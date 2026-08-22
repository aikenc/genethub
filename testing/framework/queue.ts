export function shardTailMs(durations: number[], shards: number): number {
  const buckets = Array.from({ length: Math.max(1, shards) }, () => 0);
  durations.forEach((duration, index) => {
    buckets[index % buckets.length]! += duration;
  });
  return Math.max(...buckets);
}

export function dynamicTailMs(durations: number[], workers: number): number {
  const heap = Array.from({ length: Math.max(1, workers) }, () => 0);
  for (const duration of [...durations].sort((a, b) => b - a)) {
    heap.sort((a, b) => a - b);
    heap[0] = (heap[0] ?? 0) + duration;
  }
  return Math.max(...heap);
}

export function compareQueueTails(durations: number[], workers: number): {
  shardMs: number;
  dynamicMs: number;
  dynamicWins: boolean;
} {
  const shardMs = shardTailMs(durations, workers);
  const dynamicMs = dynamicTailMs(durations, workers);
  return { shardMs, dynamicMs, dynamicWins: dynamicMs < shardMs };
}
