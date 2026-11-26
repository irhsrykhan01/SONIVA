'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    STICKER_ALIASES,
    findMedia,
    extractText,
    parseCommand,
    quotedMessage,
    senderJid,
    normalizeUserId,
    isOwner,
    numberToJid
} = require('../src/commands');
const { SonivaDatabase, dateKey } = require('../src/database');
const { extractBytesField, readVarint, STICKER_AUDIO_TAG } = require('../src/protocol');
const { isGroupChat } = require('../src/handler');
const { createWatermarkFiles, WATERMARK_TITLE, WATERMARK_LINK } = require('../src/media');

test('generated sticker watermark contains the SONIVA title and official group link', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soniva-watermark-test-'));
    try {
        const filters = createWatermarkFiles(directory);
        assert.match(fs.readFileSync(path.join(directory, 'soniva-watermark-title.txt'), 'utf8'), /Soniva Bot/);
        assert.equal(fs.readFileSync(path.join(directory, 'soniva-watermark-link.txt'), 'utf8'), WATERMARK_LINK);
        assert.match(filters, /drawbox/);
        assert.match(filters, /drawtext/);
        assert.equal(WATERMARK_TITLE, 'Soniva Bot');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SONIVA only accepts group JIDs and silently ignores private or broadcast chats', () => {
    assert.equal(isGroupChat('120363000000000000@g.us'), true);
    assert.equal(isGroupChat('628123456789@s.whatsapp.net'), false);
    assert.equal(isGroupChat('123456789@lid'), false);
    assert.equal(isGroupChat('status@broadcast'), false);
    assert.equal(isGroupChat('123456789@broadcast'), false);
});

test('all sticker aliases parse as one command', () => {
    for (const alias of STICKER_ALIASES) {
        const parsed = parseCommand({ message: { conversation: '.' + alias } });
        assert.equal(parsed.name, alias);
    }
    assert.equal(STICKER_ALIASES.size, 5);
});

test('commands are case-insensitive and accept arguments', () => {
    const parsed = parseCommand({ message: { conversation: '.PREMIUM add 6281234567890 30' } });
    assert.equal(parsed.name, 'premium');
    assert.deepEqual(parsed.args, ['add', '6281234567890', '30']);
    assert.equal(parseCommand({ message: { conversation: 'hello .sticker' } }), null);
});

test('media captions and ephemeral wrappers are detected', () => {
    const message = {
        message: {
            ephemeralMessage: {
                message: {
                    videoMessage: {
                        mimetype: 'video/mp4',
                        caption: '.sticker',
                        seconds: 4
                    }
                }
            }
        }
    };

    assert.equal(findMedia(message).kind, 'video');
    assert.equal(extractText(message), '.sticker');
    assert.equal(parseCommand(message).name, 'sticker');
});

test('image, audio, sticker and document media are classified', () => {
    assert.equal(findMedia({ message: { imageMessage: {} } }).kind, 'image');
    assert.equal(findMedia({ message: { audioMessage: {} } }).kind, 'audio');
    assert.equal(findMedia({ message: { stickerMessage: {} } }).kind, 'sticker');
    assert.equal(findMedia({ message: { documentMessage: { mimetype: 'video/mp4' } } }).kind, 'video');
    assert.equal(findMedia({ message: { documentMessage: { mimetype: 'application/pdf' } } }), null);
});

test('quoted media keeps the destination chat and quoted participant', () => {
    const message = {
        key: { remoteJid: '123@g.us', participant: '628111111111@s.whatsapp.net' },
        message: {
            extendedTextMessage: {
                text: '.addaudio',
                contextInfo: {
                    stanzaId: 'quoted-id',
                    participant: '628222222222@s.whatsapp.net',
                    quotedMessage: { stickerMessage: { isAnimated: false } }
                }
            }
        }
    };

    const quote = quotedMessage(message);
    assert.equal(quote.key.remoteJid, '123@g.us');
    assert.equal(quote.key.participant, '628222222222@s.whatsapp.net');
    assert.equal(quote.key.id, 'quoted-id');
    assert.equal(findMedia(quote).kind, 'sticker');
});

test('sender and owner checks work with device-qualified JIDs', () => {
    const message = {
        key: {
            remoteJid: '123@g.us',
            participant: '628123456789:4@s.whatsapp.net'
        }
    };

    assert.equal(senderJid(message, {}), '628123456789:4@s.whatsapp.net');
    assert.equal(normalizeUserId('628123456789:4@s.whatsapp.net'), '628123456789');
    assert.equal(isOwner('628123456789:4@s.whatsapp.net', '628123456789'), true);
    assert.equal(isOwner('628999999999@s.whatsapp.net', '628123456789'), false);
    assert.equal(numberToJid('628123456789'), '628123456789@s.whatsapp.net');
});

test('protobuf field 26 can be extracted without a generated schema', () => {
    const nested = Buffer.from([0x08, 0x01, 0x12, 0x01, 0x78]);
    const encoded = Buffer.concat([
        Buffer.from([0x08, 0x01]),
        Buffer.from([0xd2, 0x01, nested.length]),
        nested,
        Buffer.from([0x10, 0x01])
    ]);

    assert.deepEqual(extractBytesField(encoded, 26), nested);
    assert.equal(extractBytesField(encoded, 25), null);
    assert.equal(readVarint(Buffer.from([0xd2, 0x01]), 0)[0], 210n);
});

test('malformed protobuf data is rejected', () => {
    assert.throws(() => extractBytesField(Buffer.from([0x00]), 26));
    assert.throws(() => extractBytesField(Buffer.from([0xd2, 0x01, 0x05, 0x01]), 26));
});

test('group feature settings persist and are isolated per group', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soniva-group-db-test-'));
    const db = new SonivaDatabase(path.join(directory, 'test.sqlite'), 'Asia/Jakarta');

    try {
        assert.equal(db.getGroupFeature('111@g.us', 'antilink'), false);
        db.setGroupFeature('111@g.us', 'antilink', true);
        db.setGroupFeature('111@g.us', 'welcome', true);
        assert.equal(db.getGroupFeature('111@g.us', 'antilink'), true);
        assert.equal(db.getGroupFeature('111@g.us', 'welcome'), true);
        assert.deepEqual(new Set(db.getEnabledGroupFeatures('111@g.us')), new Set(['antilink', 'welcome']));
        assert.equal(db.getGroupFeature('222@g.us', 'antilink'), false);
        db.setGroupFeature('111@g.us', 'antilink', false);
        assert.equal(db.getGroupFeature('111@g.us', 'antilink'), false);
        assert.throws(() => db.setGroupFeature('111@g.us', 'unknown', true));
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('daily limits, premium expiry, and owner unlimited access are enforced', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soniva-db-test-'));
    const db = new SonivaDatabase(path.join(directory, 'test.sqlite'), 'Asia/Jakarta');

    try {
        const options = {
            now: Date.UTC(2026, 0, 1, 3, 0, 0),
            freeDailyLimit: 5,
            premiumDailyLimit: 50
        };

        assert.equal(db.getAccess('628111111111', options).remaining, 5);
        db.consumeUsage('628111111111', options.now);
        assert.equal(db.getAccess('628111111111', options).remaining, 4);

        const expiry = db.addPremium('628111111111', 30, options.now);
        const premium = db.getAccess('628111111111', options);
        assert.equal(premium.role, 'premium');
        assert.equal(premium.limit, 50);
        assert.equal(premium.expiresAt, expiry);

        const owner = db.getAccess('628999999999', { ...options, owner: true });
        assert.equal(owner.role, 'owner');
        assert.equal(owner.remaining, Infinity);

        db.removePremium('628111111111');
        assert.equal(db.getAccess('628111111111', options).role, 'free');

        const nextDay = options.now + 86400000;
        assert.equal(db.getUsage('628111111111', nextDay), 0);
        assert.match(dateKey(options.now, 'Asia/Jakarta'), /^\d{4}-\d{2}-\d{2}$/);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
