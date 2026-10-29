import { describe, expect, it } from "vitest";

import {
  classifyAttachmentFiles,
  fileToAttachment,
  MAX_FILE_ATTACHMENT_BYTES,
  resolveFileMime,
  stagedFileName,
} from "./attachments";

function file(name: string, type = "", size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("chat attachment classification", () => {
  it("keeps supported images and videos on the media path", () => {
    const plan = classifyAttachmentFiles(
      [file("photo.png", "image/png"), file("clip.mp4", "video/mp4")],
      true,
      true,
    );
    expect(plan.images.map((item) => item.name)).toEqual(["photo.png"]);
    expect(plan.videos.map((item) => item.name)).toEqual(["clip.mp4"]);
    expect(plan.files).toEqual([]);
  });

  it("stores every other file, including unsupported media formats", () => {
    const plan = classifyAttachmentFiles(
      [
        file("report.pdf", "application/pdf"),
        file("archive.zip", ""),
        file("scan.tiff", "image/tiff"),
        file("clip.mkv", "video/x-matroska"),
      ],
      false,
      false,
    );
    expect(plan.images).toEqual([]);
    expect(plan.videos).toEqual([]);
    expect(plan.files.map((item) => item.name)).toEqual([
      "report.pdf",
      "archive.zip",
      "scan.tiff",
      "clip.mkv",
    ]);
  });

  it("infers a MIME when the browser leaves File.type empty", () => {
    expect(resolveFileMime(file("notes.txt"))).toBe("text/plain");
    expect(resolveFileMime(file("data.json"))).toBe("application/json");
    expect(resolveFileMime(file("unknown.bin"))).toBe("application/octet-stream");
  });

  it("rejects an oversized stored file before upload", () => {
    expect(() =>
      classifyAttachmentFiles([file("huge.pdf", "application/pdf", MAX_FILE_ATTACHMENT_BYTES + 1)], false, false),
    ).toThrow(/64MB/);
  });

  it("preserves a safe extension and stays flat", () => {
    expect(stagedFileName(0, "年报 final.PDF", "application/pdf")).toBe("file-001.pdf");
    expect(stagedFileName(1, "no-extension", "application/octet-stream")).toBe("file-002.bin");
    expect(stagedFileName(2, "weird.<script>", "application/octet-stream")).toBe("file-003.bin");
  });

  it("records the original size on an inline image attachment", async () => {
    const attachment = await fileToAttachment(file("pixel.png", "image/png", 8));
    expect(attachment.mime).toBe("image/png");
    expect(attachment.bytes).toBe(8);
    expect(attachment.dataBase64).toBeTruthy();
  });
});
