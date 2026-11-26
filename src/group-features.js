'use strict';

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/i;
const SAFE_LINK_HOSTS = new Set(['saweria.co', 'saweria.com']);
const duplicateWindows = new Map();

function isGroup(chat) {
    return typeof chat === 'string' && chat.endsWith('@g.us');
}

function jidNumber(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isSelfJid(jid, sock) {
    const candidates = [sock.user?.id, sock.user?.lid].filter(Boolean);
    const value = String(jid || '');
    return candidates.some(candidate => value === candidate || jidNumber(value) === jidNumber(candidate));
}

function isSafeLink(text) {
    const matches = String(text || '').match(/(?:https?:\/\/|www\.)[^\s<>()]+/gi) || [];
    if (!matches.length) return false;
    return matches.every(raw => {
        try {
            const url = new URL(raw.startsWith('www.') ? 'https://' + raw : raw);
            const host = url.hostname.toLowerCase().replace(/^www\./, '');
            return SAFE_LINK_HOSTS.has(host) || [...SAFE_LINK_HOSTS].some(safe => host.endsWith('.' + safe));
        } catch {
            return false;
        }
    });
}

async function groupContext(sock, chat, sender) {
    if (!isGroup(chat)) return { allowed: false, reason: 'group-only' };
    const metadata = await sock.groupMetadata(chat);
    const participants = metadata.participants || [];
    const actor = participants.find(p => p.id === sender || jidNumber(p.id) === jidNumber(sender));
    const bot = participants.find(p => isSelfJid(p.id, sock));
    const actorAdmin = actor?.admin === 'admin' || actor?.admin === 'superadmin';
    const botAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin';
    return { allowed: actorAdmin, actorAdmin, botAdmin, metadata, participants };
}

async function setFeature(database, chat, feature, enabled) {
    database.setGroupFeature(chat, feature, enabled);
}

async function handleGroupCommand({ sock, database, config, message, command, sender, owner }) {
    const features = new Set(['antilink', 'antibot', 'antispam', 'welcome', 'goodbye']);
    if (!features.has(command.name)) return false;
    const chat = message.key.remoteJid;
    if (!isGroup(chat)) {
        await sock.sendMessage(chat, { text: 'Command ini hanya bisa digunakan di grup.' }, { quoted: message });
        return true;
    }
    let status;
    try {
        status = await groupContext(sock, chat, sender);
    } catch (error) {
        await sock.sendMessage(chat, {
            text: 'SONIVA gagal memeriksa admin grup. Coba lagi sebentar.'
        }, { quoted: message }).catch(() => {});
        console.error('[SONIVA] Group admin check failed:', error.message);
        return true;
    }
    if (!owner && !status.actorAdmin) {
        await sock.sendMessage(chat, { text: 'Command ini khusus admin grup dan owner.' }, { quoted: message });
        return true;
    }
    const action = (command.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(action)) {
        const current = database.getGroupFeature(chat, command.name);
        await sock.sendMessage(chat, {
            text: 'Pengaturan ' + command.name + ': ' + (current ? 'ON' : 'OFF') + '\nGunakan .' + command.name + ' on atau .' + command.name + ' off.'
        }, { quoted: message });
        return true;
    }
    await setFeature(database, chat, command.name, action === 'on');
    let note = '';
    if (action === 'on' && ['antilink', 'antispam', 'antibot'].includes(command.name) && !status.botAdmin) {
        note = ' Bot harus dijadikan admin agar dapat menghapus pesan atau anggota.';
    }
    if (action === 'on' && command.name === 'antibot') {
        note += ' Deteksi bot hanya berjalan jika metadata WhatsApp secara eksplisit memberi tanda bot.';
    }
    await sock.sendMessage(chat, {
        text: command.name + ' berhasil ' + (action === 'on' ? 'diaktifkan' : 'dinonaktifkan') + '.' + note
    }, { quoted: message });
    return true;
}

async function handleGroupMessage({ sock, database, message, sender, owner, text }) {
    const chat = message.key.remoteJid;
    if (!isGroup(chat) || message.key.fromMe || owner || isSelfJid(sender, sock)) return;
    const activeFeatures = database.getEnabledGroupFeatures(chat);
    if (!activeFeatures.length) return;

    const enabled = feature => activeFeatures.includes(feature);
    const status = await groupContext(sock, chat, sender).catch(() => null);
    if (!status) return;

    if (status.actorAdmin) return;

    if (enabled('antilink') && URL_RE.test(text) && !isSafeLink(text)) {
        if (status.botAdmin) {
            await sock.sendMessage(chat, { delete: message.key }).catch(() => {});
            await sock.sendMessage(chat, { text: '@' + jidNumber(sender) + ', link tidak diizinkan di grup ini.', mentions: [sender] });
        } else {
            // Never pretend moderation happened when the bot lacks admin rights.
            console.warn('[SONIVA] Antilink is enabled but the bot is not a group admin:', chat);
        }
        return;
    }

    if (enabled('antispam')) {
        const normalized = String(text || '').trim().toLowerCase();
        if (normalized.length >= 3) {
            const key = chat + '|' + sender + '|' + normalized;
            const now = Date.now();
            const prior = duplicateWindows.get(key);
            const record = prior && now - prior.firstAt <= 10000
                ? { firstAt: prior.firstAt, count: prior.count + 1, lastAt: now }
                : { firstAt: now, count: 1, lastAt: now };
            duplicateWindows.set(key, record);
            if (duplicateWindows.size > 2000) {
                for (const [k, value] of duplicateWindows) if (now - value.lastAt > 15000) duplicateWindows.delete(k);
            }
            if (record.count >= 4) {
                if (status.botAdmin) await sock.sendMessage(chat, { delete: message.key }).catch(() => {});
                if (record.count === 4) await sock.sendMessage(chat, {
                    text: '@' + jidNumber(sender) + ', terdeteksi mengirim pesan berulang. Kurangi spam ya.',
                    mentions: [sender]
                });
            }
        }
    }
}

async function handleParticipantsUpdate({ sock, database, update, ownerNumber }) {
    const chat = update.id;
    if (!isGroup(chat)) return;
    const participants = (update.participants || []).filter(jid => !isSelfJid(jid, sock));
    if (!participants.length) return;

    const welcomeEnabled = update.action === 'add' && database.getGroupFeature(chat, 'welcome');
    const goodbyeEnabled = ['remove', 'leave'].includes(update.action) && database.getGroupFeature(chat, 'goodbye');
    const antibotEnabled = update.action === 'add' && database.getGroupFeature(chat, 'antibot');

    if (welcomeEnabled) {
        for (const jid of participants) {
            await sock.sendMessage(chat, {
                text: 'Selamat datang @' + jidNumber(jid) + '! Semoga betah di grup ini.',
                mentions: [jid]
            }).catch(() => {});
        }
    }

    if (goodbyeEnabled) {
        for (const jid of participants) {
            await sock.sendMessage(chat, {
                text: 'Sampai jumpa @' + jidNumber(jid) + '! Terima kasih sudah bergabung.',
                mentions: [jid]
            }).catch(() => {});
        }
    }

    if (!antibotEnabled) return;

    const metadata = await sock.groupMetadata(chat).catch(() => null);
    if (!metadata) {
        console.warn('[SONIVA] Antibot could not read group metadata:', chat);
        return;
    }

    // WhatsApp/Baileys does not consistently expose a bot identity flag.
    // Remove only accounts explicitly marked as bots; never guess from names or behavior.
    const added = (metadata.participants || []).filter(p =>
        participants.some(jid => jid === p.id || jidNumber(jid) === jidNumber(p.id))
    );
    const botIsAdmin = (metadata.participants || []).some(p =>
        isSelfJid(p.id, sock) && (p.admin === 'admin' || p.admin === 'superadmin')
    );

    if (!botIsAdmin) {
        console.warn('[SONIVA] Antibot is enabled but SONIVA is not a group admin:', chat);
        return;
    }

    for (const participant of added) {
        const jid = participant.id;
        const flaggedBot = participant.isBot === true || participant.bot === true;
        const protectedAccount = isSelfJid(jid, sock) ||
            jidNumber(jid) === String(ownerNumber || '') ||
            participant.admin === 'admin' || participant.admin === 'superadmin';
        if (flaggedBot && !protectedAccount) {
            await sock.groupParticipantsUpdate(chat, [jid], 'remove').catch(error => {
                console.warn('[SONIVA] Antibot could not remove flagged participant:', error.message);
            });
        }
    }
}

async function applyMessageSignals(sock, message, isCommand = false) {
    if (!message?.key?.remoteJid || message.key.fromMe ||
        message.key.remoteJid === 'status@broadcast' ||
        message.key.remoteJid.endsWith('@broadcast')) return;

    const chat = message.key.remoteJid;

    // Read receipts remain independent from reactions.
    try { await sock.readMessages([message.key]); } catch {}

    // Only command messages receive the processing reaction.
    if (isCommand) {
        try { await sock.sendMessage(chat, { react: { text: '⏳', key: message.key } }); } catch {}
    }
}

async function completeMessageSignals(sock, message, isCommand = false) {
    if (!isCommand || !message?.key?.remoteJid || message.key.fromMe ||
        message.key.remoteJid === 'status@broadcast' ||
        message.key.remoteJid.endsWith('@broadcast')) return;

    try { await sock.sendMessage(message.key.remoteJid, { react: { text: '✅', key: message.key } }); } catch {}
}

module.exports = {
    handleGroupCommand, handleGroupMessage, handleParticipantsUpdate,
    applyMessageSignals, completeMessageSignals, isSafeLink, isSelfJid
};
