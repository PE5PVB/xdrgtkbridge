# xdrgtk_bridge

An fm-dx-webserver plugin that tunnels the tuner's xdrd protocol over a WebSocket on the webserver's existing HTTP(S) port. This lets XDR-GTK connect through any HTTP reverse proxy (nginx, Caddy, Traefik, Cloudflare) without opening an extra TCP port on the firewall.

## Requirements

- A running **fm-dx-webserver** instance.
- A patched **XDR-GTK** client that supports `ws://` / `wss://` connections — available here: <https://github.com/PE5PVB/xdr-gtk>.

## Installation

1. Copy (or `git clone`) this repository into the webserver's `plugins/` directory so the layout becomes:

   ```
   <fm-dx-webserver>/plugins/
     xdrgtk_bridge.js
     xdrgtk_bridge/
       frontend.js
       frontend_server.js
   ```

2. In the fm-dx-webserver admin panel, enable the **XDR-GTK Bridge** plugin.
3. Restart fm-dx-webserver.

On first start the plugin writes a config file to `<fm-dx-webserver>/plugins_configs/xdrgtk_bridge.json`:

```json
{
  "wsPath": "/xdrgtk",
  "requirePassword": true,
  "password": "password",
  "authTimeoutMs": 5000
}
```

> **Change the default password before exposing the tuner to the internet.**

## Configuration

| Key               | Default     | Description                                                                                                  |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `wsPath`          | `/xdrgtk`   | Path of the WebSocket endpoint on the webserver's HTTP(S) port.                                              |
| `requirePassword` | `true`      | When set to `false`, any password is accepted. The salt/hash handshake still runs for client compatibility.  |
| `password`        | `password`  | Shared secret used in the `sha1(salt + password)` handshake.                                                 |
| `authTimeoutMs`   | `5000`      | Milliseconds to wait for the client's authentication response before dropping the connection.                |

Config keys added in future versions are automatically merged into your existing file on startup; custom values you've set are preserved.

## Connecting with XDR-GTK

Use the [PE5PVB fork of XDR-GTK](https://github.com/PE5PVB/xdr-gtk), which adds a "Webserver" connection mode next to the classic direct-xdrd mode. In the connect dialog enter:

- **URL**: `http[s]://<your-host>[:port]` — the same URL you use in a browser. The client rewrites it internally to `ws[s]://<host>[:port]/xdrgtk`.
- **Password**: whatever you set in `xdrgtk_bridge.json`.

Audio is streamed automatically from the webserver's existing MP3 endpoint — no additional ports or client configuration required.

## Reverse-proxy configuration

The proxy in front of fm-dx-webserver must forward WebSocket upgrade headers for the `/xdrgtk` path (and `/audio` for the stream). Example for nginx:

```nginx
location /xdrgtk {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}

location /audio {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Online-user count

XDR-GTK clients are counted alongside regular web-UI users. A bridge client shows up in the webserver's online counter, and web users appear in the `o1,N` frame that XDR-GTK uses to display the number of connected listeners.

## Protocol

The wire protocol is identical to classic xdrd (line-oriented ASCII commands, newline-terminated), carried inside WebSocket text frames. After a successful `sha1(salt + password)` handshake the connection is a 1:1 passthrough to the tuner, so any xdrd-compatible client can be adapted with minimal effort.
