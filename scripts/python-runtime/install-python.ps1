# Installs the platform Python (Windows) into <runtime-dir>.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-python.ps1 <runtime-dir>
#
# Run by the desktop installer and by the dev tooling; the daemon never installs
# anything, it only reads the result: <runtime-dir>\python.json,
# {"python":"C:\\...\\python.exe"}. The same pin and the same python-build-standalone
# archive as install-python.sh. Idempotent; exits 1 with the reason on stderr.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Older 5.1 hosts still default to TLS 1.0, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say($message) { [Console]::Out.WriteLine($message) }
function Fail($message) { [Console]::Error.WriteLine("error: $message"); exit 1 }

$pin = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'python.pin')) {
  if ($line -match '^([^#=]+)=(.*)$') { $pin[$Matches[1].Trim()] = $Matches[2].Trim() }
}
$Version = $pin['version']
$Release = $pin['release']
$Triple = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$Want = $pin["sha256.$Triple"]
if (-not ($Version -and $Release -and $Want)) { Fail "python.pin has no entry for $Triple" }

$target = Join-Path $Root "python-$Version-$Release"
$python = Join-Path $target 'python.exe'

# Usable: it starts in isolated mode and reports exactly the pinned version.
# Under 'Stop', anything a broken interpreter writes to stderr would throw; that
# too just means "not usable".
function Usable($exe) {
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  try {
    & $exe -I -c 'import sys; sys.exit(0 if sys.version.split()[0] == sys.argv[1] else 1)' $Version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (-not (Usable $python)) {
  $file = "cpython-$Version%2B$Release-$Triple-install_only_stripped.tar.gz"
  # A configured mirror is tried first; the hash makes any mirror safe to use,
  # because content that does not match is never unpacked.
  $urls = @()
  if ($env:GENEHUB_PYTHON_MIRRORS) {
    foreach ($base in $env:GENEHUB_PYTHON_MIRRORS.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) {
      $urls += "$($base.TrimEnd('/'))/$Release/$file"
    }
  }
  $urls += "https://github.com/astral-sh/python-build-standalone/releases/download/$Release/$file"
  $urls += "https://mirrors.aliyun.com/github/releases/astral-sh/python-build-standalone/$Release/$file"

  $staging = Join-Path $Root ".staging-$PID"
  if (Test-Path -LiteralPath $staging) { Remove-Item -Recurse -Force -LiteralPath $staging }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $archive = Join-Path $staging 'python.tar.gz'
  $got = $false
  foreach ($url in $urls) {
    Say "==> downloading Python ${Version}: $url"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 600
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLower() -eq $Want) { $got = $true; break }
      Say '    checksum mismatch, trying the next address'
    } catch { }
    if (Test-Path -LiteralPath $archive) { Remove-Item -Force -LiteralPath $archive }
  }
  if (-not $got) {
    Remove-Item -Recurse -Force -LiteralPath $staging
    Fail "could not download Python ${Version}: every address failed or did not match the pinned checksum"
  }

  Say "==> unpacking Python $Version"
  # tar.exe ships with Windows 10 1803 and later.
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $archive -C $staging
  if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force -LiteralPath $staging; Fail 'could not unpack the Python archive' }
  Remove-Item -Force -LiteralPath $archive
  $unpacked = Join-Path $staging 'python'
  if (-not (Test-Path -LiteralPath $unpacked)) { Remove-Item -Recurse -Force -LiteralPath $staging; Fail 'the Python archive has no python directory' }
  if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
  Move-Item -LiteralPath $unpacked -Destination $target
  Remove-Item -Recurse -Force -LiteralPath $staging
  if (-not (Usable $python)) { Fail 'the installed Python does not start in isolated mode' }
}

# The platform Python is not a place to install packages into. This is the
# standard marker (PEP 668): a global `pip install` stops with this text, while
# a virtual environment created from it is unaffected.
$stdlib = (& $python -I -c 'import sysconfig; print(sysconfig.get_path("stdlib"))').Trim()
$utf8 = New-Object System.Text.UTF8Encoding $false
$marker = "[externally-managed]`nError=This is the Python that ships with GeneHub; do not install packages into it.`n Create a virtual environment and install there:`n `"`$GENEHUB_PYTHON`" -m venv <dir> && <dir>\Scripts\pip install <package>`n"
[IO.File]::WriteAllText((Join-Path $stdlib 'EXTERNALLY-MANAGED'), $marker, $utf8)

# Atomic, so the daemon never reads half of it.
$json = (@{ python = $python } | ConvertTo-Json -Compress)
$pointer = Join-Path $Root 'python.json'
[IO.File]::WriteAllText("$pointer.tmp", $json, $utf8)
Move-Item -Force -LiteralPath "$pointer.tmp" -Destination $pointer

# Only the pinned build stays. One whose files are still locked by a running
# process is left for the next install.
Get-ChildItem -LiteralPath $Root -Directory -Filter 'python-*' |
  Where-Object { $_.FullName -ne $target } |
  ForEach-Object {
    try { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction Stop } catch { }
  }

Say "Python $Version ready: $python"
