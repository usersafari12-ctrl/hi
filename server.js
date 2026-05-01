// server.js
const express = require('express');
const WebSocket = require('ws');
const app = express();
app.use(express.json());

const API_KEY = 'coolapikey';
const bots = {};
let botIdCounter = 0;

// ═══ PACKET HELPERS ═══

function buildLagPacket(seq, yaw, pitch, jump) {
    const buf = Buffer.alloc(21);
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>> 8)  & 0xFF;
    buf[4] = (seq >>> 0)  & 0xFF;
    buf[5]=0; buf[6]=0; buf[7]=0; buf[8]=0;
    buf.writeFloatBE(pitch, 9);
    buf.writeFloatBE(yaw,   13);
    buf[17] = 0x7f;
    buf[18] = 0x7f;
    if (jump) { buf[19] = 0x02; buf[20] = 0x00; }
    else       { buf[19] = 0x00; buf[20] = 0x00; }
    return buf;
}

function buildLagSlot(seq, yaw, pitch, slot) {
    const buf = Buffer.alloc(22);
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>> 8)  & 0xFF;
    buf[4] = (seq >>> 0)  & 0xFF;
    buf[5]=0; buf[6]=0; buf[7]=0; buf[8]=0;
    buf.writeFloatBE(pitch, 9);
    buf.writeFloatBE(yaw,   13);
    buf[17] = 0x7f; buf[18] = 0x7f;
    buf[19] = 0x01; buf[20] = 0x00; buf[21] = slot & 0xFF;
    return buf;
}

function buildPillarPacket(seq, yaw, jump, place) {
    const buf = Buffer.alloc(21);
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>> 8)  & 0xFF;
    buf[4] = (seq >>> 0)  & 0xFF;
    buf[5]=0; buf[6]=0; buf[7]=0; buf[8]=0;
    // Pillar: max downward pitch
    buf[9]=0xbf; buf[10]=0xc9; buf[11]=0x0f; buf[12]=0xdb;
    buf.writeFloatBE(yaw, 13);
    buf[17] = 0x7f; buf[18] = 0x7f;
    if (jump)       { buf[19] = 0x02; buf[20] = 0x03; }
    else if (place) { buf[19] = 0x00; buf[20] = 0x00; }
    else            { buf[19] = 0x00; buf[20] = 0x03; }
    return buf;
}

function buildPillarSlot(seq, yaw, slot) {
    const buf = Buffer.alloc(22);
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>> 8)  & 0xFF;
    buf[4] = (seq >>> 0)  & 0xFF;
    buf[5]=0; buf[6]=0; buf[7]=0; buf[8]=0;
    buf[9]=0xbf; buf[10]=0xc9; buf[11]=0x0f; buf[12]=0xdb;
    buf.writeFloatBE(yaw, 13);
    buf[17] = 0x7f; buf[18] = 0x7f;
    buf[19] = 0x01; buf[20] = 0x00; buf[21] = slot & 0xFF;
    return buf;
}

// ═══ BOT FACTORY ═══

function createBot(serverUrl, mode, duration) {
    const id  = ++botIdCounter;
    const bot = {
        id,
        mode,
        ws:           null,
        alive:        false,
        seq:          0,
        yaw:          Math.random() * Math.PI * 2,
        pitch:        (Math.random() - 0.5) * 1.0,
        ht:           null,
        tt:           null,
        killTimer:    null,
        timerStarted: false,
        tickCycle:    0,
        pillarYaw:    Math.random() * Math.PI * 2,
    };

    const HANDSHAKES = {
        lag:    Buffer.from([0x03, 0x87, 0x05, 0x02, 0x06]),
        pillar: Buffer.from([0x03, 0x87, 0x03, 0x02, 0x05]),
    };

    const HEARTBEAT_MS = { lag: 2500, pillar: 50 };
    const TICK_MS      = 50;
    const JUMP_EVERY   = { lag: 20, pillar: 60 };
    const SLOTS        = { lag: 1, pillar: 3 };

    // ── Tick functions ──
    function tickLag() {
        if (!bot.ws || bot.ws.readyState !== 1) return;
        bot.yaw   += (Math.random() - 0.5) * 0.15;
        bot.pitch += (Math.random() - 0.5) * 0.1;
        if (bot.pitch >  1.5) bot.pitch =  1.5;
        if (bot.pitch < -1.5) bot.pitch = -1.5;
        bot.tickCycle++;
        const jump = (bot.tickCycle % JUMP_EVERY.lag === 1);
        const pkt  = buildLagPacket(bot.seq, bot.yaw, bot.pitch, jump);
        bot.seq++;
        bot.ws.send(pkt);
    }

    function tickPillar() {
        if (!bot.ws || bot.ws.readyState !== 1) return;
        bot.pillarYaw += 0.008;
        if (bot.pillarYaw > Math.PI * 2) bot.pillarYaw -= Math.PI * 2;
        bot.tickCycle++;
        const jump  = (bot.tickCycle % JUMP_EVERY.pillar === 1);
        const place = (!jump && bot.tickCycle % 2 === 0);
        const pkt   = buildPillarPacket(bot.seq, bot.pillarYaw, jump, place);
        bot.seq++;
        bot.ws.send(pkt);
    }

    const tick = mode === 'pillar' ? tickPillar : tickLag;

    // ── WebSocket ──
    try {
        bot.ws = new WebSocket(serverUrl);
        bot.ws.binaryType = 'nodebuffer';
    } catch (e) {
        console.error(`Bot #${id} WS error: ${e.message}`);
        return bot;
    }

    bot.ws.on('open', () => {
        bot.alive = true;
        bot.seq   = 0;
        bot.ws.send(HANDSHAKES[mode]);
        console.log(`Bot #${id} [${mode}] connected → ${serverUrl}`);

        bot.ht = setInterval(() => {
            if (bot.ws && bot.ws.readyState === 1)
                bot.ws.send(Buffer.from([0x06]));
        }, HEARTBEAT_MS[mode]);

        setTimeout(() => { bot.tt = setInterval(tick, TICK_MS); }, 600);
    });

    bot.ws.on('message', (data) => {
        if (bot.timerStarted) return;
        if (!(data instanceof Buffer)) return;
        bot.timerStarted = true;

        // Send slot select
        const slotPkt = mode === 'pillar'
            ? buildPillarSlot(bot.seq, bot.pillarYaw, SLOTS.pillar)
            : buildLagSlot(bot.seq, bot.yaw, bot.pitch, SLOTS.lag);
        bot.seq++;
        bot.ws.send(slotPkt);

        console.log(`Bot #${id} joined — ${duration}s timer`);

        // Auto-kill timer
        bot.killTimer = setTimeout(() => {
            console.log(`Bot #${id} timer expired — killing`);
            killBot(id, true); // true = cycle (redeploy)
        }, duration * 1000);
    });

    bot.ws.on('error', (e) => {
        console.error(`Bot #${id} error: ${e.message}`);
    });

    bot.ws.on('close', (code) => {
        bot.alive = false;
        clearInterval(bot.ht);
        clearInterval(bot.tt);
        clearTimeout(bot.killTimer);
        console.log(`Bot #${id} closed (${code})`);
        delete bots[id];
    });

    bot.kill = () => {
        clearInterval(bot.ht);
        clearInterval(bot.tt);
        clearTimeout(bot.killTimer);
        if (bot.ws) bot.ws.close();
    };

    bots[id] = bot;
    return bot;
}

// ═══ CYCLE / KILL ═══

// Track active sessions so cycle knows what to redeploy
const sessions = {};
let sessionCounter = 0;

function killBot(id, cycle) {
    const bot = bots[id];
    if (!bot) return;
    const { mode, serverUrl, duration, sessionId } = bot;
    bot.kill();
    // onclose will delete from bots{}

    if (cycle && sessions[sessionId] && sessions[sessionId].active) {
        console.log(`Cycle: redeploying bot for session ${sessionId}`);
        setTimeout(() => {
            const nb = createBot(serverUrl, mode, duration);
            nb.serverUrl  = serverUrl;
            nb.duration   = duration;
            nb.sessionId  = sessionId;
        }, 500);
    }
}

// ═══ ROUTES ═══

// Auth middleware
function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// POST /deploy
// Body: { server, mode, count, duration, apikey }
// mode: "lag" | "pillar"
app.post('/deploy', auth, (req, res) => {
    const { server, mode, count, duration } = req.body;

    if (!server || !server.startsWith('wss://')) {
        return res.status(400).json({ error: 'Invalid server URL' });
    }
    if (!['lag', 'pillar'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be "lag" or "pillar"' });
    }

    const botCount = Math.max(1, Math.min(50, parseInt(count)  || 1));
    const botSecs  = Math.max(1, Math.min(600, parseInt(duration) || 35));

    const sessionId = ++sessionCounter;
    sessions[sessionId] = { active: true, mode, server, duration: botSecs };

    const ids = [];
    for (let i = 0; i < botCount; i++) {
        setTimeout(() => {
            const bot      = createBot(server, mode, botSecs);
            bot.serverUrl  = server;
            bot.duration   = botSecs;
            bot.sessionId  = sessionId;
            ids.push(bot.id);
        }, i * 250);
    }

    console.log(`Session ${sessionId}: deploying ${botCount}x ${mode} → ${server} for ${botSecs}s (cycle ON)`);
    res.json({
        ok:        true,
        sessionId,
        mode,
        count:     botCount,
        duration:  botSecs,
        server,
        message:   `Deploying ${botCount} ${mode} bot(s) for ${botSecs}s with cycle enabled`,
    });
});

// POST /kill
// Body: { sessionId } — kills all bots in a session and disables cycle
// Or body: {} — kills everything
app.post('/kill', auth, (req, res) => {
    const { sessionId } = req.body;

    if (sessionId) {
        if (sessions[sessionId]) sessions[sessionId].active = false;
        let killed = 0;
        Object.values(bots).forEach(b => {
            if (b.sessionId === sessionId) { b.kill(); killed++; }
        });
        console.log(`Kill session ${sessionId}: ${killed} bot(s) stopped`);
        return res.json({ ok: true, killed, sessionId });
    }

    // Kill everything
    Object.keys(sessions).forEach(sid => { sessions[sid].active = false; });
    const count = Object.keys(bots).length;
    Object.values(bots).forEach(b => b.kill());
    console.log(`Kill all: ${count} bot(s) stopped`);
    res.json({ ok: true, killed: count });
});

// GET /status
app.get('/status', auth, (req, res) => {
    const active = Object.values(bots).filter(b => b.alive).length;
    res.json({
        bots:     Object.keys(bots).length,
        active,
        sessions: Object.keys(sessions).length,
    });
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VBM server running on port ${PORT}`);
});
