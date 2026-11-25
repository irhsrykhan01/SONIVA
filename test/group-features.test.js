'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeLink, isSelfJid } = require('../src/group-features');

test('antilink allows the official Saweria domain and subdomains', () => {
    assert.equal(isSafeLink('Support SONIVA https://saweria.co/irhsrykhan'), true);
    assert.equal(isSafeLink('https://www.saweria.co/irhsrykhan'), true);
    assert.equal(isSafeLink('https://help.saweria.co/page'), true);
});

test('antilink does not allow unrelated or deceptive domains', () => {
    assert.equal(isSafeLink('https://example.com'), false);
    assert.equal(isSafeLink('https://saweria.co.example.com'), false);
});

test('antilink accepts text without links as not a safe-link decision', () => {
    assert.equal(isSafeLink('halo semuanya'), false);
});

test('self guard protects both the linked phone JID and LID', () => {
    const sock = { user: { id: '6281234567890:4@s.whatsapp.net', lid: '123456789012345@lid' } };
    assert.equal(isSelfJid('6281234567890@s.whatsapp.net', sock), true);
    assert.equal(isSelfJid('123456789012345@lid', sock), true);
    assert.equal(isSelfJid('6289999999999@s.whatsapp.net', sock), false);
});
