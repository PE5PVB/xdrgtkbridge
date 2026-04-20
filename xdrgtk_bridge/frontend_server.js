// xdrgtk_bridge/frontend_server.js
// Tunnels the tuner's serial/xdrd stream over a WebSocket on the webserver's
// existing HTTP(S) port, so it works through any HTTP reverse proxy.
//
// Endpoint: ws[s]://<host>:<webserverPort><wsPath>   (default path: /xdrgtk)
//
// Wire format (line-oriented ASCII, identical to xdrd):
//   1. Server sends text frame: "<16-char salt>\n"
//   2. Client replies text frame: "<sha1(salt+password) hex>\n"
//   3. On mismatch: server sends "a0\n" and closes. On match, server sends:
//        o1,<N>\n                  (online count)
//        OK\n                      (tuner ready)
//        a1\n                      (guest/network session marker)
//        $fmdx-webserver,<ver>,<httpPort>,<audioPath>\n   (webserver hint)
//        T<freqKhz>\n              (current cached frequency)
//      and enters bidirectional 1:1 passthrough mode.
//
// The handshake always runs. Set `requirePassword: false` in the config to
// skip hash verification (any response accepted).
//
// Config: plugins_configs/xdrgtk_bridge.json (auto-created on first run).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const pluginsApi = require('../../server/plugins_api');
const helpers = require('../../server/helpers');
let dataHandler = null;
try { dataHandler = require('../../server/datahandler'); } catch (_) { /* older webserver */ }
const { logInfo, logWarn, logError } = require('../../server/console');
const pjson = require('../../package.json');

// ---- config ----------------------------------------------------------------

// Config lives in the webserver-wide `plugins_configs/` folder so it survives
// plugin reinstalls. Path is relative to the plugin's own location:
// <fm-dx-webserver>/plugins/xdrgtk_bridge/frontend_server.js → ../../plugins_configs/xdrgtk_bridge.json
const CONFIG_PATH = path.join(__dirname, '..', '..', 'plugins_configs', 'xdrgtk_bridge.json');
const DEFAULT_CONFIG = {
    wsPath: '/xdrgtk',
    requirePassword: true,
    password: 'password',
    authTimeoutMs: 5000
};

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
            logInfo(`[xdrgtk_bridge] Created default config at ${CONFIG_PATH}`);
            return { ...DEFAULT_CONFIG };
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const missing = Object.keys(DEFAULT_CONFIG).filter(k => !(k in parsed));
        const merged = { ...DEFAULT_CONFIG, ...parsed };
        if (missing.length > 0) {
            // Persist newly-added keys so the user can see/edit them.
            // User-added keys not in DEFAULT_CONFIG are preserved via the spread above.
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
            logInfo(`[xdrgtk_bridge] Added missing config keys with defaults: ${missing.join(', ')}`);
        }
        return merged;
    } catch (err) {
        logError('[xdrgtk_bridge] Failed to read config, using defaults: ' + err.message);
        return { ...DEFAULT_CONFIG };
    }
}

const config = loadConfig();
// Handshake always runs (XDR-GTK expects it); REQUIRE_PASSWORD controls
// whether the hash response is actually verified. Any non-false value => true.
const REQUIRE_PASSWORD = config.requirePassword !== false;

// ---- shared state ----------------------------------------------------------

const clients = new Set(); // authenticated WebSocket connections only

// Tee every radio chunk to connected clients (text frames, ASCII protocol).
const origResolve = helpers.resolveDataBuffer;
helpers.resolveDataBuffer = function (data, wss, rdsWss) {
    if (clients.size > 0) {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(text); } catch (_) { /* client gone */ }
            }
        }
    }
    return origResolve.call(this, data, wss, rdsWss);
};

// ---- online-user counting ---------------------------------------------------
//
// fm-dx-webserver tracks its web-UI users in a `currentUsers` counter that is
// local to server/index.js; the only place that value leaks out is when
// index.js calls `dataHandler.showOnlineUsers(currentUsers)` on every connect
// or disconnect. We latch that number here and add our own `clients.size` on
// top, so the total reflects web users + xdrgtk/bridge clients. The combined
// value is written back into dataToSend.users (via the original setter), so
// the web UI and /data endpoint show the same count as the xdrgtk `o1,N` line.

let hostUserCount = 0;
let origShowOnlineUsers = null;

function onlineTotal() {
    return hostUserCount + clients.size;
}

function publishOnlineCount() {
    const total = onlineTotal();
    if (origShowOnlineUsers) {
        try { origShowOnlineUsers.call(dataHandler, total); } catch (_) {}
    }
    if (clients.size === 0) return;
    const frame = `o1,${total}\n`;
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(frame); } catch (_) { /* client gone */ }
        }
    }
}

if (dataHandler && typeof dataHandler.showOnlineUsers === 'function') {
    origShowOnlineUsers = dataHandler.showOnlineUsers;
    // Seed with whatever the host already knows (usually undefined at boot).
    if (dataHandler.dataToSend && Number.isFinite(dataHandler.dataToSend.users)) {
        hostUserCount = dataHandler.dataToSend.users;
    }
    dataHandler.showOnlineUsers = function (n) {
        // `n` is the host's own count; remember it, then republish the total
        // (host + bridge) so dataToSend.users ends up with the combined value.
        if (Number.isFinite(n)) hostUserCount = n;
        publishOnlineCount();
    };
}

// ---- auth helpers ----------------------------------------------------------

const SALT_LEN = 16;
const HEX_ALPHABET = '0123456789abcdef';

function generateSalt() {
    const bytes = crypto.randomBytes(SALT_LEN);
    let out = '';
    for (let i = 0; i < SALT_LEN; i++) out += HEX_ALPHABET[bytes[i] & 0x0f];
    return out;
}

function expectedHash(salt, password) {
    return crypto.createHash('sha1')
        .update(salt, 'utf8')
        .update(password, 'utf8')
        .digest('hex');
}

// ---- per-client flow -------------------------------------------------------

const TUNE_SUPPRESS_MS = 2000;

function forwardCommandsToRadio(text, state, peer) {
    // xdrd protocol: newline-terminated single-letter commands.
    // sendPrivilegedCommand appends '\n' itself, so strip it here.
    state.cmdBuf += text;
    while (true) {
        const nl = state.cmdBuf.indexOf('\n');
        if (nl < 0) break;
        const line = state.cmdBuf.slice(0, nl).replace(/\r$/, '');
        state.cmdBuf = state.cmdBuf.slice(nl + 1);
        if (line.length === 0) continue;

        // XDR-GTK fires its remembered freq as a `T...` during its connect/
        // restore flurry, which would stomp on whatever the webserver is
        // currently tuned to. Drop every T for a short window after auth —
        // a flag-per-first-command isn't enough because the client can send
        // a non-T command first (e.g. X1) and the real T arrives right after.
        if (line.charAt(0) === 'T' && Date.now() < state.dropTuneUntil) {
            logInfo(`[xdrgtk_bridge] ignored initial tune from client (${peer}): ${line}`);
            continue;
        }

        // Fire-and-forget; swallow rejections so a failed underlying write
        // doesn't surface as UnhandledPromiseRejection.
        Promise.resolve(pluginsApi.sendPrivilegedCommand(line, true)).catch(() => {});
    }
    if (state.cmdBuf.length > 8192) state.cmdBuf = '';
}

function sendPostAuthBanner(ws) {
    ws.send(`o1,${onlineTotal()}\n`);
    ws.send('OK\n');
    ws.send('a1\n');

    const serverConfig = pluginsApi.getServerConfig();
    const httpPort = serverConfig && serverConfig.webserver && serverConfig.webserver.webserverPort;
    if (httpPort) {
        ws.send(`$fmdx-webserver,${pjson.version},${httpPort},/audio\n`);
    }

    if (dataHandler && dataHandler.dataToSend) {
        const freqMhz = parseFloat(dataHandler.dataToSend.freq);
        if (!isNaN(freqMhz) && freqMhz > 0) {
            ws.send(`T${Math.round(freqMhz * 1000)}\n`);
        }
    }
}

function promoteToBridge(ws, peer) {
    clients.add(ws);
    const state = { cmdBuf: '', dropTuneUntil: Date.now() + TUNE_SUPPRESS_MS };
    logInfo(`[xdrgtk_bridge] client authenticated (${peer}) [${clients.size}]`);

    try {
        sendPostAuthBanner(ws);
    } catch (err) {
        logWarn(`[xdrgtk_bridge] failed to send banner (${peer}): ${err.message}`);
    }

    // Bridge-client joined: republish total so web UI + other xdrgtk clients update.
    publishOnlineCount();

    ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        forwardCommandsToRadio(text, state, peer);
    });

    ws.on('close', () => {
        clients.delete(ws);
        logInfo(`[xdrgtk_bridge] client disconnected (${peer}) [${clients.size}]`);
        publishOnlineCount();
    });
}

function handleAuth(ws, peer) {
    const salt = generateSalt();
    const expected = expectedHash(salt, config.password);
    let done = false;

    const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        logWarn(`[xdrgtk_bridge] auth timeout (${peer})`);
        try { ws.send('a0\n'); } catch (_) {}
        ws.close(4001, 'auth timeout');
    }, config.authTimeoutMs);

    ws.once('message', (data) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);

        const text = (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).trim().toLowerCase();
        const got = Buffer.from(text, 'utf8');
        const exp = Buffer.from(expected, 'utf8');

        const ok = !REQUIRE_PASSWORD
            || (got.length === exp.length && crypto.timingSafeEqual(got, exp));
        if (!ok) {
            logWarn(`[xdrgtk_bridge] auth failed (${peer})`);
            try { ws.send('a0\n'); } catch (_) {}
            ws.close(4003, 'auth failed');
            return;
        }

        promoteToBridge(ws, peer);
    });

    try {
        ws.send(salt + '\n');
    } catch (err) {
        clearTimeout(timeout);
        logWarn(`[xdrgtk_bridge] failed to send salt (${peer}): ${err.message}`);
        ws.close(1011, 'salt send failed');
    }
}

// ---- WebSocket server + upgrade hook --------------------------------------

const httpServer = pluginsApi.getHttpServer();
if (!httpServer) {
    logError('[xdrgtk_bridge] No httpServer from pluginsApi — bridge not started.');
    module.exports = {};
    return;
}

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request) => {
    const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    logInfo(`[xdrgtk_bridge] incoming WS (${peer})`);

    ws.on('error', (err) => {
        logWarn(`[xdrgtk_bridge] ws error (${peer}): ${err.message}`);
    });

    handleAuth(ws, peer);
});

// Core's upgrade handler in server/index.js always destroys sockets on
// unknown paths. To add our wsPath without conflict, we take ownership of
// the 'upgrade' event: save existing listeners, remove them, then dispatch
// ourselves — our wsPath we handle, everything else we forward to the saved
// listeners so /text, /audio, /rds, /chat, /data_plugins keep working.
const savedUpgradeListeners = httpServer.listeners('upgrade').slice();
httpServer.removeAllListeners('upgrade');

httpServer.on('upgrade', (request, socket, head) => {
    const url = (request.url || '').split('?')[0];
    if (url !== config.wsPath) {
        for (const fn of savedUpgradeListeners) {
            try { fn.call(httpServer, request, socket, head); } catch (err) {
                logWarn('[xdrgtk_bridge] upstream upgrade handler threw: ' + err.message);
            }
        }
        return;
    }

    const serverConfig = pluginsApi.getServerConfig();
    const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
    if (serverConfig && serverConfig.webserver && Array.isArray(serverConfig.webserver.banlist)
        && serverConfig.webserver.banlist.includes(clientIp)) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

logInfo(`[xdrgtk_bridge] WebSocket tunnel registered at path ${config.wsPath} ` +
        `(password check: ${REQUIRE_PASSWORD ? 'required' : 'DISABLED — any password accepted'})`);

module.exports = { wss };
