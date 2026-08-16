import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "../host";
import { useWorkbench } from "../session/store";
import { Pairing } from "./Pairing";

afterEach(() => {
  useWorkbench.setState({ hub: null, notice: null });
});

function host(overrides: Partial<Host> = {}): Host {
  return {
    kind: "browser",
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

  const PAIRING = {
    state: "pairing",
    hubUrl: "https://hub.example.com",
    userCode: "VCL9-47CG",
    verificationUri: "https://hub.example.com/activate",
    verificationUriComplete: "https://hub.example.com/activate?code=VCL9-47CG",
    expiresAt: "2026-01-01T00:00:00Z",
  } as const;

  it("opens the authorization page as an ordinary browser link", async () => {
    const openExternal = vi.fn();
    render(
      <Pairing
        status={PAIRING}
        host={host({ openExternal })}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );

    expect(screen.getByTestId("user-code")).toHaveTextContent("VCL9-47CG");
    await userEvent.click(screen.getByText("打开授权页面"));

    expect(openExternal).toHaveBeenCalledWith("https://hub.example.com/activate?code=VCL9-47CG");
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
    expect(screen.getByText(/同机 loopback 仍可用；跨设备需要 Relay/)).toBeInTheDocument();
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

  /**
   * The whole point of the rework: a build that knows its Hub connects with one
   * press, inside this window. No address to type, no code to read out, and —
   * the part that made this feel like someone else's software — no browser
   * opening on top of the app the user just installed.
   */
  it("connects in one press, without a window or a code, where the Hub is known", async () => {
    const onTrial = vi.fn(async () => null);
    const openExternal = vi.fn();
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host({ openExternal })}
        defaultHubUrl="https://relay.example.com"
        onPair={async () => {}}
        onTrial={onTrial}
        onUnpair={async () => {}}
      />,
    );

    await userEvent.click(screen.getByTestId("connect-hub"));
    expect(onTrial).toHaveBeenCalledWith("https://relay.example.com");
    expect(openExternal).not.toHaveBeenCalled();
  });

  /**
   * The other half of that press. Someone installing on their second computer
   * already has an account, and the way back to it used to be behind a fold
   * labelled "连到自己的 Hub" — the wrong sentence entirely for them. Their
   * remaining option was to start over as a new stranger with a new identity.
   */
  it("offers an existing identity beside the one-press path, not underneath it", async () => {
    const onPair = vi.fn(async () => {});
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        defaultHubUrl="https://relay.example.com"
        onPair={onPair}
        onTrial={async () => null}
        onUnpair={async () => {}}
      />,
    );

    await userEvent.click(screen.getByTestId("pair-hub"));
    // The same Hub this build knows, so nobody has to know its address to sign
    // in to it.
    expect(onPair).toHaveBeenCalledWith("https://relay.example.com");
  });

  /// Folded away, not taken away. Someone running their own Hub is a real user,
  /// and the address box being first is what made connecting look like homework.
  it("keeps the pairing code for a Hub of one's own, one click further in", async () => {
    const onPair = vi.fn(async () => {});
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        defaultHubUrl="https://relay.example.com"
        onPair={onPair}
        onTrial={async () => null}
        onUnpair={async () => {}}
      />,
    );

    expect(screen.queryByLabelText("Hub 地址")).toBeNull();
    await userEvent.click(screen.getByTestId("custom-hub"));

    await userEvent.clear(screen.getByLabelText("Hub 地址"));
    await userEvent.type(screen.getByLabelText("Hub 地址"), "https://hub.mine.test");
    await userEvent.click(screen.getByText("获取配对码"));
    expect(onPair).toHaveBeenCalledWith("https://hub.mine.test");
  });

  /**
   * A build of this repository alone knows no Hub to suggest. Offering "连接"
   * there would be a button with nowhere to go, so the address box is the first
   * thing instead — which is the right first thing for exactly that build.
   */
  it("asks for an address when this build knows no Hub", () => {
    render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        onPair={async () => {}}
        onTrial={async () => null}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.queryByTestId("connect-hub")).toBeNull();
    expect(screen.getByLabelText("Hub 地址")).toBeInTheDocument();
  });

  it("offers the no-approval path only where the deployment supports it", async () => {
    const onTrial = vi.fn(async () => null);
    const { rerender } = render(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.queryByText(/先体验/)).not.toBeInTheDocument();

    rerender(
      <Pairing
        status={{ state: "unpaired" }}
        host={host()}
        onPair={async () => {}}
        onTrial={onTrial}
        onUnpair={async () => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText("Hub 地址"), "https://hub.example.com");
    await userEvent.click(screen.getByText(/先体验/));
    expect(onTrial).toHaveBeenCalledWith("https://hub.example.com");
  });

  it("shows the recovery key with the link, and only when there is one", () => {
    const paired = {
      state: "paired",
      hubUrl: "https://hub.example.com",
      machineId: "m_1",
      online: true,
    } as const;

    const { rerender } = render(
      <Pairing
        status={paired}
        claim={{
          claimUrl: "https://hub.example.com/link/abc",
          recoveryKey: "rk-1",
          expiresAt: "2030-01-01T00:00:00Z",
        }}
        host={host()}
        onPair={async () => {}}
        onClaimLink={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.getByText("https://hub.example.com/link/abc")).toBeInTheDocument();
    expect(screen.getByText("rk-1")).toBeInTheDocument();

    // Minting another link for an identity that already exists re-issues
    // nothing, and pretending otherwise would teach people to ignore it.
    rerender(
      <Pairing
        status={paired}
        claim={{
          claimUrl: "https://hub.example.com/link/def",
          expiresAt: "2030-01-01T00:00:00Z",
        }}
        host={host()}
        onPair={async () => {}}
        onClaimLink={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    expect(screen.queryByText(/恢复密钥/)).not.toBeInTheDocument();
  });

  it("keeps a normal browser action beside the claim link", async () => {
    const openExternal = vi.fn();
    const claim = {
      claimUrl: "https://hub.example.com/link/abc",
      expiresAt: "2030-01-01T00:00:00Z",
    };
    const paired = {
      state: "paired",
      hubUrl: "https://hub.example.com",
      machineId: "m_1",
      online: true,
    } as const;

    render(
      <Pairing
        status={paired}
        claim={claim}
        host={host({ openExternal })}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );
    await userEvent.click(screen.getByText("在浏览器里打开"));
    expect(openExternal).toHaveBeenCalledWith(claim.claimUrl);
  });

  it("opens the account carrying this machine's identity, not as a stranger", async () => {
    // The whole point of going through a claim link. Opening `/account`
    // directly would arrive signed out, and anything done there — signing in,
    // binding — would attach to an identity that owns none of these machines.
    const openExternal = vi.fn();
    const claimLink = vi.fn(async () => ({
      claimUrl: "https://hub.example.com/link/abc",
      expiresAt: "2030-01-01T00:00:00Z",
    }));
    useWorkbench.setState({
      hub: { state: "paired", hubUrl: "https://hub.example.com", machineId: "m_1", online: true },
      claimLink,
    });

    render(
      <Pairing
        status={{
          state: "paired",
          hubUrl: "https://hub.example.com",
          machineId: "m_1",
          online: true,
        }}
        host={host({ openExternal })}
        onPair={async () => {}}
        onUnpair={async () => {}}
      />,
    );

    await userEvent.click(screen.getByText("打开我的账户"));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://hub.example.com/link/abc?next=%2Faccount",
      ),
    );
    // The account is ordinary Web; no native window bridge is involved.
  });

  it("says so rather than opening nothing when there is no Hub", async () => {
    useWorkbench.setState({ hub: { state: "unpaired" } });
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
        onUnpair={async () => {}}
      />,
    );

    await userEvent.click(screen.getByText("打开我的账户"));
    await waitFor(() => expect(useWorkbench.getState().notice).toMatch(/还没有连到 Hub/));
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
