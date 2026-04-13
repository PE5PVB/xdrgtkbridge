# XDR-GTK patch: connect to fm-dx-webserver via WebSocket tunnel

The `serialbridge` plugin no longer exposes a raw TCP port. Instead it
registers a WebSocket endpoint on the existing webserver HTTP(S) port,
so the connection survives any HTTP reverse proxy (nginx, Caddy, Traefik,
Cloudflare) without extra firewall openings.

- Default URL: `ws://<host>:<webserverPort>/xdrgtk`
  (use `wss://` when the webserver is fronted by TLS).
- Wire protocol: **identical to xdrd** (line-oriented ASCII), but carried
  inside WebSocket text frames.

## Protocol recap

```
  ← server      <16-char salt>\n
  → client      <sha1(salt+password) hex>\n
  ← server      o1,<N>\n
  ← server      OK\n
  ← server      a1\n                                  (network/guest marker)
  ← server      $fmdx-webserver,<ver>,<httpPort>,<audioPath>\n
  ← server      T<freqKhz>\n
  ⇄ both        raw tuner traffic, newline-terminated commands
```

Empty password in the plugin's `config.json` disables the handshake.

The `$fmdx-webserver,…` line is still a regular ASCII line; any stock
xdrd-compatible client that sees a `$`-prefixed line simply ignores it.

---

## XDR-GTK changes

XDR-GTK currently uses a `socket()` + `connect()` in `src/xdrgtk-conn.c`
to speak to xdrd. For the WS tunnel you need a WebSocket client. Easiest
route on GNOME/GTK stacks is **libsoup 3** (already an indirect dep via
GTK on most distros).

### 1. Link libsoup

In `CMakeLists.txt`:

```cmake
pkg_check_modules(SOUP REQUIRED libsoup-3.0)
target_include_directories(xdr-gtk PRIVATE ${SOUP_INCLUDE_DIRS})
target_link_libraries(xdr-gtk PRIVATE ${SOUP_LIBRARIES})
```

### 2. New connection type

In `src/xdrgtk-conn.h` add a mode flag plus a URI field:

```c
typedef enum {
    CONN_MODE_SERIAL,
    CONN_MODE_XDRD,       /* raw TCP to xdrd */
    CONN_MODE_WEBSOCKET   /* ws[s]:// tunnel to fm-dx-webserver */
} conn_mode_t;
```

Extend `conn_t` with `conn_mode_t mode` and a `gchar *uri`.

### 3. WebSocket connect path

In `src/xdrgtk-conn.c`, add a parallel path that uses libsoup:

```c
#include <libsoup/soup.h>

static void
ws_connected_cb(GObject *source, GAsyncResult *res, gpointer user_data)
{
    conn_t *data = user_data;
    GError *err = NULL;
    SoupWebsocketConnection *ws =
        soup_session_websocket_connect_finish(SOUP_SESSION(source), res, &err);

    if (!ws) {
        data->state = CONN_SOCKET_FAIL;
        g_idle_add(connection_socket_callback, data);
        g_error_free(err);
        return;
    }

    /* Stash ws in data; drive the same state machine (salt → hash → OK). */
    data->ws = ws;
    g_signal_connect(ws, "message", G_CALLBACK(ws_on_message), data);
    g_signal_connect(ws, "closed",  G_CALLBACK(ws_on_closed),  data);
    /* Wait for the salt (first text frame). */
}

static void
ws_on_message(SoupWebsocketConnection *ws,
              SoupWebsocketDataType    type,
              GBytes                  *message,
              gpointer                 user_data)
{
    gsize len;
    const gchar *buf = g_bytes_get_data(message, &len);
    /* Feed bytes into the same line parser you already use for xdrd —
     * newlines delimit commands; run tuner_parse() for each line. */
    tuner_feed_bytes(buf, len);
}
```

On Connect, if the user entered a `ws://` / `wss://` URL (or a checkbox
"via fm-dx-webserver" is ticked), launch this path instead of the
`socket()`/`connect()` path. Everything after "first text frame received"
re-uses the existing xdrd state machine (compute SHA1, send hash, wait
for `OK`/`a1`, then normal parsing).

Sending commands becomes:

```c
void
tuner_write(conn_t *c, const gchar *line)
{
    if (c->mode == CONN_MODE_WEBSOCKET)
        soup_websocket_connection_send_text(c->ws, line);
    else
        send(c->fd, line, strlen(line), 0);
}
```

### 4. Auto-start audio stream (same as before)

When `tuner_parse()` sees `$fmdx-webserver,<ver>,<httpPort>,<audioPath>`,
compose `ws[s]://<connect-host>:<httpPort><audioPath>` (reuse the scheme
from the tuner URI so TLS carries over) and open it with a second
`soup_session_websocket_connect_async`. The payload is raw MP3 frames;
decode via GStreamer (`mpegaudioparse ! mpg123audiodec ! autoaudiosink`)
or spawn `mpv --no-video <url>` as a child process.

### 5. Connect dialog

Two friendly input modes in `src/ui-connect.c`:

- **Direct xdrd**: host + port (existing behaviour).
- **Webserver**: URL (`http[s]://host[:port]`) + password. Internally
  this translates to `ws[s]://host:port/xdrgtk` (swap `http` → `ws`).

### 6. Reset on disconnect

In `tuner_disconnect()` / on close, call `soup_websocket_connection_close(c->ws, …)`
and free the session. Reset `tuner.is_webserver`, stop the audio subprocess
or GStreamer pipeline.

---

## Testing

1. Run fm-dx-webserver with the plugin enabled and a password configured.
   Behind a reverse proxy, make sure the upstream config passes the
   `Upgrade: websocket` headers (nginx needs `proxy_http_version 1.1;`
   and `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).
2. In your patched XDR-GTK enter the webserver URL and password.
3. On connect you should see (enable `DEBUG_READ` in `tuner.c` to watch):
   ```
   read: <salt>
   read: o1,1
   read: OK
   read: a1
   read: $fmdx-webserver,1.4.0b,7777,/audio
   read: T87500
   ```
4. Audio should auto-play if `conf.auto_audio_on_webserver` is on.
5. Compatibility check: point the same patched XDR-GTK at a plain xdrd —
   the `ws://` path is only used when you select "Webserver"; xdrd mode is
   untouched. And any existing xdrd-compatible client will never see the
   `/xdrgtk` endpoint.

---

## Notes

- The plugin takes over the server's `'upgrade'` event and dispatches
  `/xdrgtk` itself; other paths (`/text`, `/audio`, `/chat`, `/rds`,
  `/data_plugins`) are forwarded to the core handlers unchanged.
- `$fmdx-<what>,<payload>` is the convention for future webserver-only
  hints. Stock clients ignore unknown `$` lines.
- If you really need a raw TCP version back (for legacy tooling like
  stock XDR-GTK on LANs with no proxy), keep the git history of the
  previous plugin revision: it opened a `net.Server` on port 7373 with
  the same protocol.
