# Local bridge

Streams joint values from a program on the operator's machine into the viewer,
so a page served from anywhere - including a cloud host - animates the model
from data that never leaves that machine.

```bash
pip install websockets
python examples/bridge_server.py
```

Open the viewer, click **Bridge** in the toolbar, and connect to
`ws://127.0.0.1:9090`. The example waits for the page to report the joints of
the loaded model and drives all of them with a sine wave, so it works with any
robot without editing the script. Replace `read_joint_values()` with the real
source - a controller, a solver, a robot.

## Protocol

| Direction | Payload |
| --- | --- |
| server → client, once | `{"type":"hello","joints":["j1","j2"],"units":"rad","dtype":"f32","rate":100}` |
| server → client, per frame | `Float32Array` (or `Float64Array`, see `dtype`) with one value per joint, in the order `hello` declared |
| server → client, per frame | `{"type":"pose","values":{"j1":0.42}}` - simpler, for rates below ~30 Hz |
| client → server, after `hello` | `{"type":"ready","joints":[...movable joints of the loaded model...]}` |

Rotational joints are radians and prismatic joints are metres. A `hello`
declaring `"units":"deg"` rescales only the rotational joints. Sending a second
`hello` renegotiates the frame layout at any time.

Joint names the model does not have, and model joints nobody streams, are both
reported in the panel - a silent name mismatch otherwise looks like a dead
connection.

Frames are state, not events: the viewer keeps only the newest one and applies
it on the next animation frame. Streaming at 1 kHz is not an error, it just
means most frames are coalesced (the panel counts them). A hidden tab suspends
`requestAnimationFrame` entirely, so nothing is applied until it is visible
again - the model then jumps to the latest pose rather than replaying history.

## Security

The server **must** check the `Origin` header. A local WebSocket without that
check is reachable from any website the operator happens to have open, which
would let a random page read the robot state - cross-site WebSocket hijacking.
Edit `ALLOWED_ORIGINS` in `bridge_server.py` to match where the viewer is
served from.

Keep the bind address on loopback (`127.0.0.1`, the default) rather than
`0.0.0.0`, and pass `--token` to require `?token=...` on connect.

## Browser support

A page served over HTTPS connecting to `ws://127.0.0.1` is allowed in
Chrome, Edge and Firefox, which treat loopback as a trustworthy origin.
**Safari blocks it** as mixed content. Chrome is also tightening access from
public pages to local network addresses, which may add a permission prompt.

Two ways around that, neither implemented here: terminate TLS in the local
service behind a hostname that resolves to `127.0.0.1` (what Plex and Discord
do, at the cost of shipping and rotating a certificate), or relay through the
cloud host so both sides make outbound connections.

## Other languages

Node.js works the same way with the `ws` package. For C++, publishing over
UDP, ZeroMQ or shared memory into a small Python or Node bridge process is
usually cheaper than embedding a WebSocket stack; if you do want it in-process,
`libdatachannel` also gets you WebRTC data channels.

ROS users already have this: `rosbridge_suite` serves `ws://localhost:9090` and
publishes `/joint_states`, so a thin adapter on top of this protocol would work
with no local script at all.
