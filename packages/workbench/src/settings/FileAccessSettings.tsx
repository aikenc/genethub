import { useEffect, useState } from "react";
import type { FileAccessInfo } from "@genehub/proto";
import type { Client } from "../protocol/client";

/** Machine policy is visible independently of whichever project is selected. */
export function FileAccessSettings({client}: {client: Client}) {
  const [info, setInfo] = useState<FileAccessInfo | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const accept = (value: FileAccessInfo) => { setInfo(value); setText(value.additionalDirectories.join("\n")); };
  useEffect(() => {
    let cancelled = false;
    setInfo(null); setText("");
    setProblem("");
    void client.call({type: "fileAccess.list"}).then(reply => {
      if (!cancelled && reply?.type === "fileAccess") accept(reply.data);
    }).catch(error => { if (!cancelled) setProblem(String(error)); });
    return () => { cancelled = true; };
  }, [client, reload]);
  const save = async () => {
    if (!info) return;
    setBusy(true); setProblem("");
    try {
      const reply = await client.call({type: "fileAccess.configure", payload: {expectedRevision: info.revision,
        additionalDirectories: text.split("\n").map(path => path.trim()).filter(Boolean)}});
      if (reply?.type !== "fileAccess") throw new Error("设备未确认目录配置");
      accept(reply.data);
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section aria-label="可访问目录">
    <h2 className="mb-2 text-sm font-medium">可访问目录</h2>
    <p className="mb-2 text-xs text-muted">已登记项目的目录自动加入。这里可以补充源机器上的其他目录。</p>
    {info ? <ul className="mb-3 space-y-1 text-xs">{info.directories.map(directory => <li key={directory.absolutePath}>
      <code className="break-all">{directory.absolutePath}</code><span className="ml-2 text-muted">{directory.workspaceIds.length ? `${directory.workspaceIds.length} 个项目` : ""}{directory.additional ? " · 手动配置" : ""}</span>
    </li>)}</ul> : null}
    <label className="block text-xs">补充目录（每行一个绝对路径）
      <textarea aria-label="补充目录" value={text} onChange={event => setText(event.target.value)} rows={4} className="mt-1 w-full rounded border border-line bg-bg p-2 font-mono" />
    </label>
    {problem ? <p role="alert" className="my-2 text-xs text-danger">{problem}</p> : null}
    <button disabled={!info || busy} onClick={() => void save()} className="mt-2 rounded border border-line px-3 py-1 text-xs disabled:opacity-50">{busy ? "保存中…" : "保存目录配置"}</button>
    <button disabled={busy} onClick={() => setReload(value => value + 1)} className="ml-2 rounded border border-line px-3 py-1 text-xs">重新加载目录</button>
  </section>;
}
