import {afterEach, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
const asset=new FileURL('../../../../apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/client.js',import.meta.url);
const moduleUrl=`data:text/javascript;base64,${Buffer.from(readFileSync(asset)).toString('base64')}`;
const {RemoteDesktopClient}=await import(/* @vite-ignore */ moduleUrl);
afterEach(()=>vi.unstubAllGlobals());
function recordedTransport(preparation:Promise<void>=Promise.resolve()) {
  // External transport recorder only: tests shipped H5 protocol/lifecycle,
  // never claims native WebRTC, daemon, desktop frames or OS input release.
  const sockets:RecordedSocket[]=[];
  class RecordedSocket {
    onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;
    onerror:(()=>void)|null=null;onclose:(()=>void)|null=null;
    sent:string[]=[];
    constructor(){sockets.push(this);}
    send(value:string){this.sent.push(value);}
    close(){this.onclose?.();}
  }
  const peers:RecordedPeer[]=[];
  class RecordedPeer {
    connectionState='new';localDescription={type:'offer',sdp:'recorded-offer'};
    constructor(){peers.push(this);}
    createDataChannel(){return {readyState:'connecting'};}
    addTransceiver(){return {};}
    async createOffer(){await preparation;return this.localDescription;}
    async setLocalDescription(){}
    close(){this.connectionState='closed';}
  }
  vi.stubGlobal('WebSocket',RecordedSocket);
  vi.stubGlobal('RTCPeerConnection',RecordedPeer);
  vi.stubGlobal('RTCRtpReceiver',{getCapabilities:()=>({codecs:[]})});
  vi.stubGlobal('MediaStream',class {addTrack(){}});
  vi.stubGlobal('genehubServicePreview',{
    describe:async()=>({descriptor:{media:{protocol:'remote-desktop/1',sessionPath:'/api/remote/session'}}}),
    ice:async()=>({iceServers:[]}),
  });
  return {sockets,peers};
}
it('answers a repeated one-use challenge only once on its originating socket',async()=>{
  const {sockets}=recordedTransport();
  const client=new RemoteDesktopClient(document.createElement('video'));
  const pending=client.connect().catch(()=>{});
  await vi.waitFor(()=>expect(sockets).toHaveLength(1));
  const socket=sockets[0]!;socket.onopen!();
  const challenge=JSON.stringify({event:'challenge',params:{nonce:'a'.repeat(32)}});
  socket.onmessage!({data:challenge});socket.onmessage!({data:challenge});
  expect(socket.sent.map(value=>JSON.parse(value)).filter(value=>value.method==='renew')).toEqual([
    {method:'renew',params:{nonce:'a'.repeat(32)}},
  ]);
  client.close();await pending;
});
it('does not open source authority while local RTC preparation is pending, including cancellation',async()=>{
  let prepared!:()=>void;
  const preparation=new Promise<void>(resolve=>{prepared=resolve;});
  const {sockets,peers}=recordedTransport(preparation);
  const client=new RemoteDesktopClient(document.createElement('video'));
  const pending=client.connect().catch(()=>{});
  await vi.waitFor(()=>expect(peers).toHaveLength(1));
  expect(sockets).toHaveLength(0);
  client.close();prepared();await pending;
  expect(peers[0]!.connectionState).toBe('closed');
  expect(sockets).toHaveLength(0);
});
it('surfaces source health facts and explains why the source closed the session',async()=>{
  const {sockets}=recordedTransport();
  const client=new RemoteDesktopClient(document.createElement('video'));
  const sources:unknown[]=[];const statuses:string[]=[];
  client.addEventListener('source',(event:Event)=>sources.push((event as CustomEvent).detail));
  client.addEventListener('status',(event:Event)=>statuses.push((event as CustomEvent).detail));
  const pending=client.connect().catch(()=>{});
  await vi.waitFor(()=>expect(sockets).toHaveLength(1));
  const socket=sockets[0]!;socket.onopen!();
  const health={state:'starting',realFrames:0,repeatFrames:3,audio:{state:'unavailable',reason:'no default playback device'}};
  socket.onmessage!({data:JSON.stringify({event:'media.status',params:health})});
  expect(sources).toEqual([health]);
  socket.onmessage!({data:JSON.stringify({event:'session.closed',params:{reason:'target_changed'}})});
  socket.onclose!();
  await pending;
  expect(statuses.at(-1)).toContain('锁定');
});
