"""Serve camera-orbit previews from a headless Blender (no window, no desktop session).

Run as: blender -b scene.blend --python blender_server.py
GET /health                      -> ready
GET /api/blender/state           -> {"frame":..,"start":..,"end":..,"radius":..}
GET /api/blender/frame?az=&el=&zoom=&frame=&w=  -> image/jpeg
The only inputs are those five numbers; nothing from the request is executed.
Requests are handled one at a time on the main thread, which is where bpy must render.
"""
import json, math, os, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import bpy
from mathutils import Vector

PORT = int(os.environ.get("PREVIEW_BLENDER_PORT", "18082"))
scene = bpy.context.scene
for name in (os.environ.get("PREVIEW_BLENDER_ENGINE", "EEVEE"), "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    engine = {"EEVEE": "BLENDER_EEVEE_NEXT", "CYCLES": "CYCLES"}.get(name, name)
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
if scene.render.engine == "CYCLES":
    scene.cycles.samples = int(os.environ.get("PREVIEW_BLENDER_SAMPLES", "16"))

cam = scene.camera
if cam is None:
    cam = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    scene.collection.objects.link(cam)
    scene.camera = cam

points = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "MESH" for c in o.bound_box]
if points:
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center, radius = (low + high) / 2, max((high - low).length / 2, 0.5)
else:
    center, radius = Vector((0, 0, 0)), 5.0

def number(query, key, default, low, high):
    try:
        return min(max(float(query.get(key, [default])[0]), low), high)
    except ValueError:
        return default

def render(query):
    az = math.radians(number(query, "az", 35, -3600, 3600))
    el = math.radians(number(query, "el", 25, -89, 89))
    distance = radius * 2.4 / number(query, "zoom", 1, 0.2, 8)
    scene.frame_set(int(number(query, "frame", scene.frame_current, scene.frame_start, scene.frame_end)))
    width = int(number(query, "w", 640, 160, 1280))
    scene.render.resolution_x, scene.render.resolution_y = width, max(90, width * 9 // 16)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 80
    cam.location = center + Vector((
        distance * math.cos(el) * math.cos(az), distance * math.cos(el) * math.sin(az), distance * math.sin(el)))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    with tempfile.TemporaryDirectory() as folder:
        scene.render.filepath = os.path.join(folder, "frame.jpg")
        bpy.ops.render.render(write_still=True)
        with open(scene.render.filepath, "rb") as file:
            return file.read()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body, kind):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/health":
            self.reply(200, b"ready", "text/plain")
        elif url.path == "/state":
            state = {"frame": scene.frame_current, "start": scene.frame_start, "end": scene.frame_end, "radius": radius}
            self.reply(200, json.dumps(state).encode(), "application/json")
        elif url.path == "/frame":
            self.reply(200, render(query), "image/jpeg")
        else:
            self.reply(404, b"not found", "text/plain")

HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
