$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$bytes = [Text.Encoding]::UTF8.GetBytes($identity.User.Value + ':' + $distro)
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '') }
finally { $hash.Dispose() }
$name = 'GeneHub WSL ' + $key
$description = 'GeneHub WSL distribution holder ' + $key
$root = Join-Path $env:LOCALAPPDATA 'GeneHub\wsl'
$record = Join-Path $root ($key + '.json')
$stop = Join-Path $root ($key + '.stop')
$marker = 'genehub-wsl-holder-' + $key
$member = $linuxUser + ':' + $channel
$mutex = [Threading.Mutex]::new($false, 'Local\GeneHub-WSL-' + $key)
$locked = $false
try {
    try { $locked = $mutex.WaitOne(5000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another GeneHub WSL operation is in progress.' }
    $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and $task.Description -ne $description) { throw 'The scheduled task name is already in use.' }
    [string[]] $members = @()
    if (Test-Path -LiteralPath $record) {
        $decoded = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $record -Raw)
        $members = @($decoded | ForEach-Object { [string]$_ })
    }
    if ($operation -eq 'start') {
        $available = (& $wsl --list --quiet | Out-String) -replace '\x00',''
        if ($LASTEXITCODE -ne 0 -or (($available -split '\r?\n') -notcontains $distro)) {
            throw 'The selected WSL distribution is unavailable to this Windows account.'
        }
        if ($distro.Contains('"') -or $linuxUser.Contains('"')) {
            throw 'The WSL distribution or user name contains an unsupported quote.'
        }
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        if (Test-Path -LiteralPath $stop) { Remove-Item -LiteralPath $stop }
        if (!$task) {
            $runner = @'
$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$stop = @STOP@
while (!(Test-Path -LiteralPath $stop)) {
    & $wsl --distribution @DISTRO@ --user @USER@ --exec /bin/sh -c 'exec /bin/sleep infinity' @MARKER@
    Start-Sleep -Seconds 5
}
'@
            $runner = $runner.Replace('@STOP@', "'" + $stop.Replace("'", "''") + "'")
            $runner = $runner.Replace('@DISTRO@', "'" + $distro.Replace("'", "''") + "'")
            $runner = $runner.Replace('@USER@', "'" + $linuxUser.Replace("'", "''") + "'")
            $runner = $runner.Replace('@MARKER@', $marker)
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runner))
            $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
            $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            $task = Register-ScheduledTask -TaskName $name -TaskPath '\' -Description $description -Action $action -Principal $principal -Trigger $trigger -Settings $settings
        }
        if ($task.State -eq 'Disabled') { Enable-ScheduledTask -InputObject $task | Out-Null }
        if ($task.State -ne 'Running') { Start-ScheduledTask -InputObject $task }
        $members = @($members + $member | Select-Object -Unique)
    } elseif ($operation -eq 'stop') {
        $members = @($members | Where-Object { $_ -ne $member })
        if ($task -and $members.Count -eq 0) {
            New-Item -ItemType Directory -Path $root -Force | Out-Null
            Set-Content -LiteralPath $stop -Value 'stop'
            if ($task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
            $deadline = (Get-Date).AddSeconds(8)
            do {
                $task = Get-ScheduledTask -TaskName $name -TaskPath '\'
                if ($task.State -ne 'Running') { break }
                Start-Sleep -Milliseconds 250
            } while ((Get-Date) -lt $deadline)
            if ($task.State -eq 'Running') { throw 'The WSL holder task did not stop.' }
            # Task Scheduler may leave a native child behind. Match this
            # task's per-account marker, owner and creation time before
            # taking a handle. Other wsl.exe processes stay untouched.
            $holders = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" |
                Where-Object { $_.CommandLine -match ([regex]::Escape($marker) + '"?$') }
            foreach ($holder in $holders) {
                $owner = Invoke-CimMethod -InputObject $holder -MethodName GetOwnerSid -ErrorAction SilentlyContinue
                if ($owner.Sid -ne $identity.User.Value) { continue }
                $process = Get-Process -Id $holder.ProcessId -ErrorAction SilentlyContinue
                if (!$process) { continue }
                try {
                    $null = $process.Handle
                    $started = ($process.StartTime.ToUniversalTime() - $holder.CreationDate.ToUniversalTime()).Duration()
                    if ($started.TotalMilliseconds -lt 1000 -and !$process.HasExited) {
                        $process.Kill()
                        if (!$process.WaitForExit(3000)) { throw 'The WSL holder process did not exit.' }
                    }
                } finally { $process.Dispose() }
            }
            Unregister-ScheduledTask -InputObject $task -Confirm:$false
            Remove-Item -LiteralPath $stop
            $task = $null
        }
    }
    if ($operation -eq 'stop' -and $members.Count -eq 0) {
        if (Test-Path -LiteralPath $record) { Remove-Item -LiteralPath $record }
    } elseif ($operation -ne 'status' -and $task) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $temp = $record + '.' + [Guid]::NewGuid().ToString('N')
        $backup = $temp + '.backup'
        try {
            ConvertTo-Json -InputObject @($members) -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
            if (Test-Path -LiteralPath $record) { [IO.File]::Replace($temp, $record, $backup) }
            else { [IO.File]::Move($temp, $record) }
        } finally {
            foreach ($path in @($temp, $backup)) {
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
            }
        }
    }
    $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    @{taskState = if ($task) { [string]$task.State } else { 'notRegistered' }; configured = ($members -contains $member); startup = 'windowsLogon'} | ConvertTo-Json -Compress
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
