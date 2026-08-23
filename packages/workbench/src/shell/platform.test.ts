import { describe, expect, it } from "vitest";

import { isIosStandalonePwa } from "./platform";

const iphone = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  platform: "iPhone",
  maxTouchPoints: 5,
};
const ipados = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  platform: "MacIntel",
  maxTouchPoints: 5,
};
const mac = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  platform: "MacIntel",
  maxTouchPoints: 0,
};
const android = {
  userAgent: "Mozilla/5.0 (Linux; Android 15)",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};

describe("isIosStandalonePwa", () => {
  it("matches an iPhone home-screen web app via navigator.standalone", () => {
    expect(
      isIosStandalonePwa({ ...iphone, standalone: true }, () => false),
    ).toBe(true);
  });

  it("matches iPadOS reporting as Macintosh when standalone", () => {
    expect(isIosStandalonePwa(ipados, () => true)).toBe(true);
  });

  it("does not match iOS Safari in a browser tab", () => {
    expect(isIosStandalonePwa(iphone, () => false)).toBe(false);
  });

  it("does not match desktop Macs or Android PWAs", () => {
    expect(isIosStandalonePwa(mac, () => true)).toBe(false);
    expect(isIosStandalonePwa(android, () => true)).toBe(false);
  });
});
