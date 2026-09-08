"""可复制的 Python 接入示例；直接实现登记与认证协议，不需要 Node 或 GeneHub 源码。
运行：python app.py --entry /工作区/index.html --daemon-root /目标数据目录
可选 --video /视频文件：通过原生 WebRTC 预览已有视频，需安装 media-requirements.txt。
将 http_response / websocket 回声分支替换成你的 DCC、引擎或内容程序接口即可。
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import sys
from urllib.parse import unquote, urlsplit
from aiohttp import web, WSMsgType

MAX_PACKET = 256 * 1024
MAX_BODY = 8 * 1024 * 1024


def packet(value):
    return b'\0' + json.dumps(value, separators=(',', ':')).encode()


def sign(secret, value):
    # 密钥使用 64 字符 hex 文本本身作为 UTF-8 HMAC key，不先 hex 解码。
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entry', required=True)
    parser.add_argument('--daemon-root', required=True)
    parser.add_argument('--video', type=Path)
    args = parser.parse_args()
    entry = Path(args.entry).resolve(strict=True)
    if not entry.is_file() or entry.suffix.lower() not in ('.html', '.htm'):
        raise ValueError('entry 必须是工作区中的普通 HTML 文件')
    directory = Path(args.daemon_root).resolve(strict=True) / 'service-previews'
    if directory.is_symlink():
        raise ValueError('登记目录不能是符号链接')
    directory.mkdir(mode=0o700, exist_ok=True)
    if os.name != 'nt':
        directory.chmod(0o700)
    identity = str(entry).replace('\\', '/') if os.name == 'nt' else str(entry)
    record_path = directory / (hashlib.sha256(identity.encode()).hexdigest() + '.json')
    if record_path.exists() or record_path.is_symlink():
        raise ValueError('入口已有登记；先停止旧运行，勿覆盖其记录')
    run_id, secret = secrets.token_hex(16), secrets.token_hex(32)
    stopped = asyncio.Event()
    connections = set()
    media = {}

    async def close_media(sid):
        item = media.pop(sid, None)
        if item:
            pc, player, expiry = item
            if expiry is not asyncio.current_task():
                expiry.cancel()
            for track in (player.audio, player.video):
                if track:
                    track.stop()
            await pc.close()

    async def chunks(value):
        yield json.dumps(value).encode()

    async def http_response(method, path, body):
        # 这里是应用业务边界。不要把任意 URL 作为参数代理到本机或外网。
        if path == '/api/demo/echo':
            async def echo():
                for offset in range(0, len(body), 32768):
                    yield body[offset:offset+32768]
            return 201, {'content-type': 'application/octet-stream'}, echo()
        if path == '/api/demo/stream':
            async def progress():
                for n in range(3):
                    yield f'data: {n}\n\n'.encode()
                    await asyncio.sleep(0.1)
            return 200, {'content-type': 'text/event-stream'}, progress()
        if path in ('/api/demo/health', '/api/demo/status'):
            return 200, {'content-type': 'application/json'}, chunks({'ready': True, 'sessions': len(media)})
        if args.video and method == 'POST' and path == '/api/demo/stop':
            await close_media(json.loads(body)['sessionId'])
            return 200, {}, chunks({'stopped': True})
        if args.video and method == 'POST' and path == '/api/demo/offer':
            from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
            from aiortc.contrib.media import MediaPlayer
            if len(media) >= 4:
                return 429, {}, chunks({'error': '观看人数已满'})
            params = json.loads(body)
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**s) for s in params.get('iceServers', [])]))
            player = MediaPlayer(str(args.video.resolve(strict=True)), loop=True)
            sid = secrets.token_hex(16)
            async def expire():
                await asyncio.sleep(30)
                if pc.connectionState == 'connected':
                    await asyncio.sleep(3570)
                await close_media(sid)
            expiry = asyncio.create_task(expire())
            media[sid] = (pc, player, expiry)
            @pc.on('connectionstatechange')
            async def changed():
                if pc.connectionState in ('failed', 'closed'):
                    await close_media(sid)
            try:
                await pc.setRemoteDescription(RTCSessionDescription(sdp=params['sdp'], type='offer'))
                for track in (player.video, player.audio):
                    if track:
                        pc.addTrack(track)
                await pc.setLocalDescription(await pc.createAnswer())
                return 200, {'content-type': 'application/json'}, chunks({'type': 'answer', 'sdp': pc.localDescription.sdp, 'sessionId': sid})
            except BaseException:
                await close_media(sid)
                raise
        return 404, {}, chunks({'error': '没有登记此应用接口'})

    async def bridge(request):
        if request.headers.get('Origin') or len(connections) >= 32:
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(max_msg_size=MAX_PACKET, compress=False)
        await ws.prepare(request)
        connections.add(ws)
        inbox = asyncio.Queue(maxsize=16)
        ack = asyncio.Event()
        pump = None
        async def raw_receive():
            message = await asyncio.wait_for(ws.receive(), 30)
            if message.type != WSMsgType.BINARY or not message.data:
                raise ValueError('需要二进制协议包')
            return message.data
        async def receive():
            return await asyncio.wait_for(inbox.get(), 30) if pump else await raw_receive()
        async def read_packets():
            owner = asyncio.current_task()
            while True:
                data = await raw_receive()
                if data == b'\2':
                    ack.set()
                else:
                    await asyncio.wait_for(inbox.put(data), 30)
        async def control():
            data = await receive()
            if data[0] != 0:
                raise ValueError('需要控制包')
            return json.loads(data[1:])
        async def deliver(data):
            if len(data) > MAX_PACKET:
                raise ValueError('响应帧过大')
            ack.clear()
            await ws.send_bytes(data)
            await asyncio.wait_for(ack.wait(), 30)
        try:
            async with asyncio.timeout(5):
                nonce = (await control())['nonce']
                if not isinstance(nonce, str) or len(nonce) != 64:
                    raise ValueError('nonce 无效')
                await ws.send_bytes(packet({'proof': sign(secret, f'server:{nonce}:{run_id}')}))
                proof = (await control())['proof']
                if not isinstance(proof, str) or not hmac.compare_digest(proof, sign(secret, f'client:{nonce}:{run_id}')):
                    raise ValueError('认证失败')
                await ws.send_bytes(packet({'kind': 'ready'}))
            pump = asyncio.create_task(read_packets())
            owner = asyncio.current_task()
            def cancel_owner(task):
                if not task.cancelled(): task.exception()
                owner.cancel()
            pump.add_done_callback(cancel_owner)
            async with asyncio.timeout(3600):
                operation = await control()
                if operation.get('kind') == 'shutdown':
                    await ws.send_bytes(packet({'kind': 'stopping'}))
                    stopped.set()
                    return ws
                raw_path = operation.get('path', '')
                url = urlsplit(raw_path)
                path = unquote(url.path)
                if url.scheme or url.netloc or url.fragment or not path.startswith('/api/demo/') or '\\' in path or '%' in path or any(x in ('.', '..') for x in path.split('/')):
                    raise ValueError('路径不在登记范围内')
                if operation['kind'] == 'ws' and path in ('/api/demo/ws', '/api/demo/events'):
                    await deliver(packet({'kind': 'open'}))
                    while True:
                        data = await receive()
                        if data[0] == 1:
                            await deliver(data)
                        elif data[0] == 0:
                            item = json.loads(data[1:])
                            if item.get('kind') == 'close':
                                await deliver(packet({'kind': 'close', 'code': 1000, 'reason': ''}))
                                break
                            if item.get('kind') != 'text':
                                raise ValueError('WS 类型无效')
                            await deliver(packet(item))
                        else:
                            raise ValueError('WS 包无效')
                elif operation['kind'] == 'http':
                    if operation['method'] not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
                        raise ValueError('HTTP 方法无效')
                    body = bytearray()
                    while True:
                        data = await receive()
                        if data[0] == 0 and json.loads(data[1:]).get('kind') == 'end':
                            break
                        if data[0] != 1 or len(body) + len(data) - 1 > MAX_BODY:
                            raise ValueError('请求体无效或过大')
                        body.extend(data[1:])
                    status, headers, response = await http_response(operation['method'], path, body)
                    await deliver(packet({'kind': 'head', 'status': status, 'headers': headers}))
                    async for data in response:
                        await deliver(b'\1' + data)
                    await deliver(packet({'kind': 'end'}))
                else:
                    raise ValueError('操作未支持')
        except (ValueError, KeyError, asyncio.TimeoutError, json.JSONDecodeError):
            # 失败关闭，不记录私有凭证、SDP 或业务请求。
            pass
        finally:
            connections.discard(ws)
            if pump:
                pump.remove_done_callback(cancel_owner)
                pump.cancel()
            await ws.close()
        return ws

    app = web.Application()
    app.router.add_get('/', bridge)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = runner.addresses[0][1]
    record = {'version': 1, 'entry': str(entry), 'pid': os.getpid(), 'control': True,
              'runId': run_id, 'secret': secret, 'port': port, 'name': '内容过程预览（Python 示例）',
              'routes': [{'prefix': '/api/demo/', 'websocket': True}], 'media': None, 'iceServers': [], 'dataPolicy': 'auto'}
    if args.video:
        record['media'] = {'offerPath': '/api/demo/offer', 'stopPath': '/api/demo/stop', 'microphone': 'none'}
    temporary = record_path.with_suffix('.' + run_id)
    registered = False
    try:
        with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
            json.dump(record, f)
        os.link(temporary, record_path)  # 原子发布，拒绝覆盖另一次运行。
        registered = True
        temporary.unlink()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stopped.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stopped.set))
        print('已登记，请在 GeneHub 后台运行中刷新并打开预览。', flush=True)
        await stopped.wait()
    finally:
        for sid in list(media):
            await close_media(sid)
        await asyncio.gather(*(ws.close() for ws in list(connections)))
        await runner.cleanup()
        if registered and record_path.exists() and json.loads(record_path.read_text())['runId'] == run_id:
            record_path.unlink()
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    asyncio.run(main())
