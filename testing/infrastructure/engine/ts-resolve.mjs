import { existsSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTS = [".ts", ".tsx", ".js", ".mjs"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const candidates = [];
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? specifier
        : new URL(specifier, pathToFileURL(dirname(parent) + "/")).pathname;
      if (!extname(base)) {
        for (const ext of EXTS) candidates.push(base + ext);
        candidates.push(`${base}/index.ts`, `${base}/index.js`);
      }
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw error;
  }
}
