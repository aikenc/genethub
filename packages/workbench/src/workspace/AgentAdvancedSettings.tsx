import type { AgentSpaceBuilderOperation, WorkspaceInfo } from "@genehub/proto";
import { useEffect, useState, Fragment } from "react";
import { useWorkbench } from "../session/store";
import { buildAgentSpaceTree, isDescendant } from "./agent-space-tree";

/** Shared configuration, independent of the row or dialog that opened it. */
export function AgentAdvancedSettings({ workspace, section = "all", inline = false }: { workspace: WorkspaceInfo; section?: "all" | "components" | "relations"; inline?: boolean }) {
  const workspaces = useWorkbench((s) => s.workspaces);
  const tree = buildAgentSpaceTree(workspaces);
  const projectWorkspaceId = tree.projectRootById[workspace.id] ?? workspace.id;
  const breadcrumb = workspace.name;
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [componentId, setComponentId] = useState("worker");
  const [workerRole, setWorkerRole] = useState("tester");
  const [parentId, setParentId] = useState(
    workspace.agentSpace?.parentWorkspaceId ?? "",
  );
  const [lifecycle, setLifecycle] = useState(
    workspace.agentSpace?.lifecycle ?? "persistent",
  );
  const [builderSummary, setBuilderSummary] = useState<string | null>(null);
  const [error, setError] = useState("");
  const configureAgentSpace = useWorkbench(
    (state) => state.configureAgentSpace,
  );
  const inspectAgentSpaceBuild = useWorkbench(
    (state) => state.inspectAgentSpaceBuild,
  );
  const revision = workspace.agentSpace?.revision ?? 0;
  useEffect(() => {
    setParentId(workspace.agentSpace?.parentWorkspaceId ?? "");
    setLifecycle(workspace.agentSpace?.lifecycle ?? "persistent");
  }, [workspace.id, revision]);
  const mutate = async (
    operation: Parameters<typeof configureAgentSpace>[2],
  ) => {
    setSpaceBusy(true);
    setError("");
    try {
      await configureAgentSpace(workspace.id, revision, operation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配置操作失败");
    } finally {
      setSpaceBusy(false);
    }
  };
  const inspectBuild = async (operation: AgentSpaceBuilderOperation) => {
    setSpaceBusy(true);
    setError("");
    try {
      const report = await inspectAgentSpaceBuild(
        projectWorkspaceId,
        workspace.id,
        operation,
      );
      setBuilderSummary(report ? `${report.status} · ${report.command}` : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配置操作失败");
    } finally {
      setSpaceBusy(false);
    }
  };
  const parentChoices = workspaces.filter(
    (candidate) =>
      candidate.id !== workspace.id &&
      !isDescendant(workspaces, candidate.id, workspace.id),
  );
  const Container = inline ? Fragment : "details";
  return <>
          <Container>{!inline && <summary className="cursor-pointer py-2 text-sm text-muted">高级专家配置</summary>}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-fg">专家配置</span>
              <span className="text-xs text-faint">
                revision {revision}
              </span>
            </div>
            {workspace.agentSpace ? (
              <>
                <Detail label="位置" value={breadcrumb} />
                <Detail
                  label="健康"
                  value={workspace.agentSpace.health?.status ?? "unknown"}
                />
                {(workspace.agentSpace.health?.reasons ?? []).map((reason) => (
                  <p key={reason} className="py-0.5 text-xs text-danger">
                    {reason}
                  </p>
                ))}
                <Detail
                  label="生命周期"
                  value={workspace.agentSpace.lifecycle}
                />
                <Detail
                  label="Builder"
                  value={workspace.agentSpace.builderLockDigest || "未验证"}
                />
                {workspace.agentSpace.bootstrapPack ? (
                  <Detail
                    label="Pack"
                    value={`${workspace.agentSpace.bootstrapPack.id} v${workspace.agentSpace.bootstrapPack.version}`}
                  />
                ) : null}
                {section !== "relations" && <div className="mt-2 space-y-1" aria-label="Component 列表">
                  {workspace.agentSpace.components.map((component) => (
                    <div
                      key={component.componentId}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {component.componentId}
                        {component.role ? `:${component.role}` : ""}
                        {` · v${component.schemaVersion}`}
                        {!component.enabled ? " · 已停用" : ""}
                      </span>
                      <button
                        type="button"
                        disabled={spaceBusy}
                        className="min-h-10 rounded px-2 text-xs text-accent hover:bg-raised disabled:opacity-40"
                        onClick={() =>
                          void mutate({
                            kind: "setComponent",
                            componentId: component.componentId,
                            enabled: !component.enabled,
                            role: component.role ?? null,
                          })
                        }
                      >
                        {component.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        disabled={spaceBusy}
                        className="min-h-10 rounded px-2 text-xs text-danger hover:bg-raised disabled:opacity-40"
                        onClick={() =>
                          void mutate({
                            kind: "removeComponent",
                            componentId: component.componentId,
                          })
                        }
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>}
              </>
            ) : (
              <p className="mt-1 leading-relaxed text-muted">
                尚未配置组件。添加组件前，会验证当前目录的构建配置。
              </p>
            )}

            {section !== "relations" && <><div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1">
              <select
                aria-label="要添加的 Component"
                value={componentId}
                onChange={(event) => setComponentId(event.target.value)}
                className="min-w-0 rounded border border-line bg-raised min-h-10 px-2 py-2 text-fg"
              >
                <option value="pm">PM</option>
                <option value="executor">Executor</option>
                <option value="worker">Worker</option>
                <option value="reviewer">Reviewer</option>
              </select>
              {componentId === "worker" ? (
                <input
                  aria-label="Worker role"
                  value={workerRole}
                  onChange={(event) => setWorkerRole(event.target.value)}
                  placeholder="role，例如 tester"
                  className="min-w-0 rounded border border-line bg-raised min-h-10 px-2 py-2 text-fg"
                />
              ) : (
                <span />
              )}
            </div>
            <button
              type="button"
              disabled={
                spaceBusy || (componentId === "worker" && !workerRole.trim())
              }
              className="mt-1 w-full rounded bg-accent min-h-10 px-2 py-2 text-white disabled:opacity-40"
              onClick={() =>
                void mutate({
                  kind: "setComponent",
                  componentId,
                  enabled: true,
                  role: componentId === "worker" ? workerRole.trim() : null,
                })
              }
            >
              添加或更新 Component
            </button></>}

            {section !== "components" && <div className="mt-3 flex gap-1">
              <select
                aria-label="上级专家"
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-line bg-raised min-h-10 px-2 py-2 text-fg"
              >
                <option value="">无 Parent（项目根）</option>
                {parentChoices.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={spaceBusy || !workspace.agentSpace}
                className="rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() =>
                  void mutate({
                    kind: "setParent",
                    parentWorkspaceId: parentId || null,
                  })
                }
              >
                保存上级关系
              </button>
            </div>}

            <div className="mt-2 flex gap-1">
              <select
                aria-label="专家生命周期"
                value={lifecycle}
                onChange={(event) => setLifecycle(event.target.value)}
                className="min-w-0 flex-1 rounded border border-line bg-raised min-h-10 px-2 py-2 text-fg"
              >
                <option value="persistent">persistent</option>
                <option value="pooled">pooled</option>
                <option value="ephemeral">ephemeral</option>
              </select>
              <button
                type="button"
                disabled={spaceBusy || !workspace.agentSpace}
                className="rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void mutate({ kind: "setLifecycle", lifecycle })}
              >
                保存生命周期
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1">
              {!workspace.agentSpace ? (
                <>
                  <button
                    type="button"
                    disabled={spaceBusy}
                    className="rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                    onClick={() => void inspectBuild({ kind: "init" })}
                  >
                    Builder 初始化
                  </button>
                  <button
                    type="button"
                    disabled={spaceBusy}
                    className="rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                    onClick={() =>
                      void inspectBuild({
                        kind: "build",
                        dryRun: false,
                        requireNoPostCommands: true,
                      })
                    }
                  >
                    Builder Build
                  </button>
                </>
              ) : null}
              <button
                type="button"
                disabled={spaceBusy}
                className="flex-1 rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void inspectBuild({ kind: "check" })}
              >
                Builder Check
              </button>
              <button
                type="button"
                disabled={spaceBusy}
                className="flex-1 rounded border border-line min-h-10 px-2 py-2 text-fg hover:bg-raised disabled:opacity-40"
                onClick={() => void inspectBuild({ kind: "verify" })}
              >
                Builder Verify
              </button>
            </div>
            {builderSummary ? (
              <p className="mt-1 text-xs text-muted">{builderSummary}</p>
            ) : null}
          </div>
          </Container>
{error && <p role="alert" className="mt-3 text-danger">{error}</p>}
</>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 py-1">
      <span className="text-faint">{label}</span>
      <span className="break-all text-fg">{value}</span>
    </div>
  );
}

