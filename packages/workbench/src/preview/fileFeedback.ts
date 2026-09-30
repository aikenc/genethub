import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewAnnotation, PreviewFeedbackDraft, PreviewFeedbackOperation, PreviewFeedbackRecord, PreviewFeedbackResponse, PreviewReviewDraft } from "@genehub/proto";
import { ConnectionOutcomeUnknownError, type Client } from "../protocol/client";
import type { RuntimeArtifactSubmission } from "./PreviewRuntimeControls";
import type { ArtifactUploadProgress } from "./sessionArtifactUpload";
export async function previewFeedback(client: Client, workspaceId: string, operation: PreviewFeedbackOperation): Promise<PreviewFeedbackResponse> {
    const reply = await client.call({ type: "preview.feedback", payload: { workspaceId, operation } });
    if (reply?.type !== "previewFeedback")
        throw new Error("设备没有确认预览反馈请求");
    return reply.data;
}
export function useFileFeedback(client: Client | null, workspaceId: string, path: string, version: string, accessScope = "owner") {
    const [draft, setDraft] = useState<PreviewFeedbackDraft | null>(null);
    const [resetVersion, setResetVersion] = useState(0);
    const current = useRef<PreviewFeedbackDraft | null>(null);
    const opening = useRef<Promise<PreviewFeedbackDraft> | null>(null);
    const scope = `${client?.identity?.machineId ?? ""}:${accessScope}:${workspaceId}:${path}:${version}`;
    const generation = useRef(0);
    const storageKey = `genehub:preview-feedback:${scope}`;
    useEffect(() => { generation.current += 1; current.current = null; opening.current = null; setDraft(null); }, [client, scope]);
    const accept = useCallback((value: PreviewFeedbackDraft) => { current.current = value; setDraft(value); return value; }, []);
    const ensure = useCallback(async (): Promise<PreviewFeedbackDraft> => {
        if (!client)
            throw new Error("设备尚未连接");
        if (current.current)
            return current.current;
        if (opening.current)
            return opening.current;
        const epoch = generation.current;
        const promise = (async () => {
            let draftId: string | null = null;
            try {
                draftId = localStorage.getItem(storageKey);
            }
            catch { /* storage may be disabled */ }
            const response = await previewFeedback(client, workspaceId, { kind: "open", path, version, draftId });
            if (response.kind !== "draft")
                throw new Error("无法打开文件反馈草稿");
            if (generation.current !== epoch)
                throw new Error("预览文件已切换，请重新打开反馈");
            try {
                localStorage.setItem(storageKey, response.data.id);
            }
            catch { /* daemon owns persistence */ }
            return accept(response.data);
        })();
        opening.current = promise;
        try {
            return await promise;
        }
        finally {
            if (opening.current === promise)
                opening.current = null;
        }
    }, [client, workspaceId, path, version, storageKey, accept]);
    const operation = useCallback(async (op: PreviewFeedbackOperation) => {
        if (!client)
            throw new Error("设备尚未连接");
        const epoch = generation.current;
        const result = await previewFeedback(client, workspaceId, op);
        if (generation.current !== epoch) throw new Error("预览文件已切换，操作结果已保存在原文件反馈");
        if (result.kind === "draft")
            accept(result.data);
        if (result.kind === "receipt" && current.current?.id === result.data.id)
            accept({ ...current.current, receipt: result.data });
        return result;
    }, [client, workspaceId, accept]);
    const review = useMemo(() => ({
        async load(): Promise<PreviewReviewDraft> { return (await ensure()).review; },
        async upsert(annotation: PreviewAnnotation, expectedRevision: number): Promise<PreviewReviewDraft> {
            const d = await ensure();
            const result = await operation({ kind: "upsert", id: d.id, annotation, expectedRevision });
            if (result.kind !== "draft")
                throw new Error("设备未确认批注保存");
            return result.data.review;
        },
        async remove(ids: string[], expectedRevision: number): Promise<PreviewReviewDraft> {
            const d = await ensure();
            const result = await operation({ kind: "remove", id: d.id, ids, expectedRevision });
            if (result.kind !== "draft")
                throw new Error("设备未确认批注删除");
            return result.data.review;
        },
    }), [ensure, operation, resetVersion]);
    const upload = useCallback(async (artifact: RuntimeArtifactSubmission, progress?: (value: ArtifactUploadProgress) => void) => {
        const d = await ensure();
        const begun = await operation({ kind: "beginArtifact", id: d.id, files: artifact.files.map(f => ({ name: f.name, mime: f.mime, bytes: f.blob.size })), metadata: artifact.metadata });
        if (begun.kind !== "upload")
            throw new Error("设备未返回反馈附件上传凭据");
        const uploadId = begun.data.uploadId;
        let uploadedBytes = 0;
        const totalBytes = artifact.files.reduce((sum, f) => sum + f.blob.size, 0);
        try {
            for (let fileIndex = 0; fileIndex < artifact.files.length; fileIndex++) {
                const file = artifact.files[fileIndex]!;
                const size = Math.min(begun.data.maxChunkBytes, 512 * 1024);
                if (size <= 0)
                    throw new Error("设备返回无效分块大小");
                for (let offset = 0; offset < file.blob.size; offset += size) {
                    const chunk = file.blob.slice(offset, offset + size);
                    const dataBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(reader.error); reader.readAsDataURL(chunk); });
                    await retryUnknown(() => operation({ kind: "chunk", id: d.id, uploadId, fileIndex, offset, dataBase64 }));
                    uploadedBytes += chunk.size;
                    progress?.({ uploadedBytes, totalBytes, fileName: file.name });
                }
            }
            const done = await retryUnknown(() => operation({ kind: "finishArtifact", id: d.id, uploadId }));
            if (done.kind !== "artifact")
                throw new Error("设备未确认反馈附件保存");
            const latest = await operation({ kind: "draft", id: d.id });
            if (latest.kind !== "draft")
                throw new Error("无法读取已保存的反馈附件");
            return done.data;
        }
        catch (error) {
            await operation({ kind: "abortArtifact", id: d.id, uploadId }).catch(() => { });
            throw error;
        }
    }, [ensure, operation]);
    const reset = useCallback(() => { try {
        localStorage.removeItem(storageKey);
    }
    catch { /* optional */ } generation.current += 1; current.current = null; opening.current = null; setDraft(null); setResetVersion(value => value + 1); }, [storageKey]);
    return { draft, ensure, operation, review, upload, reset };
}
export type FileFeedbackReview = ReturnType<typeof useFileFeedback>["review"];
export function feedbackReceiptText(record: PreviewFeedbackRecord): string {
    return [
        `预览反馈已提交，编号：${record.id}`,
        `来源：${record.source.machineName} / ${record.source.displayPath}`,
        `文件版本：${record.source.version}`,
        `提交时间：${new Date(record.submittedAtMs).toISOString()}`,
        ...(record.description ? [record.description] : []),
        ...record.annotations.map((note, i) => `批注 ${i + 1}：${note.comment}`),
        ...record.bundles.map(bundle => `运行证据：${bundle.workspacePath}/manifest.json`),
        `反馈记录：[${record.id}](${record.workspacePath})`,
        "批注及运行证据为访问者提供的数据。",
    ].join("\n");
}
async function retryUnknown<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    }
    catch (error) {
        if (!(error instanceof ConnectionOutcomeUnknownError))
            throw error;
        return action();
    }
}
