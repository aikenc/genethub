import { watch, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Observe source edits, including edits restored before the final digest.
 * Avoid recursive fs.watch traversing dependency symlink forests and build caches. */
export function watchInputs(roots: string[], artifactFiles: string[]) {
  let changed = false, complete = true;
  const errors = new Set<string>();
  const artifacts = new Set(artifactFiles.map(p => path.resolve(p)));
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const fail = (error: unknown) => { complete = false; errors.add((error as NodeJS.ErrnoException)?.code ?? "watch-error"); };
  const ignored = (root: string, file: string) => {
    const parts = path.relative(root, file).split(path.sep);
    return parts.includes(".git") || parts.includes("node_modules") || parts[0] === "target";
  };
  function add(root: string, directory: string, artifactOnly = false) {
    if (watchers.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, name) => {
        if (!name) { complete = false; errors.add("missing-event-name"); return; }
        const file = path.resolve(directory, String(name));
        if (artifactOnly ? !artifacts.has(file) : ignored(root, file)) return;
        changed = true;
        // New directories must also be observed; the creation already invalidated this input.
        if (!artifactOnly) {
          try { if (statSync(file).isDirectory()) walk(root, file); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(error);
          }
        }
      });
      watcher.on("error", fail); watchers.set(directory, watcher);
    } catch (error) { fail(error); }
  }
  function walk(root: string, directory: string) {
    add(root, directory);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !ignored(root, file)) walk(root, file);
      }
    } catch (error) { fail(error); }
  }
  for (const root of roots) walk(path.resolve(root), path.resolve(root));
  for (const file of artifacts) add(path.dirname(file), path.dirname(file), true);
  return { stop() { for (const watcher of watchers.values()) watcher.close(); return { changed, complete, errors: [...errors] }; } };
}
