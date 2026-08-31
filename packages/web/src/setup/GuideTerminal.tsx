import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import { useWorkbench } from "../session/store";

/**
 * The terminal a setup guide runs in.
 *
 * Unlike the workbench's terminal tab this one is not tied to a project:
 * installing or signing in an agent is machine business, so the shell opens in
 * the home directory (`pty.open` with no workspace). Commands are *pasted*,
 * never executed — the user reads what the guide put there and presses enter,
 * which is the difference between a guided step and a script acting on its
 * own.
 */
export function GuideTerminal({
  command,
  height = "h-44",
}: {
  /** Pasted once the shell is up, and again whenever the button is pressed. */
  command?: string;
  height?: string;
}) {
  const client = useWorkbench((state) => state.client);
  const host = useRef<HTMLDivElement | null>(null);
  const pty = useRef<string | null>(null);
  const term = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!client || !element) return;

    const terminal = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#00000000" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    term.current = terminal;

    let disposed = false;
    const stopListening = client.onPty((id, data) => {
      if (id !== pty.current) return;
      if (data === null) {
        terminal.writeln("\r\n[进程已退出]");
        return;
      }
      terminal.write(data);
    });

    void client
      .call({
        type: "pty.open",
        payload: { workspaceId: null, cols: terminal.cols, rows: terminal.rows },
      })
      .then((reply) => {
        if (reply?.type !== "pty") throw new Error("守护进程没有返回终端");
        if (disposed) {
          void client.call({ type: "pty.close", payload: { ptyId: reply.data.ptyId } });
          return;
        }
        pty.current = reply.data.ptyId;
        setOpen(true);
      })
      .catch((cause: unknown) => setError(String(cause)));

    terminal.onData((data) => {
      if (pty.current) {
        void client.call({ type: "pty.write", payload: { ptyId: pty.current, data } });
      }
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (pty.current) {
        void client.call({
          type: "pty.resize",
          payload: { ptyId: pty.current, cols: terminal.cols, rows: terminal.rows },
        });
      }
    });
    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();
      stopListening();
      if (pty.current) void client.call({ type: "pty.close", payload: { ptyId: pty.current } });
      pty.current = null;
      term.current = null;
      terminal.dispose();
    };
  }, [client]);

  const paste = (text: string) => {
    const ptyId = pty.current;
    if (!client || !ptyId) return;
    // No trailing newline on purpose: what runs on this machine stays the
    // user's decision, made with the enter key after reading the line.
    void client.call({ type: "pty.write", payload: { ptyId, data: text } });
    term.current?.focus();
  };

  // The command arrives with the step; paste it as soon as the shell is there.
  const [pasted, setPasted] = useState<string | null>(null);
  useEffect(() => {
    if (open && command && pasted !== command) {
      paste(command);
      setPasted(command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, command, pasted]);

  if (error) return <p className="p-2 text-xs text-danger">终端打不开：{error}</p>;
  return (
    <div className="flex flex-col gap-1">
      <div ref={host} className={`${height} w-full rounded border border-line bg-bg p-1`} data-testid="guide-terminal" />
      {command && open ? (
        <button
          type="button"
          className="self-start rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
          onClick={() => paste(command)}
        >
          重新粘贴命令
        </button>
      ) : null}
    </div>
  );
}
