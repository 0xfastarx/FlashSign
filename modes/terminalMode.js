'use strict';
const readline = require('readline');
const ModernUI = require('../core/ModernUI');
const GitHubPasswordSync = require('../auth/GitHubPasswordSync');
const CryptoAutoTx = process.CryptoAutoTx || require('../bot/CryptoAutoTx');
const TelegramBot = require('node-telegram-bot-api');
const ui = new ModernUI();

async function runTerminalMode(SECURE_CONFIG) {
    let app = null;
    let mainRl = null; 
    const ui = new ModernUI(); 

    try {
        mainRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        process.on('SIGINT', async () => {
            console.log('\n👋 Bot stopped by user (Ctrl+C). Cleaning up...');
            if (app) {
                await app.cleanup();
            }
            if (mainRl) {
                mainRl.close();
            }
            process.exit(0);
        });
    
        console.log(ui.getCenterPadding(50) + '🚀 FA STARX BOT - TERMINAL MODE');
        console.log(ui.getCenterPadding(50) + '='.repeat(50));

        const passwordSystem = new GitHubPasswordSync(
            mainRl, 
            SECURE_CONFIG.ADMIN_PASSWORD,
            SECURE_CONFIG.SCRIPT_PASSWORD,
            SECURE_CONFIG.GITHUB_MAIN_URL,
            SECURE_CONFIG.GITHUB_BACKUP_URL,
            SECURE_CONFIG.ENCRYPTION_SALT
        );
        
        await passwordSystem.initialize();

        const loginResult = await passwordSystem.verifyAccess();
        
        if (!loginResult.success) {
            ui.showNotification('error', '❌ Access denied. Exiting...');
            mainRl.close(); 
            process.exit(1);
        }

        const cliSessionId = "cli_session"; 
        
        if (SECURE_CONFIG.TELEGRAM_BOT_TOKEN) {
            ui.createBox('💬 NOTIFIKASI TELEGRAM (PRIBADI)', [
                'Token Bot Telegram tersedia.',
                '',
                'Aktifkan notifikasi Telegram untuk sesi ini?',
                'Jika ya, Chat ID otomatis diambil dari sesi login Anda.'
            ], 'info');

            const useNotif = await passwordSystem.input.question('Pakai notifikasi Telegram? (y/n)');

            if (useNotif.toLowerCase() === 'y') {
                // Ambil Chat ID otomatis: dari env atau dari sesi bot
                // Untuk CLI mode, coba ambil dari TELEGRAM_CHAT_ID di .env dulu
                // Jika tidak ada, coba query via bot getUpdates
                let autoChatId = process.env.TELEGRAM_CHAT_ID || null;

                if (!autoChatId) {
                    // Coba ambil chat ID dari pesan terbaru di bot
                    ui.startLoading('🔍 Mencari Chat ID dari bot Telegram...');
                    try {
                        autoChatId = await new Promise((resolve) => {
                            const botTemp = new TelegramBot(SECURE_CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
                            botTemp.getUpdates({ limit: 10, timeout: 5 }).then(updates => {
                                if (updates && updates.length > 0) {
                                    // Ambil chat ID dari update terbaru
                                    const latest = updates[updates.length - 1];
                                    const id = latest.message?.chat?.id || 
                                               latest.callback_query?.message?.chat?.id ||
                                               null;
                                    resolve(id ? id.toString() : null);
                                } else {
                                    resolve(null);
                                }
                            }).catch(() => resolve(null));
                        });
                        ui.stopLoading();
                    } catch (e) {
                        ui.stopLoading();
                        autoChatId = null;
                    }
                }

                if (autoChatId) {
                    SECURE_CONFIG.TELEGRAM_CHAT_ID = autoChatId.toString();
                    ui.showNotification('success', `✅ Notifikasi aktif! Chat ID: ${autoChatId}`);
                } else {
                    // Fallback: minta user kirim /start ke bot terlebih dahulu
                    ui.showNotification('warning', '⚠️ Chat ID tidak ditemukan otomatis.', [
                        'Silakan kirim pesan /start ke bot Telegram Anda,',
                        'lalu tekan Enter untuk coba lagi.'
                    ]);
                    await passwordSystem.input.question('Tekan Enter setelah kirim /start ke bot');

                    // Coba lagi sekali
                    try {
                        ui.startLoading('🔄 Mencoba ulang...');
                        const botTemp2 = new TelegramBot(SECURE_CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
                        const updates2 = await botTemp2.getUpdates({ limit: 10, timeout: 5 }).catch(() => []);
                        ui.stopLoading();
                        if (updates2 && updates2.length > 0) {
                            const latest2 = updates2[updates2.length - 1];
                            const id2 = latest2.message?.chat?.id ||
                                        latest2.callback_query?.message?.chat?.id || null;
                            if (id2) {
                                SECURE_CONFIG.TELEGRAM_CHAT_ID = id2.toString();
                                ui.showNotification('success', `✅ Notifikasi aktif! Chat ID: ${id2}`);
                            } else {
                                ui.showNotification('warning', '⚠️ Masih tidak ditemukan. Notifikasi dinonaktifkan.');
                            }
                        } else {
                            ui.showNotification('warning', '⚠️ Tidak ada update. Notifikasi dinonaktifkan.');
                        }
                    } catch (e) {
                        ui.stopLoading();
                        ui.showNotification('warning', '⚠️ Gagal. Notifikasi dinonaktifkan.');
                    }
                }
            } else {
                ui.showNotification('info', 'ℹ️ Notifikasi Telegram dinonaktifkan untuk sesi ini.');
            }
        } else {
            console.log('ℹ️ Info: Token Bot Telegram tidak ditemukan, notifikasi dilewati.');
        }

        ui.createBox('🎉 ACCESS GRANTED', [
            `Welcome, ${loginResult.accessLevel === 'admin' ? 'Administrator' : 'User'}!`,
            '',
            'Loading Crypto Auto-Tx Bot dengan Fitur Generate Wallet & Backup Phrase...'
        ], 'success');
        
        await ui.sleep(2000); 
        console.clear(); 

        app = new CryptoAutoTx(mainRl, SECURE_CONFIG, cliSessionId);
        
        if (SECURE_CONFIG.TELEGRAM_CHAT_ID) {
            app.sessionNotificationChatId = SECURE_CONFIG.TELEGRAM_CHAT_ID;
        }
        
        await app.run(); 

    } catch (error) {
        console.log(error);
        ui.stopLoading(); 
        ui.showNotification('error', `Application error: ${error.message}`);
        
        if (app) await app.cleanup();
        if (mainRl) mainRl.close(); 
        process.exit(1);
    }
}

module.exports = { runTerminalMode };
