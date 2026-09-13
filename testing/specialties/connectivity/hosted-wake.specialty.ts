import { BlockedError, defineSpecialty, openMultichannelBrowser } from "../../framework/public.ts";

// fb_AD9RqRCbH1u5 / fb_STvjY076r2nl: use real transport loss and the
// browser lifecycle, never replace the client, its clocks or logical owner.
defineSpecialty({
  id: "specialty.connectivity.hosted-wake",
  title: "Hosted browser recovers an expired logical session and resolves list timeouts",
  oracle: "A real timed-out list notice clears only after a successful list read; after a frozen browser loses its logical session, the same Client automatically obtains a new owner and reads the original workspace",
  catches: ["terminal attach loses the next dial", "successful list refresh leaves a stale timeout banner"],
  tags: ["connectivity", "page-experience", "hosted-wake", "network-risk-v2"],
  runner: "playwright", llm: { default: "none" },
  expectedDurationMs: 110000, timeoutMs: 180000,
  resources: { environments: 1, cpu: 2, memoryMb: 1280, io: 1, browser: 1, pool: "browser" },
  surfaces: ["browser", "daemon", "relay", "cloud-server", "workbench-store"],
  productInterfaces: ["@genehub/workbench", "@genehub/workbench/client", "hub-http"],
  requiredArtifacts: ["genehub-host-local", "genehub_guest.wasm"],
}, async t => {
  if (process.platform === "win32") throw new BlockedError("Renderer suspension requires POSIX signals");
  const stack = await openMultichannelBrowser(t, "hosted");
  const cdp = await stack.page.context().browser()!.newBrowserCDPSession();
  let suspended: number[] = [];
  try {
    await stack.page.evaluate(async () => {
      const mc = (window as any).mc;
      mc.store = (await mc.loadWorkbench()).useWorkbench;
      await mc.store.getState().attach(mc.client);
      mc.ownerBefore = mc.client.logicalConnectionId;
    });
    stack.fabric.blackhole("server");
    await stack.page.evaluate(() => (window as any).mc.store.getState().refreshSessions());
    const failed = await stack.page.evaluate(() => {
      const mc = (window as any).mc;
      return { notice: mc.store.getState().notice,
        timeout: mc.operations.some((e: any) => e.operation === "session.list" && e.outcome === "ClientRequestTimeoutError") };
    });
    t.assertions.assert(failed.timeout && !!failed.notice, "real list timeout did not reach the Workbench notice");
    stack.fabric.clearBlackhole();
    await stack.page.evaluate(() => (window as any).mc.store.getState().refreshSessions());
    t.assertions.assert(await stack.page.evaluate(() => (window as any).mc.store.getState().notice === null),
      "successful list read left the stale timeout notice");
    const processes = await cdp.send("SystemInfo.getProcessInfo");
    suspended = processes.processInfo.filter(p => p.type === "renderer").map(p => p.id);
    t.assertions.assert(suspended.length > 0, "no isolated Chromium renderer to suspend");
    for (const pid of suspended) process.kill(pid, "SIGSTOP");
    // OS suspension prevents even WebSocket events from waking JS. Chromium's
    // Page.setWebLifecycleState can thaw immediately on a network event.
    stack.fabric.cut();
    await new Promise(resolve => setTimeout(resolve, 80000));
    for (const pid of suspended) process.kill(pid, "SIGCONT");
    suspended = [];
    await stack.page.waitForFunction(() => {
      const mc = (window as any).mc;
      return mc.client.connectionState === "ready" && mc.client.logicalConnectionId !== mc.ownerBefore;
    }, null, { timeout: 20000 }).catch(async (error: unknown) => {
      const observed = await stack.page.evaluate(() => {
        const mc = (window as any).mc;
        return { before: mc.ownerBefore, current: mc.client.logicalConnectionId,
          state: mc.client.connectionState, states: mc.states, diagnostics: mc.diagnostics };
      });
      throw new Error(`${String(error)}; ${JSON.stringify(observed)}`);
    });
    const restored = await stack.page.evaluate(async () => {
      const mc = (window as any).mc;
      const reply = await mc.client.call({ type: "workspace.list" });
      return { reply, rtc: mc.client.rtcState, states: mc.states };
    });
    t.assertions.assert(restored.rtc === "disabled", "test unexpectedly relied on RTC");
    t.assertions.assert(restored.states.includes("reconnecting"), "browser did not traverse recovery");
    t.assertions.assert(restored.reply?.type === "workspaces" && restored.reply.data.some((w: any) => w.id === stack.opened.workspaceId),
      "new logical owner could not read the original workspace");
    t.note("Real Hosted/Fabric, public Workbench store, opaque TCP blackhole, frozen Chromium, expired logical owner, and automatic fresh admission; RTC disabled throughout.");
  } finally {
    for (const pid of suspended) { try { process.kill(pid, "SIGCONT"); } catch {} }
    await cdp.detach().catch(() => {});
    await stack.stop();
  }
});
