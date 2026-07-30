; Installer hooks for Windows.
;
; The daemon is meant to outlive the window: closing the app leaves it running so
; the machine stays reachable. So by the time an upgrade wants to replace
; `bin\genet-daemon.exe`, the old one is holding that file open, and the install
; stops with "Error opening file for writing" — on the machine of someone who did
; nothing wrong and now has a half-installed app.
;
; Two things this has to get right, both learned the hard way:
;
; **Order.** The app supervises the daemon and starts a new one within about two
; seconds of it dying (`daemon.rs`, `watch`). Killing the daemon first therefore
; produces a *fresh* daemon holding the very file the installer is about to
; write, a second or so later — which looks exactly like the bug it was meant to
; fix. The supervisor goes first.
;
; **Proof.** A fixed sleep is a guess about how long Windows takes to release a
; handle, how long a scanner holds a new executable, and how long a respawn takes.
; The file itself can answer, so it is asked.
;
; Killing rather than asking politely: an installer cannot wait on a graceful
; shutdown that may be mid-turn, and the daemon is built to be killed — it
; republishes where it is listening on the next start, and adopts anything it
; finds still alive. `/T` takes children with it, since an agent left behind holds
; its own executable open the same way.

!macro StopGeneHubProcesses
  DetailPrint "正在停止 GeneHub 后台进程…"

  ; The supervisor first, or it revives what comes next.
  nsExec::Exec 'taskkill /F /T /IM GeneHub.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM genet-daemon.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM genet-agent.exe'
  Pop $0

  ; Wait for the file to actually be writable — up to about six seconds, which is
  ; far longer than a handle takes to close and still short enough that a stuck
  ; machine reaches the normal error instead of hanging here forever.
  StrCpy $1 0
  genehub_wait:
    IfFileExists "$INSTDIR\bin\genet-daemon.exe" 0 genehub_ready
    ClearErrors
    FileOpen $2 "$INSTDIR\bin\genet-daemon.exe" a
    IfErrors genehub_retry
    FileClose $2
    Goto genehub_ready
  genehub_retry:
    Sleep 300
    IntOp $1 $1 + 1
    IntCmp $1 20 genehub_ready genehub_wait genehub_ready
  genehub_ready:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopGeneHubProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same reason in reverse: an open file cannot be deleted, and an uninstall that
  ; leaves the daemon running leaves the machine reachable by an app that is no
  ; longer there.
  !insertmacro StopGeneHubProcesses
!macroend
