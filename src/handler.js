'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const {
    STICKER_ALIASES,
    findMedia,
    parseCommand,
    quotedMessage,
    senderJid,
    normalizeUserId,
    isOwner,
    numberToJid,
    contextInfo
} = require('./commands');
const { probeMedia, createSoundStickerAssets } = require('./media');
const { sendSoundSticker, stickerAlreadyHasAudio, stickerHash } = require('./protocol');
const { handleGroupCommand, handleGroupMessage } = require('./group-features');

function pendingKey(chat, sender) {
    return String(chat) + '|' + String(sender);
}

function sendText(sock, chat, text, quoted) {
    const options = quoted ? { quoted } : {};
    return sock.sendMessage(chat, { text }, options);
}

function accessFor(context, sender, owner) {
    return context.database.getAccess(sender, {
        owner,
        freeDailyLimit: context.config.freeDailyLimit,
        premiumDailyLimit: context.config.premiumDailyLimit
    });
}

async function requireAvailableLimit(context, message, sender, owner) {
    const access = accessFor(context, sender, owner);
    if (access.remaining > 0 || owner) return true;

    await sendText(
        context.sock,
        message.key.remoteJid,
        'Limit harian kamu sudah habis (' + access.used + '/' + access.limit + '). ' +
        'Coba lagi setelah reset harian atau gunakan akses premium.',
        message
    );
    return false;
}

function clearPending(context, key) {
    const entry = context.pending.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    context.pending.delete(key);
    return entry || null;
}

function setPending(context, chat, sender, details) {
    const key = pendingKey(chat, sender);
    clearPending(context, key);

    const entry = {
        ...details,
        chat,
        sender,
        createdAt: Date.now(),
        timer: null
    };

    entry.timer = setTimeout(() => {
        if (context.pending.get(key) !== entry) return;
        context.pending.delete(key);
        sendText(
            context.sock,
            chat,
            'Sesi pembuatan stiker sudah kedaluwarsa. Kirim command .sticker untuk memulai lagi.'
        ).catch((error) => console.error('[SONIVA] Pending-session notice failed:', error.message));
    }, context.config.pendingTtlMs);
    entry.timer.unref?.();

    context.pending.set(key, entry);
    return entry;
}

async function downloadToFile(sock, message, filePath, config) {
    const data = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
        }
    );

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buffer.length) throw new Error('WhatsApp returned an empty media file.');
    if (buffer.length > config.maxMediaBytes) {
        throw new Error('Media exceeds the configured limit of ' +
            Math.round(config.maxMediaBytes / 1024 / 1024) + ' MB.');
    }

    fs.writeFileSync(filePath, buffer, { flag: 'w' });
    return buffer.length;
}

function accessLabel(access) {
    if (access.role === 'owner') return 'Owner — unlimited';
    return access.role.toUpperCase() + ' — ' + access.used + '/' + access.limit +
        ' used, ' + access.remaining + ' remaining';
}

async function handleLimit(context, message, sender, owner) {
    const access = accessFor(context, sender, owner);
    const resetHint = 'Kuota direset setiap hari menurut zona waktu ' + context.config.timeZone + '.';
    await sendText(context.sock, message.key.remoteJid, accessLabel(access) + '\n' + resetHint, message);
}

async function handlePremium(context, message, command, owner) {
    if (!owner) {
        await sendText(context.sock, message.key.remoteJid, 'Command ini khusus owner.', message);
        return;
    }

    const action = (command.args[0] || '').toLowerCase();
    if (action === 'list') {
        const entries = context.database.listPremium();
        if (!entries.length) {
            await sendText(context.sock, message.key.remoteJid, 'Belum ada pengguna premium aktif.', message);
            return;
        }

        const lines = entries.map((entry, index) => {
            const expires = new Date(entry.expiresAt).toLocaleString('id-ID', {
                timeZone: context.config.timeZone,
                dateStyle: 'medium',
                timeStyle: 'short'
            });
            return (index + 1) + '. ' + entry.userId + ' — sampai ' + expires;
        });

        await sendText(context.sock, message.key.remoteJid, 'Premium aktif:\n' + lines.join('\n'), message);
        return;
    }

    const mentions = contextInfo(message)?.mentionedJid || [];
    const numericTarget = command.args.slice(1).find((arg) => /^\+?\d{8,15}$/.test(arg));
    const target = mentions[0]
        ? normalizeUserId(mentions[0])
        : normalizeUserId(numberToJid(numericTarget));

    if (!target) {
        await sendText(
            context.sock,
            message.key.remoteJid,
            'Format owner:\n.premium add 628xxxxxxxxxx 30\n.premium remove 628xxxxxxxxxx\n.premium list\nKamu juga bisa mention pengguna.',
            message
        );
        return;
    }

    if (action === 'add') {
        const dayArgument = command.args.slice(1).map(Number)
            .find((value) => Number.isInteger(value) && value >= 1 && value <= 3650);
        const days = dayArgument || 30;
        const expiresAt = context.database.addPremium(target, days);
        const date = new Date(expiresAt).toLocaleString('id-ID', {
            timeZone: context.config.timeZone,
            dateStyle: 'medium',
            timeStyle: 'short'
        });
        await sendText(
            context.sock,
            message.key.remoteJid,
            'Premium berhasil diaktifkan untuk ' + target + ' selama ' + days + ' hari. Berakhir: ' + date,
            message
        );
        return;
    }

    if (action === 'remove' || action === 'del' || action === 'delete') {
        const removed = context.database.removePremium(target);
        await sendText(
            context.sock,
            message.key.remoteJid,
            removed ? 'Premium ' + target + ' berhasil dihapus.' : target + ' tidak memiliki premium aktif.',
            message
        );
        return;
    }

    await sendText(
        context.sock,
        message.key.remoteJid,
        'Format owner:\n.premium add 628xxxxxxxxxx 30\n.premium remove 628xxxxxxxxxx\n.premium list',
        message
    );
}

async function promptForAudio(context, message) {
    await sendText(
        context.sock,
        message.key.remoteJid,
        'Kirim audio sekarang. SONIVA akan menggabungkannya dengan media tadi.',
        message
    );
}

async function promptForVisual(context, message) {
    await sendText(
        context.sock,
        message.key.remoteJid,
        'Sekarang kirim foto atau video untuk dijadikan tampilan Sound Sticker.',
        message
    );
}

async function createStickerFromMessages(context, details) {
    const {
        chat,
        sender,
        owner,
        visualMessage,
        audioMessage,
        quotedMessage: replyTo,
        directVideo
    } = details;

    const access = accessFor(context, sender, owner);
    if (!owner && access.remaining <= 0) {
        await sendText(
            context.sock,
            chat,
            'Limit harian kamu sudah habis (' + access.used + '/' + access.limit + ').',
            replyTo
        );
        return;
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniva-'));
    const visualInfo = findMedia(visualMessage);

    try {
        if (!visualInfo || !['image', 'video', 'sticker'].includes(visualInfo.kind)) {
            throw new Error('Pilih foto, video, atau stiker yang valid.');
        }

        const visualPath = path.join(workDir, 'visual.media');
        await downloadToFile(context.sock, visualMessage, visualPath, context.config);

        let audioPath = '';
        let useVideoAudio = false;

        if (audioMessage) {
            audioPath = path.join(workDir, 'source-audio.media');
            await downloadToFile(context.sock, audioMessage, audioPath, context.config);
        } else if (visualInfo.kind === 'video' && directVideo) {
            const videoInfo = await probeMedia(visualPath);
            if (!videoInfo.hasAudio) {
                setPending(context, chat, sender, {
                    action: 'sticker',
                    stage: 'await-audio',
                    visualMessage
                });
                await promptForAudio(context, visualMessage);
                return;
            }
            audioPath = visualPath;
            useVideoAudio = true;
        } else {
            throw new Error('Audio belum diterima. Kirim audio untuk melanjutkan.');
        }

        const assets = await createSoundStickerAssets({
            visualPath,
            visualType: visualInfo.kind,
            stickerAnimated: Boolean(visualInfo.payload?.isAnimated),
            audioPath,
            workDir,
            maxSeconds: context.config.maxStickerSeconds,
            maxBytes: context.config.maxStickerBytes,
            audioBitrate: context.config.audioBitrate
        });

        const sentHash = await sendSoundSticker(
            context.sock,
            chat,
            assets,
            replyTo || visualMessage
        );

        context.database.rememberSoundSticker(sentHash);
        if (!owner) context.database.consumeUsage(sender);

        console.log(
            '[SONIVA] Sound Sticker sent | user=' + sender +
            ' | duration=' + assets.duration.toFixed(2) + 's' +
            ' | WebP=' + Math.ceil(assets.stickerBytes / 1024) + 'KB' +
            ' | fps=' + assets.fps +
            ' | quality=' + assets.quality +
            ' | audio=' + (useVideoAudio ? 'video track' : 'separate audio')
        );
    } catch (error) {
        console.error('[SONIVA] Sticker generation failed:', error);
        await sendText(
            context.sock,
            chat,
            'SONIVA gagal membuat Sound Sticker: ' + error.message +
            '\nLimit tidak dipotong karena proses belum berhasil.',
            replyTo || visualMessage
        );
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

async function beginStickerCommand(context, message, sender, owner) {
    if (!(await requireAvailableLimit(context, message, sender, owner))) return;

    const quoted = quotedMessage(message);
    const source = findMedia(message) ? message : quoted;
    const media = source ? findMedia(source) : null;

    if (!media) {
        await sendText(
            context.sock,
            message.key.remoteJid,
            'Kirim foto/video/audio dengan caption .sticker, atau balas media tersebut dengan .sticker.',
            message
        );
        return;
    }

    if (media.kind === 'audio') {
        setPending(context, message.key.remoteJid, sender, {
            action: 'sticker',
            stage: 'await-media',
            audioMessage: source
        });
        await promptForVisual(context, message);
        return;
    }

    if (media.kind === 'image') {
        setPending(context, message.key.remoteJid, sender, {
            action: 'sticker',
            stage: 'await-audio',
            visualMessage: source
        });
        await promptForAudio(context, source);
        return;
    }

    if (media.kind === 'video') {
        await createStickerFromMessages(context, {
            chat: message.key.remoteJid,
            sender,
            owner,
            visualMessage: source,
            audioMessage: null,
            quotedMessage: message,
            directVideo: true
        });
        return;
    }

    if (media.kind === 'sticker') {
        await sendText(
            context.sock,
            message.key.remoteJid,
            'Untuk menambahkan suara ke stiker yang sudah ada, balas stikernya dengan .addaudio.',
            message
        );
        return;
    }

    await sendText(context.sock, message.key.remoteJid, 'Jenis media ini belum didukung.', message);
}

async function beginAddAudioCommand(context, message, sender, owner) {
    if (!(await requireAvailableLimit(context, message, sender, owner))) return;

    const quoted = quotedMessage(message);
    const sticker = quoted ? findMedia(quoted) : null;

    if (!sticker || sticker.kind !== 'sticker') {
        await sendText(
            context.sock,
            message.key.remoteJid,
            'Balas stiker WhatsApp biasa dengan command .addaudio.',
            message
        );
        return;
    }

    if (stickerAlreadyHasAudio(sticker.payload, context.database)) {
        await sendText(context.sock, message.key.remoteJid, 'Stiker itu sudah memiliki sound.', message);
        return;
    }

    setPending(context, message.key.remoteJid, sender, {
        action: 'addaudio',
        stage: 'await-audio',
        stickerMessage: quoted
    });

    await sendText(
        context.sock,
        message.key.remoteJid,
        'Kirim audio yang ingin ditambahkan ke stiker tersebut.',
        message
    );
}

async function continuePending(context, message, sender, owner, pending) {
    const incoming = findMedia(message);
    if (!incoming) return;

    if (pending.stage === 'await-audio') {
        if (incoming.kind !== 'audio') {
            await sendText(
                context.sock,
                message.key.remoteJid,
                'SONIVA masih menunggu audio. Kirim file audio atau voice note.',
                message
            );
            return;
        }

        clearPending(context, pendingKey(message.key.remoteJid, sender));

        if (pending.action === 'addaudio') {
            await createStickerFromMessages(context, {
                chat: message.key.remoteJid,
                sender,
                owner,
                visualMessage: pending.stickerMessage,
                audioMessage: message,
                quotedMessage: pending.stickerMessage,
                directVideo: false
            });
        } else {
            await createStickerFromMessages(context, {
                chat: message.key.remoteJid,
                sender,
                owner,
                visualMessage: pending.visualMessage,
                audioMessage: message,
                quotedMessage: pending.visualMessage,
                directVideo: false
            });
        }
        return;
    }

    if (pending.stage === 'await-media') {
        if (!['image', 'video'].includes(incoming.kind)) {
            await sendText(
                context.sock,
                message.key.remoteJid,
                'SONIVA masih menunggu foto atau video.',
                message
            );
            return;
        }

        clearPending(context, pendingKey(message.key.remoteJid, sender));
        await createStickerFromMessages(context, {
            chat: message.key.remoteJid,
            sender,
            owner,
            visualMessage: message,
            audioMessage: pending.audioMessage,
            quotedMessage: message,
            directVideo: false
        });
    }
}

async function handleMessage(context, message) {
    if (!message?.message || !message.key?.remoteJid) return;

    const chat = message.key.remoteJid;
    if (chat === 'status@broadcast' || chat.endsWith('@broadcast')) return;

    const senderJidValue = senderJid(message, context.sock);
    const sender = normalizeUserId(senderJidValue);
    if (!sender) return;

    const owner = isOwner(senderJidValue, context.config.ownerNumber);
    const command = parseCommand(message);
    const key = pendingKey(chat, sender);

    if (command) {
        if (await handleGroupCommand({ sock: context.sock, database: context.database, config: context.config, message, command, sender: senderJidValue, owner })) return;\n\n        if (command.name === 'cancel' || command.name === 'batal') {
            const removed = clearPending(context, key);
            await sendText(
                context.sock,
                chat,
                removed ? 'Sesi pembuatan stiker dibatalkan.' : 'Tidak ada sesi yang sedang berjalan.',
                message
            );
            return;
        }

        if (STICKER_ALIASES.has(command.name)) {
            clearPending(context, key);
            await beginStickerCommand(context, message, sender, owner);
            return;
        }

        if (command.name === 'addaudio') {
            clearPending(context, key);
            await beginAddAudioCommand(context, message, sender, owner);
            return;
        }

        if (command.name === 'limit') {
            await handleLimit(context, message, sender, owner);
            return;
        }

        if (command.name === 'premium') {
            await handlePremium(context, message, command, owner);
            return;
        }

        if (command.name === 'menu' || command.name === 'help') {
            await sendText(
                context.sock,
                chat,
                'SONIVA — Sound Sticker Maker\n\n' +
                '.sticker / .s / .sc / .stc / .stiker — buat Sound Sticker dari foto, video, dan audio.\n' +
                '.addaudio — tambahkan audio ke stiker yang dibalas.\n' +
                '.limit — cek kuota harian.\n' +
                '.cancel — batalkan sesi yang menunggu media.\n\n' +
                'Free: ' + context.config.freeDailyLimit + '/hari | Premium: ' +
                context.config.premiumDailyLimit + '/hari | Owner: unlimited.',
                message
            );
            return;
        }
    }

    const messageText = require('./commands').extractText(message);\n    await handleGroupMessage({ sock: context.sock, database: context.database, message, sender: senderJidValue, owner, text: messageText });\n\n    const pending = context.pending.get(key);
    if (pending) {
        if (Date.now() - pending.createdAt > context.config.pendingTtlMs) {
            clearPending(context, key);
            await sendText(context.sock, chat, 'Sesi sudah kedaluwarsa. Mulai lagi dengan .sticker atau .addaudio.', message);
            return;
        }
        await continuePending(context, message, sender, owner, pending);
    }
}

function createMessageHandler(context) {
    context.pending = new Map();
    return (message) => handleMessage(context, message);
}

module.exports = { createMessageHandler, handleMessage, pendingKey };
