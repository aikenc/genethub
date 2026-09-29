import { beforeEach, expect, it } from "vitest";
import { saveInputReceipt, savedInputReceipts } from "./localConversation";

beforeEach(() => localStorage.clear());
it("keeps every offline receipt in admission order and keeps targets separate", () => {
  for (let index = 40; index >= 0; index--) {
    expect(saveInputReceipt("machine-a", "session-a", {
      messageId: `m-${index}`, text: String(index), attachments: [], sentAtMs: index, error: null, autoRetry: true,
    })).toBe(true);
  }
  expect(savedInputReceipts("machine-a", "session-a").map(item => item.text)).toEqual(Array.from({ length: 41 }, (_, i) => String(i)));
  expect(savedInputReceipts("machine-b", "session-a")).toEqual([]);
  expect(savedInputReceipts("machine-a", "session-b")).toEqual([]);
});
it("does not serialize File shells and exposes attachments missing after reload", () => {
  saveInputReceipt("m", "s", { messageId: "input", text: "video", attachments: [],
    videoFiles: [new File(["bytes"], "clip.mp4", { type: "video/mp4" })], sentAtMs: 1, error: null, autoRetry: true });
  const [restored] = savedInputReceipts("m", "s");
  expect(restored?.missingAttachments).toBe(1);
  expect(restored?.videoFiles).toBeUndefined();
});
