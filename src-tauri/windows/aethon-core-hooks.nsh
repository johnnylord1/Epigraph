!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\aethon-syncd.exe" 0 aethon_core_preinstall_done
  DetailPrint "Stopping Aethon Core and owned Suwayomi before update..."
  ExecWait '"$INSTDIR\aethon-syncd.exe" shutdown --reason pre-update --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Aethon Core could not be stopped safely. Installation was not changed; close Aethon and retry."
  ${EndIf}
aethon_core_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\aethon-syncd.exe" 0 aethon_core_postinstall_done
  DetailPrint "Registering Aethon Core for the current user..."
  ExecWait '"$INSTDIR\aethon-syncd.exe" autostart install' $0
  ${If} $0 != 0
    DetailPrint "Aethon Core autostart registration failed; installation will continue."
  ${EndIf}
  Exec '"$INSTDIR\aethon-syncd.exe" serve --lan'
aethon_core_postinstall_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\aethon-syncd.exe" 0 aethon_core_preuninstall_done
  DetailPrint "Stopping Aethon Core and owned Suwayomi before uninstall..."
  ExecWait '"$INSTDIR\aethon-syncd.exe" shutdown --reason uninstall --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Aethon Core could not be stopped safely. No application data was removed; retry the uninstall."
  ${EndIf}
  ExecWait '"$INSTDIR\aethon-syncd.exe" autostart remove' $0
  ${If} $0 != 0
    Abort "Aethon Core autostart could not be removed safely. No application data was removed."
  ${EndIf}
aethon_core_preuninstall_done:
!macroend
