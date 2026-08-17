import { describe, expect, it } from "vitest";

import { CHANNEL, PRODUCT } from "./channel";
import { appDownloadPage } from "./updates/links";

describe("hosted Web channel identity", () => {
  it("uses an explicit hosted channel without mutating the Open checkout", () => {
    const hosted = import.meta.env.VITE_GENEHUB_CHANNEL;
    if (!hosted) return;
    expect(CHANNEL).toBe(hosted);
    expect(PRODUCT).toBe(import.meta.env.VITE_GENEHUB_BRAND);
  });

  it("derives the human download page from the Platform-stamped App feed", () => {
    expect(
      appDownloadPage([
        "https://relay-beta.genethub.com/artifacts/manifests/app/latest-beta.json",
      ]),
    ).toBe("https://relay-beta.genethub.com/download");
  });
});
