import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Host } from "../host";
import { Pairing } from "./Pairing";

function host(overrides: Partial<Host> = {}): Host {
  return {
    kind: "desktop",
    endpoint: async () => null,
    notify: () => {},
    openExternal: () => {},
    ...overrides,
  };
}

describe("connecting a machine to a Hub", () => {
  it("explains that a Hub is optional before asking for one", () => {
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByText(/不连接也不影响本机使用/)).toBeInTheDocument();
    expect(screen.getByLabelText("Hub 地址")).toBeInTheDocument();
  });

  it("will not send an empty address", async () => {
    const onPair = vi.fn(async () => {});
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        onPair={onPair}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByText("获取配对码")).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Hub 地址"), "https://hub.example.com");
    await userEvent.click(screen.getByText("获取配对码"));
    expect(onPair).toHaveBeenCalledWith("https://hub.example.com");
  });

  it("puts the code on screen and sends the user to the real browser to approve it", async () => {
    const openExternal = vi.fn();
    render(
      <Pairing
        status={{
          state: "pairing",
          hubUrl: "https://hub.example.com",
          userCode: "VCL9-47CG",
          verificationUri: "https://hub.example.com/activate",
          verificationUriComplete: "https://hub.example.com/activate?code=VCL9-47CG",
          expiresAt: "2026-01-01T00:00:00Z",
        }}
        host={host({ openExternal })}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );

    expect(screen.getByTestId("user-code")).toHaveTextContent("VCL9-47CG");
    await userEvent.click(screen.getByText("打开授权页面"));
    // Opening it inside this window would be a second, signed-out browser.
    expect(openExternal).toHaveBeenCalledWith(
      "https://hub.example.com/activate?code=VCL9-47CG",
    );
  });

  it("tells the difference between not paired and paired but unreachable", () => {
    const { rerender } = render(
      <Pairing
        status={{
          state: "paired",
          hubUrl: "https://hub.example.com",
          machineId: "m_1",
          online: true,
        }}
        host={host()}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByText(/远程可达/)).toBeInTheDocument();

    rerender(
      <Pairing
        status={{
          state: "paired",
          hubUrl: "https://hub.example.com",
          machineId: "m_1",
          online: false,
        }}
        host={host()}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByText(/本机和局域网仍然可用/)).toBeInTheDocument();
  });

  it("keeps a failure on screen with the reason, rather than reverting silently", () => {
    render(
      <Pairing
        status={{ state: "failed", hubUrl: "https://hub.example.com", message: "配对码已过期" }}
        host={host()}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("配对码已过期");
    // And offers the retry with the address already filled in.
    expect(screen.getByLabelText("Hub 地址")).toHaveValue("https://hub.example.com");
  });

  it("lets the owner disconnect", async () => {
    const onUnpair = vi.fn(async () => {});
    render(
      <Pairing
        status={{
          state: "paired",
          hubUrl: "https://hub.example.com",
          machineId: "m_1",
          online: true,
        }}
        host={host()}
        onPair={async () => {}}
        onUnpair={onUnpair}
      />,
    );
    await userEvent.click(screen.getByText("断开连接"));
    expect(onUnpair).toHaveBeenCalled();
  });
});
