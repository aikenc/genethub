import type { BlobRef, ImageThumb } from "@genehub/proto";
import { useState } from "react";

import { useWorkbench } from "./store";
import { useSessionArtifact } from "./useSessionArtifact";

/** One tile in a strip, whatever its source row (batch overview, item image). */
export type StripImage = {
  id: string;
  alt: string;
  thumb?: ImageThumb;
  /** Workspace-relative path of an image the agent read; opens via preview. */
  path?: string;
  /** Blob of an image the agent produced; expands in place via `blob.get`. */
  blob?: BlobRef;
};

/**
 * A horizontal strip of image thumbnails. Read images (workspace files) open
 * through the preview float; produced images expand in place from their blob,
 * falling back to the thumbnail when no ref is at hand (the flat timeline
 * carries no refs — the batch layer does). Every raster renders through
 * `<img>` and never inline markup, which is what keeps a script-bearing SVG
 * inert.
 */
export function ImageThumbStrip({ images }: { images: StripImage[] }) {
  const artifact = useSessionArtifact();
  const openPreviewFloat = useWorkbench((state) => state.openPreviewFloat);
  const loadBlob = useWorkbench((state) => state.loadBlob);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = images.find((image) => image.id === expandedId) ?? null;
  return (
    <div data-testid="image-thumb-strip">
      <div className="flex flex-wrap gap-1.5 py-1">
        {images.map((image) => (
          <ImageThumbTile
            key={image.id}
            image={image}
            selected={expandedId === image.id}
            onOpen={() => {
              if (image.path && artifact?.deviceHandle && artifact.workspaceHandle) {
                openPreviewFloat({
                  deviceHandle: artifact.deviceHandle,
                  workspaceHandle: artifact.workspaceHandle,
                  path: image.path,
                  sessionId: artifact.sessionId ?? null,
                });
                return;
              }
              const next = expandedId === image.id ? null : image.id;
              setExpandedId(next);
              if (next && image.blob) void loadBlob(image.blob);
            }}
          />
        ))}
      </div>
      {expanded ? <ExpandedImage image={expanded} /> : null}
    </div>
  );
}

function ImageThumbTile({
  image,
  selected,
  onOpen,
}: {
  image: StripImage;
  selected: boolean;
  onOpen: () => void;
}) {
  const thumb = image.thumb;
  const ratio = thumb && thumb.height > 0 ? thumb.width / thumb.height : 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={image.alt}
      aria-pressed={selected}
      className={`h-[72px] overflow-hidden rounded-md border bg-bg ${
        selected ? "border-accent" : "border-line"
      }`}
      style={{ width: `${Math.round(Math.min(Math.max(ratio, 0.4), 2.5) * 72)}px` }}
      data-testid="image-thumb"
    >
      {thumb ? (
        <img
          src={`data:${thumb.mime};base64,${thumb.dataBase64}`}
          alt={image.alt}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-1 text-[10px] text-muted">
          图片
        </span>
      )}
    </button>
  );
}

function ExpandedImage({ image }: { image: StripImage }) {
  const payload = useWorkbench((state) =>
    image.blob ? state.timeline.blobs[image.blob.id] : undefined,
  );
  const value = payload?.value;
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { mime?: unknown; dataBase64?: unknown })
      : null;
  const mime = typeof source?.mime === "string" ? source.mime : "";
  const data = typeof source?.dataBase64 === "string" ? source.dataBase64 : "";
  const fallback = image.thumb
    ? { src: `data:${image.thumb.mime};base64,${image.thumb.dataBase64}`, blurred: true }
    : null;
  return (
    <div className="max-h-96 overflow-auto border-t border-line p-2" data-testid="image-expanded">
      {mime.startsWith("image/") && data ? (
        <img
          src={`data:${mime};base64,${data}`}
          alt={image.alt}
          className="max-h-[352px] max-w-full rounded-md"
        />
      ) : fallback ? (
        <img
          src={fallback.src}
          alt={image.alt}
          className="max-h-[352px] max-w-full rounded-md"
        />
      ) : (
        <p className="text-xs text-muted">正在加载…</p>
      )}
    </div>
  );
}
