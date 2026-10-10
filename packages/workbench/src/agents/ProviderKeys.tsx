import type { ProviderInfo } from "@genehub/proto";
import { useEffect, useState } from "react";

import { useWorkbench } from "../session/store";

/**
 * The providers offered before anything is configured.
 *
 * Only a starting point for the page: which providers exist is the daemon's
 * answer (`settings.providers`), and one the user added shows up there too.
 */
const OFFERED = [
  { id: "kimi", label: "Kimi" },
  { id: "minimax", label: "MiniMax" },
  { id: "qwen", label: "千问" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
];

/**
 * Model keys for the built-in Agent.
 *
 * Keys are write-only: what comes back is whether one is set, never the value.
 * A client that is compromised later should not be able to read out a
 * credential it never saw.
 */
export function ProviderKeys() {
  const providers = useWorkbench((state) => state.settings?.providers);
  const setProvider = useWorkbench((state) => state.setProvider);
  const forgetProvider = useWorkbench((state) => state.forgetProvider);

  return (
    <section aria-label="模型密钥">
      <h3 className="mb-2 text-sm font-medium">内置 Agent 的模型密钥</h3>
      <p className="mb-3 text-xs text-muted">
        这些密钥供内置 Agent 调用模型，只保存在这台机器上，写入后不会再被读出来。模型列表由服务商提供；图片和视频输入能力可按模型设置。
      </p>
      <div className="flex flex-col gap-2">
        {rows(providers).map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onSave={(input) => setProvider({ providerId: provider.id, ...input })}
            onForget={provider.custom ? () => forgetProvider(provider.id) : undefined}
          />
        ))}
      </div>
      <AddProvider
        taken={(providers ?? []).map((provider) => provider.id)}
        onAdd={(input) => setProvider(input)}
      />
    </section>
  );
}

/**
 * The providers to show: the ones we offer, plus whatever else is configured.
 *
 * An unconfigured provider we ship still needs a row — that is where its key
 * gets typed — and it has no entry from the daemon yet, so one is made up here
 * with the address we would use.
 */
function rows(configured?: ProviderInfo[]): ProviderInfo[] {
  const known = configured ?? [];
  const missing = OFFERED.filter((offer) => !known.some((entry) => entry.id === offer.id)).map(
    (offer): ProviderInfo => ({
      id: offer.id,
      label: offer.label,
      hasApiKey: false,
      dialect: "openai",
      custom: false,
      models: [],
      modelInputs: {},
    }),
  );
  return [...known, ...missing].sort((a, b) => {
    // The ones we ship first, in the order they are offered; then the rest.
    const rank = (entry: ProviderInfo) => {
      const index = OFFERED.findIndex((offer) => offer.id === entry.id);
      return index === -1 ? OFFERED.length : index;
    };
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
}

interface Edit {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  modelInputs?: Record<string, string[]>;
}

function ProviderRow({
  provider,
  onSave,
  onForget,
}: {
  provider: ProviderInfo;
  onSave(input: Edit): Promise<void>;
  onForget?: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.baseUrl ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => setUrl(provider.baseUrl ?? ""), [provider.baseUrl]);

  return (
    <div className="flex flex-col gap-1 rounded bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-sm">{provider.label}</span>
        <input
          aria-label={`${provider.label} API Key`}
          type="password"
          className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder={provider.hasApiKey ? "已配置，输入新值可替换" : "sk-…"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          aria-label={`${provider.label} 接口地址`}
          className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          // Never blank for a provider we ship: an empty box invites the reading
          // that we do not know where to send this, and the address a key goes
          // to is not a detail to keep to ourselves.
          placeholder={provider.baseUrl ?? "接口地址"}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          type="button"
          data-testid={`save-${provider.id}`}
          className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
          disabled={busy || (key.length === 0 && url === (provider.baseUrl ?? ""))}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({ apiKey: key, baseUrl: url });
              setKey("");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "保存中…" : "保存"}
        </button>
        {onForget ? (
          <button
            type="button"
            data-testid={`forget-${provider.id}`}
            className="rounded border border-line px-2 py-1 text-xs hover:border-danger"
            onClick={() => void onForget()}
          >
            删除
          </button>
        ) : null}
      </div>
      <ModelsFound provider={provider} />
      {provider.models.length > 0 ? (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">配置模型图片 / 视频输入</summary>
          <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
            {provider.models.map((model) => (
              <div key={model} className="flex flex-wrap items-center gap-3 rounded border border-line px-2 py-1">
                <span className="min-w-40 flex-1 break-all text-fg">{model}</span>
                {(["image", "video"] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`${model} ${kind === "image" ? "图片" : "视频"}输入`}
                      checked={(provider.modelInputs?.[model] ?? []).includes(kind)}
                      disabled={busy || (kind === "video" && provider.dialect === "anthropic")}
                      onChange={(event) => {
                        const current = provider.modelInputs?.[model] ?? [];
                        const next = event.target.checked
                          ? [...current, kind]
                          : current.filter((input) => input !== kind);
                        setBusy(true);
                        void onSave({ modelInputs: { [model]: next } }).finally(() => setBusy(false));
                      }}
                    />
                    {kind === "image" ? "图片" : "视频"}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * What this key can actually use, or why nothing can.
 *
 * The failure matters more than the list. A rejected key leaves the picker empty
 * and looks exactly like a broken app from the outside; the provider already
 * said what was wrong, so it is repeated here rather than kept in a log.
 */
function ModelsFound({ provider }: { provider: ProviderInfo }) {
  if (provider.problem) {
    return (
      <p role="alert" className="text-xs text-danger">
        {provider.problem}
      </p>
    );
  }
  if (!provider.hasApiKey) return null;
  if (provider.models.length === 0) {
    return <p className="text-xs text-muted">没有可用模型。</p>;
  }
  return (
    <p className="text-xs text-muted">
      {provider.models.length} 个模型可选：
      {provider.models.slice(0, 4).join("、")}
      {provider.models.length > 4 ? " …" : ""}
    </p>
  );
}

/**
 * Somewhere else to send requests: a company gateway, a local llama.cpp, a
 * vendor we ship no address for.
 *
 * The address is required, and that is the point of the whole form. A provider
 * with a key and no address used to inherit OpenAI's, which sent one company's
 * secret to another's servers.
 */
function AddProvider({
  taken,
  onAdd,
}: {
  taken: string[];
  onAdd(input: {
    providerId: string;
    apiKey: string;
    baseUrl: string;
    label: string;
    dialect: string;
    models: string[];
  }): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dialect, setDialect] = useState("openai");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="mt-2 self-start rounded border border-line px-2 py-1 text-xs hover:border-accent"
        onClick={() => setOpen(true)}
      >
        添加自定义 provider
      </button>
    );
  }

  const clash = taken.includes(id.trim());
  const ready = id.trim().length > 0 && baseUrl.trim().length > 0 && !clash;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-line p-3">
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="provider id"
          className="w-32 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="id，如 kimi"
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <input
          aria-label="provider 名称"
          className="w-32 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="显示名（可选）"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          aria-label="provider 接口地址"
          className="min-w-56 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="接口地址，如 https://api.moonshot.cn/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="provider API Key"
          type="password"
          className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="sk-…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <select
          aria-label="接口协议"
          className="rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
          value={dialect}
          onChange={(event) => setDialect(event.target.value)}
        >
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 兼容</option>
        </select>
      </div>
      <input
        aria-label="模型列表"
        className="rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        placeholder="模型列表（可选，逗号分隔；留空就问对方要）"
        value={models}
        onChange={(event) => setModels(event.target.value)}
      />
      {clash ? <p className="text-xs text-danger">这个 id 已经有了。</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-provider"
          className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
          disabled={busy || !ready}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd({
                providerId: id.trim(),
                apiKey,
                baseUrl: baseUrl.trim(),
                label: label.trim(),
                dialect,
                models: models
                  .split(/[,，\n]/)
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              });
              setOpen(false);
              setId("");
              setLabel("");
              setBaseUrl("");
              setApiKey("");
              setModels("");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "保存中…" : "添加"}
        </button>
        <button type="button" className="rounded border border-line px-3 py-1 text-xs" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}
