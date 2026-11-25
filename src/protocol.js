'use strict';

const fs = require('node:fs');
const {
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const STICKER_AUDIO_FIELD = 26;
const STICKER_AUDIO_TAG = (STICKER_AUDIO_FIELD << 3) | 2;
const AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';
const pendingAudio = new Map();
const ENCODE_PATCH = Symbol.for('soniva.sticker-audio.encode-patched');
const DECODE_PATCH = Symbol.for('soniva.sticker-audio.decode-patched');

function readVarint(buffer, position) {
    let value = 0n;
    let shift = 0n;

    for (;;) {
        const byte = buffer[position++];
        if (byte === undefined) throw new Error('Unexpected end of protobuf data.');
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return [value, position];
        shift += 7n;
        if (shift > 70n) throw new Error('Invalid protobuf varint.');
    }
}

function extractBytesField(input, wantedField) {
    const buffer = Buffer.from(input);
    let position = 0;

    while (position < buffer.length) {
        const tagResult = readVarint(buffer, position);
        const tag = Number(tagResult[0]);
        position = tagResult[1];

        const fieldNumber = tag >>> 3;
        const wireType = tag & 7;
        if (fieldNumber === 0) throw new Error('Invalid protobuf field number.');

        if (wireType === 0) {
            const result = readVarint(buffer, position);
            position = result[1];
        } else if (wireType === 1) {
            position += 8;
        } else if (wireType === 2) {
            const lengthResult = readVarint(buffer, position);
            const length = Number(lengthResult[0]);
            position = lengthResult[1];
            if (!Number.isSafeInteger(length) || length < 0 || position + length > buffer.length) {
                throw new Error('Invalid protobuf field length.');
            }
            if (fieldNumber === wantedField) {
                return buffer.subarray(position, position + length);
            }
            position += length;
        } else if (wireType === 5) {
            position += 4;
        } else {
            throw new Error('Unsupported protobuf wire type ' + wireType + '.');
        }

        if (position > buffer.length) throw new Error('Truncated protobuf data.');
    }

    return null;
}

function rawReaderBytes(reader, length) {
    if (reader && reader.buf && Number.isInteger(reader.pos)) {
        const start = reader.pos;
        const end = length === undefined ? reader.len : Math.min(reader.len, start + length);
        return Buffer.from(reader.buf.subarray(start, end));
    }

    const buffer = Buffer.from(reader);
    return length === undefined ? buffer : buffer.subarray(0, length);
}

function hashKey(fileSha256) {
    return Buffer.from(fileSha256).toString('base64');
}

function registerStickerAudio(fileSha256, encodedAudioMessage) {
    if (!fileSha256 || !encodedAudioMessage) {
        throw new Error('Sticker hash and encoded audio are required.');
    }
    pendingAudio.set(hashKey(fileSha256), Buffer.from(encodedAudioMessage));
}

function unregisterStickerAudio(fileSha256) {
    if (fileSha256) pendingAudio.delete(hashKey(fileSha256));
}

function installStickerAudioSupport(baileysProto = proto) {
    const StickerMessage = baileysProto?.Message?.StickerMessage;
    const AudioMessage = baileysProto?.Message?.AudioMessage;

    if (!StickerMessage?.encode || !StickerMessage?.decode || !AudioMessage?.decode) {
        throw new Error('This Baileys build does not expose the expected sticker/audio protobuf types.');
    }

    if (!StickerMessage.encode[ENCODE_PATCH]) {
        const originalEncode = StickerMessage.encode;
        const patchedEncode = function (message, writer) {
            const result = originalEncode.call(this, message, writer);

            if (message && message.fileSha256 && !message.audioMessage) {
                const audioBytes = pendingAudio.get(hashKey(message.fileSha256));
                if (audioBytes) {
                    result.uint32(STICKER_AUDIO_TAG).bytes(audioBytes);
                }
            }

            return result;
        };
        patchedEncode[ENCODE_PATCH] = true;
        StickerMessage.encode = patchedEncode;
    }

    if (!StickerMessage.decode[DECODE_PATCH]) {
        const originalDecode = StickerMessage.decode;
        const patchedDecode = function (reader, length) {
            let raw = null;
            try {
                raw = rawReaderBytes(reader, length);
            } catch {
                raw = null;
            }

            const decoded = originalDecode.call(this, reader, length);
            if (raw && decoded && !decoded.audioMessage) {
                try {
                    const audioBytes = extractBytesField(raw, STICKER_AUDIO_FIELD);
                    if (audioBytes) {
                        decoded.audioMessage = AudioMessage.decode(audioBytes);
                    }
                } catch {
                    // Keep the original decoded sticker intact if an extension is malformed.
                }
            }
            return decoded;
        };
        patchedDecode[DECODE_PATCH] = true;
        StickerMessage.decode = patchedDecode;
    }
}

function encodedStickerHasAudio(encodedSticker) {
    return Boolean(extractBytesField(encodedSticker, STICKER_AUDIO_FIELD));
}

function stickerHash(stickerMessage) {
    if (!stickerMessage?.fileSha256) return '';
    return Buffer.from(stickerMessage.fileSha256).toString('base64');
}

function stickerAlreadyHasAudio(stickerMessage, database) {
    if (!stickerMessage) return false;
    if (stickerMessage.audioMessage || stickerMessage.audioStickerMessage) return true;
    return database.isKnownSoundSticker(stickerHash(stickerMessage));
}

function ownJidFor(sock, chatJid) {
    if (chatJid.endsWith('@lid') && sock.user?.lid) return sock.user.lid;
    return sock.user?.id;
}

async function sendSoundSticker(sock, chatJid, assets, quotedMessage) {
    const uploadOptions = { upload: sock.waUploadToServer };
    const seconds = Math.max(1, Math.round(assets.duration));

    const uploadedAudio = await prepareWAMessageMedia({
        audio: fs.readFileSync(assets.oggPath),
        mimetype: AUDIO_MIMETYPE,
        seconds
    }, uploadOptions);

    const uploadedSticker = await prepareWAMessageMedia({
        sticker: fs.readFileSync(assets.webpPath),
        isAnimated: true,
        mimetype: 'image/webp'
    }, uploadOptions);

    const audio = uploadedAudio.audioMessage;
    const sticker = uploadedSticker.stickerMessage;

    if (!audio?.fileSha256 || !audio?.mediaKey || !audio?.directPath) {
        throw new Error('WhatsApp did not return the required uploaded-audio metadata.');
    }
    if (!sticker?.fileSha256) {
        throw new Error('WhatsApp did not return the required uploaded-sticker metadata.');
    }

    const audioMessage = proto.Message.AudioMessage.create({
        url: audio.url,
        mimetype: AUDIO_MIMETYPE,
        fileSha256: audio.fileSha256,
        fileLength: Number(audio.fileLength || 0),
        seconds,
        ptt: true,
        mediaKey: audio.mediaKey,
        fileEncSha256: audio.fileEncSha256,
        directPath: audio.directPath,
        mediaKeyTimestamp: audio.mediaKeyTimestamp || Math.floor(Date.now() / 1000)
    });
    const encodedAudio = proto.Message.AudioMessage.encode(audioMessage).finish();

    sticker.isAnimated = true;
    sticker.width = 512;
    sticker.height = 512;
    sticker.mimetype = 'image/webp';

    registerStickerAudio(sticker.fileSha256, encodedAudio);

    try {
        const encodedSticker = proto.Message.StickerMessage.encode(sticker).finish();
        if (!encodedStickerHasAudio(encodedSticker)) {
            throw new Error('The sound-sticker audio extension was not encoded. Nothing was sent.');
        }

        const outgoing = generateWAMessageFromContent(
            chatJid,
            { stickerMessage: sticker },
            {
                quoted: quotedMessage,
                userJid: ownJidFor(sock, chatJid)
            }
        );

        await sock.relayMessage(chatJid, outgoing.message, {
            messageId: outgoing.key.id
        });

        return stickerHash(sticker);
    } finally {
        unregisterStickerAudio(sticker.fileSha256);
    }
}

module.exports = {
    STICKER_AUDIO_FIELD,
    STICKER_AUDIO_TAG,
    readVarint,
    extractBytesField,
    installStickerAudioSupport,
    encodedStickerHasAudio,
    stickerHash,
    stickerAlreadyHasAudio,
    sendSoundSticker
};
