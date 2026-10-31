"""Run one or more local backends and register them as a Service Preview.

    python run.py --config application.json --daemon-root <dataDir>

The configuration is the same `application.json` shape the Node example uses:
`entry`, optional `media`, and `backends[]` of {command, cwd, env, origin, health, routes}.
A backend without `origin` is only started, watched and stopped (a game process that talks
to another backend). A WebSocket route may set `maxViewers` (1-16): further viewers are
closed with 1013 `viewer_limit`. Any backend exit retires the whole run; the process tree
of every backend is stopped with the runner.
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web, WSMsgType

MAX_PACKET = 256 * 1024
MAX_BODY = 8 * 1024 * 1024
METHODS = ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')
REQUEST_HEADERS = {'accept', 'content-type', 'range', 'if-none-match', 'last-event-id'}
RESPONSE_HEADERS = {'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control'}


def packet(value):
    return b'\0' + json.dumps(value, separators=(',', ':')).encode()


def sign(secret, value):
    # The 64-character hex secret is the UTF-8 HMAC key itself, not hex-decoded.
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def local_base(raw):
    url = urlsplit(raw)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment or not url.port):
        raise ValueError('backend must be an http://127.0.0.1:port origin')
    return f'http://127.0.0.1:{url.port}'


def kill_tree(proc, force=False):
    if proc.returncode is not None:
        return
    try:
        if os.name == 'nt':
            taskkill = Path(os.environ.get('SystemRoot', 'C:\\Windows')) / 'System32' / 'taskkill.exe'
            subprocess.run([str(taskkill), '/PID', str(proc.pid), '/T', '/F'], capture_output=True, timeout=5)
        else:
            os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        pass


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', required=True)
    parser.add_argument('--daemon-root', required=True)
    args = parser.parse_args()
    config_path = Path(args.config).resolve(strict=True)
    spec = json.loads(config_path.read_text(encoding='utf-8'))
    entry = (config_path.parent / spec['entry']).resolve(strict=True)
    if entry.suffix.lower() not in ('.html', '.htm'):
        raise ValueError('entry must be an HTML file')
    data_policy = spec.get('dataPolicy', 'auto')
    if data_policy not in ('auto', 'direct-only'):
        raise ValueError('invalid dataPolicy')
    backends = spec.get('backends')
    if not isinstance(backends, list) or not 1 <= len(backends) <= 8:
        raise ValueError('1-8 backends required')

    registry = Path(args.daemon_root).resolve(strict=True) / 'service-previews'
    if registry.is_symlink():
        raise ValueError('registry cannot be a symlink')
    registry.mkdir(mode=0o700, exist_ok=True)
    identity = str(entry).replace('\\', '/') if os.name == 'nt' else str(entry)
    record_path = registry / (hashlib.sha256(identity.encode()).hexdigest() + '.json')
    if record_path.exists() or record_path.is_symlink():
        raise ValueError('entry already registered; stop its runner or remove the stale record explicitly')
    run_id, secret = secrets.token_hex(16), secrets.token_hex(32)

    routes = []
    for backend in backends:
        base = local_base(backend['origin']) if backend.get('origin') else None
        command = backend.get('command')
        if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
            raise ValueError('backend command must be argv')
        if backend.get('routes') and not base:
            raise ValueError('backend routes require an origin')
        for route in backend.get('routes', []):
            prefix = route.get('prefix', '')
            if not re.fullmatch(r'/api/[a-z0-9/-]+/', prefix) or any(r['prefix'] == prefix for r in routes):
                raise ValueError('unique /api/.../ prefixes ending in / required')
            viewers = route.get('maxViewers', 0)
            if isinstance(viewers, bool) or not isinstance(viewers, int) or not 0 <= viewers <= 16:
                raise ValueError('maxViewers must be an integer from 1 to 16')
            routes.append({'prefix': prefix, 'base': base, 'websocket': route.get('websocket') is True,
                           'maxViewers': viewers, 'viewers': 0})

    stopped = asyncio.Event()
    exit_code = 0
    children = []
    connections = set()

    def retire(code=0):
        nonlocal exit_code
        if not stopped.is_set():
            exit_code = code
            stopped.set()

    def safe_path(raw):
        if not isinstance(raw, str) or len(raw) > 4096 or not raw.startswith('/api/') or re.search(r'[\\\r\n#]', raw):
            raise ValueError('invalid service path')
        path = raw.split('?')[0]
        if re.search(r'%(?:2f|5c|2e|00)', path, re.I) or any(x in ('.', '..') for x in path.split('/')):
            raise ValueError('invalid path encoding')
        candidates = [r for r in routes if path.startswith(r['prefix'])]
        if not candidates:
            raise ValueError('route not registered')
        route = max(candidates, key=lambda r: len(r['prefix']))
        url = route['base'] + '/' + raw[len(route['prefix']):]
        if urlsplit(url).netloc != urlsplit(route['base']).netloc:
            raise ValueError('route escaped origin')
        return route, url

    media = spec.get('media')
    if media:
        safe_path(media['offerPath'])
        if media.get('stopPath'):
            safe_path(media['stopPath'])
        if media.get('microphone', 'none') not in ('webrtc', 'none'):
            raise ValueError('microphone must be webrtc or none')

    async def watch(proc):
        await proc.wait()
        print('Service Preview stopped: a backend exited', file=sys.stderr, flush=True)
        retire(1)

    watchers = []
    registered = False
    temporary = record_path.with_suffix('.' + run_id)
    session = aiohttp.ClientSession(auto_decompress=False)
    runner = None
    try:
        # Refuse an already occupied origin before launching anything.
        for backend in (b for b in backends if b.get('origin')):
            with socket.socket() as probe:
                try:
                    probe.bind(('127.0.0.1', urlsplit(local_base(backend['origin'])).port))
                except OSError as error:
                    raise ValueError(f"backend port {backend['origin']} is already in use") from error
        for backend in backends:
            proc = await asyncio.create_subprocess_exec(
                *backend['command'], cwd=str((config_path.parent / backend.get('cwd', '.')).resolve()),
                env={**os.environ, **backend.get('env', {})}, stdin=subprocess.DEVNULL,
                start_new_session=os.name != 'nt',
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0)
            children.append(proc)
            watchers.append(asyncio.create_task(watch(proc)))

        # Readiness is separate from process existence. A redirect is never followed.
        deadline = asyncio.get_running_loop().time() + min(spec.get('readyTimeoutMs', 120000), 300000) / 1000
        for backend in (b for b in backends if b.get('origin')):
            base = local_base(backend['origin'])
            health = base + '/' + backend.get('health', '/').lstrip('/')
            while not stopped.is_set():
                try:
                    async with session.get(health, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=2)) as r:
                        if r.status < 300:
                            break
                except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
                    pass
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError('backend readiness timed out')
                await asyncio.sleep(0.25)
        if stopped.is_set():
            return

        async def bridge(request):
            if request.headers.get('Origin') or len(connections) >= 32:
                raise web.HTTPForbidden()
            ws = web.WebSocketResponse(max_msg_size=MAX_PACKET, compress=False)
            await ws.prepare(request)
            connections.add(ws)
            inbox = asyncio.Queue(maxsize=16)
            ack = asyncio.Event()
            pump = None
            counted = None
            upstream = None

            async def raw_receive(timeout=None):
                message = await asyncio.wait_for(ws.receive(), timeout)
                if message.type != WSMsgType.BINARY or not message.data:
                    raise ValueError('binary protocol packet required')
                return message.data

            async def read_packets():
                while True:
                    data = await raw_receive()
                    if data == b'\2':
                        ack.set()
                    else:
                        await asyncio.wait_for(inbox.put(data), 30)

            async def receive():
                return await inbox.get() if pump else await raw_receive(5)

            async def control():
                data = await receive()
                if data[0] != 0:
                    raise ValueError('control packet required')
                return json.loads(data[1:])

            async def deliver(data):
                if len(data) > MAX_PACKET:
                    raise ValueError('response frame too large')
                ack.clear()
                await ws.send_bytes(data)
                await asyncio.wait_for(ack.wait(), 30)

            try:
                async with asyncio.timeout(5):
                    nonce = (await control())['nonce']
                    if not isinstance(nonce, str) or not re.fullmatch(r'[a-f0-9]{64}', nonce):
                        raise ValueError('invalid nonce')
                    await ws.send_bytes(packet({'proof': sign(secret, f'server:{nonce}:{run_id}')}))
                    proof = (await control())['proof']
                    if not isinstance(proof, str) or not hmac.compare_digest(proof, sign(secret, f'client:{nonce}:{run_id}')):
                        raise ValueError('authentication failed')
                    await ws.send_bytes(packet({'kind': 'ready'}))
                pump = asyncio.create_task(read_packets())
                owner = asyncio.current_task()

                def cancel_owner(task):
                    if not task.cancelled():
                        task.exception()
                    owner.cancel()
                pump.add_done_callback(cancel_owner)
                async with asyncio.timeout(3600):
                    operation = await control()
                    if operation.get('kind') == 'shutdown':
                        await ws.send_bytes(packet({'kind': 'stopping'}))
                        retire(0)
                        return ws
                    route, url = safe_path(operation.get('path'))
                    if operation['kind'] == 'ws':
                        if not route['websocket']:
                            raise ValueError('WS route not allowed')
                        # Checked and taken in one tick, so two viewers cannot both pass.
                        if route['maxViewers'] and route['viewers'] >= route['maxViewers']:
                            await deliver(packet({'kind': 'close', 'code': 1013, 'reason': 'viewer_limit'}))
                            return ws
                        route['viewers'] += 1
                        counted = route
                        upstream = await session.ws_connect('ws:' + url[5:], max_msg_size=MAX_PACKET - 1,
                                                            compress=0, autoping=True)
                        await deliver(packet({'kind': 'open'}))

                        async def upstream_to_client():
                            async for message in upstream:
                                if message.type == WSMsgType.TEXT:
                                    await deliver(packet({'kind': 'text', 'text': message.data}))
                                elif message.type == WSMsgType.BINARY:
                                    await deliver(b'\1' + message.data)
                                else:
                                    break
                            await deliver(packet({'kind': 'close', 'code': upstream.close_code or 1000,
                                                  'reason': ''}))
                            await ws.close()  # upstream is gone: end the relay

                        def relay_ended(task):
                            if not task.cancelled():
                                task.exception()
                                owner.cancel()
                        down = asyncio.create_task(upstream_to_client())
                        down.add_done_callback(relay_ended)
                        try:
                            while True:
                                data = await receive()
                                if data[0] == 1:
                                    await upstream.send_bytes(data[1:])
                                elif data[0] == 0:
                                    item = json.loads(data[1:])
                                    if item.get('kind') == 'text':
                                        await upstream.send_str(item['text'])
                                    elif item.get('kind') == 'close':
                                        break
                                    else:
                                        raise ValueError('invalid WS packet')
                                else:
                                    raise ValueError('invalid WS packet')
                        finally:
                            down.cancel()
                    elif operation['kind'] == 'http':
                        if operation.get('method') not in METHODS:
                            raise ValueError('invalid HTTP method')
                        headers = {}
                        for key, value in (operation.get('headers') or {}).items():
                            if key.lower() not in REQUEST_HEADERS or not isinstance(value, str) or len(value) > 2048 or re.search(r'[\r\n]', value):
                                raise ValueError('header not allowed')
                            headers[key.lower()] = value
                        body = bytearray()
                        while True:
                            data = await receive()
                            if data[0] == 0 and json.loads(data[1:]).get('kind') == 'end':
                                break
                            if data[0] != 1 or len(body) + len(data) - 1 > MAX_BODY:
                                raise ValueError('request body invalid or too large')
                            body.extend(data[1:])
                        try:
                            async with session.request(operation['method'], url, headers=headers, data=bytes(body) or None,
                                                       allow_redirects=False,
                                                       timeout=aiohttp.ClientTimeout(total=120)) as response:
                                await deliver(packet({'kind': 'head', 'status': response.status,
                                                      'headers': {k.lower(): v for k, v in response.headers.items()
                                                                  if k.lower() in RESPONSE_HEADERS}}))
                                async for chunk in response.content.iter_chunked(32 * 1024):
                                    await deliver(b'\1' + chunk)
                        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
                            await deliver(packet({'kind': 'head', 'status': 502, 'headers': {}}))
                        await deliver(packet({'kind': 'end'}))
                    else:
                        raise ValueError('operation not supported')
            except (ValueError, KeyError, TypeError, aiohttp.ClientError, OSError, asyncio.TimeoutError,
                    asyncio.CancelledError, json.JSONDecodeError):
                # Fail closed; never log credentials, SDP or application payloads.
                pass
            finally:
                if counted:
                    counted['viewers'] -= 1
                connections.discard(ws)
                if pump:
                    pump.cancel()
                if upstream:
                    await upstream.close()
                await ws.close()
            return ws

        app = web.Application()
        app.router.add_get('/', bridge)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', 0).start()
        record = {'version': 1, 'pid': os.getpid(), 'control': True, 'entry': str(entry), 'runId': run_id,
                  'secret': secret, 'port': runner.addresses[0][1],
                  'name': str(spec.get('name', 'Service Preview'))[:120],
                  'routes': [{'prefix': r['prefix'], 'websocket': r['websocket']} for r in routes],
                  'media': media, 'iceServers': spec.get('iceServers', []), 'dataPolicy': data_policy}
        with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
            json.dump(record, f)
        os.link(temporary, record_path)  # atomic publish; never overwrites another run
        registered = True
        temporary.unlink()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, retire)
            except NotImplementedError:
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(retire))
        print(f"Service Preview ready: {record['name']}; open the registered entry HTML in GeneHub.", flush=True)
        await stopped.wait()
    except BaseException as error:
        if not isinstance(error, (KeyboardInterrupt, asyncio.CancelledError)):
            print('Service Preview stopped:', error, file=sys.stderr, flush=True)
        exit_code = exit_code or 1
    finally:
        await asyncio.gather(*(ws.close() for ws in list(connections)), return_exceptions=True)
        for proc in children:
            kill_tree(proc)
        for task in watchers:
            task.cancel()
        if registered and record_path.exists() and json.loads(record_path.read_text())['runId'] == run_id:
            record_path.unlink()
        temporary.unlink(missing_ok=True)
        if runner:
            await runner.cleanup()
        await session.close()
        await asyncio.sleep(0.5)
        for proc in children:
            kill_tree(proc, force=True)
    return exit_code


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
