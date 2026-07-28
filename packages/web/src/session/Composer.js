import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
/**
 * The input area. Enter sends, shift+enter breaks the line, and while a turn is
 * running the send button becomes stop — one control, because the user's intent
 * ("make it go" / "make it stop") is never ambiguous.
 */
export function Composer({ running, disabled, onSend, onInterrupt, }) {
    const [draft, setDraft] = useState("");
    const send = () => {
        const text = draft.trim();
        if (!text)
            return;
        setDraft("");
        onSend(text);
    };
    return (_jsx("div", { className: "border-t border-line bg-surface p-3", children: _jsxs("div", { className: "flex items-end gap-2", children: [_jsx("textarea", { className: "max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent", placeholder: "describe the task", "aria-label": "\u4EFB\u52A1\u63CF\u8FF0", value: draft, disabled: disabled, onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            send();
                        }
                    } }), running ? (_jsx("button", { type: "button", onClick: onInterrupt, className: "rounded-lg border border-line px-4 py-2 hover:border-danger hover:text-danger", children: "\u505C\u6B62" })) : (_jsx("button", { type: "button", onClick: send, disabled: disabled || draft.trim().length === 0, className: "rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40", children: "\u53D1\u9001" }))] }) }));
}
