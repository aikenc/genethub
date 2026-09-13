#!/usr/bin/env node
// The CI release identity binds the bundled guest and every installation asset.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionForChannel, parseProductVersion } from "./product-version.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function appReleaseIdentity({ dist, version, channel, openSha }) {
  const releaseVersion = versionForChannel(version, channel);
  if (parseProductVersion(releaseVersion).live !== 0)
    throw new Error("App release must use an App generation version");
  if (!/^[a-f0-9]{40}$/.test(openSha ?? ""))
    throw new Error("App source SHA required");
  const bytes = readFileSync(join(dist, "genehub_guest.wasm"));
  const component = JSON.parse(
    readFileSync(join(dist, "component-identity.json"), "utf8"),
  );
  if (
    component.releaseVersion !== releaseVersion ||
    component.channel !== channel ||
    component.signedFileSize !== bytes.length ||
    !/^[a-f0-9]{64}$/.test(component.appAbiHash ?? "") ||
    !Number.isSafeInteger(component.webProtocol) ||
    component.webProtocol < 1
  ) {
    throw new Error("bundled component identity mismatch");
  }
  const installers = readdirSync(dist)
    .filter((name) => /\.(?:tar\.gz|zip|exe|msi|dmg)$/.test(name))
    .sort()
    .map((name) => {
      const artifact = readFileSync(join(dist, name));
      if (!artifact.length) throw new Error("empty installation asset");
      return { name, size: artifact.length, sha256: digest(artifact) };
    });
  if (!installers.length)
    throw new Error("App identity requires installation assets");
  return {
    schema: "genehub.app-release.v1",
    channel,
    releaseVersion,
    openSha,
    component: {
      releaseVersion,
      sha256: digest(bytes),
      size: bytes.length,
      appAbiHash: component.appAbiHash,
      webProtocol: component.webProtocol,
    },
    installers,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      if (!process.argv[i].startsWith("--") || !process.argv[i + 1])
        throw new Error("expected --name value arguments");
      args[process.argv[i].slice(2)] = process.argv[i + 1];
    }
    const identity = appReleaseIdentity({
      dist: args.dist,
      version: args.version,
      channel: args.channel,
      openSha: args["open-sha"],
    });
    writeFileSync(
      join(args.dist, "release-identity.json"),
      JSON.stringify(identity, null, 2) + "\n",
    );
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
