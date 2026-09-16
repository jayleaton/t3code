!include "FileFunc.nsh"

# The first Agents release used the official app's package name. NSIS consequently
# installed both products into t3code. Never execute that release's uninstaller:
# it recursively deletes the shared directory, including official T3 Code files.
!macro detachSharedAgentsInstall ROOT
  ReadRegStr $R0 ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${GetFileName} "$R0" $R1
  ${If} $R1 == "t3code"
    ReadRegStr $R2 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${If} $R2 == "0.0.40-nightly.20260916.16001"
      ReadRegStr $R2 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ClearErrors
      WriteRegStr ${ROOT} "${INSTALL_REGISTRY_KEY}" "LegacySharedInstallLocation" "$R0"
      WriteRegStr ${ROOT} "${INSTALL_REGISTRY_KEY}" "LegacySharedUninstallString" "$R2"
      ${If} ${Errors}
        MessageBox MB_ICONSTOP "T3 Agents must repair its previous shared installation registration. Run this installer as administrator. Your app data has not been changed."
        Abort
      ${EndIf}
      # Only the fork's own registration is changed. Leave every file and the
      # official app's registration intact so the official installer can repair it.
      DeleteRegValue ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      DeleteRegValue ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      DeleteRegValue ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
    ${Else}
      MessageBox MB_ICONSTOP "This T3 Agents installation points at T3 Code's folder. Installation stopped to protect T3 Code."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetRegView 32
    !insertmacro detachSharedAgentsInstall HKCU
    !insertmacro detachSharedAgentsInstall HKLM
    ${If} ${RunningX64}
      SetRegView 64
      !insertmacro detachSharedAgentsInstall HKCU
      !insertmacro detachSharedAgentsInstall HKLM
    ${EndIf}
  !endif
!macroend
