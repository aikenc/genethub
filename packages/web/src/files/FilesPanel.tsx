import { useEffect, useState } from "react";

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
  const { tree, file, loadTree, openFile, saveFile } = useWorkbench();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tree) void loadTree();
  }, [tree, loadTree]);

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
          <p className="m-auto text-sm text-muted">{file.path} 不是文本文件</p>
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
