#!/usr/bin/env python3
"""
Minimal local bridge server for Robot Viewer.

Streams joint values over a loopback WebSocket so a viewer page - even one
served from a cloud host - can animate the model from data that never leaves
this machine.

    pip install websockets
    python examples/bridge_server.py

Then open the viewer, click "Bridge" in the toolbar and connect to
ws://127.0.0.1:9090.

By default the server waits for the page to report the joints of the loaded
model and drives all of them with a sine wave, so it works with any robot
without editing this file. Pass --joints to stream a fixed list instead.

Wire in real data by replacing read_joint_values() below.
"""

import argparse
import asyncio
import json
import math
import struct
import time
from urllib.parse import urlparse, parse_qs

import websockets

# Only these pages may talk to this server. A local WebSocket without an Origin
# check is reachable from *any* website the operator happens to have open, which
# would let a random page read the robot state (cross-site WebSocket hijacking).
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://viewer.robotsfan.com",
}


def request_of(ws):
    """websockets >= 14 exposes ws.request; older releases put it on ws."""
    return getattr(ws, "request", ws)


def header(ws, name):
    request = request_of(ws)
    headers = getattr(request, "headers", None)
    if headers is None:
        headers = getattr(ws, "request_headers", {})
    return headers.get(name)


def query_param(ws, name):
    path = getattr(request_of(ws), "path", None) or getattr(ws, "path", "")
    values = parse_qs(urlparse(path).query).get(name)
    return values[0] if values else None


def read_joint_values(joints, elapsed):
    """Replace this with the real source: a controller, a solver, a robot."""
    return [0.5 * math.sin(elapsed + 0.35 * i) for i in range(len(joints))]


class BridgeServer:
    def __init__(self, args):
        self.args = args
        self.joints = list(args.joints or [])
        self.follow_model = not args.joints

    async def handle(self, ws):
        origin = header(ws, "Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            print(f"[bridge] rejected origin: {origin}", flush=True)
            await ws.close(1008, "origin not allowed")
            return

        if self.args.token and query_param(ws, "token") != self.args.token:
            print("[bridge] rejected: bad token", flush=True)
            await ws.close(1008, "bad token")
            return

        print(f"[bridge] client connected from {origin or 'unknown origin'}", flush=True)
        try:
            joints = list(self.joints)
            await self.send_hello(ws, joints)

            # The page answers hello with the joints of the model it has loaded.
            if self.follow_model:
                joints = await self.await_model_joints(ws)
                if not joints:
                    print("[bridge] no movable joints reported, nothing to stream", flush=True)
                    return
                print(f"[bridge] following {len(joints)} joints from the loaded model", flush=True)
                await self.send_hello(ws, joints)

            await self.stream(ws, joints)
        except websockets.exceptions.ConnectionClosed:
            # Closing the tab or the panel is the normal way out, not an error.
            print("[bridge] client disconnected", flush=True)

    async def send_hello(self, ws, joints):
        await ws.send(json.dumps({
            "type": "hello",
            "joints": joints,
            "units": "rad",
            "dtype": "f32",
            "rate": self.args.rate,
        }))

    async def await_model_joints(self, ws):
        while True:
            message = await ws.recv()
            if isinstance(message, bytes):
                continue
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                continue
            if payload.get("type") == "ready":
                return payload.get("joints") or []

    async def stream(self, ws, joints):
        frame = struct.Struct(f"<{len(joints)}f")
        period = 1.0 / self.args.rate
        start = time.perf_counter()
        next_send = start

        while True:
            now = time.perf_counter()
            values = read_joint_values(joints, now - start)
            await ws.send(frame.pack(*values))

            # Absolute-time schedule: if a slow client made the send block past
            # the deadline, skip the frames we missed instead of accumulating lag.
            next_send += period
            delay = next_send - time.perf_counter()
            if delay < -period:
                next_send = time.perf_counter()
                delay = 0
            await asyncio.sleep(max(delay, 0))


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address; keep it on loopback (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--rate", type=float, default=100.0, help="frames per second")
    parser.add_argument("--token", default="", help="require ?token=... on connect")
    parser.add_argument("--joints", nargs="*",
                        help="stream this fixed joint list instead of following the model")
    args = parser.parse_args()

    server = BridgeServer(args)
    async with websockets.serve(server.handle, args.host, args.port):
        print(f"[bridge] listening on ws://{args.host}:{args.port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
