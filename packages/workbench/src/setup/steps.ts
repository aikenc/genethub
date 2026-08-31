import type { AgentInfo, GuidePlatform, InstallMethod } from "@genehub/proto";

import { canStartAgent } from "../presentation/catalog/resolve";

/**
 * Where the setup wizard starts for an agent, derived fresh on every render.
 *
 * The wizard never tracks progress itself: the daemon re-probes while the user
 * works, and the step is recompute-from-probe-and-auth, so a completed sign-in
 * advances the dialog without anyone clicking "next".
 */
export type WizardStep = "install" | "credentials" | "ready";

export function wizardStep(agent: AgentInfo): WizardStep {
  if (agent.probe.state === "notInstalled") return "install";
  const setup = agent.setup;
  const hasGuides = Boolean(setup?.login ?? setup?.apiKey);
  // The built-in agent's credential is a provider key; an empty catalog is
  // how "no key yet" shows up for it.
  if (agent.builtin) return canStartAgent(agent) ? "ready" : "credentials";
  if (agent.auth === "unauthenticated") return hasGuides ? "credentials" : "ready";
  // Unknown is shown the guides too — an agent we cannot ask (OpenCode, a
  // custom ACP entry) still wants its own sign-in flow pointed at — but it is
  // never blocked: the step always offers a way straight to "done".
  if (agent.auth === "unknown" && hasGuides) return "credentials";
  return "ready";
}

/** The install commands that can run on the machine the agent lives on. */
export function installMethodsFor(agent: AgentInfo): InstallMethod[] {
  return (agent.setup?.install ?? []).filter((method) =>
    method.platforms.includes(agent.platform),
  );
}

/**
 * The one-liner that sets an environment variable persistently on the agent's
 * machine. Written to be pasted and *edited* before enter: the placeholder is
 * where the user's key goes, and editing is the user's confirmation that the
 * command is theirs to run.
 *
 * Per platform because the mechanisms genuinely differ: `setx` writes the
 * Windows user environment, `launchctl setenv` reaches GUI apps on macOS, and
 * on Linux a shell profile line plus a re-login is the portable answer.
 */
export function envCommand(name: string, platform: GuidePlatform): string {
  if (platform === "windows") return `setx ${name} "在此粘贴"`;
  if (platform === "macos") return `launchctl setenv ${name} "在此粘贴"`;
  return `echo 'export ${name}="在此粘贴"' >> ~/.profile`;
}

export interface AuthBadge {
  label: string;
  tone: "ok" | "warn";
}

/**
 * The sign-in badge for an agent row — or nothing, for the states nobody
 * should be badge-notified about: not installed (the state column already
 * says so), not applicable (the built-in agent's keys are ours), and unknown
 * (a badge must never invent an answer).
 */
export function authBadge(agent: AgentInfo): AuthBadge | null {
  if (agent.probe.state === "notInstalled") return null;
  if (agent.auth === "authenticated") return { label: "已认证", tone: "ok" };
  if (agent.auth === "unauthenticated") return { label: "未认证", tone: "warn" };
  return null;
}
