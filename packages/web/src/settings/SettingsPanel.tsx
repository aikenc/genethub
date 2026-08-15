import type {
  ProviderInfo,
  SpeechRuntimeStatus,
  SpeechSettings,
  UpdateStatus,
} from "@genehub/proto";
import { useEffect, useState } from "react";

import { BUILD } from "../build";
import { CHANNEL } from "../channel";
import type { Endpoint, Host } from "../host";
import { Pairing } from "../hub/Pairing";
import type { RtcState } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { THEME_OPTIONS, useTheme } from "../theme/store";
import { readRtcEnabled, writeRtcEnabled } from "./rtc";

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

const OFFICIAL_RELEASES = "https://github.com/aikenc/genethub/releases";
const QWEN3_ASR_DOCS = "https://github.com/QwenLM/Qwen3-ASR";
const SPEECH_ADAPTER_DOCS =
  "https://github.com/aikenc/genethub/blob/main/docs/speech-runtime-adapter.md";

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
    setSpeechQwen3,
    probeSpeechRuntime,
    agents,
    hub,
    claim,
    pair,
    trial,
    claimLink,
    unpair,
    client,
    activeWorkspaceId,
  } = useWorkbench();

  useEffect(() => {
    if (client && !settings) void loadSettings();
  }, [client, settings, loadSettings]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto p-4">
      <Machine identity={client?.identity ?? null} expected={endpoint?.fingerprint} />

      <Appearance />

      <RtcConnection />

      {client?.identity?.features?.includes("speech.transcribe.v2") ? (
        <SpeechSettingsCard
          host={host}
          speech={settings?.speech}
          workspaceId={activeWorkspaceId ?? undefined}
          onSave={setSpeechQwen3}
          onProbe={probeSpeechRuntime}
        />
      ) : null}

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

      <Version host={host} endpoint={endpoint} daemonVersion={client?.identity?.daemonVersion} />
    </div>
  );
}

function SpeechSettingsCard({
  host,
  speech,
  workspaceId,
  onSave,
  onProbe,
}: {
  host: Host;
  speech?: SpeechSettings;
  workspaceId?: string;
  onSave(input: {
    stubEnabled: boolean;
    contextEnabled: boolean;
    pinnedTerms: string[];
    languageHints: string[];
    collectCorrections: boolean;
    workspaceId?: string;
  }): Promise<void>;
  onProbe(): Promise<SpeechRuntimeStatus | null>;
}) {
  const [stubEnabled, setStubEnabled] = useState(speech?.stubEnabled ?? false);
  const [contextEnabled, setContextEnabled] = useState(speech?.contextEnabled ?? true);
  const [terms, setTerms] = useState((speech?.pinnedTerms ?? []).join("\n"));
  const [languages, setLanguages] = useState((speech?.languageHints ?? []).join(", "));
  const [collectCorrections, setCollectCorrections] = useState(
    Boolean(workspaceId && speech?.correctionWorkspaces.includes(workspaceId)),
  );
  const [busy, setBusy] = useState<"save" | "probe" | null>(null);
  const [probe, setProbe] = useState<SpeechRuntimeStatus | null>(null);

  useEffect(() => {
    setProbe(null);
    setStubEnabled(speech?.stubEnabled ?? false);
    setContextEnabled(speech?.contextEnabled ?? true);
    setTerms((speech?.pinnedTerms ?? []).join("\n"));
    setLanguages((speech?.languageHints ?? []).join(", "));
    setCollectCorrections(
      Boolean(workspaceId && speech?.correctionWorkspaces.includes(workspaceId)),
    );
  }, [speech, workspaceId]);

  const parsedTerms = lines(terms);
  const parsedLanguages = languages
    .split(/[\s,，]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const canSave = parsedTerms.length <= 50 && parsedLanguages.length <= 4;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">语音转文字</h2>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">Qwen3-ASR 推荐</span>
      </div>
      <div className="flex flex-col gap-3 rounded bg-surface px-3 py-3 text-xs">
        <div>
          <p className="font-medium text-fg">
            {speech?.runtime.implementation === "stub"
              ? speech.runtime.label
              : speech?.runtime.model || speech?.runtime.label || "尚未安装本地语音模型"}
          </p>
          <p className="mt-0.5 text-faint">
            GeneHub 会把真实麦克风音频流式送到当前选择的本机 runtime，并把 revisioned Best-1 原位写入输入框。runtime 只有真实提供 N-best、分段和不确定词时，界面才会显示相应候选；不会伪造置信度。
          </p>
          {speech?.runtime.implementation === "mock" ? (
            <p className="mt-1 text-muted">开发 Mock 已启用：音频只在浏览器内用于波形，不执行模型推理。</p>
          ) : null}
          {speech?.runtime.implementation === "stub" ? (
            <p className="mt-1 text-muted">协议 Stub 正在使用正式音频链路，但只会返回固定测试文字。</p>
          ) : null}
        </div>

        <label className="flex items-start gap-2 rounded border border-line px-2 py-2">
          <input
            type="checkbox"
            role="switch"
            aria-label="语音协议 Stub"
            checked={stubEnabled}
            onChange={(event) => setStubEnabled(event.currentTarget.checked)}
          />
          <span>
            <span className="block text-fg">启用语音协议 Stub（测试模式）</span>
            <span className="mt-0.5 block text-faint">
              保存语音设置后生效。不安装或运行模型；真实麦克风 PCM 仍按正式链路分块送到 daemon，Stub 返回固定的 Partial、分段 N-best 和低置信候选，用于验证 UI 与 Adapter 契约。音频不保存，候选选择不会写入训练数据；关闭并保存后恢复已登记的真实 Runtime。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 rounded border border-line px-2 py-2">
          <input
            type="checkbox"
            checked={contextEnabled}
            onChange={(event) => setContextEnabled(event.currentTarget.checked)}
          />
          <span>
            <span className="block text-fg">使用当前会话和项目术语增强识别</span>
            <span className="mt-0.5 block text-faint">
              活动工作区 ID 自动维护。读取最近对话、当前草稿、工作区/文件名，以及项目显式提供的 .genethub/speech/context.md、terms.txt 和 learned-terms.txt；不会遍历读取普通文件正文。
            </span>
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted">固定专业术语（每行一个，最多 50 个）</span>
          <textarea
            aria-label="固定专业术语"
            rows={4}
            className="resize-y rounded border border-line bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
            placeholder={"GeneHub\nPipeSpace\nQwen3-ASR"}
            value={terms}
            onChange={(event) => setTerms(event.currentTarget.value)}
          />
        </label>

        <label className="flex items-start gap-2 rounded border border-line px-2 py-2">
          <input
            type="checkbox"
            checked={collectCorrections}
            disabled={!workspaceId}
            onChange={(event) => setCollectCorrections(event.currentTarget.checked)}
          />
          <span>
            <span className="block text-fg">为当前项目沉淀我主动选择的候选</span>
            <span className="mt-0.5 block text-faint">
              {workspaceId
                ? "只为当前项目写入 .genethub/speech/preferences.jsonl 和 learned-terms.txt；切换项目不会沿用授权。只记录主动纠正，不保存音频、不自动上传，并默认写入该目录的 .gitignore。关闭收集不会删除已有文件，可直接检查、导出或删除。"
                : "请先选择一个工作区；纠正收集不会按整台机器全局开启。"}
            </span>
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted">语言提示（逗号分隔，最多 4 个）</span>
          <input
            aria-label="语音语言提示"
            className="rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
            placeholder="zh, en"
            value={languages}
            onChange={(event) => setLanguages(event.currentTarget.value)}
          />
        </label>

        {parsedTerms.length > 50 || parsedLanguages.length > 4 ? (
          <p role="alert" className="text-danger">专业术语最多 50 个，语言提示最多 4 个。</p>
        ) : null}

        <p className="text-faint">
          GeneHub 只提供 UI、连接协议、上下文和反馈接口，不下载模型或创建 Python 环境。可在内置 Agent 中说“安装本地语音模型”，它会使用 genehub-speech-runtime Skill 先检查硬件、说明方案并征得确认，再按社区文档安装、探测和登记。
          <button
            type="button"
            className="ml-1 underline decoration-dotted hover:text-accent"
            onClick={() => host.openExternal(QWEN3_ASR_DOCS)}
          >
            查看 Qwen3-ASR 社区运行说明
          </button>
          <button
            type="button"
            className="ml-1 underline decoration-dotted hover:text-accent"
            onClick={() => host.openExternal(SPEECH_ADAPTER_DOCS)}
          >
            查看 Adapter 接入契约
          </button>
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="save-speech-qwen3"
            className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-40"
            disabled={busy !== null || !canSave}
            onClick={async () => {
              setBusy("save");
              setProbe(null);
              try {
                await onSave({
                  stubEnabled,
                  contextEnabled,
                  pinnedTerms: parsedTerms,
                  languageHints: parsedLanguages,
                  collectCorrections,
                  workspaceId,
                });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "save" ? "保存中…" : "保存语音设置"}
          </button>
          <button
            type="button"
            data-testid="probe-speech-qwen3"
            className="rounded border border-line px-3 py-1.5 hover:border-accent disabled:opacity-40"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("probe");
              try {
                setProbe(await onProbe());
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "probe" ? "检查中…" : "检查语音 runtime"}
          </button>
          <SpeechRuntimeProbeStatus status={probe} />
        </div>
      </div>
    </section>
  );
}

function SpeechRuntimeProbeStatus({ status }: { status: SpeechRuntimeStatus | null }) {
  if (!status) return <span className="text-muted">尚未检查 runtime</span>;
  if (status.state === "ready") return <span role="status" className="text-accent-bright">语音 runtime 就绪</span>;
  return <span role="alert" className="text-danger">{status.message}</span>;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function RtcConnection() {
  const client = useWorkbench((state) => state.client);
  const [enabled, setEnabled] = useState(readRtcEnabled);
  const [state, setState] = useState<RtcState>(() => client?.rtcState ?? "standby");

  useEffect(() => {
    setState(client?.rtcState ?? (enabled ? "standby" : "disabled"));
    return client?.onRtcStateChange?.(setState);
  }, [client, enabled]);

  const change = (next: boolean) => {
    setEnabled(next);
    writeRtcEnabled(next);
    client?.setRtcEnabled?.(next);
    if (!client) setState(next ? "standby" : "disabled");
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">点对点连接</h2>
      <div className="flex items-center gap-3 rounded bg-surface px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <p>优先使用 WebRTC 直连</p>
          <p className="mt-0.5 text-faint" data-testid="rtc-status">
            {rtcLabel(state, client?.identity?.transport)}
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-2">
          <span className="sr-only">WebRTC 直连</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="WebRTC 直连"
            checked={enabled}
            onChange={(event) => change(event.currentTarget.checked)}
          />
          <span>{enabled ? "开" : "关"}</span>
        </label>
      </div>
      <p className="mt-1.5 text-[11px] text-faint">
        关闭后继续使用端到端加密的基础连接；开关只保存在当前浏览器。
      </p>
    </section>
  );
}

function rtcLabel(state: RtcState, transport?: string): string {
  switch (state) {
    case "disabled":
      return "已关闭";
    case "unavailable":
      return "当前客户端或 daemon 不支持 RTC";
    case "standby":
      return transport === "loopback" ? "当前是本机直连，无需 RTC" : "等待可升级的远程连接";
    case "connecting":
      return "正在建立 RTC 直连…";
    case "connected":
      return "RTC 已直连；新请求会走点对点通道";
    case "failed":
      return "RTC 直连失败；当前仍使用端到端加密基础连接";
  }
}

/**
 * Which palette this client draws itself in.
 *
 * Not in `settings.*`, which is the machine's and shared by everything
 * connected to it: a phone in a dark room and a laptop under an office light
 * are asking different questions, and one answer for both would be wrong on one
 * of them. So this is remembered here, per browser (`theme/store.ts`).
 */
function Appearance() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">外观</h2>
      <div className="flex flex-col gap-2 rounded bg-surface px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="radiogroup" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={preference === option.value}
                data-testid={`theme-${option.value}`}
                className={`rounded border px-2.5 py-1.5 ${
                  preference === option.value
                    ? "border-accent bg-raised text-fg"
                    : "border-line text-muted hover:border-line-strong hover:text-fg"
                }`}
                onClick={() => setPreference(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {preference === "system" ? (
            <span className="text-muted">系统现在是{resolved === "dark" ? "暗色" : "亮色"}。</span>
          ) : null}
        </div>
        <p className="text-faint">只对这台设备上的这个客户端生效。同一台机器从手机连过来，那边可以是另一个颜色。</p>
      </div>
    </section>
  );
}

/**
 * What an unstamped build calls itself.
 *
 * The version in the repository is 0.0.0 and the release workflow writes the tag
 * in as it builds (`scripts/version.mjs`), so this is the number every build made
 * from source reports — and printing it as "0.0.0" would read as a real release,
 * the very confusion the placeholder exists to avoid.
 */
const UNRELEASED = "0.0.0";

// The channel is part of the version's meaning: `0.23.0-beta.4` and `0.23.0`
// are two lines that never compare against each other, and the prefix is what
// keeps a screenshot of this page from being read as the other line
// (`scripts/channel.mjs` stamps CHANNEL in, like the version).
const PREFIX: Record<string, string> = {
  official: "正式版 ",
  beta: "Beta版 ",
  alpha: "Alpha版 ",
  dev: "开发版 ",
};
const devSuffix = () =>
  CHANNEL === "dev" && import.meta.env.VITE_GENEHUB_DEV_NAME ? ` ${import.meta.env.VITE_GENEHUB_DEV_NAME}` : "";
const shown = (version: string) =>
  `${version === UNRELEASED ? "开发版" : `${PREFIX[CHANNEL] ?? ""}${version}`}${devSuffix()}`;

/**
 * Which build this is, and whether a newer one has been published.
 *
 * Two numbers rather than one because they are two executables. A local Windows
 * bundle stamps one version into both, so disagreement there means an upgrade
 * only half landed. A remote daemon belongs to another machine and legitimately
 * updates on a different schedule; the endpoint decides which sentence applies.
 *
 * The check is a button and never a timer. The selected daemon checks itself;
 * the desktop shell checks its own Windows App. A local bundle can still fetch
 * through its daemon, while a remote client opens the installer on this computer.
 */
function Version({
  host,
  endpoint,
  daemonVersion,
}: {
  host: Host;
  endpoint?: Endpoint | null;
  daemonVersion?: string;
}) {
  const { update, appUpdate, updating, appUpdating, checkUpdates, client } = useWorkbench();
  const [app, setApp] = useState<string | null>(null);
  const localBundle = endpoint?.via === "loopback";

  useEffect(() => {
    void host.appVersion?.().then(setApp);
  }, [host]);

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">版本</h2>
      <div className="flex flex-col gap-2 rounded bg-surface px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          {app ? <span data-testid="app-version">应用 {shown(app)}</span> : null}
          <span className="text-muted" data-testid="daemon-version">
            daemon {daemonVersion ? shown(daemonVersion) : "未连接"}
          </span>
          <button
            type="button"
            data-testid="check-update"
            className="ml-auto rounded border border-line px-2 py-1 hover:border-accent disabled:opacity-40"
            // The machine is what does the looking, so with no connection there
            // is nothing to ask — and a button that can only answer "还没连上"
            // should not be pressable in the first place.
            disabled={updating || appUpdating || !client}
            onClick={() => void checkUpdates(host)}
          >
            {updating || appUpdating ? "检查中…" : "检查更新"}
          </button>
        </div>
        {/* The page is a third artefact, served from wherever it was last
            deployed to and updating on nobody's schedule but the deployer's.
            Without it the daemon's number reads as *the* version, and a
            deployment that was never rebuilt looks like a fixed bug that came
            back — an hour went that way once.

            Its own line, and selectable: it is long, it is meant to be quoted
            into a bug report, and above it sits a button it must never push off
            the row. */}
        <code className="select-all break-all font-mono text-faint" data-testid="page-build">
          页面 {BUILD}
        </code>
        <p className="text-muted" data-testid="manual-update-note">
          应用内自动下载和安装暂未启用。请从官方发布页手动下载，并通过独立可信渠道核对
          SHA256SUMS；同站点提供的校验值只能发现下载损坏。
          <button
            type="button"
            data-testid="manual-update-link"
            className="ml-1 underline decoration-dotted hover:text-accent"
            onClick={() => host.openExternal(OFFICIAL_RELEASES)}
          >
            打开官方发布页
          </button>
        </p>
        {/* Not for a build from source: a developer running a fresh shell against
            an installed daemon is not a broken upgrade, and saying so would be
            crying wolf at the one person who can tell the difference. */}
        {localBundle && app && daemonVersion && app !== daemonVersion && app !== UNRELEASED ? (
          <p role="alert" className="text-danger">
            两个版本不一致，上次升级大概只装了一半。重新装一遍安装包，或者从托盘退出再打开。
          </p>
        ) : null}
        {!localBundle && app && daemonVersion && app !== daemonVersion ? (
          <p className="text-muted" data-testid="remote-version-note">
            客户端 App 和远程 daemon 分别更新，版本可以不同。
          </p>
        ) : null}
        {appUpdate && (!localBundle || appUpdate.newer) ? <AppAnswer status={appUpdate} /> : null}
        <Answer status={update} subject={localBundle ? "整机" : "daemon"} />
      </div>
    </section>
  );
}

/**
 * What the check found.
 *
 * Every outcome gets a sentence, including the boring one: a button that answers
 * nothing looks broken, and a check that reached nothing must never be allowed to
 * read as "you are up to date".
 */
function Answer({ status, subject }: { status: UpdateStatus | null; subject: "整机" | "daemon" }) {
  if (!status) return null;
  if (status.problem) {
    return (
      <p role="alert" className="text-danger">
        没查到 {subject} 有没有新版本：{status.problem}
      </p>
    );
  }
  // A build from source is neither behind nor "the latest": it is not on the
  // scale at all, and "已经是最新的了" would be a claim nobody can check.
  if (status.current === UNRELEASED) {
    return (
      <p className="text-muted">这是从源码构建的开发版，不跟发布版本比较。最新发布是 {status.latest ?? "未知"}。</p>
    );
  }
  if (!status.newer) {
    return <p className="text-muted">{subject} 已经是最新的了。</p>;
  }

  return (
    <p className="text-muted">
      {subject} 有新版本 {status.latest}。自动下载未启用，请使用上方官方发布页手动更新。
    </p>
  );
}

function AppAnswer({ status }: { status: UpdateStatus }) {
  if (status.problem) {
    return (
      <p role="alert" className="text-danger">
        没查到客户端 App 有没有新版本：{status.problem}
      </p>
    );
  }
  if (status.current === UNRELEASED) {
    return <p className="text-muted">客户端 App 是源码构建的开发版，不跟发布版本比较。</p>;
  }
  if (!status.newer) {
    return <p className="text-muted">客户端 App 已经是最新的了。</p>;
  }
  return (
    <p className="text-muted">
      客户端 App 有新版本 {status.latest}。自动下载未启用，请使用上方官方发布页手动更新。
    </p>
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
  identity: { machineId: string; fingerprint: string } | null;
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
        <p className="text-muted">在别的设备上连到这台机器时，核对这串指纹是否一致；不一致说明连的不是这台机器。</p>
        {/* The version used to be here too, and moved to its own section: this
            one is about which machine answered, and a build number sat in it
            only because there was nowhere else to print one. */}
        <div className="flex gap-3 text-muted">
          <span>{identity.machineId}</span>
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
