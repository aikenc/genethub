import { defineSpecialty } from "../../framework/public.ts";

for (let index = 0; index < 16; index += 1) {
  const delay = index % 4 === 0 ? 200 : 40;
  defineSpecialty(
    {
      id: `specialty.infra.parallel-${String(index).padStart(2, "0")}`,
      title: `Isolated parallel unit ${index}`,
      oracle: "unique lease home and no shared writable path",
      catches: ["shared HOME", "global env"],
      tags: ["infra", "infra-parallel"],
      expectedDurationMs: delay + 100,
      timeoutMs: 15_000,
      surfaces: ["testctl"],
    },
    async (t) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      t.assertions.assert(Boolean(t.env.home), "missing home");
      t.assertions.assert(t.env.home !== process.env.HOME || t.env.home.includes("genehub-env-"), "home not isolated");
    },
  );
}
