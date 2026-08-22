import { compareQueueTails, defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.infra.queue-compare",
    title: "Longest-first dynamic queue beats round-robin shards on uneven work",
    oracle: "dynamic tail wait is strictly below a 4-shard round-robin baseline",
    catches: ["fixed shards", "shortest-first"],
    tags: ["infra", "infra-parallel"],
    expectedDurationMs: 200,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    const durations = [800, 800, 200, 200, 200, 200, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40];
    const result = compareQueueTails(durations, 4);
    t.assertions.assert(result.dynamicWins, `dynamic ${result.dynamicMs}ms vs shard ${result.shardMs}ms`);
  },
);
