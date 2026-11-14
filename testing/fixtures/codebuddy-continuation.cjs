#!/usr/bin/env node
// External CodeBuddy stream-json boundary only. No daemon/SDK code is replaced.
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.GENEHUB_CBC_CONTINUATION, 'utf8'));
const record = (event, extra = {}) => fs.appendFileSync(config.journal,
  JSON.stringify({ event, at: Date.now(), pid: process.pid, ...extra }) + '\n');
const out = frame => process.stdout.write(JSON.stringify(frame) + '\n');
if (args.includes('--version')) { console.log('2.160.0'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--permission-mode choices: "default", "bypassPermissions", "plan"'); process.exit(0);
}
const resumed = args.includes('--resume');
record('launch', { resumed, resumeId: resumed ? args[args.indexOf('--resume') + 1] : null });
let timer;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const subtype = frame.request.subtype;
    record('control', { subtype });
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
      response: { models: [{ id: 'hy4std', name: 'HY' }], account: { tokenSource: 'oauth' } } } });
    if (subtype === 'interrupt') {
      clearTimeout(timer);
      // Real vendor trace: an interrupted CLI can return a successful result
      // envelope. The native Stop remains authoritative over that envelope.
      if (config.interruptSuccess) {
        out({ type: 'assistant', message: { role: 'assistant', model: 'hy4std',
          content: [{ type: 'text', text: 'Interrupted by user' }] } });
        out({ type: 'result', subtype: 'success', is_error: false });
      } else out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Interrupted'] });
      setTimeout(() => process.exit(0), 20);
    }
    return;
  }
  if (frame.type !== 'user') return;
  record('user');
  if (config.silent) return;
  timer = setTimeout(() => {
    record('answer');
    out({ type: 'system', subtype: 'init', session_id: 'preserved-provider-context' });
    out({ type: 'assistant', message: { id: 'reply-' + process.pid, role: 'assistant', model: 'hy4std',
      content: [{ type: 'text', text: resumed ? 'CONTINUATION_COMPLETED' : 'INITIAL_COMPLETED' }] } });
    out({ type: 'result', subtype: 'success', is_error: false });
    setTimeout(() => process.exit(0), 20);
  }, resumed ? 95_000 : 0);
});
