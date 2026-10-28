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
/** A stored chat file must also be openable in Asset Preview (64 MiB cap). */
export const MAX_FILE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_ATTACHMENTS_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 16;

export class AttachmentTooLarge extends Error {}

const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  avi: "video/x-msvideo",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  sql: "application/sql",
  py: "text/x-python",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  sh: "application/x-sh",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/x-ndjson": "jsonl",
  "application/yaml": "yaml",
  "application/toml": "toml",
  "application/xml": "xml",
  "application/sql": "sql",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function isSupportedImageMime(mime: string): boolean {
  return (IMAGE_ATTACHMENT_MIMES as readonly string[]).includes(mime.toLowerCase());
}

export function isSupportedVideoMime(mime: string): boolean {
  return (VIDEO_ATTACHMENT_MIMES as readonly string[]).includes(mime.toLowerCase());
}

export function isSupportedMediaMime(mime: string): boolean {
  return isSupportedImageMime(mime) || isSupportedVideoMime(mime);
}

/** Declared MIME when it has the `type/subtype` shape; otherwise a small
 * extension map, then `application/octet-stream`. Browsers leave `File.type`
 * empty for many extensions, so classification must not trust it alone. */
export function resolveFileMime(file: File): string {
  const declared = (file.type ?? "").trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(declared)) return declared;
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  return EXTENSION_MIMES[extension] ?? "application/octet-stream";
}

export function fileToAttachment(file: File): Promise<Attachment> {
  const mime = resolveFileMime(file);
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
        mime,
        dataBase64: comma === -1 ? result : result.slice(comma + 1),
        bytes: file.size,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function classifyAttachmentFiles(files: File[], imageAllowed: boolean, videoAllowed: boolean): {
  images: File[];
  videos: File[];
  files: File[];
} {
  const images: File[] = [];
  const videos: File[] = [];
  const stored: File[] = [];
  for (const file of files) {
    const mime = resolveFileMime(file);
    if (isSupportedImageMime(mime)) images.push(file);
    else if (isSupportedVideoMime(mime)) videos.push(file);
    else stored.push(file);
  }
  if (images.length > 0 && !imageAllowed) throw new Error("当前模型不支持图片输入");
  if (videos.length > 0 && !videoAllowed) throw new Error("当前模型不支持视频输入");
  if (videos.some((file) => file.size > MAX_VIDEO_ATTACHMENT_BYTES)) throw new Error("视频超过 64MB");
  if (stored.some((file) => file.size > MAX_FILE_ATTACHMENT_BYTES)) throw new Error("单个文件超过 64MB");
  const storedBytes = stored.reduce((total, file) => total + file.size, 0);
  if (storedBytes > MAX_FILE_ATTACHMENTS_TOTAL_BYTES) throw new Error("文件附件合计超过 256MB");
  return { images, videos, files: stored };
}

/** A store-safe, flat name. The original name stays in `Attachment.name` and
 * the upload metadata; the Agent opens this deterministic path. */
export function stagedFileName(index: number, originalName: string, mime: string): string {
  const match = /\.([A-Za-z0-9]{1,16})$/.exec(originalName);
  const extension = (match?.[1] ?? MIME_EXTENSIONS[mime] ?? "bin").toLowerCase();
  return `file-${String(index + 1).padStart(3, "0")}.${extension}`;
}

export function attachmentSizeLabel(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
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
