import { useEffect, useState } from "react";

import { formatBytes, ResourceBody, useResourcePreview } from "../session/ResourcePreview";
import { useWorkbench } from "../session/store";
import { FileTree } from "./FileTree";

/**
 * Files, as a reader with an escape hatch.
 *
 * Editing is deliberately plain: the agent does the writing, and a person
 * dropping in to fix a typo needs a textarea far more than they need a second
 * IDE. Anything heavier would be a second place for the file's state to live.
 */
export function FilesPanel() {
  const { tree, file, loadTree, openFile, saveFile, client } = useWorkbench();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Panels stay mounted from the first paint, which is before there is a
  // daemon to ask; loading anything earlier only produces a failure nobody
  // asked for.
  useEffect(() => {
    if (client && !tree) void loadTree();
  }, [client, tree, loadTree]);

  // A file arriving replaces whatever was being edited; keeping the old draft
  // would silently paste it into a different file on the next save.
  useEffect(() => setDraft(null), [file?.path]);

  const dirty = draft !== null && file !== null && draft !== file.content;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="max-h-48 shrink-0 overflow-y-auto border-b border-line p-1 md:max-h-none md:w-64 md:border-b-0 md:border-r">
        {tree ? (
          <FileTree
            root={tree}
            selected={file?.path ?? null}
            onOpen={(path) => void openFile(path)}
            onExpand={(path) => void loadTree(path)}
          />
        ) : (
          <p className="p-2 text-xs text-muted">载入中…</p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!file ? (
          <p className="m-auto text-sm text-muted">选一个文件</p>
        ) : !file.isText ? (
          <NonTextPreview path={file.path} />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
              <span className="truncate font-mono">{file.path}</span>
              {file.truncated ? <span className="text-muted">（已截断）</span> : null}
              <button
                type="button"
                className="ml-auto rounded bg-accent px-2 py-1 text-white disabled:opacity-40"
                disabled={!dirty || saving}
                onClick={async () => {
                  if (draft === null) return;
                  setSaving(true);
                  try {
                    await saveFile(draft);
                    setDraft(null);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "保存中…" : dirty ? "保存" : "已保存"}
              </button>
            </div>
            <textarea
              aria-label={`${file.path} 的内容`}
              className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-xs leading-relaxed outline-none"
              spellCheck={false}
              value={draft ?? file.content}
              onChange={(event) => setDraft(event.target.value)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What `file.read` refuses (`FileContent.isText === false`) via the resource
 * contract instead — same `ResourceBody` renderer an artifact card in the
 * chat timeline uses, so a screenshot looks the same whichever way it was
 * opened.
 */
function NonTextPreview({ path }: { path: string }) {
  const { phase, loadAnyway } = useResourcePreview(path, { auto: true });

  return (
    <div className="m-auto max-w-full space-y-3 p-4 text-center text-sm text-muted">
      <p className="truncate font-mono text-xs">{path}</p>
      {phase.step === "stating" || phase.step === "loading" ? <p>加载中…</p> : null}
      {phase.step === "statError" || phase.step === "loadError" ? (
        <p className="text-danger">{phase.message}</p>
      ) : null}
      {phase.step === "ready" ? (
        <div className="space-y-2">
          <p>
            {phase.meta.mime} · {formatBytes(phase.meta.size)}
          </p>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-white"
            onClick={loadAnyway}
          >
            加载预览
          </button>
        </div>
      ) : null}
      {phase.step === "loaded" ? (
        <div className="text-left">
          <ResourceBody content={phase.content} />
        </div>
      ) : null}
    </div>
  );
}
