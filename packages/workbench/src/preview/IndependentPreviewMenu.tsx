import { useCallback, useEffect, useRef, useState } from "react";

import type { Client } from "../protocol/client";
import { createPreviewPopoutUrl, registerPreviewPopoutClient } from "./popout";
import { PreviewShareButton } from "./PreviewShareButton";
import { PreviewToolbarPortal } from "./PreviewToolbar";
import { independentPreviewUrl, type AssetPreviewLocation } from "./url";

export function IndependentPreviewMenu({ client, source, resources, canShare }: {
  client: Client;
  source: AssetPreviewLocation;
  resources: Iterable<string>;
  canShare: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [openShare, setOpenShare] = useState<(() => void) | null>(null);
  const bindShare = useCallback((open: (() => void) | null) => setOpenShare(() => open), []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const url = independentPreviewUrl(source);
  const item = "rounded px-2 py-1 text-left text-fg hover:bg-raised";
  return (
    <>
      <PreviewToolbarPortal>
        <details ref={menu} className="relative text-xs text-muted" onKeyDown={event => {
          if (event.key === "Escape" && event.currentTarget.open) {
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}>
          <summary className="flex h-7 cursor-pointer list-none items-center rounded-md border border-line bg-surface px-2 text-fg hover:bg-raised [&::-webkit-details-marker]:hidden">
            独立预览
          </summary>
          <div className="absolute right-0 top-full z-50 mt-1 flex w-40 flex-col rounded-lg border border-line bg-surface p-2 shadow-lg">
            <a className={item} href={url} target="_blank" rel="noopener" onClick={event => {
              if (menu.current) menu.current.open = false;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || client.connectionState !== "ready") return;
              const popout = createPreviewPopoutUrl(url, null);
              const release = registerPreviewPopoutClient({ id: popout.id, sessionId: null }, source, client);
              // The trusted same-origin launcher consumes the bridge and
              // severs opener before the site loads.
              if (window.open(popout.url, `genehub-preview-${popout.id}`)) {
                event.preventDefault();
                window.setTimeout(release, 60_000);
              } else {
                release();
              }
            }}>用已有权限打开</a>
            <button type="button" className={item} disabled={!canShare || !openShare} onClick={() => {
              if (menu.current) menu.current.open = false;
              openShare?.();
            }}>创建限时分享</button>
          </div>
        </details>
      </PreviewToolbarPortal>
      <PreviewShareButton client={client} source={source} resources={resources} trigger={false} bindOpen={bindShare} independent />
    </>
  );
}
