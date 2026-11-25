#!/usr/bin/env node
'use strict';

const { loadEnvFile, loadConfig } = require('./src/config');
const { startBot } = require('./src/bot');

async function main() {
    loadEnvFile();
    const config = loadConfig();
    console.log('[SONIVA] Starting Sound Sticker Bot...');
    console.log('[SONIVA] Data directory and WhatsApp credentials stay on this device.');

    await startBot(config);
}

main().catch((error) => {
    console.error('[SONIVA] Startup failed:', error.message);
    process.exitCode = 1;
});
