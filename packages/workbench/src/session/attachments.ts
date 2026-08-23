import type { Attachment } from "@genehub/proto";

/**
 * Pasting a screenshot into the composer is the core way images enter a
 * conversation here — there is no separate file picker (yet). Clipboard
 * items expose pasted images as `kind === "file"` with an image MIME type;
 * everything else (plain text, HTML) is left for the browser's default paste
 * to handle untouched.
 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Above this, a paste is more likely a large screenshot mistake than a
 * useful reference image — the daemon inlines attachment bytes straight into
 * the session log (see `Attachment::data_base64`'s doc comment), so this
 * also keeps that log from ballooning. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export class AttachmentTooLarge extends Error {}

export function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(new AttachmentTooLarge(`${file.name || "图片"} 超过 8MB`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // `data:<mime>;base64,<payload>` — only the part after the comma is
      // the payload the daemon expects in `dataBase64`.
      const comma = result.indexOf(",");
      resolve({
        name: file.name || "pasted-image.png",
        mime: file.type,
        dataBase64: comma === -1 ? result : result.slice(comma + 1),
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function attachmentPreviewUrl(attachment: Attachment): string | undefined {
  if (!attachment.dataBase64) return undefined;
  return `data:${attachment.mime};base64,${attachment.dataBase64}`;
}
