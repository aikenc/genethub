import type { Reply, Request } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Host } from "../host";
import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";

import { UpdateToast } from "./UpdateToast";

function host(overrides: Partial<Host> = {}): Host {
  return {
    kind: "desktop",
    endpoint: async () => null,
    notify: () => {},
    openExternal: () => {},
    ...overrides,
  };
}

function daemon(answers: Partial<Record<Request["type"], () => Reply>>) {
  const calls: Request[] = [];
  const client = {
    call: async (request: Request) => {
      calls.push(request);
      return answers[request.type]?.();
    },
  } as unknown as Client;
  useWorkbench.setState({ client });
  return calls;
}

beforeEach(() => {
  useWorkbench.setState({ client: null, download: { state: "idle" }, notice: null });
});

describe("the box in the corner after a download", () => {
  /// Nothing was asked for, so nothing is said. A toast that is always there is
  /// a toast people learn to look past.
  it("shows nothing while the machine is not fetching anything", () => {
    render(<UpdateToast host={host()} />);
    expect(screen.queryByTestId("update-toast")).toBeNull();
  });

  it("reports progress without offering anything to press", () => {
    useWorkbench.setState({
      download: { state: "fetching", version: "0.1.18", received: 5_242_880, total: 20_971_520 },
    });
    render(<UpdateToast host={host()} />);

    expect(screen.getByTestId("update-toast")).toHaveTextContent("正在下载 0.1.18");
    expect(screen.getByTestId("update-progress")).toHaveStyle({ width: "25%" });
    expect(screen.queryByTestId("install-update")).toBeNull();
  });

  /**
   * A server that sends no length is allowed to. The bar has nothing honest to
   * say then, and the byte count does — inventing a percentage would be a
   * progress bar that lies about being nearly done.
   */
  it("counts bytes when the release host would not say how many there are", () => {
    useWorkbench.setState({
      download: { state: "fetching", version: "0.1.18", received: 3_145_728 },
    });
    render(<UpdateToast host={host()} />);

    expect(screen.getByTestId("update-toast")).toHaveTextContent("3.0 MB");
    expect(screen.getByTestId("update-toast")).not.toHaveTextContent("%");
  });

  it("never executes a legacy downloaded file and points to the fixed official page", async () => {
    const installed: string[] = [];
    const opened: string[] = [];
    useWorkbench.setState({
      download: {
        state: "ready",
        version: "0.1.18",
        path: "C:\\Users\\me\\AppData\\Roaming\\GeneHub\\updates\\GeneHub-setup.exe",
      },
    });
    render(
      <UpdateToast
        host={host({
          openExternal: (url) => opened.push(url),
          installUpdate: async (path) => {
            installed.push(path);
          },
        })}
      />,
    );

    expect(screen.getByTestId("update-toast")).toHaveTextContent("自动安装已禁用");
    expect(screen.getByTestId("update-toast")).toHaveTextContent("SHA256SUMS");
    expect(screen.queryByTestId("install-update")).toBeNull();
    expect(installed).toEqual([]);

    await userEvent.click(screen.getByTestId("manual-update-link"));
    expect(opened).toEqual(["https://github.com/aikenc/genethub/releases"]);
  });

  /**
   * A phone watching someone's desktop is the case this protects. It cannot run
   * a file that is not on it, and a button that could only fail is worse than
   * the sentence saying where the installer went.
   */
  it("offers no install button where the shell cannot run one", () => {
    const remoteInstaller = "C:\\Users\\dev\\Downloads\\GeneHub-Setup.exe";
    useWorkbench.setState({
      download: { state: "ready", version: "0.1.18", path: remoteInstaller },
    });
    render(<UpdateToast host={host({ kind: "browser" })} />);

    expect(screen.queryByTestId("install-update")).toBeNull();
    expect(screen.getByTestId("update-toast")).toHaveTextContent(remoteInstaller);
  });

  /// "稍后" means later. Throwing the file away would make the next press pay
  /// for the whole download again as a punishment for reading the box.
  it("stops asking without discarding what was downloaded", async () => {
    const calls = daemon({
      "update.dismiss": () => ({ type: "updateDownload", data: { state: "idle" } }),
    });
    useWorkbench.setState({
      download: { state: "ready", version: "0.1.18", path: "/data/updates/setup.exe" },
    });
    render(<UpdateToast host={host()} />);

    await userEvent.click(screen.getByTestId("dismiss-update"));

    await waitFor(() => expect(screen.queryByTestId("update-toast")).toBeNull());
    expect(calls).toEqual([{ type: "update.dismiss" }]);
  });

  it("does not retry an obsolete automatic download path", () => {
    const calls = daemon({});
    useWorkbench.setState({
      download: { state: "failed", version: "0.1.18", message: "下载失败：服务器返回 503" },
    });
    render(<UpdateToast host={host()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("下载 0.1.18 失败");
    expect(screen.getByTestId("update-toast")).toHaveTextContent("503");

    expect(screen.queryByTestId("retry-update")).toBeNull();
    expect(calls).toEqual([]);
  });
});
