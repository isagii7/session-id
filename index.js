const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sessions = new Map();

// Generate unique session folder name
function genSessionId() {
    return 'nexty~' + uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase();
}

// Encode creds to base64
function encodeCreds(sessionPath) {
    const creds = fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf8');
    return 'NEXTY~' + Buffer.from(creds).toString('base64');
}

app.post('/pair', async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });

    const cleanNumber = number.replace(/[^0-9]/g, '');
    const sessionId = genSessionId();
    const sessionPath = path.join(__dirname, 'temp_sessions', sessionId);

    fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Nexty Bot', 'Chrome', '1.0.0']
        });

        sessions.set(sessionId, { sock, sessionPath, number: cleanNumber, resolved: false });

        // Wait for socket to register then request pairing code
        await new Promise(r => setTimeout(r, 1500));

        const code = await sock.requestPairingCode(cleanNumber);
        const formatted = code.match(/.{1,4}/g).join('-');

        res.json({ code: formatted, sessionId });

        // Handle connection
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                await saveCreds();

                const sessionData = sessions.get(sessionId);
                if (sessionData && !sessionData.resolved) {
                    sessionData.resolved = true;

                    const encodedSession = encodeCreds(sessionPath);

                    // Send session to user's WhatsApp
                    await sock.sendMessage(cleanNumber + '@s.whatsapp.net', {
                        text: `╔══════════════════╗\n║   *NEXTY SESSION*   ║\n╚══════════════════╝\n\n*Session ID:*\n\n${encodedSession}\n\n*Instructions:*\n1. Copy the session above\n2. Go to Heroku → Config Vars\n3. Set *SESSION* = (paste here)\n4. Restart your bot\n\n> *Nexty Bot* • Session Generator`
                    });

                    // Cleanup after 30s
                    setTimeout(() => {
                        try {
                            sock.end();
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                            sessions.delete(sessionId);
                        } catch (_) {}
                    }, 30000);
                }
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    // ignore reconnect
                }
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    sessions.delete(sessionId);
                } catch (_) {}
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(err);
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
        res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

app.get('/status/:sessionId', (req, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s) return res.json({ status: 'done' });
    res.json({ status: s.resolved ? 'connected' : 'waiting' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexty Session Generator running on port ${PORT}`));
