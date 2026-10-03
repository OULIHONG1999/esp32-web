# 发布打包（纪律 9 用）：build 产物中的占位符 → 真实服务器地址 → zip
# 仓库与远端永远只有占位符（firmware.example.com / panel.example.com）；
# 真实地址只存在于本机 `.fw-deploy.local`（gitignored）或调用参数。
#
# 用法：
#   & $env:MIMO_NODE $env:MIMO_NPM run build
#   powershell -File tools/package-deploy.ps1            # 读 .fw-deploy.local
#   powershell -File tools/package-deploy.ps1 -ServerHost 1.2.3.4   # 显式指定
param(
  [string]$ServerHost,
  [string]$PanelHost
)

$root = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.fw-deploy.local'
if ((-not $ServerHost) -and (Test-Path $local)) {
  foreach ($line in [IO.File]::ReadAllLines($local)) {
    if ($line -match '^\s*SERVER_HOST\s*=\s*(\S+)') { $ServerHost = $Matches[1] }
    if ($line -match '^\s*PANEL_HOST\s*=\s*(\S+)') { $PanelHost = $Matches[1] }
  }
}
if (-not $ServerHost) {
  throw '缺少真实服务器地址：传 -ServerHost 参数，或在仓库根放 .fw-deploy.local（一行：SERVER_HOST=x.x.x.x）'
}
if (-not $PanelHost) { $PanelHost = $ServerHost }

$dist = Join-Path $root 'dist'
if (-not (Test-Path $dist)) { throw 'dist/ 不存在——先 npm run build' }

$map = @{ 'firmware.example.com' = $ServerHost; 'panel.example.com' = $PanelHost }
Get-ChildItem -Path $dist -Recurse -Include *.html, *.txt, *.js, *.css, *.json, *.md | ForEach-Object {
  $c = [IO.File]::ReadAllText($_.FullName)
  $changed = $false
  foreach ($k in $map.Keys) {
    if ($c.Contains($k)) { $c = $c.Replace($k, $map[$k]); $changed = $true }
  }
  if ($changed) { [IO.File]::WriteAllText($_.FullName, $c, [Text.UTF8Encoding]::new($false)) }
}

$zip = Join-Path $env:TEMP ('fw-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.zip')
Compress-Archive -Path (Join-Path $root 'server'), $dist, (Join-Path $root 'package.json') -DestinationPath $zip -Force
Write-Host "INJECTED -> $ServerHost (panel: $PanelHost)"
Write-Host "ZIP: $zip"
