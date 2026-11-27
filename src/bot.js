'use strict';

const { rm } = require('node:fs/promises');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    proto
} = require('@whiskeysockets/baileys');

const { SonivaDatabase } = require('./database');
const { assertMediaTools } = require('./media');
const { installStickerAudioSupport } = require('./protocol');
const { createMessageHandler, isGroupChat } = require('./handler');
const { parseCommand } = require('./commands');
const { handleParticipantsUpdate, applyMessageSignals, completeMessageSignals } = require('./group-features');

async function startBot(config) {
    await assertMediaTools();
    installStickerAudioSupport(proto);

    const database = new SonivaDatabase(config.databasePath, config.timeZone);
    if (!config.ownerNumber) {
        console.warn('[SONIVA] SONIVA_OWNER is empty. Owner-specific group administration privileges are disabled.');
    }

    let reconnectTimer = null;
    let stopped = false;

    async function connect() {
        if (stopped) return;

        const auth = await useMultiFileAuthState(config.authDir);
        let versionOptions = {};
        try {
            const latest = await fetchLatestBaileysVersion();
            if (latest?.version) versionOptions = { version: latest.version };
        } catch (error) {
            console.warn('[SONIVA] Could not fetch the latest WhatsApp Web version:', error.message);
        }

        const sock = makeWASocket({
            ...versionOptions,
            auth: auth.state,
            logger: pino({ level: 'silent' }),
            browser: ['SONIVA', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: true
        });

        let reconnectScheduled = false;
        let pairingRequested = false;
        let messageChain = Promise.resolve();
        const seen = new Set();

        sock.ev.on('creds.update', auth.saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && config.pairingNumber && !pairingRequested) {
                pairingRequested = true;
                try {
                    const code = await sock.requestPairingCode(config.pairingNumber);
                    console.log('[SONIVA] Pairing code: ' + code);
                    console.log('[SONIVA] WhatsApp > Linked devices > Link a device > Link with phone number instead.');
                } catch (error) {
                    console.error('[SONIVA] Pairing-code request failed:', error.message);
                }
            } else if (qr && !config.pairingNumber) {
                console.log('\n[SONIVA] Scan this QR with WhatsApp > Linked devices > Link a device:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                console.log('[SONIVA] Connected successfully.');
                sock.sendPresenceUpdate('available').catch(() => {});
                console.log('[SONIVA] Sticker creation: unlimited for all users; no premium tiers.');
                console.log('[SONIVA] Commands: .sticker, .addaudio, .limit, .help');
            }

            if (connection === 'close' && !reconnectScheduled && !stopped) {
                const status = lastDisconnect?.error?.output?.statusCode;
                reconnectScheduled = true;

                if (status === DisconnectReason.loggedOut) {
                    console.warn('[SONIVA] WhatsApp session was logged out. Clearing only saved WhatsApp credentials...');
                    try {
                        await rm(config.authDir, { recursive: true, force: true });
                    } catch (error) {
                        console.error('[SONIVA] Could not clear the logged-out WhatsApp session:', error.message);
                        return;
                    }

                    console.log('[SONIVA] Old session cleared. A fresh login screen will be generated shortly.');
                    reconnectTimer = setTimeout(() => {
                        connect().catch((error) => console.error('[SONIVA] Fresh login startup failed:', error));
                    }, 2000);
                    reconnectTimer.unref?.();
                    return;
                }

                console.warn('[SONIVA] Connection closed (code ' + (status ?? 'unknown') + '). Reconnecting in 5 seconds...');
                reconnectTimer = setTimeout(() => {
                    connect().catch((error) => console.error('[SONIVA] Reconnect failed:', error));
                }, 5000);
                reconnectTimer.unref?.();
            }
        });

        const handleMessage = createMessageHandler({ sock, config, database });
        sock.ev.on('group-participants.update', (update) => {
            handleParticipantsUpdate({ sock, database, update, ownerNumber: config.ownerNumber })
                .catch(error => console.error('[SONIVA] Group participant handler error:', error.message));
        });
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const message of messages || []) {
                // Drop private/broadcast chats before read receipts, reactions, or command handling.
                if (!isGroupChat(message?.key?.remoteJid)) continue;
                const id = message?.key?.id;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                if (seen.size > 1000) seen.delete(seen.values().next().value);

                messageChain = messageChain
                    .then(async () => {
                        const isCommand = Boolean(parseCommand(message));
                        await applyMessageSignals(sock, message, isCommand);
                        try {
                            await handleMessage(message);
                        } finally {
                            await completeMessageSignals(sock, message, isCommand);
                        }
                    })
                    .catch((error) => console.error('[SONIVA] Message handler error:', error));
            }
        });
    }

    await connect();

    const shutdown = () => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
            database.close();
        } catch {
            // The database may already be closed.
        }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return { database, shutdown };
}

module.exports = { startBot };
