import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { ToolCallView } from "./ToolCall";
export function Timeline({ state }) {
    const bottom = useRef(null);
    const scroller = useRef(null);
    const [pinned, setPinned] = useState(true);
    // Stay at the bottom while new content arrives, unless the user scrolled up
    // to read something — then leave them where they are.
    useEffect(() => {
        if (pinned)
            bottom.current?.scrollIntoView({ block: "end" });
    }, [state.items, pinned]);
    return (_jsxs("div", { ref: scroller, className: "flex-1 space-y-3 overflow-y-auto px-4 py-4", "data-testid": "timeline", onScroll: (event) => {
            const element = event.currentTarget;
            const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
            setPinned(distance < 40);
        }, children: [state.items.map((item) => (_jsx(Item, { item: item }, item.id))), state.lastError ? (_jsx("p", { className: "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger", role: "alert", children: state.lastError.message })) : null, _jsx("div", { ref: bottom })] }));
}
function Item({ item }) {
    switch (item.type) {
        case "userMessage":
            return (_jsx("div", { className: "flex justify-end", children: _jsx("p", { className: "max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent px-3 py-2 text-white", children: item.text }) }));
        case "assistantMessage":
            return (_jsx("p", { className: "whitespace-pre-wrap", "data-testid": "assistant-message", children: item.text }));
        case "reasoning":
            return _jsx(Reasoning, { text: item.text });
        case "toolCall":
            return _jsx(ToolCallView, { name: item.name, status: item.status, detail: item.detail });
        case "todo":
            return (_jsx("ul", { className: "space-y-1 rounded-lg border border-line bg-surface px-3 py-2", children: item.items.map((entry, index) => (_jsx("li", { className: entry.status === "completed" ? "text-muted line-through" : "", children: entry.text }, index))) }));
        case "compaction":
            return (_jsxs("p", { className: "text-center text-xs text-muted", children: ["\u2014\u2014 \u5386\u53F2\u5DF2\u538B\u7F29\uFF08", item.reason, "\uFF09\u2014\u2014"] }));
        case "error":
            return (_jsx("p", { className: "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger", children: item.message }));
    }
}
/** Collapsed by default: it is context, not the answer. */
function Reasoning({ text }) {
    const [open, setOpen] = useState(false);
    return (_jsxs("div", { className: "rounded-lg border border-line bg-raised px-3 py-2 text-xs text-muted", children: [_jsx("button", { type: "button", onClick: () => setOpen((value) => !value), className: "text-accent", children: open ? "收起思考过程" : "思考过程" }), open ? _jsx("p", { className: "mt-1 whitespace-pre-wrap", children: text }) : null] }));
}
