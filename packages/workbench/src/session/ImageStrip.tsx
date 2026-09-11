import type { BlobRef, ImageThumb } from "@genehub/proto";

import { resolveArtifactRef } from "../preview/resolveArtifactRef";
import { useWorkbench } from "./store";
import { useSessionArtifact } from "./useSessionArtifact";

/** One tile in a strip, whatever its source row (batch overview, item image). */
export type StripImage = {
  id: string;
  alt: string;
  thumb?: ImageThumb;
  /** Workspace-relative path; click opens the original through asset.preview. */
  path?: string;
  /** Blob of an image the agent produced; kept for fork, not for Preview. */
  blob?: BlobRef;
};

/**
 * A horizontal strip of image thumbnails. Read images and produced images
 * both open the same Preview float: the path is resolved the way Markdown
 * file links are, then `asset.preview` loads the original. Every raster
 * renders through `<img>` and never inline markup, which is what keeps a
 * script-bearing SVG inert.
 */
export function ImageThumbStrip({
  images,
  size = "process",
}: {
  images: StripImage[];
  /** Process cards stay compact; turn-body galleries use document sizing. */
  size?: "process" | "document";
}) {
  const artifact = useSessionArtifact();
  const openPreviewFloat = useWorkbench((state) => state.openPreviewFloat);
  const previewFloat = useWorkbench((state) => state.previewFloat);

  const openImage = (image: StripImage) => {
    if (!image.path || !artifact) return;
    const resolved = resolveArtifactRef(image.path, artifact);
    if (resolved.kind !== "preview") return;
    openPreviewFloat({
      deviceHandle: artifact.deviceHandle,
      workspaceHandle: artifact.workspaceHandle,
      path: resolved.path,
      sessionId: artifact.sessionId ?? null,
    });
  };

  return (
    <div data-testid="image-thumb-strip">
      <div className="flex flex-wrap gap-1.5 py-1">
        {images.map((image) => {
          const resolved =
            image.path && artifact ? resolveArtifactRef(image.path, artifact) : null;
          const selected =
            resolved?.kind === "preview" && previewFloat?.path === resolved.path;
          return (
            <ImageThumbTile
              key={image.id}
              image={image}
              selected={selected}
              size={size}
              onOpen={() => openImage(image)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ImageThumbTile({
  image,
  selected,
  size,
  onOpen,
}: {
  image: StripImage;
  selected: boolean;
  size: "process" | "document";
  onOpen: () => void;
}) {
  const thumb = image.thumb;
  const ratio = thumb && thumb.height > 0 ? thumb.width / thumb.height : 1;
  if (size === "document") {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={image.alt}
        aria-pressed={selected}
        className={`gh-markdown-image-ref ${selected ? "border-accent" : ""}`}
        data-testid="image-thumb"
        data-size="document"
      >
        {thumb ? (
          <img
            src={`data:${thumb.mime};base64,${thumb.dataBase64}`}
            alt={image.alt}
            className="gh-markdown-image"
          />
        ) : (
          <span className="px-2 py-6 text-xs text-muted">图片</span>
        )}
        {image.alt ? <span className="gh-markdown-image-ref-label">{image.alt}</span> : null}
      </button>
    );
  }
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
