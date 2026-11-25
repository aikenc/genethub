import { CornerUpLeft } from "lucide-react";
import { previewIconButton } from "./PreviewToolbar";
import { independentPreviewUrl, previewBasePath, type AssetPreviewLocation } from "./url";

const returnParam = "workbenchReturn";
const tabParam = "workbenchPreviewTab";
const tabKey = "genehub:workbench-preview-tab";
const reservedTabs = new WeakSet<Window>();

export function canOpenIndependentPreview(source: AssetPreviewLocation): boolean {
  return location.protocol === "https:"
    && /\.html?$/i.test(source.path)
    && !new URLSearchParams(location.search).has("previewCompatibility")
    && !source.docQuery && !source.docFragment
    && (!source.siteEntryPath || source.siteEntryPath === source.path);
}

export function supportsIndependentPreview(features?: string[]): boolean {
  return !!features?.includes("asset.preview.independent.storage.v1")
    && features.includes("asset.preview.independent.review.v1");
}

// Reserve the tab during the click, before service discovery or an async path retry.
export function reserveIndependentPreviewTab(): Window | null {
  if (navigator.userActivation?.isActive === false) return null;
  let tab: Window | null = null;
  try {
    tab = window.open("about:blank", "_blank");
    if (tab) {
      reservedTabs.add(tab);
      if (tab.document.body) tab.document.body.textContent = "正在打开独立预览…";
    }
    return tab;
  } catch {
    return tab;
  }
}

export function cancelIndependentPreviewTab(tab?: Window | null): void {
  if (tab && reservedTabs.delete(tab)) tab.close();
}

export function openIndependentPreviewTab(tab: Window, source: AssetPreviewLocation): boolean {
  if (tab.closed) return false;
  try {
    const url = new URL(independentPreviewUrl(source));
    const workbench = new URL(location.href);
    workbench.searchParams.delete("preview");
    const id = crypto.randomUUID();
    tab.sessionStorage.setItem(tabKey, id);
    url.searchParams.set("review", "1");
    url.searchParams.set(returnParam, workbench.pathname + workbench.search);
    url.searchParams.set(tabParam, id);
    tab.opener = null;
    tab.location.replace(url.href);
    reservedTabs.delete(tab);
    return true;
  } catch {
    cancelIndependentPreviewTab(tab);
    return false;
  }
}

export function preservePreviewReturn(url: URL): void {
  const current = new URLSearchParams(location.search);
  for (const name of [returnParam, tabParam]) {
    const value = current.get(name);
    if (value) url.searchParams.set(name, value);
  }
}

export function PreviewReturn({ owner }: { owner: boolean }) {
  if (!owner) return null;
  const params = new URLSearchParams(location.search);
  const returnPath = params.get(returnParam);
  if (!returnPath?.startsWith("/") || returnPath.startsWith("//") || returnPath.includes("\\")) return null;
  const back = new URL(returnPath, location.origin);
  if (back.origin !== location.origin || !back.pathname.startsWith(previewBasePath().replace(/\/$/, "") + "/")) return null;
  return <a className={previewIconButton} href={back.href} aria-label="返回对话" title="返回对话"
    onClick={event => {
      const id = params.get(tabParam);
      try {
        if (!id || sessionStorage.getItem(tabKey) !== id) return;
      } catch {
        return;
      }
      event.preventDefault();
      window.close();
    }}><CornerUpLeft size={16} /></a>;
}
