param(
  [Parameter(Mandatory = $true)][string]$Installer,
  # Shortcuts and the uninstaller follow the product name; the exe stays pinned to 'T3 Agents.exe'.
  [Parameter(Mandatory = $true)][string]$ProductName
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This destructive installer test is only for disposable GitHub runners.' }

$official = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$agents = Join-Path $env:LOCALAPPDATA 'Programs\t3agents'
$guid = 'ccf78c7e-8df2-5a0c-a080-27ced17c5cb7'
$installKey = "HKCU:\Software\$guid"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
if ((Test-Path $official) -or (Test-Path $agents) -or (Test-Path $installKey)) {
  throw 'Installer test requires an unused runner profile.'
}
New-Item -ItemType Directory -Path $official | Out-Null
$sentinel = Join-Path $official 'official-app-preserved.txt'
Set-Content $sentinel 'Official T3 files must survive Agents installation and removal.'
$hash = (Get-FileHash $sentinel).Hash

function Assert-OfficialPreserved {
  if (!(Test-Path $sentinel) -or (Get-FileHash $sentinel).Hash -ne $hash) {
    throw 'Agents modified the official app directory.'
  }
}
function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
function Get-Shortcuts([string]$Name) {
  foreach ($folder in 'Desktop', 'Programs') {
    Join-Path ([Environment]::GetFolderPath($folder)) "$Name.lnk"
  }
}
function Assert-Installed {
  $exe = Join-Path $agents 'T3 Agents.exe'
  if (!(Test-Path $exe)) { throw 'Agents executable missing from its separate directory.' }
  if ((Get-ItemProperty $installKey).InstallLocation.TrimEnd('\') -ne $agents) {
    throw 'Agents registered the wrong install directory.'
  }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in Get-Shortcuts $ProductName) {
    if (!(Test-Path $shortcut) -or $shell.CreateShortcut($shortcut).TargetPath -ne $exe) {
      throw "Agents shortcut $shortcut does not target the installed executable."
    }
  }
  Assert-OfficialPreserved
}
function Remove-Agents {
  $uninstaller = Join-Path $agents "Uninstall $ProductName.exe"
  $process = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$agents" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
  Assert-OfficialPreserved
}
function Install-And-Remove-Agents {
  Invoke-Installer '/S'
  Assert-Installed
  Remove-Agents
}

# Exercise the real installer, including its shortcut and uninstaller.
Install-And-Remove-Agents

# Reproduce an install whose shortcuts were created while the product was named 'T3 Agents'.
# The auto-update must rename them, not leave them beside a second set.
if ($ProductName -ne 'T3 Agents') {
  Invoke-Installer '/S'
  foreach ($shortcut in Get-Shortcuts $ProductName) { Rename-Item $shortcut 'T3 Agents.lnk' }
  Set-ItemProperty $installKey -Name ShortcutName -Value 'T3 Agents'
  Invoke-Installer '--updated', '/S'
  Assert-Installed
  if (@(Get-Shortcuts 'T3 Agents' | Where-Object { Test-Path $_ }).Count -ne 0) {
    throw 'The update left a T3 Agents shortcut behind.'
  }
  if ((Get-ItemProperty $uninstallKey).DisplayName -notlike "$ProductName *") {
    throw 'The update kept the old uninstall entry name.'
  }
  Remove-Agents
}

# Reproduce the first release's registration pointing at the official directory.
# An invalid uninstaller deliberately fails if the new installer tries to run it.
$legacyUninstaller = Join-Path $official 'Uninstall T3 Agents.exe'
Set-Content $legacyUninstaller 'Must never be executed or deleted by the corrected installer.'
New-Item -Path $installKey -Force | Out-Null
New-ItemProperty $installKey -Name InstallLocation -Value $official -Force | Out-Null
New-Item -Path $uninstallKey -Force | Out-Null
New-ItemProperty $uninstallKey -Name DisplayVersion -Value '0.0.40-nightly.20260916.16001' -Force | Out-Null
New-ItemProperty $uninstallKey -Name UninstallString -Value ('"' + $legacyUninstaller + '"') -Force | Out-Null
Install-And-Remove-Agents
if (!(Test-Path $legacyUninstaller)) { throw 'Installer removed files from the legacy shared directory.' }
Write-Output 'Fresh install, shortcut rename on update, legacy collision recovery, and uninstall isolation passed.'
