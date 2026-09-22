import type { Attachment } from "@genehub/proto";

/**
 * Clipboard items expose pasted images as `kind === "file"` with an image MIME type;
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

export const IMAGE_ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const VIDEO_ATTACHMENT_MIMES = ["video/mp4", "video/webm", "video/quicktime", "video/mpeg", "video/x-msvideo"] as const;

/** RPC bodies are capped at 2.9 MB. Inline images expand by roughly one third
 * as Base64 and share that body with text and the rest of the request. */
export const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 2_200_000;
const MAX_INLINE_ATTACHMENT_FILE_BYTES = Math.floor(MAX_INLINE_ATTACHMENT_BASE64_CHARS * 3 / 4);
export const MAX_VIDEO_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export class AttachmentTooLarge extends Error {}

export function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_INLINE_ATTACHMENT_FILE_BYTES) {
    return Promise.reject(new AttachmentTooLarge(`${file.name || "图片"} 过大；图片附件合计需小于约 1.6MB`));
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

export function classifyAttachmentFiles(files: File[], imageAllowed: boolean, videoAllowed: boolean): {
  images: File[];
  videos: File[];
} {
  const images = files.filter((file) => file.type.startsWith("image/"));
  const videos = files.filter((file) => file.type.startsWith("video/"));
  if (images.length + videos.length !== files.length) throw new Error("只支持图片和视频文件");
  if (images.some((file) => !IMAGE_ATTACHMENT_MIMES.includes(file.type as typeof IMAGE_ATTACHMENT_MIMES[number]))) {
    throw new Error("图片仅支持 PNG、JPEG、WebP 或 GIF");
  }
  if (videos.some((file) => !VIDEO_ATTACHMENT_MIMES.includes(file.type as typeof VIDEO_ATTACHMENT_MIMES[number]))) {
    throw new Error("视频格式当前不支持");
  }
  if (images.length > 0 && !imageAllowed) throw new Error("当前模型不支持图片输入");
  if (videos.length > 0 && !videoAllowed) throw new Error("当前模型不支持视频输入");
  if (videos.some((file) => file.size > MAX_VIDEO_ATTACHMENT_BYTES)) throw new Error("视频超过 64MB");
  return { images, videos };
}

export function validateInlineAttachmentBudget(attachments: Attachment[]): void {
  const encoded = attachments.reduce((total, attachment) => total + (attachment.dataBase64?.length ?? 0), 0);
  if (encoded > MAX_INLINE_ATTACHMENT_BASE64_CHARS) {
    throw new AttachmentTooLarge("图片附件合计过大；请选择合计小于约 1.6MB 的图片");
  }
}

export function attachmentPreviewUrl(attachment: Attachment): string | undefined {
  if (!attachment.dataBase64) return undefined;
  return `data:${attachment.mime};base64,${attachment.dataBase64}`;
}
