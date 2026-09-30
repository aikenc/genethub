import { useState } from "react";
import { Share2, ExternalLink } from "lucide-react";
import type { Client, ProtocolDial } from "../protocol/client";
import type { PreviewShareLink } from "@genehub/proto";
import { previewFeedback } from "./fileFeedback";
import { assetPreviewUrl, type AssetPreviewLocation } from "./url";
export type PreviewShareCredential = {
    token: string;
    redeemUrl: string;
};
export function parsePreviewShare(hash: string): PreviewShareCredential | null {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const token = params.get("genehubPreviewShare");
    const redeemUrl = params.get("genehubPreviewRedeem");
    if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || !redeemUrl)
        return null;
    try {
        const url = new URL(redeemUrl);
        if (url.origin !== window.location.origin || !url.pathname.endsWith("/api/preview-shares/redeem") || url.search || url.hash)
            return null;
        return { token, redeemUrl: url.toString() };
    }
    catch {
        return null;
    }
}
export async function redeemPreviewShare(share: PreviewShareCredential, signal?: AbortSignal): Promise<ProtocolDial> {
    const response = await fetch(share.redeemUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: share.token }), credentials: "omit", cache: "no-store", signal });
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.error || "分享链接暂时不可用");
    if (typeof result.url !== "string" || typeof result.fabricRouteTicket !== "string" || typeof result.channelCapability !== "string" || typeof result.channelSecret !== "string")
        throw new Error("分享连接凭据不完整");
    return { url: result.url, fabricRouteTicket: result.fabricRouteTicket, fabricAuthorizationExpiresAt: result.fabricAuthorizationExpiresAt, channelCredential: { capabilityId: result.channelCapability, secret: result.channelSecret } };
}
export function previewShareUrl(source: AssetPreviewLocation, link: PreviewShareLink): string {
    const redeem = new URL(link.redeemUrl);
    const base = redeem.pathname.slice(0, -"api/preview-shares/redeem".length);
    const url = new URL(assetPreviewUrl(source.deviceHandle, source.workspaceHandle, source.path, redeem.origin, base));
    url.hash = new URLSearchParams({ genehubPreviewShare: link.token, genehubPreviewRedeem: link.redeemUrl }).toString();
    return url.toString();
}
export async function mintPreviewShare(client: Client, source: AssetPreviewLocation, ttlSeconds: number, resources: Iterable<string> = []): Promise<{
    url: string;
    link: PreviewShareLink;
}> {
    const result = await previewFeedback(client, source.workspaceHandle, { kind: "share", path: source.path, ttlSeconds, resources: Array.from(resources) });
    if (result.kind !== "share")
        throw new Error("设备未确认分享授权");
    return { url: previewShareUrl(source, result.data), link: result.data };
}
export function PreviewShareButton({ client, source, defaultTtl = 3600, label = "分享预览", quick = false, resources }: {
    client: Client;
    source: AssetPreviewLocation;
    defaultTtl?: number;
    label?: string;
    quick?: boolean;
    resources?: Iterable<string>;
}) {
    const [open, setOpen] = useState(false);
    const [ttl, setTtl] = useState(defaultTtl);
    const [busy, setBusy] = useState(false);
    const [value, setValue] = useState<{
        url: string;
        link: PreviewShareLink;
    } | null>(null);
    const [problem, setProblem] = useState("");
    const [copied, setCopied] = useState(false);
    const generate = async (seconds: number) => { setBusy(true); setProblem(""); setCopied(false); try {
        setValue(await mintPreviewShare(client, source, seconds, resources));
    }
    catch (e) {
        setProblem(String(e));
    }
    finally {
        setBusy(false);
    } };
    return <><button type="button" aria-label={label} title={label} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg" onClick={() => { setOpen(true); if (quick)
        void generate(3600); }}>{quick ? <ExternalLink size={14} /> : <Share2 size={14} />}</button>
    {open ? <div role="dialog" aria-modal="true" aria-label="分享预览链接" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }} className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-3"><section className="w-full max-w-lg rounded-xl border border-line bg-surface p-4 text-sm text-fg">
      <header className="mb-3 flex items-center justify-between"><h2>{quick ? "在浏览器打开预览" : "分享预览"}</h2><button aria-label="关闭分享" onClick={() => setOpen(false)}>关闭</button></header>
      {!quick ? <label>授权时间 <select aria-label="分享授权时间" value={ttl} onChange={e => { setTtl(Number(e.target.value)); setValue(null); setCopied(false); }} className="rounded border border-line bg-bg p-1"><option value={3600}>1h</option><option value={86400}>1d</option><option value={604800}>7d</option></select></label> : <p>链接授权时间：1h</p>}
      {value ? <><p className="mt-2 text-xs">有效至 {new Date(value.link.expiresAtMs).toLocaleString()}</p><textarea aria-label="预览分享链接" readOnly value={value.url} className="mt-2 h-24 w-full rounded border border-line bg-bg p-2 text-xs"/><p className="mt-2 text-xs text-muted">访问者可以添加批注和提交运行日志，提交后复制反馈传回。</p></> : null}
      {problem ? <p role="alert" className="mt-2 text-danger">{problem}</p> : null}
      <footer className="mt-3 flex justify-end gap-2">{value ? <><button className="rounded border border-line px-3 py-2" onClick={() => { void previewFeedback(client, source.workspaceHandle, { kind: "revoke", shareId: value.link.shareId }).then(() => { setValue(null); setProblem("分享已撤销"); }).catch(e => setProblem(String(e))); }}>撤销分享</button><button className="rounded bg-accent px-3 py-2 text-white" onClick={() => { if (!navigator.clipboard) {
            setProblem("请选择上面的链接手动复制");
            return;
        } void navigator.clipboard.writeText(value.url).then(() => setCopied(true)).catch(() => setProblem("复制失败，请选择上面的链接手动复制")); }}>{copied ? "已复制" : "复制链接"}</button></> : <button disabled={busy} className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50" onClick={() => void generate(quick ? 3600 : ttl)}>{busy ? "正在生成…" : "生成链接"}</button>}</footer>
    </section></div> : null}
  </>;
}
export function PreviewShareCopyButton() {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    return <><button aria-label="分享预览" className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg" onClick={() => setOpen(true)} title="分享预览"><Share2 size={14} /></button>
    {open ? <div role="dialog" aria-modal="true" aria-label="分享预览" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }} className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-3"><section className="w-full max-w-lg rounded-xl border border-line bg-surface p-4 text-sm text-fg">
      <p>转发当前分享链接，沿用原授权期限。</p><textarea aria-label="预览分享链接" readOnly value={window.location.href} className="my-3 h-24 w-full border border-line bg-bg p-2"/>
      <button onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true)).catch(() => { }); }}>{copied ? "已复制" : "复制链接"}</button><button className="ml-4" onClick={() => setOpen(false)}>关闭</button>
    </section></div> : null}</>;
}
