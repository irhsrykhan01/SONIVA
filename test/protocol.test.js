'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    readVarint,
    extractBytesField,
    encodedStickerHasAudio
} = require('../src/protocol');

function encodeVarint(value) {
    let number = BigInt(value);
    const bytes = [];
    while (number > 0x7fn) {
        bytes.push(Number(number & 0x7fn) | 0x80);
        number >>= 7n;
    }
    bytes.push(Number(number));
    return Buffer.from(bytes);
}

function bytesField(fieldNumber, payload) {
    const data = Buffer.from(payload);
    return Buffer.concat([
        encodeVarint((fieldNumber << 3) | 2),
        encodeVarint(data.length),
        data
    ]);
}

test('readVarint reads a multi-byte protobuf integer', () => {
    const encoded = encodeVarint(300);
    const [value, next] = readVarint(encoded, 0);
    assert.equal(value, 300n);
    assert.equal(next, encoded.length);
});

test('extractBytesField returns the requested length-delimited field', () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const encoded = Buffer.concat([
        bytesField(2, Buffer.from('unrelated')),
        bytesField(26, payload)
    ]);
    assert.deepEqual(extractBytesField(encoded, 26), payload);
});

test('encodedStickerHasAudio detects the embedded audio extension', () => {
    const audioMetadata = Buffer.from([10, 3, 1, 2, 3]);
    assert.equal(encodedStickerHasAudio(bytesField(26, audioMetadata)), true);
    assert.equal(encodedStickerHasAudio(bytesField(25, audioMetadata)), false);
});

test('extractBytesField rejects truncated protobuf payloads', () => {
    const truncated = Buffer.concat([
        encodeVarint((26 << 3) | 2),
        encodeVarint(5),
        Buffer.from([1, 2])
    ]);
    assert.throws(() => extractBytesField(truncated, 26), /Invalid protobuf field length/);
});

test('readVarint rejects truncated input', () => {
    assert.throws(() => readVarint(Buffer.from([0x80]), 0), /Unexpected end/);
});
