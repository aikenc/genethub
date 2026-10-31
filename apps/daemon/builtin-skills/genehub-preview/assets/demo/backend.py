"""Small real HTTP/WS service for exercising the service bridge without a model."""
import asyncio
import os

from aiohttp import web, WSMsgType


async def health(_):
    return web.Response(text='ready')


async def status(_):
    return web.json_response({'ready': True, 'pid': os.getpid()})


async def echo(request):
    body = await request.read()
    return web.Response(status=201, body=body, content_type=request.content_type or 'application/octet-stream')


async def stream(request):
    response = web.StreamResponse(headers={'content-type': 'text/event-stream'})
    await response.prepare(request)
    for n in range(1, 6):
        await response.write(f'data: {n}\n\n'.encode())
        await asyncio.sleep(0.1)
    return response


async def socket(request):
    ws = web.WebSocketResponse(max_msg_size=256 * 1024, compress=False)
    await ws.prepare(request)
    async for message in ws:
        if message.type == WSMsgType.TEXT:
            await ws.send_str(message.data)
        elif message.type == WSMsgType.BINARY:
            await ws.send_bytes(message.data)
    return ws


app = web.Application()
app.router.add_get('/health', health)
app.router.add_get('/status', status)
app.router.add_route('*', '/echo{tail:.*}', echo)
app.router.add_get('/stream', stream)
app.router.add_get('/{tail:.*}', socket)
web.run_app(app, host='127.0.0.1', port=int(os.environ.get('PREVIEW_DEMO_PORT', '18010')), print=None)
