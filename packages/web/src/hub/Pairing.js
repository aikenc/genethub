import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
/**
 * Connecting this machine to a Hub, so a phone or another browser can reach it.
 *
 * Everything here renders from `HubStatus`, which the daemon owns. The UI never
 * tracks "we are in step two of pairing" itself: a reload, a crash, or a second
 * window would each have their own idea of the step, and the one on the machine
 * is the only one that is true.
 */
export function Pairing({ status, host, onPair, onUnpair, defaultHubUrl = "", }) {
    const [hubUrl, setHubUrl] = useState(defaultHubUrl);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (status && "hubUrl" in status)
            setHubUrl(status.hubUrl);
    }, [status]);
    if (!status)
        return null;
    if (status.state === "paired") {
        return (_jsxs("section", { className: "space-y-2 rounded-lg border border-line bg-surface p-4", children: [_jsx(Row, { label: "\u5DF2\u8FDE\u63A5", value: status.hubUrl }), _jsx(Row, { label: "\u673A\u5668 ID", value: status.machineId }), _jsx("p", { className: "text-xs text-muted", children: status.online
                        ? "远程可达：手机和其他浏览器现在能找到这台电脑。"
                        : "已配对，但当前连不上 Hub。本机和局域网仍然可用。" }), _jsx("button", { type: "button", className: "rounded border border-line px-3 py-1.5 text-xs hover:border-danger hover:text-danger", disabled: busy, onClick: () => {
                        setBusy(true);
                        void onUnpair().finally(() => setBusy(false));
                    }, children: "\u65AD\u5F00\u8FDE\u63A5" })] }));
    }
    if (status.state === "pairing") {
        return (_jsxs("section", { className: "space-y-3 rounded-lg border border-accent/50 bg-accent/5 p-4 text-center", children: [_jsx("p", { className: "text-sm text-muted", children: "\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u4E0B\u9762\u7684\u5730\u5740\uFF0C\u8F93\u5165\u8FD9\u4E2A\u914D\u5BF9\u7801\uFF1A" }), _jsx("p", { className: "font-mono text-3xl tracking-[0.3em]", "data-testid": "user-code", children: status.userCode }), _jsx("button", { type: "button", className: "rounded bg-accent px-4 py-2 text-sm text-white", onClick: () => host.openExternal(status.verificationUriComplete), children: "\u6253\u5F00\u6388\u6743\u9875\u9762" }), _jsx("p", { className: "text-xs text-muted", children: status.verificationUri })] }));
    }
    return (_jsxs("section", { className: "space-y-3 rounded-lg border border-line bg-surface p-4", children: [_jsx("p", { className: "text-sm", children: "\u8FDE\u63A5\u5230 Hub \u4E4B\u540E\uFF0C\u624B\u673A\u548C\u5176\u4ED6\u7535\u8111\u4E0A\u7684\u6D4F\u89C8\u5668\u5C31\u80FD\u8FDC\u7A0B\u4F7F\u7528\u8FD9\u53F0\u673A\u5668\u3002\u4E0D\u8FDE\u63A5\u4E5F\u4E0D\u5F71\u54CD\u672C\u673A\u4F7F\u7528\u3002" }), status.state === "failed" ? (_jsx("p", { className: "text-xs text-danger", role: "alert", children: status.message })) : null, _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { className: "flex-1 rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent", "aria-label": "Hub \u5730\u5740", placeholder: "https://hub.example.com", value: hubUrl, onChange: (event) => setHubUrl(event.target.value) }), _jsx("button", { type: "button", className: "rounded bg-accent px-4 py-1.5 text-sm text-white disabled:opacity-40", disabled: busy || hubUrl.trim().length === 0, onClick: () => {
                            setBusy(true);
                            void onPair(hubUrl.trim()).finally(() => setBusy(false));
                        }, children: "\u83B7\u53D6\u914D\u5BF9\u7801" })] })] }));
}
function Row({ label, value }) {
    return (_jsxs("p", { className: "flex justify-between gap-4 text-sm", children: [_jsx("span", { className: "text-muted", children: label }), _jsx("span", { className: "truncate font-mono text-xs", children: value })] }));
}
