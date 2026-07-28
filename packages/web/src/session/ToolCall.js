import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
/**
 * Tool calls get a renderer per shape, and `unknown` gets a readable fallback.
 *
 * The fallback is not a nicety. A new agent will call tools we have never heard
 * of, and showing raw JSON is the difference between "that agent looks broken"
 * and "that tool has no custom view yet" (`architecture.md` §4).
 */
export function ToolCallView({ name, status, detail, }) {
    return (_jsxs("div", { className: "rounded-lg border border-line bg-surface", "data-testid": "tool-call", children: [_jsxs("header", { className: "flex items-center gap-2 border-b border-line px-3 py-2 text-xs", children: [_jsx(StatusDot, { status: status }), _jsx("span", { className: "font-mono text-fg", children: name }), _jsx("span", { className: "text-muted", children: summarize(detail) })] }), _jsx("div", { className: "px-3 py-2 text-[13px]", children: _jsx(Body, { detail: detail }) })] }));
}
function StatusDot({ status }) {
    const colour = status === "ok"
        ? "bg-ok"
        : status === "error"
            ? "bg-danger"
            : status === "running"
                ? "bg-accent animate-pulse"
                : "bg-muted";
    return _jsx("i", { className: `h-2 w-2 shrink-0 rounded-full ${colour}`, "aria-label": status, role: "img" });
}
function summarize(detail) {
    switch (detail.kind) {
        case "shell":
            return detail.command;
        case "read":
        case "edit":
        case "write":
            return detail.path;
        case "search":
            return detail.query;
        case "fetch":
            return detail.url;
        case "plan":
            return "计划";
        case "subAgent":
            return detail.agent;
        case "unknown":
            return "";
    }
}
function Body({ detail }) {
    switch (detail.kind) {
        case "shell":
            return (_jsxs(Pre, { children: [detail.output || "（暂无输出）", detail.exitCode !== null && detail.exitCode !== 0 ? `\n退出码 ${detail.exitCode}` : ""] }));
        case "read":
            return (_jsxs(Pre, { children: [detail.content, detail.truncated ? "\n…（已截断）" : ""] }));
        case "write":
            return _jsx(Pre, { children: detail.content });
        case "edit":
            return _jsx(Diff, { diff: detail.diff });
        case "search":
            return detail.matches.length === 0 ? (_jsx("p", { className: "text-muted", children: "\u6CA1\u6709\u5339\u914D" })) : (_jsx("ul", { className: "space-y-0.5 font-mono text-xs", children: detail.matches.slice(0, 50).map((match, index) => (_jsxs("li", { className: "truncate", children: [_jsx("span", { className: "text-accent", children: match.path }), match.line !== null && match.line !== undefined ? `:${match.line}` : "", match.preview ? _jsxs("span", { className: "text-muted", children: [" ", match.preview] }) : null] }, `${match.path}:${match.line ?? index}`))) }));
        case "fetch":
            return _jsx(Pre, { children: detail.summary });
        case "plan":
            return _jsx(Pre, { children: detail.markdown });
        case "subAgent":
            return _jsx("p", { className: "text-muted", children: detail.prompt });
        case "unknown":
            return _jsx(Unknown, { raw: detail.raw });
    }
}
function Pre({ children }) {
    return (_jsx("pre", { className: "max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg", children: children }));
}
/** Line-level colouring. Enough to read a change; not a merge tool. */
function Diff({ diff }) {
    return (_jsx("pre", { className: "max-h-80 overflow-auto font-mono text-xs", "data-testid": "diff", children: diff.split("\n").map((line, index) => (_jsx("div", { className: line.startsWith("+")
                ? "bg-ok/10 text-ok"
                : line.startsWith("-")
                    ? "bg-danger/10 text-danger"
                    : line.startsWith("@@")
                        ? "text-muted"
                        : "", children: line || " " }, index))) }));
}
function Unknown({ raw }) {
    const [open, setOpen] = useState(false);
    return (_jsxs("div", { children: [_jsx("button", { type: "button", className: "text-xs text-accent", onClick: () => setOpen((value) => !value), children: open ? "收起原始数据" : "展开原始数据" }), open ? _jsx(Pre, { children: JSON.stringify(raw, null, 2) }) : null] }));
}
