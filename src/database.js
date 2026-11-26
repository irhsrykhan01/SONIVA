'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function userKey(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '') ||
        String(value || '').split('@')[0].split(':')[0];
}

function dateKey(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(now));

    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return values.year + '-' + values.month + '-' + values.day;
}

class SonivaDatabase {
    constructor(databasePath, timeZone = 'Asia/Jakarta') {
        this.timeZone = timeZone;
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.db = new DatabaseSync(databasePath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS daily_usage (' +
            'user_id TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, ' +
            'PRIMARY KEY (user_id, day));'
        );
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS premiums (' +
            'user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);'
        );
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS sound_stickers (' +
            'file_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);'
        );
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS group_features (' +
            'chat_id TEXT NOT NULL, feature TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, ' +
            'updated_at INTEGER NOT NULL, PRIMARY KEY (chat_id, feature));'
        );
    }

    getGroupFeature(chatId, feature) {
        const row = this.db.prepare(
            'SELECT enabled FROM group_features WHERE chat_id = ? AND feature = ?'
        ).get(String(chatId), String(feature));
        return Boolean(row?.enabled);
    }

    setGroupFeature(chatId, feature, enabled) {
        const allowed = new Set(['antilink', 'antibot', 'antispam', 'welcome', 'goodbye']);
        if (!allowed.has(String(feature))) throw new Error('Unknown group feature: ' + feature);
        this.db.prepare(
            'INSERT INTO group_features (chat_id, feature, enabled, updated_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(chat_id, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
        ).run(String(chatId), String(feature), enabled ? 1 : 0, Date.now());
        return Boolean(enabled);
    }

    getEnabledGroupFeatures(chatId) {
        return this.db.prepare(
            'SELECT feature FROM group_features WHERE chat_id = ? AND enabled = 1'
        ).all(String(chatId)).map(row => row.feature);
    }

    getPremiumUntil(userId) {
        const row = this.db.prepare(
            'SELECT expires_at FROM premiums WHERE user_id = ?'
        ).get(userKey(userId));
        return row ? Number(row.expires_at) : 0;
    }

    isPremium(userId, now = Date.now()) {
        return this.getPremiumUntil(userId) > now;
    }

    getUsage(userId, now = Date.now()) {
        const row = this.db.prepare(
            'SELECT used FROM daily_usage WHERE user_id = ? AND day = ?'
        ).get(userKey(userId), dateKey(now, this.timeZone));
        return row ? Number(row.used) : 0;
    }

    getAccess(userId, options = {}) {
        const now = options.now ?? Date.now();
        if (options.owner) {
            return {
                role: 'owner',
                used: 0,
                limit: Infinity,
                remaining: Infinity,
                expiresAt: null
            };
        }

        const premiumUntil = this.getPremiumUntil(userId);
        const premium = premiumUntil > now;
        const limit = premium
            ? options.premiumDailyLimit
            : options.freeDailyLimit;
        const used = this.getUsage(userId, now);

        return {
            role: premium ? 'premium' : 'free',
            used,
            limit,
            remaining: Math.max(0, limit - used),
            expiresAt: premium ? premiumUntil : null
        };
    }

    consumeUsage(userId, now = Date.now()) {
        const key = userKey(userId);
        const day = dateKey(now, this.timeZone);
        this.db.prepare(
            'INSERT INTO daily_usage (user_id, day, used) VALUES (?, ?, 1) ' +
            'ON CONFLICT(user_id, day) DO UPDATE SET used = used + 1'
        ).run(key, day);
        return this.getUsage(key, now);
    }

    addPremium(userId, days = 30, now = Date.now()) {
        const key = userKey(userId);
        if (!key) throw new Error('Target user is invalid.');

        const duration = Math.max(1, Math.min(3650, Number(days) || 30)) * 86400000;
        const current = this.getPremiumUntil(key);
        const expiresAt = Math.max(now, current) + duration;

        this.db.prepare(
            'INSERT INTO premiums (user_id, expires_at, created_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at'
        ).run(key, expiresAt, now);

        return expiresAt;
    }

    removePremium(userId) {
        const result = this.db.prepare(
            'DELETE FROM premiums WHERE user_id = ?'
        ).run(userKey(userId));
        return Number(result.changes) > 0;
    }

    listPremium(now = Date.now()) {
        return this.db.prepare(
            'SELECT user_id, expires_at FROM premiums WHERE expires_at > ? ORDER BY expires_at ASC'
        ).all(now).map((row) => ({
            userId: row.user_id,
            expiresAt: Number(row.expires_at)
        }));
    }

    rememberSoundSticker(fileHash, now = Date.now()) {
        if (!fileHash) return;
        this.db.prepare(
            'INSERT OR REPLACE INTO sound_stickers (file_hash, created_at) VALUES (?, ?)'
        ).run(String(fileHash), now);
    }

    isKnownSoundSticker(fileHash) {
        if (!fileHash) return false;
        return Boolean(this.db.prepare(
            'SELECT 1 AS found FROM sound_stickers WHERE file_hash = ?'
        ).get(String(fileHash)));
    }

    close() {
        this.db.close();
    }
}

module.exports = { SonivaDatabase, dateKey, userKey };
