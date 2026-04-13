// serialbridge_server.js
// Tunnels the tuner's serial/xdrd stream over a WebSocket on the webserver's
// existing HTTP(S) port, so it works through any HTTP reverse proxy.
//
// Endpoint: ws[s]://<host>:<webserverPort><wsPath>   (default path: /tuner)
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
// If password is empty in config.json, the auth handshake is skipped.
//
// Config: plugins/serialbridge/config.json (auto-created on first run).

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

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
    wsPath: '/xdrgtk',
    password: '',
    authTimeoutMs: 5000
};

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
            logInfo(`[serialbridge] Created default config at ${CONFIG_PATH}`);
            return { ...DEFAULT_CONFIG };
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (err) {
        logError('[serialbridge] Failed to read config, using defaults: ' + err.message);
        return { ...DEFAULT_CONFIG };
    }
}

const config = loadConfig();
const AUTH_ENABLED = typeof config.password === 'string' && config.password.length > 0;

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

function forwardCommandsToRadio(text, state) {
    // xdrd protocol: newline-terminated single-letter commands.
    // sendPrivilegedCommand appends '\n' itself, so strip it here.
    state.cmdBuf += text;
    while (true) {
        const nl = state.cmdBuf.indexOf('\n');
        if (nl < 0) break;
        const line = state.cmdBuf.slice(0, nl).replace(/\r$/, '');
        state.cmdBuf = state.cmdBuf.slice(nl + 1);
        if (line.length === 0) continue;
        pluginsApi.sendPrivilegedCommand(line, true);
    }
    if (state.cmdBuf.length > 8192) state.cmdBuf = '';
}

function sendPostAuthBanner(ws) {
    const count = clients.size;
    ws.send(`o1,${count}\n`);
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
    const state = { cmdBuf: '' };
    logInfo(`[serialbridge] client authenticated (${peer}) [${clients.size}]`);

    try {
        sendPostAuthBanner(ws);
    } catch (err) {
        logWarn(`[serialbridge] failed to send banner (${peer}): ${err.message}`);
    }

    ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        forwardCommandsToRadio(text, state);
    });

    ws.on('close', () => {
        clients.delete(ws);
        logInfo(`[serialbridge] client disconnected (${peer}) [${clients.size}]`);
    });
}

function handleAuth(ws, peer) {
    const salt = generateSalt();
    const expected = expectedHash(salt, config.password);
    let done = false;

    const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        logWarn(`[serialbridge] auth timeout (${peer})`);
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

        const ok = got.length === exp.length && crypto.timingSafeEqual(got, exp);
        if (!ok) {
            logWarn(`[serialbridge] auth failed (${peer})`);
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
        logWarn(`[serialbridge] failed to send salt (${peer}): ${err.message}`);
        ws.close(1011, 'salt send failed');
    }
}

// ---- WebSocket server + upgrade hook --------------------------------------

const httpServer = pluginsApi.getHttpServer();
if (!httpServer) {
    logError('[serialbridge] No httpServer from pluginsApi — bridge not started.');
    module.exports = {};
    return;
}

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request) => {
    const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    logInfo(`[serialbridge] incoming WS (${peer})`);

    ws.on('error', (err) => {
        logWarn(`[serialbridge] ws error (${peer}): ${err.message}`);
    });

    if (AUTH_ENABLED) {
        handleAuth(ws, peer);
    } else {
        promoteToBridge(ws, peer);
    }
});

// Core's upgrade handler in server/index.js always destroys sockets on
// unknown paths. To add /tuner without conflict, we take ownership of the
// 'upgrade' event: save existing listeners, remove them, then dispatch
// ourselves — /tuner we handle, everything else we forward to the saved
// listeners so /text, /audio, /rds, /chat, /data_plugins keep working.
const savedUpgradeListeners = httpServer.listeners('upgrade').slice();
httpServer.removeAllListeners('upgrade');

httpServer.on('upgrade', (request, socket, head) => {
    const url = (request.url || '').split('?')[0];
    if (url !== config.wsPath) {
        for (const fn of savedUpgradeListeners) {
            try { fn.call(httpServer, request, socket, head); } catch (err) {
                logWarn('[serialbridge] upstream upgrade handler threw: ' + err.message);
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

logInfo(`[serialbridge] WebSocket tunnel registered at path ${config.wsPath} ` +
        `(auth: ${AUTH_ENABLED ? 'enabled' : 'DISABLED — set password in config.json'})`);

module.exports = { wss };
