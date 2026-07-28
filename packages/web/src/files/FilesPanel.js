import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        if (!tree)
            void loadTree();
    }, [tree, loadTree]);
    // A file arriving replaces whatever was being edited; keeping the old draft
    // would silently paste it into a different file on the next save.
    useEffect(() => setDraft(null), [file?.path]);
    const dirty = draft !== null && file !== null && draft !== file.content;
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col md:flex-row", children: [_jsx("div", { className: "max-h-48 shrink-0 overflow-y-auto border-b border-line p-1 md:max-h-none md:w-64 md:border-b-0 md:border-r", children: tree ? (_jsx(FileTree, { root: tree, selected: file?.path ?? null, onOpen: (path) => void openFile(path), onExpand: (path) => void loadTree(path) })) : (_jsx("p", { className: "p-2 text-xs text-muted", children: "\u8F7D\u5165\u4E2D\u2026" })) }), _jsx("div", { className: "flex min-h-0 flex-1 flex-col", children: !file ? (_jsx("p", { className: "m-auto text-sm text-muted", children: "\u9009\u4E00\u4E2A\u6587\u4EF6" })) : !file.isText ? (_jsxs("p", { className: "m-auto text-sm text-muted", children: [file.path, " \u4E0D\u662F\u6587\u672C\u6587\u4EF6"] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs", children: [_jsx("span", { className: "truncate font-mono", children: file.path }), file.truncated ? _jsx("span", { className: "text-muted", children: "\uFF08\u5DF2\u622A\u65AD\uFF09" }) : null, _jsx("button", { type: "button", className: "ml-auto rounded bg-accent px-2 py-1 text-white disabled:opacity-40", disabled: !dirty || saving, onClick: async () => {
                                        if (draft === null)
                                            return;
                                        setSaving(true);
                                        try {
                                            await saveFile(draft);
                                            setDraft(null);
                                        }
                                        finally {
                                            setSaving(false);
                                        }
                                    }, children: saving ? "保存中…" : dirty ? "保存" : "已保存" })] }), _jsx("textarea", { "aria-label": `${file.path} 的内容`, className: "min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-xs leading-relaxed outline-none", spellCheck: false, value: draft ?? file.content, onChange: (event) => setDraft(event.target.value) })] })) })] }));
}
