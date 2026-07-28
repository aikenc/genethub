import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useWorkbench } from "../session/store";
/**
 * What the agent actually changed, and a way to commit it.
 *
 * This is the panel people look at before they trust anything: a diff they can
 * read beats a paragraph claiming the work is done. Committing is here for the
 * same reason — reviewing and recording a change belong in the same place.
 */
export function ChangesPanel() {
    const { git, diff, refreshGit, loadDiff, commit } = useWorkbench();
    const [selected, setSelected] = useState(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!git)
            void refreshGit();
    }, [git, refreshGit]);
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col md:flex-row", children: [_jsxs("div", { className: "flex max-h-56 shrink-0 flex-col border-b border-line md:max-h-none md:w-72 md:border-b-0 md:border-r", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs", children: [_jsx("span", { className: "truncate", children: git?.branch ?? "（无分支）" }), _jsx("button", { type: "button", className: "ml-auto text-muted hover:text-fg", onClick: () => void refreshGit(), children: "\u5237\u65B0" })] }), _jsxs("ul", { className: "flex-1 overflow-y-auto p-1 text-sm", children: [(git?.changes ?? []).map((change) => (_jsx("li", { children: _jsxs("button", { type: "button", "aria-current": selected === change.path, className: `flex w-full items-center gap-2 truncate rounded px-2 py-1 text-left hover:bg-raised ${selected === change.path ? "bg-raised" : ""}`, onClick: () => {
                                        setSelected(change.path);
                                        void loadDiff(change.path);
                                    }, children: [_jsx("span", { className: `w-3 shrink-0 font-mono text-xs ${tone(change.kind)}`, children: mark(change.kind) }), _jsx("span", { className: "truncate font-mono text-xs", children: change.path })] }) }, `${change.path}:${String(change.staged)}`))), git?.clean ? _jsx("li", { className: "p-2 text-xs text-muted", children: "\u5DE5\u4F5C\u533A\u5E72\u51C0" }) : null] }), _jsxs("div", { className: "border-t border-line p-2", children: [_jsx("textarea", { "aria-label": "\u63D0\u4EA4\u8BF4\u660E", className: "h-16 w-full resize-none rounded border border-line bg-bg p-2 text-xs outline-none focus:border-accent", placeholder: "\u63D0\u4EA4\u8BF4\u660E", value: message, onChange: (event) => setMessage(event.target.value) }), _jsx("button", { type: "button", className: "mt-1 w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40", disabled: busy || message.trim().length === 0 || (git?.clean ?? true), onClick: async () => {
                                    setBusy(true);
                                    try {
                                        await commit(message.trim());
                                        setMessage("");
                                        setSelected(null);
                                    }
                                    finally {
                                        setBusy(false);
                                    }
                                }, children: busy ? "提交中…" : "提交全部改动" })] })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-auto bg-bg", children: diff ? (_jsx(Diff, { text: diff })) : (_jsxs("p", { className: "m-auto p-4 text-sm text-muted", children: ["\u9009\u4E00\u4E2A\u6587\u4EF6\u770B\u5B83\u7684\u6539\u52A8\uFF0C\u6216\u8005", _jsx("button", { type: "button", className: "px-1 text-accent underline", onClick: () => {
                                setSelected(null);
                                void loadDiff();
                            }, children: "\u770B\u5168\u90E8" })] })) })] }));
}
function Diff({ text }) {
    return (_jsx("pre", { className: "p-3 font-mono text-xs leading-relaxed", "data-testid": "diff", children: text.split("\n").map((line, index) => (_jsx("div", { className: line.startsWith("+") && !line.startsWith("+++")
                ? "text-ok"
                : line.startsWith("-") && !line.startsWith("---")
                    ? "text-danger"
                    : line.startsWith("@@")
                        ? "text-accent"
                        : "text-muted", children: line || " " }, index))) }));
}
function mark(kind) {
    return { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "?" }[kind];
}
function tone(kind) {
    return kind === "deleted" ? "text-danger" : kind === "added" ? "text-ok" : "text-muted";
}
