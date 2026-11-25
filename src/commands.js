'use strict';

const STICKER_ALIASES = new Set(['sticker', 's', 'sc', 'stc', 'stiker']);

function unwrapContent(content) {
    let current = content || {};
    for (let depth = 0; depth < 8; depth += 1) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
        } else if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
        } else if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
        } else if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
        } else if (current.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
        } else if (current.editedMessage?.message) {
            current = current.editedMessage.message;
        } else {
            break;
        }
    }
    return current;
}

function findMedia(message) {
    const content = unwrapContent(message?.message || message);

    if (content.videoMessage) {
        return { kind: 'video', payload: content.videoMessage };
    }
    if (content.imageMessage) {
        return { kind: 'image', payload: content.imageMessage };
    }
    if (content.audioMessage) {
        return { kind: 'audio', payload: content.audioMessage };
    }
    if (content.stickerMessage) {
        return { kind: 'sticker', payload: content.stickerMessage };
    }

    const document = content.documentMessage;
    if (document) {
        const mime = String(document.mimetype || '').toLowerCase();
        if (mime.startsWith('video/')) return { kind: 'video', payload: document };
        if (mime.startsWith('image/')) return { kind: 'image', payload: document };
        if (mime.startsWith('audio/')) return { kind: 'audio', payload: document };
    }

    return null;
}

function extractText(message) {
    const content = unwrapContent(message?.message || message);
    return String(
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        content.buttonsResponseMessage?.selectedButtonId ||
        content.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    ).trim();
}

function parseCommand(message) {
    const text = extractText(message);
    const match = text.match(/^\.([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    return {
        name: match[1].toLowerCase(),
        args: String(match[2] || '').trim().split(/\s+/).filter(Boolean),
        raw: text
    };
}

function contextInfo(message) {
    const content = unwrapContent(message?.message || message);
    return content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.audioMessage?.contextInfo ||
        content.stickerMessage?.contextInfo ||
        content.documentMessage?.contextInfo ||
        null;
}

function quotedMessage(message) {
    const context = contextInfo(message);
    if (!context?.quotedMessage) return null;

    return {
        key: {
            remoteJid: message.key.remoteJid,
            id: context.stanzaId || 'quoted-media',
            participant: context.participant || message.key.participant,
            fromMe: false
        },
        message: context.quotedMessage
    };
}

function senderJid(message, sock) {
    if (message.key?.participant) return message.key.participant;
    if (message.key?.fromMe) return sock.user?.id || message.key.remoteJid;
    return message.key?.remoteJid || '';
}

function normalizeUserId(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isOwner(sender, configuredNumber) {
    const owner = String(configuredNumber || '').replace(/\D/g, '');
    return Boolean(owner) && normalizeUserId(sender) === owner;
}

function numberToJid(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return '';
    return digits + '@s.whatsapp.net';
}

module.exports = {
    STICKER_ALIASES,
    unwrapContent,
    findMedia,
    extractText,
    parseCommand,
    contextInfo,
    quotedMessage,
    senderJid,
    normalizeUserId,
    isOwner,
    numberToJid
};
