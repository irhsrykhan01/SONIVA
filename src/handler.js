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
    isOwner
} = require('./commands');
const { probeMedia, createSoundStickerAssets } = require('./media');
const { sendSoundSticker, stickerAlreadyHasAudio, stickerHash } = require('./protocol');
const { handleGroupCommand, handleGroupMessage } = require('./group-features');

function isGroupChat(remoteJid) {
    return typeof remoteJid === 'string' && remoteJid.endsWith('@g.us');
}

function pendingKey(chat, sender) {
    return String(chat) + '|' + String(sender);
}

function sendText(sock, chat, text, quoted) {
    const options = quoted ? { quoted } : {};
    return sock.sendMessage(chat, { text }, options);
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

function parseChannelReference(value) {
    const input = String(value || '').trim();
    const match = input.match(/^https?:\\/\\/whatsapp\\.com\\/channel\\/([^/?#]+)/i);
    if (match) return { type: 'invite', key: match[1] };
    if (input.endsWith('@newsletter')) return { type: 'jid', key: input };
    throw new Error('Masukkan link WhatsApp Channel atau JID yang berakhiran @newsletter.');
}

async function handleSetChannel(context, message, sender, command) {
    const reference = command.args.join(' ').trim();
    if (!reference) {
        await sendText(context.sock, message.key.remoteJid, 'Cara pakai: .setchannel <link/JID Channel>', message);
        return;
    }

    const parsed = parseChannelReference(reference);
    if (typeof context.sock.newsletterMetadata !== 'function') {
        throw new Error('Baileys pada versi ini belum menyediakan fitur metadata Channel.');
    }

    const metadata = await context.sock.newsletterMetadata(parsed.type, parsed.key);
    if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) {
        throw new Error('Metadata Channel tidak valid atau JID tidak ditemukan.');
    }

    const role = String(metadata.viewer_metadata?.role || '').toUpperCase();
    if (role && !['ADMIN', 'OWNER'].includes(role)) {
        throw new Error('Akun WhatsApp yang terhubung bukan admin Channel tersebut.');
    }

    context.database.setSavedChannel(sender, {
        id: metadata.id,
        name: metadata.name || metadata.thread_metadata?.name?.text || 'WhatsApp Channel'
    });

    await sendText(
        context.sock,
        message.key.remoteJid,
        'Channel berhasil disimpan untuk akun ini.\nNama: ' +
            (metadata.name || metadata.thread_metadata?.name?.text || 'WhatsApp Channel') +
            '\nJID: ' + metadata.id +
            '\n\nBalas pesan dengan .upch untuk mengirimkannya ke Channel.',
        message
    );
}

async function handleUpChannel(context, message, sender, command) {
    const saved = context.database.getSavedChannel(sender);
    if (!saved) {
        await sendText(context.sock, message.key.remoteJid, 'Channel belum diatur. Gunakan .setchannel <link/JID Channel> terlebih dahulu.', message);
        return;
    }

    if (typeof context.sock.sendMessage !== 'function') {
        throw new Error('Pengiriman pesan tidak tersedia pada koneksi ini.');
    }

    const quoted = quotedMessage(message);
    const text = command.args.join(' ').trim();

    if (!quoted && !text) {
        await sendText(context.sock, message.key.remoteJid, 'Balas pesan yang ingin dikirim dengan .upch, atau gunakan .upch <teks>.', message);
        return;
    }

    if (quoted) {
        const media = findMedia(quoted);
        if (media?.kind === 'sticker' && stickerAlreadyHasAudio(media.payload, context.database)) {
            if (typeof context.sock.relayMessage !== 'function') {
                throw new Error('Baileys tidak menyediakan relayMessage untuk meneruskan Sound Sticker asli.');
            }
            const messageId = typeof context.sock.generateMessageTag === 'function'
                ? context.sock.generateMessageTag()
                : undefined;
            await context.sock.relayMessage(saved.id, quoted.message, messageId ? { messageId } : {});
        } else if (media) {
            const data = await downloadMediaMessage(
                quoted,
                'buffer',
                {},
                {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: context.sock.updateMediaMessage
                }
            );
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (!buffer.length) throw new Error('Media yang dibalas kosong atau gagal diunduh.');
            if (buffer.length > context.config.maxMediaBytes) {
                throw new Error('Media melebihi batas ukuran SONIVA.');
            }

            let payload;
            if (media.kind === 'image') payload = { image: buffer, ...(media.payload.caption ? { caption: media.payload.caption } : {}) };
            else if (media.kind === 'video') payload = { video: buffer, ...(media.payload.caption ? { caption: media.payload.caption } : {}) };
            else if (media.kind === 'audio') payload = { audio: buffer, mimetype: media.payload.mimetype || 'audio/ogg', ptt: Boolean(media.payload.ptt) };
            else if (media.kind === 'sticker') payload = { sticker: buffer };
            else payload = { document: buffer, mimetype: media.payload.mimetype || 'application/octet-stream', fileName: media.payload.fileName || 'file' };
            await context.sock.sendMessage(saved.id, payload);
        } else {
            const quotedText = require('./commands').extractText(quoted);
            if (!quotedText) throw new Error('Pesan yang dibalas tidak memiliki teks atau media yang didukung.');
            await context.sock.sendMessage(saved.id, { text: quotedText });
        }
    } else {
        await context.sock.sendMessage(saved.id, { text });
    }

    await sendText(context.sock, message.key.remoteJid, 'Berhasil mengirim pesan ke WhatsApp Channel: ' + saved.name, message);
}

async function handleLimit(context, message) {
    await sendText(
        context.sock,
        message.key.remoteJid,
        'SONIVA tidak menerapkan limit harian atau sistem premium. Semua pengguna dapat membuat Sound Sticker tanpa kuota.',
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

        console.log(
            '[SONIVA] Sound Sticker sent | user=' + sender +
            ' | duration=' + assets.duration.toFixed(2) + 's' +
            ' | WebP=' + Math.ceil(assets.stickerBytes / 1024) + 'KB' +
            ' | fps=' + assets.fps +
            ' | quality=' + assets.quality +
            ' | resolution=' + assets.dimension + 'px' +
            ' | compressionAttempts=' + assets.compressionAttempts +
            ' | audio=' + (useVideoAudio ? 'video track' : 'separate audio')
        );
    } catch (error) {
        console.error('[SONIVA] Sticker generation failed:', error);
        await sendText(
            context.sock,
            chat,
            'SONIVA gagal membuat Sound Sticker: ' + error.message,
            replyTo || visualMessage
        );
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

async function beginStickerCommand(context, message, sender, owner) {

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
    // SONIVA only operates in groups. Ignore private chats and all broadcast JIDs silently.
    if (!isGroupChat(chat)) return;

    const senderJidValue = senderJid(message, context.sock);
    const sender = normalizeUserId(senderJidValue);
    if (!sender) return;

    const owner = isOwner(senderJidValue, context.config.ownerNumber);
    const command = parseCommand(message);
    const key = pendingKey(chat, sender);

    if (command) {
        if (await handleGroupCommand({ sock: context.sock, database: context.database, config: context.config, message, command, sender: senderJidValue, owner })) return;

        if (command.name === 'setchannel' || command.name === 'setch') {
            try {
                await handleSetChannel(context, message, sender, command);
            } catch (error) {
                await sendText(context.sock, chat, 'Gagal menyimpan Channel: ' + error.message, message);
            }
            return;
        }

        if (command.name === 'upch' || command.name === 'uploadchannel' || command.name === 'upchannel') {
            try {
                await handleUpChannel(context, message, sender, command);
            } catch (error) {
                console.error('[SONIVA] Channel upload failed:', error);
                await sendText(context.sock, chat, 'Gagal mengirim ke Channel: ' + error.message, message);
            }
            return;
        }

        if (command.name === 'cancel' || command.name === 'batal') {
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

        if (command.name === 'menu' || command.name === 'help') {
            const role = owner ? 'OWNER' : 'USER';
            const mention = '@' + sender;
            const menuText =
                '╭─「 SONIVA 」\n' +
                '│ Halo ' + mention + '\n' +
                '│ Status  ' + role + '\n' +
                '│ Limit   UNLIMITED\n' +
                '│ Total   11 Commands\n' +
                '╰──────────────\n\n' +
                '乂 STICKER MAKER\n' +
                '│ .sticker\n' +
                '│ .addaudio\n' +
                '│ .cancel\n\n' +
                '乂 USER MENU\n' +
                '│ .limit (no quota)\n' +
                '│ .menu\n\n' +
                '乂 GROUP ADMIN\n' +
                '│ .antilink on/off\n' +
                '│ .antibot on/off\n' +
                '│ .antispam on/off\n' +
                '│ .welcome on/off\n' +
                '│ .goodbye on/off\n\n' +
                '「 SONIVA 」';
            await context.sock.sendMessage(chat, {
                text: menuText,
                mentions: [senderJidValue]
            }, { quoted: message });
            return;
        }
    }

    const messageText = require('./commands').extractText(message);
    await handleGroupMessage({ sock: context.sock, database: context.database, message, sender: senderJidValue, owner, text: messageText });

    const pending = context.pending.get(key);
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

module.exports = { createMessageHandler, handleMessage, pendingKey, isGroupChat };
