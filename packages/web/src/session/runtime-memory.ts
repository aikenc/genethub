import type { AgentInfo } from "@genehub/proto";

import { canStartAgent, resolveAgentProfile } from "../presentation/catalog/resolve";

/**
 * Which Agent and model a new conversation should open with.
 *
 * Kept in this browser rather than on the machine, alongside the sidebar's
 * arrangement: this is how one person set up one window. A phone opening the
 * same project has its own answer, and neither should rearrange the other.
 *
 * Keyed by project, because that is how the choice is actually made — an
 * infrastructure repo is worked on with one Agent and a design system with
 * another, and being dropped back onto whichever one the last project used is
 * a surprise discovered at the first reply. A project nobody has opened before
 * inherits the last choice made anywhere, which is a better guess than the
 * built-in default.
 *
 * Model, mode and thinking depth are stored under the Agent they belong to.
 * They are not portable: `sonnet` means nothing to Codex, and remembering one
 * number for the project would hand the wrong id to `session.create` every
 * time the Agent changed.
 */
export interface AgentRuntimeMemory {
  modelId?: string;
  modeId?: string;
  effortId?: string;
}

export interface WorkspaceRuntimeMemory {
  agentId?: string;
  agents?: Record<string, AgentRuntimeMemory>;
}

export interface RuntimeChoice {
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  /**
   * Whether this project has been worked on before, as opposed to inheriting
   * the last choice made anywhere. Only its own history outranks the
   * conversation currently on screen.
   */
  scoped: boolean;
}

interface RuntimeMemoryFile {
  version: 1;
  /** What the last project to be chosen in settled on, for projects with none. */
  last?: WorkspaceRuntimeMemory;
  workspaces: Record<string, WorkspaceRuntimeMemory>;
}

const KEY = "genehub.runtime.by-workspace";

/**
 * The remembered choice for a project, with everything the catalog no longer
 * offers dropped.
 *
 * An uninstalled Agent or a withdrawn model would otherwise be handed straight
 * to `session.create`, which fails — and fails at the first message, long after
 * the choice that caused it. Anything dropped here simply falls back to the
 * caller's default, which is what a project with no memory already does.
 */
export function recallRuntimeChoice(
  workspaceId: string | null,
  agents: AgentInfo[],
  /** An Agent the caller has already settled on; its own axes are read out. */
  preferredAgentId?: string | null,
): RuntimeChoice {
  const file = read();
  const own = workspaceId ? file.workspaces[workspaceId] : undefined;
  const remembered = own ?? file.last ?? {};
  const scoped = Boolean(own);
  const wanted = preferredAgentId ?? remembered.agentId;
  const agent = agents.find(
    (candidate) => candidate.id === wanted && canStartAgent(candidate),
  );
  if (!agent) return { agentId: null, modelId: null, modeId: null, effortId: null, scoped };

  const axes = remembered.agents?.[agent.id] ?? {};
  // An Agent that publishes no catalog owns its own defaults, so a model id we
  // cannot see in one is not evidence that it has gone away.
  const opaque =
    agent.catalog.models.length === 0 && resolveAgentProfile(agent.id).startWithoutModelCatalog;
  const modelId =
    axes.modelId &&
    (opaque || agent.catalog.models.some((model) => model.id === axes.modelId))
      ? axes.modelId
      : null;
  const modeId =
    axes.modeId && (opaque || agent.catalog.modes.some((mode) => mode.id === axes.modeId))
      ? axes.modeId
      : null;
  const efforts = agent.catalog.models.find((model) => model.id === modelId)?.efforts ?? [];
  const effortId =
    axes.effortId && (opaque || efforts.includes(axes.effortId)) ? axes.effortId : null;

  return { agentId: agent.id, modelId, modeId, effortId, scoped };
}

/** Records one axis, or several, as this project's answer and as the latest one. */
export function rememberRuntimeChoice(
  workspaceId: string | null,
  agentId: string | null,
  axes: AgentRuntimeMemory = {},
): void {
  if (!workspaceId || !agentId) return;
  const file = read();
  const before = file.workspaces[workspaceId] ?? {};
  const entry: WorkspaceRuntimeMemory = {
    agentId,
    agents: {
      ...before.agents,
      [agentId]: { ...before.agents?.[agentId], ...axes },
    },
  };
  write({
    version: 1,
    last: entry,
    workspaces: { ...file.workspaces, [workspaceId]: entry },
  });
}

function read(): RuntimeMemoryFile {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<RuntimeMemoryFile>) : null;
    if (!parsed || parsed.version !== 1 || typeof parsed.workspaces !== "object") {
      return { version: 1, workspaces: {} };
    }
    return {
      version: 1,
      workspaces: parsed.workspaces ?? {},
      ...(parsed.last ? { last: parsed.last } : {}),
    };
  } catch {
    return { version: 1, workspaces: {} };
  }
}

function write(file: RuntimeMemoryFile): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(file));
  } catch {
    // Storage blocked. The choice lasts as long as the tab, which is better
    // than refusing to switch model.
  }
}
