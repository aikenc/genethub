import type { BlobOverview, RoundBatch, RoundBatchSummary, RoundTrunk } from "@genehub/proto";

/** Session-directory originals. Workspace reads stay with the tool batch. */
export function isProducedImagePath(path: string | undefined | null): boolean {
  if (!path) return false;
  const normalized = path.replace(/^\/+/, "");
  return normalized.includes(".genethub/sessions/") && normalized.includes("/images/");
}

export function isProducedImage(row: BlobOverview): boolean {
  if (row.kind !== "image") return false;
  return row.path ? isProducedImagePath(row.path) : Boolean(row.thumb);
}

export function isImageOnlyBatch(batch: RoundBatch): boolean {
  return (
    !batch.summary.marker &&
    batch.blobs.length > 0 &&
    batch.blobs.every((row) => row.kind === "image") &&
    batch.blobs.some(isProducedImage)
  );
}

export function isFinalSummaryBatch(
  batch: RoundBatchSummary,
  finalSummaryText: string,
): boolean {
  if (batch.blobCount !== 0) return false;
  const compact = batch.text.trim();
  if (!compact) return false;
  const prefix = compact.endsWith("…") ? compact.slice(0, -1) : compact;
  return finalSummaryText.trimStart().startsWith(prefix);
}

function isVisibleProcessBatch(batch: RoundBatch, finalSummaryText?: string): boolean {
  if (batch.summary.marker) return false;
  if (finalSummaryText && isFinalSummaryBatch(batch.summary, finalSummaryText)) return false;
  return true;
}

/** Last visible process batch's produced images, when the round has settled. */
export function finalGalleryFromTrunks(
  trunks: readonly RoundTrunk[],
  outcome: string,
  finalSummaryText?: string,
): BlobOverview[] {
  if (outcome === "running") return [];
  const visible = trunks.flatMap((trunk) =>
    trunk.batches.filter((batch) => isVisibleProcessBatch(batch, finalSummaryText)),
  );
  const last = visible.at(-1);
  if (!last) return [];
  return last.blobs.filter(isProducedImage);
}

export function hoistedImageIds(gallery: readonly BlobOverview[]): Set<string> {
  return new Set(gallery.map((row) => row.itemId));
}

export function markdownLinkedImagePaths(text: string): string[] {
  const paths: string[] = [];
  const embed = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const link = /(?<!!)\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))(?:\s+"[^"]*")?\)/gi;
  for (const match of text.matchAll(embed)) {
    if (match[1]) paths.push(match[1]);
  }
  for (const match of text.matchAll(link)) {
    if (match[1]) paths.push(match[1]);
  }
  return paths;
}

export function sameImagePath(left: string, right: string): boolean {
  const normalize = (path: string) => path.replace(/^\/+/, "").replace(/\\/g, "/");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Session-inlined 128px thumb used for tiles, copy, and forward. */
export type InlineImage = {
  path: string;
  mime: string;
  dataBase64: string;
};

const SAFE_INLINE_IMAGE =
  /^data:image\/(?:jpeg|jpg|png|gif|webp);base64,[a-z0-9+/]+=*$/i;

export function isSafeInlineImageDataUrl(value: string): boolean {
  return SAFE_INLINE_IMAGE.test(value.trim());
}

export function thumbDataUrl(image: Pick<InlineImage, "mime" | "dataBase64">): string {
  return `data:${image.mime};base64,${image.dataBase64}`;
}

export function inlineImagesFromTrunks(trunks: readonly RoundTrunk[]): InlineImage[] {
  const out: InlineImage[] = [];
  const seen = new Set<string>();
  for (const trunk of trunks) {
    for (const batch of trunk.batches) {
      for (const row of batch.blobs) {
        if (row.kind !== "image" || !row.thumb || !row.path) continue;
        if (seen.has(row.path)) continue;
        seen.add(row.path);
        out.push({
          path: row.path,
          mime: row.thumb.mime,
          dataBase64: row.thumb.dataBase64,
        });
      }
    }
  }
  return out;
}

export function thumbForPath(
  images: readonly InlineImage[],
  path: string | undefined | null,
): InlineImage | undefined {
  if (!path) return undefined;
  return images.find((image) => sameImagePath(image.path, path));
}

export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function fileStem(path: string): string {
  const name = fileName(path);
  return name.replace(/\.[^.]+$/, "") || name;
}

export function attachmentsFromInlineImages(
  images: readonly InlineImage[],
): Array<{ name: string; mime: string; dataBase64: string }> {
  return images.map((image, index) => ({
    name: fileName(image.path) || `image-${index + 1}.jpg`,
    mime: image.mime,
    dataBase64: image.dataBase64,
  }));
}

/** Rewrite workspace image hrefs to inlined thumbs so copy/forward carry pixels. */
export function rewriteLinkedImagesToThumbs(
  text: string,
  images: readonly InlineImage[],
): string {
  if (!text || images.length === 0) return text;
  return text.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, _bang: string, alt: string, href: string) => {
      if (href.toLowerCase().startsWith("data:")) return full;
      const thumb = thumbForPath(images, href);
      if (!thumb) return full;
      return `![${alt || fileStem(thumb.path)}](${thumbDataUrl(thumb)})`;
    },
  );
}

export function appendUnlinkedThumbs(
  text: string,
  images: readonly InlineImage[],
): string {
  if (images.length === 0) return text;
  const rewritten = rewriteLinkedImagesToThumbs(text, images);
  const linked = markdownLinkedImagePaths(text);
  const extras = images.filter(
    (image) => !linked.some((path) => sameImagePath(path, image.path)),
  );
  if (extras.length === 0) return rewritten;
  const lines = extras.map((image) => `![${fileStem(image.path)}](${thumbDataUrl(image)})`);
  return rewritten ? `${rewritten}\n${lines.join("\n")}` : lines.join("\n");
}

export function galleryNotInMarkdown(
  gallery: readonly BlobOverview[],
  markdown: string | undefined,
): BlobOverview[] {
  if (!markdown) return [...gallery];
  const linked = markdownLinkedImagePaths(markdown);
  // Workspace copies in the assistant text already paint as inline
  // pictures. Do not add a second strip of the session originals.
  if (linked.length > 0) return [];
  return [...gallery];
}

export function withoutHoistedImages(batch: RoundBatch, hoisted: ReadonlySet<string>): RoundBatch {
  if (hoisted.size === 0) return batch;
  return {
    ...batch,
    blobs: batch.blobs.filter((row) => !hoisted.has(row.itemId)),
  };
}

export function visibleProcessBatches(
  batches: readonly RoundBatch[],
  finalSummaryText: string | undefined,
  hoisted: ReadonlySet<string>,
): RoundBatch[] {
  return batches
    .filter((batch) => {
      if (batch.summary.marker) return true;
      if (finalSummaryText && isFinalSummaryBatch(batch.summary, finalSummaryText)) return false;
      return true;
    })
    .map((batch) => withoutHoistedImages(batch, hoisted))
    .filter((batch) => {
      if (batch.summary.marker) return true;
      if (batch.blobs.length > 0) return true;
      return Boolean(batch.monologue?.trim());
    });
}
