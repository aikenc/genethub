import type { Reply, Request } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("guides the finished download into the installer", async () => {
    const installed: string[] = [];
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
          installUpdate: async (path) => {
            installed.push(path);
          },
        })}
      />,
    );

    expect(screen.getByTestId("update-toast")).toHaveTextContent("新版本 0.1.18 已下载");
    // The cost is on the box, not buried in settings: this is the click that
    // stops the daemon and whatever an agent was mid-turn.
    expect(screen.getByTestId("update-toast")).toHaveTextContent("会被打断");

    await userEvent.click(screen.getByTestId("install-update"));
    expect(installed).toEqual([
      "C:\\Users\\me\\AppData\\Roaming\\GeneHub\\updates\\GeneHub-setup.exe",
    ]);
  });

  /**
   * A phone watching someone's desktop is the case this protects. It cannot run
   * a file that is not on it, and a button that could only fail is worse than
   * the sentence saying where the installer went.
   */
  it("offers no install button where the shell cannot run one", () => {
    useWorkbench.setState({
      download: { state: "ready", version: "0.1.18", path: "/data/updates/GeneHub.AppImage" },
    });
    render(<UpdateToast host={host({ kind: "browser" })} />);

    expect(screen.queryByTestId("install-update")).toBeNull();
    expect(screen.getByTestId("update-toast")).toHaveTextContent("/data/updates/GeneHub.AppImage");
  });

  it("says why the install did not start rather than closing on the failure", async () => {
    useWorkbench.setState({
      download: { state: "ready", version: "0.1.18", path: "/data/updates/setup.exe" },
    });
    render(
      <UpdateToast
        host={host({
          installUpdate: async () => {
            throw new Error("这个安装包不在 GeneHub 的更新目录里，没有运行");
          },
        })}
      />,
    );

    await userEvent.click(screen.getByTestId("install-update"));
    expect(await screen.findByRole("alert")).toHaveTextContent("不在 GeneHub 的更新目录里");
    // Still there, because the person now has something to read and a second
    // chance to press.
    expect(screen.getByTestId("install-update")).toBeInTheDocument();
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
    render(<UpdateToast host={host({ installUpdate: vi.fn() })} />);

    await userEvent.click(screen.getByTestId("dismiss-update"));

    await waitFor(() => expect(screen.queryByTestId("update-toast")).toBeNull());
    expect(calls).toEqual([{ type: "update.dismiss" }]);
  });

  it("lets a failed download be tried again from where it is reported", async () => {
    const calls = daemon({
      "update.download": () => ({
        type: "updateDownload",
        data: { state: "fetching", version: "0.1.18", received: 0 },
      }),
    });
    useWorkbench.setState({
      download: { state: "failed", version: "0.1.18", message: "下载失败：服务器返回 503" },
    });
    render(<UpdateToast host={host()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("下载 0.1.18 失败");
    expect(screen.getByTestId("update-toast")).toHaveTextContent("503");

    await userEvent.click(screen.getByTestId("retry-update"));
    expect(calls).toEqual([{ type: "update.download" }]);
    await waitFor(() =>
      expect(screen.getByTestId("update-toast")).toHaveTextContent("正在下载 0.1.18"),
    );
  });
});
