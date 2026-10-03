param([Parameter(Mandatory = $true)][string]$Installer)
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
function Install-And-Remove-Agents {
  $process = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  $exe = Join-Path $agents 'T3 Agents.exe'
  if (!(Test-Path $exe)) { throw 'Agents executable missing from its separate directory.' }
  if ((Get-ItemProperty $installKey).InstallLocation.TrimEnd('\') -ne $agents) {
    throw 'Agents registered the wrong install directory.'
  }
  $shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'T3 Agents.lnk'
  $shell = New-Object -ComObject WScript.Shell
  if (!(Test-Path $shortcut) -or $shell.CreateShortcut($shortcut).TargetPath -ne $exe) {
    throw 'Agents shortcut does not target the installed executable.'
  }
  Assert-OfficialPreserved
  $uninstaller = Join-Path $agents 'Uninstall T3 Agents.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$agents" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
  Assert-OfficialPreserved
}

# Exercise the real installer, including its shortcut and uninstaller.
Install-And-Remove-Agents

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
Write-Output 'Fresh install, legacy collision recovery, shortcuts, and uninstall isolation passed.'
