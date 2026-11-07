import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineSpecialty, daemonEndpoint, openWorkbenchPage } from "../../framework/public.ts";

for (const busy of [false, true]) defineSpecialty({
  id: `specialty.daemon.workspace-team-remove-${busy ? "busy-atomic" : "directory-readonly"}`,
  title: busy ? "A waiting descendant prevents all team deregistration" : "One team removal preserves disk and directory queries cannot resurrect it",
  oracle: busy ? "A production Agent asking a question causes root remove to fail with every original registration retained" : "One public RPC removes root and nested members, preserves history and files, and shipped directory commands leave removed registrations absent",
  catches: ["per-member partial removal", "waiting member omitted from protection", "read-only team query reopens a removed root", "removal deletes files"],
  tags: ["core", "daemon", "workspace-team-removal"], llm: { default: busy ? "mock" : "none" },
  expectedDurationMs: 15000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0 },
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  surfaces: ["daemon", "team-template"], productInterfaces: ["workspace.remove", "workspace.open", "workspace.list", "agentSpace.configure", "session.create", "tools/run.py directory"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    const source = path.join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template");
    const make = async (name: string, parent?: string) => {
      const root = path.join(t.env.root, "spaces", name);
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "agent-space.genet.json"), JSON.stringify({ schema: "agent-space.v1", name, tags: ["team"], skills: ["team-core"], team: {}, folders: [{path:"."}] }));
      cpSync(path.join(source, "tools"), path.join(root, "tools"), { recursive: true });
      const w = await opened.client.call({type:"workspace.open",payload:{root}});
      if (w?.type !== "workspace") throw new Error("open failed");
      const configured = await opened.client.call({type:"agentSpace.configure",payload:{workspaceId:w.data.id,expectedRevision:w.data.agentSpace?.revision ?? 0,operation: parent ? {kind:"setParent",parentWorkspaceId:parent} : {kind:"setLifecycle",lifecycle:"persistent"}}});
      if (configured?.type !== "workspace") throw new Error("configure failed");
      writeFileSync(path.join(root, "sentinel.txt"), name);
      return {id:w.data.id, root};
    };
    const root = await make("removed-team");
    const child = await make("child", root.id);
    const nested = await make("nested", child.id);
    const survivor = await make("survivor");
    const ids = [root.id, child.id, nested.id];
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sid = await t.flows.main.createBuiltinSession(opened.client, nested.id);
    if (busy) {
      opened.mock.script({tool:{name:"request_user_input",arguments:{questions:[{id:"decision",header:"检查",question:"是否继续？",options:[{label:"继续",description:"继续任务"},{label:"稍后",description:"等待确认"}]}]}}});
      await t.flows.main.sendPrompt(opened.client, sid, "请先确认再继续");
      await t.tools.waitUntil(async () => {
        const x = await opened.client.call({type:"session.get",payload:{sessionId:sid}});
        return x?.type === "snapshot" && x.data.summary.status === "waiting";
      }, 30000);
      let refused = false;
      try { await opened.client.call({type:"workspace.remove",payload:{workspaceId:root.id}}); } catch { refused = true; }
      t.assertions.assert(refused, "busy subtree was removed");
      const listed = await opened.client.call({type:"workspace.list"});
      t.assertions.assert(listed?.type === "workspaces" && ids.every(id => listed.data.some(w=>w.id===id)), "busy rejection partially removed members");
      return;
    }
    const removed = await opened.client.call({type:"workspace.remove",payload:{workspaceId:root.id}});
    t.assertions.assert(removed?.type === "workspaces" && ids.every(id => !removed.data.some(w=>w.id===id)), "single RPC left descendants registered");
    await opened.client.call({type:"workspace.remove",payload:{workspaceId:root.id}});
    const env = {...opened.daemon.env, GENEHUB_CLI:opened.daemon.genet};
    for (const args of [["directory"],["directory","--team","removed-team"]]) {
      await promisify(execFile)(process.env.GENEHUB_PYTHON!,[path.join(root.root,"tools/run.py"),...args],{cwd:root.root,env,timeout:30000,maxBuffer:128*1024});
    }
    const listed = await opened.client.call({type:"workspace.list"});
    t.assertions.assert(listed?.type === "workspaces" && ids.every(id=>!listed.data.some(w=>w.id===id)) && listed.data.some(w=>w.id===survivor.id), "directory query resurrected registrations or removed unrelated project");
    for (const item of [root,child,nested,survivor]) t.assertions.assert(existsSync(path.join(item.root,"sentinel.txt")) && readFileSync(path.join(item.root,"sentinel.txt"),"utf8") !== "", "user files changed");
    const reopened = await opened.client.call({type:"workspace.open",payload:{root:nested.root}});
    t.assertions.assert(reopened?.type === "workspace" && reopened.data.id===nested.id, "explicit reopen lost identity");
    const history = await opened.client.call({type:"session.get",payload:{sessionId:sid}});
    t.assertions.assert(history?.type === "snapshot" && history.data.summary.id===sid, "historical session lost");
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});


defineSpecialty({
  id: "specialty.page-experience.workspace-team-remove",
  title: "Project list confirms and completes a whole-team removal",
  oracle: "A real browser confirmation removes the team card and its descendant registration while user files remain",
  catches: ["project stays in removing state", "UI sends removal to the wrong workspace", "descendant remains registered"],
  tags: ["page-experience", "workspace-team-removal"], runner: "playwright", llm: { default: "mock" },
  expectedDurationMs: 15000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 1, pool: "browser" },
  surfaces: ["workbench-ui", "daemon"], productInterfaces: ["workspace.remove", "project-list confirmation"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  let browser: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({type:"workspace.rename",payload:{workspaceId:opened.workspaceId,name:"cleanup-target"}});
    await opened.client.call({type:"agentSpace.configure",payload:{workspaceId:opened.workspaceId,expectedRevision:0,operation:{kind:"setLifecycle",lifecycle:"persistent"}}});
    const childRoot = path.join(opened.workspaceRoot,"child"); mkdirSync(childRoot);
    writeFileSync(path.join(childRoot,"keep.txt"),"preserved");
    const child = await opened.client.call({type:"workspace.open",payload:{root:childRoot}});
    if (child?.type !== "workspace") throw new Error("child open failed");
    await opened.client.call({type:"agentSpace.configure",payload:{workspaceId:child.data.id,expectedRevision:0,operation:{kind:"setParent",parentWorkspaceId:opened.workspaceId}}});
    const sid = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    browser = await openWorkbenchPage(t.openRoot,()=>daemonEndpoint(opened.daemon),opened.workspaceId,sid,{viewport:{width:1280,height:900}});
    const page = browser.page;
    await page.getByRole("button", {name:"当前项目", exact:true}).waitFor();
    await page.getByRole("navigation",{name:"工作台导航"}).getByRole("button",{name:"项目",exact:true}).click();
    const projects=page.getByRole("complementary",{name:"项目列表面板",exact:true});
    const project=projects.getByRole("region",{name:"项目 cleanup-target",exact:true});
    await project.waitFor();
    await projects.getByRole("button",{name:"批量",exact:true}).click();
    await project.getByRole("checkbox",{name:"选择项目 cleanup-target",exact:true}).check();
    await projects.getByRole("button",{name:"移除",exact:true}).click();
    await page.getByRole("dialog",{name:"移除所选项目",exact:true}).getByRole("button",{name:"确认处理 1 项",exact:true}).click();
    await project.waitFor({state:"detached",timeout:30000});
    const listed = await opened.client.call({type:"workspace.list"});
    t.assertions.assert(listed?.type === "workspaces" && !listed.data.some(w=>[opened.workspaceId,child.data.id].includes(w.id)),"browser removal left part of the team registered");
    t.assertions.assert(readFileSync(path.join(childRoot,"keep.txt"),"utf8")==="preserved","browser removal changed user files");
  } finally { await browser?.close(); opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
