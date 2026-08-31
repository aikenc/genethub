import type { AgentInfo } from "@genehub/proto";

/**
 * A complete `AgentInfo` for tests, with the wiring every renderer assumes.
 *
 * One maker rather than five copies, because the type keeps gaining fields and
 * each one used to mean editing every fixture by hand. Defaults describe a
 * ready, signed-in, third-party CLI; overrides say what makes this case
 * itself.
 */
export function agentFixture(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "genet",
    label: "GeneHub Agent",
    builtin: false,
    probe: { state: "ready" },
    capabilities: {
      interrupt: true,
      setModel: true,
      setEffort: false,
      setMode: false,
      permissions: false,
      resume: true,
      fork: false,
      attachments: false,
    },
    catalog: { models: [], modes: [], commands: [] },
    platform: "linux",
    version: undefined,
    auth: "authenticated",
    setup: { install: [] },
    ...overrides,
  };
}
