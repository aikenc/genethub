import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";

import { AssetPreviewError_ } from "@genehub/workbench/client";
import { defineSpecialty } from "../../framework/public.ts";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const kind = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  kind.copy(out, 4);
  body.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([kind, body])), 8 + body.length);
  return out;
}

/** A valid transparent PNG, made without a product encoder. */
function sourcePng(seed: number, width = 2048, height = 1024): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = (x + seed) & 255;
      raw[pixel + 1] = (y + seed) & 255;
      raw[pixel + 2] = (x ^ y ^ seed) & 255;
      raw[pixel + 3] = x < 512 ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_MAGIC,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngDimensions(bytes: Uint8Array): [number, number] {
  const data = Buffer.from(bytes);
  if (!data.subarray(0, 8).equals(PNG_MAGIC) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("preview output is not a PNG");
  }
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

defineSpecialty(
  {
    id: "specialty.preview.image-representations",
    title: "Real daemon returns bounded image previews without substituting original bytes",
    oracle: "128/1024 are valid bounded PNGs; original is exact; a changed source changes version and pixels; nonimages reject image requests; workspace list stays responsive during decode",
    catches: ["ignored representation field", "original returned as thumbnail", "stale source-version cache", "nonimage fallback", "guest decode stalls unrelated requests"],
    tags: ["preview", "image", "wasm-guest", "cross-repo-contract"],
    expectedDurationMs: 45000,
    timeoutMs: 120000,
    resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
    surfaces: ["daemon", "host", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
    requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
  },
  async (t) => {
    const filePath = join(t.env.workspace, "painting.png");
    const source = sourcePng(17);
    writeFileSync(filePath, source);
    writeFileSync(join(t.env.workspace, "notes.txt"), "not an image");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const path = `${opened.rootHandle}/painting.png`;
    let phase = "first thumbnail";
    try {
      t.assertions.assert(existsSync(filePath), "workspace fixture vanished after daemon opened");
      t.assertions.assert(
        opened.client.identity?.features?.includes("asset.preview.image.v1") === true,
        "real daemon did not advertise image representations",
      );
      const small = await opened.client.preview(opened.workspaceId, path, "image-128");
      t.assertions.assert(small.metadata.representation === "image-128", "128 representation missing");
      t.assertions.assert(small.metadata.sourceBytes === source.length, "source length was lost");
      t.assertions.assert(small.metadata.mediaType === "image/png", "transparent image lost alpha format");
      t.assertions.assert(pngDimensions(small.bytes).join("x") === "128x64", "128 pixels are wrong");
      t.assertions.assert(small.bytes.length < source.length, "thumbnail was not smaller than source");

      phase = "medium thumbnail";
      const large = opened.client.preview(opened.workspaceId, path, "image-1024");
      void large.catch(() => undefined);
      const began = performance.now();
      const workspaces = await opened.client.call({ type: "workspace.list" });
      const listMs = performance.now() - began;
      t.assertions.assert(workspaces?.type === "workspaces", "unrelated workspace list failed");
      t.assertions.assert(listMs < 2000, `decode stalled workspace list for ${listMs.toFixed(0)}ms`);
      const medium = await large;
      t.assertions.assert(medium.metadata.representation === "image-1024", "1024 representation missing");
      t.assertions.assert(pngDimensions(medium.bytes).join("x") === "1024x512", "1024 pixels are wrong");
      t.assertions.assert(medium.metadata.version === small.metadata.version, "one source has two versions");

      phase = "large fixture";
      const largeSource = sourcePng(23, 7680, 4320);
      t.assertions.assert(largeSource.length < 64 * 1024 * 1024, "8K fixture exceeds source budget");
      writeFileSync(join(t.env.workspace, "large.png"), largeSource);
      const largePath = `${opened.rootHandle}/large.png`;
      const largePreview = opened.client.preview(opened.workspaceId, largePath, "image-1024");
      void largePreview.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const largeBegan = performance.now();
      const alongside = await opened.client.call({ type: "workspace.list" });
      const alongsideMs = performance.now() - largeBegan;
      t.assertions.assert(alongside?.type === "workspaces", "workspace list failed during 8K decode");
      t.assertions.assert(alongsideMs < 2000, `8K decode stalled list for ${alongsideMs.toFixed(0)}ms`);
      const largeResult = await largePreview;
      t.assertions.assert(largeResult.metadata.sourceBytes === largeSource.length, "8K source length mismatch");
      t.assertions.assert(pngDimensions(largeResult.bytes).join("x") === "1024x576", "8K preview pixels are wrong");
      t.assertions.assert(largeResult.bytes.length < largeSource.length, "8K original bytes leaked into preview");

      phase = "original";
      const original = await opened.client.preview(opened.workspaceId, path);
      t.assertions.assert(original.metadata.representation === undefined, "old original response changed contract");
      t.assertions.assert(
        createHash("sha256").update(original.bytes).digest("hex") === createHash("sha256").update(source).digest("hex"),
        "original bytes differ from source",
      );

      phase = "source replacement";
      const changed = sourcePng(18);
      writeFileSync(filePath, changed);
      const fresh = await opened.client.preview(opened.workspaceId, path, "image-128");
      t.assertions.assert(fresh.metadata.version !== small.metadata.version, "changed file reused an old version");
      t.assertions.assert(!Buffer.from(fresh.bytes).equals(Buffer.from(small.bytes)), "changed file reused old pixels");

      phase = "nonimage rejection";
      try {
        await opened.client.preview(opened.workspaceId, `${opened.rootHandle}/notes.txt`, "image-128");
        t.assertions.assert(false, "nonimage returned a thumbnail");
      } catch (error) {
        t.assertions.assert(error instanceof AssetPreviewError_ && error.status === 415, `nonimage error: ${String(error)}`);
      }
    } catch (error) {
      throw new Error(`${phase}: ${String(error)}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
