'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const GitHubPasswordSync = require('../auth/GitHubPasswordSync');
const CryptoAutoTx = require('./CryptoAutoTx');
const TwoFactorAuth = require('../auth/TwoFactorAuth');
const { NETWORK_CONFIG } = require('../utils/constants');
const { enhancedConfigManager } = require('../utils/secureConfig');
const EthTransfer = require('../transfer/EthTransfer');
const TokenTransfer = require('../transfer/TokenTransfer');
const AutoTokenDetectionManager = require('../transfer/AutoTokenDetectionManager');
const ModernUI = require('../core/ModernUI');
const ui = new ModernUI();


// ==========================================================
// == CONTROLLER USER CHECK
// == Daftar & cek akses user via Controller HTTP server
// ==========================================================

const http = require('http');

function controllerRequest(path) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${process.env.CONTROLLER_HTTP_PORT || 3099}${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null)); // Controller tidak jalan = skip cek
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
}

async function registerUserToController(chatId, username, firstName) {
    const enc = encodeURIComponent;
    return await controllerRequest(
        `/register?id=${chatId}&username=${enc(username || '')}&firstName=${enc(firstName || '')}`
    );
}

async function checkUserAccess(chatId) {
    return await controllerRequest(`/check?id=${chatId}`);
}

class TelegramFullController {
    constructor(secureConfig) {
        this.config = secureConfig;
        this.userStates = new Map();
        this.bot = null;
        this.securitySystem = null;
        this.userSessions = new Map();
        // Simpan metadata login: { level, loginMethod: 'password'|'otp', loginTime }
        this.userLoginMeta = new Map();
        // Transfer bot: simpan instance aktif per user
        this.transferInstances = new Map(); // chatId → { ethTransfer|tokenTransfer|autoDetect, type }

        this.initBot();
        this.initSecuritySystem();
    }

    initSecuritySystem() {
        this.securitySystem = new GitHubPasswordSync(
            null,
            this.config.ADMIN_PASSWORD,
            this.config.SCRIPT_PASSWORD,
            this.config.GITHUB_MAIN_URL,
            this.config.GITHUB_BACKUP_URL,
            this.config.ENCRYPTION_SALT
        );
        this._securityInitialized = false;  // Flag: initialize() hanya jalan 1x
        this._securityInitializing = false; // Flag: cegah race condition
    }

    // ─── OWNER CHECK ──────────────────────────────────────────────────────────
    isOwner(chatId) {
        if (!this.config.OWNER_TELEGRAM_ID) return false;
        return String(chatId) === String(this.config.OWNER_TELEGRAM_ID);
    }

    // Ambil username owner dari Telegram untuk ditampilkan sebagai kontak
    async _getOwnerContact() {
        if (this._ownerContactCache) return this._ownerContactCache;
        try {
            const chat = await this.bot.getChat(this.config.OWNER_TELEGRAM_ID);
            if (chat.username) {
                this._ownerContactCache = `@${chat.username}`;
            } else {
                // Tidak punya username, pakai first name saja
                this._ownerContactCache = chat.first_name || 'Admin';
            }
            return this._ownerContactCache;
        } catch (e) {
            return null;
        }
    }

    // ─── UPDATE PASSWORD DI .env (OWNER ONLY) ────────────────────────────────
    _updatePasswordInEnv(type, newPassword) {
        try {
            const envPath = path.join(__dirname, '../.env');
            if (!fs.existsSync(envPath)) {
                return { ok: false, msg: 'File .env tidak ditemukan.' };
            }
            const configKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256'
            );
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', configKey, iv);
            let encrypted = cipher.update(newPassword, 'utf8', 'base64');
            encrypted += cipher.final('base64');
            const encryptedVal = `${encrypted}:${iv.toString('hex')}`;

            let envContent = fs.readFileSync(envPath, 'utf8');
            const envKey = type === 'admin' ? 'ADMIN_PASSWORD_ENCRYPTED' : 'SCRIPT_PASSWORD_ENCRYPTED';
            const regex = new RegExp('^' + envKey + '=.*$', 'm');
            if (!regex.test(envContent)) {
                return { ok: false, msg: `Key ${envKey} tidak ditemukan di .env.` };
            }
            envContent = envContent.replace(regex, `${envKey}=${encryptedVal}`);
            fs.writeFileSync(envPath, envContent, 'utf8');

            // Update in-memory config langsung berlaku tanpa restart
            if (type === 'admin') {
                this.config.ADMIN_PASSWORD = newPassword;
                this.securitySystem.adminPassword = newPassword;
            } else {
                this.config.SCRIPT_PASSWORD = newPassword;
                this.securitySystem.scriptPassword = newPassword;
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, msg: e.message };
        }
    }

    initBot() {
        if (this.config.TELEGRAM_BOT_TOKEN) {
            try {
                this.bot = new TelegramBot(this.config.TELEGRAM_BOT_TOKEN, { polling: true });
                console.log('🤖 Telegram Bot (v19.0.0 - Generate Wallet & Backup Phrase) initialized');
                this.setupBotHandlers();
            } catch (error) {
                console.log('❌ Error initializing Main Bot:', error.message);
            }
        } else {
            console.error('FATAL: TelegramFullController dipanggil tanpa TELEGRAM_BOT_TOKEN.');
        }
    }

    setupBotHandlers() {
        this.bot.onText(/\/start/, (msg) => this.startSecurityFlow(msg.chat.id, msg));
        this.bot.onText(/\/menu/, (msg) => this.showMainMenu(msg.chat.id));
        this.bot.onText(/\/status/, (msg) => this.sendBotStatus(msg.chat.id));

        this.bot.on('message', (msg) => this.handleMessage(msg));
        this.bot.on('callback_query', (query) => this.handleCallback(query));
    }

    // ===================================
    // SECURITY & AUTHENTICATION FLOW
    // ===================================

    async startSecurityFlow(chatId, msg = null) {
        // ── Cek username Telegram — wajib ada ──
        const username = msg?.from?.username || '';
        const firstName = msg?.from?.first_name || '';

        if (!username) {
            // Ambil kontak admin
            const ownerContact = this.config.OWNER_TELEGRAM_ID
                ? await this._getOwnerContact()
                : null;
            const contactLine = ownerContact
                ? `\n\n👤 Hubungi admin: ${ownerContact}`
                : '\n\n👤 Hubungi admin untuk informasi lebih lanjut.';

            this.bot.sendMessage(chatId,
                `🚫 *Akses Ditolak*\n\n` +
                `Kamu belum memiliki *username Telegram*.\n\n` +
                `Cara set username:\n` +
                `Telegram → Settings → Username → isi username kamu\n\n` +
                `Setelah diset, ketuk /start lagi.` +
                contactLine,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            return;
        }

        // Register dulu (auto aktif jika baru)
        const regResult = await registerUserToController(chatId, username, firstName);

        // Kirim notif ke admin controller jika user baru
        if (regResult && regResult.isNew) {
            const adminId = this.config.ADMIN_CHAT_ID;
            if (adminId && this.bot) {
                this.bot.sendMessage(adminId,
                    `🔔 *USER BARU LOGIN*\n\n` +
                    `🆔 Chat ID  : \`${chatId}\`\n` +
                    `👤 Nama     : ${firstName || '-'}\n` +
                    `🏷️ Username : ${username ? '@' + username : '-'}\n` +
                    `📅 Waktu    : ${new Date().toLocaleString('id-ID')}\n\n` +
                    `_Kelola via Controller Bot → 👥 Kelola User_`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            }
        }

        // Cek akses
        const accessResult = await checkUserAccess(chatId);

        if (accessResult && !accessResult.allowed) {
            // Ambil username owner dari config untuk kontak admin
            const ownerContact = this.config.OWNER_TELEGRAM_ID
                ? await this._getOwnerContact()
                : null;
            const contactLine = ownerContact
                ? `\n\n👤 Hubungi admin: ${ownerContact}`
                : '\n\n👤 Hubungi admin untuk informasi lebih lanjut.';

            let pesan = '🚫 *Akses Ditolak*\n\n';
            if (accessResult.reason === 'blocked') {
                pesan += `Akun Anda telah diblokir.${contactLine}`;
            } else if (accessResult.reason === 'expired') {
                pesan += `Masa aktif akun Anda telah habis.${contactLine}`;
            } else {
                pesan += `Anda tidak memiliki akses ke bot ini.${contactLine}`;
            }
            this.bot.sendMessage(chatId, pesan, { parse_mode: 'Markdown' }).catch(() => { });
            return;
        }

        // Akses OK — lanjut login biasa
        if (this.userSessions.has(chatId)) {
            this.showMainMenu(chatId);
            return;
        }

        // initialize() hanya jalan 1x — cegah race condition multi user
        if (!this._securityInitialized) {
            if (this._securityInitializing) {
                // Ada proses initialize() sedang berjalan, tunggu sebentar lalu coba lagi
                await new Promise(r => setTimeout(r, 1500));
            } else {
                this._securityInitializing = true;
                await this.securitySystem.initialize();
                this._securityInitialized = true;
                this._securityInitializing = false;
            }
        }

        this.showLoginOptions(chatId);
    }

    showLoginOptions(chatId) {
        const menu = {
            reply_markup: {
                keyboard: [
                    ['1. Administrator Access'],
                    ['2. Script Password Access']
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        };

        this.bot.sendMessage(chatId,
            `🔐 FA STARX BOT SECURITY SYSTEM\n\n` +
            `🔑 Login Methods:\n` +
            `1. Administrator Access\n` +
            `2. Script Password Access\n\n` +
            `» Select login method:`,
            menu
        );
    }

    async handlePasswordInput(chatId, password, userState, msg) {
        try {
            let isValid = false;
            let accessLevel = '';

            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            if (userState.action === 'awaiting_admin_password') {
                isValid = (password === this.securitySystem.adminPassword);
                accessLevel = 'admin';
            } else if (userState.action === 'awaiting_script_password') {
                isValid = (password === this.securitySystem.scriptPassword);
                accessLevel = 'script';
            }

            if (isValid) {
                this.userStates.delete(chatId);

                // ── Cek apakah password berubah sejak 2FA dipasang ──
                const tfa = this._get2FA(chatId);
                const salt = this._get2FAMasterSalt(chatId);
                const pwUsed = accessLevel === 'admin'
                    ? this.securitySystem.adminPassword
                    : this.securitySystem.scriptPassword;
                tfa.checkAndUpdatePasswordHash(accessLevel, pwUsed, salt);

                // ── Cek apakah perlu tawarkan setup 2FA (hanya jika belum ada 2FA) ──
                const status = tfa.getStatus(accessLevel, salt);

                if (!status.exists && !status.active) {
                    // 2FA belum ada: tawarkan setup via Telegram
                    const tfaSetup = await this._handle2FATelegram(chatId, accessLevel);
                    if (tfaSetup === 'pending') return; // tunggu input setup 2FA
                }

                // Langsung finish login — tandai masuk pakai password
                await this._finishLoginTelegram(chatId, accessLevel, 'password');

            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                const remainingAttempts = 3 - userState.attempts;
                if (remainingAttempts > 0) {
                    this.bot.sendMessage(chatId,
                        `❌ Wrong password. ${remainingAttempts} attempts left\n\n» Please try again:`
                    );
                } else {
                    this.bot.sendMessage(chatId, `🚫 ACCESS DENIED - Too many failed attempts.`);
                    this.userStates.delete(chatId);
                }
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Login error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    // ── Helper 2FA untuk Telegram mode (per chatId) ──
    _get2FA(chatId) {
        if (!this._twoFAMap) this._twoFAMap = new Map();
        if (!this._twoFAMap.has(chatId)) {
            const dataDir = path.join(__dirname, 'data', `user_${chatId}`);
            this._twoFAMap.set(chatId, new TwoFactorAuth(dataDir));
        }
        return this._twoFAMap.get(chatId);
    }

    _get2FAMasterSalt(chatId) {
        const base = process.env.SYSTEM_ID || 'FASTARX_2FA_DEFAULT_SALT';
        return `${base}_${chatId}`;
    }

    /**
     * Handle 2FA di Telegram mode.
     * Return: 'ok' | 'skipped' | 'pending' | 'failed'
     */
    async _handle2FATelegram(chatId, level) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const status = tfa.getStatus(level, salt);

        if (status.expired) {
            const changedStr2 = status.passwordChangedAt ? tfa._fmtDateTime(status.passwordChangedAt) : '?';
            this.bot.sendMessage(chatId,
                `⏰ *2FA HANGUS*\n\n` +
                `Google Authenticator untuk level *${level.toUpperCase()}* telah hangus.\n` +
                `Password diubah sejak: *${changedStr2}*\n` +
                `(Grace period >7 hari)\n\n` +
                `Silakan setup 2FA baru setelah login.`,
                { parse_mode: 'Markdown' }
            );
            // Izinkan login tetapi 2FA tidak aktif
            return 'ok';
        }

        if (status.active && status.inGrace) {
            this.bot.sendMessage(chatId,
                `⚠️ *2FA GRACE PERIOD*\n\n` +
                `2FA masih valid: *${status.graceDetail ? tfa._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}* tersisa.\n` +
                `Password telah diubah. Segera setup ulang 2FA sebelum habis.`,
                { parse_mode: 'Markdown' }
            );
        }

        if (status.active) {
            // Simpan state: tunggu token 2FA
            this.userStates.set(chatId, {
                action: 'awaiting_2fa_token',
                level,
                secret: tfa.getSecret(level, salt),
                attempts: 0
            });

            const graceMsg = status.inGrace ? `\n⚠️ Grace period aktif: *${status.graceDetail ? tfa._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}* tersisa` : '';
            this.bot.sendMessage(chatId,
                `🔐 *GOOGLE AUTHENTICATOR*\n\n` +
                `Level: *${level.toUpperCase()}*${graceMsg}\n\n` +
                `Masukkan kode 6-digit dari Google Authenticator.\n` +
                `Ketik *skip* untuk melewati verifikasi.`,
                { parse_mode: 'Markdown' }
            );
            return 'pending';
        }

        // 2FA belum ada → tawarkan setup
        this.userStates.set(chatId, {
            action: 'awaiting_2fa_setup_choice',
            level
        });

        this.bot.sendMessage(chatId,
            `🔐 *SETUP GOOGLE AUTHENTICATOR (OPSIONAL)*\n\n` +
            `Anda belum memasang 2FA untuk level *${level.toUpperCase()}*.\n\n` +
            `• 2FA ADMIN hanya terikat ke password ADMIN\n` +
            `• 2FA SCRIPT hanya terikat ke password SCRIPT\n` +
            `• Jika password diubah, 2FA lama valid 7 hari\n\n` +
            `Ketik *ya* untuk setup sekarang, atau *tidak* untuk skip.`,
            { parse_mode: 'Markdown' }
        );
        return 'pending';
    }

    /**
     * Handler untuk state 2FA di Telegram (dipanggil dari processTextMessage).
     */
    async process2FAInput(chatId, text, userState) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);

        // ── Verifikasi token ──
        if (userState.action === 'awaiting_2fa_token') {
            if (text.toLowerCase() === 'skip') {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `⏭️ 2FA di-skip. Login dilanjutkan.`);
                this._finishLoginTelegram(chatId, userState.level, 'otp');
                return;
            }

            const ok = tfa.verifyTOTP(userState.secret, text.trim());
            if (ok) {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `✅ *2FA VERIFIED!*`, { parse_mode: 'Markdown' });
                this._finishLoginTelegram(chatId, userState.level, 'otp');
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🚫 2FA GAGAL — Terlalu banyak percobaan salah. Login ditolak.`);
                } else {
                    this.bot.sendMessage(chatId,
                        `❌ Kode salah. ${3 - userState.attempts} percobaan tersisa.\n` +
                        `Masukkan ulang, atau ketik *skip*.`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
            return;
        }

        // ── Pilihan setup 2FA ──
        if (userState.action === 'awaiting_2fa_setup_choice') {
            if (text.toLowerCase() === 'ya' || text.toLowerCase() === 'y') {
                const secret = tfa.generateSecret();
                const accountName = `FA_STARX_${userState.level.toUpperCase()}`;
                const uri = tfa.buildOtpAuthUri(secret, accountName);

                this.userStates.set(chatId, {
                    action: 'awaiting_2fa_verify_setup',
                    level: userState.level,
                    secret
                });

                this.bot.sendMessage(chatId,
                    `🔐 *SETUP 2FA — ${userState.level.toUpperCase()}*\n\n` +
                    `*Secret Key* (ketik manual di Google Authenticator):\n` +
                    `\`${secret}\`\n\n` +
                    `*Account*: \`${accountName}\`\n` +
                    `*Issuer*: \`FA STARX BOT\`\n\n` +
                    `📋 *LANGKAH:*\n` +
                    `1. Buka Google Authenticator di HP\n` +
                    `2. Ketuk (+) → "Enter a setup key"\n` +
                    `3. Isi Account: ${accountName}\n` +
                    `4. Isi Key: \`${secret}\`\n` +
                    `5. Pilih "Time based" → Save\n\n` +
                    `Setelah itu kirim kode 6-digit untuk verifikasi:`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `⏭️ 2FA tidak dipasang.`);
                this._finishLoginTelegram(chatId, userState.level, 'otp');
            }
            return;
        }

        // ── Verifikasi saat setup ──
        if (userState.action === 'awaiting_2fa_verify_setup') {
            const ok = tfa.verifyTOTP(userState.secret, text.trim());
            if (ok) {
                // Simpan 2FA (password tidak tersedia di sini, pakai hash kosong sebagai placeholder)
                const config = tfa.load(salt);
                config[userState.level] = {
                    secret: userState.secret,
                    passwordHash: null, // Telegram mode: tidak simpan password hash
                    createdAt: Date.now(),
                    passwordChangedAt: null,
                    active: true
                };
                tfa.save(config, salt);

                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId,
                    `✅ *GOOGLE AUTHENTICATOR BERHASIL DIPASANG!*\n\n` +
                    `Level: *${userState.level.toUpperCase()}*\n\n` +
                    `Saat login berikutnya, Anda akan ditanya kode 2FA.\n` +
                    `Kode bisa di-skip jika tidak mau verifikasi.\n\n` +
                    `⚠️ Simpan secret key di tempat aman sebagai backup!`,
                    { parse_mode: 'Markdown' }
                );
                this._finishLoginTelegram(chatId, userState.level, 'otp');
            } else {
                userState.verifyAttempts = (userState.verifyAttempts || 0) + 1;
                if (userState.verifyAttempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `❌ Verifikasi gagal. 2FA tidak dipasang.`);
                    this._finishLoginTelegram(chatId, userState.level, 'otp');
                } else {
                    this.bot.sendMessage(chatId,
                        `❌ Kode salah. ${3 - userState.verifyAttempts} percobaan tersisa.\nCoba lagi:`
                    );
                }
            }
            return;
        }
    }

    async _finishLoginTelegram(chatId, level, loginMethod = 'password') {
        // Simpan metadata login untuk cek izin 2FA management
        this.userLoginMeta.set(chatId, {
            level,
            loginMethod,   // 'password' | 'otp'
            loginTime: Date.now()
        });
        this.bot.sendMessage(chatId,
            `✅ LOGIN SUCCESSFUL!\n\n` +
            `Welcome, ${level === 'admin' ? 'Administrator' : 'User'}!\n\n` +
            `🔄 Initializing Crypto Auto-Tx Bot for your session...`
        );
        const userSession = await this.initializeCryptoApp(chatId);
        this.userSessions.set(chatId, userSession);
        this.requestNotificationChatId(chatId);
    }

    async initializeCryptoApp(chatId) {
        try {
            const cryptoAppInstance = new CryptoAutoTx(null, this.config, chatId);
            cryptoAppInstance.bot = this.bot;
            // FIX: Set sessionNotificationChatId to the user's own chatId by default
            cryptoAppInstance.sessionNotificationChatId = chatId.toString();

            await cryptoAppInstance.initializeWalletConnect();
            // NOTE: WalletConnect event handlers are already set up inside initializeWalletConnect()
            // via setupWalletConnectEvents(). No need to add duplicate handlers here.

            console.log(`✅ Crypto Auto-Tx Bot session initialized for user ${chatId}`);
            return cryptoAppInstance;

        } catch (error) {
            console.log(`❌ Error initializing Crypto App for ${chatId}:`, error.message);
            this.bot.sendMessage(chatId, `❌ Error initializing Crypto App: ${error.message}`);
            return null;
        }
    }

    requestNotificationChatId(chatId) {
        // Auto-set ke chat ID sendiri, tanya konfirmasi saja
        this.userStates.set(chatId, { action: 'awaiting_notification_choice' });

        this.bot.sendMessage(chatId,
            `💬 *NOTIFIKASI TELEGRAM (PRIBADI)*\n\n` +
            `Aktifkan notifikasi transaksi untuk sesi ini?\n\n` +
            `Notifikasi akan dikirim ke chat ini *(${chatId})*.\n\n` +
            `Ketik *ya* untuk aktifkan, atau *tidak* untuk skip.`,
            { parse_mode: 'Markdown' }
        );
    }

    async processNotificationChatId(chatId, input) {
        try {
            const cryptoApp = this.userSessions.get(chatId);
            if (!cryptoApp) {
                this.bot.sendMessage(chatId, '❌ Sesi Anda tidak ditemukan. /start ulang.');
                return;
            }

            const answer = input.toLowerCase().trim();

            if (answer === 'ya' || answer === 'y') {
                // Auto-set ke chat ID sendiri
                cryptoApp.sessionNotificationChatId = chatId.toString();
                console.log(`[Session ${chatId}] Notifikasi aktif → Chat ID: ${chatId}`);

                this.bot.sendMessage(chatId,
                    `✅ *NOTIFIKASI AKTIF!*\n\n` +
                    `Notifikasi transaksi akan dikirim ke chat ini.\n` +
                    `Chat ID: \`${chatId}\``,
                    { parse_mode: 'Markdown' }
                );

                // Kirim tes notifikasi
                try {
                    await this.bot.sendMessage(chatId, `🔔 *Tes Notifikasi* — Koneksi berhasil! ✅`, { parse_mode: 'Markdown' });
                } catch (e) { /* ignore */ }

            } else {
                // Skip notifikasi
                this.bot.sendMessage(chatId, `⏭️ Notifikasi dinonaktifkan untuk sesi ini.`);
            }

            this.userStates.delete(chatId);
            this.showMainMenu(chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    // ===================================
    // MAIN MENU & NAVIGATION
    // ===================================


    // =============================================
    // == TRANSFER BOT — MENU & FLOW
    // =============================================

    showTransferMenu(chatId) {
        const active = this.transferInstances.get(chatId);
        const activeRow = active
            ? [[{ text: '🛑 Stop Transfer Aktif', callback_data: 'transfer_stop' }]]
            : [];

        const keyboard = [
            [{ text: '🪙 ETH Auto-Forward', callback_data: 'transfer_eth_auto' }],
            [{ text: '🪙 Token Auto-Forward', callback_data: 'transfer_token_auto' }],
            [{ text: '🪙 Token Transfer Once', callback_data: 'transfer_token_once' }],
            [{ text: '🎯 Auto Token Detection', callback_data: 'transfer_auto_detect' }],
            ...activeRow,
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }],
        ];

        this.bot.sendMessage(chatId,
            `💸 *TRANSFER BOT*\n\n` +
            `${active ? '🟢 Ada transfer yang sedang berjalan.\n\n' : ''}` +
            `Wallet diambil dari *Wallet Management*.\n` +
            `Pilih mode transfer:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async startTransferSetup(chatId, mode) {
        // Ambil cryptoApp dari sesi user
        const cryptoApp = this.userSessions.get(chatId);
        if (!cryptoApp) {
            this.bot.sendMessage(chatId, '❌ Sesi tidak ditemukan. Silakan /start ulang.');
            return;
        }

        // Load daftar wallet dari Wallet Management
        const wallets = await cryptoApp.loadWallets();
        const walletEntries = Object.entries(wallets);

        if (walletEntries.length === 0) {
            this.bot.sendMessage(chatId,
                `❌ *Belum ada wallet tersimpan.*\n\n` +
                `Tambahkan wallet dulu melalui *💼 Wallet Management → 📥 Import Wallet* atau *🔐 Generate Wallet*.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'transfer_menu' }]] }
                }
            );
            return;
        }

        // Tampilkan pilihan wallet
        const walletRows = walletEntries.map(([address, data], i) => [{
            text: `${i + 1}. ${data.nickname || address.slice(0, 8) + '...'} — ${address.slice(0, 6)}...${address.slice(-4)}`,
            callback_data: `transfer_pick_wallet_${i}`
        }]);
        walletRows.push([{ text: '❌ Batal', callback_data: 'transfer_menu' }]);

        // Simpan state dengan daftar wallet dan mode
        this.userStates.set(chatId, {
            action: 'transfer_awaiting_wallet_pick',
            mode,
            walletEntries: walletEntries.map(([address, data]) => ({ address, privateKey: data.privateKey, nickname: data.nickname || '' }))
        });

        this.bot.sendMessage(chatId,
            `💸 *${this._transferModeLabel(mode)}*\n\n` +
            `*Pilih wallet sumber:*`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: walletRows } }
        );
    }

    async processTransferSetup(chatId, text, userState) {
        if (text.trim().toLowerCase() === '/cancel' || text.trim().toLowerCase() === 'batal') {
            this.userStates.delete(chatId);
            this.showTransferMenu(chatId);
            return;
        }

        switch (userState.action) {
            case 'transfer_awaiting_network': {
                const networkKeys = Object.keys(NETWORK_CONFIG);
                const choice = parseInt(text.trim());
                if (isNaN(choice) || choice < 1 || choice > networkKeys.length) {
                    this.bot.sendMessage(chatId, `❌ Pilihan tidak valid. Kirim 1-${networkKeys.length}:`);
                    return;
                }
                userState.networkKey = networkKeys[choice - 1];
                const needsToken = ['token_auto', 'token_once'].includes(userState.mode);
                if (needsToken) {
                    userState.action = 'transfer_awaiting_token_address';
                    this.userStates.set(chatId, userState);
                    this.bot.sendMessage(chatId,
                        `✅ Network: *${NETWORK_CONFIG[userState.networkKey].name}*\n\n` +
                        `*Token Contract Address*\n\nKirim alamat kontrak token (0x...):`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_menu' }]] }
                        }
                    );
                } else {
                    userState.tokenAddress = null;
                    userState.action = 'transfer_awaiting_destination';
                    this.userStates.set(chatId, userState);
                    this.bot.sendMessage(chatId,
                        `✅ Network: *${NETWORK_CONFIG[userState.networkKey].name}*\n\n` +
                        `*Alamat Tujuan*\n\nKirim alamat wallet tujuan (0x...):`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_menu' }]] }
                        }
                    );
                }
                break;
            }

            case 'transfer_awaiting_token_address': {
                if (!ethers.isAddress(text.trim())) {
                    this.bot.sendMessage(chatId, '❌ Alamat token tidak valid. Coba lagi:');
                    return;
                }
                userState.tokenAddress = text.trim();
                userState.action = 'transfer_awaiting_destination';
                this.userStates.set(chatId, userState);
                this.bot.sendMessage(chatId,
                    `✅ Token: \`${text.trim()}\`\n\n` +
                    `*Alamat Tujuan*\n\nKirim alamat wallet tujuan (0x...):`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_menu' }]] }
                    }
                );
                break;
            }

            case 'transfer_awaiting_destination': {
                if (!ethers.isAddress(text.trim())) {
                    this.bot.sendMessage(chatId, '❌ Alamat tidak valid. Coba lagi:');
                    return;
                }
                userState.destinationAddress = text.trim();
                userState.action = 'transfer_awaiting_confirm';
                this.userStates.set(chatId, userState);

                const net = NETWORK_CONFIG[userState.networkKey];
                const summary =
                    `📋 *RINGKASAN KONFIGURASI*\n\n` +
                    `🎯 Mode: ${this._transferModeLabel(userState.mode)}\n` +
                    `🌐 Network: ${net.name}\n` +
                    `💼 Wallet: \`${userState.fromAddress}\` _(${userState.accountName})_\n` +
                    `📥 Tujuan: \`${userState.destinationAddress}\`\n` +
                    (userState.tokenAddress ? `🪙 Token: \`${userState.tokenAddress}\`\n` : `🪙 Token: Auto-Detect\n`) +
                    `\nMulai transfer?`;

                this.bot.sendMessage(chatId, summary, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '▶️ Mulai', callback_data: 'transfer_start_nosave' }],
                            [{ text: '❌ Batal', callback_data: 'transfer_menu' }]
                        ]
                    }
                });
                break;
            }
        }
    }

    _transferModeLabel(mode) {
        return {
            'eth_auto': '🪙 ETH Auto-Forward',
            'token_auto': '🪙 Token Auto-Forward',
            'token_once': '🪙 Token Transfer Once',
            'auto_detect': '🎯 Auto Token Detection',
        }[mode] || mode;
    }

    async _startTransferInstance(chatId, config, save = false) {
        // Stop existing instance jika ada
        this.stopTransfer(chatId);

        const net = NETWORK_CONFIG[config.networkKey];
        // Pakai bot Telegram yang sudah ada (notifikasi lewat sistem yang ada)
        const tgNotifier = this._makeTelegramNotifier(chatId);

        let instance;
        const { mode, privateKey, destinationAddress, tokenAddress, accountName } = config;

        if (mode === 'eth_auto') {
            instance = new EthTransfer(net.rpc, privateKey, net.chainId, net.name, tgNotifier);
            instance.startAutoForward(destinationAddress, accountName);
        } else if (mode === 'token_auto') {
            instance = new TokenTransfer(net.rpc, privateKey, net.chainId, net.name, tgNotifier);
            instance.startAutoForward(tokenAddress, destinationAddress, accountName);
        } else if (mode === 'token_once') {
            instance = new TokenTransfer(net.rpc, privateKey, net.chainId, net.name, tgNotifier);
            const result = await instance.sendToken(tokenAddress, destinationAddress);
            if (result) {
                this.bot.sendMessage(chatId,
                    `✅ *Transfer berhasil!*\n\n💰 ${result.amount} ${result.symbol}\n📄 TX: \`${result.hash}\``,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.bot.sendMessage(chatId, '⚠️ Tidak ada saldo untuk ditransfer atau terjadi error.');
            }
            this.userStates.delete(chatId);
            return;
        } else if (mode === 'auto_detect') {
            instance = new AutoTokenDetectionManager(net.rpc, privateKey, net.chainId, net.name, tgNotifier);
            instance.startAutoDetection(destinationAddress, accountName);
        }

        this.transferInstances.set(chatId, { instance, mode, config });
        this.userStates.delete(chatId);

        if (save) {
            try {
                const password = this.config.ADMIN_PASSWORD;
                enhancedConfigManager.addAccount({
                    network: config.networkKey,
                    privateKey, destinationAddress, tokenAddress,
                    accountName, fromAddress: config.fromAddress
                }, password);
            } catch (e) { }
        }

        this.bot.sendMessage(chatId,
            `🟢 *${this._transferModeLabel(mode)} AKTIF*\n\n` +
            `🌐 Network: ${net.name}\n` +
            `📤 Dari: \`${config.fromAddress}\`\n` +
            `📥 Tujuan: \`${destinationAddress}\`\n` +
            `🏷️ Nama: ${accountName}\n\n` +
            `Transfer berjalan di background.\n` +
            `Gunakan *🛑 Stop Transfer* untuk menghentikan.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🛑 Stop Transfer', callback_data: 'transfer_stop' }, { text: '🔙 Menu Utama', callback_data: 'main_menu' }]] }
            }
        );
    }

    _makeTelegramNotifier(chatId) {
        // Adapter agar TelegramNotifier dari transfer bot pakai bot Telegram yang sudah ada
        const self = this;
        return {
            sendNotification: (msg) => {
                try { self.bot.sendMessage(chatId, msg, { parse_mode: 'HTML' }); } catch (e) { }
                return Promise.resolve(true);
            },
            formatTransferAlert: (tokenInfo, amount, network, txHash) =>
                `🟢 <b>TOKEN TRANSFER TERDETEKSI</b>\n\n` +
                `💰 Token: ${tokenInfo.name} (${tokenInfo.symbol})\n` +
                `🔢 Amount: ${amount} ${tokenInfo.symbol}\n` +
                `🌐 Network: ${network}\n` +
                (txHash ? `📄 TX: ${txHash.slice(0, 10)}...${txHash.slice(-8)}\n` : '') +
                `⏰ ${new Date().toLocaleString()}`,
            formatForwardSuccess: (tokenInfo, amount, txHash, network) =>
                `🎉 <b>TRANSFER BERHASIL</b>\n\n` +
                `✅ Status: Confirmed\n` +
                `🪙 Token: ${tokenInfo.name} (${tokenInfo.symbol})\n` +
                `💰 Amount: ${amount} ${tokenInfo.symbol}\n` +
                `🌐 Network: ${network}\n` +
                `📄 TX: ${txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : 'pending'}`,
            formatBotStarted: (mode, network, from, to, tokenAddr, accountName) =>
                `🟡 <b>BOT DIMULAI — ${mode}</b>\n\n` +
                `🌐 Network: ${network}\n` +
                `📤 Wallet: ${from.slice(0, 6)}...${from.slice(-4)}\n` +
                `📥 Tujuan: ${to.slice(0, 6)}...${to.slice(-4)}\n` +
                (tokenAddr ? `🪙 Token: ${tokenAddr.slice(0, 6)}...${tokenAddr.slice(-4)}\n` : `🪙 Token: Auto-Detect\n`) +
                (accountName ? `🏷️ Akun: ${accountName}\n` : '') +
                `⏰ ${new Date().toLocaleString()}`,
            formatTokenDetected: (token) =>
                `🎯 <b>TOKEN TERDETEKSI</b>\n\n` +
                `🪙 ${token.name} (${token.symbol})\n` +
                `💰 Balance: ${token.balance} ${token.symbol}\n` +
                `⏰ ${new Date().toLocaleString()}`,
        };
    }

    stopTransfer(chatId) {
        const active = this.transferInstances.get(chatId);
        if (active && active.instance) {
            try { active.instance.stop(); } catch (e) { }
            this.transferInstances.delete(chatId);
            this.bot.sendMessage(chatId, '🛑 Transfer dihentikan.');
        } else {
            this.bot.sendMessage(chatId, 'ℹ️ Tidak ada transfer yang sedang berjalan.');
        }
    }




    showMainMenu(chatId) {
        if (!this.userSessions.has(chatId)) {
            this.bot.sendMessage(chatId, 'Anda harus login. Kirim /start');
            return;
        }

        const keyboardRows = [
            ['💼 Wallet Management'],
            ['🦊 RPC Inject', '🔗 WalletConnect'],
            ['🌐 RPC Management', '💸 Transfer Bot'],
            ['⚙️ Pengaturan'],
        ];

        const menu = {
            reply_markup: {
                keyboard: keyboardRows,
                resize_keyboard: true,
                one_time_keyboard: false
            }
        };

        const ownerTag = this.isOwner(chatId) ? '\n👑 Anda login sebagai Owner.' : '';
        this.bot.sendMessage(chatId,
            `🤖 FA STARX BOT v19.0 - MAIN MENU\n(Session: ${chatId})${ownerTag}\n\nPilih menu di bawah:`,
            menu
        );
    }

    // ─── MENU PENGATURAN (semua user) ───────────────────────────────────────
    showPengaturanMenu(chatId) {
        const isOwner = this.isOwner(chatId);
        const keyboard = [
            [{ text: '📊 Info & Status', callback_data: 'info_menu' }],
            [{ text: '🔐 Kelola 2FA', callback_data: '2fa_menu' }],
            [{ text: '🔑 Ubah Sandi', callback_data: 'owner_change_password_menu' }],
            [{ text: '🚪 Logout', callback_data: 'logout_confirm' }],
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }],
        ];
        this.bot.sendMessage(chatId,
            `⚙️ *PENGATURAN*\n\n` +
            `${isOwner ? '👑 Owner Mode\n\n' : ''}` +
            `Pilih menu:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    // ─── MENU UBAH SANDI (inline, owner only) ────────────────────────────────
    showUbahSandiMenu(chatId) {
        if (!this.isOwner(chatId)) {
            this.bot.sendMessage(chatId,
                `🚫 *Akses Ditolak*\n\nFitur Ubah Sandi hanya bisa digunakan oleh Owner.`,
                { parse_mode: 'Markdown' }
            );
            this.showPengaturanMenu(chatId);
            return;
        }
        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔑 Ganti Password Admin', callback_data: 'owner_change_admin_pw' }],
                    [{ text: '🔑 Ganti Password Script', callback_data: 'owner_change_script_pw' }],
                    [{ text: '🔙 Kembali', callback_data: 'pengaturan_menu' }],
                ]
            }
        };
        this.bot.sendMessage(chatId,
            `🔑 *UBAH SANDI*\n\nPilih password yang ingin diubah:`,
            { parse_mode: 'Markdown', ...menu }
        );
    }

    // ─── OWNER: Mulai alur ganti password ────────────────────────────────────
    startOwnerChangePassword(chatId, type) {
        if (!this.isOwner(chatId)) {
            this.bot.sendMessage(chatId, '🚫 Akses ditolak.');
            return;
        }
        const label = type === 'admin' ? 'Admin' : 'Script';
        this.userStates.set(chatId, {
            action: 'owner_awaiting_new_password',
            type,
            step: 1
        });
        this.bot.sendMessage(chatId,
            `🔑 *GANTI PASSWORD ${label.toUpperCase()}*\n\n` +
            `Masukkan password baru (minimal 6 karakter):\n` +
            `_(kirim /cancel untuk membatalkan)_`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'owner_change_password_menu' }]] }
            }
        );
    }

    // ─── OWNER: Proses input password baru ───────────────────────────────────
    async processOwnerChangePassword(chatId, text, userState) {
        // Cancel
        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '⏹️ Dibatalkan.');
            this.showUbahSandiMenu(chatId);
            return;
        }

        const label = userState.type === 'admin' ? 'Admin' : 'Script';

        if (userState.step === 1) {
            // Langkah 1: input password baru
            if (text.trim().length < 6) {
                this.bot.sendMessage(chatId, '❌ Password minimal 6 karakter. Coba lagi:');
                return;
            }
            userState.newPassword = text.trim();
            userState.step = 2;
            this.userStates.set(chatId, userState);
            this.bot.sendMessage(chatId,
                `✅ Password baru diterima.\n\n` +
                `Konfirmasi: kirim ulang password baru yang sama:`
            );
        } else if (userState.step === 2) {
            // Langkah 2: konfirmasi
            if (text.trim() !== userState.newPassword) {
                this.bot.sendMessage(chatId,
                    `❌ Password tidak cocok.\n\nMulai ulang — masukkan password baru lagi:`
                );
                userState.step = 1;
                delete userState.newPassword;
                this.userStates.set(chatId, userState);
                return;
            }

            // Simpan ke .env
            const result = this._updatePasswordInEnv(userState.type, userState.newPassword);
            this.userStates.delete(chatId);

            if (result.ok) {
                // Notifikasi grace period 2FA jika ada
                const tfa = this._get2FA(chatId);
                const salt = this._get2FAMasterSalt(chatId);
                const tfaStatus = tfa.getStatus(userState.type, salt);
                if (tfaStatus.active) {
                    tfa.onPasswordChanged(userState.type, salt);
                }

                this.bot.sendMessage(chatId,
                    `✅ *Password ${label} berhasil diubah!*\n\n` +
                    `Password baru sudah aktif, berlaku langsung tanpa restart.\n\n` +
                    (tfaStatus.active
                        ? `⚠️ 2FA ${label} akan masuk grace period 7 hari karena password berubah.`
                        : ''),
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.bot.sendMessage(chatId, `❌ Gagal menyimpan password: ${result.msg}`);
            }
            this.showUbahSandiMenu(chatId);
        }
    }

    // ===================================
    // WALLET MANAGEMENT (UPDATED dengan Fitur Baru)
    // ===================================

    showWalletMenu(cryptoApp, chatId) {
        if (!cryptoApp) return;

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📥 Import (Private Key)', callback_data: 'wallet_import' },
                        { text: '🌱 Import (Mnemonic)', callback_data: 'wallet_import_mnemonic' }
                    ],
                    [
                        { text: '🔐 Generate Wallet', callback_data: 'wallet_generate' }
                    ],
                    [
                        { text: '📋 List/Pilih Wallet', callback_data: 'wallet_list' },
                        { text: '🔑 Backup Phrase [BARU]', callback_data: 'wallet_backup_list' }
                    ],
                    [
                        { text: '🗑️ Hapus Wallet', callback_data: 'wallet_delete_menu' }
                    ],
                    [
                        { text: '💰 Cek Balance', callback_data: 'wallet_balance' },
                        { text: '📊 TX Stats', callback_data: 'wallet_stats' }
                    ],
                    [
                        { text: '🔙 Main Menu', callback_data: 'main_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId, '💼 WALLET MANAGEMENT:', menu);
    }

    // ==============================================
    // [FITUR BARU] Generate Wallet di Telegram
    // ==============================================

    async startGenerateWallet(cryptoApp, chatId) {
        this.userStates.set(chatId, { action: 'awaiting_generate_wallet_name' });

        this.bot.sendMessage(chatId,
            `🔐 GENERATE WALLET BARU\n\n` +
            `Bot akan membuatkan wallet baru untuk Anda.\n\n` +
            `Beri nama untuk wallet ini (contoh: "Wallet Harian"):\n` +
            `(atau kirim "skip" untuk nama otomatis)`
        );
    }

    async processGenerateWalletName(cryptoApp, chatId, input) {
        try {
            let nickname = input;
            if (input.toLowerCase() === 'skip') {
                nickname = '';
            }

            await this.bot.sendMessage(chatId, '⏳ Mengenerate wallet baru... Mohon tunggu...');

            const newWallet = await cryptoApp.generateNewWallet();

            // Format pesan dengan mnemonic
            const message =
                `✅ WALLET BERHASIL DIBUAT!\n\n` +
                `📍 Address: \`${newWallet.address}\`\n` +
                `🔑 Private Key: \`${newWallet.privateKey}\`\n\n` +
                `🔐 BACKUP PHRASE (12 KATA):\n` +
                `||${newWallet.mnemonic}||\n\n` +
                `⚠️ *PERINGATAN PENTING:*\n` +
                `• Simpan 12 kata di atas di tempat AMAN!\n` +
                `• Jangan pernah bagikan ke siapapun!\n` +
                `• Jika hilang, wallet TIDAK BISA dipulihkan!`;

            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

            // Tanya apakah mau disimpan
            const saveMenu = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Simpan Wallet', callback_data: `wallet_save_generated_${newWallet.address}` },
                            { text: '❌ Jangan Simpan', callback_data: 'wallet_menu' }
                        ]
                    ]
                }
            };

            // Simpan data wallet sementara di userState
            this.userStates.set(chatId, {
                action: 'confirm_save_generated',
                tempData: {
                    privateKey: newWallet.privateKey,
                    mnemonic: newWallet.mnemonic,
                    address: newWallet.address,
                    nickname: nickname || `Wallet_${Date.now().toString().slice(-4)}`
                }
            });

            this.bot.sendMessage(chatId, 'Simpan wallet ini?', saveMenu);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal generate wallet: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async confirmSaveGeneratedWallet(cryptoApp, chatId, address) {
        const userState = this.userStates.get(chatId);
        if (!userState?.tempData || userState.tempData.address !== address) {
            this.bot.sendMessage(chatId, '❌ Data wallet expired. Silakan generate ulang.');
            return;
        }

        try {
            const { privateKey, mnemonic, nickname } = userState.tempData;

            const saved = await cryptoApp.saveWalletWithMnemonic(privateKey, mnemonic, nickname);

            if (saved) {
                this.bot.sendMessage(chatId,
                    `✅ Wallet berhasil disimpan dengan nama: *${nickname}*`,
                    { parse_mode: 'Markdown' }
                );

                const useNow = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🟢 Gunakan Sekarang', callback_data: `wallet_use_${address}` },
                                { text: '🔙 Kembali ke Menu', callback_data: 'wallet_menu' }
                            ]
                        ]
                    }
                };

                this.bot.sendMessage(chatId, 'Gunakan wallet ini sekarang?', useNow);
            } else {
                this.bot.sendMessage(chatId, '❌ Gagal menyimpan wallet.');
            }

            this.userStates.delete(chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    // ==============================================
    // [FITUR BARU] Lihat Backup Phrase di Telegram
    // ==============================================

    async showBackupList(cryptoApp, chatId) {
        try {
            const allWallets = await cryptoApp.listAllWalletsBackup();

            if (allWallets.length === 0) {
                this.bot.sendMessage(chatId,
                    `📭 Tidak ada wallet yang tersimpan.`
                );
                return;
            }

            const buttons = [];
            allWallets.forEach((wallet) => {
                const tag = wallet.mnemonic ? '🌱' : '🔑';
                buttons.push([
                    {
                        text: `${tag} ${wallet.nickname} (${wallet.address.slice(0, 6)}...)`,
                        callback_data: `wallet_show_backup_${wallet.address}`
                    }
                ]);
            });

            buttons.push([{ text: '🔙 Kembali', callback_data: 'wallet_menu' }]);

            this.bot.sendMessage(chatId,
                `🔐 *BACKUP WALLET*\n\n` +
                `🌱 = Ada Mnemonic   🔑 = Private Key Only\n\n` +
                `Pilih wallet untuk lihat data backup:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
            );

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async showBackupPhrase(cryptoApp, chatId, address) {
        try {
            const result = await cryptoApp.getWalletMnemonic(address);

            if (!result.success) {
                this.bot.sendMessage(chatId, `❌ ${result.message}`);
                return;
            }

            // Selalu tampilkan private key
            let msg =
                `🔐 *BACKUP DATA — ${result.nickname}*\n\n` +
                `📍 *Address:*\n` +
                `\`${result.address}\`\n\n` +
                `🔑 *PRIVATE KEY:*\n` +
                `||\`${result.privateKey}\`||\n\n`;

            // Tampilkan mnemonic jika ada
            if (result.mnemonic) {
                msg +=
                    `🌱 *MNEMONIC / SEED PHRASE:*\n` +
                    `||${result.mnemonic}||\n\n`;
            } else {
                msg += `ℹ️ _Wallet ini tidak memiliki mnemonic (diimpor via private key)._\n\n`;
            }

            msg +=
                `⚠️ *PERINGATAN KEAMANAN:*\n` +
                `• Hanya tampilkan di layar pribadi!\n` +
                `• Jangan screenshot atau simpan di cloud!\n` +
                `• Simpan offline (kertas / hardware wallet)`;

            await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

            this.bot.sendMessage(chatId, 'Kembali ke daftar backup:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔙 Kembali', callback_data: 'wallet_backup_list' }
                    ]]
                }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    // ==============================================
    // WALLET MANAGEMENT (Fungsi Existing yang Diupdate)
    // ==============================================

    async showDeleteWalletMenu(cryptoApp, chatId) {
        try {
            const wallets = await cryptoApp.loadWallets();
            if (Object.keys(wallets).length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada wallet untuk dihapus.');
                return;
            }

            const buttons = [];
            Object.entries(wallets).forEach(([address, data]) => {
                buttons.push([
                    {
                        text: `🗑️ ${data.nickname} (${address.slice(0, 6)}...)`,
                        callback_data: `wallet_delete_confirm_${address}`
                    }
                ]);
            });

            buttons.push([{ text: '🔙 Batal', callback_data: 'wallet_menu' }]);

            this.bot.sendMessage(chatId, 'Pilih wallet yang akan dihapus:', {
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async confirmDeleteWallet(cryptoApp, chatId, address) {
        const wallets = await cryptoApp.loadWallets();
        const walletData = wallets[address];

        if (!walletData) {
            this.bot.sendMessage(chatId, '❌ Wallet tidak ditemukan.');
            return;
        }

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `🔴 HAPUS ${walletData.nickname}`, callback_data: `wallet_delete_exec_${address}` },
                        { text: '🟢 Batal', callback_data: 'wallet_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId, `Yakin ingin menghapus wallet ${walletData.nickname} (${address})?`, menu);
    }

    async executeDeleteWallet(cryptoApp, chatId, address) {
        try {
            const deleted = await cryptoApp.deleteWallet(address);
            if (deleted) {
                this.bot.sendMessage(chatId, `✅ Wallet berhasil dihapus.`);
            } else {
                this.bot.sendMessage(chatId, '❌ Gagal menghapus wallet.');
            }
            this.showWalletMenu(cryptoApp, chatId);
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async importWalletFlow(cryptoApp, chatId) {
        this.userStates.set(chatId, { action: 'awaiting_wallet_import' });

        this.bot.sendMessage(chatId,
            `📥 *IMPORT WALLET — PRIVATE KEY*\n\n` +
            `Kirim private key:\n` +
            `Format: \`0x...\` atau tanpa \`0x\`\n\n` +
            `⚠️ Private key akan dienkripsi dan disimpan aman.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wallet_menu' }]] }
            }
        );
    }

    async importMnemonicFlow(cryptoApp, chatId) {
        this.userStates.set(chatId, { action: 'awaiting_mnemonic_input' });

        this.bot.sendMessage(chatId,
            `🌱 *IMPORT WALLET — MNEMONIC / SEED PHRASE*\n\n` +
            `Kirim 12 atau 24 kata mnemonic kamu, pisahkan dengan spasi.\n\n` +
            `Contoh:\n` +
            `\`word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12\`\n\n` +
            `⚠️ Pesan berisi mnemonic akan langsung dihapus dari chat setelah diproses.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wallet_menu' }]] }
            }
        );
    }

    async processMnemonicImport(cryptoApp, chatId, text, msg) {
        // Hapus pesan mnemonic dari chat langsung untuk keamanan
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const mnemonic = text.trim().toLowerCase().replace(/\s+/g, ' ');
        const wordCount = mnemonic.split(' ').length;

        if (wordCount !== 12 && wordCount !== 24) {
            this.bot.sendMessage(chatId,
                `❌ Jumlah kata tidak valid.\n` +
                `Kamu memasukkan *${wordCount} kata*. Harus *12 atau 24 kata*.\n\n` +
                `Coba lagi:`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            const defaultPath = "m/44'/60'/0'/0/0";
            const hdWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, defaultPath);

            // Simpan mnemonic & wallet sementara, tanya path & nama
            this.userStates.set(chatId, {
                action: 'awaiting_mnemonic_path',
                tempData: {
                    mnemonic,
                    privateKey: hdWallet.privateKey,
                    address: hdWallet.address,
                    path: defaultPath
                }
            });

            this.bot.sendMessage(chatId,
                `✅ *MNEMONIC VALID!*\n\n` +
                `📍 Address : \`${hdWallet.address}\`\n` +
                `🛤️ Path    : \`${defaultPath}\`\n\n` +
                `Gunakan derivation path custom? (ketik path-nya, atau ketik *skip* untuk pakai default)\n` +
                `Contoh: \`m/44'/60'/0'/0/1\` untuk wallet index ke-2`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip (Pakai Default)', callback_data: 'mnemonic_path_skip' }]] }
                }
            );

        } catch (e) {
            this.bot.sendMessage(chatId,
                `❌ *Mnemonic tidak valid!*\n\nPastikan kata-kata benar dan urutan sesuai.`,
                { parse_mode: 'Markdown' }
            );
            this.userStates.delete(chatId);
        }
    }

    async processMnemonicPath(cryptoApp, chatId, pathInput) {
        const userState = this.userStates.get(chatId);
        if (!userState?.tempData) {
            this.bot.sendMessage(chatId, '❌ Session expired. Ulangi dari awal.');
            return;
        }

        const { mnemonic } = userState.tempData;

        if (pathInput.toLowerCase() !== 'skip') {
            try {
                const customWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, pathInput.trim());
                userState.tempData.privateKey = customWallet.privateKey;
                userState.tempData.address = customWallet.address;
                userState.tempData.path = pathInput.trim();
                this.bot.sendMessage(chatId, `✅ Path custom digunakan: \`${pathInput.trim()}\`\nAddress: \`${customWallet.address}\``, { parse_mode: 'Markdown' });
            } catch (e) {
                this.bot.sendMessage(chatId, `❌ Path tidak valid: ${e.message}\nMenggunakan path default.`);
            }
        }

        userState.action = 'awaiting_mnemonic_name';
        this.userStates.set(chatId, userState);

        this.bot.sendMessage(chatId,
            `📍 *Address*: \`${userState.tempData.address}\`\n\nBeri nama wallet ini:`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip (Tanpa Nama)', callback_data: 'mnemonic_name_skip' }]] }
            }
        );
    }

    async finishMnemonicImport(cryptoApp, chatId, nickname) {
        const userState = this.userStates.get(chatId);
        if (!userState?.tempData) {
            this.bot.sendMessage(chatId, '❌ Session expired.');
            return;
        }

        const { privateKey, mnemonic, address } = userState.tempData;
        const finalName = nickname || `Wallet_${Date.now().toString().slice(-4)}`;

        try {
            const saved = await cryptoApp.saveWalletWithMnemonic(privateKey, mnemonic, finalName);

            if (saved) {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId,
                    `✅ *WALLET BERHASIL DIIMPOR!*\n\n` +
                    `🏷️ Nama    : ${finalName}\n` +
                    `📍 Address : \`${address}\`\n\n` +
                    `Mnemonic tersimpan terenkripsi.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🟢 Gunakan Sekarang', callback_data: `wallet_use_${address}` }],
                                [{ text: '🔙 Menu Wallet', callback_data: 'wallet_menu' }]
                            ]
                        }
                    }
                );
            } else {
                this.bot.sendMessage(chatId, '❌ Gagal menyimpan wallet.');
                this.userStates.delete(chatId);
            }
        } catch (e) {
            this.bot.sendMessage(chatId, `❌ Error: ${e.message}`);
            this.userStates.delete(chatId);
        }
    }

    async processWalletImport(cryptoApp, chatId, privateKey, msg) {
        try {
            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            if (!privateKey.startsWith('0x')) {
                privateKey = '0x' + privateKey;
            }

            const wallet = new ethers.Wallet(privateKey);

            this.userStates.set(chatId, {
                action: 'awaiting_wallet_name',
                tempData: { privateKey: privateKey, address: wallet.address }
            });

            this.bot.sendMessage(chatId,
                `✅ Private Key Valid!\n\n` +
                `📍 Address: \`${wallet.address}\`\n\n` +
                `Sekarang beri nama wallet:`
            );

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Private Key invalid: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async processWalletName(cryptoApp, chatId, walletName) {
        const userState = this.userStates.get(chatId);
        if (!userState?.tempData) {
            this.bot.sendMessage(chatId, '❌ Session expired.');
            return;
        }

        try {
            const { privateKey, address } = userState.tempData;
            const saved = await cryptoApp.saveWallet(privateKey, walletName);

            if (saved) {
                this.bot.sendMessage(chatId,
                    `✅ WALLET BERHASIL DISIMPAN!\n\n` +
                    `🏷️ ${walletName}\n` +
                    `📍 \`${address}\``,
                    { parse_mode: 'Markdown' }
                );

                this.userStates.delete(chatId);
                this.showWalletMenu(cryptoApp, chatId);
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async listWallets(cryptoApp, chatId, callbackPrefix = 'wallet_select_') {
        try {
            const wallets = await cryptoApp.loadWallets();
            if (Object.keys(wallets).length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada wallet.');
                return;
            }

            let message = '💼 WALLET YANG DISIMPAN:\n\n';
            const buttons = [];

            Object.entries(wallets).forEach(([address, data], index) => {
                const isActive = cryptoApp.wallet?.address?.toLowerCase() === address.toLowerCase();
                const hasMnemonic = data.mnemonic ? '🔐' : '🔑';

                message += `${isActive ? '🟢 ' : '⚪️ '}${index + 1}. ${data.nickname} ${hasMnemonic}\n`;
                message += `   📍 \`${address}\`\n`;
                message += `   📊 TX: ${data.initialTxCount || 0}\n\n`;

                buttons.push([
                    {
                        text: `${isActive ? '🟢 ' : ''}${data.nickname}`,
                        callback_data: `${callbackPrefix}${address}`
                    }
                ]);
            });

            if (callbackPrefix === 'wallet_select_') {
                buttons.push([{ text: '🔙 Kembali', callback_data: 'wallet_menu' }]);
            } else {
                buttons.push([{ text: '🔙 Batal', callback_data: 'wc_menu' }]);
            }

            this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async selectWallet(cryptoApp, chatId, address) {
        try {
            const wallets = await cryptoApp.loadWallets();
            const walletData = wallets[address];

            if (walletData) {
                const setupSuccess = cryptoApp.setupWallet(walletData.privateKey);

                if (setupSuccess) {
                    wallets[address].lastUsed = new Date().toISOString();
                    await cryptoApp.saveWallets(wallets);

                    this.bot.sendMessage(chatId,
                        `✅ WALLET DIPILIH!\n\n` +
                        `🏷️ ${walletData.nickname}\n` +
                        `📍 \`${address}\`\n\n` +
                        `Wallet aktif dan siap digunakan.`,
                        { parse_mode: 'Markdown' }
                    );

                    await this.checkBalance(cryptoApp, chatId);
                }
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async getTransactionStats(cryptoApp, chatId) {
        if (!cryptoApp.wallet) {
            this.bot.sendMessage(chatId, '❌ Wallet belum setup!');
            return;
        }

        try {
            await this.bot.sendMessage(chatId, '📊 Getting transaction statistics...');

            const walletInfo = await cryptoApp.getWalletInfo(cryptoApp.wallet.address);
            const balance = await cryptoApp.provider.getBalance(cryptoApp.wallet.address);
            const balanceEth = ethers.formatEther(balance);

            const message =
                `📊 TRANSACTION STATISTICS\n\n` +
                `💳 \`${cryptoApp.wallet.address}\`\n` +
                `💰 Balance: ${balanceEth} ETH\n` +
                `📈 Total Transactions: ${walletInfo.transactionCount}\n` +
                `🕒 Status: ${walletInfo.firstSeen}\n` +
                `⛓️ Current Block: ${walletInfo.currentBlock}\n` +
                `🔗 Chain ID: ${cryptoApp.currentChainId}\n` +
                `🌐 RPC: ${cryptoApp.currentRpcName}\n` +
                `🕒 ${new Date().toLocaleString()}`;

            this.bot.sendMessage(chatId, message);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error getting stats: ${error.message}`);
        }
    }

    // ===================================
    // AUTO TRANSACTION MODE (WalletConnect) & DELAY UI
    // ===================================

    showWalletConnectMenu(cryptoApp, chatId) {
        if (!cryptoApp) return;

        const status = cryptoApp.isConnected ? '🟢 TERHUBUNG' : '🔴 TIDAK TERHUBUNG';
        const walletInfo = cryptoApp.wallet ?
            `🟢 Aktif: ${cryptoApp.wallet.address.slice(0, 6)}...` :
            '🔴 Belum ada wallet aktif';

        const delayInfo = cryptoApp.executionDelay > 0
            ? `⏱️ Delay Aktif: ${cryptoApp.executionDelay} Detik`
            : `⏱️ Delay: OFF (Instan)`;

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔄 Ganti/Pilih Wallet', callback_data: 'wc_select_wallet' }
                    ],
                    [
                        { text: '🔗 Connect WC', callback_data: 'wc_connect' },
                        { text: '🔄 Status', callback_data: 'wc_status' }
                    ],
                    [
                        { text: `⏱️ Set Delay (${cryptoApp.executionDelay}s)`, callback_data: 'wc_set_delay' }
                    ],
                    [
                        { text: '🔌 Disconnect', callback_data: 'wc_disconnect' },
                    ],
                    [
                        { text: '🔙 Main Menu', callback_data: 'main_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId,
            `🔗 WALLETCONNECT\n\n` +
            `Status: ${status}\n` +
            `Wallet: ${walletInfo}\n` +
            `Chain: ${cryptoApp.currentChainId}\n` +
            `${delayInfo}\n` +
            `Auto-Save RPC: ${cryptoApp.autoSaveRpc ? 'ON' : 'OFF'}`,
            menu
        );
    }

    async startWalletConnect(cryptoApp, chatId) {
        if (!cryptoApp.wallet) {
            this.bot.sendMessage(chatId, '❌ Belum ada wallet aktif. Silakan pilih wallet dulu.');
            return;
        }

        this.userStates.set(chatId, { action: 'awaiting_wc_uri' });

        this.bot.sendMessage(chatId,
            `🔗 WALLETCONNECT SETUP\n\n` +
            `Wallet Aktif: \`${cryptoApp.wallet.address}\`\n\n` +
            `1. Buka DApp di browser\n` +
            `2. Pilih WalletConnect\n` +
            `3. Copy URI\n` +
            `4. Kirim URI ke sini:`,
            { parse_mode: 'Markdown' }
        );
    }

    async processWalletConnectURI(cryptoApp, chatId, uri, msg) {
        try {
            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            await this.bot.sendMessage(chatId, '🔄 Menghubungkan ke WalletConnect...');

            const connected = await cryptoApp.connectWalletConnect(uri);

            if (connected) {
                this.bot.sendMessage(chatId,
                    `✅ PAIRING DIMULAI!\n\n` +
                    `Bot menunggu proposal dari DApp...`
                );
            } else {
                this.bot.sendMessage(chatId, '❌ Gagal memulai pairing. Cek URI.');
            }

            this.userStates.delete(chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async requestDelayInput(cryptoApp, chatId) {
        this.userStates.set(chatId, { action: 'awaiting_delay_input' });

        this.bot.sendMessage(chatId,
            `⏱️ SMART DELAY EXECUTION\n\n` +
            `Masukkan durasi jeda dalam *DETIK*.\n` +
            `Kirim angka 0 untuk mematikan (Instan).\n` +
            `Contoh: \`5\``,
            { parse_mode: 'Markdown' }
        );
    }

    async processDelayInput(cryptoApp, chatId, input, msg) {
        try {
            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            const delaySeconds = parseInt(input);

            if (isNaN(delaySeconds) || delaySeconds < 0) {
                this.bot.sendMessage(chatId, '❌ Input harus angka positif atau 0. Coba lagi.');
                return;
            }

            cryptoApp.executionDelay = delaySeconds;

            const status = delaySeconds === 0 ? 'NON-AKTIF (Instan)' : `${delaySeconds} Detik`;

            this.bot.sendMessage(chatId,
                `✅ DELAY TERSIMPAN!\n\n` +
                `Status: ${status}`
            );

            this.userStates.delete(chatId);
            this.showWalletConnectMenu(cryptoApp, chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async processRpcInjectAddPort(cryptoApp, chatId, input, userState) {
        try {
            // Step 1: Minta nomor port
            if (userState.step === 'port') {
                const portNum = parseInt(input);
                if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
                    this.bot.sendMessage(chatId, '❌ Port tidak valid. Masukkan angka 1024–65535:',
                        { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rpc_inject_menu' }]] } }
                    );
                    return;
                }
                if (cryptoApp.rpcPortsConfig[portNum]) {
                    this.bot.sendMessage(chatId, `❌ Port ${portNum} sudah ada dalam daftar.`);
                    this.userStates.delete(chatId);
                    await this.showRpcInjectMenu(cryptoApp, chatId);
                    return;
                }
                // Simpan port sementara, minta pilih mode
                this.userStates.set(chatId, { action: 'awaiting_rpc_inject_addport', step: 'mode', tempPort: portNum });
                this.bot.sendMessage(chatId,
                    `Port: *${portNum}*\n\nPilih mode:`,
                    {
                        parse_mode: 'Markdown', reply_markup: {
                            inline_keyboard: [
                                [{ text: '💻 Localhost (127.0.0.1)', callback_data: `rpc_inject_addport_mode_localhost_${portNum}` }],
                                [{ text: '🌐 VPS (0.0.0.0)', callback_data: `rpc_inject_addport_mode_vps_${portNum}` }],
                                [{ text: '❌ Batal', callback_data: 'rpc_inject_menu' }]
                            ]
                        }
                    }
                );
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    // ===================================
    // RPC & GAS MANAGEMENT
    // ===================================

    showRpcMenu(cryptoApp, chatId) {
        if (!cryptoApp) return;

        const autoSaveStatusIcon = cryptoApp.autoSaveRpc ? '✅' : '❌';
        const autoSaveText = `Auto-Save: ${cryptoApp.autoSaveRpc ? 'ON' : 'OFF'}`;

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📡 Pilih RPC', callback_data: 'rpc_select' },
                        { text: '➕ Tambah RPC', callback_data: 'rpc_add' }
                    ],
                    [
                        { text: '⛽ Atur Gas', callback_data: 'rpc_gas_menu' },
                        { text: 'ℹ️ Info RPC', callback_data: 'rpc_info' }
                    ],
                    [
                        { text: '🗑️ Hapus RPC', callback_data: 'rpc_delete_menu' }
                    ],
                    [
                        { text: `${autoSaveStatusIcon} ${autoSaveText}`, callback_data: 'rpc_toggle_autosave' }
                    ],
                    [
                        { text: '🔙 Main Menu', callback_data: 'main_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId, '🌐 RPC MANAGEMENT:', menu);
    }

    async showGasRpcSelection(cryptoApp, chatId) {
        try {
            const rpcList = Object.entries(cryptoApp.savedRpcs);
            if (rpcList.length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada RPC tersimpan.');
                return;
            }

            let message = '⛽ PILIH RPC UNTUK DIEDIT GAS-NYA:\n\n';
            const buttons = [];

            rpcList.forEach(([key, rpc], index) => {
                const gasMode = rpc.gasConfig?.mode || 'auto';
                const gasVal = rpc.gasConfig?.value || 0;
                const status = gasMode === 'auto' ? 'Auto' : (gasMode === 'manual' ? `${gasVal} Gwei` : `+${gasVal}%`);

                message += `${index + 1}. ${rpc.name} [${status}]\n`;

                buttons.push([
                    {
                        text: `${rpc.name} (${status})`,
                        callback_data: `rpc_gas_select_${key}`
                    }
                ]);
            });

            buttons.push([{ text: '🔙 Kembali', callback_data: 'rpc_menu' }]);

            this.bot.sendMessage(chatId, message, {
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async showGasModeSelection(cryptoApp, chatId, rpcKey) {
        const rpc = cryptoApp.savedRpcs[rpcKey];
        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
            return;
        }

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Auto (Default)', callback_data: `rpc_gas_set_auto_${rpcKey}` }
                    ],
                    [
                        { text: '🛠 Manual (Gwei)', callback_data: `rpc_gas_ask_manual_${rpcKey}` },
                        { text: '🚀 Aggressive (% Boost)', callback_data: `rpc_gas_ask_aggressive_${rpcKey}` }
                    ],
                    [
                        { text: '🔙 Batal', callback_data: 'rpc_gas_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId,
            `⛽ SETUP GAS UNTUK: ${rpc.name}\n\n` +
            `Pilih mode:`,
            menu
        );
    }

    async processGasInput(cryptoApp, chatId, value, userState, msg) {
        try {
            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            const rpcKey = userState.tempData.rpcKey;
            const mode = userState.tempData.mode;
            const numValue = parseFloat(value);

            if (isNaN(numValue) || numValue < 0) {
                this.bot.sendMessage(chatId, '❌ Nilai harus angka positif. Coba lagi.');
                return;
            }

            if (!cryptoApp.savedRpcs[rpcKey]) {
                this.bot.sendMessage(chatId, '❌ RPC target hilang. Setup dibatalkan.');
                this.userStates.delete(chatId);
                return;
            }

            cryptoApp.savedRpcs[rpcKey].gasConfig = {
                mode: mode,
                value: numValue
            };

            cryptoApp.saveRpcConfig();

            const unit = mode === 'manual' ? 'Gwei' : '%';

            this.bot.sendMessage(chatId,
                `✅ GAS CONFIG TERSIMPAN!\n\n` +
                `RPC: ${cryptoApp.savedRpcs[rpcKey].name}\n` +
                `Mode: ${mode.toUpperCase()}\n` +
                `Value: ${numValue} ${unit}`
            );

            this.userStates.delete(chatId);
            this.showRpcMenu(cryptoApp, chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async showRpcInfo(cryptoApp, chatId) {
        const gasConf = cryptoApp.getActiveRpcGasConfig();

        this.bot.sendMessage(chatId,
            `ℹ️ INFORMASI RPC SAAT INI\n\n` +
            `🏷️ Nama: ${cryptoApp.currentRpcName}\n` +
            `🔗 URL: ${cryptoApp.currentRpc}\n` +
            `⛓️ Chain: ${cryptoApp.currentChainId}\n` +
            `⛽ Gas Mode: ${gasConf.mode.toUpperCase()} ${gasConf.mode !== 'auto' ? `(${gasConf.value})` : ''}\n` +
            `⚙️ Auto-Save DApp: ${cryptoApp.autoSaveRpc ? 'ON' : 'OFF'}`
        );
    }

    async startAddRpcFlow(cryptoApp, chatId, step = 1, data = {}) {
        this.userStates.set(chatId, { action: 'awaiting_rpc_add', step, data });

        if (step === 1) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (1/3)\n\nKirim Nama RPC (contoh: RPC Sepolia):');
        } else if (step === 2) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (2/3)\n\nKirim URL RPC (contoh: https://...):');
        } else if (step === 3) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (3/3)\n\nKirim Chain ID (contoh: 11155111):');
        }
    }

    async processAddRpc(cryptoApp, chatId, input, userState) {
        const { step, data } = userState;

        try {
            if (step === 1) {
                data.name = input;
                await this.startAddRpcFlow(cryptoApp, chatId, 2, data);

            } else if (step === 2) {
                if (!input.startsWith('http')) {
                    this.bot.sendMessage(chatId, '❌ URL tidak valid. Harus dimulai http/https. Coba lagi:');
                    return;
                }
                data.url = input;
                await this.startAddRpcFlow(cryptoApp, chatId, 3, data);

            } else if (step === 3) {
                const chainIdNum = parseInt(input);
                if (isNaN(chainIdNum) || chainIdNum <= 0) {
                    this.bot.sendMessage(chatId, '❌ Chain ID tidak valid. Harus angka positif. Coba lagi:');
                    return;
                }

                data.chainId = chainIdNum;
                const key = `custom_${Date.now()}`;

                cryptoApp.savedRpcs[key] = {
                    name: data.name,
                    rpc: data.url,
                    chainId: data.chainId,
                    gasConfig: { mode: 'auto', value: 0 }
                };

                if (cryptoApp.saveRpcConfig()) {
                    this.bot.sendMessage(chatId, `✅ RPC "${data.name}" berhasil disimpan!`);
                    this.userStates.delete(chatId);
                    this.showRpcMenu(cryptoApp, chatId);
                } else {
                    this.bot.sendMessage(chatId, `❌ Gagal menyimpan RPC.`);
                    this.userStates.delete(chatId);
                }
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async showDeleteRpcMenu(cryptoApp, chatId) {
        try {
            const rpcList = Object.entries(cryptoApp.savedRpcs);
            if (rpcList.length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada RPC untuk dihapus.');
                return;
            }

            const buttons = [];

            rpcList.forEach(([key, rpc]) => {
                if (cryptoApp.currentRpc === rpc.rpc) {
                    buttons.push([{ text: `🟢 ${rpc.name} (Aktif)`, callback_data: 'rpc_delete_active' }]);
                } else {
                    buttons.push([
                        {
                            text: `🗑️ ${rpc.name}`,
                            callback_data: `rpc_delete_exec_${key}`
                        }
                    ]);
                }
            });

            buttons.push([{ text: '🔙 Batal', callback_data: 'rpc_menu' }]);

            this.bot.sendMessage(chatId, 'Pilih RPC yang akan dihapus:', {
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async executeDeleteRpc(cryptoApp, chatId, rpcKey) {
        try {
            const rpcData = cryptoApp.savedRpcs[rpcKey];
            if (!rpcData) {
                this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
                return;
            }

            delete cryptoApp.savedRpcs[rpcKey];

            if (cryptoApp.saveRpcConfig()) {
                this.bot.sendMessage(chatId, `✅ RPC "${rpcData.name}" berhasil dihapus!`);
            }

            this.showRpcMenu(cryptoApp, chatId);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async showRpcList(cryptoApp, chatId) {
        try {
            const rpcList = Object.entries(cryptoApp.savedRpcs);
            if (rpcList.length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada RPC tersimpan.');
                return;
            }

            let message = '📡 DAFTAR RPC:\n\n';
            const buttons = [];

            rpcList.forEach(([key, rpc], index) => {
                const isActive = cryptoApp.currentRpc === rpc.rpc;
                const gasMode = rpc.gasConfig?.mode || 'auto';
                const gasInfo = gasMode === 'auto' ? '' : ` (${rpc.gasConfig.value}${gasMode === 'manual' ? ' Gwei' : '%'})`;

                message += `${isActive ? '🟢 ' : '⚪️ '}${index + 1}. ${rpc.name}${gasInfo}\n`;
                message += `   🔗 ${rpc.rpc}\n`;
                message += `   ⛓️ Chain: ${rpc.chainId}\n\n`;

                buttons.push([
                    {
                        text: `${isActive ? '🟢 ' : ''}${rpc.name}`,
                        callback_data: `rpc_use_${key}`
                    }
                ]);
            });

            buttons.push([{ text: '🔙 Kembali', callback_data: 'rpc_menu' }]);

            this.bot.sendMessage(chatId, message, {
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async selectRpc(cryptoApp, chatId, rpcKey) {
        try {
            const selectedRpc = cryptoApp.savedRpcs[rpcKey];
            if (selectedRpc) {
                cryptoApp.currentRpc = selectedRpc.rpc;
                cryptoApp.currentChainId = selectedRpc.chainId;
                cryptoApp.currentRpcName = selectedRpc.name;
                cryptoApp.setupProvider();
                cryptoApp.saveRpcConfig();

                this.bot.sendMessage(chatId,
                    `✅ RPC DIPILIH!\n\n` +
                    `🏷️ ${selectedRpc.name}\n` +
                    `🔗 ${selectedRpc.rpc}\n` +
                    `⛓️ Chain: ${selectedRpc.chainId}`
                );
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    // ===================================
    // INFO & STATUS
    // ===================================

    // ═══════════════════════════════════════════════════════
    // 🔐 2FA MANAGEMENT — TELEGRAM
    // ═══════════════════════════════════════════════════════

    show2FAMenu(chatId) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const adminInfo = tfa.formatStatus('admin', salt);
        const scriptInfo = tfa.formatStatus('script', salt);

        const loginMeta = this.userLoginMeta.get(chatId);
        const loginMethod = loginMeta?.loginMethod || 'otp';
        const loginNote = loginMethod === 'password'
            ? `\n✅ _Login dengan password — bisa ubah/hapus 2FA meski grace period_`
            : `\n⚠️ _Login dengan OTP — tidak bisa ubah/hapus 2FA saat grace period_`;

        const text =
            `🔐 *KELOLA GOOGLE AUTHENTICATOR*\n\n` +
            tfa.renderTelegram('admin', salt) + `\n\n` +
            tfa.renderTelegram('script', salt) +
            loginNote + `\n\n` +
            `Pilih aksi:`;

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔄 Ganti 2FA Admin', callback_data: '2fa_reset_admin' },
                        { text: '🔄 Ganti 2FA Script', callback_data: '2fa_reset_script' }
                    ],
                    [
                        { text: '🗑️ Hapus 2FA Admin', callback_data: '2fa_delete_admin' },
                        { text: '🗑️ Hapus 2FA Script', callback_data: '2fa_delete_script' }
                    ],
                    [
                        { text: '🔙 Kembali', callback_data: 'info_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId, text, { ...menu, parse_mode: 'Markdown' });
    }

    /**
     * Handle 2FA management actions dari Telegram.
     * action: 'reset_admin' | 'reset_script' | 'delete_admin' | 'delete_script'
     */
    async handle2FAAction(chatId, action) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const [op, level] = action.split('_'); // 'reset'/'delete', 'admin'/'script'
        const lbl = level.toUpperCase();
        const status = tfa.getStatus(level, salt);

        // ── Cek apakah user login dengan password atau OTP ──
        const loginMeta = this.userLoginMeta.get(chatId);
        const loginMethod = loginMeta?.loginMethod || 'otp';

        // ── Grace period: izinkan jika login pakai password (baru), blokir jika OTP ──
        if (status.active && status.inGrace) {
            if (loginMethod === 'password') {
                // Login pakai password baru → IZINKAN, lanjut ke bawah
                // (tidak return, eksekusi lanjut ke blok delete/reset)
            } else {
                // Login pakai OTP → BLOKIR
                const remaining = status.graceDetail ? tfa._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari';
                this.bot.sendMessage(chatId,
                    `🔒 *TIDAK BISA ${op === 'delete' ? 'MENGHAPUS' : 'MENGGANTI'} 2FA ${lbl}*\n\n` +
                    `Password *${lbl}* telah diubah, 2FA dalam masa grace period.\n\n` +
                    `⏳ Sisa: *${remaining}*\n\n` +
                    `Kamu masuk menggunakan *OTP lama* — tidak bisa ubah/hapus 2FA.\n\n` +
                    `✅ Untuk bisa ubah/hapus: *login ulang dengan password baru*, lalu coba lagi.`,
                    { parse_mode: 'Markdown' }
                );
                this.show2FAMenu(chatId);
                return;
            }
        }

        if (op === 'delete') {
            if (!status.exists || status.expired) {
                const msg = !status.exists
                    ? `ℹ️ 2FA *${lbl}* belum dipasang.`
                    : `ℹ️ 2FA *${lbl}* sudah hangus dan tidak aktif.`;
                this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                this.show2FAMenu(chatId);
                return;
            }

            // 2FA aktif: tawarkan pilihan verifikasi — OTP atau Password
            const secret = tfa.getSecret(level, salt);
            this.userStates.set(chatId, {
                action: 'awaiting_2fa_delete_method',
                level,
                secret,
                attempts: 0
            });
            this.bot.sendMessage(chatId,
                `🗑️ *HAPUS 2FA ${lbl}*\n\n` +
                `Pilih metode konfirmasi penghapusan:\n\n` +
                `1️⃣ *Kode OTP* — dari Google Authenticator\n` +
                `2️⃣ *Password ${lbl}* — masukkan password login\n\n` +
                `Ketik *1* atau *2*:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '1️⃣ Pakai Kode OTP', callback_data: `2fa_delete_method_otp_${level}` },
                                { text: '2️⃣ Pakai Password', callback_data: `2fa_delete_method_pw_${level}` }
                            ],
                            [{ text: '❌ Batal', callback_data: 'manage_2fa' }]
                        ]
                    }
                }
            );

        } else if (op === 'reset') {
            // ── Jika 2FA hangus (expired): harus verifikasi password BARU dulu ──
            if (status.expired || !status.exists) {
                this.userStates.set(chatId, {
                    action: 'awaiting_2fa_new_password_verify',
                    level,
                    attempts: 0
                });
                this.bot.sendMessage(chatId,
                    `🔄 *SETUP 2FA BARU — ${lbl}*\n\n` +
                    (status.expired
                        ? `2FA *${lbl}* telah hangus karena password sudah diubah.\n\n`
                        : `2FA *${lbl}* belum pernah dipasang.\n\n`) +
                    `Untuk melanjutkan, masukkan *password ${lbl} yang sekarang* (password baru):`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // 2FA aktif normal: verifikasi OTP lama dulu, lalu setup baru
            const secret = tfa.getSecret(level, salt);
            this.userStates.set(chatId, {
                action: 'awaiting_2fa_reset_verify',
                level,
                secret,
                attempts: 0
            });
            this.bot.sendMessage(chatId,
                `🔄 *GANTI 2FA ${lbl}*\n\n` +
                `Verifikasi dengan kode OTP saat ini terlebih dahulu:`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    /**
     * Proses input verifikasi untuk delete/reset 2FA di Telegram.
     */
    async process2FAManageInput(chatId, text, userState) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const { level } = userState;
        const lbl = level.toUpperCase();

        // ── Delete: pilih metode (OTP atau Password) via teks ──
        if (userState.action === 'awaiting_2fa_delete_method') {
            const choice = text.trim();
            if (choice === '1') {
                this.userStates.set(chatId, { action: 'awaiting_2fa_delete_verify', level, secret: userState.secret, attempts: 0 });
                this.bot.sendMessage(chatId,
                    `🔐 *HAPUS 2FA ${lbl} — via OTP*\n\nMasukkan kode 6-digit dari Google Authenticator:`,
                    { parse_mode: 'Markdown' }
                );
            } else if (choice === '2') {
                this.userStates.set(chatId, { action: 'awaiting_2fa_delete_pw_verify', level, attempts: 0 });
                this.bot.sendMessage(chatId,
                    `🔑 *HAPUS 2FA ${lbl} — via Password*\n\nMasukkan password *${lbl}* untuk konfirmasi:`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.bot.sendMessage(chatId, `❌ Pilihan tidak valid. Ketik *1* (OTP) atau *2* (Password):`, { parse_mode: 'Markdown' });
            }
            return;
        }

        // ── Delete: verifikasi via Password ──
        if (userState.action === 'awaiting_2fa_delete_pw_verify') {
            const correctPw = level === 'admin'
                ? this.securitySystem?.adminPassword
                : this.securitySystem?.scriptPassword;
            if (!correctPw) {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `❌ Tidak dapat memverifikasi password. Coba login ulang.`);
                this.show2FAMenu(chatId);
                return;
            }
            if (text.trim() === correctPw) {
                tfa.remove(level, salt);
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `✅ *2FA ${lbl} berhasil dihapus.*\n\n_(Dikonfirmasi via password)_`, { parse_mode: 'Markdown' });
                this.show2FAMenu(chatId);
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🚫 Password salah 3 kali. Operasi dibatalkan.`);
                    this.show2FAMenu(chatId);
                } else {
                    this.bot.sendMessage(chatId, `❌ Password salah. *${3 - userState.attempts} percobaan tersisa.*\nMasukkan ulang:`, { parse_mode: 'Markdown' });
                }
            }
            return;
        }

        // ── Delete: verifikasi OTP ──
        if (userState.action === 'awaiting_2fa_delete_verify') {
            if (tfa.verifyTOTP(userState.secret, text.trim())) {
                tfa.remove(level, salt);
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `✅ *2FA ${lbl} berhasil dihapus.*`, { parse_mode: 'Markdown' });
                this.show2FAMenu(chatId);
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🚫 Terlalu banyak percobaan salah. Operasi dibatalkan.`);
                    this.show2FAMenu(chatId);
                } else {
                    this.bot.sendMessage(chatId, `❌ OTP salah. *${3 - userState.attempts} percobaan tersisa.*\nMasukkan ulang:`, { parse_mode: 'Markdown' });
                }
            }
            return;
        }

        // ── Reset: verifikasi OTP lama sebelum setup baru ──
        if (userState.action === 'awaiting_2fa_reset_verify') {
            if (tfa.verifyTOTP(userState.secret, text.trim())) {
                this.userStates.delete(chatId);
                tfa.remove(level, salt);
                await this._telegram2FASetupNew(chatId, level);
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🚫 Terlalu banyak percobaan. Operasi dibatalkan.`);
                    this.show2FAMenu(chatId);
                } else {
                    this.bot.sendMessage(chatId, `❌ OTP salah. *${3 - userState.attempts} percobaan tersisa.*\nMasukkan ulang:`, { parse_mode: 'Markdown' });
                }
            }
            return;
        }

        // ── Setup baru setelah expired: verifikasi password BARU ──
        if (userState.action === 'awaiting_2fa_new_password_verify') {
            const correctPw = level === 'admin'
                ? this.securitySystem?.adminPassword
                : this.securitySystem?.scriptPassword;

            if (!correctPw) {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `❌ Tidak dapat memverifikasi password saat ini. Coba login ulang.`);
                this.show2FAMenu(chatId);
                return;
            }

            if (text.trim() === correctPw) {
                this.userStates.delete(chatId);
                // Bersihkan data 2FA lama yang expired
                const statusNow = tfa.getStatus(level, salt);
                if (statusNow.exists) tfa.remove(level, salt);
                await this._telegram2FASetupNew(chatId, level);
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🚫 Password salah 3 kali. Operasi dibatalkan.`);
                    this.show2FAMenu(chatId);
                } else {
                    this.bot.sendMessage(chatId,
                        `❌ Password salah. *${3 - userState.attempts} percobaan tersisa.*\n` +
                        `Masukkan password *${lbl}* yang sekarang (password baru):`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
            return;
        }

        // ── Verifikasi kode OTP dari GA untuk setup baru ──
        if (userState.action === 'awaiting_2fa_setup_new_verify') {
            if (tfa.verifyTOTP(userState.secret, text.trim())) {
                const config = tfa.load(salt);
                const pwNow = level === 'admin'
                    ? this.securitySystem?.adminPassword
                    : this.securitySystem?.scriptPassword;
                const pwHashSave = pwNow
                    ? require('crypto').createHash('sha256').update(pwNow).digest('hex')
                    : null;
                config[level] = {
                    secret: userState.secret,
                    passwordHash: pwHashSave,
                    createdAt: Date.now(),
                    passwordChangedAt: null,
                    active: true
                };
                tfa.save(config, salt);
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId,
                    `✅ *2FA ${lbl} BERHASIL DIPASANG!*\n\n` +
                    `Login berikutnya bisa pakai *Password* atau *OTP*.\n` +
                    `⚠️ Simpan secret key di tempat aman sebagai backup!`,
                    { parse_mode: 'Markdown' }
                );
                this.show2FAMenu(chatId);
            } else {
                userState.verifyAttempts = (userState.verifyAttempts || 0) + 1;
                if (userState.verifyAttempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `❌ Verifikasi gagal. 2FA baru tidak dipasang.`);
                    this.show2FAMenu(chatId);
                } else {
                    this.bot.sendMessage(chatId, `❌ Kode salah. *${3 - userState.verifyAttempts} percobaan tersisa.*\nMasukkan ulang:`, { parse_mode: 'Markdown' });
                }
            }
            return;
        }
    }

    async _telegram2FASetupNew(chatId, level) {
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const lbl = level.toUpperCase();
        const secret = tfa.generateSecret();
        const accountName = `FA_STARX_${lbl}`;

        this.userStates.set(chatId, {
            action: 'awaiting_2fa_setup_new_verify',
            level,
            secret
        });

        this.bot.sendMessage(chatId,
            `🔐 *SETUP 2FA BARU — ${lbl}*\n\n` +
            `*Secret Key* (ketik manual di Google Authenticator):\n` +
            `\`${secret}\`\n\n` +
            `*Account*: \`${accountName}\`\n` +
            `*Issuer*: \`FA STARX BOT\`\n\n` +
            `📋 *LANGKAH:*\n` +
            `1. Buka Google Authenticator\n` +
            `2. Ketuk (+) → "Enter a setup key"\n` +
            `3. Isi Account: \`${accountName}\`\n` +
            `4. Isi Key: \`${secret}\`\n` +
            `5. Pilih "Time based" → Save\n\n` +
            `Setelah itu kirim kode 6-digit untuk verifikasi:`,
            { parse_mode: 'Markdown' }
        );
    }

    showInfoMenu(cryptoApp, chatId) {
        if (!cryptoApp) return;

        // Tampilkan status 2FA real-time
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const adminInfo = tfa.formatStatus('admin', salt);
        const scriptInfo = tfa.formatStatus('script', salt);

        const tfaText =
            `\n🔐 *STATUS GOOGLE AUTHENTICATOR*\n` +
            tfa.renderTelegram('admin', salt) + `\n` +
            tfa.renderTelegram('script', salt) + `\n`;

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🤖 Status Bot', callback_data: 'info_status' },
                        { text: '💰 Cek Balance', callback_data: 'wallet_balance' }
                    ],
                    [
                        { text: '📊 TX Stats', callback_data: 'wallet_stats' },
                        { text: 'ℹ️ Info RPC', callback_data: 'rpc_info' }
                    ],
                    [
                        { text: '🔙 Main Menu', callback_data: 'main_menu' }
                    ]
                ]
            }
        };

        this.bot.sendMessage(chatId, `📊 *INFO & STATUS*${tfaText}`, { ...menu, parse_mode: 'Markdown' });
    }

    async checkBalance(cryptoApp, chatId) {
        if (!cryptoApp.wallet) {
            this.bot.sendMessage(chatId, '❌ Belum ada wallet yang dipilih.');
            return;
        }

        try {
            await this.bot.sendMessage(chatId, '🔄 Mengecek balance...');

            const balanceInfo = await cryptoApp.checkBalance();

            if (balanceInfo) {
                this.bot.sendMessage(chatId,
                    `💰 BALANCE INFO\n\n` +
                    `🏷️ Wallet: \`${cryptoApp.wallet.address}\`\n` +
                    `💰 Balance: ${balanceInfo.balance} ETH\n` +
                    `📊 Total TX: ${balanceInfo.txCount}\n` +
                    `⛓️ Chain: ${cryptoApp.currentChainId}\n` +
                    `🌐 RPC: ${cryptoApp.currentRpcName}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.bot.sendMessage(chatId, `❌ Gagal mengambil balance.`);
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async sendBotStatus(chatId) {
        const cryptoApp = this.userSessions.get(chatId);
        if (!cryptoApp) {
            this.bot.sendMessage(chatId, '❌ Sesi Anda tidak ditemukan. /start ulang.');
            return;
        }

        const status = cryptoApp.isConnected ? '🟢 TERHUBUNG' : '🔴 TIDAK TERHUBUNG';
        const walletInfo = cryptoApp.wallet ?
            `\n💳 Wallet: \`${cryptoApp.wallet.address}\`` :
            '\n💳 Wallet: Belum setup';

        const wallets = await cryptoApp.loadWallets();
        const totalWallets = Object.keys(wallets).length;

        const walletsWithMnemonic = (await cryptoApp.listWalletsWithMnemonic()).length;

        const notifInfo = cryptoApp.sessionNotificationChatId ?
            `\n🔔 Notif ke: ${cryptoApp.sessionNotificationChatId}` :
            '\n🔔 Notif: (dinonaktifkan)';

        // Tambahkan info 2FA real-time ke status bot
        const tfa2fa = this._get2FA(chatId);
        const salt2fa = this._get2FAMasterSalt(chatId);
        const tfaAdminRender = tfa2fa.renderTelegram('admin', salt2fa);
        const tfaScriptRender = tfa2fa.renderTelegram('script', salt2fa);

        this.bot.sendMessage(chatId,
            `🤖 *BOT STATUS* (Session: ${chatId})\n\n` +
            `Status WC: ${status}` +
            `${walletInfo}\n` +
            `💼 Total Wallets: ${totalWallets} (${walletsWithMnemonic} dengan mnemonic)\n` +
            `${notifInfo}\n` +
            `⛓️ Chain ID: ${cryptoApp.currentChainId}\n` +
            `🌐 RPC: ${cryptoApp.currentRpcName}\n` +
            `⚙️ Auto-Save RPC: ${cryptoApp.autoSaveRpc ? 'ON' : 'OFF'}\n` +
            `⏱️ Smart Delay: ${cryptoApp.executionDelay}s\n` +
            `🕒 ${new Date().toLocaleString()}\n\n` +
            `🔐 *STATUS 2FA*\n` +
            tfaAdminRender + `\n` +
            tfaScriptRender,
            { parse_mode: 'Markdown' }
        );
    }

    // ===================================
    // [v19] RPC INJECT UI (TELEGRAM)
    // ===================================

    async showRpcInjectMenu(cryptoApp, chatId) {
        if (!cryptoApp) return;

        const allPorts = cryptoApp.getAllRpcPortsStatus();
        const runningPorts = allPorts.filter(p => p.isRunning);

        let statusText = runningPorts.length > 0
            ? `🟢 AKTIF — ${runningPorts.map(p => `port ${p.port} (${p.modeLabel})`).join(', ')}`
            : '🔴 Tidak ada server aktif';

        let portLines = allPorts.map(p =>
            `${p.statusIcon} Port ${p.port} | ${p.modeLabel} | ${p.isPermanent ? '🔒' : '🗑️'} ${p.label}`
        ).join('\n');

        // Build buttons: tiap port punya tombol start/stop + toggle mode
        const portButtons = allPorts.map(p => {
            const toggleMode = p.vpsMode ? '💻 → Localhost' : '🌐 → VPS';
            if (p.isRunning) {
                return [
                    { text: `🛑 Stop ${p.port}`, callback_data: `rpc_inject_stop_${p.port}` },
                    { text: `📋 Info ${p.port}`, callback_data: `rpc_inject_info_${p.port}` }
                ];
            } else {
                return [
                    { text: `▶️ Start ${p.port}`, callback_data: `rpc_inject_start_${p.port}` },
                    { text: `${toggleMode} (${p.port})`, callback_data: `rpc_inject_togglemode_${p.port}` }
                ];
            }
        });

        const extraButtons = [
            [{ text: '➕ Tambah Port Custom', callback_data: 'rpc_inject_addport' }],
            [{ text: '🗑️ Hapus Port Custom', callback_data: 'rpc_inject_deleteport' }],
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
        ];

        this.bot.sendMessage(chatId,
            `🦊 *METAMASK RPC INJECT — PORT MANAGER*\n\n` +
            `Status: ${statusText}\n\n` +
            `*Daftar Port:*\n${portLines}\n\n` +
            `💡 Tiap port bisa diset Localhost atau VPS mode secara independen.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [...portButtons, ...extraButtons] } }
        );
    }

    async startRpcInjectServer(cryptoApp, chatId, port, vpsMode = null) {
        if (!cryptoApp.wallet) {
            this.bot.sendMessage(chatId, '❌ Pilih wallet aktif dulu sebelum start RPC server.');
            return;
        }

        const cfg = cryptoApp.rpcPortsConfig[port] || {};
        const useVps = vpsMode !== null ? vpsMode : (cfg.vpsMode || false);

        await this.bot.sendMessage(chatId, `⏳ Memulai RPC server port ${port} (${useVps ? '🌐 VPS' : '💻 Localhost'})...`);
        const started = await cryptoApp.startRpcServer(port, useVps);

        if (started) {
            const info = cryptoApp.getRpcServerInfo(port);
            this.bot.sendMessage(chatId,
                `✅ *RPC SERVER PORT ${port} AKTIF!*\n\n` +
                `🔌 Mode  : ${info.modeLabel}\n` +
                `🔗 URL   : \`${info.rpcUrl}\`\n` +
                (info.vpsMode ? `⚠️ Ganti \`<IP_VPS>\` dengan IP publik VPS kamu!\n` : '') +
                `⛓️ Chain : \`${info.chainId}\` (${info.chainIdHex})\n\n` +
                `📋 *Cara connect di MetaMask:*\n` +
                `1. Settings → Networks → Add Network\n` +
                `2. Network Name: ${info.networkName} (Bot)\n` +
                `3. RPC URL: ${info.rpcUrl}\n` +
                `4. Chain ID: ${info.chainId}\n` +
                `5. Simpan & ganti ke network ini\n\n` +
                `Setiap transaksi dari DApp akan langsung di-approve! 🎯`,
                { parse_mode: 'Markdown' }
            );
        } else {
            this.bot.sendMessage(chatId, `❌ Gagal start port ${port}. Port mungkin sudah dipakai proses lain.`);
        }
        await this.showRpcInjectMenu(cryptoApp, chatId);
    }

    // ===================================
    // MESSAGE & CALLBACK HANDLERS
    // ===================================

    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;
        if (!text) return;

        const userState = this.userStates.get(chatId);

        if (!this.userSessions.has(chatId)) {
            if (userState && (userState.action === 'awaiting_admin_password' || userState.action === 'awaiting_script_password')) {
                await this.handlePasswordInput(chatId, text, userState, msg);
                return;
            }

            // ── Pilihan metode login (password vs OTP) saat 2FA aktif ──
            if (userState && userState.action === 'awaiting_login_method') {
                await this.handleLoginMethodChoice(chatId, text, userState, msg);
                return;
            }

            // ── State OTP login langsung ──
            if (userState && userState.action === 'awaiting_otp_login') {
                await this.handleOtpLoginInput(chatId, text, userState, msg);
                return;
            }

            // ── Routing 2FA setup states (sebelum sesi terbentuk) ──
            if (userState && (
                userState.action === 'awaiting_2fa_token' ||
                userState.action === 'awaiting_2fa_setup_choice' ||
                userState.action === 'awaiting_2fa_verify_setup'
            )) {
                await this.process2FAInput(chatId, text, userState);
                return;
            }

            // ── Routing 2FA manage states (bisa saat sesi sudah ada juga) ──
            if (userState && (
                userState.action === 'awaiting_2fa_delete_verify' ||
                userState.action === 'awaiting_2fa_delete_method' ||
                userState.action === 'awaiting_2fa_delete_pw_verify' ||
                userState.action === 'awaiting_2fa_reset_verify' ||
                userState.action === 'awaiting_2fa_new_password_verify' ||
                userState.action === 'awaiting_2fa_setup_new_verify'
            )) {
                await this.process2FAManageInput(chatId, text, userState);
                return;
            }

            // ── Notifikasi choice sebelum sesi terbentuk ──
            if (userState && userState.action === 'awaiting_notification_choice') {
                await this.processNotificationChatId(chatId, text);
                return;
            }

            if (text === '1. Administrator Access' || text === '2. Script Password Access') {
                await this.handleSecurityMessage(chatId, text, msg);
                return;
            }
        }

        if (!this.userSessions.has(chatId)) {
            this.bot.sendMessage(chatId, 'Sesi Anda tidak ditemukan. Silakan /start untuk login.');
            return;
        }

        const cryptoApp = this.userSessions.get(chatId);
        if (!cryptoApp) {
            this.bot.sendMessage(chatId, 'Sesi Anda error. Silakan /start ulang.');
            this.userSessions.delete(chatId);
            this.userLoginMeta.delete(chatId);
            return;
        }

        if (text === '💼 Wallet Management') {
            this.showWalletMenu(cryptoApp, chatId);
        } else if (text === '🌐 RPC Management') {
            this.showRpcMenu(cryptoApp, chatId);
        } else if (text === '🔗 WalletConnect') {
            this.showWalletConnectMenu(cryptoApp, chatId);
        } else if (text === '🦊 RPC Inject') {
            await this.showRpcInjectMenu(cryptoApp, chatId);
        } else if (text === '💸 Transfer Bot') {
            this.showTransferMenu(chatId);
        } else if (text === '⚙️ Pengaturan') {
            this.showPengaturanMenu(chatId);
        } else {
            const currentState = this.userStates.get(chatId);
            if (currentState) {
                await this.handleUserState(cryptoApp, chatId, text, currentState, msg);
            }
        }
    }

    /**
     * Handle pilihan 1/2 dari user: Password atau OTP.
     */
    async handleLoginMethodChoice(chatId, text, userState, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        const { level } = userState;
        const labelLevel = level === 'admin' ? 'ADMINISTRATOR' : 'SCRIPT';

        if (text.trim() === '2') {
            // Masuk dengan OTP
            const tfa = this._get2FA(chatId);
            const salt = this._get2FAMasterSalt(chatId);
            const secret = tfa.getSecret(level, salt);
            const status = tfa.getStatus(level, salt);
            const graceNote = status.inGrace ? `\n⚠️ Grace period aktif: *${status.graceDetail ? tfa._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}* tersisa` : '';

            this.userStates.set(chatId, {
                action: 'awaiting_otp_login',
                level,
                secret,
                attempts: 0
            });

            this.bot.sendMessage(chatId,
                `📱 *${labelLevel} — LOGIN OTP*${graceNote}\n\n` +
                `Masukkan kode 6-digit dari Google Authenticator:`,
                { parse_mode: 'Markdown' }
            );
        } else {
            // Masuk dengan Password (default untuk input 1 atau apapun)
            this.userStates.set(chatId, {
                action: level === 'admin' ? 'awaiting_admin_password' : 'awaiting_script_password',
                loginType: level,
                attempts: 0
            });
            this.bot.sendMessage(chatId,
                `🔑 *${labelLevel} — LOGIN PASSWORD*\n\n» Masukkan password:`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    /**
     * Handle input kode OTP saat login via OTP.
     */
    async handleOtpLoginInput(chatId, text, userState, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        const { level, secret } = userState;
        const labelLevel = level === 'admin' ? 'ADMINISTRATOR' : 'SCRIPT';
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);

        if (tfa.verifyTOTP(secret, text.trim())) {
            this.userStates.delete(chatId);
            // Cek apakah password berubah sejak 2FA dipasang (pakai password aktif saat ini)
            const pwOtp = level === 'admin'
                ? this.securitySystem?.adminPassword
                : this.securitySystem?.scriptPassword;
            if (pwOtp) tfa.checkAndUpdatePasswordHash(level, pwOtp, salt);
            this.bot.sendMessage(chatId, `✅ *OTP Verified! Selamat datang, ${labelLevel}!*`, { parse_mode: 'Markdown' });
            // Tandai masuk pakai OTP
            await this._finishLoginTelegram(chatId, level, 'otp');
        } else {
            userState.attempts = (userState.attempts || 0) + 1;
            const remaining = 3 - userState.attempts;
            if (remaining > 0) {
                this.bot.sendMessage(chatId,
                    `❌ Kode OTP salah. *${remaining} percobaan tersisa.*\nMasukkan ulang:`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, `🚫 *OTP GAGAL* — Terlalu banyak percobaan salah. Akses ditolak.`, { parse_mode: 'Markdown' });
            }
        }
    }

    async handleSecurityMessage(chatId, text, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        let level = null;
        if (text === '1. Administrator Access') level = 'admin';
        else if (text === '2. Script Password Access') level = 'script';
        if (!level) return;

        // Cek apakah 2FA aktif untuk level ini
        const tfa = this._get2FA(chatId);
        const salt = this._get2FAMasterSalt(chatId);
        const status = tfa.getStatus(level, salt);
        const labelLevel = level === 'admin' ? 'ADMINISTRATOR' : 'SCRIPT';

        if (status.expired) {
            const changedStr = status.passwordChangedAt ? tfa._fmtDateTime(status.passwordChangedAt) : '?';
            this.bot.sendMessage(chatId,
                `⏰ *2FA ${labelLevel} HANGUS*\n\n` +
                `Google Authenticator telah expired.\n` +
                `Password diubah sejak: *${changedStr}*\n` +
                `(Grace period >7 hari)\n\n` +
                `Login dilanjutkan dengan password biasa.`,
                { parse_mode: 'Markdown' }
            );
        }

        if (status.active) {
            // Ada 2FA aktif: tampilkan pilihan metode
            const graceNote = status.inGrace
                ? `\n⚠️ Grace period aktif: *${status.graceDetail ? tfa._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}* tersisa`
                : '';

            this.userStates.set(chatId, {
                action: 'awaiting_login_method',
                level,
                attempts: 0
            });

            this.bot.sendMessage(chatId,
                `🔐 *${labelLevel} — PILIH METODE LOGIN*${graceNote}\n\n` +
                `1️⃣  Masuk dengan *Password*\n` +
                `2️⃣  Masuk dengan *Google Authenticator (OTP)*\n\n` +
                `Balas dengan *1* atau *2*:`,
                { parse_mode: 'Markdown' }
            );
        } else {
            // Tidak ada 2FA: langsung ke input password
            this.userStates.set(chatId, {
                action: level === 'admin' ? 'awaiting_admin_password' : 'awaiting_script_password',
                loginType: level,
                attempts: 0
            });
            this.bot.sendMessage(chatId,
                `🔑 *${labelLevel} LOGIN*\n\n» Masukkan password:`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleUserState(cryptoApp, chatId, text, userState, msg) {
        if (userState.action === 'awaiting_gas_manual_input' || userState.action === 'awaiting_gas_aggressive_input') {
            await this.processGasInput(cryptoApp, chatId, text, userState, msg);
            return;
        }

        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        switch (userState.action) {
            case 'awaiting_notification_chat_id':
            case 'awaiting_notification_choice':
                await this.processNotificationChatId(chatId, text);
                break;
            case 'owner_awaiting_new_password':
                await this.processOwnerChangePassword(chatId, text, userState);
                break;
            case 'awaiting_2fa_delete_verify':
            case 'awaiting_2fa_delete_method':
            case 'awaiting_2fa_delete_pw_verify':
            case 'awaiting_2fa_reset_verify':
            case 'awaiting_2fa_new_password_verify':
            case 'awaiting_2fa_setup_new_verify':
                await this.process2FAManageInput(chatId, text, userState);
                break;
            case 'awaiting_wallet_import':
                await this.processWalletImport(cryptoApp, chatId, text, msg);
                break;
            case 'awaiting_mnemonic_input':
                await this.processMnemonicImport(cryptoApp, chatId, text, msg);
                break;
            case 'awaiting_mnemonic_path':
                await this.processMnemonicPath(cryptoApp, chatId, text);
                break;
            case 'awaiting_mnemonic_name':
                await this.finishMnemonicImport(cryptoApp, chatId, text);
                break;
            case 'awaiting_wallet_name':
                await this.processWalletName(cryptoApp, chatId, text);
                break;
            case 'awaiting_generate_wallet_name':
                await this.processGenerateWalletName(cryptoApp, chatId, text);
                break;
            case 'awaiting_wc_uri':
                await this.processWalletConnectURI(cryptoApp, chatId, text, msg);
                break;
            case 'awaiting_rpc_add':
                await this.processAddRpc(cryptoApp, chatId, text, userState);
                break;
            case 'awaiting_delay_input':
                await this.processDelayInput(cryptoApp, chatId, text, msg);
                break;
            case 'awaiting_rpc_inject_addport':
                await this.processRpcInjectAddPort(cryptoApp, chatId, text, userState);
                break;

            // ── Transfer Bot states ──
            case 'transfer_awaiting_token_address':
            case 'transfer_awaiting_destination':
                await this.processTransferSetup(chatId, text, userState);
                break;
        }
    }

    async handleCallback(query) {
        const chatId = query.message.chat.id;
        const data = query.data;

        if (!this.userSessions.has(chatId)) {
            this.bot.answerCallbackQuery(query.id, { text: '❌ Sesi berakhir. /start ulang.', show_alert: true });
            return;
        }

        const cryptoApp = this.userSessions.get(chatId);

        try {
            // Main Menu
            if (data === 'main_menu') {
                this.showMainMenu(chatId);
            }

            // Wallet Management
            else if (data === 'wallet_menu') {
                this.showWalletMenu(cryptoApp, chatId);
            }
            else if (data === 'wallet_import') {
                await this.importWalletFlow(cryptoApp, chatId);
            }
            else if (data === 'wallet_import_mnemonic') {
                await this.importMnemonicFlow(cryptoApp, chatId);
            }
            else if (data === 'mnemonic_path_skip') {
                await this.processMnemonicPath(cryptoApp, chatId, 'skip');
            }
            else if (data === 'mnemonic_name_skip') {
                await this.finishMnemonicImport(cryptoApp, chatId, '');
            }
            else if (data === 'wallet_generate') {
                await this.startGenerateWallet(cryptoApp, chatId);
            }
            else if (data.startsWith('wallet_save_generated_')) {
                const address = data.replace('wallet_save_generated_', '');
                await this.confirmSaveGeneratedWallet(cryptoApp, chatId, address);
            }
            else if (data === 'wallet_backup_list') {
                await this.showBackupList(cryptoApp, chatId);
            }
            else if (data.startsWith('wallet_show_backup_')) {
                const address = data.replace('wallet_show_backup_', '');
                await this.showBackupPhrase(cryptoApp, chatId, address);
            }
            else if (data.startsWith('wallet_backup_sent_')) {
                const address = data.replace('wallet_backup_sent_', '');
                this.bot.answerCallbackQuery(query.id, { text: '✅ Backup phrase sudah ditampilkan di atas' });
            }
            else if (data === 'wallet_list') {
                await this.listWallets(cryptoApp, chatId, 'wallet_select_');
            }
            else if (data === 'wallet_balance') {
                await this.checkBalance(cryptoApp, chatId);
            }
            else if (data === 'wallet_stats') {
                await this.getTransactionStats(cryptoApp, chatId);
            }
            else if (data.startsWith('wallet_select_')) {
                const address = data.replace('wallet_select_', '');
                await this.selectWallet(cryptoApp, chatId, address);
                this.showWalletMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('wallet_use_')) {
                const address = data.replace('wallet_use_', '');
                await this.selectWallet(cryptoApp, chatId, address);
                this.showWalletMenu(cryptoApp, chatId);
            }
            else if (data === 'wallet_delete_menu') {
                await this.showDeleteWalletMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('wallet_delete_confirm_')) {
                const address = data.replace('wallet_delete_confirm_', '');
                await this.confirmDeleteWallet(cryptoApp, chatId, address);
            }
            else if (data.startsWith('wallet_delete_exec_')) {
                const address = data.replace('wallet_delete_exec_', '');
                await this.executeDeleteWallet(cryptoApp, chatId, address);
            }

            // WalletConnect
            else if (data === 'wc_menu') {
                this.showWalletConnectMenu(cryptoApp, chatId);
            }
            else if (data === 'wc_select_wallet') {
                await this.listWallets(cryptoApp, chatId, 'wc_wallet_picked_');
            }
            else if (data.startsWith('wc_wallet_picked_')) {
                const address = data.replace('wc_wallet_picked_', '');
                await this.selectWallet(cryptoApp, chatId, address);
                this.showWalletConnectMenu(cryptoApp, chatId);
            }
            else if (data === 'wc_connect') {
                await this.startWalletConnect(cryptoApp, chatId);
            }
            else if (data === 'wc_status') {
                await this.sendBotStatus(chatId);
            }
            else if (data === 'wc_disconnect') {
                await cryptoApp.cleanup();
                this.bot.sendMessage(chatId, '✅ WalletConnect disconnected.');
                this.showWalletConnectMenu(cryptoApp, chatId);
            }
            else if (data === 'wc_set_delay') {
                await this.requestDelayInput(cryptoApp, chatId);
            }

            // RPC
            else if (data === 'rpc_menu') {
                this.showRpcMenu(cryptoApp, chatId);
            }
            else if (data === 'rpc_select') {
                await this.showRpcList(cryptoApp, chatId);
            }
            else if (data === 'rpc_add') {
                await this.startAddRpcFlow(cryptoApp, chatId, 1, {});
            }
            else if (data === 'rpc_info') {
                await this.showRpcInfo(cryptoApp, chatId);
            }
            else if (data === 'rpc_delete_menu') {
                await this.showDeleteRpcMenu(cryptoApp, chatId);
            }
            else if (data === 'rpc_delete_active') {
                this.bot.answerCallbackQuery(query.id, { text: '❌ Tidak bisa hapus RPC aktif', show_alert: true });
                return;
            }
            else if (data.startsWith('rpc_delete_exec_')) {
                const rpcKey = data.replace('rpc_delete_exec_', '');
                await this.executeDeleteRpc(cryptoApp, chatId, rpcKey);
            }
            else if (data.startsWith('rpc_use_')) {
                const rpcKey = data.replace('rpc_use_', '');
                await this.selectRpc(cryptoApp, chatId, rpcKey);
            }
            else if (data === 'rpc_toggle_autosave') {
                cryptoApp.autoSaveRpc = !cryptoApp.autoSaveRpc;
                cryptoApp.saveRpcConfig();
                const statusText = cryptoApp.autoSaveRpc ? 'AKTIF' : 'NON-AKTIF';
                this.bot.answerCallbackQuery(query.id, { text: `✅ Auto-Save RPC: ${statusText}`, show_alert: false });
                this.showRpcMenu(cryptoApp, chatId);
            }

            // Gas Management
            else if (data === 'rpc_gas_menu') {
                await this.showGasRpcSelection(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_gas_select_')) {
                const rpcKey = data.replace('rpc_gas_select_', '');
                await this.showGasModeSelection(cryptoApp, chatId, rpcKey);
            }
            else if (data.startsWith('rpc_gas_set_auto_')) {
                const rpcKey = data.replace('rpc_gas_set_auto_', '');
                if (cryptoApp.savedRpcs[rpcKey]) {
                    cryptoApp.savedRpcs[rpcKey].gasConfig = { mode: 'auto', value: 0 };
                    cryptoApp.saveRpcConfig();
                    this.bot.answerCallbackQuery(query.id, { text: '✅ Mode: AUTO', show_alert: true });
                    this.showRpcMenu(cryptoApp, chatId);
                }
            }
            else if (data.startsWith('rpc_gas_ask_manual_')) {
                const rpcKey = data.replace('rpc_gas_ask_manual_', '');
                this.userStates.set(chatId, {
                    action: 'awaiting_gas_manual_input',
                    tempData: { rpcKey: rpcKey, mode: 'manual' }
                });
                this.bot.sendMessage(chatId, '🛠 Masukkan nilai Gas (Gwei) yang ingin dipaksa (contoh: 50):',
                    { reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'rpc_gas_menu' }]] } }
                );
            }
            else if (data.startsWith('rpc_gas_ask_aggressive_')) {
                const rpcKey = data.replace('rpc_gas_ask_aggressive_', '');
                this.userStates.set(chatId, {
                    action: 'awaiting_gas_aggressive_input',
                    tempData: { rpcKey: rpcKey, mode: 'aggressive' }
                });
                this.bot.sendMessage(chatId, '🚀 Masukkan Persentase Boost (%) (contoh: 20 untuk +20%):',
                    { reply_markup: { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'rpc_gas_menu' }]] } }
                );
            }

            // Info Menu
            else if (data === 'info_menu') {
                this.showInfoMenu(cryptoApp, chatId);
            }
            else if (data === 'info_status') {
                await this.sendBotStatus(chatId);
            }

            // ── Pengaturan callbacks ──
            else if (data === 'pengaturan_menu') {
                this.showPengaturanMenu(chatId);
            }
            else if (data === 'owner_change_password_menu') {
                this.showUbahSandiMenu(chatId);
            }
            else if (data === 'owner_change_admin_pw') {
                this.startOwnerChangePassword(chatId, 'admin');
            }
            else if (data === 'owner_change_script_pw') {
                this.startOwnerChangePassword(chatId, 'script');
            }
            else if (data === 'logout_confirm') {
                await this.logout(chatId);
            }

            // ── Transfer Bot callbacks ──
            else if (data === 'transfer_menu') {
                this.showTransferMenu(chatId);
            }
            else if (data === 'transfer_eth_auto') {
                await this.startTransferSetup(chatId, 'eth_auto');
            }
            else if (data === 'transfer_token_auto') {
                await this.startTransferSetup(chatId, 'token_auto');
            }
            else if (data === 'transfer_token_once') {
                await this.startTransferSetup(chatId, 'token_once');
            }
            else if (data === 'transfer_auto_detect') {
                await this.startTransferSetup(chatId, 'auto_detect');
            }
            else if (data.startsWith('transfer_pick_wallet_')) {
                const idx = parseInt(data.replace('transfer_pick_wallet_', ''));
                const state = this.userStates.get(chatId);
                if (!state || state.action !== 'transfer_awaiting_wallet_pick') return;
                const walletInfo = state.walletEntries[idx];
                if (!walletInfo) return;
                // Simpan info wallet ke state, lanjut ke pilih network
                state.privateKey = walletInfo.privateKey;
                state.fromAddress = walletInfo.address;
                state.accountName = walletInfo.nickname || walletInfo.address.slice(0, 8);
                state.action = 'transfer_awaiting_network';
                this.userStates.set(chatId, state);

                const networkKeys = Object.keys(NETWORK_CONFIG);
                const rows = networkKeys.map((k, i) => [{ text: `${i + 1}. ${NETWORK_CONFIG[k].name}`, callback_data: `transfer_pick_network_${i}` }]);
                rows.push([{ text: '❌ Batal', callback_data: 'transfer_menu' }]);
                this.bot.sendMessage(chatId,
                    `✅ Wallet: *${state.accountName}*\n\`${state.fromAddress}\`\n\nPilih network:`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
                );
            }
            else if (data.startsWith('transfer_pick_network_')) {
                const idx = parseInt(data.replace('transfer_pick_network_', ''));
                const state = this.userStates.get(chatId);
                if (!state) return;
                const networkKeys = Object.keys(NETWORK_CONFIG);
                state.networkKey = networkKeys[idx];
                const needsToken = ['token_auto', 'token_once'].includes(state.mode);
                if (needsToken) {
                    state.action = 'transfer_awaiting_token_address';
                    this.userStates.set(chatId, state);
                    this.bot.sendMessage(chatId,
                        `✅ Network: *${NETWORK_CONFIG[state.networkKey].name}*\n\n` +
                        `Kirim alamat kontrak token (0x...):`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_menu' }]] }
                        }
                    );
                } else {
                    state.tokenAddress = null;
                    state.action = 'transfer_awaiting_destination';
                    this.userStates.set(chatId, state);
                    this.bot.sendMessage(chatId,
                        `✅ Network: *${NETWORK_CONFIG[state.networkKey].name}*\n\n` +
                        `Kirim alamat wallet tujuan (0x...):`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_menu' }]] }
                        }
                    );
                }
            }

            else if (data === 'transfer_stop') {
                this.stopTransfer(chatId);
            }
            else if (data === 'transfer_start_nosave') {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'transfer_awaiting_confirm') {
                    await this._startTransferInstance(chatId, state, false);
                }
            }
            else if (data === 'transfer_start_save') {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'transfer_awaiting_confirm') {
                    await this._startTransferInstance(chatId, state, true);
                }
            }


            // ── 2FA Management callbacks ──
            else if (data === '2fa_menu') {
                this.show2FAMenu(chatId);
            }
            else if (data === '2fa_reset_admin') {
                await this.handle2FAAction(chatId, 'reset_admin');
            }
            else if (data === '2fa_reset_script') {
                await this.handle2FAAction(chatId, 'reset_script');
            }
            else if (data === '2fa_delete_admin') {
                await this.handle2FAAction(chatId, 'delete_admin');
            }
            else if (data === '2fa_delete_script') {
                await this.handle2FAAction(chatId, 'delete_script');
            }
            // ── Pilihan metode hapus 2FA: OTP atau Password ──
            else if (data.startsWith('2fa_delete_method_otp_')) {
                const level = data.replace('2fa_delete_method_otp_', '');
                const tfa = this._get2FA(chatId);
                const salt = this._get2FAMasterSalt(chatId);
                const lbl = level.toUpperCase();
                const secret = tfa.getSecret(level, salt);
                this.userStates.set(chatId, { action: 'awaiting_2fa_delete_verify', level, secret, attempts: 0 });
                this.bot.sendMessage(chatId,
                    `🔐 *HAPUS 2FA ${lbl} — via OTP*\n\nMasukkan kode 6-digit dari Google Authenticator:`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data.startsWith('2fa_delete_method_pw_')) {
                const level = data.replace('2fa_delete_method_pw_', '');
                const lbl = level.toUpperCase();
                this.userStates.set(chatId, { action: 'awaiting_2fa_delete_pw_verify', level, attempts: 0 });
                this.bot.sendMessage(chatId,
                    `🔑 *HAPUS 2FA ${lbl} — via Password*\n\nMasukkan password *${lbl}* untuk konfirmasi:`,
                    { parse_mode: 'Markdown' }
                );
            }

            // ========================
            // [v20] RPC INJECT — MULTI-PORT
            // ========================
            else if (data === 'rpc_inject_menu') {
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_inject_info_')) {
                const port = parseInt(data.replace('rpc_inject_info_', ''));
                const info = cryptoApp.getRpcServerInfo(port);
                if (info) {
                    this.bot.sendMessage(chatId,
                        `🦊 *RPC INJECT INFO — PORT ${port}*\n\n` +
                        `🔌 Mode    : ${info.modeLabel}\n` +
                        `🔗 RPC URL : \`${info.rpcUrl}\`\n` +
                        (info.vpsMode ? `⚠️ Ganti \`<IP_VPS>\` dengan IP publik VPS kamu!\n` : '') +
                        `⛓️ Chain   : \`${info.chainId}\` (${info.chainIdHex})\n` +
                        `🌐 Network : ${info.networkName}\n\n` +
                        `MetaMask → Settings → Networks → Add Network`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    this.bot.sendMessage(chatId, `❌ Port ${port} tidak aktif.`);
                }
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_inject_stop_')) {
                const port = parseInt(data.replace('rpc_inject_stop_', ''));
                const ok = await cryptoApp.stopRpcServer(port);
                this.bot.sendMessage(chatId, ok ? `✅ Port ${port} dihentikan.` : `❌ Port ${port} tidak sedang berjalan.`);
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_inject_start_')) {
                const port = parseInt(data.replace('rpc_inject_start_', ''));
                await this.startRpcInjectServer(cryptoApp, chatId, port);
            }
            else if (data.startsWith('rpc_inject_togglemode_')) {
                const port = parseInt(data.replace('rpc_inject_togglemode_', ''));
                const cfg = cryptoApp.rpcPortsConfig[port];
                if (cfg) {
                    cfg.vpsMode = !cfg.vpsMode;
                    cryptoApp._saveRpcPortsConfig();
                    this.bot.sendMessage(chatId,
                        `🔄 Port ${port} mode diubah ke: ${cfg.vpsMode ? '🌐 VPS (0.0.0.0)' : '💻 Localhost (127.0.0.1)'}\n` +
                        `Mode tersimpan. Klik Start untuk menjalankan.`
                    );
                }
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }
            else if (data === 'rpc_inject_addport') {
                this.userStates.set(chatId, { action: 'awaiting_rpc_inject_addport', step: 'port' });
                this.bot.sendMessage(chatId,
                    `➕ *TAMBAH PORT CUSTOM*\n\nMasukkan nomor port (1024–65535):`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rpc_inject_menu' }]] } }
                );
            }
            else if (data === 'rpc_inject_deleteport') {
                const customPorts = Object.values(cryptoApp.rpcPortsConfig).filter(p => !p.isPermanent);
                if (customPorts.length === 0) {
                    this.bot.sendMessage(chatId, '❌ Tidak ada port custom untuk dihapus.');
                    await this.showRpcInjectMenu(cryptoApp, chatId);
                } else {
                    const buttons = customPorts.map(p => ([{
                        text: `🗑️ Hapus Port ${p.port} (${p.label})`,
                        callback_data: `rpc_inject_confirmdelete_${p.port}`
                    }]));
                    buttons.push([{ text: '🔙 Batal', callback_data: 'rpc_inject_menu' }]);
                    this.bot.sendMessage(chatId, `🗑️ *Pilih port custom yang ingin dihapus:*`,
                        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
                    );
                }
            }
            else if (data.startsWith('rpc_inject_confirmdelete_')) {
                const port = parseInt(data.replace('rpc_inject_confirmdelete_', ''));
                const result = cryptoApp.removeRpcPort(port);
                this.bot.sendMessage(chatId, result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`);
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_inject_addport_mode_')) {
                // Format: rpc_inject_addport_mode_localhost_8547 atau rpc_inject_addport_mode_vps_8547
                const parts = data.replace('rpc_inject_addport_mode_', '').split('_');
                const modeStr = parts[0]; // 'localhost' atau 'vps'
                const portNum = parseInt(parts[1]);
                const vpsMode = modeStr === 'vps';

                const added = cryptoApp.addRpcPort(portNum, vpsMode, `Port ${portNum} (Custom)`);
                if (added) {
                    this.bot.sendMessage(chatId,
                        `✅ Port *${portNum}* berhasil ditambahkan!\n` +
                        `Mode: ${vpsMode ? '🌐 VPS (0.0.0.0)' : '💻 Localhost (127.0.0.1)'}\n\n` +
                        `Port belum distart. Pilih port dari menu untuk menjalankan.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    this.bot.sendMessage(chatId, `❌ Gagal menambahkan port ${portNum}.`);
                }
                this.userStates.delete(chatId);
                await this.showRpcInjectMenu(cryptoApp, chatId);
            }

            this.bot.answerCallbackQuery(query.id);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
            this.bot.answerCallbackQuery(query.id);
        }
    }

    // ===================================
    // UTILITY METHODS
    // ===================================

    async logout(chatId) {
        const cryptoApp = this.userSessions.get(chatId);
        if (cryptoApp) {
            await cryptoApp.cleanup();
        }

        this.userSessions.delete(chatId);
        this.userStates.delete(chatId);

        const menu = { reply_markup: { remove_keyboard: true } };

        this.bot.sendMessage(chatId,
            `🔐 LOGGED OUT\n\n` +
            `Sesi Anda telah berakhir.\n\n` +
            `Kirim /start untuk login kembali.`,
            menu
        );
    }

    async cleanup() {
        if (this.bot) {
            this.bot.stopPolling();
            console.log('🤖 Main Bot stopped.');
        }

        console.log(`Cleaning up ${this.userSessions.size} active sessions...`);

        for (const [chatId, session] of this.userSessions.entries()) {
            console.log(`Cleaning up session for ${chatId}...`);
            await session.cleanup();
        }

        this.userSessions.clear();
        console.log('🤖 All Crypto App sessions cleaned up.');
    }
}

module.exports = TelegramFullController;
