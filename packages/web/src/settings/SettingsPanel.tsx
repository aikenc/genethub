import type { ProviderInfo } from "@genehub/proto";
import { useEffect, useState } from "react";

import type { Endpoint, Host } from "../host";
import { Pairing } from "../hub/Pairing";
import { useWorkbench } from "../session/store";

/**
 * The providers offered before anything is configured.
 *
 * Only a starting point for the page: which providers exist is the daemon's
 * answer (`settings.providers`), and one the user added shows up there too.
 */
const OFFERED = [
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
export function SettingsPanel({ host, endpoint }: { host: Host; endpoint?: Endpoint | null }) {
  const {
    settings,
    loadSettings,
    setProvider,
    forgetProvider,
    agents,
    hub,
    claim,
    pair,
    trial,
    claimLink,
    unpair,
    client,
  } = useWorkbench();

  useEffect(() => {
    if (client && !settings) void loadSettings();
  }, [client, settings, loadSettings]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto p-4">
      <Machine identity={client?.identity ?? null} expected={endpoint?.fingerprint} />

      <section>
        <h2 className="mb-2 text-sm font-medium">模型密钥</h2>
        <p className="mb-3 text-xs text-muted">
          密钥只保存在这台机器上，写入后不会再被读出来。填好之后模型列表由对方给出，不用手填。
        </p>
        <div className="flex flex-col gap-2">
          {rows(settings?.providers).map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              onSave={(input) => setProvider({ providerId: provider.id, ...input })}
              onForget={provider.custom ? () => forgetProvider(provider.id) : undefined}
            />
          ))}
        </div>
        <AddProvider
          taken={(settings?.providers ?? []).map((provider) => provider.id)}
          onAdd={(input) => setProvider(input)}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Agent</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-2 rounded bg-surface px-3 py-2">
              <span>{agent.label}</span>
              {agent.builtin ? <span className="text-xs text-muted">内置</span> : null}
              <span className="ml-auto text-xs text-muted">
                {agent.probe.state === "ready"
                  ? "可用"
                  : agent.probe.state === "notInstalled"
                    ? "未安装"
                    : agent.probe.reason}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">远程访问</h2>
        <Pairing
          status={hub}
          claim={claim}
          host={host}
          // Empty in a build of this repository alone, which has no Hub to
          // suggest. A deployment that runs one bakes it in, and then "先体验"
          // is a single click instead of an address to look up.
          defaultHubUrl={import.meta.env.VITE_GENEHUB_HUB_URL ?? ""}
          onPair={(hubUrl) => pair(hubUrl)}
          onTrial={(hubUrl) => trial(hubUrl)}
          onClaimLink={() => claimLink()}
          onUnpair={() => unpair()}
        />
      </section>
    </div>
  );
}

/**
 * Which machine answered, and the fingerprint of the key it answered with.
 *
 * Shown on every host, not only the remote ones: a fingerprint is only useful
 * if the user has somewhere to read the expected value, and the desktop is that
 * somewhere ([security-model.md](../../docs/security-model.md) §1.2). Where the
 * shell knows the fingerprint independently we compare the two ourselves,
 * because a mismatch there means something is sitting in the middle.
 */
function Machine({
  identity,
  expected,
}: {
  identity: { machineId: string; fingerprint: string; daemonVersion: string } | null;
  expected?: string;
}) {
  if (!identity) return null;
  const mismatched = expected !== undefined && expected !== identity.fingerprint;

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">这台机器</h2>
      <div className="flex flex-col gap-1 rounded bg-surface px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted">公钥指纹</span>
          <code data-testid="fingerprint" className="font-mono text-sm tracking-wider">
            {identity.fingerprint}
          </code>
        </div>
        <p className="text-muted">
          在别的设备上连到这台机器时，核对这串指纹是否一致；不一致说明连的不是这台机器。
        </p>
        <div className="flex gap-3 text-muted">
          <span>{identity.machineId}</span>
          <span>daemon {identity.daemonVersion}</span>
        </div>
        {mismatched ? (
          <p role="alert" className="text-danger">
            指纹与本机记录的 {expected} 不一致，先不要在这条连接上输入任何密钥。
          </p>
        ) : null}
      </div>
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
      {provider.models.length} 个模型可选：{provider.models.slice(0, 4).join("、")}
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
        <button
          type="button"
          className="rounded border border-line px-3 py-1 text-xs"
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
    </div>
  );
}
