# TeleportXR
Teleport virtual reality server for node.js

1. Ensure node.js is installed.
2. Run npm install teleportxr.
3. See https://github.com/teleportxr/teleport-nodejs-server-example.git for example usage.

## Environment variables

The library itself reads the following environment variables. Variables that
configure the example server (`TELEPORT_*`, `PORT`) are documented in the
[teleport-nodejs-server-example](https://github.com/teleportxr/teleport-nodejs-server-example)
README.

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBRTC_CONNECT_TIMEOUT_MS` | `10000` | Time in milliseconds to wait for a client to complete WebRTC connection establishment. Clients that don't establish a peer connection within this window are disconnected and removed. Read in `client/client.js`. |
