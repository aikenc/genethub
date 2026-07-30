; Installer hooks for Windows.
;
; The daemon is meant to outlive the window: closing the app leaves it running so
; the machine stays reachable. Which means that at the moment an upgrade wants to
; replace `bin\genet-daemon.exe`, the old one is holding that file open, and the
; installer stops with "Error opening file for writing" — on the machine of
; someone who did nothing wrong and now has a half-installed app.
;
; So the processes we ship are stopped first, by name. Killing rather than asking
; politely: an installer cannot wait on a graceful shutdown that may be mid-turn,
; and the daemon is built to be killed — it republishes where it is listening on
; the next start, and adopts anything it finds still alive.
;
; `/T` takes the children with it: agents are spawned by the daemon, and an agent
; left behind would hold its own executable open the same way.

!macro StopGeneHubProcesses
  DetailPrint "正在停止 GeneHub 后台进程…"
  nsExec::Exec 'taskkill /F /T /IM genet-daemon.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM genet-agent.exe'
  Pop $0
  ; Windows releases the file handles a moment after the process goes, and the
  ; next thing this installer does is open those files for writing.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopGeneHubProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same reason in reverse: files that are open cannot be deleted, and an
  ; uninstall that leaves the daemon running leaves the machine reachable by an
  ; app that is no longer there.
  !insertmacro StopGeneHubProcesses
!macroend
