import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * An approval sits at the bottom of the timeline rather than in a modal: the
 * user needs the surrounding context to decide, and a dialog hides exactly the
 * thing they are being asked about.
 */
export function PermissionCard({ request, onAnswer, }) {
    return (_jsxs("div", { className: "rounded-lg border border-accent/50 bg-accent/5 px-3 py-3", role: "group", "aria-label": "\u6743\u9650\u8BF7\u6C42", children: [_jsx("p", { className: "font-medium", children: request.title }), request.detail ? (_jsx("pre", { className: "mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted", children: request.detail })) : null, _jsx("div", { className: "mt-3 flex flex-wrap gap-2", children: request.options.map((option) => (_jsx("button", { type: "button", className: option.kind === "reject"
                        ? "rounded border border-line px-3 py-1.5 text-xs hover:border-danger hover:text-danger"
                        : "rounded bg-accent px-3 py-1.5 text-xs text-white", onClick: () => onAnswer({ outcome: "selected", optionId: option.id }), children: option.label }, option.id))) })] }));
}
