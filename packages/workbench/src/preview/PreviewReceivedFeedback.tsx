import { useState } from "react";
import type { PreviewFeedbackRecord, PreviewFeedbackSummary } from "@genehub/proto";
import type { Client } from "../protocol/client";
import { feedbackReceiptText, previewFeedback } from "./fileFeedback";
import { previewTextButton, PreviewToolbarPortal } from "./PreviewToolbar";

export function PreviewReceivedFeedback({ client, workspaceId, path, version, onAddToChat }: {
  client: Client;
  workspaceId: string;
  path: string;
  version: string;
  onAddToChat?: (receipt: PreviewFeedbackRecord) => void;
}) {
  const [records, setRecords] = useState<PreviewFeedbackSummary[]>();
  const [selected, setSelected] = useState<PreviewFeedbackRecord>();
  const [busy, setBusy] = useState(false);
  const [addedToChat, setAddedToChat] = useState<string>();
  const [problem, setProblem] = useState("");

  async function load(id?: string) {
    setBusy(true);
    setProblem("");
    try {
      const result = await previewFeedback(client, workspaceId, id ? { kind: "read", id } : { kind: "list", path });
      if (result.kind === "list") {
        setRecords(result.data);
        setSelected(undefined);
      } else if (result.kind === "receipt") {
        setSelected(result.data);
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <PreviewToolbarPortal slot="feedback">
    <details className="border-t border-line pt-2" onToggle={event => {
      if (event.currentTarget.open && records === undefined && !busy) void load();
    }}>
      <summary className="cursor-pointer px-2 py-1">收到的反馈</summary>
      {problem ? <p role="alert" className="px-2 text-danger">{problem}</p> : null}
      {busy ? <p role="status" className="px-2 text-muted">正在读取反馈…</p> : null}
      {selected ? <>
        <button type="button" className={previewTextButton} onClick={() => setSelected(undefined)}>返回列表</button>
        <p className="px-2 text-muted">{selected.source.version === version ? "当前版本" : "来自旧版本"}</p>
        {onAddToChat ? <button type="button" className={previewTextButton} disabled={addedToChat === selected.id}
          onClick={() => { onAddToChat(selected); setAddedToChat(selected.id); }}>
          {addedToChat === selected.id ? "已放入会话待发" : "放入会话待发"}
        </button> : null}
        <textarea readOnly value={feedbackReceiptText(selected)} aria-label="收到的反馈内容"
          className="min-h-40 w-full rounded border border-line bg-bg p-2 text-xs" />
      </> : <>
        {records?.length === 0 ? <p className="px-2 py-1 text-muted">暂无收到的反馈</p> : null}
        {records?.map(record => <button type="button" key={record.id} disabled={busy}
          className="block w-full rounded px-2 py-2 text-left hover:bg-raised" onClick={() => void load(record.id)}>
          <span className="block break-words">{record.description || "批注或运行证据"}</span>
          <span className="block text-muted">{new Date(record.submittedAtMs).toLocaleString()} · {record.version === version ? "当前版本" : "来自旧版本"}</span>
        </button>)}
        <button type="button" className={previewTextButton} disabled={busy} onClick={() => void load()}>刷新反馈</button>
      </>}
    </details>
  </PreviewToolbarPortal>;
}
