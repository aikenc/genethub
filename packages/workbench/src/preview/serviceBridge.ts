import { useEffect, type RefObject } from "react";
import type { ServicePreviewClient } from "./serviceClient";

const SOURCE = "genehub-service-v1";
/** The frame never receives a Client or a registration credential. Each operation
 * gets an isolated MessagePort; response reads are driven by iframe consumption. */
export function useServiceBridge(
  frame: RefObject<HTMLIFrameElement>,
  service: ServicePreviewClient | null | undefined,
  generation: string | null,
) {
  useEffect(() => {
    if (!service) return;
    const active = new Set<() => void>();
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.source !== SOURCE
      )
        return;
      const port = event.ports[0];
      if (!port) return;
      const data = event.data;
      if (
        active.size >= 10 ||
        typeof data.path !== "string" ||
        !service.allows(data.path, data.kind === "ws")
      ) {
        port.postMessage({
          kind: "error",
          message: "服务路径未授权或并发超限",
        });
        port.close();
        return;
      }
      const controller = new AbortController();
      let ws: {
        close(): void;
        send(value: unknown | Uint8Array): Promise<void>;
      } | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let closed = false;
      let reading = false;
      let acknowledge: (() => void) | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        acknowledge?.();
        acknowledge = null;
        controller.abort();
        void reader?.cancel().catch(() => {});
        ws?.close();
        port.close();
        active.delete(close);
      };
      active.add(close);
      const error = () => {
        if (!closed)
          port.postMessage({
            kind: "error",
            message: "服务连接失败或运行已结束",
          });
        close();
      };
      port.onmessage = (message) => {
        if (closed) return;
        if (message.data?.kind === "cancel") {
          close();
          return;
        }
        if (message.data?.kind === "ack") {
          acknowledge?.();
          acknowledge = null;
          return;
        }
        if (message.data?.kind === "pull" && reader && !reading) {
          reading = true;
          void reader
            .read()
            .then((value) => {
              reading = false;
              if (closed) return;
              if (value.done) {
                port.postMessage({ kind: "end" });
                close();
              } else {
                const bytes = value.value.slice();
                port.postMessage({ kind: "body", bytes: bytes.buffer }, [
                  bytes.buffer,
                ]);
              }
            })
            .catch(error);
        }
        if (message.data?.kind === "send" && ws) {
          const payload =
            message.data.bytes instanceof ArrayBuffer
              ? new Uint8Array(message.data.bytes)
              : { kind: "text", text: String(message.data.text ?? "") };
          void ws
            .send(payload)
            .then(() => {
              if (!closed)
                port.postMessage({ kind: "sent", size: message.data.size });
            })
            .catch(error);
        }
      };
      port.onmessageerror = error;
      port.start();
      void (async () => {
        if (data.kind === "http") {
          if (
            data.bytes &&
            (!(data.bytes instanceof ArrayBuffer) ||
              data.bytes.byteLength > 8 * 1024 * 1024)
          )
            throw new Error("body too large");
          const response = await service.fetch(data.path, {
            method: data.method,
            headers: data.headers,
            body: data.bytes,
            signal: controller.signal,
          });
          if (closed) {
            await response.body?.cancel();
            return;
          }
          const headers: Record<string, string> = {};
          response.headers.forEach((v, k) => (headers[k] = v));
          reader = response.body?.getReader();
          port.postMessage({ kind: "head", status: response.status, headers });
          if (!reader) {
            port.postMessage({ kind: "end" });
            close();
          }
        } else if (data.kind === "ws") {
          ws = await service.websocket(data.path, async (packet) => {
            if (closed) return;
            const bytes = packet.slice();
            await new Promise<void>((resolve) => {
              const timer = setTimeout(close, 30000);
              acknowledge = () => {
                clearTimeout(timer);
                resolve();
              };
              port.postMessage({ kind: "packet", bytes: bytes.buffer }, [
                bytes.buffer,
              ]);
            });
          });
          if (closed) ws.close();
        } else throw new Error("unsupported operation");
      })().catch(error);
    };
    window.addEventListener("message", receive);
    // Notify an already loaded frame; no authority is granted by this notification.
    frame.current?.contentWindow?.postMessage(
      { source: SOURCE, kind: "available" },
      "*",
    );
    return () => {
      window.removeEventListener("message", receive);
      for (const close of active) close();
    };
  }, [frame, service, generation]);
}
/** Injected only into the existing opaque sandbox, after the file fetch shim. */
export function serviceBridgeScript(): string {
  return `(()=>{
const SOURCE=${JSON.stringify(SOURCE)};
const nativeFetch=window.fetch.bind(window), NativeWebSocket=window.WebSocket;
const pathOf=input=>{try{const raw=typeof input==='string'?input:input.url;if(raw.startsWith('/api/'))return raw;const u=new URL(raw,document.baseURI);return u.hostname==='preview.invalid'&&u.pathname.startsWith('/api/')?u.pathname+u.search:null;}catch{return null;}};
function open(data){const c=new MessageChannel();parent.postMessage({...data,source:SOURCE},'*',[c.port2]);c.port1.start();return c.port1;}
window.fetch=async function(input,init={}){
 const path=pathOf(input);if(!path)return nativeFetch(input,init);
 const original=input instanceof Request?new Request(input,init):null;
 const req=original??new Request(new URL(path,'https://preview.invalid'),init);
 const headers={};req.headers.forEach((v,k)=>headers[k]=v);
 const bytes=['GET','HEAD'].includes(req.method)?null:await req.arrayBuffer();
 if(bytes&&bytes.byteLength>8388608)throw new TypeError('上传超过 8 MiB');
 const signal=init.signal||(input instanceof Request?input.signal:null);if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 return new Promise((resolve,reject)=>{
  const port=open({kind:'http',path,method:req.method,headers,bytes});let controller,settled=false;
  const timer=setTimeout(()=>fail(new Error('服务预览尚未启用或没有响应')),15000);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);port.close();};
  const fail=e=>{if(settled)controller?.error(e);else reject(e);cleanup();};
  const abort=()=>{port.postMessage({kind:'cancel'});fail(new DOMException('Aborted','AbortError'));};signal?.addEventListener('abort',abort,{once:true});
  port.onmessage=event=>{const m=event.data;if(m.kind==='head'){
   clearTimeout(timer);const body=new ReadableStream({start(c){controller=c;},pull(){port.postMessage({kind:'pull'});},cancel(){port.postMessage({kind:'cancel'});cleanup();}},{highWaterMark:0});
   settled=true;resolve(new Response(req.method==='HEAD'||[204,205,304].includes(m.status)?null:body,{status:m.status,headers:m.headers}));
  }else if(m.kind==='body')controller.enqueue(new Uint8Array(m.bytes));else if(m.kind==='end'){controller?.close();cleanup();}else if(m.kind==='error')fail(new Error(m.message));};
 });
};
class ServiceSocket extends EventTarget{
 static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
 CONNECTING=0;OPEN=1;CLOSING=2;CLOSED=3;readyState=0;bufferedAmount=0;binaryType='blob';extensions='';protocol='';
 onopen=null;onmessage=null;onerror=null;onclose=null;
 constructor(url,protocols){super();const path=pathOf(String(url));if(!path)return new NativeWebSocket(url,protocols);
  if(protocols&&(Array.isArray(protocols)?protocols.length:true))throw new TypeError('服务桥尚不支持 WS 子协议');this.url=String(url);
  this.port=open({kind:'ws',path});this.timer=setTimeout(()=>this.end(1006,'服务预览尚未启用'),15000);
  this.port.onmessage=e=>{const m=e.data;if(m.kind==='sent'){this.bufferedAmount=Math.max(0,this.bufferedAmount-(Number(m.size)||0));return;}if(m.kind==='error'){this.emit('error',new Event('error'));this.end(1006,m.message);return;}
   if(m.kind!=='packet')return;this.port.postMessage({kind:'ack'});const b=new Uint8Array(m.bytes);if(b[0]===1){this.emit('message',new MessageEvent('message',{data:this.binaryType==='arraybuffer'?b.slice(1).buffer:new Blob([b.slice(1)])}));return;}
   const p=JSON.parse(new TextDecoder().decode(b.slice(1)));if(p.kind==='open'){clearTimeout(this.timer);this.readyState=1;this.emit('open',new Event('open'));}else if(p.kind==='text')this.emit('message',new MessageEvent('message',{data:p.text}));else if(p.kind==='close')this.end(p.code,p.reason);
  };
 }
 emit(kind,event){this.dispatchEvent(event);if(typeof this['on'+kind]==='function')this['on'+kind](event);}
 send(value){if(this.readyState!==1)throw new DOMException('Socket is not open','InvalidStateError');
  if(value instanceof Blob)throw new TypeError('请使用 ArrayBuffer 发送二进制服务消息');
  const bytes=typeof value==='string'?null:value instanceof ArrayBuffer?value:ArrayBuffer.isView(value)?value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength):null;
  if(bytes===null&&typeof value!=='string')throw new TypeError('无效 WS 消息');const size=bytes?bytes.byteLength:new TextEncoder().encode(value).length;
  if(size>200000||this.bufferedAmount+size>1048576)throw new Error('服务 WS 发送缓冲超限');this.bufferedAmount+=size;this.port.postMessage({kind:'send',bytes,text:bytes?null:value,size});
 }
 close(code=1000,reason=''){if(code!==1000)throw new TypeError('服务 WS 仅支持正常主动关闭');if(this.readyState===3)return;this.port.postMessage({kind:'cancel'});this.end(code,reason);}
 end(code,reason){if(this.readyState===3)return;clearTimeout(this.timer);this.readyState=3;this.port.close();this.emit('close',new CloseEvent('close',{code,reason,wasClean:code===1000}));}
}
window.WebSocket=ServiceSocket;
})();`;
}
