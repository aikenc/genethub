import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccessItem, AccessReport } from "@genehub/proto";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { AccessSettings } from "./AccessSettings";

function item(overrides: Partial<AccessItem>): AccessItem {
  return {
    id: "mac.full-disk-access",
    group: "disk",
    label: "完全磁盘访问（推荐）",
    purpose: "不再弹窗",
    state: "denied",
    detail: "未授予。",
    holders: ["/Users/x/.local/bin/genet-beta"],
    action: "settings",
    recommended: true,
    ...overrides,
  };
}

function report(overrides: Partial<AccessReport> = {}): AccessReport {
  return {
    platform: "macos",
    items: [
      item({ id: "mac.code-identity", group: "identity", label: "稳定的程序身份", action: "fix" }),
      item({}),
      item({ id: "mac.folder.desktop", label: "桌面文件夹", state: "notDetermined", action: "prompt", recommended: false }),
      item({ id: "mac.screen-recording", group: "desktop", state: "notApplicable", recommended: false }),
    ],
    checkedAt: "2026-11-09T00:00:00Z",
    ...overrides,
  } as AccessReport;
}

function client(reports: AccessReport[], onRequest = vi.fn()): Client {
  let read = 0;
  return {
    call: vi.fn(async (request: { type: string; payload?: unknown }) => {
      if (request.type === "access.list") return { type: "access", data: reports[Math.min(read++, reports.length - 1)] };
      onRequest(request.payload);
      return {
        type: "accessSetup",
        data: { outcomes: [{ id: "mac.full-disk-access", kind: "needsUser", message: "已打开系统设置" }], report: reports[reports.length - 1] },
      };
    }),
  } as unknown as Client;
}

describe("the system permissions page", () => {
  it("lists what is missing, hides what does not apply and asks for the recommended set in one click", async () => {
    const onRequest = vi.fn();
    render(<AccessSettings client={client([report()], onRequest)} />);
    await screen.findByText("完全磁盘访问（推荐）");
    expect(screen.queryByTestId("access-mac.screen-recording")).toBeNull();
    expect(screen.getByText(/2 项推荐项待处理/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "一键申请推荐项" }));
    await waitFor(() => expect(onRequest).toHaveBeenCalledWith({ ids: null }));
    expect(await screen.findByText("已打开系统设置")).toBeTruthy();
  });

  it("asks for one item at a time for the fine-grained path", async () => {
    const onRequest = vi.fn();
    render(<AccessSettings client={client([report()], onRequest)} />);
    const row = await screen.findByTestId("access-mac.folder.desktop");
    await userEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(onRequest).toHaveBeenCalledWith({ ids: ["mac.folder.desktop"] }));
  });

  it("pauses dialog-producing requests while the Mac is locked", async () => {
    render(<AccessSettings client={client([report({ locked: true })])} />);
    const row = await screen.findByTestId("access-mac.folder.desktop");
    expect((row.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("锁屏");
    // A fix the daemon makes itself needs no dialog, so it stays available.
    const fix = screen.getByTestId("access-mac.code-identity").querySelector("button") as HTMLButtonElement;
    expect(fix.disabled).toBe(false);
  });

  it("shows an administrator command instead of a button", async () => {
    const withCommand = report({
      items: [item({ id: "mac.firewall", group: "network", action: "command", command: "sudo socketfilterfw --add x", recommended: false })],
    });
    render(<AccessSettings client={client([withCommand])} />);
    await screen.findByText(/sudo socketfilterfw/);
    expect(screen.getByTestId("access-mac.firewall").querySelector("button")).toBeNull();
  });
});
