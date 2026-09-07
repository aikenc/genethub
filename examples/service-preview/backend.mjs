/** Small real HTTP/WS service for exercising the service bridge without a model. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(new URL('../../packages/service-preview/package.json', import.meta.url))('ws');
const port=Number(process.env.PREVIEW_DEMO_PORT??18010);
const server=createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ready');return;}
  if(req.url==='/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,pid:process.pid}));return;}
  if(req.url?.startsWith('/echo')){res.statusCode=201;res.setHeader('content-type',req.headers['content-type']??'application/octet-stream');req.pipe(res);return;}
  if(req.url==='/stream'){res.setHeader('content-type','text/event-stream');let n=0;const tick=setInterval(()=>{res.write(`data: ${++n}\n\n`);if(n===5){clearInterval(tick);res.end();}},100);res.on('close',()=>clearInterval(tick));return;}
  res.writeHead(404);res.end('not found');
});
const ws=new WebSocketServer({server,maxPayload:256*1024,perMessageDeflate:false});
ws.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
server.listen(port,'127.0.0.1');
