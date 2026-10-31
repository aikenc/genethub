"""Pixel Streaming signalling server (UE 5.4 protocol) for the preview runner, in Python.

    python signalling.py --http-port 18081 --streamer-port 18888

Unreal connects to the streamer port (-PixelStreamingURL=ws://127.0.0.1:<streamer-port>); the
preview bridge connects to the HTTP port. Both are loopback only. This is a faithful subset of
Epic's reference server (cirrus): config, identify/endpointId, listStreamers, subscribe,
offer/answer/iceCandidate forwarding, ping/pong, player counts. No SFU, matchmaker or static files.
"""
import argparse
import asyncio
import json
import time

from aiohttp import web, WSMsgType

streamers = {}   # id -> ws
players = {}     # id -> {'ws', 'streamer', 'browser_offers'}
next_player = 1
legacy = 0
CONFIG = {'type': 'config', 'peerConnectionOptions': {}}


def unique_streamer_id(wanted):
    taken = set(streamers)
    if wanted not in taken:
        return wanted
    n = 1
    while f'{wanted}{n}' in taken:
        n += 1
    return f'{wanted}{n}'


async def send(ws, message):
    if not ws.closed:
        await ws.send_str(json.dumps(message))


async def to_streamer(pid, message):
    player = players[pid]
    sid = player['streamer'] or next(iter(streamers), None)
    if sid in streamers:
        await send(streamers[sid], {**message, 'playerId': pid})


async def streamer_socket(request):
    global legacy
    ws = web.WebSocketResponse(max_msg_size=1 << 20)
    await ws.prepare(request)
    sid = None
    await send(ws, CONFIG)
    await send(ws, {'type': 'identify'})

    def register(wanted):
        nonlocal sid
        if sid in streamers:
            del streamers[sid]
        sid = unique_streamer_id(wanted)
        streamers[sid] = ws

    async def fallback_id():
        global legacy
        await asyncio.sleep(5)  # an older streamer that never identifies itself
        if sid is None:
            register(f'__LEGACY_STREAMER__{legacy}')
            legacy += 1
    timer = asyncio.create_task(fallback_id())
    try:
        async for frame in ws:
            if frame.type != WSMsgType.TEXT:
                break
            message = json.loads(frame.data)
            kind = message.get('type')
            if kind == 'endpointId':
                register(str(message['id']))
            elif kind == 'ping':
                await send(ws, {'type': 'pong', 'time': message.get('time')})
            elif kind in ('offer', 'answer', 'iceCandidate'):
                pid = str(message.pop('playerId', ''))
                if pid in players:
                    await send(players[pid]['ws'], message)
            elif kind == 'disconnectPlayer':
                pid = str(message.get('playerId', ''))
                if pid in players:
                    await players[pid]['ws'].close(code=1011, message=str(message.get('reason', ''))[:100].encode())
            elif kind != 'layerPreference':
                await ws.close(code=1008, message=b'Unsupported message type')
    except (json.JSONDecodeError, KeyError, TypeError):
        await ws.close(code=1008, message=b'Cannot parse')
    finally:
        timer.cancel()
        if sid and streamers.get(sid) is ws:
            del streamers[sid]
            for player in [p for p in players.values() if p['streamer'] == sid]:
                await player['ws'].close()
    return ws


async def broadcast_count():
    for player in list(players.values()):
        await send(player['ws'], {'type': 'playerCount', 'count': len(players)})


async def player_socket(request):
    global next_player
    ws = web.WebSocketResponse(max_msg_size=1 << 20)
    await ws.prepare(request)
    pid = str(next_player)
    next_player += 1
    offer = request.query.get('OfferToReceive', 'false') not in ('false', '')
    players[pid] = {'ws': ws, 'streamer': None, 'browser_offers': offer}

    async def keepalive():
        while True:
            await asyncio.sleep(10)
            await send(ws, {'type': 'ping', 'time': int(time.time() * 1000)})
    ping = asyncio.create_task(keepalive())
    await send(ws, CONFIG)
    await broadcast_count()
    try:
        async for frame in ws:
            if frame.type != WSMsgType.TEXT:
                break
            message = json.loads(frame.data)
            kind = message.get('type')
            if kind == 'listStreamers':
                await send(ws, {'type': 'streamerList', 'ids': list(streamers)})
            elif kind == 'subscribe':
                if message.get('streamerId') in streamers:
                    players[pid]['streamer'] = message['streamerId']
                    await to_streamer(pid, {'type': 'playerConnected', 'dataChannel': True, 'sfu': False,
                                            'sendOffer': not offer})
            elif kind == 'unsubscribe':
                await to_streamer(pid, {'type': 'playerDisconnected'})
                players[pid]['streamer'] = None
            elif kind in ('offer', 'answer', 'iceCandidate', 'dataChannelRequest', 'peerDataChannelsReady'):
                await to_streamer(pid, message)
            elif kind not in ('stats', 'pong'):
                await ws.close(code=1008, message=b'Unsupported message type')
    except (json.JSONDecodeError, KeyError, TypeError):
        await ws.close(code=1008, message=b'Cannot parse')
    finally:
        ping.cancel()
        if players[pid]['streamer'] in streamers:
            await to_streamer(pid, {'type': 'playerDisconnected'})
        del players[pid]
        await broadcast_count()
    return ws


async def http_or_player(request):
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        return await player_socket(request)
    return web.Response(text='ok')  # health


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--http-port', type=int, required=True)
    parser.add_argument('--streamer-port', type=int, required=True)
    args = parser.parse_args()
    runners = []
    for port, handler in ((args.http_port, http_or_player), (args.streamer_port, streamer_socket)):
        app = web.Application()
        app.router.add_get('/{tail:.*}', handler)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', port).start()
        runners.append(runner)
    await asyncio.Event().wait()


if __name__ == '__main__':
    asyncio.run(main())
