import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Pairing } from "../hub/Pairing";
import { useWorkbench } from "../session/store";
const KNOWN_PROVIDERS = [
    { id: "deepseek", label: "DeepSeek" },
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
];
/**
 * Keys, agents and remote access.
 *
 * Keys are write-only: what comes back is whether one is set, never the value.
 * A client that is compromised later should not be able to read out a
 * credential it never saw.
 */
export function SettingsPanel({ host }) {
    const { settings, loadSettings, setProvider, agents, hub, pair, unpair } = useWorkbench();
    useEffect(() => {
        if (!settings)
            void loadSettings();
    }, [settings, loadSettings]);
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto p-4", children: [_jsxs("section", { children: [_jsx("h2", { className: "mb-2 text-sm font-medium", children: "\u6A21\u578B\u5BC6\u94A5" }), _jsx("p", { className: "mb-3 text-xs text-muted", children: "\u5BC6\u94A5\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u673A\u5668\u4E0A\uFF0C\u5199\u5165\u540E\u4E0D\u4F1A\u518D\u88AB\u8BFB\u51FA\u6765\u3002" }), _jsx("div", { className: "flex flex-col gap-2", children: KNOWN_PROVIDERS.map((provider) => (_jsx(ProviderRow, { id: provider.id, label: provider.label, configured: settings?.providers.find((entry) => entry.id === provider.id)?.hasApiKey ?? false, baseUrl: settings?.providers.find((entry) => entry.id === provider.id)?.baseUrl ?? "", onSave: (apiKey, baseUrl) => setProvider({ providerId: provider.id, apiKey, baseUrl }) }, provider.id))) })] }), _jsxs("section", { children: [_jsx("h2", { className: "mb-2 text-sm font-medium", children: "Agent" }), _jsx("ul", { className: "flex flex-col gap-1 text-sm", children: agents.map((agent) => (_jsxs("li", { className: "flex items-center gap-2 rounded bg-surface px-3 py-2", children: [_jsx("span", { children: agent.label }), agent.builtin ? _jsx("span", { className: "text-xs text-muted", children: "\u5185\u7F6E" }) : null, _jsx("span", { className: "ml-auto text-xs text-muted", children: agent.probe.state === "ready"
                                        ? "可用"
                                        : agent.probe.state === "notInstalled"
                                            ? "未安装"
                                            : agent.probe.reason })] }, agent.id))) })] }), _jsxs("section", { children: [_jsx("h2", { className: "mb-2 text-sm font-medium", children: "\u8FDC\u7A0B\u8BBF\u95EE" }), _jsx(Pairing, { status: hub, host: host, onPair: (hubUrl) => pair(hubUrl), onUnpair: () => unpair() })] })] }));
}
function ProviderRow({ id, label, configured, baseUrl, onSave, }) {
    const [key, setKey] = useState("");
    const [url, setUrl] = useState(baseUrl);
    const [busy, setBusy] = useState(false);
    useEffect(() => setUrl(baseUrl), [baseUrl]);
    return (_jsxs("div", { className: "flex flex-wrap items-center gap-2 rounded bg-surface px-3 py-2", children: [_jsx("span", { className: "w-24 shrink-0 text-sm", children: label }), _jsx("input", { "aria-label": `${label} API Key`, type: "password", className: "min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent", placeholder: configured ? "已配置，输入新值可替换" : "sk-…", value: key, onChange: (event) => setKey(event.target.value) }), _jsx("input", { "aria-label": `${label} 接口地址`, className: "min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent", placeholder: "\u63A5\u53E3\u5730\u5740\uFF08\u53EF\u9009\uFF09", value: url, onChange: (event) => setUrl(event.target.value) }), _jsx("button", { type: "button", "data-testid": `save-${id}`, className: "rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40", disabled: busy || (key.length === 0 && url === baseUrl), onClick: async () => {
                    setBusy(true);
                    try {
                        await onSave(key, url);
                        setKey("");
                    }
                    finally {
                        setBusy(false);
                    }
                }, children: busy ? "保存中…" : "保存" })] }));
}
