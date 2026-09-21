param(
  [Parameter(Mandatory = $true)]
  [string]$DshHome,

  [string]$PnpmCommand = "pnpm.cmd"
)

$ErrorActionPreference = "Stop"

$homePath = [System.IO.Path]::GetFullPath($DshHome)
$profilePath = Join-Path $homePath "profiles\desktop"
$packagePath = Join-Path $profilePath "package.json"
$localPluginsPath = Join-Path $homePath "local-plugins"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "Desktop profile package.json not found: $packagePath"
}

New-Item -ItemType Directory -Path $localPluginsPath -Force | Out-Null

foreach ($name in @("dsh-purge", "dsh-liangshen")) {
  $source = Join-Path $scriptRoot $name
  $target = Join-Path $localPluginsPath $name
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Plugin source not found: $source"
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Get-ChildItem -LiteralPath $source -Force |
    Copy-Item -Destination $target -Recurse -Force
}

$profile = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $profile.dependencies) {
  $profile | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
}

$profile.dependencies | Add-Member -MemberType NoteProperty -Name "dsh-purge" `
  -Value "file:../../local-plugins/dsh-purge" -Force
$profile.dependencies | Add-Member -MemberType NoteProperty -Name "@linxin666/dsh-liangshen" `
  -Value "file:../../local-plugins/dsh-liangshen" -Force

if ($null -eq $profile.dsh -or $null -eq $profile.dsh.profile) {
  throw "Desktop profile does not contain dsh.profile"
}

$bundles = @($profile.dsh.profile.bundles)
foreach ($bundle in @("dsh-purge", "@linxin666/dsh-liangshen")) {
  if ($bundles -notcontains $bundle) {
    $bundles += $bundle
  }
}
$profile.dsh.profile.bundles = $bundles

$json = $profile | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($packagePath, $json + [Environment]::NewLine,
  [System.Text.UTF8Encoding]::new($false))

Push-Location $profilePath
try {
  & $PnpmCommand install --offline
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "Compatibility plugins installed. Fully restart DeepSeek Harness."
