'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const isPkg = typeof process.pkg !== 'undefined';
const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const crypto = require('crypto');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const GitHubPasswordSync = require('../auth/GitHubPasswordSync');
const CryptoAutoTx = require('./CryptoAutoTx');
const TwoFactorAuth = require('../auth/TwoFactorAuth');
const BackupPasswordGuard = require('../auth/BackupPasswordGuard');
const { NETWORK_CONFIG, MANUAL_NETWORKS, ERC20_ABI, TRACKER_NETWORKS } = require('../utils/constants');
const { enhancedConfigManager } = require('../utils/secureConfig');
const EthTransfer = require('../transfer/EthTransfer');
const TokenTransfer = require('../transfer/TokenTransfer');
const AutoTokenDetectionManager = require('../transfer/AutoTokenDetectionManager');
const ModernUI = require('../core/ModernUI');
const morse = require('../utils/morse');
const morseMap = morse.parseMorseFile();         // legacy: untuk dekripsi pesan lama
const allMorseCiphers = morse.getAllCiphers();    // baru: 273 versi cipher per-char random
const morseStorage = require('../utils/morseStorage');
const backupHelper = require('../utils/backupHelper');
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
        this.trackerIntervals = new Map();
        // Delay a bit to let bot initialization complete
        setTimeout(() => this.resumeTrackerPollings(), 3000);
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
        const isTgOwner = String(chatId) === String(this.config.OWNER_TELEGRAM_ID);
        if (!isTgOwner) return false;

        // Jika user ini adalah owner Telegram ID-nya tapi login aktif menggunakan sandi/level script,
        // perlakukan dia sebagai NON-owner (script mode).
        const loginMeta = this.userLoginMeta.get(chatId);
        if (loginMeta && loginMeta.level === 'script') {
            return false;
        }
        return true;
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
            const envPath = path.join(projectRoot, 'security', '.env');
            if (!fs.existsSync(envPath)) {
                return { ok: false, msg: 'File .env tidak ditemukan di folder security/.' };
            }
            
            // Menggunakan hash live aktif proyek agar enkripsi sinkron dengan loadConfiguration
            const integrityGuard = require('../core/integrityGuard');
            const liveHash = integrityGuard.calculateProjectHash();
            
            const configKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024' + liveHash,
                'CONFIG_SALT_2024',
                50000,
                32,
                'sha256'
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
                console.log('🤖 Telegram Bot (v20.0.0 - Generate Wallet & Backup Phrase) initialized');
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
        this.bot.on('document', (msg) => this.handleDocument(msg));
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
            const dataDir = path.join(projectRoot, 'data', `user_${chatId}`);
            this._twoFAMap.set(chatId, new TwoFactorAuth(dataDir));
        }
        return this._twoFAMap.get(chatId);
    }

    _get2FAMasterSalt(chatId) {
        const base = process.env.SYSTEM_ID || 'FASTARX_2FA_DEFAULT_SALT';
        return `${base}_${chatId}`;
    }

    // ── Helper Sandi Backup Wallet (per chatId) ──
    _getBackupGuard(chatId) {
        if (!this._backupGuardMap) this._backupGuardMap = new Map();
        if (!this._backupGuardMap.has(chatId)) {
            const dataDir = path.join(projectRoot, 'data', `user_${chatId}`);
            this._backupGuardMap.set(chatId, new BackupPasswordGuard(dataDir));
        }
        return this._backupGuardMap.get(chatId);
    }

    _getBackupGuardSalt(chatId) {
        const base = process.env.SYSTEM_ID || 'FASTARX_BACKUP_DEFAULT_SALT';
        return `${base}_backup_${chatId}`;
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
            [{ text: '🔙 Kembali', callback_data: 'menu_lainnya' }],
        ];

        this.bot.sendMessage(chatId,
            `💸 *TRANSFER BOT*\n\n` +
            `${active ? '🟢 Ada transfer yang sedang berjalan.\n\n' : ''}` +
            `Wallet diambil dari *Wallet Management*.\n` +
            `Pilih mode transfer:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    showMenuLainnya(chatId) {
        const keyboard = [
            [{ text: '💸 Transfer Bot', callback_data: 'transfer_menu' }],
            [{ text: '💸 Transfer Manual', callback_data: 'transfer_manual_menu' }],
            [{ text: '🔐 Morse Cipher Tool', callback_data: 'morse_menu' }],
            [{ text: '📊 Tracking Bot', callback_data: 'tracker_menu' }],
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
        ];

        this.bot.sendMessage(chatId,
            `📂 *MENU LAINNYA*\n\n` +
            `Pilih fitur yang ingin digunakan:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async showDappsMenu(chatId) {
        const cryptoApp = this.userSessions.get(chatId);
        if (!cryptoApp) {
            this.bot.sendMessage(chatId, '❌ Sesi tidak ditemukan. Silakan /start ulang.');
            return;
        }

        const dappApprovalOn = cryptoApp.dappApprovalRequired || false;
        const dappApprovalLabel = dappApprovalOn
            ? '🔐 DApp Approval: 🟢 ON (klik untuk OFF)'
            : '🔐 DApp Approval: 🔴 OFF (klik untuk ON)';

        const timeout = cryptoApp.dappInactivityTimeout !== undefined ? cryptoApp.dappInactivityTimeout : 30;
        const timerLabel = timeout === 0
            ? '⏱️ Auto-Disconnect: 🔴 OFF (klik untuk ON)'
            : `⏱️ Auto-Disconnect: 🟢 ${timeout} Menit (klik untuk ubah)`;

        const keyboard = [
            [{ text: dappApprovalLabel, callback_data: 'dapp_approval_toggle_new' }],
            [{ text: timerLabel, callback_data: 'dapp_timer_settings' }]
        ];

        const escapeMarkdown = (text) => {
            if (!text) return '';
            return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
        };

        // Ambil daftar DApp terhubung
        const connected = cryptoApp.connectedDapps || [];

        let dappsListText = '';
        if (connected.length === 0) {
            dappsListText = 'ℹ️ *Belum ada DApp yang terhubung.*\n\n';
        } else {
            dappsListText = '🌐 *Daftar DApp Terhubung:*\n\n';
            connected.forEach((dapp, idx) => {
                const connectedTime = dapp.connectedAt ? new Date(dapp.connectedAt).toLocaleString() : 'N/A';
                dappsListText += `${idx + 1}. *${escapeMarkdown(dapp.name)}*\n` +
                                 `🔗 URL: \`${escapeMarkdown(dapp.url)}\`\n` +
                                 `📡 Via: ${escapeMarkdown(dapp.via)}\n` +
                                 `🕒 Waktu: ${escapeMarkdown(connectedTime)}\n\n`;
                
                // Tambahkan tombol disconnect untuk masing-masing DApp
                keyboard.push([{ text: `❌ Disconnect: ${dapp.name}`, callback_data: `dapp_disconnect_${dapp.id}` }]);
            });
        }

        keyboard.push([{ text: '🔙 Kembali', callback_data: 'menu_lainnya' }]);

        const dappStatusInfo = dappApprovalOn
            ? '🟢 *DApp Approval:* ON — Setiap koneksi DApp baru memerlukan persetujuan manual via Telegram.'
            : '🔴 *DApp Approval:* OFF — DApp baru otomatis terhubung (auto-connect).';

        this.bot.sendMessage(chatId,
            `🌐 *KELOLA DAPPS*\n\n` +
            `${dappStatusInfo}\n\n` +
            `${dappsListText}` +
            `Pilih aksi di bawah:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async processDappTimerInput(cryptoApp, chatId, text, msg) {
        try {
            await this.bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {}

        const minutes = parseInt(text.trim());
        if (isNaN(minutes) || minutes < 0 || minutes > 1440) {
            await this.bot.sendMessage(chatId,
                `❌ *Input tidak valid!*\n\n` +
                `Silakan masukkan angka menit antara \`0\` sampai \`1440\`.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        cryptoApp.dappInactivityTimeout = minutes;
        cryptoApp.saveRpcConfig();
        this.userStates.delete(chatId);

        const statusText = minutes === 0
            ? '❌ *Auto-Disconnect dinonaktifkan.*'
            : `✅ *Auto-Disconnect diset ke ${minutes} menit.*`;

        await this.bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
        this.showDappsMenu(chatId);
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

    // ===================================
    // 💸 MANUAL TRANSFER FLOW (INDEPENDENT)
    // ===================================

    getExplorerApiKeys(chatId) {
        const filePath = path.join(projectRoot, `data/${chatId}_explorer_keys.enc`);
        if (!fs.existsSync(filePath)) {
            return {};
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const decrypted = this._decryptData(raw, this.config.SCRIPT_PASSWORD + chatId);
            return JSON.parse(decrypted);
        } catch (e) {
            console.error('Failed to decrypt explorer API keys:', e);
            return {};
        }
    }

    saveExplorerApiKeys(chatId, keys) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${chatId}_explorer_keys.enc`);
        try {
            const encrypted = this._encryptData(JSON.stringify(keys), this.config.SCRIPT_PASSWORD + chatId);
            fs.writeFileSync(filePath, encrypted, 'utf8');
            try { fs.chmodSync(filePath, 0o600); } catch (_) {}
            return true;
        } catch (e) {
            console.error('Failed to encrypt explorer API keys:', e);
            return false;
        }
    }

    getTrackedWallets(chatId) {
        const filePath = path.join(projectRoot, `data/${chatId}_tracked_wallets.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error('Failed to read tracked wallets:', e);
            return [];
        }
    }

    saveTrackedWallets(chatId, wallets) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${chatId}_tracked_wallets.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(wallets, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('Failed to save tracked wallets:', e);
            return false;
        }
    }

    getTrackerHistory(chatId) {
        const filePath = path.join(projectRoot, `data/${chatId}_tracker_history.json`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error('Failed to read tracker history:', e);
            return [];
        }
    }

    saveTrackerHistory(chatId, history) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${chatId}_tracker_history.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('Failed to save tracker history:', e);
            return false;
        }
    }

    getTrackerState(chatId) {
        const filePath = path.join(projectRoot, `data/${chatId}_tracker_state.json`);
        if (!fs.existsSync(filePath)) return { active: false, lastScannedBlocks: {}, scannedTxHashes: [] };
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error('Failed to read tracker state:', e);
            return { active: false, lastScannedBlocks: {}, scannedTxHashes: [] };
        }
    }

    saveTrackerState(chatId, state) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${chatId}_tracker_state.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('Failed to save tracker state:', e);
            return false;
        }
    }


    _encryptData(text, password) {
        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        const result = { encrypted, iv: iv.toString('hex'), salt: salt.toString('hex'), authTag: authTag.toString('hex') };
        return Buffer.from(JSON.stringify(result)).toString('base64');
    }

    _decryptData(encryptedData, password) {
        const data = JSON.parse(Buffer.from(encryptedData, 'base64').toString());
        const salt = Buffer.from(data.salt, 'hex');
        const iv = Buffer.from(data.iv, 'hex');
        const authTag = Buffer.from(data.authTag, 'hex');
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    _httpGet(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    getManualRpcs(chatId) {
        const filePath = path.join(projectRoot, `data/${chatId}_manual_rpcs.json`);
        if (fs.existsSync(filePath)) {
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                return {};
            }
        }
        return {};
    }

    saveManualRpcs(chatId, rpcs) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${chatId}_manual_rpcs.json`);
        fs.writeFileSync(filePath, JSON.stringify(rpcs, null, 2), 'utf8');
    }

    getManualTokens(chatId, chainId) {
        const filePath = path.join(projectRoot, `data/${chatId}_manual_tokens.json`);
        if (fs.existsSync(filePath)) {
            try {
                const allTokens = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return allTokens[chainId] || [];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    saveManualToken(chatId, chainId, tokenInfo) {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${chatId}_manual_tokens.json`);
        let allTokens = {};
        if (fs.existsSync(filePath)) {
            try {
                allTokens = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {}
        }
        if (!allTokens[chainId]) {
            allTokens[chainId] = [];
        }
        if (!allTokens[chainId].some(t => t.address.toLowerCase() === tokenInfo.address.toLowerCase())) {
            allTokens[chainId].push(tokenInfo);
        }
        fs.writeFileSync(filePath, JSON.stringify(allTokens, null, 2), 'utf8');
    }

    async showManualTransferMenu(chatId) {
        const keyboard = [];
        // Default networks
        Object.entries(MANUAL_NETWORKS).forEach(([key, net]) => {
            keyboard.push([{ text: `🌐 ${net.name}`, callback_data: `tm_pick_net_default_${key}` }]);
        });
        
        keyboard.push([{ text: '🌐 Jaringan Lain nya', callback_data: 'tm_menu_other_networks' }]);
        keyboard.push([{ text: '🔑 Setup Explorer API Keys', callback_data: 'tm_setup_api_keys' }]);
        keyboard.push([{ text: '🔙 Kembali', callback_data: 'menu_lainnya' }]);

        this.bot.sendMessage(chatId,
            `💸 *TRANSFER MANUAL — PILIH JARINGAN*\n\n` +
            `Silakan pilih jaringan untuk transfer manual Anda:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async showExplorerApiKeysMenu(chatId) {
        const keys = this.getExplorerApiKeys(chatId);
        
        const mask = (val) => val ? `${val.slice(0, 6)}...${val.slice(-4)}` : '🔴 Belum diset';

        const keyboard = [
            [{ text: `Etherscan API Key: ${mask(keys.etherscan)}`, callback_data: 'tm_edit_api_etherscan' }],
            [{ text: `Basescan API Key: ${mask(keys.basescan)}`, callback_data: 'tm_edit_api_basescan' }],
            [{ text: `BscScan API Key: ${mask(keys.bscscan)}`, callback_data: 'tm_edit_api_bscscan' }],
            [{ text: '🔙 Kembali', callback_data: 'transfer_manual_menu' }]
        ];

        this.bot.sendMessage(chatId,
            `🔑 *EXPLORER API KEYS (MANUAL TRANSFER)*\n\n` +
            `API Key ini disimpan secara terenkripsi di folder \`data/\` untuk mengambil riwayat transaksi Anda secara aman.\n\n` +
            `Pilih salah satu tombol di bawah untuk mengatur/mengubah kunci:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async showAssetDashboard(chatId, state) {
        try {
            await this.bot.sendMessage(chatId, '🔄 Menghubungkan provider & memuat riwayat transaksi...');
            
            const provider = new ethers.JsonRpcProvider(state.network.rpc);
            const balance = await provider.getBalance(state.wallet.address);
            const balanceFormatted = ethers.formatEther(balance);
            state.balanceFormatted = balanceFormatted;

            // Ambil API keys
            const apiKeys = this.getExplorerApiKeys(chatId);
            
            const chainId = state.network.chainId;
            let url = '';

            if (chainId === 11155111) {
                const key = apiKeys.etherscan;
                if (key) {
                    url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${state.asset.type === 'native' ? 'txlist' : 'tokentx'}&address=${state.wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=${key}`;
                    if (state.asset.type !== 'native') {
                        url += `&contractaddress=${state.asset.address}`;
                    }
                } else {
                    // Blockscout (Free, No Key)
                    url = `https://eth-sepolia.blockscout.com/api?module=account&action=${state.asset.type === 'native' ? 'txlist' : 'tokentx'}&address=${state.wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`;
                    if (state.asset.type !== 'native') {
                        url += `&contractaddress=${state.asset.address}`;
                    }
                }
            } else if (chainId === 84532) {
                const key = apiKeys.basescan;
                if (key) {
                    url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${state.asset.type === 'native' ? 'txlist' : 'tokentx'}&address=${state.wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=${key}`;
                    if (state.asset.type !== 'native') {
                        url += `&contractaddress=${state.asset.address}`;
                    }
                } else {
                    // Blockscout (Free, No Key)
                    url = `https://base-sepolia.blockscout.com/api?module=account&action=${state.asset.type === 'native' ? 'txlist' : 'tokentx'}&address=${state.wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`;
                    if (state.asset.type !== 'native') {
                        url += `&contractaddress=${state.asset.address}`;
                    }
                }
            } else if (chainId === 97) {
                const key = apiKeys.bscscan || '';
                url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${state.asset.type === 'native' ? 'txlist' : 'tokentx'}&address=${state.wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`;
                if (state.asset.type !== 'native') {
                    url += `&contractaddress=${state.asset.address}`;
                }
                if (key) {
                    url += `&apikey=${key}`;
                }
            }

            let txs = [];
            let errorMsg = null;

            if (url) {
                try {
                    const res = await this._httpGet(url);
                    if (res && res.status === '1' && Array.isArray(res.result)) {
                        txs = res.result.slice(0, 4);
                    } else if (res && (res.message === 'No transactions found' || res.message === 'No transfers found' || res.message === 'No token transfers found' || (Array.isArray(res.result) && res.result.length === 0))) {
                        txs = [];
                    } else if (res) {
                        const errMsg = typeof res.result === 'string' ? res.result : (res.message || 'Error tidak diketahui');
                        errorMsg = `Gagal memuat riwayat: ${errMsg}`;
                    }
                } catch (e) {
                    errorMsg = `Gagal memuat riwayat: rate limit atau network error.`;
                }
            } else {
                errorMsg = 'Jaringan ini tidak mendukung API Explorer bawaan.';
            }

            // Simpan transaksi di state
            state.latestTxs = txs;
            this.userStates.set(chatId, state);

            const keyboard = [
                [{ text: '📤 Kirim / Send', callback_data: 'tm_start_send_flow' }]
            ];

            // Render tombol riwayat
            if (txs.length > 0) {
                txs.forEach((tx, idx) => {
                    const isOutgoing = tx.from.toLowerCase() === state.wallet.address.toLowerCase();
                    const dirSymbol = isOutgoing ? '⬆️ Kirim' : '⬇️ Terima';
                    const targetAddr = isOutgoing ? tx.to : tx.from;
                    const amountRaw = tx.value;
                    const decimals = tx.tokenDecimal ? parseInt(tx.tokenDecimal) : (state.asset.decimals || 18);
                    const amountFormatted = ethers.formatUnits(amountRaw, decimals);
                    const symbol = tx.tokenSymbol || state.asset.symbol || 'Native';
                    const displayAmt = parseFloat(amountFormatted).toFixed(4);

                    const label = `${dirSymbol} ${displayAmt} ${symbol} ${isOutgoing ? '→' : '←'} ${targetAddr.slice(0, 6)}...${targetAddr.slice(-4)}`;
                    keyboard.push([{ text: label, callback_data: `tm_tx_detail_${idx}` }]);
                });
            } else {
                keyboard.push([{ text: errorMsg || 'ℹ️ Belum ada riwayat transaksi.', callback_data: 'tm_dummy_tx' }]);
            }

            // Lihat transaksi lainnya
            const explorerUrl = state.network.explorer 
                ? `${state.network.explorer}/address/${state.wallet.address}`
                : null;
            
            const bottomRow = [];
            if (explorerUrl) {
                bottomRow.push({ text: '🔍 Lihat Transaksi Lainnya', url: explorerUrl });
            }
            bottomRow.push({ text: '🔙 Kembali', callback_data: 'transfer_manual_menu' });
            keyboard.push(bottomRow);

            const assetLabel = state.asset.type === 'native' ? 'Native Coin' : `${state.asset.name} (${state.asset.symbol})`;
            let dashboardText = 
                `📊 *DASHBOARD ASET — TRANSFER MANUAL*\n\n` +
                `🌐 Jaringan: *${state.network.name}*\n` +
                `🪙 Aset: *${assetLabel}*\n` +
                `💼 Wallet: *${state.wallet.nickname || state.wallet.address}*\n` +
                `\`${state.wallet.address}\`\n\n` +
                `💰 Saldo: *${parseFloat(balanceFormatted).toFixed(6)} ETH/Native*\n`;

            if (state.asset.type === 'token') {
                try {
                    const tokenContract = new ethers.Contract(state.asset.address, ERC20_ABI, provider);
                    const tokBal = await tokenContract.balanceOf(state.wallet.address);
                    const tokBalFormatted = ethers.formatUnits(tokBal, state.asset.decimals);
                    dashboardText += `🪙 Saldo Token: *${parseFloat(tokBalFormatted).toFixed(6)} ${state.asset.symbol}*\n`;
                } catch (_) {
                    dashboardText += `🪙 Saldo Token: *Gagal memuat*\n`;
                }
            }

            dashboardText += `\n*4 Transaksi Terakhir:*`;

            this.bot.sendMessage(chatId, dashboardText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal memuat dashboard aset: ${error.message}`);
            await this.showManualTransferMenu(chatId);
        }
    }

    async showTransactionDetail(chatId, state, txIndex) {
        const tx = state.latestTxs && state.latestTxs[txIndex];
        if (!tx) {
            this.bot.sendMessage(chatId, '❌ Detail transaksi tidak ditemukan.');
            await this.showAssetDashboard(chatId, state);
            return;
        }

        const isOutgoing = tx.from.toLowerCase() === state.wallet.address.toLowerCase();
        const typeLabel = isOutgoing ? '⬆️ KIRIM (Outgoing)' : '⬇️ TERIMA (Incoming)';
        const amountRaw = tx.value;
        const decimals = tx.tokenDecimal ? parseInt(tx.tokenDecimal) : (state.asset.decimals || 18);
        const amountFormatted = ethers.formatUnits(amountRaw, decimals);
        const symbol = tx.tokenSymbol || state.asset.symbol || 'Native';
        
        let gasCostFormatted = 'N/A';
        if (tx.gasUsed && tx.gasPrice) {
            const gasCostRaw = BigInt(tx.gasUsed) * BigInt(tx.gasPrice);
            gasCostFormatted = ethers.formatEther(gasCostRaw);
        }

        const date = tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toLocaleString('id-ID') : 'N/A';
        const isErr = tx.isError === '1';

        let detailText = 
            `📋 *DETAIL TRANSAKSI*\n\n` +
            `🏷️ Tipe: *${typeLabel}*\n` +
            `✅ Status: *${isErr ? '🔴 Gagal' : '🟢 Sukses'}*\n\n` +
            `📄 *TX Hash:* \`${tx.hash}\`\n\n` +
            `👤 *Dari (Pengirim):*\n\`${tx.from}\`\n\n` +
            `📥 *Ke (Penerima):*\n\`${tx.to}\`\n\n` +
            `🪙 *Aset:* *${symbol}*\n` +
            `🔢 *Jumlah:* *${amountFormatted} ${symbol}*\n` +
            `⛽ *Gas Used:* \`${tx.gasUsed || 'N/A'}\`\n` +
            `💰 *Biaya Gas:* *${gasCostFormatted} ETH/Native*\n` +
            `📦 *Block:* \`#${tx.blockNumber || 'N/A'}\`\n` +
            `📅 *Waktu:* \`${date}\`\n`;

        const keyboard = [];
        
        if (state.network.explorer && tx.hash) {
            keyboard.push([{ text: '🔍 Lihat di Explorer', url: `${state.network.explorer}/tx/${tx.hash}` }]);
        }

        keyboard.push([{ text: '🔙 Kembali ke Dashboard', callback_data: 'tm_back_to_dashboard' }]);

        this.bot.sendMessage(chatId, detailText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    async showManualTransferOtherNetworks(chatId) {
        const keyboard = [];
        const customRpcs = this.getManualRpcs(chatId);
        
        Object.entries(customRpcs).forEach(([key, rpc]) => {
            keyboard.push([{ text: `🌐 ${rpc.name} (${rpc.chainId})`, callback_data: `tm_pick_net_custom_${key}` }]);
        });

        keyboard.push([{ text: '➕ Tambah Jaringan / RPC', callback_data: 'tm_add_rpc' }]);
        keyboard.push([{ text: '🔙 Kembali', callback_data: 'transfer_manual_menu' }]);

        this.bot.sendMessage(chatId,
            `🌐 *Jaringan Kustom (Manual Transfer)*\n\n` +
            `Berikut adalah daftar jaringan kustom Anda untuk transfer manual:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async startAddManualRpcFlow(chatId, step = 1, data = {}) {
        this.userStates.set(chatId, { action: 'manual_transfer_awaiting_rpc_add', step, data });

        if (step === 1) {
            this.bot.sendMessage(chatId, '➕ *TAMBAH RPC TRANSFER MANUAL (1/4)*\n\nKirim Nama Jaringan (contoh: RPC Sepolia):', { parse_mode: 'Markdown' });
        } else if (step === 2) {
            this.bot.sendMessage(chatId, '➕ *TAMBAH RPC TRANSFER MANUAL (2/4)*\n\nKirim URL RPC (contoh: https://...):', { parse_mode: 'Markdown' });
        } else if (step === 3) {
            this.bot.sendMessage(chatId, '➕ *TAMBAH RPC TRANSFER MANUAL (3/4)*\n\nKirim Chain ID (contoh: 11155111):', { parse_mode: 'Markdown' });
        } else if (step === 4) {
            this.bot.sendMessage(chatId, '➕ *TAMBAH RPC TRANSFER MANUAL (4/4)*\n\nKirim Link Block Explorer atau /skip jika tidak ada:', { parse_mode: 'Markdown' });
        }
    }

    async processAddManualRpc(chatId, input, userState) {
        const { step, data } = userState;
        try {
            if (step === 1) {
                data.name = input;
                await this.startAddManualRpcFlow(chatId, 2, data);
            } else if (step === 2) {
                if (!input.startsWith('http')) {
                    this.bot.sendMessage(chatId, '❌ URL tidak valid. Harus dimulai http/https. Coba lagi:');
                    return;
                }
                data.rpc = input;
                await this.startAddManualRpcFlow(chatId, 3, data);
            } else if (step === 3) {
                const chainId = parseInt(input);
                if (isNaN(chainId)) {
                    this.bot.sendMessage(chatId, '❌ Chain ID harus berupa angka. Coba lagi:');
                    return;
                }
                data.chainId = chainId;
                await this.startAddManualRpcFlow(chatId, 4, data);
            } else if (step === 4) {
                data.explorer = input === '/skip' ? '' : input;
                
                // Save custom rpc
                const customRpcs = this.getManualRpcs(chatId);
                const key = `custom_${Date.now()}`;
                customRpcs[key] = data;
                this.saveManualRpcs(chatId, customRpcs);

                this.bot.sendMessage(chatId, `✅ Jaringan *${data.name}* berhasil disimpan!`, { parse_mode: 'Markdown' });
                this.userStates.delete(chatId);
                await this.showManualTransferOtherNetworks(chatId);
            }
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal menambahkan jaringan: ${error.message}`);
            this.userStates.delete(chatId);
        }
    }

    async askManualTransferWallet(chatId, network) {
        const cryptoApp = this.userSessions.get(chatId);
        if (!cryptoApp) {
            this.bot.sendMessage(chatId, '❌ Sesi tidak ditemukan. Silakan /start ulang.');
            return;
        }

        const wallets = await cryptoApp.loadWallets();
        const walletEntries = Object.entries(wallets);

        if (walletEntries.length === 0) {
            this.bot.sendMessage(chatId,
                `❌ *Belum ada wallet tersimpan.*\n\n` +
                `Tambahkan wallet dulu melalui *💼 Wallet Management*.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'transfer_manual_menu' }]] }
                }
            );
            return;
        }

        const walletRows = walletEntries.map(([address, data], i) => [{
            text: `${i + 1}. ${data.nickname || address.slice(0, 8) + '...'} — ${address.slice(0, 6)}...${address.slice(-4)}`,
            callback_data: `tm_pick_wallet_${i}`
        }]);
        walletRows.push([{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]);

        this.userStates.set(chatId, {
            action: 'tm_awaiting_wallet_pick',
            network,
            walletEntries: walletEntries.map(([address, data]) => ({ address, privateKey: data.privateKey, nickname: data.nickname || '' }))
        });

        this.bot.sendMessage(chatId,
            `💸 *TRANSFER MANUAL — PILIH WALLET SUMBER*\n\n` +
            `Jaringan: *${network.name}*\n` +
            `Pilih wallet asal pengiriman:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: walletRows } }
        );
    }

    async showManualTransferAssets(chatId, state) {
        try {
            await this.bot.sendMessage(chatId, '🔄 Menghubungkan provider & mengambil saldo...');
            const provider = new ethers.JsonRpcProvider(state.network.rpc);
            const balance = await provider.getBalance(state.wallet.address);
            const balanceFormatted = ethers.formatEther(balance);
            state.balanceFormatted = balanceFormatted;

            const keyboard = [];
            keyboard.push([{
                text: `Native Coin (${parseFloat(balanceFormatted).toFixed(4)} ETH/Native)`,
                callback_data: 'tm_pick_asset_native'
            }]);

            // Load custom tokens
            const tokens = this.getManualTokens(chatId, state.network.chainId);
            for (const tok of tokens) {
                try {
                    const tokContract = new ethers.Contract(tok.address, ERC20_ABI, provider);
                    const tokBalance = await tokContract.balanceOf(state.wallet.address);
                    const tokBalFormatted = ethers.formatUnits(tokBalance, tok.decimals);
                    keyboard.push([{
                        text: `🪙 ${tok.symbol} (${parseFloat(tokBalFormatted).toFixed(4)})`,
                        callback_data: `tm_pick_asset_token_${tok.address}`
                    }]);
                } catch (e) {
                    keyboard.push([{
                        text: `🪙 ${tok.symbol} (Error Saldo)`,
                        callback_data: `tm_pick_asset_token_${tok.address}`
                    }]);
                }
            }

            keyboard.push([{ text: '➕ Tambahkan Token', callback_data: 'tm_add_token' }]);
            keyboard.push([{ text: '🔙 Kembali ke Jaringan', callback_data: 'transfer_manual_menu' }]);

            this.userStates.set(chatId, state);

            this.bot.sendMessage(chatId,
                `📊 *INFORMASI SALDO & ASET*\n\n` +
                `🌐 Jaringan: *${state.network.name}*\n` +
                `💼 Wallet: *${state.wallet.nickname || state.wallet.address}*\n` +
                `\`${state.wallet.address}\`\n\n` +
                `Silakan pilih aset untuk dikirim atau tambahkan token baru:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
            );

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal mengambil saldo: ${error.message}\nPastikan RPC URL aktif.`);
            await this.showManualTransferMenu(chatId);
        }
    }

    async processManualTransferAddToken(chatId, address, userState) {
        if (!ethers.isAddress(address)) {
            this.bot.sendMessage(chatId, '❌ Alamat token tidak valid. Coba lagi:');
            return;
        }

        try {
            this.bot.sendMessage(chatId, '🔍 Mendeteksi detail token...');
            const provider = new ethers.JsonRpcProvider(userState.network.rpc);
            const tokenContract = new ethers.Contract(address, ERC20_ABI, provider);
            
            const [name, symbol, decimals] = await Promise.all([
                tokenContract.name(),
                tokenContract.symbol(),
                tokenContract.decimals()
            ]);

            const tokenInfo = {
                name,
                symbol,
                decimals: parseInt(decimals),
                address
            };

            this.saveManualToken(chatId, userState.network.chainId, tokenInfo);
            this.bot.sendMessage(chatId, `✅ Token *${symbol}* (${name}) berhasil ditambahkan!`, { parse_mode: 'Markdown' });

            userState.action = 'tm_assets_screen';
            await this.showManualTransferAssets(chatId, userState);

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal memuat token: ${error.message}`);
            userState.action = 'tm_assets_screen';
            await this.showManualTransferAssets(chatId, userState);
        }
    }

    async askManualTransferRecipient(chatId, state) {
        state.action = 'manual_transfer_awaiting_recipient';
        this.userStates.set(chatId, state);

        const assetLabel = state.asset.type === 'native' ? 'Native Coin' : state.asset.symbol;
        this.bot.sendMessage(chatId,
            `📥 *TRANSFER MANUAL — PENERIMA TOKEN*\n\n` +
            `Jaringan: *${state.network.name}*\n` +
            `Aset: *${assetLabel}*\n\n` +
            `Kirim alamat wallet penerima (0x...):`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]] } }
        );
    }

    async askManualTransferAmount(chatId, state) {
        state.action = 'manual_transfer_awaiting_amount';
        this.userStates.set(chatId, state);

        const assetLabel = state.asset.type === 'native' ? 'Native Coin' : state.asset.symbol;
        this.bot.sendMessage(chatId,
            `🔢 *TRANSFER MANUAL — JUMLAH KIRIM*\n\n` +
            `Jaringan: *${state.network.name}*\n` +
            `Aset: *${assetLabel}*\n` +
            `Penerima: \`${state.recipient}\`\n\n` +
            `Kirim jumlah koin/token yang akan dikirim (contoh: 0.05):`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]] } }
        );
    }

    async showManualTransferGasOptions(chatId, state) {
        try {
            await this.bot.sendMessage(chatId, '⛽ Menghitung estimasi gas fee...');
            const provider = new ethers.JsonRpcProvider(state.network.rpc);
            const feeData = await provider.getFeeData();
            
            const gasLimit = state.asset.type === 'native' ? 21000n : 100000n;
            const baseGasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('10', 'gwei');

            const regulerGasPrice = baseGasPrice;
            const fastGasPrice = baseGasPrice * 13n / 10n;
            const instanGasPrice = baseGasPrice * 16n / 10n;

            const regulerCost = ethers.formatEther(regulerGasPrice * gasLimit);
            const fastCost = ethers.formatEther(fastGasPrice * gasLimit);
            const instanCost = ethers.formatEther(instanGasPrice * gasLimit);

            state.gasPrices = {
                reguler: regulerGasPrice.toString(),
                fast: fastGasPrice.toString(),
                instan: instanGasPrice.toString(),
                gasLimit: gasLimit.toString()
            };

            const keyboard = [
                [{ text: `⚡ Instan (~${parseFloat(instanCost).toFixed(6)} ETH/Native)`, callback_data: 'tm_gas_instan' }],
                [{ text: `🚀 Fast (~${parseFloat(fastCost).toFixed(6)} ETH/Native)`, callback_data: 'tm_gas_fast' }],
                [{ text: `🐌 Reguler (~${parseFloat(regulerCost).toFixed(6)} ETH/Native)`, callback_data: 'tm_gas_reguler' }],
                [{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]
            ];

            this.userStates.set(chatId, state);

            this.bot.sendMessage(chatId,
                `⛽ *ESTIMASI GAS FEE*\n\n` +
                `Pilih opsi kecepatan transaksi Anda:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
            );

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal memperkirakan gas: ${error.message}\nFallback ke gas standar.`);
            state.selectedGas = {
                mode: 'reguler',
                gasPrice: ethers.parseUnits('20', 'gwei').toString(),
                gasLimit: (state.asset.type === 'native' ? 21000n : 100000n).toString()
            };
            await this.showManualTransferConfirmation(chatId, state);
        }
    }

    async showManualTransferConfirmation(chatId, state) {
        const assetLabel = state.asset.type === 'native' ? 'Native Coin' : state.asset.symbol;
        const speedLabel = state.selectedGas.mode.toUpperCase();
        const gasCost = ethers.formatEther(BigInt(state.selectedGas.gasPrice) * BigInt(state.selectedGas.gasLimit));

        const summary =
            `📋 *RINGKASAN KONFIGURASI TRANSFER*\n\n` +
            `🌐 Jaringan: *${state.network.name}*\n` +
            `💼 Wallet: *${state.wallet.nickname}* (\`${state.wallet.address}\`)\n` +
            `📥 Penerima: \`${state.recipient}\`\n` +
            `🪙 Aset: *${assetLabel}*\n` +
            `🔢 Jumlah: *${state.amount} ${state.asset.symbol || 'Native'}*\n` +
            `⛽ Kecepatan Gas: *${speedLabel}*\n` +
            `💰 Est. Biaya Gas: *${parseFloat(gasCost).toFixed(6)} ETH/Native*\n\n` +
            `Apakah Anda ingin memulai transfer?`;

        const keyboard = [
            [{ text: '▶️ Mulai Kirim', callback_data: 'tm_send_confirm' }],
            [{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]
        ];

        this.userStates.set(chatId, state);

        this.bot.sendMessage(chatId, summary, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    async executeManualTransfer(chatId, state) {
        this.userStates.delete(chatId);
        try {
            await this.bot.sendMessage(chatId, '⏳ *Sedang memproses transaksi...*', { parse_mode: 'Markdown' });
            
            const provider = new ethers.JsonRpcProvider(state.network.rpc);
            const wallet = new ethers.Wallet(state.wallet.privateKey, provider);

            let tx;
            if (state.asset.type === 'native') {
                tx = await wallet.sendTransaction({
                    to: state.recipient,
                    value: ethers.parseEther(state.amount.toString()),
                    gasPrice: BigInt(state.selectedGas.gasPrice),
                    gasLimit: BigInt(state.selectedGas.gasLimit)
                });
            } else {
                const tokenContract = new ethers.Contract(state.asset.address, ERC20_ABI, wallet);
                tx = await tokenContract.transfer(
                    state.recipient,
                    ethers.parseUnits(state.amount.toString(), state.asset.decimals),
                    {
                        gasPrice: BigInt(state.selectedGas.gasPrice),
                        gasLimit: BigInt(state.selectedGas.gasLimit)
                    }
                );
            }

            await this.bot.sendMessage(chatId,
                `✅ *Transaksi Berhasil Dikirim!*\n\n` +
                `📄 TX Hash: \`${tx.hash}\`\n` +
                `⏳ Menunggu konfirmasi dari blockchain...`,
                { parse_mode: 'Markdown' }
            );

            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                await this.bot.sendMessage(chatId,
                    `🎉 *TRANSAKSI SELESAI & SUKSES CONFRIMED!*\n\n` +
                    `🌐 Jaringan: ${state.network.name}\n` +
                    `📄 Block: ${receipt.blockNumber}\n` +
                    `📄 TX Hash: \`${receipt.hash}\``,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await this.bot.sendMessage(chatId, `❌ *Transaksi Gagal di Blockchain.*`, { parse_mode: 'Markdown' });
            }

        } catch (error) {
            await this.bot.sendMessage(chatId, `❌ *Transaksi Gagal:* ${error.message}`, { parse_mode: 'Markdown' });
        }
        this.showMenuLainnya(chatId);
    }




    showMainMenu(chatId) {
        if (!this.userSessions.has(chatId)) {
            this.bot.sendMessage(chatId, 'Anda harus login. Kirim /start');
            return;
        }

        const keyboardRows = [
            ['💼 Wallet Management'],
            ['🦊 RPC Inject', '🔗 WalletConnect'],
            ['🌐 RPC Management', '📂 Menu Lainnya'],
            ['⚙️ Pengaturan'],
        ];

        const menu = {
            reply_markup: {
                keyboard: keyboardRows,
                resize_keyboard: true,
                one_time_keyboard: false
            }
        };

        const ownerTag = this.isOwner(chatId) ? '\n👑 Anda login sebagai Owner.' : '\n📜 Anda login sebagai Script.';
        this.bot.sendMessage(chatId,
            `🤖 FA STARX BOT v20.0 - MAIN MENU\n(Session: ${chatId})${ownerTag}\n\nPilih menu di bawah:`,
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
            [{ text: '📦 Migrasi/Backup Data', callback_data: 'migration_menu' }],
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

    showMigrationMenu(chatId) {
        const keyboard = [
            [
                { text: '📤 Backup Data', callback_data: 'migration_backup' },
                { text: '📥 Impor Data', callback_data: 'migration_import' }
            ],
            [{ text: '🔙 Kembali', callback_data: 'pengaturan_menu' }]
        ];

        this.bot.sendMessage(chatId,
            `📦 *MIGRASI / BACKUP DATA*\n\n` +
            `Fitur ini memungkinkan Anda mencadangkan seluruh data (Wallet, RPC, Port, dan Morse) ke dalam satu file terenkripsi yang dikirim langsung ke Telegram Anda.\n\n` +
            `• *Backup*: Membuat file cadangan terenkripsi password.\n` +
            `• *Impor*: Memulihkan data dari file cadangan yang diunggah.\n\n` +
            `Pilih aksi di bawah:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    showMorseMenu(chatId) {
        const keyboard = [
            [
                { text: '🔑 Enkripsi Teks', callback_data: 'morse_encrypt' },
                { text: '🔓 Dekripsi Kode', callback_data: 'morse_decrypt' }
            ],
            [{ text: '📋 Lihat Pesan Tersimpan', callback_data: 'morse_list_saved' }],
            [{ text: '🔙 Kembali', callback_data: 'menu_lainnya' }]
        ];
        this.bot.sendMessage(chatId,
            `🔐 *MORSE CIPHER TOOL*\n\n` +
            `Fitur ini memungkinkan Anda melakukan enkripsi dan dekripsi menggunakan sandi Morse Kustom secara aman.\n\n` +
            `📁 *Dukungan File .txt:*\n` +
            `Anda bisa mengunggah file \`.txt\` secara langsung untuk diproses otomatis! Bot akan memproses isinya secara aman tanpa menyimpan file di server, lalu mengirimkan hasilnya kembali berupa file \`.txt\` baru.\n\n` +
            `Pilih aksi di bawah:`,
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
                    [{ text: '🔐 Ganti Sandi Backup Wallet', callback_data: 'owner_change_backup_pw' }],
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
                        { text: '🌐 Kelola DApps', callback_data: 'dapps_menu' },
                        { text: '💰 Cek Balance', callback_data: 'wallet_stats' }
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
    // [FITUR BARU] Sandi Backup Wallet — Gerbang & Alur
    // ==============================================

    /**
     * Gerbang utama — dipanggil saat user memilih wallet untuk lihat backup.
     * Cek apakah sandi backup sudah di-set:
     *   - Belum → tawarkan buat sandi
     *   - Sudah → minta input sandi (max 3x percobaan)
     */
    async requestBackupUnlock(cryptoApp, chatId, address) {
        const guard = this._getBackupGuard(chatId);
        const salt = this._getBackupGuardSalt(chatId);

        if (!guard.isSet(salt)) {
            // Belum ada sandi backup → tawarkan buat
            this.bot.sendMessage(chatId,
                `🔐 *SANDI BACKUP DIPERLUKAN*\n\n` +
                `Anda belum memiliki Kata Sandi Backup.\n` +
                `Untuk melindungi data sensitif (Private Key & Mnemonic), ` +
                `Anda wajib membuat sandi terlebih dahulu.\n\n` +
                `Buat sekarang?`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔐 Buat Sandi Backup', callback_data: `backup_create_pw_${address}` }],
                            [{ text: '🔙 Batal', callback_data: 'wallet_backup_list' }]
                        ]
                    }
                }
            );
            return;
        }

        // Sudah ada sandi → minta input
        this.userStates.set(chatId, {
            action: 'awaiting_backup_unlock',
            address,
            attempts: 0
        });

        this.bot.sendMessage(chatId,
            `🔑 *VERIFIKASI SANDI BACKUP*\n\n` +
            `Masukkan Kata Sandi Backup untuk melihat data wallet ini:\n` +
            `_(pesan sandi akan otomatis dihapus)_\n\n` +
            `Kirim /cancel untuk membatalkan.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wallet_backup_list' }]]
                }
            }
        );
    }

    /**
     * Mulai alur pembuatan sandi backup baru (pertama kali).
     */
    startCreateBackupPassword(chatId, address) {
        this.userStates.set(chatId, {
            action: 'backup_pw_set',
            step: 'new',
            address: address || null
        });

        this.bot.sendMessage(chatId,
            `🔐 *BUAT SANDI BACKUP WALLET*\n\n` +
            `Sandi ini akan diminta setiap kali Anda ingin melihat data backup (Private Key / Mnemonic).\n\n` +
            `📝 Masukkan sandi baru (minimal 6 karakter):\n` +
            `_(pesan sandi akan otomatis dihapus)_\n\n` +
            `Kirim /cancel untuk membatalkan.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wallet_backup_list' }]]
                }
            }
        );
    }

    /**
     * Mulai alur ganti sandi backup dari menu Pengaturan.
     */
    startChangeBackupPassword(chatId) {
        if (!this.isOwner(chatId)) {
            this.bot.sendMessage(chatId, '🚫 Akses ditolak.');
            return;
        }

        const guard = this._getBackupGuard(chatId);
        const salt = this._getBackupGuardSalt(chatId);

        if (!guard.isSet(salt)) {
            // Belum pernah set — langsung alur buat baru (tanpa address target)
            this.userStates.set(chatId, {
                action: 'backup_pw_set',
                step: 'new',
                address: null,
                fromSettings: true
            });

            this.bot.sendMessage(chatId,
                `🔐 *BUAT SANDI BACKUP WALLET*\n\n` +
                `Anda belum memiliki Sandi Backup. Mari buat sekarang.\n\n` +
                `📝 Masukkan sandi baru (minimal 6 karakter):\n` +
                `_(pesan sandi akan otomatis dihapus)_\n\n` +
                `Kirim /cancel untuk membatalkan.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '❌ Batal', callback_data: 'owner_change_password_menu' }]]
                    }
                }
            );
            return;
        }

        // Sudah ada sandi → minta verifikasi sandi lama dulu
        this.userStates.set(chatId, {
            action: 'backup_pw_change',
            step: 'verify_old',
            attempts: 0,
            fromSettings: true
        });

        this.bot.sendMessage(chatId,
            `🔐 *GANTI SANDI BACKUP WALLET*\n\n` +
            `Masukkan sandi backup Anda saat ini untuk verifikasi:\n` +
            `_(pesan sandi akan otomatis dihapus)_\n\n` +
            `Kirim /cancel untuk membatalkan.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Batal', callback_data: 'owner_change_password_menu' }]]
                }
            }
        );
    }

    /**
     * Handler teks utama untuk semua state backup password:
     *   - awaiting_backup_unlock (verifikasi sebelum lihat backup)
     *   - backup_pw_set (buat sandi baru, step: new → confirm)
     *   - backup_pw_change (ganti sandi, step: verify_old → new → confirm)
     */
    async processBackupPasswordInput(cryptoApp, chatId, text, userState, msg) {
        // Hapus pesan berisi sandi dari chat
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

        const input = text.trim();

        // Cancel
        if (input === '/cancel') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '⏹️ Dibatalkan.');
            if (userState.fromSettings) {
                this.showUbahSandiMenu(chatId);
            } else {
                this.bot.sendMessage(chatId, 'Kembali ke daftar backup:', {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'wallet_backup_list' }]]
                    }
                });
            }
            return;
        }

        const guard = this._getBackupGuard(chatId);
        const salt = this._getBackupGuardSalt(chatId);

        // ── STATE: Verifikasi sandi sebelum lihat backup ──
        if (userState.action === 'awaiting_backup_unlock') {
            const ok = guard.verify(input, salt);
            if (ok) {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId, '✅ Sandi benar! Menampilkan data backup...');
                await this.showBackupPhrase(cryptoApp, chatId, userState.address);
            } else {
                userState.attempts = (userState.attempts || 0) + 1;
                if (userState.attempts >= 3) {
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId,
                        `🚫 *Sandi salah 3x berturut-turut!*\n\nAkses backup dikunci. Silakan coba lagi nanti.`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'wallet_backup_list' }]]
                            }
                        }
                    );
                } else {
                    this.userStates.set(chatId, userState);
                    this.bot.sendMessage(chatId,
                        `❌ Sandi salah! Percobaan ${userState.attempts}/3.\n\nMasukkan sandi yang benar atau kirim /cancel:`
                    );
                }
            }
            return;
        }

        // ── STATE: Buat sandi baru (backup_pw_set) ──
        if (userState.action === 'backup_pw_set') {
            if (userState.step === 'new') {
                if (input.length < 6) {
                    this.bot.sendMessage(chatId, '❌ Sandi minimal 6 karakter. Coba lagi:');
                    return;
                }
                userState.newPassword = input;
                userState.step = 'confirm';
                this.userStates.set(chatId, userState);
                this.bot.sendMessage(chatId,
                    `✅ Sandi diterima.\n\n🔁 Konfirmasi: kirim ulang sandi yang sama:`
                );
            } else if (userState.step === 'confirm') {
                if (input !== userState.newPassword) {
                    this.bot.sendMessage(chatId,
                        `❌ Sandi tidak cocok!\n\nMulai ulang — masukkan sandi baru lagi:`
                    );
                    userState.step = 'new';
                    delete userState.newPassword;
                    this.userStates.set(chatId, userState);
                    return;
                }

                // Simpan sandi
                const saved = guard.setPassword(input, salt);
                this.userStates.delete(chatId);

                if (saved) {
                    this.bot.sendMessage(chatId,
                        `✅ *Sandi Backup Wallet berhasil dibuat!*\n\n` +
                        `Sandi ini akan diminta setiap kali Anda melihat data backup wallet.\n` +
                        `Anda bisa mengubahnya nanti di ⚙️ Pengaturan → 🔑 Ubah Sandi.`,
                        { parse_mode: 'Markdown' }
                    );

                    // Kalau ada address target, langsung minta unlock
                    if (userState.address && cryptoApp) {
                        await this.requestBackupUnlock(cryptoApp, chatId, userState.address);
                    } else if (userState.fromSettings) {
                        this.showUbahSandiMenu(chatId);
                    } else {
                        this.bot.sendMessage(chatId, 'Kembali ke daftar backup:', {
                            reply_markup: {
                                inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'wallet_backup_list' }]]
                            }
                        });
                    }
                } else {
                    this.bot.sendMessage(chatId, '❌ Gagal menyimpan sandi. Coba lagi nanti.');
                }
            }
            return;
        }

        // ── STATE: Ganti sandi (backup_pw_change) ──
        if (userState.action === 'backup_pw_change') {
            if (userState.step === 'verify_old') {
                const ok = guard.verify(input, salt);
                if (ok) {
                    userState.step = 'new';
                    userState.attempts = 0;
                    this.userStates.set(chatId, userState);
                    this.bot.sendMessage(chatId,
                        `✅ Sandi lama benar!\n\n📝 Masukkan sandi backup *baru* (minimal 6 karakter):`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    userState.attempts = (userState.attempts || 0) + 1;
                    if (userState.attempts >= 3) {
                        this.userStates.delete(chatId);
                        this.bot.sendMessage(chatId,
                            `🚫 *Sandi salah 3x!* Proses ganti sandi dibatalkan.`,
                            { parse_mode: 'Markdown' }
                        );
                        this.showUbahSandiMenu(chatId);
                    } else {
                        this.userStates.set(chatId, userState);
                        this.bot.sendMessage(chatId,
                            `❌ Sandi salah! Percobaan ${userState.attempts}/3.\n\nMasukkan sandi lama yang benar:`
                        );
                    }
                }
            } else if (userState.step === 'new') {
                if (input.length < 6) {
                    this.bot.sendMessage(chatId, '❌ Sandi minimal 6 karakter. Coba lagi:');
                    return;
                }
                userState.newPassword = input;
                userState.step = 'confirm';
                this.userStates.set(chatId, userState);
                this.bot.sendMessage(chatId,
                    `✅ Sandi baru diterima.\n\n🔁 Konfirmasi: kirim ulang sandi baru yang sama:`
                );
            } else if (userState.step === 'confirm') {
                if (input !== userState.newPassword) {
                    this.bot.sendMessage(chatId,
                        `❌ Sandi tidak cocok!\n\nMulai ulang — masukkan sandi baru lagi:`
                    );
                    userState.step = 'new';
                    delete userState.newPassword;
                    this.userStates.set(chatId, userState);
                    return;
                }

                const saved = guard.setPassword(input, salt);
                this.userStates.delete(chatId);

                if (saved) {
                    this.bot.sendMessage(chatId,
                        `✅ *Sandi Backup Wallet berhasil diubah!*\n\n` +
                        `Sandi baru sudah aktif dan berlaku langsung.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    this.bot.sendMessage(chatId, '❌ Gagal menyimpan sandi baru. Coba lagi nanti.');
                }
                this.showUbahSandiMenu(chatId);
            }
            return;
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

    async processRpcInjectPassword(cryptoApp, chatId, text, userState) {
        const input = text.trim();
        if (input.toLowerCase() === '/cancel' || input.toLowerCase() === 'batal') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '❌ Mulai RPC server dibatalkan.');
            await this.showRpcInjectMenu(cryptoApp, chatId);
            return;
        }

        let password = input;
        if (input.toLowerCase() === 'skip') {
            password = '';
        } else if (!input) {
            this.bot.sendMessage(chatId, '❌ Password tidak boleh kosong. Silakan masukkan password keamanan atau ketik *skip*:');
            return;
        }

        const port = userState.port;
        this.userStates.delete(chatId);
        await this.startRpcInjectServer(cryptoApp, chatId, port, null, password);
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
                        { text: '✏️ Edit RPC', callback_data: 'rpc_edit_menu' },
                        { text: '🗑️ Hapus RPC', callback_data: 'rpc_delete_menu' }
                    ],
                    [
                        { text: '⛽ Atur Gas', callback_data: 'rpc_gas_menu' },
                        { text: 'ℹ️ Info RPC', callback_data: 'rpc_info' }
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
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (1/4)\n\nKirim Nama RPC (contoh: RPC Sepolia):');
        } else if (step === 2) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (2/4)\n\nKirim URL RPC (contoh: https://...):');
        } else if (step === 3) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (3/4)\n\nKirim Chain ID (contoh: 11155111):');
        } else if (step === 4) {
            this.bot.sendMessage(chatId, '➕ TAMBAH RPC (4/4)\n\nKirim Link Block Explorer (contoh: `https://sepolia.etherscan.io`) atau kirim /skip jika tidak ingin diisi:');
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
                await this.startAddRpcFlow(cryptoApp, chatId, 4, data);

            } else if (step === 4) {
                let explorerUrl = null;
                if (input && input.trim().toLowerCase() !== '/skip') {
                    let rawUrl = input.trim();
                    if (!rawUrl.startsWith('http')) {
                        this.bot.sendMessage(chatId, '❌ URL Block Explorer tidak valid. Harus dimulai http/https atau kirim /skip. Coba lagi:');
                        return;
                    }
                    if (rawUrl.endsWith('/')) {
                        rawUrl = rawUrl.slice(0, -1);
                    }
                    explorerUrl = rawUrl;
                }

                data.explorer = explorerUrl;
                const key = `custom_${Date.now()}`;

                cryptoApp.savedRpcs[key] = {
                    name: data.name,
                    rpc: data.url,
                    chainId: data.chainId,
                    explorer: data.explorer,
                    gasConfig: { mode: 'auto', value: 0 }
                };

                if (cryptoApp.saveRpcConfig()) {
                    const explorerStatus = data.explorer ? `\n🔍 Explorer: ${data.explorer}` : '\n🔍 Explorer: (Tidak diisi)';
                    this.bot.sendMessage(chatId, `✅ RPC "${data.name}" berhasil disimpan!${explorerStatus}`);
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

    async showEditRpcMenu(cryptoApp, chatId) {
        try {
            const rpcList = Object.entries(cryptoApp.savedRpcs);
            if (rpcList.length === 0) {
                this.bot.sendMessage(chatId, '📭 Tidak ada RPC untuk diedit.');
                return;
            }

            const buttons = [];

            rpcList.forEach(([key, rpc]) => {
                buttons.push([
                    {
                        text: `✏️ ${rpc.name}`,
                        callback_data: `rpc_edit_select_${key}`
                    }
                ]);
            });

            buttons.push([{ text: '🔙 Batal', callback_data: 'rpc_menu' }]);

            this.bot.sendMessage(chatId, 'Pilih RPC yang ingin Anda edit:', {
                reply_markup: { inline_keyboard: buttons }
            });

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }

    async showEditRpcPropMenu(cryptoApp, chatId, rpcKey) {
        const rpc = cryptoApp.savedRpcs[rpcKey];
        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
            return;
        }

        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🏷️ Edit Nama', callback_data: `rpc_edit_prop_name_${rpcKey}` },
                        { text: '🔗 Kelola URL RPC', callback_data: `rpc_urlsub_menu_${rpcKey}` }
                    ],
                    [
                        { text: '⛓️ Edit Chain ID', callback_data: `rpc_edit_prop_chain_${rpcKey}` },
                        { text: '🔍 Edit Explorer URL', callback_data: `rpc_edit_prop_explorer_${rpcKey}` }
                    ],
                    [
                        { text: '🔙 Kembali', callback_data: 'rpc_edit_menu' }
                    ]
                ]
            }
        };

        const explorerInfo = rpc.explorer ? `\n🔍 Explorer: ${rpc.explorer}` : '\n🔍 Explorer: (Tidak diisi)';
        this.bot.sendMessage(chatId,
            `✏️ EDIT RPC: *${rpc.name}*\n\n` +
            `🔗 URL RPC: \`${rpc.rpc}\`\n` +
            `⛓️ Chain ID: \`${rpc.chainId}\`` +
            explorerInfo + `\n\n` +
            `Pilih bagian yang ingin diubah:`,
            { reply_markup: menu.reply_markup, parse_mode: 'Markdown' }
        );
    }

    async startEditRpcInput(cryptoApp, chatId, rpcKey, property) {
        const rpc = cryptoApp.savedRpcs[rpcKey];
        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
            return;
        }

        this.userStates.set(chatId, { action: 'awaiting_rpc_edit', rpcKey, property });

        let promptMsg = '';
        if (property === 'name') {
            promptMsg = `✏️ Kirim Nama baru untuk RPC *${rpc.name}*:`;
        } else if (property === 'url') {
            promptMsg = `✏️ Kirim URL RPC baru untuk *${rpc.name}*\n(Contoh: https://...):`;
        } else if (property === 'backup_add') {
            promptMsg = `➕ Kirim URL RPC cadangan baru untuk *${rpc.name}*\n(Contoh: https://...):`;
        } else if (property === 'chain') {
            promptMsg = `✏️ Kirim Chain ID baru untuk *${rpc.name}*\n(Contoh: 11155111):`;
        } else if (property === 'explorer') {
            promptMsg = `✏️ Kirim Link Block Explorer baru untuk *${rpc.name}*\n(Contoh: https://etherscan.io)\natau kirim /skip untuk menghapus explorer:`;
        }

        this.bot.sendMessage(chatId, promptMsg, { parse_mode: 'Markdown' });
    }

    async processEditRpc(cryptoApp, chatId, input, userState) {
        const { rpcKey, property } = userState;
        const rpc = cryptoApp.savedRpcs[rpcKey];

        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC yang sedang diedit tidak ditemukan.');
            this.userStates.delete(chatId);
            return;
        }

        try {
            if (property === 'name') {
                const oldName = rpc.name;
                rpc.name = input.trim();
                cryptoApp.saveRpcConfig();
                this.bot.sendMessage(chatId, `✅ Nama RPC berhasil diubah dari *${oldName}* menjadi *${rpc.name}*!`, { parse_mode: 'Markdown' });
                this.userStates.delete(chatId);
                await this.showEditRpcPropMenu(cryptoApp, chatId, rpcKey);

            } else if (property === 'url') {
                if (!input.startsWith('http')) {
                    this.bot.sendMessage(chatId, '❌ URL tidak valid. Harus dimulai http/https. Coba lagi:');
                    return;
                }
                const oldUrl = rpc.rpc;
                rpc.rpc = input.trim();
                
                if (cryptoApp.currentRpc === oldUrl) {
                    cryptoApp.currentRpc = rpc.rpc;
                    cryptoApp.setupProvider();
                }

                cryptoApp.saveRpcConfig();
                this.bot.sendMessage(chatId, `✅ URL RPC berhasil diperbarui!`);
                this.userStates.delete(chatId);
                await this.showEditRpcUrlSubMenu(cryptoApp, chatId, rpcKey);

            } else if (property === 'backup_add') {
                if (!input.startsWith('http')) {
                    this.bot.sendMessage(chatId, '❌ URL tidak valid. Harus dimulai http/https. Coba lagi:');
                    return;
                }
                if (!rpc.backupRpcs) {
                    rpc.backupRpcs = [];
                }
                const newBackupUrl = input.trim();
                if (rpc.rpc === newBackupUrl || rpc.backupRpcs.includes(newBackupUrl)) {
                    this.bot.sendMessage(chatId, '❌ URL tersebut sudah terdaftar di RPC ini.');
                    return;
                }
                rpc.backupRpcs.push(newBackupUrl);
                cryptoApp.saveRpcConfig();
                this.bot.sendMessage(chatId, `✅ URL cadangan berhasil ditambahkan!`);
                this.userStates.delete(chatId);
                await this.showEditRpcUrlSubMenu(cryptoApp, chatId, rpcKey);

            } else if (property === 'chain') {
                const chainIdNum = parseInt(input);
                if (isNaN(chainIdNum) || chainIdNum <= 0) {
                    this.bot.sendMessage(chatId, '❌ Chain ID tidak valid. Harus angka positif. Coba lagi:');
                    return;
                }
                const oldChainId = rpc.chainId;
                rpc.chainId = chainIdNum;

                if (rpc.rpc === cryptoApp.currentRpc) {
                    cryptoApp.currentChainId = chainIdNum;
                }

                cryptoApp.saveRpcConfig();
                this.bot.sendMessage(chatId, `✅ Chain ID berhasil diubah dari *${oldChainId}* menjadi *${rpc.chainId}*!`);
                this.userStates.delete(chatId);
                await this.showEditRpcPropMenu(cryptoApp, chatId, rpcKey);

            } else if (property === 'explorer') {
                let explorerUrl = null;
                if (input && input.trim().toLowerCase() !== '/skip') {
                    let rawUrl = input.trim();
                    if (!rawUrl.startsWith('http')) {
                        this.bot.sendMessage(chatId, '❌ URL Block Explorer tidak valid. Harus dimulai http/https atau kirim /skip. Coba lagi:');
                        return;
                    }
                    if (rawUrl.endsWith('/')) {
                        rawUrl = rawUrl.slice(0, -1);
                    }
                    explorerUrl = rawUrl;
                }

                rpc.explorer = explorerUrl;
                cryptoApp.saveRpcConfig();

                if (explorerUrl) {
                    this.bot.sendMessage(chatId, `✅ Link Block Explorer berhasil diperbarui ke: ${explorerUrl}`);
                } else {
                    this.bot.sendMessage(chatId, `✅ Link Block Explorer berhasil dihapus!`);
                }
                this.userStates.delete(chatId);
                await this.showEditRpcPropMenu(cryptoApp, chatId, rpcKey);
            }

        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal menyimpan perubahan: ${error.message}`);
            this.userStates.delete(chatId);
            this.showRpcMenu(cryptoApp, chatId);
        }
    }

    async showEditRpcUrlSubMenu(cryptoApp, chatId, rpcKey) {
        const rpc = cryptoApp.savedRpcs[rpcKey];
        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
            return;
        }

        const backups = rpc.backupRpcs || [];
        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✏️ Ubah URL Utama', callback_data: `rpc_urlsub_main_${rpcKey}` }
                    ],
                    [
                        { text: '➕ Tambah URL Cadangan', callback_data: `rpc_urlsub_add_${rpcKey}` }
                    ],
                    [
                        { text: '📋 Lihat & Hapus Cadangan', callback_data: `rpc_urlsub_list_${rpcKey}` }
                    ],
                    [
                        { text: '🔙 Kembali', callback_data: `rpc_edit_select_${rpcKey}` }
                    ]
                ]
            }
        };

        let msg = `🔗 *KELOLA URL RPC: ${rpc.name}*\n\n` +
                  `🔗 URL Utama: \`${rpc.rpc}\`\n\n` +
                  `📋 URL Cadangan (${backups.length}):\n`;
        
        if (backups.length === 0) {
            msg += `_(Tidak ada URL cadangan)_\n`;
        } else {
            backups.forEach((b, idx) => {
                msg += `${idx + 1}. \`${b}\`\n`;
            });
        }

        this.bot.sendMessage(chatId, msg, { reply_markup: menu.reply_markup, parse_mode: 'Markdown' });
    }

    async showDeleteBackupRpcMenu(cryptoApp, chatId, rpcKey) {
        const rpc = cryptoApp.savedRpcs[rpcKey];
        if (!rpc) {
            this.bot.sendMessage(chatId, '❌ RPC tidak ditemukan.');
            return;
        }

        const backups = rpc.backupRpcs || [];
        if (backups.length === 0) {
            this.bot.sendMessage(chatId, '📭 Tidak ada URL cadangan untuk dihapus.');
            return;
        }

        const buttons = [];
        backups.forEach((b, idx) => {
            buttons.push([
                {
                    text: `🗑️ ${b.replace('https://', '').replace('http://', '').slice(0, 30)}...`,
                    callback_data: `rpc_urlsub_del_${rpcKey}_${idx}`
                }
            ]);
        });

        buttons.push([{ text: '🔙 Kembali', callback_data: `rpc_urlsub_menu_${rpcKey}` }]);

        this.bot.sendMessage(chatId, `Pilih URL cadangan yang ingin dihapus dari *${rpc.name}*:`, {
            reply_markup: { inline_keyboard: buttons },
            parse_mode: 'Markdown'
        });
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

        // Check if any port is running in another user session
        allPorts.forEach(p => {
            if (!p.isRunning) {
                for (const [otherChatId, otherCryptoApp] of this.userSessions.entries()) {
                    if (otherChatId.toString() !== chatId.toString()) {
                        if (otherCryptoApp.rpcServers.has(p.port) && otherCryptoApp.rpcServers.get(p.port).isRunning) {
                            p.isUsedByOther = true;
                            p.statusIcon = '🟡';
                            break;
                        }
                    }
                }
            }
        });

        const runningPorts = allPorts.filter(p => p.isRunning);

        let statusText = runningPorts.length > 0
            ? `🟢 AKTIF — ${runningPorts.map(p => `port ${p.port} (${p.modeLabel})`).join(', ')}`
            : '🔴 Tidak ada server aktif';

        let portLines = allPorts.map(p => {
            if (p.isUsedByOther) {
                return `🟡 Port ${p.port} | ${p.modeLabel} | ${p.isPermanent ? '🔒' : '🗑️'} ${p.label} (Dipakai User Lain)`;
            }
            return `${p.statusIcon} Port ${p.port} | ${p.modeLabel} | ${p.isPermanent ? '🔒' : '🗑️'} ${p.label}`;
        }).join('\n');

        // Build buttons: tiap port punya tombol start/stop + toggle mode
        const portButtons = allPorts.map(p => {
            const toggleMode = p.vpsMode ? '💻 → Localhost' : '🌐 → VPS';
            if (p.isRunning) {
                return [
                    { text: `🛑 Stop ${p.port}`, callback_data: `rpc_inject_stop_${p.port}` },
                    { text: `📋 Info ${p.port}`, callback_data: `rpc_inject_info_${p.port}` }
                ];
            } else if (p.isUsedByOther) {
                return [
                    { text: `🚫 Dipakai (${p.port})`, callback_data: `rpc_inject_usedbyother_${p.port}` },
                    { text: `${toggleMode} (${p.port})`, callback_data: `rpc_inject_togglemode_${p.port}` }
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

    async startRpcInjectServer(cryptoApp, chatId, port, vpsMode = null, password = null) {
        if (!cryptoApp.wallet) {
            this.bot.sendMessage(chatId, '❌ Pilih wallet aktif dulu sebelum start RPC server.');
            return;
        }

        // Check if another user session has this port active
        const portNum = parseInt(port);
        let portActiveInOtherSession = false;

        for (const [otherChatId, otherCryptoApp] of this.userSessions.entries()) {
            if (otherChatId.toString() !== chatId.toString()) {
                if (otherCryptoApp.rpcServers.has(portNum) && otherCryptoApp.rpcServers.get(portNum).isRunning) {
                    portActiveInOtherSession = true;
                    break;
                }
            }
        }

        if (portActiveInOtherSession) {
            this.bot.sendMessage(chatId, `❌ Gagal: Port ${port} sudah aktif digunakan oleh user Telegram lain.`);
            await this.showRpcInjectMenu(cryptoApp, chatId);
            return;
        }

        const cfg = cryptoApp.rpcPortsConfig[port] || {};
        const useVps = vpsMode !== null ? vpsMode : (cfg.vpsMode || false);

        await this.bot.sendMessage(chatId, `⏳ Memulai RPC server port ${port} (${useVps ? '🌐 VPS' : '💻 Localhost'})...`);
        const started = await cryptoApp.startRpcServer(port, useVps, password);

        if (started) {
            const info = cryptoApp.getRpcServerInfo(port);
            this.bot.sendMessage(chatId,
                `✅ *RPC SERVER PORT ${port} AKTIF!*\n\n` +
                `🔌 Mode  : ${info.modeLabel}\n` +
                `🔗 URL   : \`${info.rpcUrl}\`\n` +
                (info.vpsMode ? `⚠️ Ganti \`<IP_VPS>\` dengan IP publik VPS kamu!\n` : '') +
                `⛓️ Chain : \`${info.chainId}\` (${info.chainIdHex})\n` +
                `🔑 Password: \`${password || '-'}\`\n\n` +
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
        } else if (text === '📂 Menu Lainnya') {
            this.showMenuLainnya(chatId);
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
            case 'awaiting_rpc_edit':
                await this.processEditRpc(cryptoApp, chatId, text, userState);
                break;
            case 'awaiting_delay_input':
                await this.processDelayInput(cryptoApp, chatId, text, msg);
                break;
            case 'awaiting_rpc_inject_addport':
                await this.processRpcInjectAddPort(cryptoApp, chatId, text, userState);
                break;
            case 'awaiting_rpc_inject_password':
                await this.processRpcInjectPassword(cryptoApp, chatId, text, userState);
                break;

            // ── Transfer Bot states ──
            case 'transfer_awaiting_token_address':
            case 'transfer_awaiting_destination':
                await this.processTransferSetup(chatId, text, userState);
                break;

            // ── Manual Transfer states ──
            case 'manual_transfer_awaiting_rpc_add':
                await this.processAddManualRpc(chatId, text, userState);
                break;
            case 'manual_transfer_awaiting_recipient':
                if (!ethers.isAddress(text.trim())) {
                    this.bot.sendMessage(chatId, '❌ Alamat tidak valid. Kirim ulang alamat wallet penerima (0x...):');
                    return;
                }
                userState.recipient = text.trim();
                await this.askManualTransferAmount(chatId, userState);
                break;
            case 'manual_transfer_awaiting_amount':
                const amt = parseFloat(text.trim());
                if (isNaN(amt) || amt <= 0) {
                    this.bot.sendMessage(chatId, '❌ Jumlah tidak valid. Kirim ulang angka (contoh: 0.05):');
                    return;
                }
                userState.amount = text.trim();
                await this.showManualTransferGasOptions(chatId, userState);
                break;
            case 'manual_transfer_awaiting_token_add':
                await this.processManualTransferAddToken(chatId, text.trim(), userState);
                break;
            case 'manual_transfer_awaiting_api_key':
                const target = userState.target;
                const apiKeys = this.getExplorerApiKeys(chatId);
                if (text.trim() === '/delete') {
                    delete apiKeys[target];
                    this.saveExplorerApiKeys(chatId, apiKeys);
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `🗑️ API Key untuk ${target.toUpperCase()} berhasil dihapus!`);
                } else {
                    apiKeys[target] = text.trim();
                    this.saveExplorerApiKeys(chatId, apiKeys);
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `✅ API Key untuk ${target.toUpperCase()} berhasil diperbarui!`);
                }
                await this.showExplorerApiKeysMenu(chatId);
                break;

            // ── Morse Cipher states ──
            case 'awaiting_morse_encrypt':
                await this.processMorseEncrypt(chatId, text, msg);
                break;
            case 'awaiting_morse_decrypt':
                await this.processMorseDecrypt(chatId, text, msg);
                break;
            case 'morse_awaiting_save_password':
                await this.processMorseSavePassword(chatId, text, userState, msg);
                break;
            case 'morse_awaiting_save_name':
                await this.processMorseSaveName(chatId, text, userState, msg);
                break;
            case 'morse_awaiting_view_password':
                await this.processMorseViewPassword(chatId, text, userState, msg);
                break;
            case 'awaiting_dapp_timer_input':
                await this.processDappTimerInput(cryptoApp, chatId, text, msg);
                break;
            case 'migration_awaiting_backup_password':
                await this.processMigrationBackupPassword(chatId, text, msg);
                break;
            case 'migration_awaiting_import_password':
                await this.processMigrationImportPassword(chatId, text, userState, msg);
                break;

            // ── Backup Wallet Password Guard states ──
            case 'awaiting_backup_unlock':
            case 'backup_pw_set':
            case 'backup_pw_change':
                await this.processBackupPasswordInput(cryptoApp, chatId, text, userState, msg);
                break;

            // ── Tracker states ──
            case 'tracker_awaiting_addr':
                await this.processTrackerAddr(chatId, text, userState);
                break;
            case 'tracker_awaiting_name':
                await this.processTrackerName(chatId, text, userState);
                break;
            case 'tracker_awaiting_min_val':
                await this.processTrackerMinVal(chatId, text, userState);
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

        // Global: hentikan loading spinner di semua tombol sebelum proses apapun
        // (kecuali dapp_approval_toggle yang punya answerCallbackQuery sendiri dengan custom text)
        if (data !== 'dapp_approval_toggle' && !data.startsWith('dapp_connect_approve_') && !data.startsWith('dapp_connect_reject_') && !data.startsWith('rpc_inject_usedbyother_')) {
            this.bot.answerCallbackQuery(query.id).catch(() => {});
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
                await this.requestBackupUnlock(cryptoApp, chatId, address);
            }
            else if (data.startsWith('backup_create_pw_')) {
                const address = data.replace('backup_create_pw_', '');
                this.startCreateBackupPassword(chatId, address);
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
            else if (data === 'rpc_edit_menu') {
                await this.showEditRpcMenu(cryptoApp, chatId);
            }
            else if (data.startsWith('rpc_edit_select_')) {
                const rpcKey = data.replace('rpc_edit_select_', '');
                await this.showEditRpcPropMenu(cryptoApp, chatId, rpcKey);
            }
            else if (data.startsWith('rpc_edit_prop_')) {
                const parts = data.split('_');
                const property = parts[3];
                const rpcKey = parts.slice(4).join('_');
                await this.startEditRpcInput(cryptoApp, chatId, rpcKey, property);
            }
            else if (data.startsWith('rpc_urlsub_menu_')) {
                const rpcKey = data.replace('rpc_urlsub_menu_', '');
                await this.showEditRpcUrlSubMenu(cryptoApp, chatId, rpcKey);
            }
            else if (data.startsWith('rpc_urlsub_main_')) {
                const rpcKey = data.replace('rpc_urlsub_main_', '');
                await this.startEditRpcInput(cryptoApp, chatId, rpcKey, 'url');
            }
            else if (data.startsWith('rpc_urlsub_add_')) {
                const rpcKey = data.replace('rpc_urlsub_add_', '');
                await this.startEditRpcInput(cryptoApp, chatId, rpcKey, 'backup_add');
            }
            else if (data.startsWith('rpc_urlsub_list_')) {
                const rpcKey = data.replace('rpc_urlsub_list_', '');
                await this.showDeleteBackupRpcMenu(cryptoApp, chatId, rpcKey);
            }
            else if (data.startsWith('rpc_urlsub_del_')) {
                const parts = data.replace('rpc_urlsub_del_', '').split('_');
                const idx = parseInt(parts.pop());
                const rpcKey = parts.join('_');
                const rpc = cryptoApp.savedRpcs[rpcKey];
                if (rpc && rpc.backupRpcs) {
                    const deletedUrl = rpc.backupRpcs.splice(idx, 1)[0];
                    cryptoApp.saveRpcConfig();
                    this.bot.answerCallbackQuery(query.id, { text: `🗑️ URL cadangan dihapus!`, show_alert: false });
                }
                await this.showEditRpcUrlSubMenu(cryptoApp, chatId, rpcKey);
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
            else if (data === 'migration_menu') {
                try { await this.bot.deleteMessage(chatId, query.message.message_id); } catch (e) {}
                this.showMigrationMenu(chatId);
            }
            else if (data === 'migration_backup') {
                try { await this.bot.deleteMessage(chatId, query.message.message_id); } catch (e) {}
                this.userStates.set(chatId, { action: 'migration_awaiting_backup_password' });
                this.bot.sendMessage(chatId,
                    `📤 *BACKUP DATA — BUAT PASSWORD*\n\n` +
                    `Silakan masukkan password pengaman untuk enkripsi file backup Anda. Password ini wajib diingat untuk proses pemulihan/impor data nanti.\n\n` +
                    `_Ketik password baru Anda di bawah ini:_`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'migration_menu' }]]
                        }
                    }
                );
            }
            else if (data === 'migration_import') {
                try { await this.bot.deleteMessage(chatId, query.message.message_id); } catch (e) {}
                this.userStates.set(chatId, { action: 'awaiting_backup_upload' });
                this.bot.sendMessage(chatId,
                    `📥 *IMPOR DATA — UNGGAH FILE CADANGAN*\n\n` +
                    `Silakan kirim/unggah file backup Anda (\`.enc\`) yang ingin dipulihkan ke chat ini.\n\n` +
                    `_Menunggu file backup..._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'migration_menu' }]]
                        }
                    }
                );
            }
            // [v19.2] DApp Approval Toggle
            else if (data === 'dapp_approval_toggle') {
                const cryptoApp = this.userSessions.get(chatId);
                if (!cryptoApp) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: '❌ Sesi tidak ditemukan. Silakan /start ulang.',
                        show_alert: true
                    });
                    return;
                }

                // Toggle status
                cryptoApp.dappApprovalRequired = !cryptoApp.dappApprovalRequired;
                cryptoApp.saveRpcConfig();

                const newStatus = cryptoApp.dappApprovalRequired;
                const statusEmoji = newStatus ? '🟢' : '🔴';
                const statusText = newStatus ? 'ON' : 'OFF';

                // Tampilkan banner/toast instan di Telegram
                await this.bot.answerCallbackQuery(query.id, {
                    text: `🔐 DApp Approval: ${statusText} ${statusEmoji}`,
                    show_alert: false
                });

                // Hapus message menu pengaturan yang lama
                try {
                    await this.bot.deleteMessage(chatId, query.message.message_id);
                } catch (e) {
                    // Abaikan jika sudah terhapus
                }

                // Refresh menu pengaturan dengan status baru
                this.showPengaturanMenu(chatId);
            }
            // ── DApps menu callbacks ──
            else if (data === 'dapps_menu') {
                try {
                    await this.bot.deleteMessage(chatId, query.message.message_id);
                } catch (e) {}
                this.showDappsMenu(chatId);
            }
            else if (data === 'dapp_approval_toggle_new') {
                const cryptoApp = this.userSessions.get(chatId);
                if (!cryptoApp) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: '❌ Sesi tidak ditemukan. Silakan /start ulang.',
                        show_alert: true
                    });
                    return;
                }

                cryptoApp.dappApprovalRequired = !cryptoApp.dappApprovalRequired;
                cryptoApp.saveRpcConfig();

                const newStatus = cryptoApp.dappApprovalRequired;
                const statusEmoji = newStatus ? '🟢' : '🔴';
                const statusText = newStatus ? 'ON' : 'OFF';

                await this.bot.answerCallbackQuery(query.id, {
                    text: `🔐 DApp Approval: ${statusText} ${statusEmoji}`,
                    show_alert: false
                });

                try {
                    await this.bot.deleteMessage(chatId, query.message.message_id);
                } catch (e) {}
                this.showDappsMenu(chatId);
            }
            else if (data.startsWith('dapp_disconnect_')) {
                const cryptoApp = this.userSessions.get(chatId);
                if (!cryptoApp) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: '❌ Sesi tidak ditemukan. Silakan /start ulang.',
                        show_alert: true
                    });
                    return;
                }

                const dappId = data.replace('dapp_disconnect_', '');
                cryptoApp.removeConnectedDapp(dappId);

                await this.bot.answerCallbackQuery(query.id, {
                    text: '❌ Koneksi DApp diputuskan!',
                    show_alert: false
                });

                try {
                    await this.bot.deleteMessage(chatId, query.message.message_id);
                } catch (e) {}
                this.showDappsMenu(chatId);
            }
            else if (data === 'dapp_timer_settings') {
                const cryptoApp = this.userSessions.get(chatId);
                if (!cryptoApp) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: '❌ Sesi tidak ditemukan. Silakan /start ulang.',
                        show_alert: true
                    });
                    return;
                }

                await this.bot.answerCallbackQuery(query.id);

                this.userStates.set(chatId, {
                    action: 'awaiting_dapp_timer_input'
                });

                await this.bot.sendMessage(chatId,
                    `⏱️ *Timer Auto-Disconnect DApp*\n\n` +
                    `Saat ini: *${cryptoApp.dappInactivityTimeout !== 0 ? cryptoApp.dappInactivityTimeout + ' menit' : 'OFF (Tidak aktif)'}*\n\n` +
                    `Ketik waktu tunggu dalam menit yang Anda inginkan (1-1440):\n` +
                    `Ketik \`0\` jika ingin menonaktifkan fitur auto-disconnect ini.`,
                    { parse_mode: 'Markdown' }
                );
            }
            // [v19.2] DApp Connect Approve/Reject callbacks
            else if (data.startsWith('dapp_connect_approve_') || data.startsWith('dapp_connect_reject_')) {
                const isApprove = data.startsWith('dapp_connect_approve_');
                const approvalId = isApprove
                    ? data.replace('dapp_connect_approve_', '')
                    : data.replace('dapp_connect_reject_', '');

                // Cari cryptoApp yang memiliki pending approval ini
                let targetCryptoApp = null;
                for (const [cid, app] of this.userSessions.entries()) {
                    if (app.pendingDappApprovals && app.pendingDappApprovals.has(approvalId)) {
                        targetCryptoApp = app;
                        break;
                    }
                }

                if (!targetCryptoApp) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: '⏰ Request sudah expired atau sudah diproses.',
                        show_alert: true
                    });
                    return;
                }

                const result = targetCryptoApp.resolveDappApproval(approvalId, isApprove);

                await this.bot.answerCallbackQuery(query.id, {
                    text: isApprove ? '✅ DApp Connected!' : '❌ DApp Rejected!',
                    show_alert: false
                });
            }
            else if (data === 'menu_lainnya') {
                this.showMenuLainnya(chatId);
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
            else if (data === 'owner_change_backup_pw') {
                this.startChangeBackupPassword(chatId);
            }
            // ── Tracker Menu Callbacks ──
            else if (data === 'tracker_menu') {
                this.showTrackerMenu(chatId);
            }
            else if (data === 'tracker_add_wallet') {
                this.userStates.set(chatId, { action: 'tracker_awaiting_addr' });
                this.bot.sendMessage(chatId,
                    `👁️ *TAMBAH WALLET PEMANTAU (1/3)*\n\n` +
                    `Kirimkan **Alamat Publik** wallet yang ingin dipantau (0x...):\n\n` +
                    `⚠️ _Hanya alamat publik. JANGAN kirim Private Key atau Seed Phrase!_\n\n` +
                    `_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data === 'tracker_list_wallets') {
                this.showTrackerListWallets(chatId);
            }
            else if (data === 'tracker_toggle') {
                const state = this.getTrackerState(chatId);
                state.active = !state.active;
                this.saveTrackerState(chatId, state);
                if (state.active) {
                    this.startTrackerPolling(chatId);
                    this.bot.sendMessage(chatId, '🟢 *Tracking Bot diaktifkan di latar belakang!*', { parse_mode: 'Markdown' });
                } else {
                    this.stopTrackerPolling(chatId);
                    this.bot.sendMessage(chatId, '🔴 *Tracking Bot dihentikan.*', { parse_mode: 'Markdown' });
                }
                this.showTrackerMenu(chatId);
            }
            else if (data === 'tracker_settings') {
                this.showTrackerSettings(chatId);
            }
            else if (data === 'tracker_min_val_menu') {
                this.showTrackerMinValMenu(chatId);
            }
            else if (data === 'tracker_toggle_native') {
                const state = this.getTrackerState(chatId);
                state.notifyNative = state.notifyNative === undefined ? false : !state.notifyNative;
                this.saveTrackerState(chatId, state);
                this.showTrackerSettings(chatId);
            }
            else if (data === 'tracker_toggle_erc20') {
                const state = this.getTrackerState(chatId);
                state.notifyErc20 = state.notifyErc20 === undefined ? false : !state.notifyErc20;
                this.saveTrackerState(chatId, state);
                this.showTrackerSettings(chatId);
            }
            else if (data.startsWith('tracker_set_min_')) {
                const action = data.replace('tracker_set_min_', '');
                if (action === 'manual') {
                    this.userStates.set(chatId, { action: 'tracker_awaiting_min_val' });
                    this.bot.sendMessage(chatId, `✏️ *Masukkan minimum nilai USDT* (contoh: 2.5):\n\n_(Kirim /cancel untuk membatalkan)_`, { parse_mode: 'Markdown' });
                } else {
                    const val = parseFloat(action);
                    const state = this.getTrackerState(chatId);
                    state.minUsdt = val;
                    this.saveTrackerState(chatId, state);
                    this.bot.sendMessage(chatId, `✅ Filter minimum nilai berhasil diubah menjadi: *$${val} USDT*`, { parse_mode: 'Markdown' });
                    this.showTrackerSettings(chatId);
                }
            }
            else if (data.startsWith('tracker_toggle_net_')) {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'tracker_awaiting_chains') {
                    const netKey = data.replace('tracker_toggle_net_', '');
                    if (state.selectedNetworks.includes(netKey)) {
                        state.selectedNetworks = state.selectedNetworks.filter(n => n !== netKey);
                    } else {
                        state.selectedNetworks.push(netKey);
                    }
                    this.userStates.set(chatId, state);
                    
                    // Edit message markup to reflect toggled option
                    const keyboard = [];
                    const keys = Object.keys(TRACKER_NETWORKS);
                    for (let i = 0; i < keys.length; i += 2) {
                        const row = [];
                        const key1 = keys[i];
                        const net1 = TRACKER_NETWORKS[key1];
                        const active1 = state.selectedNetworks.includes(key1) ? '✅' : '⬜️';
                        row.push({ text: `${active1} ${net1.name}`, callback_data: `tracker_toggle_net_${key1}` });

                        if (i + 1 < keys.length) {
                            const key2 = keys[i + 1];
                            const net2 = TRACKER_NETWORKS[key2];
                            const active2 = state.selectedNetworks.includes(key2) ? '✅' : '⬜️';
                            row.push({ text: `${active2} ${net2.name}`, callback_data: `tracker_toggle_net_${key2}` });
                        }
                        keyboard.push(row);
                    }
                    keyboard.push([
                        { text: '🌟 Select All', callback_data: 'tracker_net_all' },
                        { text: '❌ Clear All', callback_data: 'tracker_net_clear' }
                    ]);
                    keyboard.push([{ text: '💾 Simpan & Selesai', callback_data: 'tracker_save_wallet' }]);

                    this.bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
                }
            }
            else if (data === 'tracker_net_all') {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'tracker_awaiting_chains') {
                    state.selectedNetworks = Object.keys(TRACKER_NETWORKS);
                    this.userStates.set(chatId, state);
                    this.showTrackerAddChainsMenu(chatId, state);
                }
            }
            else if (data === 'tracker_net_clear') {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'tracker_awaiting_chains') {
                    state.selectedNetworks = [];
                    this.userStates.set(chatId, state);
                    this.showTrackerAddChainsMenu(chatId, state);
                }
            }
            else if (data === 'tracker_save_wallet') {
                const state = this.userStates.get(chatId);
                if (state && state.action === 'tracker_awaiting_chains') {
                    if (state.selectedNetworks.length === 0) {
                        this.bot.answerCallbackQuery(query.id, { text: '⚠️ Pilih minimal 1 jaringan!', show_alert: true });
                        return;
                    }
                    const wallets = this.getTrackedWallets(chatId);
                    wallets.push({
                        address: state.address,
                        name: state.name,
                        networks: state.selectedNetworks
                    });
                    this.saveTrackedWallets(chatId, wallets);
                    this.userStates.delete(chatId);
                    this.bot.sendMessage(chatId, `✅ *Wallet berhasil ditambahkan ke daftar pantauan!*`, { parse_mode: 'Markdown' });
                    this.showTrackerListWallets(chatId);
                }
            }
            else if (data.startsWith('tracker_del_wallet_')) {
                const idx = parseInt(data.replace('tracker_del_wallet_', ''));
                const wallets = this.getTrackedWallets(chatId);
                if (wallets[idx]) {
                    const name = wallets[idx].name;
                    wallets.splice(idx, 1);
                    this.saveTrackedWallets(chatId, wallets);
                    this.bot.sendMessage(chatId, `🗑️ Wallet *${name}* berhasil dihapus dari daftar pantauan.`, { parse_mode: 'Markdown' });
                }
                this.showTrackerListWallets(chatId);
            }
            else if (data.startsWith('tracker_history_')) {
                const page = parseInt(data.replace('tracker_history_', '')) || 1;
                this.showTrackerHistory(chatId, page);
            }
            else if (data.startsWith('tracker_hist_detail_')) {
                const idx = parseInt(data.replace('tracker_hist_detail_', ''));
                this.showTrackerHistoryDetail(chatId, idx);
            }
            else if (data === 'morse_menu') {
                this.showMorseMenu(chatId);
            }
            else if (data === 'morse_encrypt') {
                this.userStates.set(chatId, { action: 'awaiting_morse_encrypt' });
                this.bot.sendMessage(chatId,
                    `✍️ *Ketik teks biasa* atau *unggah file .txt* yang ingin Anda enkripsi:\n\n` +
                    `_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data === 'morse_decrypt') {
                this.userStates.set(chatId, { action: 'awaiting_morse_decrypt' });
                this.bot.sendMessage(chatId,
                    `✍️ *Kirim kode Morse kustom* atau *unggah file .txt* yang berisi kode Morse untuk didekripsi:\n\n` +
                    `_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data === 'morse_save_confirm_yes') {
                const state = this.userStates.get(chatId);
                if (!state || state.action !== 'morse_awaiting_save_decision') return;

                state.action = 'morse_awaiting_save_name';
                this.userStates.set(chatId, state);

                await this.bot.sendMessage(chatId,
                    `✍️ *Masukkan nama/label* untuk menyimpan pesan ini:\n\n` +
                    `_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data === 'morse_save_confirm_no') {
                this.userStates.delete(chatId);
                await this.bot.sendMessage(chatId, 'ℹ️ Pesan tidak disimpan di server.');
                this.showMorseMenu(chatId);
            }
            else if (data === 'morse_save_use_password_no') {
                const state = this.userStates.get(chatId);
                if (!state || state.action !== 'morse_awaiting_save_decision') return;

                try {
                    morseStorage.saveMessage({
                        chatId,
                        morseCode: state.morseCode,
                        fileName: state.fileName,
                        password: null,
                        customName: state.customName
                    });
                    this.userStates.delete(chatId);
                    await this.bot.sendMessage(chatId, `✅ *Pesan '${state.customName}' berhasil disimpan di server (tanpa password).*`, { parse_mode: 'Markdown' });
                } catch (e) {
                    await this.bot.sendMessage(chatId, `❌ Gagal menyimpan: ${e.message}`);
                }
                this.showMorseMenu(chatId);
            }
            else if (data === 'morse_save_use_password_yes') {
                const state = this.userStates.get(chatId);
                if (!state || state.action !== 'morse_awaiting_save_decision') return;

                state.action = 'morse_awaiting_save_password';
                this.userStates.set(chatId, state);

                await this.bot.sendMessage(chatId,
                    `🔑 *Masukkan password* untuk mengunci pesan ini:\n\n_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data === 'morse_list_saved') {
                this.userStates.delete(chatId); // Clear state if any
                const userMessages = morseStorage.getMessagesByChatId(chatId);
                if (userMessages.length === 0) {
                    await this.bot.sendMessage(chatId, '📭 *Anda belum memiliki pesan tersimpan.*', { parse_mode: 'Markdown' });
                    this.showMorseMenu(chatId);
                    return;
                }

                const keyboard = userMessages.map((msg, idx) => {
                    const status = msg.isPasswordProtected ? '🔒' : '🔓';
                    return [
                        {
                            text: `${idx + 1}. [${status}] ${msg.customName}`,
                            callback_data: `morse_view_saved_${msg.id}`
                        },
                        {
                            text: '🗑️',
                            callback_data: `morse_delete_confirm_${msg.id}`
                        }
                    ];
                });
                keyboard.push([{ text: '🔙 Kembali ke Menu Morse', callback_data: 'morse_menu' }]);

                await this.bot.sendMessage(chatId,
                    `📋 *DAFTAR PESAN TERSIMPAN*\n\n` +
                    `Status: 🔒 Terkunci | 🔓 Terbuka\n\nPilih pesan untuk dibuka atau ketuk 🗑️ untuk menghapus:`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
                );
            }
            else if (data.startsWith('morse_view_saved_')) {
                const msgId = data.replace('morse_view_saved_', '');
                const message = morseStorage.getMessageById(msgId);
                if (!message) {
                    await this.bot.sendMessage(chatId, '❌ Pesan tidak ditemukan.');
                    return;
                }

                if (message.isPasswordProtected) {
                    this.userStates.set(chatId, {
                        action: 'morse_awaiting_view_password',
                        messageId: msgId
                    });
                    const keyboard = [
                        [{ text: '❌ Batal', callback_data: 'morse_list_saved' }]
                    ];
                    await this.bot.sendMessage(chatId,
                        `🔒 *Pesan Terkunci*\n\nMasukkan password untuk membuka pesan ini:`,
                        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
                    );
                } else {
                    try {
                        const decrypted = morseStorage.decryptMessage(message);
                        await this._sendDecryptedMorseFiles(chatId, message, decrypted, false);
                    } catch (e) {
                        await this.bot.sendMessage(chatId, `❌ Gagal membuka pesan: ${e.message}`);
                    }
                }
            }
            else if (data.startsWith('morse_delete_confirm_')) {
                const msgId = data.replace('morse_delete_confirm_', '');
                const message = morseStorage.getMessageById(msgId);
                if (!message) {
                    await this.bot.sendMessage(chatId, '❌ Pesan tidak ditemukan.');
                    return;
                }

                const keyboard = [
                    [
                        { text: '🗑️ Ya, Hapus', callback_data: `morse_delete_saved_${msgId}` },
                        { text: '❌ Batal', callback_data: 'morse_list_saved' }
                    ]
                ];

                await this.bot.sendMessage(chatId,
                    `⚠️ *Hapus Pesan Tersimpan*\n\n` +
                    `Apakah Anda yakin ingin menghapus pesan *${message.customName}* dari server?\n\n` +
                    `_(Tindakan ini tidak dapat dibatalkan)_`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
                );
            }
            else if (data.startsWith('morse_delete_saved_')) {
                const msgId = data.replace('morse_delete_saved_', '');
                const deleted = morseStorage.deleteMessage(msgId);
                if (deleted) {
                    await this.bot.sendMessage(chatId, '🗑️ Pesan berhasil dihapus.');
                } else {
                    await this.bot.sendMessage(chatId, '❌ Gagal menghapus pesan.');
                }
                // Refresh list
                const userMessages = morseStorage.getMessagesByChatId(chatId);
                if (userMessages.length === 0) {
                    this.showMorseMenu(chatId);
                } else {
                    const keyboard = userMessages.map((msg, idx) => {
                        const status = msg.isPasswordProtected ? '🔒' : '🔓';
                        return [
                            {
                                text: `${idx + 1}. [${status}] ${msg.customName}`,
                                callback_data: `morse_view_saved_${msg.id}`
                            },
                            {
                                text: '🗑️',
                                callback_data: `morse_delete_confirm_${msg.id}`
                            }
                        ];
                    });
                    keyboard.push([{ text: '🔙 Kembali ke Menu Morse', callback_data: 'morse_menu' }]);

                    await this.bot.sendMessage(chatId,
                        `📋 *DAFTAR PESAN TERSIMPAN*\n\n` +
                        `Status: 🔒 Terkunci | 🔓 Terbuka\n\nPilih pesan untuk dibuka atau ketuk 🗑️ untuk menghapus:`,
                        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
                    );
                }
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

            // ── 💸 Manual Transfer callbacks ──
            else if (data === 'transfer_manual_menu') {
                this.userStates.delete(chatId);
                await this.showManualTransferMenu(chatId);
            }
            else if (data === 'tm_menu_other_networks') {
                await this.showManualTransferOtherNetworks(chatId);
            }
            else if (data === 'tm_add_rpc') {
                await this.startAddManualRpcFlow(chatId);
            }
            else if (data === 'tm_setup_api_keys') {
                await this.showExplorerApiKeysMenu(chatId);
            }
            else if (data.startsWith('tm_edit_api_')) {
                const target = data.replace('tm_edit_api_', '');
                this.userStates.set(chatId, {
                    action: 'manual_transfer_awaiting_api_key',
                    target
                });
                this.bot.sendMessage(chatId,
                    `🔑 *UPDATE API KEY (${target.toUpperCase()})*\n\n` +
                    `Kirimkan API Key baru Anda untuk ${target.toUpperCase()} (atau kirim \`/delete\` untuk menghapus key yang ada):`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tm_setup_api_keys' }]] } }
                );
            }
            else if (data.startsWith('tm_pick_net_default_')) {
                const netKey = data.replace('tm_pick_net_default_', '');
                const network = MANUAL_NETWORKS[netKey];
                if (network) {
                    await this.askManualTransferWallet(chatId, { ...network });
                }
            }
            else if (data.startsWith('tm_pick_net_custom_')) {
                const netKey = data.replace('tm_pick_net_custom_', '');
                const customRpcs = this.getManualRpcs(chatId);
                const network = customRpcs[netKey];
                if (network) {
                    await this.askManualTransferWallet(chatId, { ...network });
                }
            }
            else if (data.startsWith('tm_pick_wallet_')) {
                const idx = parseInt(data.replace('tm_pick_wallet_', ''));
                const state = this.userStates.get(chatId);
                if (!state || state.action !== 'tm_awaiting_wallet_pick') return;
                const walletInfo = state.walletEntries[idx];
                if (!walletInfo) return;
                state.wallet = walletInfo;
                state.action = 'tm_assets_screen';
                await this.showManualTransferAssets(chatId, state);
            }
            else if (data === 'tm_pick_asset_native') {
                const state = this.userStates.get(chatId);
                if (!state) return;
                state.asset = { type: 'native', symbol: 'Native', decimals: 18 };
                await this.showAssetDashboard(chatId, state);
            }
            else if (data.startsWith('tm_pick_asset_token_')) {
                const tokenAddress = data.replace('tm_pick_asset_token_', '');
                const state = this.userStates.get(chatId);
                if (!state) return;
                const tokens = this.getManualTokens(chatId, state.network.chainId);
                const tokenInfo = tokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
                if (tokenInfo) {
                    state.asset = { type: 'token', ...tokenInfo };
                    await this.showAssetDashboard(chatId, state);
                }
            }
            else if (data === 'tm_start_send_flow') {
                const state = this.userStates.get(chatId);
                if (!state) return;
                await this.askManualTransferRecipient(chatId, state);
            }
            else if (data.startsWith('tm_tx_detail_')) {
                const idx = parseInt(data.replace('tm_tx_detail_', ''));
                const state = this.userStates.get(chatId);
                if (!state) return;
                await this.showTransactionDetail(chatId, state, idx);
            }
            else if (data === 'tm_back_to_dashboard') {
                const state = this.userStates.get(chatId);
                if (!state) return;
                await this.showAssetDashboard(chatId, state);
            }
            else if (data === 'tm_add_token') {
                const state = this.userStates.get(chatId);
                if (!state) return;
                state.action = 'manual_transfer_awaiting_token_add';
                this.userStates.set(chatId, state);
                this.bot.sendMessage(chatId,
                    '🪙 *TAMBAH TOKEN*\n\nKirim alamat kontrak token ERC-20 (0x...):', 
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'transfer_manual_menu' }]] } }
                );
            }
            else if (data === 'tm_gas_instan') {
                const state = this.userStates.get(chatId);
                if (!state || !state.gasPrices) return;
                state.selectedGas = { mode: 'instan', gasPrice: state.gasPrices.instan, gasLimit: state.gasPrices.gasLimit };
                await this.showManualTransferConfirmation(chatId, state);
            }
            else if (data === 'tm_gas_fast') {
                const state = this.userStates.get(chatId);
                if (!state || !state.gasPrices) return;
                state.selectedGas = { mode: 'fast', gasPrice: state.gasPrices.fast, gasLimit: state.gasPrices.gasLimit };
                await this.showManualTransferConfirmation(chatId, state);
            }
            else if (data === 'tm_gas_reguler') {
                const state = this.userStates.get(chatId);
                if (!state || !state.gasPrices) return;
                state.selectedGas = { mode: 'reguler', gasPrice: state.gasPrices.reguler, gasLimit: state.gasPrices.gasLimit };
                await this.showManualTransferConfirmation(chatId, state);
            }
            else if (data === 'tm_send_confirm') {
                const state = this.userStates.get(chatId);
                if (!state || !state.selectedGas) return;
                await this.executeManualTransfer(chatId, state);
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
                this.userStates.delete(chatId);
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
                        `🌐 Network : ${info.networkName}\n` +
                        `🔑 Password: \`${info.password || '-'}\`\n\n` +
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
                this.userStates.set(chatId, { action: 'awaiting_rpc_inject_password', port });
                this.bot.sendMessage(chatId,
                    `🔑 *RPC PASSWORD REQUIRED*\n\n` +
                    `Silakan masukkan password keamanan untuk port *${port}*:\n\n` +
                    `👉 Ketik *skip* untuk menjalankan tanpa password keamanan.\n\n` +
                    `_(Kirim /cancel untuk membatalkan)_`,
                    { parse_mode: 'Markdown' }
                );
            }
            else if (data.startsWith('rpc_inject_usedbyother_')) {
                const port = parseInt(data.replace('rpc_inject_usedbyother_', ''));
                this.bot.answerCallbackQuery(query.id, {
                    text: `⚠️ Port ${port} sedang aktif digunakan oleh user lain!`,
                    show_alert: true
                }).catch(() => {});
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

        if (this.trackerIntervals) {
            for (const [chatId, interval] of this.trackerIntervals.entries()) {
                clearInterval(interval);
            }
            this.trackerIntervals.clear();
        }

        console.log(`Cleaning up ${this.userSessions.size} active sessions...`);

        for (const [chatId, session] of this.userSessions.entries()) {
            console.log(`Cleaning up session for ${chatId}...`);
            await session.cleanup();
        }

        this.userSessions.clear();
        console.log('🤖 All Crypto App sessions cleaned up.');
    }

    // ===================================
    // MORSE CIPHER METHODS
    // ===================================

    async processMorseEncrypt(chatId, text, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.showMorseMenu(chatId);
            return;
        }

        if (!text.trim()) {
            this.bot.sendMessage(chatId, '⚠ Teks tidak boleh kosong! Coba lagi:');
            return;
        }

        const encryptedText = morse.encryptMultiCipher(text, allMorseCiphers);
        
        // Save temporary state for save prompt (originalText TIDAK disimpan untuk keamanan)
        this.userStates.set(chatId, {
            action: 'morse_awaiting_save_decision',
            morseCode: encryptedText,
            fileName: null
        });

        const responseMessage =
            `🔐 *HASIL ENKRIPSI MORSE* 🔐\n\n` +
            `📥 *Input Teks:* \`${text}\`\n\n` +
            `📤 *Output Kode Morse:* \n\`${encryptedText}\`\n\n` +
            `💾 *Apakah Anda ingin menyimpan pesan terenkripsi ini di server?*`;

        const keyboard = [
            [
                { text: '✅ Ya', callback_data: 'morse_save_confirm_yes' },
                { text: '❌ Tidak', callback_data: 'morse_save_confirm_no' }
            ]
        ];

        await this.bot.sendMessage(chatId, responseMessage, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    async processMorseDecrypt(chatId, text, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.showMorseMenu(chatId);
            return;
        }

        if (!text.trim()) {
            this.bot.sendMessage(chatId, '⚠ Kode tidak boleh kosong! Coba lagi:');
            return;
        }

        // Coba multi-cipher dulu, fallback ke legacy jika hasil kosong
        let decryptedText = morse.decryptMultiCipher(text, allMorseCiphers);
        if (!decryptedText || decryptedText.trim() === '') {
            decryptedText = morse.decrypt(text, morseMap);
        }
        this.userStates.delete(chatId);

        const responseMessage =
            `🔓 *HASIL DEKRIPSI MORSE* 🔓\n\n` +
            `📥 *Input Morse:* \`Secret Morse Code\`\n\n` +
            `📤 *Output Teks:* \`${decryptedText}\`\n\n` +
            `💡 _Pilih opsi di bawah untuk lanjut:_`;

        const keyboard = [
            [{ text: '🔙 Kembali ke Menu Morse', callback_data: 'morse_menu' }]
        ];

        await this.bot.sendMessage(chatId, responseMessage, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    async processMorseSaveName(chatId, text, userState, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '⏹️ Penyimpanan dibatalkan.');
            this.showMorseMenu(chatId);
            return;
        }

        const customName = text.trim();
        if (!customName) {
            this.bot.sendMessage(chatId, '⚠ Nama tidak boleh kosong! Coba lagi:');
            return;
        }

        userState.customName = customName;
        userState.action = 'morse_awaiting_save_decision';
        this.userStates.set(chatId, userState);

        const keyboard = [
            [
                { text: '🔑 Ya, Pakai Password', callback_data: 'morse_save_use_password_yes' },
                { text: '🔓 Tidak, Tanpa Password', callback_data: 'morse_save_use_password_no' }
            ],
            [{ text: '🔙 Batal', callback_data: 'morse_save_confirm_no' }]
        ];

        await this.bot.sendMessage(chatId,
            `🔒 *Kunci Keamanan*\n\nApakah Anda ingin mengunci pesan '${customName}' ini dengan password?`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async processMorseSavePassword(chatId, text, userState, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '⏹️ Penyimpanan dibatalkan.');
            this.showMorseMenu(chatId);
            return;
        }

        const password = text.trim();
        if (password.length < 4) {
            this.bot.sendMessage(chatId, '❌ Password minimal 4 karakter. Silakan masukkan password baru:');
            return;
        }

        try {
            const { morseCode, fileName, customName } = userState;
            morseStorage.saveMessage({
                chatId,
                morseCode,
                fileName,
                password,
                customName
            });

            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, `✅ *Pesan '${customName}' berhasil disimpan dan dikunci dengan password!*`, { parse_mode: 'Markdown' });
            this.showMorseMenu(chatId);
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ Gagal menyimpan pesan: \`${error.message}\``, { parse_mode: 'Markdown' });
        }
    }

    async processMorseViewPassword(chatId, text, userState, msg) {
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        if (text.trim() === '/cancel') {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '⏹️ Batal melihat pesan.');
            this.showMorseMenu(chatId);
            return;
        }

        const password = text.trim();
        const messageId = userState.messageId;
        const message = morseStorage.getMessageById(messageId);

        if (!message) {
            this.userStates.delete(chatId);
            this.bot.sendMessage(chatId, '❌ Pesan tidak ditemukan.');
            this.showMorseMenu(chatId);
            return;
        }

        try {
            const decrypted = morseStorage.decryptMessage(message, password);
            this.userStates.delete(chatId);
            await this._sendDecryptedMorseFiles(chatId, message, decrypted, true);
        } catch (error) {
            const keyboard = [
                [{ text: '❌ Batal', callback_data: 'morse_list_saved' }]
            ];
            let errorMsg;
            if (error.message === 'Incorrect password') {
                errorMsg = `❌ *Password salah!* Silakan coba lagi.\n\n💡 _Tips: Perhatikan penggunaan huruf kapital (Keyboard HP sering otomatis mengubah huruf pertama jadi kapital) dan pastikan tidak ada spasi tambahan._`;
            } else {
                errorMsg = `❌ *Gagal membuka pesan:* \`${error.message}\`\n\nSilakan coba lagi:`;
            }
            this.bot.sendMessage(chatId, errorMsg, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    }

    /**
     * Kirim hasil dekripsi Morse sebagai file .txt agar tidak terkena batas panjang Telegram.
     * @param {number} chatId
     * @param {object} message  - Metadata dari morseStorage
     * @param {object} decrypted - { originalText, morseCode, fileName }
     * @param {boolean} wasPasswordProtected
     */
    async _sendDecryptedMorseFiles(chatId, message, decrypted, wasPasswordProtected) {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');

        const timestamp = new Date(message.timestamp).toLocaleString('id-ID');
        const lockStatus = wasPasswordProtected ? '🔒 Terkunci (Password Cocok)' : '🔓 Terbuka (Tanpa Password)';
        const label = message.customName || message.id;
        const safeName = label.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);

        // Isi file — HANYA kode Morse terenkripsi (data asli TIDAK pernah disimpan di server)
        const fileContent =
            `============================\n` +
            `  PESAN TERSIMPAN - ${label}\n` +
            `============================\n` +
            `Waktu Simpan : ${timestamp}\n` +
            `Status       : ${lockStatus}\n` +
            (decrypted.fileName ? `File Sumber  : ${decrypted.fileName}\n` : '') +
            `============================\n\n` +
            `[KODE MORSE TERENKRIPSI]\n${decrypted.morseCode}\n`;

        const tmpFile = path.join(os.tmpdir(), `morse_${safeName}_${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, fileContent, 'utf8');

        const keyboard = [
            [
                { text: '🗑️ Hapus Pesan', callback_data: `morse_delete_confirm_${message.id}` },
                { text: '🔙 Kembali', callback_data: 'morse_list_saved' }
            ]
        ];

        await this.bot.sendMessage(chatId,
            `📂 *PESAN BERHASIL DIBUKA*\n\n` +
            `📝 *Nama:* \`${label}\`\n` +
            `📅 *Disimpan:* ${timestamp}\n` +
            `🔐 *Status:* ${lockStatus}\n\n` +
            `📎 Isi pesan dikirim sebagai file di bawah ini:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );

        await this.bot.sendDocument(chatId,
            fs.createReadStream(tmpFile),
            {},
            { filename: `${safeName}.txt`, contentType: 'text/plain' }
        );

        // Bersihkan file temp
        try { fs.unlinkSync(tmpFile); } catch (e) { }
    }

    async handleDocument(msg) {
        const chatId = msg.chat.id;

        if (!this.userSessions.has(chatId)) {
            this.bot.sendMessage(chatId, '❌ Sesi Anda tidak ditemukan atau berakhir. Silakan /start untuk login.');
            return;
        }

        const document = msg.document;
        if (!document) return;

        const fileName = document.file_name || '';
        const userState = this.userStates.get(chatId);

        // Intersepsi jika user sedang menunggu upload file backup
        if (userState && userState.action === 'awaiting_backup_upload') {
            const statusMsg = await this.bot.sendMessage(
                chatId,
                `⏳ *Mengunduh file backup '${fileName}'...*`,
                { parse_mode: 'Markdown' }
            );

            try {
                const fileLink = await this.bot.getFileLink(document.file_id);
                const fileContent = await this._fetchFileContent(fileLink);

                const parsed = JSON.parse(fileContent);
                if (!parsed || !parsed.salt || !parsed.iv || !parsed.ciphertext) {
                    throw new Error('Format isi file backup tidak valid');
                }

                try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }

                // Pindah ke state meminta password dekripsi
                this.userStates.set(chatId, {
                    action: 'migration_awaiting_import_password',
                    backupData: parsed,
                    attempts: 0
                });

                await this.bot.sendMessage(chatId,
                    `🔑 *IMPOR DATA — MASUKKAN PASSWORD*\n\n` +
                    `File backup berhasil diterima.\n` +
                    `Silakan masukkan password dekripsi Anda:\n\n` +
                    `_Percobaan: 1 dari 3_`,
                    { parse_mode: 'Markdown' }
                );
                return;
            } catch (err) {
                try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }
                this.bot.sendMessage(
                    chatId,
                    `⚠️ *File Backup Tidak Valid!*\n\n` +
                    `File yang diunggah bukan file backup Fastarx yang valid atau isi file rusak.\n\n` +
                    `Silakan unggah kembali file backup yang benar.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }
        }

        if (!fileName.toLowerCase().endsWith('.txt')) {
            this.bot.sendMessage(
                chatId,
                '⚠️ *Format File Salah!*\n\nBot ini hanya mendukung pengolahan file dengan ekstensi \`.txt\`.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const statusMsg = await this.bot.sendMessage(
            chatId,
            `⏳ *Memproses file '${fileName}'...*\n_Sedang mengunduh dan melakukan pemrosesan data secara in-memory (aman)..._`,
            { parse_mode: 'Markdown' }
        );

        try {
            const fileLink = await this.bot.getFileLink(document.file_id);
            const fileContent = await this._fetchFileContent(fileLink);

            if (!fileContent.trim()) {
                try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }
                this.bot.sendMessage(
                    chatId,
                    '⚠️ *File Kosong!*\n\nKonten dari file yang Anda unggah kosong atau tidak memiliki karakter untuk diproses.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const userState = this.userStates.get(chatId);
            const currentAction = userState?.action;
            let actionType = 'encrypt';

            if (currentAction === 'awaiting_morse_encrypt') {
                actionType = 'encrypt';
            } else if (currentAction === 'awaiting_morse_decrypt') {
                actionType = 'decrypt';
            } else {
                actionType = this._isMorseCode(fileContent) ? 'decrypt' : 'encrypt';
            }

            this.userStates.delete(chatId);

            if (actionType === 'encrypt') {
                const encryptedMorse = morse.encryptFileMultiCipher(fileContent, allMorseCiphers);
                const outputBuffer = Buffer.from(encryptedMorse, 'utf-8');

                try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }

                await this.bot.sendDocument(
                    chatId,
                    outputBuffer,
                    {
                        caption: '🔐 *ENKRIPSI BERHASIL!*\n\nBerikut adalah hasil sandi Morse kustom Anda dalam bentuk file \`.txt\`.'
                    },
                    {
                        filename: `enkripsi_${fileName}`,
                        contentType: 'text/plain'
                    }
                );

                // Save temporary state for save prompt (originalText TIDAK disimpan untuk keamanan)
                this.userStates.set(chatId, {
                    action: 'morse_awaiting_save_decision',
                    morseCode: encryptedMorse,
                    fileName: fileName
                });

                const savePromptMsg =
                    `💾 *Apakah Anda ingin menyimpan pesan terenkripsi dari file '${fileName}' ini di server?*`;

                const keyboard = [
                    [
                        { text: '✅ Ya', callback_data: 'morse_save_confirm_yes' },
                        { text: '❌ Tidak', callback_data: 'morse_save_confirm_no' }
                    ]
                ];

                await this.bot.sendMessage(chatId, savePromptMsg, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else {
                // Coba multi-cipher dulu, fallback ke legacy jika hasil kosong
                let decryptedText = morse.decryptFileMultiCipher(fileContent, allMorseCiphers);
                if (!decryptedText || decryptedText.trim() === '') {
                    decryptedText = morse.decryptFile(fileContent, morseMap);
                }
                const outputBuffer = Buffer.from(decryptedText, 'utf-8');

                try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }

                await this.bot.sendDocument(
                    chatId,
                    outputBuffer,
                    {
                        caption: '🔓 *DEKRIPSI BERHASIL!*\n\nBerikut adalah hasil terjemahan teks asli Anda dalam bentuk file \`.txt\`.'
                    },
                    {
                        filename: `dekripsi_${fileName}`,
                        contentType: 'text/plain'
                    }
                );
            }

        } catch (error) {
            try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { }
            console.error('❌ Gagal memproses file:', error);
            this.bot.sendMessage(
                chatId,
                `❌ *Gagal memproses file!*\nTerjadi kesalahan internal: \`${error.message}\``,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async processMigrationBackupPassword(chatId, password, msg) {
        // Hapus pesan password dari chat demi keamanan
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

        const statusMsg = await this.bot.sendMessage(chatId, '⏳ *Sedang memproses dan mengenkripsi data backup Anda...*', { parse_mode: 'Markdown' });

        try {
            const dataDir = path.join(projectRoot, 'data');
            const backupBuffer = backupHelper.createBackup(chatId, password, dataDir);

            // Kirim file backup ke Telegram
            await this.bot.sendDocument(
                chatId,
                backupBuffer,
                {
                    caption: `🔐 *BACKUP DATA FASTARX BOT BERHASIL!*\n\n` +
                             `File ini berisi data Wallet, RPC, Port, dan Morse Anda dalam bentuk terenkripsi.\n\n` +
                             `⚠️ *PERINGATAN*: Jangan membagikan file ini kepada siapa pun. Jangan lupa password yang telah Anda buat.`
                },
                {
                    filename: `fastarx_backup_${chatId}.enc`,
                    contentType: 'application/octet-stream'
                }
            );

            try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            this.userStates.delete(chatId);

            this.bot.sendMessage(chatId, '✅ *Proses Selesai.* File backup telah dikirim di atas.', { parse_mode: 'Markdown' });

        } catch (error) {
            try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            console.error('❌ Gagal memproses backup:', error);
            this.bot.sendMessage(chatId, `❌ *Gagal memproses backup!*\nTerjadi kesalahan: \`${error.message}\``, { parse_mode: 'Markdown' });
            this.userStates.delete(chatId);
        }
    }

    async processMigrationImportPassword(chatId, password, userState, msg) {
        // Hapus pesan password dari chat demi keamanan
        try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

        const statusMsg = await this.bot.sendMessage(chatId, '⏳ *Sedang mendekripsi dan memulihkan data Anda...*', { parse_mode: 'Markdown' });

        try {
            const dataDir = path.join(projectRoot, 'data');
            const backupData = userState.backupData;

            // Panggil restoreBackup
            backupHelper.restoreBackup(chatId, password, backupData, dataDir);

            try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            this.userStates.delete(chatId);

            // Re-inisialisasi / reload sesi cryptoApp agar memuat data baru secara real-time
            const oldSession = this.userSessions.get(chatId);
            if (oldSession) {
                try {
                    await oldSession.cleanup();
                } catch (e) {
                    console.error('⚠️ Gagal cleanup sesi lama saat impor:', e.message);
                }
            }

            // Inisialisasi ulang sesi baru dengan data yang sudah di-impor
            try {
                const newSession = await this.initializeCryptoApp(chatId);
                this.userSessions.set(chatId, newSession);
            } catch (e) {
                console.error('⚠️ Gagal re-inisialisasi sesi cryptoApp baru setelah impor:', e.message);
            }

            await this.bot.sendMessage(chatId,
                `✅ *IMPOR BERHASIL!*\n\n` +
                `Seluruh data Anda (Wallet, RPC, Port, dan Morse) telah berhasil didekripsi dan dipulihkan ke akun ini.\n\n` +
                `Sesi bot Anda telah disegarkan otomatis.`,
                { parse_mode: 'Markdown' }
            );

        } catch (error) {
            try { await this.bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            
            userState.attempts = (userState.attempts || 0) + 1;
            const remaining = 3 - userState.attempts;

            if (remaining > 0) {
                this.bot.sendMessage(chatId,
                    `❌ *Password Dekripsi Salah!*\n\n` +
                    `Silakan masukkan password yang benar.\n\n` +
                    `_Sisa percobaan: ${remaining} dari 3_`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                this.userStates.delete(chatId);
                this.bot.sendMessage(chatId,
                    `🚫 *Batas Percobaan Habis!*\n\n` +
                    `Anda salah memasukkan password sebanyak 3 kali.\n` +
                    `Proses impor dibatalkan. Silakan unggah kembali file backup Anda jika ingin mencoba lagi.`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    }

    _isMorseCode(content) {
        const trimmed = content.trim();
        if (!trimmed) return false;
        const nonSpaceChars = trimmed.replace(/\s+/g, '');
        if (!nonSpaceChars) return false;
        const morseChars = nonSpaceChars.replace(/[^!*^#~]/g, '');
        return (morseChars.length / nonSpaceChars.length) > 0.9;
    }

    _fetchFileContent(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => { resolve(data); });
                res.on('error', (err) => { reject(err); });
            }).on('error', (err) => { reject(err); });
        });
    }

    // ===================================
    // 📊 TRACKING BOT FLOW (INDEPENDENT)
    // ===================================

    showTrackerMenu(chatId) {
        const state = this.getTrackerState(chatId);
        const wallets = this.getTrackedWallets(chatId);
        const statusText = state.active ? '🟢 AKTIF' : '🔴 NON-AKTIF';
        
        const keyboard = [
            [
                { text: '➕ Tambah Wallet', callback_data: 'tracker_add_wallet' },
                { text: '📋 Daftar Pantauan', callback_data: 'tracker_list_wallets' }
            ],
            [
                { text: '📜 History Tracking', callback_data: 'tracker_history_1' },
                { text: state.active ? '🔴 Hentikan Tracker' : '🟢 Aktifkan Tracker', callback_data: 'tracker_toggle' }
            ],
            [
                { text: '⚙️ Pengaturan', callback_data: 'tracker_settings' },
                { text: '🔙 Kembali', callback_data: 'menu_lainnya' }
            ]
        ];

        this.bot.sendMessage(chatId,
            `📊 *TRACKING BOT (MAINNET)*\n\n` +
            `Status: *${statusText}*\n` +
            `Wallet dipantau: *${wallets.length} wallet*\n\n` +
            `Pelacak ini memantau transaksi token masuk secara real-time pada 16 jaringan mainnet.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    showTrackerListWallets(chatId) {
        const wallets = this.getTrackedWallets(chatId);
        if (wallets.length === 0) {
            const keyboard = [[{ text: '➕ Tambah Wallet', callback_data: 'tracker_add_wallet' }], [{ text: '🔙 Kembali', callback_data: 'tracker_menu' }]];
            this.bot.sendMessage(chatId, `📋 *DAFTAR PANTAUAN*\n\nBelum ada wallet yang dipantau.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
            return;
        }

        let txt = `📋 *DAFTAR PANTAUAN*\n\n`;
        const keyboard = [];
        wallets.forEach((w, idx) => {
            const truncated = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
            txt += `*${idx + 1}. ${w.name}*\n` +
                   `• Address: \`${w.address}\`\n` +
                   `• Jaringan: ${w.networks.map(n => TRACKER_NETWORKS[n]?.name || n).join(', ')}\n\n`;
            
            keyboard.push([{ text: `🗑️ Hapus: ${w.name}`, callback_data: `tracker_del_wallet_${idx}` }]);
        });

        keyboard.push([{ text: '🔙 Kembali', callback_data: 'tracker_menu' }]);

        this.bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }

    async showTrackerHistory(chatId, page = 1) {
        const history = this.getTrackerHistory(chatId);
        const limit = 5;
        const total = history.length;
        const totalPages = Math.ceil(total / limit) || 1;

        if (total === 0) {
            const keyboard = [[{ text: '🔙 Kembali', callback_data: 'tracker_menu' }]];
            this.bot.sendMessage(chatId, `📜 *RIWAYAT TRACKING*\n\nBelum ada transaksi masuk yang terdeteksi.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
            return;
        }

        const startIndex = (page - 1) * limit;
        const pageItems = history.slice(startIndex, startIndex + limit);

        const keyboard = pageItems.map((item, idx) => {
            const absoluteIndex = startIndex + idx;
            const priceText = item.estimatedUsdt && item.estimatedUsdt !== 'Unknown' ? `~$${item.estimatedUsdt}` : '⚠️ $0';
            return [{
                text: `⬇️ ${item.amount} ${item.tokenSymbol} (${priceText}) • ${item.networkName}`,
                callback_data: `tracker_hist_detail_${absoluteIndex}`
            }];
        });

        const navRow = [];
        if (page > 1) {
            navRow.push({ text: '⬅️ Sebelumnya', callback_data: `tracker_history_${page - 1}` });
        }
        if (startIndex + limit < total) {
            navRow.push({ text: 'Berikutnya ➡️', callback_data: `tracker_history_${page + 1}` });
        }
        if (navRow.length > 0) {
            keyboard.push(navRow);
        }

        keyboard.push([{ text: '🔙 Kembali ke Menu', callback_data: 'tracker_menu' }]);

        this.bot.sendMessage(chatId,
            `📜 *RIWAYAT TRACKING (Halaman ${page}/${totalPages})*\n\n` +
            `Pilih transaksi untuk melihat detail lengkap:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    showTrackerHistoryDetail(chatId, index) {
        const history = this.getTrackerHistory(chatId);
        const item = history[index];
        if (!item) {
            this.bot.sendMessage(chatId, `❌ Detail transaksi tidak ditemukan.`);
            this.showTrackerHistory(chatId, 1);
            return;
        }

        const explorerUrl = TRACKER_NETWORKS[item.networkKey]?.explorer ? `${TRACKER_NETWORKS[item.networkKey].explorer}/tx/${item.txHash}` : '';
        const priceVal = item.estimatedUsdt && item.estimatedUsdt !== 'Unknown' ? `*~$${item.estimatedUsdt} USDT*` : `*⚠️ Tidak ada harga — Kemungkinan scam/airdrop*`;

        const keyboard = [];
        if (explorerUrl) {
            keyboard.push([{ text: '🔗 Lihat di Explorer', url: explorerUrl }]);
        }
        keyboard.push([{ text: '🔙 Kembali ke Riwayat', callback_data: 'tracker_history_1' }]);

        const msgText = `📋 *DETAIL TRACKING #${parseInt(index) + 1}*\n\n` +
            `💼 *Wallet:* \`${item.walletName}\` (\`${item.walletAddress.slice(0, 6)}...${item.walletAddress.slice(-4)}\`)\n` +
            `🌐 *Jaringan:* \`${item.networkName}\` (Chain ID: ${TRACKER_NETWORKS[item.networkKey]?.chainId || '-'})\n\n` +
            `🪙 *Token:* ${item.tokenName} (${item.tokenSymbol})\n` +
            `📋 *Kontrak:* \`${item.tokenAddress || 'Native'}\`\n` +
            `🔢 *Jumlah:* \`${item.amount}\` ${item.tokenSymbol}\n` +
            `💵 *Estimasi Saat Masuk:* ${priceVal}\n\n` +
            `👤 *Pengirim:* \`${item.from}\`\n` +
            `📄 *TX Hash:* \`${item.txHash}\`\n` +
            `⏰ *Waktu Terdeteksi:* ${new Date(item.timestamp * 1000).toLocaleString()}`;

        this.bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }

    showTrackerSettings(chatId) {
        const state = this.getTrackerState(chatId);
        if (state.minUsdt === undefined) state.minUsdt = 0;
        if (state.notifyNative === undefined) state.notifyNative = true;
        if (state.notifyErc20 === undefined) state.notifyErc20 = true;
        this.saveTrackerState(chatId, state);

        const keyboard = [
            [
                { text: `Native Alerts: ${state.notifyNative ? '🟢 ON' : '🔴 OFF'}`, callback_data: 'tracker_toggle_native' },
                { text: `ERC20 Alerts: ${state.notifyErc20 ? '🟢 ON' : '🔴 OFF'}`, callback_data: 'tracker_toggle_erc20' }
            ],
            [
                { text: `Filter Min Value: $${state.minUsdt} USDT`, callback_data: 'tracker_min_val_menu' }
            ],
            [
                { text: '🔙 Kembali', callback_data: 'tracker_menu' }
            ]
        ];

        this.bot.sendMessage(chatId,
            `⚙️ *PENGATURAN TRACKER*\n\n` +
            `Atur filter dan jenis notifikasi untuk tracking bot:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    showTrackerMinValMenu(chatId) {
        const keyboard = [
            [
                { text: '$0 (Semua)', callback_data: 'tracker_set_min_0' },
                { text: '$1 USDT', callback_data: 'tracker_set_min_1' },
                { text: '$5 USDT', callback_data: 'tracker_set_min_5' }
            ],
            [
                { text: '$10 USDT', callback_data: 'tracker_set_min_10' },
                { text: '$50 USDT', callback_data: 'tracker_set_min_50' },
                { text: '$100 USDT', callback_data: 'tracker_set_min_100' }
            ],
            [
                { text: '✏️ Input Manual', callback_data: 'tracker_set_min_manual' },
                { text: '🔙 Kembali', callback_data: 'tracker_settings' }
            ]
        ];

        this.bot.sendMessage(chatId,
            `✏️ *PILIH MINIMUM ESTIMASI NILAI USDT*\n\n` +
            `Notifikasi hanya akan dikirim jika estimasi nilai token masuk melebihi nilai filter ini.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async processTrackerAddr(chatId, text, state) {
        const addr = text.trim();
        if (!ethers.isAddress(addr)) {
            this.bot.sendMessage(chatId, '❌ Alamat tidak valid. Silakan kirim ulang alamat publik wallet (0x...):');
            return;
        }
        state.address = addr;
        state.action = 'tracker_awaiting_name';
        this.userStates.set(chatId, state);
        this.bot.sendMessage(chatId, `👁️ *TAMBAH WALLET PEMANTAU (2/3)*\n\nBeri nama panggilan untuk wallet ini (contoh: \`Wallet Utama\`, \`Whale 1\`):`);
    }

    async processTrackerName(chatId, text, state) {
        const name = text.trim();
        if (!name) {
            this.bot.sendMessage(chatId, '❌ Nama tidak boleh kosong. Silakan kirim ulang nama wallet:');
            return;
        }
        state.name = name;
        state.selectedNetworks = [];
        state.action = 'tracker_awaiting_chains';
        this.userStates.set(chatId, state);
        this.showTrackerAddChainsMenu(chatId, state);
    }

    showTrackerAddChainsMenu(chatId, state) {
        const keyboard = [];
        const keys = Object.keys(TRACKER_NETWORKS);
        
        for (let i = 0; i < keys.length; i += 2) {
            const row = [];
            const key1 = keys[i];
            const net1 = TRACKER_NETWORKS[key1];
            const active1 = state.selectedNetworks.includes(key1) ? '✅' : '⬜️';
            row.push({ text: `${active1} ${net1.name}`, callback_data: `tracker_toggle_net_${key1}` });

            if (i + 1 < keys.length) {
                const key2 = keys[i + 1];
                const net2 = TRACKER_NETWORKS[key2];
                const active2 = state.selectedNetworks.includes(key2) ? '✅' : '⬜️';
                row.push({ text: `${active2} ${net2.name}`, callback_data: `tracker_toggle_net_${key2}` });
            }
            keyboard.push(row);
        }

        keyboard.push([
            { text: '🌟 Select All', callback_data: 'tracker_net_all' },
            { text: '❌ Clear All', callback_data: 'tracker_net_clear' }
        ]);
        keyboard.push([{ text: '💾 Simpan & Selesai', callback_data: 'tracker_save_wallet' }]);

        this.bot.sendMessage(chatId,
            `👁️ *TAMBAH WALLET PEMANTAU (3/3)*\n\n` +
            `*Wallet:* \`${state.address}\`\n` +
            `*Nama:* \`${state.name}\`\n\n` +
            `Pilih jaringan yang ingin dipantau:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
    }

    async processTrackerMinVal(chatId, text, state) {
        const val = parseFloat(text.trim());
        if (isNaN(val) || val < 0) {
            this.bot.sendMessage(chatId, '❌ Nilai tidak valid. Kirim angka (contoh: 2.5):');
            return;
        }
        const trackerState = this.getTrackerState(chatId);
        trackerState.minUsdt = val;
        this.saveTrackerState(chatId, trackerState);
        this.userStates.delete(chatId);
        this.bot.sendMessage(chatId, `✅ Filter minimum nilai berhasil diubah menjadi: *$${val} USDT*`, { parse_mode: 'Markdown' });
        this.showTrackerSettings(chatId);
    }

    resumeTrackerPollings() {
        const dir = path.join(projectRoot, 'data');
        if (!fs.existsSync(dir)) return;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (file.endsWith('_tracker_state.json')) {
                    const chatId = file.replace('_tracker_state.json', '');
                    const state = this.getTrackerState(chatId);
                    if (state && state.active) {
                        this.startTrackerPolling(chatId);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to resume tracker pollings:', e);
        }
    }

    startTrackerPolling(chatId) {
        this.stopTrackerPolling(chatId);
        console.log(`Starting tracker polling for chat: ${chatId}`);
        this.runTrackerScan(chatId).catch(console.error);

        const interval = setInterval(() => {
            this.runTrackerScan(chatId).catch(console.error);
        }, 45000);

        this.trackerIntervals.set(chatId, interval);
    }

    stopTrackerPolling(chatId) {
        const active = this.trackerIntervals.get(chatId);
        if (active) {
            clearInterval(active);
            this.trackerIntervals.delete(chatId);
            console.log(`Stopped tracker polling for chat: ${chatId}`);
        }
    }

    _trackerHttpGet(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const fetchUrl = (currentUrl, redirectCount = 0) => {
                if (redirectCount > 5) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                const parsed = new URL(currentUrl);
                const options = {
                    hostname: parsed.hostname,
                    path: parsed.pathname + parsed.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'FastarxBot/1.0',
                        ...headers
                    },
                    timeout: 8000
                };
                const req = https.get(options, (res) => {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        let newUrl = res.headers.location;
                        if (!newUrl.startsWith('http')) {
                            newUrl = parsed.protocol + '//' + parsed.host + newUrl;
                        }
                        fetchUrl(newUrl, redirectCount + 1);
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('error', err => reject(err));
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
            };
            fetchUrl(url);
        });
    }

    async getTokenPriceInUsdt(chainId, tokenAddress, tokenSymbol) {
        try {
            const nativeCgIds = {
                1: 'ethereum',
                56: 'binancecoin',
                137: 'matic-network',
                43114: 'avalanche-2',
                250: 'fantom',
                100: 'xdai',
                42220: 'celo',
                25: 'crypto-com-chain',
                42161: 'ethereum',
                10: 'ethereum',
                8453: 'ethereum',
                59144: 'ethereum',
                324: 'ethereum',
                534352: 'ethereum',
                81457: 'ethereum',
                5000: 'mantle'
            };

            if (!tokenAddress) {
                const cgId = nativeCgIds[chainId];
                if (!cgId) return null;
                const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`;
                const raw = await this._trackerHttpGet(url, { 'User-Agent': 'FastarxBot/1.0' });
                const res = JSON.parse(raw);
                if (res && res[cgId] && res[cgId].usd) {
                    return parseFloat(res[cgId].usd);
                }
                return null;
            }

            const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
            try {
                const dexRaw = await this._trackerHttpGet(dexUrl, { 'User-Agent': 'FastarxBot/1.0' });
                const dexRes = JSON.parse(dexRaw);
                if (dexRes && dexRes.pairs && dexRes.pairs.length > 0) {
                    const price = parseFloat(dexRes.pairs[0].priceUsd);
                    if (!isNaN(price) && price > 0) {
                        return price;
                    }
                }
            } catch (e) {
                console.error(`DexScreener price lookup failed for ${tokenAddress}:`, e);
            }

            const platformIds = {
                1: 'ethereum',
                56: 'binance-smart-chain',
                137: 'polygon-pos',
                43114: 'avalanche',
                250: 'fantom',
                100: 'xdai',
                42220: 'celo',
                25: 'cronos',
                42161: 'arbitrum-one',
                10: 'optimistic-ethereum',
                8453: 'base',
                59144: 'linea',
                324: 'zksync',
                534352: 'scroll',
                81457: 'blast'
            };

            const platform = platformIds[chainId];
            if (platform) {
                const cgUrl = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${tokenAddress}&vs_currencies=usd`;
                try {
                    const cgRaw = await this._trackerHttpGet(cgUrl, { 'User-Agent': 'FastarxBot/1.0' });
                    const cgRes = JSON.parse(cgRaw);
                    const addrLower = tokenAddress.toLowerCase();
                    if (cgRes && cgRes[addrLower] && cgRes[addrLower].usd) {
                        return parseFloat(cgRes[addrLower].usd);
                    }
                } catch (e) {
                    console.error(`CoinGecko fallback lookup failed for ${tokenAddress}:`, e);
                }
            }
        } catch (err) {
            console.error('Failed to get token price:', err);
        }
        return null;
    }

    async runTrackerScan(chatId) {
        try {
            const wallets = this.getTrackedWallets(chatId);
            if (wallets.length === 0) return;

            const state = this.getTrackerState(chatId);
            if (!state.active) return;

            if (!state.lastScannedBlocks) state.lastScannedBlocks = {};
            if (!state.scannedTxHashes) state.scannedTxHashes = [];

            const apiKeys = this.getExplorerApiKeys(chatId);

            for (const wallet of wallets) {
                for (const netKey of wallet.networks) {
                    const net = TRACKER_NETWORKS[netKey];
                    if (!net) continue;

                    let nativeUrl = '';
                    let tokenUrl = '';
                    const walletLower = wallet.address.toLowerCase();

                    if (net.hasFreeApi) {
                        nativeUrl = `${net.apiUrl}?module=account&action=txlist&address=${wallet.address}&page=1&offset=15&sort=desc`;
                        tokenUrl = `${net.apiUrl}?module=account&action=tokentx&address=${wallet.address}&page=1&offset=15&sort=desc`;
                    } else {
                        let key = '';
                        if (netKey === 'bsc') key = apiKeys.bscscan || apiKeys.etherscan || '';
                        else if (netKey === 'optimism') key = apiKeys.etherscan || '';
                        else if (netKey === 'linea') key = apiKeys.etherscan || '';
                        else if (netKey === 'scroll') key = apiKeys.etherscan || '';
                        else if (netKey === 'fantom') key = apiKeys.etherscan || '';
                        else if (netKey === 'cronos') key = apiKeys.etherscan || '';
                        else key = apiKeys.etherscan || '';

                        if (!key) continue;

                        nativeUrl = `${net.apiUrl}?chainid=${net.chainId}&module=account&action=txlist&address=${wallet.address}&page=1&offset=15&sort=desc&apikey=${key}`;
                        tokenUrl = `${net.apiUrl}?chainid=${net.chainId}&module=account&action=tokentx&address=${wallet.address}&page=1&offset=15&sort=desc&apikey=${key}`;
                    }

                    if (state.notifyNative !== false) {
                        try {
                            const raw = await this._trackerHttpGet(nativeUrl);
                            const res = JSON.parse(raw);
                            if (res && res.result && Array.isArray(res.result)) {
                                const newTxs = res.result.filter(tx => 
                                    tx.to && tx.to.toLowerCase() === walletLower && 
                                    !state.scannedTxHashes.includes(tx.hash)
                                );

                                for (const tx of newTxs) {
                                    const valueEth = ethers.formatEther(tx.value);
                                    const valueFloat = parseFloat(valueEth);
                                    if (valueFloat <= 0) continue;

                                    const price = await this.getTokenPriceInUsdt(net.chainId, null, 'ETH');
                                    let estimatedUsdt = 'Unknown';
                                    let filterPass = true;

                                    if (price !== null) {
                                        const usdVal = valueFloat * price;
                                        estimatedUsdt = usdVal.toFixed(2);
                                        if (state.minUsdt && usdVal < state.minUsdt) {
                                            filterPass = false;
                                        }
                                    }

                                    state.scannedTxHashes.push(tx.hash);
                                    if (state.scannedTxHashes.length > 500) {
                                        state.scannedTxHashes.shift();
                                    }

                                    if (filterPass) {
                                        const history = this.getTrackerHistory(chatId);
                                        const symbol = netKey === 'bsc' ? 'BNB' : (netKey === 'polygon' ? 'POL' : (netKey === 'avax' ? 'AVAX' : (netKey === 'fantom' ? 'FTM' : (netKey === 'celo' ? 'CELO' : (netKey === 'mantle' ? 'MNT' : 'ETH')))));
                                        const historyItem = {
                                            txHash: tx.hash,
                                            walletAddress: wallet.address,
                                            walletName: wallet.name,
                                            networkKey: netKey,
                                            networkName: net.name,
                                            tokenSymbol: symbol,
                                            tokenName: 'Native Gas Token',
                                            tokenAddress: '',
                                            amount: valueEth,
                                            estimatedUsdt,
                                            from: tx.from,
                                            timestamp: parseInt(tx.timeStamp) || Math.floor(Date.now() / 1000)
                                        };
                                        history.unshift(historyItem);
                                        if (history.length > 100) history.pop();
                                        this.saveTrackerHistory(chatId, history);

                                        const explorerTxUrl = net.explorer ? `${net.explorer}/tx/${tx.hash}` : '';
                                        const priceText = estimatedUsdt !== 'Unknown' ? `*~$${estimatedUsdt} USDT*` : `*⚠️ Tidak ada harga — Kemungkinan scam/airdrop*`;

                                        let alertText = `🔔 *TOKEN MASUK TERDETEKSI!*\n\n` +
                                            `💼 *Wallet:* \`${wallet.name}\` (\`${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}\`)\n` +
                                            `🌐 *Jaringan:* \`${net.name}\` (Chain ID: ${net.chainId})\n\n` +
                                            `🪙 *Token:* ${symbol} (Native Gas Token)\n` +
                                            `🔢 *Jumlah:* \`${parseFloat(valueEth).toFixed(6)}\` ${symbol}\n` +
                                            `💵 *Estimasi:* ${priceText}\n\n` +
                                            `👤 *Pengirim:* \`${tx.from}\`\n` +
                                            `📄 *TX Hash:* \`${tx.hash}\`\n` +
                                            `⏰ *Waktu:* ${new Date(historyItem.timestamp * 1000).toLocaleString()}`;

                                        const inlineKeyboard = [];
                                        if (explorerTxUrl) {
                                            inlineKeyboard.push([{ text: '🔗 Lihat di Explorer', url: explorerTxUrl }]);
                                        }

                                        await this.bot.sendMessage(chatId, alertText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`Error scanning native txs for ${wallet.address} on ${net.name}:`, err.message);
                        }
                    }

                    if (state.notifyErc20 !== false) {
                        try {
                            const raw = await this._trackerHttpGet(tokenUrl);
                            const res = JSON.parse(raw);
                            if (res && res.result && Array.isArray(res.result)) {
                                const newTxs = res.result.filter(tx => 
                                    tx.to && tx.to.toLowerCase() === walletLower && 
                                    !state.scannedTxHashes.includes(tx.hash)
                                );

                                for (const tx of newTxs) {
                                    const decimals = parseInt(tx.tokenDecimal) || 18;
                                    const amountFormatted = ethers.formatUnits(tx.value, decimals);
                                    const amountFloat = parseFloat(amountFormatted);
                                    if (amountFloat <= 0) continue;

                                    const price = await this.getTokenPriceInUsdt(net.chainId, tx.contractAddress, tx.tokenSymbol);
                                    let estimatedUsdt = 'Unknown';
                                    let filterPass = true;

                                    if (price !== null) {
                                        const usdVal = amountFloat * price;
                                        estimatedUsdt = usdVal.toFixed(2);
                                        if (state.minUsdt && usdVal < state.minUsdt) {
                                            filterPass = false;
                                        }
                                    }

                                    state.scannedTxHashes.push(tx.hash);
                                    if (state.scannedTxHashes.length > 500) {
                                        state.scannedTxHashes.shift();
                                    }

                                    if (filterPass) {
                                        const history = this.getTrackerHistory(chatId);
                                        const historyItem = {
                                            txHash: tx.hash,
                                            walletAddress: wallet.address,
                                            walletName: wallet.name,
                                            networkKey: netKey,
                                            networkName: net.name,
                                            tokenSymbol: tx.tokenSymbol || 'Unknown',
                                            tokenName: tx.tokenName || 'Unknown Token',
                                            tokenAddress: tx.contractAddress,
                                            amount: amountFormatted,
                                            estimatedUsdt,
                                            from: tx.from,
                                            timestamp: parseInt(tx.timeStamp) || Math.floor(Date.now() / 1000)
                                        };
                                        history.unshift(historyItem);
                                        if (history.length > 100) history.pop();
                                        this.saveTrackerHistory(chatId, history);

                                        const explorerTxUrl = net.explorer ? `${net.explorer}/tx/${tx.hash}` : '';
                                        const priceText = estimatedUsdt !== 'Unknown' ? `*~$${estimatedUsdt} USDT*` : `*⚠️ Tidak ada harga — Kemungkinan scam/airdrop*`;

                                        let alertText = `🔔 *TOKEN MASUK TERDETEKSI!*\n\n` +
                                            `💼 *Wallet:* \`${wallet.name}\` (\`${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}\`)\n` +
                                            `🌐 *Jaringan:* \`${net.name}\` (Chain ID: ${net.chainId})\n\n` +
                                            `🪙 *Token:* ${tx.tokenName || 'Unknown'} (${tx.tokenSymbol || 'Unknown'})\n` +
                                            `📋 *Kontrak:* \`${tx.contractAddress}\`\n` +
                                            `🔢 *Jumlah:* \`${parseFloat(amountFormatted).toFixed(6)}\` ${tx.tokenSymbol || ''}\n` +
                                            `💵 *Estimasi:* ${priceText}\n\n` +
                                            `👤 *Pengirim:* \`${tx.from}\`\n` +
                                            `📄 *TX Hash:* \`${tx.hash}\`\n` +
                                            `⏰ *Waktu:* ${new Date(historyItem.timestamp * 1000).toLocaleString()}`;

                                        const inlineKeyboard = [];
                                        if (explorerTxUrl) {
                                            inlineKeyboard.push([{ text: '🔗 Lihat di Explorer', url: explorerTxUrl }]);
                                        }

                                        await this.bot.sendMessage(chatId, alertText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`Error scanning token txs for ${wallet.address} on ${net.name}:`, err.message);
                        }
                    }
                }
            }

            this.saveTrackerState(chatId, state);
        } catch (e) {
            console.error('Error during tracker scan iteration:', e);
        }
    }

}

module.exports = TelegramFullController;
