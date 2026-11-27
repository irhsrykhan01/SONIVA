'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
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
        const [tagValue, nextPosition] = readVarint(buffer, position);
        const tag = Number(tagValue);
        position = nextPosition;
        const fieldNumber = tag >>> 3;
        const wireType = tag & 7;
        if (fieldNumber === 0) throw new Error('Invalid protobuf field number.');
        if (wireType === 0) {
            position = readVarint(buffer, position)[1];
        } else if (wireType === 1) {
            position += 8;
        } else if (wireType === 2) {
            const [lengthValue, afterLength] = readVarint(buffer, position);
            const length = Number(lengthValue);
            position = afterLength;
            if (!Number.isSafeInteger(length) || length < 0 || position + length > buffer.length) {
                throw new Error('Invalid protobuf field length.');
            }
            if (fieldNumber === wantedField) return buffer.subarray(position, position + length);
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
    if (!fileSha256 || !encodedAudioMessage) throw new Error('Sticker hash and encoded audio are required.');
    pendingAudio.set(hashKey(fileSha256), Buffer.from(encodedAudioMessage));
}

function unregisterStickerAudio(fileSha256) {
    if (fileSha256) pendingAudio.delete(hashKey(fileSha256));
}

function installStickerAudioSupport(baileysProto = proto) {
    const StickerMessage = baileysProto?.Message?.StickerMessage;
    const AudioMessage = baileysProto?.Message?.AudioMessage;
    if (!StickerMessage?.fromObject || !StickerMessage?.encode ||
        !StickerMessage?.decode || !StickerMessage?.toObject ||
        !AudioMessage?.fromObject || !AudioMessage?.encode ||
        !AudioMessage?.decode || !AudioMessage?.toObject) {
        throw new Error('This Baileys build does not expose the expected sticker/audio protobuf methods.');
    }

    // StickerMessage field 26 is an unassigned length-delimited extension in the
    // pinned Baileys 7.0.0-rc14 schema. Do not reuse field 23 (mediaKeyDomain).
    if (!StickerMessage.fromObject[ENCODE_PATCH]) {
        const originalFromObject = StickerMessage.fromObject;
        const patchedFromObject = function (object) {
            const sticker = originalFromObject.call(this, object);
            if (object?.audioMessage != null) {
                sticker.audioMessage = AudioMessage.fromObject(object.audioMessage);
            }
            return sticker;
        };
        patchedFromObject[ENCODE_PATCH] = true;
        StickerMessage.fromObject = patchedFromObject;
    }

    if (!StickerMessage.encode[ENCODE_PATCH]) {
        const originalEncode = StickerMessage.encode;
        const patchedEncode = function (message, writer) {
            const result = originalEncode.call(this, message, writer);
            let audioBytes = null;
            if (message?.audioMessage != null) {
                audioBytes = AudioMessage.encode(message.audioMessage).finish();
            } else if (message?.fileSha256) {
                audioBytes = pendingAudio.get(hashKey(message.fileSha256)) || null;
            }
            if (audioBytes?.length) result.uint32(STICKER_AUDIO_TAG).bytes(audioBytes);
            return result;
        };
        patchedEncode[ENCODE_PATCH] = true;
        StickerMessage.encode = patchedEncode;
    }

    if (!StickerMessage.decode[DECODE_PATCH]) {
        const originalDecode = StickerMessage.decode;
        const patchedDecode = function (reader, length) {
            let raw = null;
            try { raw = rawReaderBytes(reader, length); } catch { raw = null; }
            const decoded = originalDecode.call(this, reader, length);
            if (raw && decoded && !decoded.audioMessage) {
                try {
                    const audioBytes = extractBytesField(raw, STICKER_AUDIO_FIELD);
                    if (audioBytes) decoded.audioMessage = AudioMessage.decode(audioBytes);
                } catch {
                    // Keep the sticker readable when an unknown extension is malformed.
                }
            }
            return decoded;
        };
        patchedDecode[DECODE_PATCH] = true;
        StickerMessage.decode = patchedDecode;
    }

    if (!StickerMessage.toObject[ENCODE_PATCH]) {
        const originalToObject = StickerMessage.toObject;
        const patchedToObject = function (message, options) {
            const object = originalToObject.call(this, message, options);
            if (message?.audioMessage != null) {
                object.audioMessage = AudioMessage.toObject(message.audioMessage, options);
            }
            return object;
        };
        patchedToObject[ENCODE_PATCH] = true;
        StickerMessage.toObject = patchedToObject;
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

async function computeWaveform(audioPath) {
    const child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', audioPath,
        '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let errorText = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { if (errorText.length < 8192) errorText += chunk.toString(); });
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    if (code !== 0) throw new Error('Could not create audio waveform: ' + errorText.trim());
    const pcm = Buffer.concat(chunks);
    const samples = Math.floor(pcm.length / 2);
    const bars = 64;
    const values = new Uint8Array(bars);
    if (!samples) return values;
    let peak = 0;
    const raw = new Float64Array(bars);
    for (let bar = 0; bar < bars; bar++) {
        const start = Math.floor(bar * samples / bars);
        const end = Math.max(start + 1, Math.floor((bar + 1) * samples / bars));
        let sum = 0;
        for (let i = start; i < Math.min(end, samples); i++) sum += Math.abs(pcm.readInt16LE(i * 2));
        raw[bar] = sum / Math.max(1, Math.min(end, samples) - start);
        peak = Math.max(peak, raw[bar]);
    }
    for (let i = 0; i < bars; i++) values[i] = peak ? Math.round(raw[i] / peak * 100) : 0;
    return values;
}

async function sendSoundSticker(sock, chatJid, assets, quotedMessage) {
    const uploadOptions = { upload: sock.waUploadToServer };
    const seconds = Math.max(1, Math.round(assets.duration));
    const waveform = await computeWaveform(assets.oggPath);

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
    if (!audio?.fileSha256 || !audio?.mediaKey || !audio?.directPath || !audio?.fileEncSha256) {
        throw new Error('WhatsApp did not return the required uploaded-audio metadata.');
    }
    if (!sticker?.fileSha256) throw new Error('WhatsApp did not return the required uploaded-sticker metadata.');

    const audioMessage = proto.Message.AudioMessage.create({
        url: audio.url,
        mimetype: AUDIO_MIMETYPE,
        fileSha256: audio.fileSha256,
        fileLength: audio.fileLength,
        seconds,
        ptt: true,
        mediaKey: audio.mediaKey,
        fileEncSha256: audio.fileEncSha256,
        directPath: audio.directPath,
        mediaKeyTimestamp: audio.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
        waveform
    });
    const encodedAudio = proto.Message.AudioMessage.encode(audioMessage).finish();

    sticker.isAnimated = true;
    sticker.width = 512;
    sticker.height = 512;
    sticker.mimetype = 'image/webp';

    registerStickerAudio(sticker.fileSha256, encodedAudio);
    try {
        const outgoing = generateWAMessageFromContent(
            chatJid,
            { stickerMessage: sticker },
            { quoted: quotedMessage, userJid: ownJidFor(sock, chatJid) }
        );

        const encodedMessage = proto.Message.encode(outgoing.message).finish();
        const encodedSticker = extractBytesField(encodedMessage, 26);
        const embeddedAudioBytes = encodedSticker
            ? extractBytesField(encodedSticker, STICKER_AUDIO_FIELD)
            : null;
        let embeddedAudio = null;
        try {
            if (embeddedAudioBytes?.length) {
                embeddedAudio = proto.Message.AudioMessage.decode(embeddedAudioBytes);
            }
        } catch {
            embeddedAudio = null;
        }
        if (!embeddedAudio?.url || !embeddedAudio?.mediaKey ||
            !embeddedAudio?.directPath || !embeddedAudio?.fileSha256 ||
            !embeddedAudio?.fileEncSha256) {
            throw new Error('Metadata audio Sound Sticker tidak valid setelah encoding. Sticker tidak dikirim agar tidak menjadi stiker bisu.');
        }

        await sock.relayMessage(chatJid, outgoing.message, { messageId: outgoing.key.id });
        return stickerHash(sticker);
    } finally {
        unregisterStickerAudio(sticker.fileSha256);
    }
}

module.exports = {
    STICKER_AUDIO_FIELD, STICKER_AUDIO_TAG,
    readVarint, extractBytesField, installStickerAudioSupport,
    encodedStickerHasAudio, stickerHash, stickerAlreadyHasAudio, sendSoundSticker
};
