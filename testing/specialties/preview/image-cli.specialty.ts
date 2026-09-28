import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import { BlockedError, defineSpecialty, tryLocateHost } from "../../framework/public.ts";

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

function pngChunk(kind: string, payload: Buffer): Buffer {
  const name = Buffer.from(kind, "ascii");
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  name.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, payload])), 8 + payload.length);
  return chunk;
}

defineSpecialty(
  {
    id: "specialty.preview.image-cli",
    title: "Bundled native host CLI writes a bounded thumbnail to a chosen file",
    oracle: "CLI output is a decodable 128x64 transparent PNG and refuses to overwrite an existing file",
    catches: ["thumbnail CLI missing from bundled host", "CLI writes original pixels", "CLI overwrites a chosen destination"],
    tags: ["preview", "image", "native-host", "cli"],
    expectedDurationMs: 5000,
    timeoutMs: 30000,
    resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 },
    surfaces: ["genehub-host", "native-cli", "filesystem"],
    requiredArtifacts: ["genehub-host-local"],
  },
  async (t) => {
    const host = tryLocateHost(t.openRoot);
    if (!host) throw new BlockedError("genehub-host-local artifact missing");
    const width = 256;
    const height = 128;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * (1 + width * 4) + 1 + x * 4;
        raw[pixel] = (x + y) & 255;
        raw[pixel + 1] = (x ^ y) & 255;
        raw[pixel + 3] = x < 64 ? 0 : 255;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const source = Buffer.concat([
      PNG_MAGIC,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const input = join(t.env.workspace, "cli-source.png");
    const output = join(t.env.workspace, "cli-thumb.png");
    writeFileSync(input, source);
    const args = ["thumbnail", "--input", input, "--output", output, "--max-edge", "128"];
    const first = await promisify(execFile)(host, args, { timeout: 20000 });
    const result = JSON.parse(first.stdout) as { mediaType: string; width: number; height: number; bytes: number };
    const thumbnail = readFileSync(output);
    t.assertions.assert(result.mediaType === "image/png" && result.width === 128 && result.height === 64,
      `CLI metadata: ${first.stdout}`);
    t.assertions.assert(thumbnail.subarray(0, 8).equals(PNG_MAGIC)
      && thumbnail.readUInt32BE(16) === 128 && thumbnail.readUInt32BE(20) === 64,
      "CLI did not write the requested PNG pixels");
    t.assertions.assert(thumbnail.length === result.bytes && thumbnail.length < source.length,
      "CLI sent original bytes or reported the wrong length");
    const digest = createHash("sha256").update(thumbnail).digest("hex");
    let rejected = false;
    try {
      await promisify(execFile)(host, args, { timeout: 20000 });
    } catch {
      rejected = true;
    }
    t.assertions.assert(rejected, "CLI accepted an existing destination");
    t.assertions.assert(createHash("sha256").update(readFileSync(output)).digest("hex") === digest,
      "CLI changed the destination after refusing overwrite");
  },
);
