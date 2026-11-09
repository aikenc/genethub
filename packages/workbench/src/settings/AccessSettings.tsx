import { useCallback, useEffect, useState } from "react";
import type {
  AccessItem,
  AccessOutcome,
  AccessReport,
  AccessSetupResult,
  AccessState,
} from "@genehub/proto";
import type { Client } from "../protocol/client";

const STATE_LABEL: Record<AccessState, string> = {
  granted: "已允许",
  denied: "未允许",
  notDetermined: "未询问",
  unknown: "无法判断",
  needsRecheck: "需重新确认",
  notApplicable: "不适用",
};

const STATE_TONE: Record<AccessState, string> = {
  granted: "text-ok",
  denied: "text-danger",
  notDetermined: "text-muted",
  unknown: "text-muted",
  needsRecheck: "text-accent-bright",
  notApplicable: "text-muted",
};

const GROUPS: { id: string; title: string; hint: string }[] = [
  { id: "identity", title: "运行", hint: "让 GeneHub 自己的程序能被系统放行，并且更新后仍被认作同一个程序。" },
  { id: "disk", title: "磁盘", hint: "推荐直接授予“完全磁盘访问”；想按位置授权也可以逐项申请。" },
  { id: "network", title: "网络", hint: "只主动连出去无需任何设置；被其他设备直连时才可能要放行。" },
  { id: "desktop", title: "远程桌面（可选）", hint: "不用远程桌面就可以忽略。" },
];

const OUTCOME_TONE: Record<AccessOutcome["kind"], string> = {
  done: "text-ok",
  needsUser: "text-accent-bright",
  denied: "text-danger",
  skipped: "text-muted",
  failed: "text-danger",
};

/**
 * What this machine's operating system lets GeneHub do, and the shortest way to
 * get the rest granted. The machine decides what exists; this page only shows
 * it, so macOS, Windows and WSL share one screen.
 */
export function AccessSettings({ client }: { client: Client }) {
  const [report, setReport] = useState<AccessReport | null>(null);
  const [outcomes, setOutcomes] = useState<AccessOutcome[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProblem("");
    try {
      const reply = await client.call({ type: "access.list" });
      if (reply?.type !== "access") throw new Error("设备没有返回权限状态");
      setReport(reply.data);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ask = async (ids: string[] | null, label: string) => {
    setBusy(label);
    setProblem("");
    try {
      const reply = await client.call({ type: "access.request", payload: { ids } });
      if (reply?.type !== "accessSetup") throw new Error("设备没有确认申请");
      const result: AccessSetupResult = reply.data;
      setReport(result.report);
      setOutcomes(result.outcomes);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  if (!report) {
    return (
      <section aria-label="系统权限">
        <h2 className="mb-2 text-sm font-medium">系统权限</h2>
        {problem ? <p role="alert" className="text-xs text-danger">{problem}</p> : <p className="text-xs text-muted">正在检查…</p>}
      </section>
    );
  }

  const open = report.items.filter((item) => item.state !== "notApplicable");
  const missing = open.filter((item) => item.recommended && !["granted"].includes(item.state));
  const granted = open.filter((item) => item.state === "granted").length;

  return (
    <section aria-label="系统权限">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium">系统权限</h2>
        <button
          disabled={busy !== null}
          onClick={() => void refresh()}
          className="rounded border border-line px-2 py-0.5 text-xs disabled:opacity-50"
        >
          重新检查
        </button>
      </div>
      <p className="mb-2 text-xs text-muted">
        这台机器是你的个人服务器，只需要三类权限：运行自己的程序、读写磁盘、使用网络。
        {report.platform === "macos" ? "应用更新后，已授予的权限不会丢。" : ""}
      </p>
      {open.length === 0 ? (
        <p className="text-xs text-muted">这个系统没有需要在这里配置的权限。</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-line p-2 text-xs">
            <span>
              {granted} 项已允许
              {missing.length ? ` · ${missing.length} 项推荐项待处理` : " · 推荐项都已就绪"}
            </span>
            <button
              disabled={busy !== null || missing.length === 0}
              onClick={() => void ask(null, "all")}
              className="ml-auto rounded border border-line px-3 py-1 disabled:opacity-50"
            >
              {busy === "all" ? "申请中…" : "一键申请推荐项"}
            </button>
          </div>
          {report.locked ? (
            <p role="status" className="mb-2 text-xs text-accent-bright">
              这台电脑当前锁屏：会弹系统对话框的申请已暂停，解锁后再点。
            </p>
          ) : null}
          {GROUPS.map((group) => {
            const items = open.filter((item) => item.group === group.id);
            if (!items.length) return null;
            return (
              <div key={group.id} className="mb-3">
                <h3 className="text-xs font-medium">{group.title}</h3>
                <p className="mb-1 text-xs text-muted">{group.hint}</p>
                <ul className="space-y-2">
                  {items.map((item) => (
                    <AccessRow
                      key={item.id}
                      item={item}
                      outcome={outcomes.find((outcome) => outcome.id === item.id)}
                      busy={busy}
                      locked={!!report.locked}
                      onAsk={() => void ask([item.id], item.id)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
      {problem ? <p role="alert" className="mt-2 text-xs text-danger">{problem}</p> : null}
    </section>
  );
}

function AccessRow({
  item,
  outcome,
  busy,
  locked,
  onAsk,
}: {
  item: AccessItem;
  outcome?: AccessOutcome;
  busy: string | null;
  locked: boolean;
  onAsk: () => void;
}) {
  const needsDialog = item.action === "prompt" || item.action === "settings";
  const actionable = item.state !== "granted" && item.action !== "none" && item.action !== "command";
  const buttonLabel = item.action === "settings" ? "打开系统设置" : item.action === "fix" ? "修复" : "申请";
  return (
    <li className="rounded border border-line p-2 text-xs" data-testid={`access-${item.id}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {item.label}
            <span className={`ml-2 ${STATE_TONE[item.state]}`}>{STATE_LABEL[item.state]}</span>
          </div>
          <div className="text-muted">{item.purpose}</div>
          {item.detail ? <div className="mt-0.5">{item.detail}</div> : null}
          {item.holders.length && item.state !== "granted" ? (
            <div className="mt-0.5 text-muted">
              涉及：{item.holders.map((holder) => <code key={holder} className="mr-1 break-all">{holder}</code>)}
            </div>
          ) : null}
          {item.command ? (
            <div className="mt-1">
              需要管理员运行：
              <code className="block break-all rounded bg-bg p-1">{item.command}</code>
            </div>
          ) : null}
          {outcome ? <div className={`mt-1 ${OUTCOME_TONE[outcome.kind]}`}>{outcome.message}</div> : null}
        </div>
        {actionable ? (
          <button
            disabled={busy !== null || (needsDialog && locked)}
            onClick={onAsk}
            title={needsDialog && locked ? "这台电脑已锁屏" : undefined}
            className="shrink-0 rounded border border-line px-3 py-1 disabled:opacity-50"
          >
            {busy === item.id ? "处理中…" : buttonLabel}
          </button>
        ) : null}
      </div>
    </li>
  );
}
