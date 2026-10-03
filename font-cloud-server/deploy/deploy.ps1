# font-cloud 部署到已有的 esp32-web 服务器（共存，不替换 firmware-server）
# 用法：powershell -File font-cloud-server/deploy/deploy.ps1
param(
  [string]$ServerHost,
  [int]$Port = 8788
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fc = Join-Path $repo 'font-cloud-server'
$local = Join-Path $repo '.fw-deploy.local'

if ((-not $ServerHost) -and (Test-Path $local)) {
  foreach ($line in [IO.File]::ReadAllLines($local)) {
    if ($line -match 'SERVER_HOST\s*=\s*(\S+)') { $ServerHost = $Matches[1] }
  }
}
if (-not $ServerHost) { throw 'missing SERVER_HOST' }
Write-Host "DEPLOY font-cloud -> root@${ServerHost} port=${Port}"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP ('font-cloud-deploy-' + $stamp)
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $fc 'server.py') $stage
Copy-Item (Join-Path $fc 'requirements.txt') $stage
Copy-Item (Join-Path $fc 'README.md') $stage
Copy-Item (Join-Path $fc 'public') (Join-Path $stage 'public') -Recurse
Copy-Item (Join-Path $fc 'fonts') (Join-Path $stage 'fonts') -Recurse
Copy-Item (Join-Path $fc 'deploy') (Join-Path $stage 'deploy') -Recurse

$ttf = Get-ChildItem (Join-Path $stage 'fonts') -Recurse -Include *.ttf,*.otf
if (-not $ttf) { throw 'no ttf/otf in fonts/ - see fonts/README.md' }
Write-Host ('PACK fonts: ' + (($ttf | ForEach-Object Name) -join ', '))

$tarball = Join-Path $env:TEMP ('font-cloud-' + $stamp + '.tar.gz')
if (Test-Path $tarball) { Remove-Item $tarball -Force }
# Windows Compress-Archive 会写出反斜杠路径，服务器 unzip 解不出来；用 tar 打 POSIX 路径
Push-Location $stage
tar -czf $tarball *
Pop-Location
Write-Host "TAR: $tarball"

scp -o BatchMode=yes $tarball ("root@${ServerHost}:/tmp/font-cloud-deploy.tar.gz")
scp -o BatchMode=yes (Join-Path $fc 'deploy\install-on-server.sh') ("root@${ServerHost}:/tmp/font-cloud-install.sh")
ssh -o BatchMode=yes ("root@${ServerHost}") "bash /tmp/font-cloud-install.sh"

Write-Host '==== public entry checks ===='
$base = 'http://' + $ServerHost
$paths = @('/font-cloud.json', '/api/meta', '/llms-font-cloud.txt', '/docs/protocol.md', '/font-bench/', '/font-bench/font-cloud', '/api/registry')
foreach ($p in $paths) {
  try {
    $r = Invoke-WebRequest -Uri ($base + $p) -UseBasicParsing -TimeoutSec 15
    Write-Host ('OK ' + $r.StatusCode + ' ' + $p)
  } catch {
    Write-Host ('ERR ' + $p + ' :: ' + $_.Exception.Message)
  }
}
Write-Host ('SHARE: ' + $base + '/font-cloud')
