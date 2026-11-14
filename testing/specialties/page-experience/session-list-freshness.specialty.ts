import { defineSpecialty, daemonEndpoint, openWorkbenchPage, startSharedBottleneck } from "../../framework/public.ts";

type ReadObservation = {at:number; operation?:string; phase?:string; outcome?:string; snapshot?:boolean; complete?:boolean};
declare global { interface Window { freshnessEvidence: ReadObservation[] } }

defineSpecialty({
  id: "specialty.page-experience.session-list-freshness",
  title: "A real slow catalog cannot erase a known Human request and one live conversation can recover independently",
  oracle: "An opaque constrained link delays a thousand-session catalog past its real deadline. The real page retains the last confirmed Human request with a visible observation label, receives that conversation's later completion, and clears the list error after transport recovery.",
  catches: ["global list error replaces every row with unknown", "stale facts pretend to be live", "one live session cannot recover until full list succeeds", "mobile hides the failure explanation"],
  tags: ["page-experience", "session-catalog", "team-urgent-recovery"], runner: "playwright", llm: { default: "mock" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon", "tcp"], productInterfaces: ["@genehub/workbench", "catalog.sync", "session.page", "session.respondPermission", "session.send"],
  expectedDurationMs: 90000, timeoutMs: 240000,
}, async t => {
  const o = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  let link: Awaited<ReturnType<typeof startSharedBottleneck>> | undefined;
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    o.mock.script({ tool: { name: "request_user_input", arguments: { questions: [{ id: "accept", header: "范围", question: "确认本次验收", options: [{ label: "继续", description: "继续本次工作" }, { label: "结束", description: "保留结果" }] }] } } }, { text: "ACTUAL_RECOVERY_COMPLETE", repeat: 4 });
    const target = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    await o.client.call({ type: "session.rename", payload: { sessionId: target, title: "真实待办必须保留" } });
    const background:string[]=[];
    for (let n = 0; n < 50; n++) background.push(...await Promise.all(Array.from({ length: 20 }, () => t.flows.main.createBuiltinSession(o.client, o.workspaceId))));
    await t.flows.main.sendPrompt(o.client, target, "请确认本次工作范围");
    await t.tools.waitUntil(async () => { const r = await o.client.call({ type: "session.get", payload: { sessionId: target } }); return r?.type === "snapshot" && r.data.summary.interactionSummary?.count === 1; }, 15000);
    link = await startSharedBottleneck(daemonEndpoint(o.daemon).url, { bandwidthMbps: 100, rttMs: 0 });
    browser = await openWorkbenchPage(t.openRoot, () => {
      const control = daemonEndpoint(o.daemon), body = daemonEndpoint(o.daemon);
      // Real independent admissions, as the production Host supplies. Only
      // the catalog/control carrier is shaped; body events stay observable.
      return { ...control, url: link!.urlFor(control.url), bulk: body };
    }, o.workspaceId, target, { viewport: { width: 1280, height: 900 } }, { trace: false,
      beforeNavigate: async page => { await page.addInitScript(() => {
        window.freshnessEvidence = [];
        window.addEventListener("genehub:client-diagnostic", event => {
          const e=(event as CustomEvent).detail;
          if (e?.kind === "operation" && window.freshnessEvidence.length < 2000) {
            const d=e.detail; window.freshnessEvidence.push({at:Date.now(),operation:d.operation,phase:d.phase,outcome:d.outcome,snapshot:d.snapshot,complete:d.complete});
          }
        });
      }); },
    });
    const page = browser.page;
    await page.getByRole("group", { name: "确认本次验收", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    const row = page.getByRole("complementary", { name: "会话列表", exact: true }).locator(".conversation-row").filter({ hasText: "真实待办必须保留" });
    await row.getByRole("img", { name: /待你处理/ }).waitFor();
    // Incremental subscriptions do not periodically reread the old whole list.
    // Change actual metadata so conditional synchronization has real bytes to
    // transfer. The original 20kbps carrier still makes authenticated progress;
    // a nearly idle, unchanged snapshot is not a slow-read failure precondition.
    const failedAfter=Date.now();
    link.setProfile({ bandwidthMbps: 0.02, rttMs: 0 });
    for(let offset=0;offset<background.length;offset+=20) await Promise.all(background.slice(offset,offset+20).map((id,i)=>
      o.client.call({type:"session.rename",payload:{sessionId:id,title:`Background ${offset+i} ${"catalog-change-".repeat(8)}`}})));
    t.note(JSON.stringify({phase:"real-background-metadata-change",changedSessions:background.length,bandwidthMbps:0.02}));
    const pane=page.getByRole("complementary",{name:"会话列表",exact:true});
    await pane.getByRole("button",{name:"列表选项",exact:true}).click();
    await pane.getByRole("menuitem",{name:"刷新列表",exact:true}).click();
    await page.waitForFunction(mark => window.freshnessEvidence.some(e=>e.at>=mark &&
      e.operation === "catalog.sync" && e.phase === "finish" &&
      e.outcome === "ClientRequestTimeoutError"), failedAfter, {timeout:100000});
    // The source can begin a retry before its transient error caption is read.
    // Its public operation diagnostic proves the actual deadline independently
    // of that caption; the page must still disclose its cached observation.
    const navigation=page.getByRole("navigation",{name:"工作台导航",exact:true});
    t.note(JSON.stringify({phase:"actual-directory-timeout",reads:await page.evaluate(mark=>window.freshnessEvidence.filter(e=>e.at>=mark).slice(-12),failedAfter)}));
    const staleSource=pane.getByRole("status").filter({hasText:/上次状态/});
    await staleSource.first().waitFor();
    await row.getByRole("img", { name: /上次确认.*待你处理/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    t.assertions.assert(await staleSource.first().isVisible() &&
      await row.getByRole("img",{name:/上次确认.*待你处理/}).isVisible(),
      "mobile concealed the last known real request or its source observation label");
    // A second authenticated consumer answers while this page's catalog is
    // delayed, matching a live row update independent of a list refresh.
    // This does not claim that a UI command crosses a 20kbps saturated link.
    const current = await o.client.call({ type: "session.get", payload: { sessionId: target } });
    if (current?.type !== "snapshot" || !current.data.pendingPermissions[0]) throw Error("real question missing");
    const request = current.data.pendingPermissions[0];
    await o.client.call({ type: "session.respondPermission", payload: { sessionId: target, requestId: request.id,
      outcome: { outcome: "answered", answers: (request.questions ?? []).map(q => ({ questionId: q.id, selectedOptionIds: q.options[0] ? [q.options[0].id] : [] })) } } });
    await row.getByRole("button").first().click();
    await page.getByText("ACTUAL_RECOVERY_COMPLETE", { exact: true }).first().waitFor({ timeout: 30000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "会话", exact: true }).click();
    await row.waitFor();
    let completed=await o.client.call({type:"session.get",payload:{sessionId:target}});
    await t.tools.waitUntil(async()=>{
      if(completed?.type === "snapshot" && completed.data.summary.status === "idle" &&
        (completed.data.summary.interactionSummary?.count ?? 0) === 0) return true;
      completed=await o.client.call({type:"session.get",payload:{sessionId:target}}); return false;
    },15000);
    t.note(JSON.stringify({phase:"independent-body-recovered",native:completed?.type === "snapshot" ?
      {status:completed.data.summary.status,pending:completed.data.summary.interactionSummary?.count ?? 0}:null,
      row:await row.innerText(),icons:await row.getByRole("img").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("aria-label"))),
      sourceStillCached:await staleSource.count()>0}));
    await t.tools.waitUntil(async () => await row.getByRole("img",{name:/上次确认/}).count() === 0, 15000);
    t.assertions.assert(await staleSource.count() > 0, "independent row was only checked after full catalog recovery");
    const unobserved=pane.locator(".conversation-row").filter({hasNotText:"真实待办必须保留"});
    const otherRows=await unobserved.count();
    t.assertions.assert(otherRows>0 && await unobserved.getByRole("img",{name:/上次确认/}).count()===otherRows,
      "observing one body falsely confirmed another conversation's cached status");
    await page.getByRole("button",{name:"当前项目",exact:true}).click();
    const project=page.getByRole("region",{name:"项目页面",exact:true});
    const projectRow=project.locator(".conversation-row").filter({hasText:"真实待办必须保留"});
    await projectRow.waitFor();
    t.assertions.assert(await projectRow.getByRole("img",{name:/待你处理/}).count()===0,
      "cached project history overrode the independently completed body with its old activity row");
    await navigation.getByRole("button",{name:"会话",exact:true}).click();
    t.assertions.assert(await staleSource.count()>0,"opening project history falsely confirmed the whole failed source");
    link.setProfile({ bandwidthMbps: 100, rttMs: 0 });
    await t.tools.waitUntil(async () => await staleSource.count() === 0, 30000);
    t.assertions.assert(await row.getByRole("img", { name: /待你处理/ }).count() === 0, "answered Human request remained pending after catalog recovery");
    t.note(JSON.stringify({ actualSessions: 1001, transportFault: "opaque shared bottleneck", staleRequestVisible: true, independentlyObservedRows:1, otherVisibleRowsStillStale:otherRows, viewport: "390x844", recovered: true }));
  } catch (error) {
    if (browser) t.note(JSON.stringify({phase:"failure",reads:await browser.page.evaluate(()=>window.freshnessEvidence?.slice(-16) ?? []),
      statuses:(await browser.page.getByRole("status").allTextContents()).map(s=>s.slice(0,160)).slice(-6),
      targetRow:(await browser.page.locator(".conversation-row").filter({hasText:"真实待办必须保留"}).allTextContents()).map(s=>s.slice(0,300))}));
    throw error;
  } finally { await browser?.close(); await link?.stop(); o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
