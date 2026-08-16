import type {
  PatchControlRequest,
  PatchControlResponse,
  Request,
} from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Host } from "../host";
import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";

import { UpdateToast } from "./UpdateToast";

const active = {
  channel: "beta",
  logicRevision: 41,
  platformAbi: 19,
  protocolVersion: 3,
  digest: "a".repeat(64),
  origin: "downloaded",
};

function host(overrides: Partial<Host> = {}): Host {
  return {
    kind: "browser",
    endpoint: async () => null,
    notify: () => {},
    openExternal: () => {},
    ...overrides,
  };
}

function daemon(answer: (request: PatchControlRequest) => PatchControlResponse) {
  const patches: PatchControlRequest[] = [];
  const client = {
    patch: async (request: PatchControlRequest) => {
      patches.push(request);
      return answer(request);
    },
    call: async (_request: Request) => undefined,
  } as unknown as Client;
  useWorkbench.setState({ client });
  return patches;
}

beforeEach(() => {
  useWorkbench.setState({ client: null, patch: null, patching: false, notice: null });
});

describe("the signed Wasm patch action", () => {
  it("shows nothing before a person checks", () => {
    render(<UpdateToast host={host()} />);
    expect(screen.queryByTestId("update-toast")).toBeNull();
  });

  it("applies only the candidate selected by the native controller", async () => {
    const patches = daemon(() => ({ type: "busy", active, blockers: {
      activeSessions: 1,
      terminals: 0,
      nativeResources: 0,
    } }));
    useWorkbench.setState({
      patch: {
        type: "status",
        active,
        highestAcceptedRevision: 41,
        availability: {
          type: "available",
          artifact: {
            logicRevision: 42,
            platformAbi: 19,
            protocolVersion: 3,
            digest: "b".repeat(64),
            size: 1024,
            openSourceSha: "1".repeat(40),
            cloudSourceSha: "2".repeat(40),
          },
        },
      },
    });
    render(<UpdateToast host={host()} />);

    await userEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ type: "apply", terminateActivities: false });
    expect(patches[0]).not.toHaveProperty("url");
    expect(patches[0]).not.toHaveProperty("revision");
  });

  it("requires an explicit second action before terminating active work", async () => {
    const patches = daemon(() => ({
      type: "applied",
      requestId: "patch_test",
      active: { ...active, logicRevision: 42 },
    }));
    useWorkbench.setState({
      patch: {
        type: "busy",
        active,
        blockers: { activeSessions: 2, terminals: 1, nativeResources: 1 },
      },
    });
    render(<UpdateToast host={host()} />);

    expect(screen.getByTestId("update-toast")).toHaveTextContent("共 4 项活动工作");
    await userEvent.click(screen.getByRole("button", { name: "终止任务并更新" }));
    expect(patches).toHaveLength(0);
    expect(screen.getByText("确认终止活动任务？")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认终止并更新" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ type: "apply", terminateActivities: true });
  });

  it("routes an ABI mismatch to the human-facing App download page", async () => {
    const opened: string[] = [];
    useWorkbench.setState({
      patch: {
        type: "status",
        active,
        highestAcceptedRevision: 41,
        availability: {
          type: "requiresApp",
          requiredPlatformAbi: 20,
          appManifestUrls: ["https://relay-beta.genethub.com/artifacts/manifests/app/latest-beta.json"],
        },
      },
    });
    render(<UpdateToast host={host({ openExternal: (url) => opened.push(url) })} />);

    await userEvent.click(screen.getByRole("button", { name: "查看安装包" }));
    expect(opened).toEqual(["https://relay-beta.genethub.com/download"]);
  });

  it("dismisses a completed patch without a daemon round trip", async () => {
    useWorkbench.setState({
      patch: { type: "applied", requestId: "patch_done", active },
    });
    render(<UpdateToast host={host()} />);

    await userEvent.click(screen.getByTestId("dismiss-update"));
    await waitFor(() => expect(screen.queryByTestId("update-toast")).toBeNull());
  });
});
