'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(filePath = path.resolve(process.cwd(), '.env')) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

function positiveInteger(value, fallback, maximum = 1000000) {
    const number = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isSafeInteger(number) || number < 1) return fallback;
    return Math.min(number, maximum);
}

function loadConfig(env = process.env, root = process.cwd()) {
    const ownerNumber = String(env.SONIVA_OWNER || '').replace(/\D/g, '');
    return Object.freeze({
        ownerNumber,
        maxMediaBytes: positiveInteger(env.MAX_MEDIA_MB, 64, 200) * 1024 * 1024,
        maxStickerSeconds: positiveInteger(env.MAX_STICKER_SECONDS, 10, 60),
        maxStickerBytes: positiveInteger(env.MAX_STICKER_BYTES, 500000, 500000),
        audioBitrate: /^[0-9]{2,3}k$/i.test(String(env.AUDIO_BITRATE || '32k'))
            ? String(env.AUDIO_BITRATE || '32k') : '32k',
        pendingTtlMs: positiveInteger(env.MAX_PENDING_MINUTES, 8, 60) * 60 * 1000,
        timeZone: String(env.TIME_ZONE || 'Asia/Jakarta'),
        authDir: path.resolve(root, env.AUTH_DIR || 'auth_info'),
        databasePath: path.resolve(root, env.DATABASE_PATH || '.data/soniva.sqlite'),
        pairingNumber: String(env.PAIRING_NUMBER || '').replace(/\D/g, '')
    });
}

module.exports = { loadEnvFile, loadConfig, positiveInteger };
