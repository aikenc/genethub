import type { GitChangeKind } from "@genehub/proto";
import { useEffect, useState } from "react";

import { useWorkbench } from "../session/store";

/**
 * What the agent actually changed, and a way to commit it.
 *
 * This is the panel people look at before they trust anything: a diff they can
 * read beats a paragraph claiming the work is done. Committing is here for the
 * same reason — reviewing and recording a change belong in the same place.
 */
export function ChangesPanel() {
  const { git, diff, refreshGit, loadDiff, commit } = useWorkbench();
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!git) void refreshGit();
  }, [git, refreshGit]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex max-h-56 shrink-0 flex-col border-b border-line md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <span className="truncate">{git?.branch ?? "（无分支）"}</span>
          <button
            type="button"
            className="ml-auto text-muted hover:text-fg"
            onClick={() => void refreshGit()}
          >
            刷新
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto p-1 text-sm">
          {(git?.changes ?? []).map((change) => (
            <li key={`${change.path}:${String(change.staged)}`}>
              <button
                type="button"
                aria-current={selected === change.path}
                className={`flex w-full items-center gap-2 truncate rounded px-2 py-1 text-left hover:bg-raised ${
                  selected === change.path ? "bg-raised" : ""
                }`}
                onClick={() => {
                  setSelected(change.path);
                  void loadDiff(change.path);
                }}
              >
                <span className={`w-3 shrink-0 font-mono text-xs ${tone(change.kind)}`}>
                  {mark(change.kind)}
                </span>
                <span className="truncate font-mono text-xs">{change.path}</span>
              </button>
            </li>
          ))}
          {git?.clean ? <li className="p-2 text-xs text-muted">工作区干净</li> : null}
        </ul>

        <div className="border-t border-line p-2">
          <textarea
            aria-label="提交说明"
            className="h-16 w-full resize-none rounded border border-line bg-bg p-2 text-xs outline-none focus:border-accent"
            placeholder="提交说明"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button
            type="button"
            className="mt-1 w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
            disabled={busy || message.trim().length === 0 || (git?.clean ?? true)}
            onClick={async () => {
              setBusy(true);
              try {
                await commit(message.trim());
                setMessage("");
                setSelected(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "提交中…" : "提交全部改动"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {diff ? (
          <Diff text={diff} />
        ) : (
          <p className="m-auto p-4 text-sm text-muted">
            选一个文件看它的改动，或者
            <button
              type="button"
              className="px-1 text-accent underline"
              onClick={() => {
                setSelected(null);
                void loadDiff();
              }}
            >
              看全部
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="p-3 font-mono text-xs leading-relaxed" data-testid="diff">
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-ok"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-danger"
                : line.startsWith("@@")
                  ? "text-accent"
                  : "text-muted"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function mark(kind: GitChangeKind): string {
  return { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "?" }[kind];
}

function tone(kind: GitChangeKind): string {
  return kind === "deleted" ? "text-danger" : kind === "added" ? "text-ok" : "text-muted";
}
