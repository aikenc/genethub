import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import type { PreviewFeedbackRecord } from "@genehub/proto";
import { feedbackReceiptText, type useFileFeedback } from "./fileFeedback";
import { PreviewToolbarPortal } from "./PreviewToolbar";
export function PreviewFeedbackPanel({ feedback, bindOpen, showToolbarButton = false }: {
    feedback: ReturnType<typeof useFileFeedback>;
    bindOpen?: (open: (() => void) | null) => void;
    /** Files that cannot be annotated keep a toolbar button. Annotatable files open this from the 批注 menu. */
    showToolbarButton?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [description, setDescription] = useState("");
    const [notes, setNotes] = useState<string[]>([]);
    const [bundles, setBundles] = useState<string[]>([]);
    const [receipt, setReceipt] = useState<PreviewFeedbackRecord | null>(null);
    const [copied, setCopied] = useState(false);
    const show = useCallback(async () => { setOpen(true); setCopied(false); setBusy(true); setProblem(""); try {
        const draft = await feedback.ensure();
        setReceipt(draft.receipt);
        setNotes(draft.review.annotations.map(n => n.id));
        setBundles(draft.bundles.map(b => b.workspacePath));
    }
    catch (e) {
        setProblem(String(e));
    }
    finally {
        setBusy(false);
    } }, [feedback]);
    const showRef = useRef(show);
    showRef.current = show;
    useEffect(() => {
        if (!bindOpen) return;
        bindOpen(() => { void showRef.current(); });
        return () => bindOpen(null);
    }, [bindOpen]);
    const submit = async () => { setBusy(true); setProblem(""); try {
        const d = await feedback.ensure();
        const result = await feedback.operation({ kind: "submit", id: d.id, description, annotationIds: notes, bundlePaths: bundles });
        if (result.kind !== "receipt")
            throw new Error("设备未确认反馈提交");
        setReceipt(result.data);
    }
    catch (e) {
        setProblem(String(e));
    }
    finally {
        setBusy(false);
    } };
    const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(v => v !== id) : [...values, id];
    return <>{showToolbarButton ? <PreviewToolbarPortal><button type="button" aria-label="预览反馈" title="预览反馈" className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg" onClick={() => void show()}><MessageSquareText size={14} /></button></PreviewToolbarPortal> : null}
    {open ? <div role="dialog" aria-modal="true" aria-label="预览反馈" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-3">
      <section className="flex max-h-[85dvh] w-full max-w-xl flex-col rounded-xl border border-line bg-surface p-4 text-sm text-fg">
        <header className="mb-3 flex items-center justify-between"><h2>预览反馈</h2><button aria-label="关闭反馈" onClick={() => setOpen(false)}>关闭</button></header>
        <div className="min-h-0 overflow-y-auto">
          {receipt ? <><p role="status">反馈已提交：{receipt.id}</p><textarea aria-label="可复制的预览反馈" readOnly value={feedbackReceiptText(receipt)} className="mt-3 h-56 w-full rounded border border-line bg-bg p-2 text-xs"/></> : <>
            <p className="mb-2 text-xs text-muted">{feedback.draft?.source.displayPath}</p>
            <textarea aria-label="反馈说明" placeholder="描述体验或问题" value={description} maxLength={5000} onChange={e => setDescription(e.target.value)} className="h-24 w-full rounded border border-line bg-bg p-2"/>
            {feedback.draft?.review.annotations.map(note => <label key={note.id} className="mt-2 flex items-start gap-2"><input type="checkbox" checked={notes.includes(note.id)} onChange={() => setNotes(toggle(notes, note.id))}/><span className="break-words">{note.comment}</span></label>)}
            {feedback.draft?.bundles.map(bundle => <label key={bundle.workspacePath} className="mt-2 flex items-start gap-2"><input type="checkbox" checked={bundles.includes(bundle.workspacePath)} onChange={() => setBundles(toggle(bundles, bundle.workspacePath))}/><span>运行日志及附件（{bundle.files.length} 个文件）</span></label>)}
          </>}
          {problem ? <p role="alert" className="mt-2 text-danger">{problem}</p> : null}
        </div>
        <footer className="mt-3 flex justify-end gap-2">{problem && !receipt ? <button onClick={() => { feedback.reset(); setOpen(false); }}>新的反馈</button> : null}{receipt ? <>
          <button className="rounded border border-line px-3 py-2" onClick={() => { feedback.reset(); setReceipt(null); setDescription(""); setOpen(false); }}>新的反馈</button>
          <button className="rounded bg-accent px-3 py-2 text-white" onClick={() => { void navigator.clipboard?.writeText(feedbackReceiptText(receipt)).then(() => setCopied(true)).catch(() => setProblem("复制失败，请选择上面的文本手动复制")); if (!navigator.clipboard)
                setProblem("请选择上面的文本手动复制"); }}>{copied ? "已复制" : "复制编号和内容"}</button>
        </> : <button disabled={busy} className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50" onClick={() => void submit()}>{busy ? "正在保存…" : "提交反馈"}</button>}</footer>
      </section></div> : null}
  </>;
}
