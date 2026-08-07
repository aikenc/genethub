import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseBoundedInteger,
  config,
  validateGlobalBufferLimit,
  validateBufferLimits,
  validateControlOrigin,
} from "../src/shared/config.js";
import { admissionCredential, requestTarget } from "../src/shared/request-target.js";
import { startRelay } from "../src/main.js";

describe("relay configuration boundaries", () => {
  it("parses the complete integer and enforces the declared range", () => {
    assert.equal(parseBoundedInteger("PORT", undefined, 8788, 1, 65_535), 8788);
    assert.equal(parseBoundedInteger("PORT", "65535", 8788, 1, 65_535), 65_535);
    for (const invalid of ["0", "65536", "12junk", "-1", " 12", "12 ", "1.5"]) {
      assert.throws(() => parseBoundedInteger("PORT", invalid, 8788, 1, 65_535));
    }
  });

  it("accepts port zero when the caller explicitly permits an ephemeral bind", () => {
    assert.equal(parseBoundedInteger("RELAY_PORT", "0", 8788, 0, 65_535), 0);
  });

  it("never permits a single accepted frame to exceed the peer buffer", () => {
    assert.doesNotThrow(() => validateBufferLimits(4096, 4096));
    assert.throws(() => validateBufferLimits(4095, 4096), /must be at least/);
  });

  it("never permits the process-wide queue to be smaller than one peer queue", () => {
    assert.doesNotThrow(() => validateGlobalBufferLimit(8192, 4096));
    assert.throws(() => validateGlobalBufferLimit(4095, 4096), /must be at least/);
  });
});

describe("upgrade request targets", () => {
  it("fails malformed targets closed instead of throwing from an event listener", () => {
    assert.equal(requestTarget("http://[not-an-ip"), null);
    assert.equal(requestTarget("http://%"), null);
    assert.equal(requestTarget("/fabric/v2")?.pathname, "/fabric/v2");
  });

  it("bounds bearer and query credentials by UTF-8 bytes", () => {
    assert.equal(admissionCredential("x".repeat(4096), 4096)?.length, 4096);
    assert.equal(admissionCredential("x".repeat(4097), 4096), null);
    assert.equal(admissionCredential("恶".repeat(1366), 4096), null);
  });
});

describe("the Control credential transport", () => {
  it("fails closed when the production Control token is absent", () => {
    const previous = process.env.RELAY_CONTROL_TOKEN;
    delete process.env.RELAY_CONTROL_TOKEN;
    try {
      assert.throws(() => config.controlToken(), /RELAY_CONTROL_TOKEN must be set/);
    } finally {
      if (previous === undefined) delete process.env.RELAY_CONTROL_TOKEN;
      else process.env.RELAY_CONTROL_TOKEN = previous;
    }
  });

  it("refuses to start a production Control relay without its token", async () => {
    const previousMode = process.env.RELAY_MODE;
    const previousToken = process.env.RELAY_CONTROL_TOKEN;
    process.env.RELAY_MODE = "control";
    delete process.env.RELAY_CONTROL_TOKEN;
    try {
      await assert.rejects(
        startRelay({
          port: 0,
          host: "127.0.0.1",
          controlOrigin: "http://127.0.0.1:9",
        }),
        /RELAY_CONTROL_TOKEN must be set/,
      );
    } finally {
      if (previousMode === undefined) delete process.env.RELAY_MODE;
      else process.env.RELAY_MODE = previousMode;
      if (previousToken === undefined) delete process.env.RELAY_CONTROL_TOKEN;
      else process.env.RELAY_CONTROL_TOKEN = previousToken;
    }
  });
  it("requires HTTPS except for a raw literal loopback IP", () => {
    assert.equal(validateControlOrigin("https://control.example/base/"), "https://control.example/base");
    assert.equal(validateControlOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
    assert.equal(validateControlOrigin("http://127.99.1.2/control"), "http://127.99.1.2/control");
    assert.equal(validateControlOrigin("http://[::1]:8787"), "http://[::1]:8787");
    for (const unsafe of [
      "http://control.example",
      "http://localhost:8787",
      "http://10.0.0.1",
      "http://2130706433",
      "http://127.1",
      "http://0177.0.0.1",
      "https://user:secret@control.example",
      "https://control.example/path?token=x",
      "https://control.example/#fragment",
    ]) {
      assert.throws(() => validateControlOrigin(unsafe), /RELAY_CONTROL_ORIGIN/);
    }
  });
});
