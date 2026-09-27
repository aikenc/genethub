/** Capabilities are supplied only to a Run's pinned package view. The regular
 * RPC/asset APIs retain their normal caller authority; no second backend. */
export const WORKFLOW_BRIDGE_SOURCE = "genehub.workflow.view.v1";

export function workflowBridgeScript(context: unknown, instanceId: string): string {
  const encoded = JSON.stringify(context).replace(/</g, "\\u003c");
  return `(() => {
    const source = ${JSON.stringify(WORKFLOW_BRIDGE_SOURCE)};
    const instanceId = ${JSON.stringify(instanceId)};
    const pending = new Map(); let serial = 0;
    function invoke(kind, payload) {
      const requestId = instanceId + ":" + String(++serial);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('平台请求超时；控制操作请核对结果，勿盲目重试')); }, 30000);
        pending.set(requestId, {resolve, reject, timer});
        parent.postMessage({source, instanceId, requestId, kind, payload}, '*');
      });
    }
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.source !== source || event.data.instanceId !== instanceId || event.data.kind !== 'result') return;
      const item = pending.get(event.data.requestId); if (!item) return;
      clearTimeout(item.timer); pending.delete(event.data.requestId);
      event.data.ok ? item.resolve(event.data.value) : item.reject(new Error(event.data.error));
    });
    addEventListener('pagehide', () => {
      for (const item of pending.values()) {clearTimeout(item.timer);item.reject(new Error('视图已关闭；控制操作请核对结果，勿盲目重试'));}
      pending.clear();
    });
    const context = ${encoded};
    const rpc = (method, payload) => invoke('rpc', {method, payload});
    const fs = {
      readFile: (path, workspaceId = context.workspaceId) => invoke('file', {action:'readFile',path,workspaceId}),
      readdir: (path, workspaceId = context.workspaceId) => invoke('file', {action:'readdir',path,workspaceId}),
      writeFile: (path, content, workspaceId = context.workspaceId) => invoke('file', {action:'writeFile',path,content,workspaceId}),
      mkdir: (path, workspaceId = context.workspaceId) => invoke('file', {action:'mkdir',path,workspaceId}),
      remove: (path, workspaceId = context.workspaceId) => invoke('file', {action:'remove',path,workspaceId})
    };
    const intent = Object.fromEntries(['openSession','openRun','openFile','openView','draftToPM'].map(name => [name, payload => invoke('intent', {name, payload})]));
    window.GenetHub = Object.freeze({context, rpc, fs, intent});
  })();`;
}
