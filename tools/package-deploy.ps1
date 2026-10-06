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

# 部署脚本：任何异常都必须炸出来（曾因 .NET 类型缺失静默产出 0 字节 zip 而继续往下走）
$ErrorActionPreference = 'Stop'

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
# 自建 zip：Compress-Archive 在 Windows 上写 `\` 作路径分隔符，远端 `unzip -o` 会报
# "appears to use backslashes as path separators" 并**以退出码 1 结束**——文档里的
# `unzip && systemctl restart` 链会在这里断掉（东西解出来了，服务却没重启，
# 表现为 ExecMainStartTimestamp 不变）。这里显式用 `/` 写条目名，unzip 干净退 0。
# ZipArchive / ZipArchiveMode 在 System.IO.Compression；ZipFileExtensions 在 .FileSystem——两个都要载
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# 注意：不要把「文件」放进 -Path 再带 -Recurse——PowerShell 会从该文件的**父目录**
# 开始递归。曾因此把仓库根下 node_modules/**/package.json 全部打进包里（82 个），
# 远端 /opt/firmware-server/node_modules 被塞满只有 package.json 的目录。
# 目录用 -Recurse 枚举，单文件用 Get-Item 单独取，两者再合并。
$files = @(
  Get-ChildItem -Path (Join-Path $root 'server') -Recurse -File
  Get-ChildItem -Path (Join-Path $root 'dist') -Recurse -File
  Get-Item -Path (Join-Path $root 'package.json')
) | Where-Object { $_.FullName -notmatch '\\server-data\\' -and $_.FullName -notmatch '\\node_modules\\' }
if ($files.Count -eq 0) { throw '待打包文件为 0——检查 server/ 与 dist/ 是否存在' }
$fs = [IO.File]::Create($zip)
try {
  $za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $za, $f.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $za.Dispose() }
} finally { $fs.Dispose() }

# 自检：条目数一致 + 无 `\` 路径 + 体积合理（0 字节 zip 会静默害死部署）
$check = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $bad = @($check.Entries | Where-Object { $_.FullName -match '\\' })
  $count = $check.Entries.Count
} finally { $check.Dispose() }
$size = (Get-Item $zip).Length
if ($count -ne $files.Count -or $bad.Count -gt 0 -or $size -lt 1024) {
  throw "打包自检失败：条目 $count/$($files.Count)、反斜杠条目 $($bad.Count)、体积 $size 字节"
}

Write-Host "INJECTED -> $ServerHost (panel: $PanelHost)"
Write-Host "ZIP: $zip  ($($files.Count) 个文件，路径分隔符 = /)"
