import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import {
  SYSTEM_STARTED_LABEL,
  defaultConversationFilter,
  isDefaultConversationSession,
  matchesConversation,
} from "./conversationFilters";

const workspace = (id: string, parentWorkspaceId?: string) =>
  ({ id, agentSpace: parentWorkspaceId ? { parentWorkspaceId } : undefined }) as unknown as WorkspaceInfo;

const session = (patch: Partial<SessionSummary>) =>
  ({ id: "s", workspaceId: "w", status: "idle", ...patch }) as unknown as SessionSummary;

const workspaces = [workspace("w"), workspace("child", "w")];
const shown = (s: SessionSummary, filter = defaultConversationFilter) =>
  matchesConversation(s, workspaces, filter);

describe("matchesConversation", () => {
  it("shows a plain session of a primary Workspace by default", () => {
    expect(shown(session({}))).toBe(true);
  });

  it("hides a session in a child Space and one that another session started", () => {
    expect(shown(session({ workspaceId: "child" }))).toBe(false);
    expect(shown(session({ labels: [SYSTEM_STARTED_LABEL] }))).toBe(false);
  });

  it("lists those hidden sessions under the children filter", () => {
    const children = { ...defaultConversationFilter, ownership: "children" as const };
    expect(shown(session({ workspaceId: "child" }), children)).toBe(true);
    expect(shown(session({ labels: [SYSTEM_STARTED_LABEL] }), children)).toBe(true);
    expect(shown(session({}), children)).toBe(false);
  });

  it("still separates archived from live sessions", () => {
    expect(shown(session({ archived: true }))).toBe(false);
  });
});

describe("default session view inclusion", () => {
  it("includes a human session in a project root", () => {
    expect(isDefaultConversationSession(session({}), workspaces)).toBe(true);
  });

  it("excludes a system-started session even when it lives in a project root", () => {
    expect(isDefaultConversationSession(session({ labels: [SYSTEM_STARTED_LABEL] }), workspaces)).toBe(false);
  });

  it("excludes any session in a child Space", () => {
    expect(isDefaultConversationSession(session({ workspaceId: "child" }), workspaces)).toBe(false);
    expect(isDefaultConversationSession(session({ workspaceId: "child", labels: [SYSTEM_STARTED_LABEL] }), workspaces)).toBe(false);
  });

  it("excludes a session whose workspace is not in the catalogue", () => {
    expect(isDefaultConversationSession(session({ workspaceId: "missing" }), workspaces)).toBe(false);
  });
});
