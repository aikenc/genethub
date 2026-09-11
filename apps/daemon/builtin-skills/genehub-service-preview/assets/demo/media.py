"""Native WebRTC reference endpoint: moving video and tone, no model dependency.
This is a connectivity sample, not a generated avatar or a media mock inside GeneHub.
"""
import asyncio
import fractions
import math
import os
import uuid
import numpy as np
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, VideoStreamTrack, AudioStreamTrack
from aiortc.contrib.media import MediaBlackhole
from av import VideoFrame, AudioFrame

peers = {}
class Picture(VideoStreamTrack):
    async def recv(self):
        pts, base = await self.next_timestamp()
        image = np.zeros((360, 640, 3), dtype=np.uint8)
        image[:, :, 0] = 25
        image[:, :, 1] = 65
        x = int(pts / 90000 * 90) % 580
        image[130:230, x:x+60] = (80, 230, 180)
        frame = VideoFrame.from_ndarray(image, format="rgb24")
        frame.pts, frame.time_base = pts, base
        return frame
class Tone(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.samples = 0
        self.started = None
    async def recv(self):
        loop = asyncio.get_running_loop()
        if self.started is None:
            self.started = loop.time()
        await asyncio.sleep(max(0, self.started + self.samples / 48000 - loop.time()))
        values = (np.sin((np.arange(960) + self.samples) * (2 * math.pi * 440 / 48000)) * 900).astype(np.int16)
        frame = AudioFrame.from_ndarray(values.reshape(1,-1), format="s16", layout="mono")
        frame.sample_rate = 48000
        frame.pts = self.samples
        frame.time_base = fractions.Fraction(1,48000)
        self.samples += 960
        return frame
async def offer(request):
    if len(peers) >= 4:
        raise web.HTTPTooManyRequests()
    params = await request.json()
    servers = [RTCIceServer(**item) for item in params.get("iceServers", [])]
    pc = RTCPeerConnection(RTCConfiguration(iceServers=servers))
    session_id = uuid.uuid4().hex
    sink = MediaBlackhole()
    peers[session_id] = (pc,sink)
    @pc.on("track")
    def track(track):
        sink.addTrack(track)
    @pc.on("connectionstatechange")
    async def changed():
        if pc.connectionState in ("failed", "closed"):
            peers.pop(session_id, None)
            await sink.stop()
            if pc.connectionState != "closed":
                await pc.close()
    await pc.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"],type="offer"))
    pc.addTrack(Picture())
    pc.addTrack(Tone())
    await sink.start()
    await pc.setLocalDescription(await pc.createAnswer())
    async def expire():
        await asyncio.sleep(30)
        if pc.connectionState != "connected":
            await pc.close()
        else:
            await asyncio.sleep(3570)
            await pc.close()
    asyncio.create_task(expire())
    return web.json_response({"sdp":pc.localDescription.sdp,"type":"answer","sessionId":session_id})
async def stop(request):
    body = await request.json()
    pair = peers.pop(body.get("sessionId"),None)
    if pair:
        await pair[1].stop()
        await pair[0].close()
    return web.json_response({"stopped":True})
async def health(_):
    return web.json_response({"ready":True,"sessions":len(peers)})
async def shutdown(_):
    await asyncio.gather(*(pc.close() for pc,_ in list(peers.values())))
app=web.Application(client_max_size=256*1024)
app.add_routes([web.get('/health',health),web.post('/offer',offer),web.post('/stop',stop)])
app.on_shutdown.append(shutdown)
web.run_app(app,host='127.0.0.1',port=int(os.environ.get('PREVIEW_MEDIA_PORT','18011')),access_log=None)
