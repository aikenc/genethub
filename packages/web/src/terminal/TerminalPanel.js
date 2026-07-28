import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../session/store";
/**
 * A terminal on the machine, in the browser.
 *
 * Output comes over its own frame type rather than the session event stream:
 * a build printing thousands of lines a second would otherwise flood the
 * timeline's sequence numbers and make replay useless.
 */
export function TerminalPanel() {
    const client = useWorkbench((state) => state.client);
    const workspaces = useWorkbench((state) => state.workspaces);
    const host = useRef(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        const element = host.current;
        const workspace = workspaces[0];
        if (!client || !element || !workspace)
            return;
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
        let ptyId = null;
        let disposed = false;
        const stopListening = client.onPty((id, data) => {
            if (id !== ptyId)
                return;
            if (data === null) {
                terminal.writeln("\r\n[进程已退出]");
                return;
            }
            terminal.write(data);
        });
        void client
            .call({
            type: "pty.open",
            payload: { workspaceId: workspace.id, cols: terminal.cols, rows: terminal.rows },
        })
            .then((reply) => {
            if (reply?.type !== "pty")
                throw new Error("守护进程没有返回终端");
            if (disposed) {
                void client.call({ type: "pty.close", payload: { ptyId: reply.data.ptyId } });
                return;
            }
            ptyId = reply.data.ptyId;
        })
            .catch((cause) => setError(String(cause)));
        terminal.onData((data) => {
            if (ptyId)
                void client.call({ type: "pty.write", payload: { ptyId, data } });
        });
        const resize = () => {
            fit.fit();
            if (ptyId) {
                void client.call({
                    type: "pty.resize",
                    payload: { ptyId, cols: terminal.cols, rows: terminal.rows },
                });
            }
        };
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        return () => {
            disposed = true;
            observer.disconnect();
            stopListening();
            if (ptyId)
                void client.call({ type: "pty.close", payload: { ptyId } });
            terminal.dispose();
        };
    }, [client, workspaces]);
    if (error)
        return _jsxs("p", { className: "p-4 text-sm text-danger", children: ["\u7EC8\u7AEF\u6253\u4E0D\u5F00\uFF1A", error] });
    return _jsx("div", { ref: host, className: "h-full w-full p-2", "data-testid": "terminal" });
}
