/**
 * =============================================================================
 * == FA STARX BOT v20.0.0
 * == Entry Point
 * =============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const isPkg = typeof process.pkg !== 'undefined';
const projectRoot = isPkg ? path.dirname(process.execPath) : __dirname;
const envPath = path.join(projectRoot, 'security', '.env');

dotenv.config({ path: envPath, override: true });

// Global safety net — mencegah bot mati total akibat error tak terduga
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Global] Unhandled Promise Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (error) => {
    console.error('⚠️ [Global] Uncaught Exception:', error?.message || error);
});

const readline = require('readline');
const { loadConfiguration } = require('./config/loadConfiguration');
const ModernUI = require('./core/ModernUI');
const TelegramFullController = require('./bot/TelegramFullController');
const { runTerminalMode } = require('./modes/terminalMode');
const integrityGuard = require('./core/integrityGuard');

const ui = new ModernUI();

async function main() {
    let telegramController = null;

    try {
        // Jalankan pengecekan integritas sebelum memuat konfigurasi
        await integrityGuard.verify();
        
        // Reload .env untuk memperbarui nilai process.env setelah re-enkripsi selesai
        dotenv.config({ path: envPath, override: true });

        await ui.showAnimatedBanner(1, 0);
        const SECURE_CONFIG = loadConfiguration();

        if (SECURE_CONFIG.TELEGRAM_BOT_TOKEN) {
            // Mode Telegram
            console.log('🤖 Starting Telegram Bot (v20.0.0 - Generate Wallet & Backup Phrase)...');
            telegramController = new TelegramFullController(SECURE_CONFIG);
            console.log('✅ Telegram Bot Active!');
            console.log('📱 Fitur baru: Generate Wallet & Backup Phrase tersedia!');
            console.log('🔐 Login via: /start di Bot Anda');

            process.on('SIGINT', async () => {
                console.log('\n👋 Bot stopped by user (Ctrl+C). Cleaning up Telegram Bot...');
                if (telegramController) {
                    await telegramController.cleanup();
                }
                process.exit(0);
            });

        } else {
            // Mode Terminal
            ui.showNotification('warning', 'TOKEN TELEGRAM TIDAK DITEMUKAN', [
                'TELEGRAM_BOT_TOKEN tidak ada di file .env.',
                'Menjalankan mode terminal (CLI)...',
                'Fitur baru: Generate Wallet & Backup Phrase tersedia!'
            ]);
            await ui.sleep(2000);
            await runTerminalMode(SECURE_CONFIG);
        }

    } catch (error) {
        ui.stopLoading();
        ui.showNotification('error', 'FATAL APPLICATION ERROR', [error.message, error.stack]);
        console.log(error);

        if (telegramController) {
            await telegramController.cleanup();
        }

        process.exit(1);
    }
}

// Start the application
main();