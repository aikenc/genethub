# Installs the pinned CPython embeddable build for Windows into <runtime-dir>
# and prints its path. Source: python.org's official embeddable zip.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 <runtime-dir>
#
# Output protocol, one JSON object per line on stdout:
#   {"phase":"…","message":"…"}   progress
#   {"error":"…"}                 why it stopped (exit code 1)
#   {"python":"C:\\…\\python.exe"} the interpreter; last line on success
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 writes redirected output in the OEM code page; the
# daemon reads UTF-8 (paths under a non-ASCII user name, Chinese messages).
# This file itself is saved as UTF-8 with a BOM so 5.1 reads its literals.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# Older 5.1 hosts still default to TLS 1.0, which python.org refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Version = '3.13.16'
$Hashes = @{
  'amd64' = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
  'arm64' = '790d097697a2020477549a6764d89d22194c88d6e42caebcb2db63791e004c94'
}

function Emit($object) { [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress)) }
function Say($phase, $message) { Emit @{ phase = $phase; message = $message } }
function Fail($message) { Emit @{ error = $message }; exit 1 }

# Starts in isolated mode and reports exactly the pinned version. Under
# 'Stop', anything a broken interpreter writes to stderr would throw; that
# too just means "not usable".
function Usable($python) {
  if (-not (Test-Path -LiteralPath $python)) { return $false }
  try {
    & $python -I -c 'import sys; sys.exit(0 if sys.version.split()[0] == sys.argv[1] else 1)' $Version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
$expected = $Hashes[$arch]
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$name = "python-$Version"
$target = Join-Path $Root $name
$python = Join-Path $target 'python.exe'

if (-not (Usable $python)) {
  $file = "python-$Version-embed-$arch.zip"
  $urls = @()
  if ($env:GENEHUB_PYTHON_MIRRORS) {
    foreach ($base in $env:GENEHUB_PYTHON_MIRRORS.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) {
      $urls += "$($base.TrimEnd('/'))/$Version/$file"
    }
  }
  $urls += "https://www.python.org/ftp/python/$Version/$file"
  $urls += "https://registry.npmmirror.com/-/binary/python/$Version/$file"
  $urls += "https://mirrors.huaweicloud.com/python/$Version/$file"

  $staging = Join-Path $Root ".staging-$PID"
  if (Test-Path -LiteralPath $staging) { Remove-Item -Recurse -Force -LiteralPath $staging }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $archive = Join-Path $staging 'python.zip'
  $got = $false
  foreach ($url in $urls) {
    Say 'download' "下载 Python ${Version}：$url"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 600
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLower() -eq $expected) { $got = $true; break }
      Say 'download' '校验失败，换下一个地址'
    } catch { }
    if (Test-Path -LiteralPath $archive) { Remove-Item -Force -LiteralPath $archive }
  }
  if (-not $got) {
    Remove-Item -Recurse -Force -LiteralPath $staging
    Fail "无法下载 Python ${Version}：所有地址都失败或校验不通过"
  }

  Say 'extract' "解压 Python $Version"
  $unpacked = Join-Path $staging 'python'
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
  Remove-Item -Force -LiteralPath $archive
  if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
  Move-Item -LiteralPath $unpacked -Destination $target
  Remove-Item -Recurse -Force -LiteralPath $staging
  # The install time, which is how the cleanup below tells builds apart.
  (Get-Item -LiteralPath $target).LastWriteTime = Get-Date
  Say 'verify' "检查 Python $Version"
  if (-not (Usable $python)) { Fail '安装后的 Python 无法以隔离模式启动' }
}

# The pinned build and the one installed before it stay: an Agent started
# before this install may still be running on that one. Older builds go;
# one that is still in use (its files are locked) is left for next time.
Get-ChildItem -LiteralPath $Root -Directory -Filter 'python-*' |
  Where-Object { $_.FullName -ne $target } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 1 |
  ForEach-Object {
    try { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction Stop } catch { }
  }

Emit @{ python = $python }
