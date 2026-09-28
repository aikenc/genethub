import type { Client } from "../protocol/client";

type SmallImage = { bytes: Uint8Array; mediaType: string } | null;
type Pending = {
  controller: AbortController;
  users: number;
  promise: Promise<SmallImage>;
};

const pendingByClient = new WeakMap<Client, Map<string, Pending>>();

/** Merge only simultaneous reads on one authenticated Client. A path is not
 * a durable cache key: the file may change without a client-side event. */
export function loadSessionImage(
  client: Client,
  workspaceHandle: string,
  path: string,
  signal?: AbortSignal,
): Promise<SmallImage> {
  if (signal?.aborted) return Promise.resolve(null);
  let pending = pendingByClient.get(client);
  if (!pending) {
    pending = new Map();
    pendingByClient.set(client, pending);
  }
  const key = `${workspaceHandle}\0${path}`;
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      users: 0,
      promise: client.preview(workspaceHandle, path, "image-128", controller.signal)
        .then((result) => result.metadata.kind === "image"
          ? { bytes: result.bytes, mediaType: result.metadata.mediaType }
          : null)
        .catch(() => null)
        .finally(() => {
          if (pending?.get(key) === entry) pending.delete(key);
        }),
    };
    pending.set(key, entry);
  }
  const request = entry;
  request.users += 1;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: SmallImage) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      request.users -= 1;
      if (request.users === 0 && pending?.get(key) === request) {
        pending.delete(key);
        request.controller.abort();
      }
      resolve(value);
    };
    const cancel = () => finish(null);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else void request.promise.then(finish);
  });
}
