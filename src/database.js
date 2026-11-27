'use strict';

const fs = require('node:fs');
const path = require('node:path');

class SonivaDatabase {
    constructor(databasePath) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.db = new (require('node:sqlite').DatabaseSync)(databasePath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        // Remove legacy quota and premium records from older SONIVA installations.
        this.db.exec('DROP TABLE IF EXISTS daily_usage; DROP TABLE IF EXISTS premiums;');
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS sound_stickers (' +
            'file_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);'
        );
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS channel_settings (' +
            'user_id TEXT PRIMARY KEY, channel_jid TEXT NOT NULL, channel_name TEXT NOT NULL, updated_at INTEGER NOT NULL);'
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

    getSavedChannel(userId) {
        return this.db.prepare(
            'SELECT channel_jid AS id, channel_name AS name FROM channel_settings WHERE user_id = ?'
        ).get(String(userId)) || null;
    }

    setSavedChannel(userId, metadata) {
        if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) {
            throw new Error('Invalid WhatsApp Channel JID.');
        }
        this.db.prepare(
            'INSERT INTO channel_settings (user_id, channel_jid, channel_name, updated_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(user_id) DO UPDATE SET channel_jid = excluded.channel_jid, channel_name = excluded.channel_name, updated_at = excluded.updated_at'
        ).run(String(userId), String(metadata.id), String(metadata.name || 'WhatsApp Channel'), Date.now());
        return this.getSavedChannel(userId);
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

module.exports = { SonivaDatabase };
