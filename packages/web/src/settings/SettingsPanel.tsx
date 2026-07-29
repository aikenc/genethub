import { useEffect, useState } from "react";

import type { Endpoint, Host } from "../host";
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
export function SettingsPanel({ host, endpoint }: { host: Host; endpoint?: Endpoint | null }) {
  const {
    settings,
    loadSettings,
    setProvider,
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
          密钥只保存在这台机器上，写入后不会再被读出来。
        </p>
        <div className="flex flex-col gap-2">
          {KNOWN_PROVIDERS.map((provider) => (
            <ProviderRow
              key={provider.id}
              id={provider.id}
              label={provider.label}
              configured={
                settings?.providers.find((entry) => entry.id === provider.id)?.hasApiKey ?? false
              }
              baseUrl={settings?.providers.find((entry) => entry.id === provider.id)?.baseUrl ?? ""}
              onSave={(apiKey, baseUrl) =>
                setProvider({ providerId: provider.id, apiKey, baseUrl })
              }
            />
          ))}
        </div>
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

function ProviderRow({
  id,
  label,
  configured,
  baseUrl,
  onSave,
}: {
  id: string;
  label: string;
  configured: boolean;
  baseUrl: string;
  onSave(apiKey: string, baseUrl: string): Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(baseUrl);
  const [busy, setBusy] = useState(false);

  useEffect(() => setUrl(baseUrl), [baseUrl]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-surface px-3 py-2">
      <span className="w-24 shrink-0 text-sm">{label}</span>
      <input
        aria-label={`${label} API Key`}
        type="password"
        className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        placeholder={configured ? "已配置，输入新值可替换" : "sk-…"}
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <input
        aria-label={`${label} 接口地址`}
        className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        placeholder="接口地址（可选）"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button
        type="button"
        data-testid={`save-${id}`}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
        disabled={busy || (key.length === 0 && url === baseUrl)}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(key, url);
            setKey("");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
