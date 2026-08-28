!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\epigraph-syncd.exe" 0 epigraph_core_preinstall_legacy
  DetailPrint "Stopping Epigraph Core and owned Suwayomi before update..."
  ExecWait '"$INSTDIR\epigraph-syncd.exe" shutdown --reason pre-update --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Epigraph Core could not be stopped safely. Installation was not changed; close Epigraph and retry."
  ${EndIf}
  Goto epigraph_core_preinstall_done
epigraph_core_preinstall_legacy:
  IfFileExists "$INSTDIR\aethon-syncd.exe" 0 epigraph_core_preinstall_done
  DetailPrint "Stopping legacy Core before update..."
  ExecWait '"$INSTDIR\aethon-syncd.exe" shutdown --reason pre-update --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Legacy Core could not be stopped safely. Installation was not changed; close the previous app and retry."
  ${EndIf}
epigraph_core_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\epigraph-syncd.exe" 0 epigraph_core_postinstall_done
  DetailPrint "Registering Epigraph Core for the current user..."
  ExecWait '"$INSTDIR\epigraph-syncd.exe" autostart install' $0
  ${If} $0 != 0
    DetailPrint "Epigraph Core autostart registration failed; installation will continue."
  ${EndIf}
  Exec '"$INSTDIR\epigraph-syncd.exe" serve --lan'
epigraph_core_postinstall_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\epigraph-syncd.exe" 0 epigraph_core_preuninstall_legacy
  DetailPrint "Stopping Epigraph Core and owned Suwayomi before uninstall..."
  ExecWait '"$INSTDIR\epigraph-syncd.exe" shutdown --reason uninstall --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Epigraph Core could not be stopped safely. No application data was removed; retry the uninstall."
  ${EndIf}
  ExecWait '"$INSTDIR\epigraph-syncd.exe" autostart remove' $0
  ${If} $0 != 0
    Abort "Epigraph Core autostart could not be removed safely. No application data was removed."
  ${EndIf}
  Goto epigraph_core_preuninstall_done
epigraph_core_preuninstall_legacy:
  IfFileExists "$INSTDIR\aethon-syncd.exe" 0 epigraph_core_preuninstall_done
  DetailPrint "Stopping legacy Core and owned Suwayomi before uninstall..."
  ExecWait '"$INSTDIR\aethon-syncd.exe" shutdown --reason uninstall --timeout-seconds 45' $0
  ${If} $0 != 0
    Abort "Legacy Core could not be stopped safely. No application data was removed; retry the uninstall."
  ${EndIf}
  ExecWait '"$INSTDIR\aethon-syncd.exe" autostart remove' $0
  ${If} $0 != 0
    Abort "Legacy Core autostart could not be removed safely. No application data was removed."
  ${EndIf}
epigraph_core_preuninstall_done:
!macroend
