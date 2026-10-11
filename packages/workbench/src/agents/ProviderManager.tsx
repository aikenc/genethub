import type { ModelCapabilities, ProviderInfo, ProviderPreset } from "@genehub/proto";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { useWorkbench } from "../session/store";
import { configuredProviders, DIALECT_LABEL, presetsToAdd } from "./providers";

const FIELD =
  "rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent";

/**
 * The model providers of the built-in Agent: the ones set up, and a way to add
 * one. A key for a provider is the same kind of thing as an Agent's login, so
 * it lives in the same place and is looked after the same way: write-only, kept
 * on this machine, never read back out.
 *
 * Only providers that are set up are listed. The ones we know an address for
 * are offered under "添加 provider", where they merely fill in the id, the
 * address and the protocol.
 */
export function ProviderManager() {
  const providers = useWorkbench((state) => state.settings?.providers);
  const shipped = useWorkbench((state) => state.settings?.presets);
  const setProvider = useWorkbench((state) => state.setProvider);
  const forgetProvider = useWorkbench((state) => state.forgetProvider);
  const configured = configuredProviders(providers);
  const [adding, setAdding] = useState(false);

  // Nothing set up yet: the form is the page.
  const showForm = adding || configured.length === 0;

  return (
    <section aria-label="模型 provider" className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        内置 Agent 通过这些 provider 调用模型。密钥只保存在这台机器上，写入后不会再被读出来；模型列表由服务商提供，保存后会向它核对密钥。
      </p>
      {configured.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="已配置的 provider">
          {configured.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              onSave={(input) => setProvider({ providerId: provider.id, ...input })}
              // A shipped provider is not deleted, only emptied: the daemon
              // keeps nothing of it that is worth showing.
              onRemove={() =>
                provider.custom ? forgetProvider(provider.id) : setProvider({ providerId: provider.id, apiKey: "" })
              }
            />
          ))}
        </ul>
      ) : null}
      {showForm ? (
        <AddProvider
          taken={(providers ?? []).filter((entry) => entry.custom || entry.hasApiKey).map((entry) => entry.id)}
          presets={presetsToAdd(providers, shipped)}
          onAdd={async (input) => {
            await setProvider(input);
            setAdding(false);
          }}
          onCancel={configured.length > 0 ? () => setAdding(false) : undefined}
        />
      ) : (
        <button
          type="button"
          className="flex min-h-11 items-center gap-1.5 self-start rounded border border-line px-3 text-xs text-accent hover:border-accent"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} aria-hidden /> 添加 provider
        </button>
      )}
    </section>
  );
}

interface Edit {
  apiKey?: string;
  baseUrl?: string;
  modelInputs?: Record<string, string[]>;
  modelCapabilities?: Record<string, ModelCapabilities>;
}

function ProviderRow({
  provider,
  onSave,
  onRemove,
}: {
  provider: ProviderInfo;
  onSave(input: Edit): Promise<void>;
  onRemove(): Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setUrl(provider.baseUrl ?? ""), [provider.baseUrl]);

  return (
    <li data-provider-id={provider.id} className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-20 shrink-0 text-sm text-fg">{provider.label}</span>
        <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
          {DIALECT_LABEL[provider.dialect] ?? provider.dialect}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={`${provider.label} API Key`}
          type="password"
          autoComplete="off"
          className={`min-w-40 flex-1 ${FIELD}`}
          placeholder={provider.hasApiKey ? "已配置，输入新值可替换" : "sk-…"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          aria-label={`${provider.label} 接口地址`}
          className={`min-w-40 flex-1 ${FIELD}`}
          // Never blank: an empty box invites the reading that we do not know
          // where to send this, and the address a key goes to is not a detail
          // to keep to ourselves.
          placeholder={provider.baseUrl ?? "接口地址"}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          type="button"
          data-testid={`save-${provider.id}`}
          className="min-h-9 rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
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
        {confirming ? (
          <span
            role="group"
            aria-label={`${provider.label} 移除确认`}
            className="flex items-center gap-1 rounded border border-danger/50 px-2"
          >
            <span className="text-xs text-fg">确认移除？</span>
            <button
              type="button"
              data-testid={`forget-${provider.id}`}
              aria-label={`确认移除 ${provider.label}`}
              className="min-h-9 rounded px-2 text-xs text-danger hover:underline disabled:opacity-40"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onRemove();
                } finally {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              确认
            </button>
            <button
              type="button"
              aria-label={`取消移除 ${provider.label}`}
              className="min-h-9 rounded px-2 text-xs text-muted hover:text-fg"
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            aria-label={`移除 ${provider.label}`}
            className="min-h-9 rounded border border-line px-2 py-1 text-xs hover:border-danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            移除
          </button>
        )}
      </div>
      <ModelsFound provider={provider} />
      {provider.models.length > 0 ? (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">配置模型能力（输入 / 思考 / 上下文）</summary>
          <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {provider.models.map((model) => (
              <ModelCapabilityRow
                key={model}
                model={model}
                provider={provider}
                busy={busy}
                onSave={(user) => {
                  setBusy(true);
                  return onSave({ modelCapabilities: { [model]: user } }).finally(() => setBusy(false));
                }}
              />
            ))}
          </div>
        </details>
      ) : null}
    </li>
  );
}

const THINKING_LABELS: Record<string, string> = {
  adaptive: "adaptive（模型自定思考量）",
  budget: "budget（固定思考预算）",
  only: "始终思考（不可关闭）",
  none: "不思考",
};

const SOURCE_LABELS: Record<string, string> = {
  rule: "规则",
  discovered: "服务商",
  user: "手动",
};

/** Where a value came from, next to it, so a wrong guess can be traced. */
function SourceTag({ source }: { source?: string }) {
  if (!source) return null;
  return <span className="rounded border border-line px-1 text-[10px] text-faint">{SOURCE_LABELS[source] ?? source}</span>;
}

/**
 * One model's capabilities: what the agent will be told, where each part came
 * from, and the user's override of it. Each edit sends the model's whole user
 * entry, so clearing a field hands it back to discovery and the rules.
 */
function ModelCapabilityRow({
  model,
  provider,
  busy,
  onSave,
}: {
  model: string;
  provider: ProviderInfo;
  busy: boolean;
  onSave(user: ModelCapabilities): Promise<void>;
}) {
  const info = provider.modelCapabilities?.[model];
  const effective = info?.effective ?? { inputs: provider.modelInputs?.[model] };
  const user = info?.user ?? {};
  const sources = info?.sources ?? {};
  const save = (change: Partial<ModelCapabilities>) => {
    const next: ModelCapabilities = { ...user, ...change };
    for (const field of Object.keys(next) as (keyof ModelCapabilities)[]) {
      if (next[field] === undefined) delete next[field];
    }
    return onSave(next);
  };
  const number = (field: "contextWindow" | "maxTokens", label: string) => (
    <NumberField
      label={`${model} ${label}`}
      placeholder={effective[field] === undefined ? "未知" : String(effective[field])}
      value={user[field]}
      disabled={busy}
      onCommit={(value) => void save({ [field]: value })}
    />
  );
  return (
    <div className="flex flex-col gap-1 rounded border border-line px-2 py-1">
      <span className="break-all text-fg">{model}</span>
      <div className="flex flex-wrap items-center gap-3">
        {(["image", "video"] as const).map((kind) => (
          <label key={kind} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`${model} ${kind === "image" ? "图片" : "视频"}输入`}
              checked={(effective.inputs ?? []).includes(kind)}
              disabled={busy || (kind === "video" && provider.dialect === "anthropic")}
              onChange={(event) => {
                const current = effective.inputs ?? [];
                const next = event.target.checked
                  ? [...current, kind]
                  : current.filter((input) => input !== kind);
                void save({ inputs: next });
              }}
            />
            {kind === "image" ? "图片" : "视频"}
          </label>
        ))}
        <SourceTag source={sources.inputs} />
        <label className="flex items-center gap-1">
          思考
          <select
            aria-label={`${model} 思考方式`}
            className="rounded border border-line bg-bg px-1 py-0.5"
            disabled={busy}
            value={user.thinking ?? ""}
            onChange={(event) => {
              const thinking = event.target.value || undefined;
              // Choosing a way to think says the model reasons; "none" says it does not.
              void save({
                thinking,
                reasoning: thinking === undefined ? undefined : thinking !== "none",
              });
            }}
          >
            <option value="">
              自动（{effective.thinking ? THINKING_LABELS[effective.thinking] ?? effective.thinking : effective.reasoning ? "budget" : "未知"}）
            </option>
            {Object.entries(THINKING_LABELS).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <SourceTag source={sources.thinking ?? sources.reasoning} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {number("contextWindow", "上下文窗口")}
        <SourceTag source={sources.contextWindow} />
        {number("maxTokens", "最大输出")}
        <SourceTag source={sources.maxTokens} />
      </div>
    </div>
  );
}

/** A token count, saved when the box loses focus; empty means automatic. */
function NumberField({
  label,
  placeholder,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value?: number;
  disabled: boolean;
  onCommit(value: number | undefined): void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const short = label.slice(label.lastIndexOf(" ") + 1);
  return (
    <label className="flex items-center gap-1">
      {short}
      <input
        aria-label={label}
        inputMode="numeric"
        className="w-28 rounded border border-line bg-bg px-1 py-0.5 outline-none focus:border-accent"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => {
          const next = text === "" ? undefined : Number(text);
          if (next !== value) onCommit(next);
        }}
      />
    </label>
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

const CUSTOM = "custom";

/**
 * Adds a provider: pick one we know, or none of them for a company gateway, a
 * local llama.cpp, a vendor we ship no address for. Picking one only fills in
 * the fields below, which stay editable.
 *
 * The address is required, and that is the point of the whole form. A provider
 * with a key and no address used to inherit OpenAI's, which sent one company's
 * secret to another's servers.
 */
function AddProvider({
  taken,
  presets,
  onAdd,
  onCancel,
}: {
  taken: string[];
  presets: ProviderPreset[];
  onAdd(input: {
    providerId: string;
    apiKey: string;
    baseUrl: string;
    label: string;
    dialect: string;
    models: string[];
  }): Promise<void>;
  onCancel?(): void;
}) {
  const [choice, setChoice] = useState<string>(CUSTOM);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dialect, setDialect] = useState("openai");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = (next: string) => {
    setChoice(next);
    const preset = presets.find((entry) => entry.id === next);
    setId(preset?.id ?? "");
    setLabel(preset?.label ?? "");
    setBaseUrl(preset?.baseUrl ?? "");
    setDialect(preset?.dialect ?? "openai");
  };

  const clash = taken.includes(id.trim());
  // A shipped provider without a key would not show up in the list at all.
  const ready =
    id.trim().length > 0 && baseUrl.trim().length > 0 && !clash && (choice === CUSTOM || apiKey.trim().length > 0);

  return (
    <div role="group" aria-label="添加 provider" className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <h4 className="text-xs font-medium text-fg">添加 provider</h4>
      <div role="radiogroup" aria-label="选择服务商" className="flex flex-wrap gap-1.5">
        {[...presets.map((preset) => ({ id: preset.id, label: preset.label })), { id: CUSTOM, label: "自定义" }].map(
          (option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={choice === option.id}
              className={`min-h-9 rounded-full border px-3 text-xs ${
                choice === option.id
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-line text-muted hover:text-fg"
              }`}
              onClick={() => pick(option.id)}
            >
              {option.label}
            </button>
          ),
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="provider id"
          className={`w-32 ${FIELD}`}
          placeholder="id，如 kimi"
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <input
          aria-label="provider 名称"
          className={`w-32 ${FIELD}`}
          placeholder="显示名（可选）"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          aria-label="provider 接口地址"
          className={`min-w-56 flex-1 ${FIELD}`}
          placeholder="接口地址，如 https://api.moonshot.cn/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="provider API Key"
          type="password"
          autoComplete="off"
          className={`min-w-40 flex-1 ${FIELD}`}
          placeholder="sk-…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <select
          aria-label="接口协议"
          className={FIELD}
          value={dialect}
          onChange={(event) => setDialect(event.target.value)}
        >
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 兼容</option>
        </select>
      </div>
      {choice === CUSTOM ? (
        <input
          aria-label="模型列表"
          className={FIELD}
          placeholder="模型列表（可选，逗号分隔；留空就问对方要，也借此核对 Key）"
          value={models}
          onChange={(event) => setModels(event.target.value)}
        />
      ) : null}
      {clash ? <p className="text-xs text-danger">这个 id 已经有了。</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-provider"
          className="min-h-9 rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
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
              pick(CUSTOM);
              setApiKey("");
              setModels("");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "保存中…" : "添加"}
        </button>
        {onCancel ? (
          <button type="button" className="min-h-9 rounded border border-line px-3 py-1 text-xs" onClick={onCancel}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}
