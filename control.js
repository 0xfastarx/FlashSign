// controller.js (v3.7 - Full Fix)

const path = require('path');
const fs = require('fs');

// --- ENTRY POINT BYPASS UNTUK BINARY PKG ---
if (process.argv.includes('--run-bot-utama') || process.env.RUN_BOT_MODE === 'utama') {
    require('./main.js');
    return;
}
if (process.argv.includes('--run-bot-auto') || process.env.RUN_BOT_MODE === 'auto') {
    process.chdir(path.join(__dirname, 'auto'));
    require('./main.js');
    return;
}

const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const crypto = require('crypto');
const si = require('systeminformation');

const isPkg = typeof process.pkg !== 'undefined';
const projectRoot = isPkg ? path.dirname(process.execPath) : __dirname;

let server;

// --- CEK FILE .env ---
const envPath = path.join(projectRoot, 'security', '.env');
if (!fs.existsSync(envPath)) {
    console.error('❌ FATAL: File .env tidak ditemukan di folder security/!');
    console.error('Harap jalankan "node setup.js" terlebih dahulu.');
    process.exit(1);
}

dotenv.config({ path: envPath });
console.log('ℹ️ File .env dimuat oleh Controller.');

const integrityGuard = require('./core/integrityGuard');

// ===================================
// == ENV DECRYPTOR ==
// ===================================
class EnvDecryptor {
    constructor() {
        this.configKey = this.generateConfigKey();
    }
    generateConfigKey() {
        const liveHash = integrityGuard.calculateProjectHash();
        return crypto.pbkdf2Sync(
            'FASTARX_CONFIG_KEY_2024' + liveHash,
            'CONFIG_SALT_2024',
            50000, 32, 'sha256'
        );
    }
    decryptValue(encryptedValue) {
        if (!encryptedValue) return null;
        const parts = encryptedValue.split(':');
        if (parts.length !== 2) return null;

        const encryptedData = parts[0];
        const iv = Buffer.from(parts[1], 'hex');

        // Coba 1: Menggunakan liveHash (configKey default)
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', this.configKey, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {}

        // Coba 2: Menggunakan approvedHash (jika file termodifikasi dan belum diverifikasi)
        try {
            const approvedHash = integrityGuard.getApprovedHash() || '';
            const key = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024' + approvedHash,
                'CONFIG_SALT_2024',
                50000, 32, 'sha256'
            );
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {}

        // Coba 3: Menggunakan static key (pasca setup.js dijalankan)
        try {
            const staticKey = crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
            const decipher = crypto.createDecipheriv('aes-256-cbc', staticKey, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error(`DECRYPTION FAILED: ${error.message}`);
            return null;
        }
    }
}

// ===================================
// == DYNAMIC ENV CRYPTOGRAPHY & HELPERS ==
// ===================================

function getDynamicConfigKey() {
    const approvedHash = integrityGuard.getApprovedHash() || '';
    return crypto.pbkdf2Sync(
        'FASTARX_CONFIG_KEY_2024' + approvedHash,
        'CONFIG_SALT_2024',
        50000, 32, 'sha256'
    );
}

function decryptValue(encryptedValue) {
    if (!encryptedValue) return null;
    try {
        const parts = encryptedValue.split(':');
        if (parts.length !== 2) throw new Error('Format tidak valid.');
        const encryptedData = parts[0];
        const iv = Buffer.from(parts[1], 'hex');
        const key = getDynamicConfigKey();
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        // Fallback ke static key
        try {
            const staticKey = crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
            const parts = encryptedValue.split(':');
            const decipher = crypto.createDecipheriv('aes-256-cbc', staticKey, Buffer.from(parts[1], 'hex'));
            let decrypted = decipher.update(parts[0], 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            console.error(`DECRYPTION FAILED: ${error.message}`);
            return null;
        }
    }
}

function encryptValue(plaintext) {
    if (!plaintext) return null;
    try {
        const iv = crypto.randomBytes(16);
        const key = getDynamicConfigKey();
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(plaintext, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return `${encrypted}:${iv.toString('hex')}`;
    } catch (error) {
        console.error(`ENCRYPTION FAILED: ${error.message}`);
        return null;
    }
}

function readEnvField(envContent, fieldName) {
    const match = envContent.match(new RegExp(`^${fieldName}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
    return match ? match[1] : null;
}

function updateEnvField(key, value) {
    const envPath = path.join(projectRoot, 'security', '.env');
    if (!fs.existsSync(envPath)) return false;
    try {
        let content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split(/\r?\n/);
        let found = false;
        const updatedLines = lines.map(line => {
            if (line.trim().startsWith(key + '=')) {
                found = true;
                return `${key}="${value}"`;
            }
            return line;
        });

        if (!found) {
            updatedLines.push(`${key}="${value}"`);
        }

        fs.writeFileSync(envPath, updatedLines.join('\n'), 'utf8');
        return true;
    } catch (e) {
        console.error(`Gagal mengupdate ${key} di .env:`, e.message);
        return false;
    }
}

function getEnvFieldPreview(fieldName) {
    const envPath = path.join(projectRoot, 'security', '.env');
    if (!fs.existsSync(envPath)) return 'Tidak ditemukan';
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        const encrypted = readEnvField(content, fieldName);
        if (!encrypted) return 'Belum diatur';
        const decrypted = decryptValue(encrypted);
        if (!decrypted) return 'Gagal dekripsi';
        if (fieldName.includes('PASSWORD') || fieldName.includes('TOKEN') || fieldName.includes('SECRET') || fieldName.includes('GITHUB')) {
            if (fieldName.includes('GITHUB')) {
                const parts = decrypted.split('/');
                const fileName = parts[parts.length - 1] || 'json';
                return `•••••••• (File: ${fileName})`;
            }
            return `•••••••• (Terakhir: ${decrypted.slice(-4)})`;
        }
        return decrypted;
    } catch (e) {
        return 'Error';
    }
}

// --- TOTP inline (RFC 6238) ---
function base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const output = [];
    const input = base32.replace(/=+$/, '').toUpperCase();
    for (const char of input) {
        const idx = alphabet.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) { output.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(output);
}

function verifyTOTP(secret, token, window = 1) {
    try {
        const counter = Math.floor(Date.now() / 1000 / 30);
        const key = base32Decode(secret);
        for (let delta = -window; delta <= window; delta++) {
            const c = counter + delta;
            const buf = Buffer.alloc(8);
            let tmp = c;
            for (let i = 7; i >= 0; i--) { buf[i] = tmp & 0xff; tmp = Math.floor(tmp / 256); }
            const hmac = crypto.createHmac('sha1', key).update(buf).digest();
            const offset = hmac[hmac.length - 1] & 0x0f;
            const code = (
                ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
                (hmac[offset + 2] << 8) | hmac[offset + 3]
            ) % 1000000;
            if (code.toString().padStart(6, '0') === token.toString()) return true;
        }
    } catch (e) {}
    return false;
}

function base32Encode(buffer) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0, output = '';
    for (let i = 0; i < buffer.length; i++) {
        value = (value << 8) | buffer[i];
        bits += 8;
        while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    while (output.length % 8) output += '=';
    return output;
}

function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

// ==========================================================
// == LOAD KONFIGURASI DARI .env ==
// ==========================================================

let TOKEN_CONTROLLER;
let ADMIN_CHAT_ID;

try {
    console.log('🔒 Memuat konfigurasi Controller dari .env...');
    const envDecryptor = new EnvDecryptor();

    // [FIX #1] ADMIN_CHAT_ID juga terenkripsi oleh setup.js
    // Harus pakai ADMIN_CHAT_ID_ENCRYPTED, bukan ADMIN_CHAT_ID
    TOKEN_CONTROLLER = envDecryptor.decryptValue(process.env.CONTROLLER_BOT_TOKEN_ENCRYPTED);
    const adminChatIdStr = envDecryptor.decryptValue(process.env.ADMIN_CHAT_ID_ENCRYPTED);
    ADMIN_CHAT_ID = parseInt(adminChatIdStr, 10);

    if (!TOKEN_CONTROLLER) {
        throw new Error('Gagal mendekripsi CONTROLLER_BOT_TOKEN_ENCRYPTED.');
    }
    if (!adminChatIdStr || isNaN(ADMIN_CHAT_ID)) {
        throw new Error('Gagal mendekripsi ADMIN_CHAT_ID_ENCRYPTED atau nilainya tidak valid.');
    }

    console.log('✅ Konfigurasi Controller berhasil dimuat.');
    console.log(`   └─ Admin Chat ID: ${ADMIN_CHAT_ID}`);

} catch (error) {
    console.error('❌ FATAL: Gagal memuat konfigurasi dari .env.');
    console.error(error.message);
    process.exit(1);
}

// ==========================================================
// == KONFIGURASI BOT ==
// == Menjalankan 'node main.js' langsung (tanpa npm)
// ==========================================================

const botConfigs = {
    'utama': {
        name: 'Bot Utama',
        command: isPkg ? process.execPath : 'node',
        args: isPkg ? ['--run-bot-utama'] : ['main.js'],
        cwd: projectRoot
    },
    'auto': {
        name: 'Bot Kedua',
        command: isPkg ? process.execPath : 'node',
        args: isPkg ? ['--run-bot-auto'] : ['main.js'],
        cwd: path.join(projectRoot, 'auto')
    }
};

let runningBots = {};

// ==========================================================
// == INISIALISASI BOT CONTROLLER ==
// ==========================================================

const bot = new TelegramBot(TOKEN_CONTROLLER, { polling: true });


// ==========================================================
// == USER MANAGER
// == Menyimpan data user di users.json (plain JSON)
// == Format: { chatId: { username, firstName, joinedAt, expiredAt, status, note } }
// ==========================================================

const USERS_FILE = path.join(projectRoot, 'data', 'users.json');

// Pastikan folder data ada
if (!fs.existsSync(path.join(projectRoot, 'data'))) {
    fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
}

class UserManager {
    constructor() {
        this.users = this._load();
        this._migrate();  // Auto-migrasi field yang kurang
    }

    // Tambah field baru ke user lama yang belum punya
    _migrate() {
        let changed = false;
        for (const id in this.users) {
            const u = this.users[id];
            if (typeof u.loginCount === 'undefined') {
                u.loginCount = 1;
                changed = true;
            }
            if (!Array.isArray(u.loginHistory)) {
                // Pakai joinedAt sebagai login pertama kalau ada
                u.loginHistory = u.joinedAt ? [u.joinedAt] : [];
                changed = true;
            }
        }
        if (changed) {
            this._save();
            console.log('[UserManager] Migrasi data users.json selesai.');
        }
    }

    _load() {
        try {
            if (!fs.existsSync(USERS_FILE)) return {};
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } catch (e) {
            console.error('[UserManager] Gagal load users.json:', e.message);
            return {};
        }
    }

    _save() {
        try {
            fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
        } catch (e) {
            console.error('[UserManager] Gagal simpan users.json:', e.message);
        }
    }

    // Daftarkan atau update user saat /start
    registerOrUpdate(chatId, username, firstName) {
        const id = String(chatId);
        const isNew = !this.users[id];
        const now = new Date().toISOString();

        if (isNew) {
            this.users[id] = {
                username: username || '',
                firstName: firstName || '',
                joinedAt: now,
                expiredAt: null,       // null = tidak ada batas
                status: 'aktif',       // aktif | blokir
                note: '',
                loginCount: 1,
                loginHistory: [now]    // simpan 5 terakhir
            };
        } else {
            // Update info terbaru tapi jangan timpa status/expiredAt
            this.users[id].username = username || this.users[id].username;
            this.users[id].firstName = firstName || this.users[id].firstName;

            // Catat login
            this.users[id].loginCount = (this.users[id].loginCount || 0) + 1;
            if (!Array.isArray(this.users[id].loginHistory)) {
                this.users[id].loginHistory = [];
            }
            this.users[id].loginHistory.push(now);
            // Simpan hanya 5 terakhir
            if (this.users[id].loginHistory.length > 5) {
                this.users[id].loginHistory = this.users[id].loginHistory.slice(-5);
            }
        }

        this._save();
        return { isNew, user: this.users[id] };
    }

    getUser(chatId) {
        return this.users[String(chatId)] || null;
    }

    getAllUsers() {
        return this.users;
    }

    // Cek apakah user boleh akses
    // Return: { allowed: bool, reason: string }
    checkAccess(chatId) {
        const id = String(chatId);
        const user = this.users[id];

        if (!user) return { allowed: false, reason: 'not_found' };
        if (user.status === 'blokir') return { allowed: false, reason: 'blocked' };

        // Cek masa aktif
        if (user.expiredAt) {
            const now = new Date();
            const exp = new Date(user.expiredAt);
            if (now > exp) {
                // Auto-blokir
                this.users[id].status = 'blokir';
                this._save();
                return { allowed: false, reason: 'expired' };
            }
        }

        return { allowed: true, reason: 'ok' };
    }

    // Set masa aktif: jumlah hari dari SEKARANG
    setExpiry(chatId, days) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        const exp = new Date();
        exp.setDate(exp.getDate() + days);
        this.users[id].expiredAt = exp.toISOString();
        this._save();
        return true;
    }

    // Hapus masa aktif (bebas selamanya)
    removeExpiry(chatId) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        this.users[id].expiredAt = null;
        this._save();
        return true;
    }

    // Blokir user
    block(chatId) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        this.users[id].status = 'blokir';
        this._save();
        return true;
    }

    // Unblokir user
    unblock(chatId) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        this.users[id].status = 'aktif';
        // Hapus expiredAt kalau sudah lewat biar bisa akses lagi
        if (this.users[id].expiredAt && new Date() > new Date(this.users[id].expiredAt)) {
            this.users[id].expiredAt = null;
        }
        this._save();
        return true;
    }

    // Hapus user
    remove(chatId) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        delete this.users[id];
        this._save();
        return true;
    }

    // Set catatan
    setNote(chatId, note) {
        const id = String(chatId);
        if (!this.users[id]) return false;
        this.users[id].note = note;
        this._save();
        return true;
    }

    // Format sisa hari
    formatExpiry(expiredAt) {
        if (!expiredAt) return '♾️ Tidak ada batas';
        const now = new Date();
        const exp = new Date(expiredAt);
        const diff = exp - now;
        if (diff <= 0) return '⛔ Sudah expired';
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        if (days > 0) return `⏳ ${days} hari ${hours} jam lagi`;
        if (hours > 0) return `⏳ ${hours} jam ${mins} menit lagi`;
        return `⏳ ${mins} menit lagi`;
    }

    // Format tanggal
    formatDate(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}

const userManager = new UserManager();

// Cek expired secara berkala setiap 1 jam
setInterval(() => {
    const users = userManager.getAllUsers();
    for (const id in users) {
        const u = users[id];
        if (u.status === 'aktif' && u.expiredAt && new Date() > new Date(u.expiredAt)) {
            userManager.block(id);
            console.log(`[UserManager] User ${id} (${u.firstName}) otomatis diblokir karena expired.`);
        }
    }
}, 60 * 60 * 1000);

console.log('🤖 Bot Controller (Saklar) Aktif...');
console.log(`Hanya merespon perintah dari Admin ID: ${ADMIN_CHAT_ID}`);

// Fetch username admin saat start — dipakai untuk notif ke user
let ADMIN_USERNAME = null;
bot.getChat(ADMIN_CHAT_ID).then(chat => {
    if (chat.username) {
        ADMIN_USERNAME = chat.username;
        console.log(`✅ Admin username: @${ADMIN_USERNAME}`);
    } else {
        ADMIN_USERNAME = null;
        console.log(`ℹ️  Admin tidak punya username, akan tampilkan nama saja.`);
    }
}).catch(e => {
    console.warn(`⚠️  Gagal fetch info admin: ${e.message}`);
});

// Format kontak admin untuk notif ke user
function getAdminContact() {
    if (ADMIN_USERNAME) return `👤 Hubungi admin: @${ADMIN_USERNAME}`;
    return `👤 Hubungi admin untuk informasi lebih lanjut.`;
}

// ==========================================================
// == STATE PENGATURAN .env ==
// ==========================================================
const pendingEnvEdit = new Map(); // chatId -> { field }
const pending2faSetup = new Map(); // chatId -> { secret }
let pendingOtpRequest = null; // { res, timeout }

const ENV_FIELDS_MAP = {
    'GITHUB_MAIN_URL_ENCRYPTED': 'GitHub Main URL',
    'GITHUB_BACKUP_URL_ENCRYPTED': 'GitHub Backup URL',
    'OWNER_TELEGRAM_ID_ENCRYPTED': 'Owner Telegram ID',
    'ADMIN_CHAT_ID_ENCRYPTED': 'Admin Chat ID',
    'TELEGRAM_BOT_TOKEN_ENCRYPTED': 'Token Bot Utama',
    'CONTROLLER_BOT_TOKEN_ENCRYPTED': 'Token Controller Bot',
    'ADMIN_PASSWORD_ENCRYPTED': 'Password Admin',
    'SCRIPT_PASSWORD_ENCRYPTED': 'Password Script'
};

let restartTimer = null;

function scheduleAutoRestart(chatId) {
    if (restartTimer) {
        clearTimeout(restartTimer);
    }
    
    bot.sendMessage(chatId, '🔄 *Notifikasi:* Perubahan konfigurasi terdeteksi. Bot Saklar akan otomatis restart dalam *60 detik* untuk menerapkan konfigurasi baru.', { parse_mode: 'Markdown' }).catch(() => {});
    
    restartTimer = setTimeout(async () => {
        bot.sendMessage(chatId, '🔄 *Restarting...* Memulai ulang Bot Saklar sekarang.', { parse_mode: 'Markdown' })
            .catch(() => {})
            .finally(async () => {
                console.log('🔄 Melakukan restart otomatis...');
                
                try {
                    await bot.stopPolling();
                    console.log('✅ Polling Telegram dihentikan.');
                } catch (e) {
                    console.error('Gagal menghentikan polling:', e.message);
                }

                const spawnAndExit = () => {
                    const spawn = require('child_process').spawn;
                    const cleanEnv = { ...process.env };
                    
                    // Hapus semua key dari process.env yang ada di file .env 
                    // agar dotenv pada proses baru membaca ulang nilai terbaru dari file disk.
                    try {
                        const envPath = path.join(projectRoot, 'security', '.env');
                        if (fs.existsSync(envPath)) {
                            const envContent = fs.readFileSync(envPath, 'utf8');
                            const lines = envContent.split(/\r?\n/);
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                                    const key = trimmed.split('=')[0].trim();
                                    if (key) {
                                        delete cleanEnv[key];
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error('⚠️ Gagal membersihkan environment variables:', err.message);
                    }

                    const child = spawn(process.argv[0], process.argv.slice(1), {
                        detached: true,
                        stdio: 'inherit',
                        env: cleanEnv
                    });
                    child.unref();
                    process.exit(0);
                };

                if (server) {
                    server.close(() => {
                        console.log('✅ HTTP Server ditutup, port dilepas.');
                        spawnAndExit();
                    });

                    // Fallback exit setelah 3 detik jika ada koneksi gantung
                    setTimeout(() => {
                        console.log('⚠️ HTTP Server close timeout. Force exit...');
                        spawnAndExit();
                    }, 3000);
                } else {
                    spawnAndExit();
                }
            });
    }, 60000);
}

function sendEnvMenu(chatId) {
    const text = `⚙️ *PENGATURAN .env*
    
Pilih variabel konfigurasi yang ingin Anda ubah:

1. *GitHub Main:* \`${getEnvFieldPreview('GITHUB_MAIN_URL_ENCRYPTED')}\`
2. *GitHub Backup:* \`${getEnvFieldPreview('GITHUB_BACKUP_URL_ENCRYPTED')}\`
3. *Owner TG ID:* \`${getEnvFieldPreview('OWNER_TELEGRAM_ID_ENCRYPTED')}\`
4. *Admin Chat ID:* \`${getEnvFieldPreview('ADMIN_CHAT_ID_ENCRYPTED')}\`
5. *Token Bot Utama:* \`${getEnvFieldPreview('TELEGRAM_BOT_TOKEN_ENCRYPTED')}\`
6. *Token Controller:* \`${getEnvFieldPreview('CONTROLLER_BOT_TOKEN_ENCRYPTED')}\`
7. *Password Admin:* \`${getEnvFieldPreview('ADMIN_PASSWORD_ENCRYPTED')}\`
8. *Password Script:* \`${getEnvFieldPreview('SCRIPT_PASSWORD_ENCRYPTED')}\`
9. *Setup 2FA:* \`${getEnvFieldPreview('SETUP_2FA_SECRET_ENCRYPTED')}\``;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Github Main', callback_data: 'env_edit:GITHUB_MAIN_URL_ENCRYPTED' },
                    { text: '🌐 Github Backup', callback_data: 'env_edit:GITHUB_BACKUP_URL_ENCRYPTED' }
                ],
                [
                    { text: '👤 Owner TG ID', callback_data: 'env_edit:OWNER_TELEGRAM_ID_ENCRYPTED' },
                    { text: '🆔 Admin Chat ID', callback_data: 'env_edit:ADMIN_CHAT_ID_ENCRYPTED' }
                ],
                [
                    { text: '🤖 Token Utama', callback_data: 'env_edit:TELEGRAM_BOT_TOKEN_ENCRYPTED' },
                    { text: '🔌 Token Controller', callback_data: 'env_edit:CONTROLLER_BOT_TOKEN_ENCRYPTED' }
                ],
                [
                    { text: '🔑 Pass Admin', callback_data: 'env_edit:ADMIN_PASSWORD_ENCRYPTED' },
                    { text: '🔑 Pass Script', callback_data: 'env_edit:SCRIPT_PASSWORD_ENCRYPTED' }
                ],
                [
                    { text: '🔄 Reset 2FA (Authenticator)', callback_data: 'env_reset_2fa' }
                ],
                [{ text: '« Kembali ke Menu Utama', callback_data: 'menu_main' }]
            ]
        }
    };
    bot.sendMessage(chatId, text, { ...opts, parse_mode: 'Markdown' }).catch((err) => {
        console.warn('Gagal kirim menu .env:', err.message);
    });
}

function startEnvEditFlow(chatId, field) {
    const fieldName = ENV_FIELDS_MAP[field];
    if (!fieldName) return;
    
    pendingEnvEdit.set(chatId, { field });
    bot.sendMessage(chatId, `📝 *Edit ${fieldName}*

Silakan kirimkan nilai baru untuk *${fieldName}*:
_(Ketik /batal untuk membatalkan)_`, { parse_mode: 'Markdown' }).catch(() => {});
}

function handleEnvEditInput(chatId, field, value) {
    const fieldName = ENV_FIELDS_MAP[field];
    
    // Validasi
    if (field === 'ADMIN_CHAT_ID_ENCRYPTED' || field === 'OWNER_TELEGRAM_ID_ENCRYPTED') {
        if (!/^\d+$/.test(value)) {
            bot.sendMessage(chatId, '❌ Input harus berupa angka. Silakan kirim ulang atau ketik /batal:').catch(() => {});
            return;
        }
    }
    if (field === 'ADMIN_PASSWORD_ENCRYPTED' || field === 'SCRIPT_PASSWORD_ENCRYPTED') {
        if (value.length < 4) {
            bot.sendMessage(chatId, '❌ Password minimal harus 4 karakter. Silakan kirim ulang atau ketik /batal:').catch(() => {});
            return;
        }
    }

    pendingEnvEdit.delete(chatId);
    
    const encryptedValue = encryptValue(value);
    if (!encryptedValue) {
        bot.sendMessage(chatId, '❌ Gagal mengenkripsi nilai baru. Aksi dibatalkan.').catch(() => {});
        sendEnvMenu(chatId);
        return;
    }

    const ok = updateEnvField(field, encryptedValue);
    if (ok) {
        let note = '';
        if (field === 'CONTROLLER_BOT_TOKEN_ENCRYPTED' || field === 'ADMIN_CHAT_ID_ENCRYPTED') {
            note = '\n\n*⚠️ Catatan:* Perubahan Token Controller atau Admin Chat ID akan aktif setelah Controller Bot di-restart.';
        }
        bot.sendMessage(chatId, `✅ *${fieldName}* berhasil diperbarui di file .env!${note}`, { parse_mode: 'Markdown' }).catch(() => {});
        scheduleAutoRestart(chatId);
    } else {
        bot.sendMessage(chatId, '❌ Gagal mengupdate file .env.').catch(() => {});
    }
    
    setTimeout(() => sendEnvMenu(chatId), 1000);
}

function start2faResetFlow(chatId) {
    const newSecret = generateSecret();
    const uri = `otpauth://totp/Fastarx%20Bot%20-%20Setup:Admin?secret=${newSecret}&issuer=Fastarx%20Bot%20-%20Setup&algorithm=SHA1&digits=6&period=30`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;

    pending2faSetup.set(chatId, { secret: newSecret });

    const text = `📱 *SETUP 2FA BARU*

Buka Google Authenticator / Authy di HP Anda.
Tambahkan akun baru dengan detail berikut:

🔑 *Secret:* \`${newSecret}\`

Atau scan QR Code di bawah ini:
[Klik link ini untuk melihat QR Code](${qrUrl})

*Konfirmasi:* Silakan masukkan kode 6-digit OTP dari Authenticator Anda untuk mengaktifkan 2FA baru ini.
_(Ketik /batal untuk membatalkan)_`;

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});
}

function handle2faSetupConfirm(chatId, secret, otpCode) {
    if (!verifyTOTP(secret, otpCode)) {
        bot.sendMessage(chatId, '❌ Kode OTP salah. Silakan coba lagi atau ketik /batal untuk membatalkan:').catch(() => {});
        return;
    }

    pending2faSetup.delete(chatId);
    
    const encryptedSecret = encryptValue(secret);
    if (!encryptedSecret) {
        bot.sendMessage(chatId, '❌ Gagal mengenkripsi 2FA Secret. Aksi dibatalkan.').catch(() => {});
        sendEnvMenu(chatId);
        return;
    }

    const ok = updateEnvField('SETUP_2FA_SECRET_ENCRYPTED', encryptedSecret);
    if (ok) {
        bot.sendMessage(chatId, '✅ *Setup 2FA* berhasil diperbarui dan aktif!').catch(() => {});
        scheduleAutoRestart(chatId);
    } else {
        bot.sendMessage(chatId, '❌ Gagal menyimpan 2FA Secret baru ke file .env.').catch(() => {});
    }
    
    setTimeout(() => sendEnvMenu(chatId), 1000);
}

function handleStartupOtpInput(chatId, otpCode) {
    if (!pendingOtpRequest) return;
    
    // Dapatkan secret 2FA
    const approvedHash = integrityGuard.getApprovedHash() || '';
    const envContent = fs.readFileSync(path.join(projectRoot, 'security', '.env'), 'utf8');
    const setup2FAEncrypted = readEnvField(envContent, 'SETUP_2FA_SECRET_ENCRYPTED');

    let secret = null;
    if (setup2FAEncrypted) {
        secret = decryptValue(setup2FAEncrypted);
    }

    if (secret) {
        if (verifyTOTP(secret, otpCode)) {
            bot.sendMessage(chatId, '✅ *OTP Terverifikasi!* Startup Bot Utama disetujui.', { parse_mode: 'Markdown' }).catch(() => {});
            
            const responseObj = pendingOtpRequest.res;
            clearTimeout(pendingOtpRequest.timeout);
            pendingOtpRequest = null;

            responseObj.writeHead(200);
            responseObj.end(JSON.stringify({ verified: true }));
        } else {
            bot.sendMessage(chatId, '❌ *OTP Salah.* Silakan coba lagi.').catch(() => {});
        }
    } else {
        bot.sendMessage(chatId, '⚠️ 2FA belum dikonfigurasi di file .env Anda.').catch(() => {});
        
        const responseObj = pendingOtpRequest.res;
        clearTimeout(pendingOtpRequest.timeout);
        pendingOtpRequest = null;

        responseObj.writeHead(200);
        responseObj.end(JSON.stringify({ verified: false, reason: '2fa_not_configured' }));
    }
}

// ==========================================================
// == FUNGSI MENU ==
// ==========================================================

function sendMainMenu(chatId, text = 'Pilih bot yang ingin Anda kontrol:') {
    const statusIconUtama = runningBots['utama'] ? '🟢' : '🔴';
    const statusIconAuto = runningBots['auto'] ? '🟢' : '🔴';
    const totalUsers = Object.keys(userManager.getAllUsers()).length;
    const blockedUsers = Object.values(userManager.getAllUsers()).filter(u => u.status === 'blokir').length;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: `${statusIconUtama} ${botConfigs.utama.name}`, callback_data: 'menu_bot:utama' }],
                [{ text: `${statusIconAuto} ${botConfigs.auto.name}`, callback_data: 'menu_bot:auto' }],
                [
                    { text: '📊 Cek Status Bot', callback_data: 'status_all' },
                    { text: '🖥️ Cek Status VPS', callback_data: 'status_vps' }
                ],
                [{ text: `👥 Kelola User (${totalUsers} user, ${blockedUsers} blokir)`, callback_data: 'user_menu' }],
                [{ text: `⚙️ Pengaturan .env`, callback_data: 'env_menu' }]
            ]
        }
    };
    bot.sendMessage(chatId, text, opts).catch((err) => {
        console.warn('Gagal kirim menu:', err.message);
    });
}

function sendBotMenu(chatId, botId, textPrefix = '') {
    const config = botConfigs[botId];
    if (!config) {
        sendMainMenu(chatId, 'Error: Bot tidak dikenal.');
        return;
    }
    const statusText = runningBots[botId] ? 'Berjalan' : 'Mati';
    const messageText = `${textPrefix}Kontrol untuk: *${config.name}*\nStatus saat ini: *${statusText}*`;
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `▶️ Aktifkan`, callback_data: `start_bot:${botId}` },
                    { text: `⏹️ Nonaktifkan`, callback_data: `stop_bot:${botId}` }
                ],
                [{ text: `🔄 Refresh Status`, callback_data: `status_bot:${botId}` }],
                [{ text: '« Kembali ke Menu Utama', callback_data: 'menu_main' }]
            ]
        }
    };
    bot.sendMessage(chatId, messageText, { ...opts, parse_mode: 'Markdown' }).catch((err) => {
        console.warn('Gagal kirim sub-menu:', err.message);
    });
}

// ==========================================================
// == HANDLER PERINTAH & TOMBOL ==
// ==========================================================

bot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) {
        bot.sendMessage(msg.chat.id, 'Anda tidak diizinkan menggunakan bot ini.');
        return;
    }
    sendMainMenu(msg.chat.id);
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_CHAT_ID) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Aksi ditolak.', show_alert: true }).catch(() => { });
        return;
    }

    // [FIX #6] Jawab callback SEGERA sebelum proses apapun
    // Mencegah error "query is too old / query ID is invalid"
    bot.answerCallbackQuery(callbackQuery.id).catch(() => { });

    if (data !== 'status_vps') {
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
    }

    const [action, botId] = data.split(':');

    switch (action) {
        case 'menu_main':
            sendMainMenu(chatId);
            break;
        case 'env_menu':
            sendEnvMenu(chatId);
            break;
        case 'env_edit':
            startEnvEditFlow(chatId, botId);
            break;
        case 'env_reset_2fa':
            start2faResetFlow(chatId);
            break;
        case 'menu_bot':
            sendBotMenu(chatId, botId);
            break;
        case 'start_bot':
            startBotProcess(chatId, botId);
            setTimeout(() => sendMainMenu(chatId, 'Perintah aktivasi dikirim...'), 1500);
            break;
        case 'stop_bot':
            stopBotProcess(chatId, botId);
            setTimeout(() => sendMainMenu(chatId, 'Perintah nonaktif dikirim...'), 1500);
            break;
        case 'status_bot': {
            // [FIX #4] Block scope {} agar const tidak konflik antar case
            const statusMsg = checkBotStatus(botId);
            sendBotMenu(chatId, botId, `${statusMsg}\n\n`);
            break;
        }
        case 'status_all': {
            // [FIX #4] Block scope {}
            const allStatusMsg = checkAllBotStatus();
            sendMainMenu(chatId, allStatusMsg);
            break;
        }
        case 'status_vps':
            await checkVpsStatus(chatId);
            break;

        // ── USER MANAGEMENT ──
        case 'user_menu':
            sendUserMenu(chatId);
            break;
        case 'user_list': {
            const page = parseInt(botId) || 0;
            sendUserList(chatId, page);
            break;
        }
        case 'user_detail':
            sendUserDetail(chatId, botId);
            break;
        case 'user_blokir':
            sendBlockedUsers(chatId);
            break;
        case 'user_expiring':
            sendExpiringUsers(chatId);
            break;
        case 'user_block': {
            const ok = userManager.block(botId);
            bot.sendMessage(chatId, ok ? `✅ User \`${botId}\` berhasil diblokir.` : `❌ User tidak ditemukan.`, { parse_mode: 'Markdown' }).catch(() => { });
            // Kirim notif ke user yang diblokir
            bot.sendMessage(parseInt(botId),
                `🚫 *Akses Anda telah diblokir.*\n\n${getAdminContact()}`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            setTimeout(() => sendUserDetail(chatId, botId), 500);
            break;
        }
        case 'user_unblock': {
            const ok = userManager.unblock(botId);
            bot.sendMessage(chatId, ok ? `✅ User \`${botId}\` berhasil dibuka blokirnya.` : `❌ User tidak ditemukan.`, { parse_mode: 'Markdown' }).catch(() => { });
            // Kirim notif ke user
            bot.sendMessage(parseInt(botId),
                `✅ *Akses Anda telah dipulihkan!*\n\nKetuk /start untuk mulai menggunakan bot.\n\n${getAdminContact()}`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            setTimeout(() => sendUserDetail(chatId, botId), 500);
            break;
        }
        case 'user_removeexp': {
            const ok = userManager.removeExpiry(botId);
            bot.sendMessage(chatId, ok ? `✅ Masa aktif user \`${botId}\` dihapus (bebas selamanya).` : `❌ User tidak ditemukan.`, { parse_mode: 'Markdown' }).catch(() => { });
            // Notif ke user
            bot.sendMessage(parseInt(botId),
                `✅ *Masa aktif akun Anda telah dihapus.*\nAnda bisa menggunakan bot tanpa batas waktu.\n\n${getAdminContact()}`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            setTimeout(() => sendUserDetail(chatId, botId), 500);
            break;
        }
        case 'user_setexp': {
            // Minta admin input jumlah hari
            pendingExpiry.set(chatId, botId);
            bot.sendMessage(chatId,
                `⏰ *Set Masa Aktif untuk* \`${botId}\`\n\nKirim jumlah hari (angka):\nContoh: \`7\` untuk 7 hari, \`30\` untuk 30 hari`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '1 hari', callback_data: `user_setexp_days:${botId}:1` },
                                { text: '3 hari', callback_data: `user_setexp_days:${botId}:3` },
                                { text: '7 hari', callback_data: `user_setexp_days:${botId}:7` }
                            ],
                            [
                                { text: '14 hari', callback_data: `user_setexp_days:${botId}:14` },
                                { text: '30 hari', callback_data: `user_setexp_days:${botId}:30` },
                                { text: '90 hari', callback_data: `user_setexp_days:${botId}:90` }
                            ],
                            [{ text: '❌ Batal', callback_data: `user_detail:${botId}` }]
                        ]
                    }
                }
            ).catch(() => { });
            break;
        }
        case 'user_setexp_days': {
            // Format: user_setexp_days:userId:days
            const parts = data.split(':');
            const targetId = parts[1];
            const days = parseInt(parts[2]);
            if (!isNaN(days) && days > 0) {
                userManager.setExpiry(targetId, days);
                const u = userManager.getUser(targetId);
                const exp = userManager.formatExpiry(u.expiredAt);
                bot.sendMessage(chatId, `✅ Masa aktif user \`${targetId}\` diset *${days} hari* (${exp}).`, { parse_mode: 'Markdown' }).catch(() => { });
                // Notif ke user
                bot.sendMessage(parseInt(targetId),
                    `⏰ *Masa aktif akun Anda diperbarui!*\n\n` +
                    `Masa aktif: *${days} hari*\n` +
                    `Sisa: ${exp}\n\n` +
                    `${getAdminContact()}`,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
                pendingExpiry.delete(chatId);
                setTimeout(() => sendUserDetail(chatId, targetId), 500);
            }
            break;
        }
        case 'user_delete': {
            const u = userManager.getUser(botId);
            if (u) {
                userManager.remove(botId);
                bot.sendMessage(chatId, `🗑️ User \`${botId}\` telah dihapus.`, { parse_mode: 'Markdown' }).catch(() => { });
                setTimeout(() => sendUserMenu(chatId), 500);
            } else {
                bot.sendMessage(chatId, `❌ User tidak ditemukan.`).catch(() => { });
            }
            break;
        }
    }
});

// ==========================================================
// == FUNGSI KONTROL PROSES ==
// ==========================================================

function startBotProcess(chatId, botId) {
    const config = botConfigs[botId];
    if (!config) {
        bot.sendMessage(chatId, `❌ Konfigurasi bot "${botId}" tidak ditemukan.`).catch(() => { });
        return;
    }
    if (runningBots[botId]) {
        bot.sendMessage(chatId, `⚠️ ${config.name} sudah berjalan.`).catch(() => { });
        return;
    }

    const spawnEnv = { ...process.env };
    if (isPkg) {
        if (botId === 'utama') spawnEnv.RUN_BOT_MODE = 'utama';
        if (botId === 'auto') spawnEnv.RUN_BOT_MODE = 'auto';
    }

    console.log(`Mencoba menjalankan: "${config.command}${isPkg ? '' : ' ' + config.args.join(' ')}"...`);
    console.log(`Working Directory: ${config.cwd}`);
    bot.sendMessage(chatId, `🔄 Menjalankan ${config.name}...`).catch(() => { });

    const botProcess = spawn(config.command, isPkg ? [] : config.args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        cwd: config.cwd,
        env: spawnEnv
    });

    runningBots[botId] = botProcess;

    botProcess.on('close', (code) => {
        console.log(`${config.name} berhenti dengan kode: ${code}`);
        // Hanya kirim notif jika berhenti sendiri (bukan dimatikan manual)
        if (runningBots[botId]) {
            bot.sendMessage(chatId, `❌ ${config.name} berhenti sendiri (Kode: ${code}).`).catch(() => { });
            delete runningBots[botId];
        }
    });

    botProcess.on('error', (err) => {
        console.error(`Gagal memulai ${config.name}:`, err);
        bot.sendMessage(chatId, `❌ Gagal menjalankan ${config.name}: ${err.message}`).catch(() => { });
        delete runningBots[botId];
    });

    setTimeout(() => {
        if (runningBots[botId]) {
            console.log(`${config.name} berhasil dijalankan.`);
            bot.sendMessage(chatId, `✅ ${config.name} telah diaktifkan!`).catch(() => { });
        }
    }, 1500);
}

function stopBotProcess(chatId, botId) {
    const config = botConfigs[botId];
    if (!config) {
        bot.sendMessage(chatId, `❌ Konfigurasi bot "${botId}" tidak ditemukan.`).catch(() => { });
        return;
    }

    // [FIX #2] Nama variabel 'botProcess' bukan 'process'
    const botProcess = runningBots[botId];
    if (!botProcess) {
        bot.sendMessage(chatId, `ℹ️ ${config.name} memang sudah nonaktif.`).catch(() => { });
        return;
    }

    console.log(`Mematikan ${config.name}...`);
    bot.sendMessage(chatId, `🔄 Mematikan ${config.name}...`).catch(() => { });

    // [FIX #3] Kill dulu, delete setelah berhasil — mencegah proses zombie
    const killed = botProcess.kill('SIGINT');

    if (killed) {
        delete runningBots[botId];
        console.log(`${config.name} berhasil dinonaktifkan.`);
        bot.sendMessage(chatId, `✅ ${config.name} telah dinonaktifkan.`).catch(() => { });
    } else {
        console.log(`Gagal mematikan ${config.name}.`);
        bot.sendMessage(chatId, `❌ Gagal mematikan ${config.name}. Coba lagi.`).catch(() => { });
    }
}


// ==========================================================
// == FUNGSI USER MANAGEMENT
// ==========================================================

function sendUserMenu(chatId) {
    const users = userManager.getAllUsers();
    const total = Object.keys(users).length;
    const aktif = Object.values(users).filter(u => u.status === 'aktif').length;
    const blokir = Object.values(users).filter(u => u.status === 'blokir').length;

    bot.sendMessage(chatId,
        `👥 *KELOLA USER*\n\n` +
        `📊 Total  : ${total} user\n` +
        `🟢 Aktif  : ${aktif} user\n` +
        `🔴 Blokir : ${blokir} user`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📋 Lihat Semua User', callback_data: 'user_list:0' }],
                    [{ text: '🔴 Lihat User Terblokir', callback_data: 'user_blokir' }],
                    [{ text: '⏰ User Hampir Expired', callback_data: 'user_expiring' }],
                    [{ text: '« Kembali', callback_data: 'menu_main' }]
                ]
            }
        }
    ).catch(() => { });
}

function sendUserList(chatId, page = 0) {
    const users = userManager.getAllUsers();
    const ids = Object.keys(users);
    const perPage = 5;
    const start = page * perPage;
    const slice = ids.slice(start, start + perPage);

    if (slice.length === 0) {
        bot.sendMessage(chatId, '📭 Tidak ada user terdaftar.', {
            reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'user_menu' }]] }
        }).catch(() => { });
        return;
    }

    const buttons = slice.map(id => {
        const u = users[id];
        const icon = u.status === 'blokir' ? '🔴' : '🟢';
        const name = u.firstName || u.username || id;
        return [{ text: `${icon} ${name} (${id})`, callback_data: `user_detail:${id}` }];
    });

    // Navigasi halaman
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `user_list:${page - 1}` });
    if (start + perPage < ids.length) nav.push({ text: 'Next ▶️', callback_data: `user_list:${page + 1}` });
    if (nav.length > 0) buttons.push(nav);
    buttons.push([{ text: '« Kembali', callback_data: 'user_menu' }]);

    bot.sendMessage(chatId,
        `📋 *Daftar User* (${start + 1}-${Math.min(start + perPage, ids.length)} dari ${ids.length})`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    ).catch(() => { });
}

function sendUserDetail(chatId, userId) {
    const u = userManager.getUser(userId);
    if (!u) {
        bot.sendMessage(chatId, '❌ User tidak ditemukan.').catch(() => { });
        return;
    }

    const statusIcon = u.status === 'aktif' ? '🟢 Aktif' : '🔴 Blokir';
    const expText = userManager.formatExpiry(u.expiredAt);
    const joinText = userManager.formatDate(u.joinedAt);
    const expDate = u.expiredAt ? userManager.formatDate(u.expiredAt) : '-';

    // Format riwayat login
    const loginCount = u.loginCount || 1;
    const loginHistory = Array.isArray(u.loginHistory) ? u.loginHistory : [];
    // Urutkan terbaru dulu
    const loginSorted = [...loginHistory].reverse();
    const loginLines = loginSorted.length > 0
        ? loginSorted.map((ts, i) => `  ${i + 1}\. ${userManager.formatDate(ts)}`).join('\n')
        : '  -';

    const text =
        `👤 *Detail User*\n\n` +
        `🆔 Chat ID   : \`${userId}\`\n` +
        `👤 Nama      : ${u.firstName || '-'}\n` +
        `🏷️ Username  : ${u.username ? '@' + u.username : '-'}\n` +
        `📅 Bergabung : ${joinText}\n` +
        `📌 Status    : ${statusIcon}\n` +
        `⏳ Masa Aktif: ${expText}\n` +
        `📆 Expired   : ${expDate}\n` +
        (u.note ? `📝 Catatan   : ${u.note}\n` : '') +
        `\n📊 *Total Login: ${loginCount}x*\n` +
        `📋 *5 Login Terakhir:*\n${loginLines}`;

    const isBlocked = u.status === 'blokir';
    bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '⏰ Set Masa Aktif', callback_data: `user_setexp:${userId}` },
                    { text: '♾️ Hapus Masa Aktif', callback_data: `user_removeexp:${userId}` }
                ],
                [
                    isBlocked
                        ? { text: '✅ Buka Blokir', callback_data: `user_unblock:${userId}` }
                        : { text: '🚫 Blokir User', callback_data: `user_block:${userId}` }
                ],
                [{ text: '🗑️ Hapus User', callback_data: `user_delete:${userId}` }],
                [{ text: '« Kembali ke Daftar', callback_data: 'user_list:0' }]
            ]
        }
    }).catch(() => { });
}

function sendBlockedUsers(chatId) {
    const users = userManager.getAllUsers();
    const blocked = Object.entries(users).filter(([, u]) => u.status === 'blokir');

    if (blocked.length === 0) {
        bot.sendMessage(chatId, '✅ Tidak ada user yang diblokir.', {
            reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'user_menu' }]] }
        }).catch(() => { });
        return;
    }

    const buttons = blocked.map(([id, u]) => {
        const name = u.firstName || u.username || id;
        return [{ text: `🔴 ${name} (${id})`, callback_data: `user_detail:${id}` }];
    });
    buttons.push([{ text: '« Kembali', callback_data: 'user_menu' }]);

    bot.sendMessage(chatId, `🔴 *User Terblokir* (${blocked.length})`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    ).catch(() => { });
}

function sendExpiringUsers(chatId) {
    const users = userManager.getAllUsers();
    const now = new Date();

    // User yang expired dalam 3 hari ke depan
    const expiring = Object.entries(users).filter(([, u]) => {
        if (u.status !== 'aktif' || !u.expiredAt) return false;
        const diff = new Date(u.expiredAt) - now;
        return diff > 0 && diff <= 3 * 24 * 60 * 60 * 1000;
    });

    if (expiring.length === 0) {
        bot.sendMessage(chatId, '✅ Tidak ada user yang hampir expired dalam 3 hari ke depan.', {
            reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'user_menu' }]] }
        }).catch(() => { });
        return;
    }

    const buttons = expiring.map(([id, u]) => {
        const name = u.firstName || u.username || id;
        const sisa = userManager.formatExpiry(u.expiredAt);
        return [{ text: `⏳ ${name} — ${sisa}`, callback_data: `user_detail:${id}` }];
    });
    buttons.push([{ text: '« Kembali', callback_data: 'user_menu' }]);

    bot.sendMessage(chatId, `⏰ *User Hampir Expired* (${expiring.length})`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    ).catch(() => { });
}

// State untuk input hari masa aktif
const pendingExpiry = new Map(); // chatId → userId yang sedang di-set

// ==========================================================
// == FUNGSI STATUS VPS ==
// ==========================================================

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function checkVpsStatus(chatId) {
    try {
        const msg = await bot.sendMessage(chatId, '🖥️ Mengecek status VPS...');

        // [FIX CPU] Ambil baseline dulu, tunggu 500ms, baru ukur lagi
        // si.currentLoad() butuh 2 titik data untuk hitung % CPU yang akurat
        // Tanpa ini, hasil pertama sering 0% atau loncat tidak stabil
        await si.currentLoad();
        await new Promise(r => setTimeout(r, 500));

        const [load, memInfo, diskInfo] = await Promise.all([
            si.currentLoad(), // Pengukuran kedua = akurat
            si.mem(),
            si.fsSize()
        ]);

        const cpuUsage = load.currentLoad;
        const ramTotal = memInfo.total;
        const ramActuallyUsed = ramTotal - memInfo.available;
        const ramUsedPercent = ramTotal > 0 ? (ramActuallyUsed / ramTotal) * 100 : 0;

        const rootDisk = diskInfo.find(d => d.mount === '/') || diskInfo[0];
        let diskText = '   └─ Data tidak tersedia';
        if (rootDisk) {
            diskText = `   ├─ Terpakai   : ${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.size)}\n   └─ Penggunaan : ${(rootDisk.use || 0).toFixed(2)} %`;
        }

        // [FIX #5] Pakai *teks* bukan **teks** — Markdown Telegram hanya support single asterisk
        const pesan = `🖥️ *--- Status VPS ---* 🖥️

🔥 *CPU*
   └─ Penggunaan: ${cpuUsage.toFixed(2)} %

🧠 *RAM (Aktual)*
   ├─ Terpakai   : ${formatBytes(ramActuallyUsed)} / ${formatBytes(ramTotal)}
   └─ Penggunaan : ${ramUsedPercent.toFixed(2)} %

💾 *DISK ( / )*
${diskText}`;

        bot.editMessageText(pesan, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'Markdown'
        }).catch(() => { });

    } catch (error) {
        console.error('Gagal mengecek status VPS:', error);
        bot.sendMessage(chatId, `❌ Gagal mengambil status VPS: ${error.message}`).catch(() => { });
    }
}

// ==========================================================
// == FUNGSI STATUS BOT ==
// ==========================================================

function checkBotStatus(botId) {
    const config = botConfigs[botId];
    if (!config) return `⚠️ Bot "${botId}" tidak dikenal.`;
    return runningBots[botId]
        ? `📊 Status *${config.name}*: 🟢 AKTIF`
        : `📊 Status *${config.name}*: 🔴 NONAKTIF`;
}

function checkAllBotStatus() {
    let statusText = '📊 *--- Status Semua Bot ---*\n\n';
    for (const id in botConfigs) {
        const config = botConfigs[id];
        const icon = runningBots[id] ? '🟢' : '🔴';
        statusText += `${icon} *${config.name}*: ${runningBots[id] ? 'AKTIF' : 'NONAKTIF'}\n`;
    }
    return statusText;
}

// ==========================================================
// == HANDLER LAIN ==
// ==========================================================

bot.on('message', (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    if (!msg.text) return;

    const trimmedText = msg.text.trim();

    // Handle input /batal
    if (trimmedText === '/batal') {
        if (pendingEnvEdit.has(msg.chat.id) || pending2faSetup.has(msg.chat.id) || pendingExpiry.has(msg.chat.id)) {
            pendingEnvEdit.delete(msg.chat.id);
            pending2faSetup.delete(msg.chat.id);
            pendingExpiry.delete(msg.chat.id);
            bot.sendMessage(msg.chat.id, '❌ Aksi dibatalkan.').catch(() => {});
            sendMainMenu(msg.chat.id);
            return;
        }
    }

    // Handle input pengeditan variabel .env
    if (pendingEnvEdit.has(msg.chat.id)) {
        const editData = pendingEnvEdit.get(msg.chat.id);
        handleEnvEditInput(msg.chat.id, editData.field, trimmedText);
        return;
    }

    // Handle input konfirmasi 2FA setup baru
    if (pending2faSetup.has(msg.chat.id)) {
        const setupData = pending2faSetup.get(msg.chat.id);
        handle2faSetupConfirm(msg.chat.id, setupData.secret, trimmedText);
        return;
    }

    // Handle input OTP untuk verifikasi startup bot utama
    if (pendingOtpRequest && /^\d{6}$/.test(trimmedText)) {
        handleStartupOtpInput(msg.chat.id, trimmedText);
        return;
    }

    // Handle input jumlah hari masa aktif (manual ketik)
    if (pendingExpiry.has(msg.chat.id)) {
        const days = parseInt(msg.text.trim());
        if (!isNaN(days) && days > 0) {
            const targetId = pendingExpiry.get(msg.chat.id);
            userManager.setExpiry(targetId, days);
            pendingExpiry.delete(msg.chat.id);
            const u = userManager.getUser(targetId);
            const exp = userManager.formatExpiry(u.expiredAt);
            bot.sendMessage(msg.chat.id,
                `✅ Masa aktif user \`${targetId}\` diset *${days} hari* (${exp}).`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            // Notif ke user
            bot.sendMessage(parseInt(targetId),
                `⏰ *Masa aktif akun Anda diperbarui!*\n\nMasa aktif: *${days} hari*\nSisa: ${exp}\n\n${getAdminContact()}`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
            setTimeout(() => sendUserDetail(msg.chat.id, targetId), 500);
        } else {
            bot.sendMessage(msg.chat.id, '❌ Input tidak valid. Kirim angka positif (contoh: 7).').catch(() => { });
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        sendMainMenu(msg.chat.id, 'Perintah tidak dikenal. Menampilkan menu utama:');
    }
});


// ==========================================================
// == HTTP SERVER — Untuk cek akses user dari main.js
// == main.js query: GET http://localhost:3099/check?id=CHATID
// == Response: { allowed: true/false, reason: string, user: {...} }
// ==========================================================

const http = require('http');

const HTTP_PORT = process.env.CONTROLLER_HTTP_PORT || 3099;

server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    const id = url.searchParams.get('id');
    const action = url.pathname;

    if (action === '/check' && id) {
        const result = userManager.checkAccess(id);
        const user = userManager.getUser(id);
        res.writeHead(200);
        res.end(JSON.stringify({ ...result, user }));

    } else if (action === '/register' && id) {
        // main.js register user baru saat /start
        const params = url.searchParams;
        const { isNew, user } = userManager.registerOrUpdate(
            id,
            params.get('username') || '',
            params.get('firstName') || ''
        );
        res.writeHead(200);
        res.end(JSON.stringify({ isNew, user }));

    } else if (action === '/request-otp-verification') {
        if (pendingOtpRequest) {
            try {
                pendingOtpRequest.res.writeHead(200);
                pendingOtpRequest.res.end(JSON.stringify({ verified: false, reason: 'superseded' }));
                clearTimeout(pendingOtpRequest.timeout);
            } catch (err) {}
        }

        // Baca body POST untuk mendapatkan changeReason
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let changeReason = 'file_modified';
            try {
                const parsed = JSON.parse(body);
                if (parsed.changeReason) changeReason = parsed.changeReason;
            } catch (e) {}

            const timeout = setTimeout(() => {
                if (pendingOtpRequest && pendingOtpRequest.res === res) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ verified: false, reason: 'timeout' }));
                    bot.sendMessage(ADMIN_CHAT_ID, '⏰ *Verifikasi OTP Timeout.*\nStartup Bot Utama dibatalkan karena tidak ada respon dalam 60 detik.', { parse_mode: 'Markdown' }).catch(() => {});
                    pendingOtpRequest = null;
                }
            }, 60000);

            pendingOtpRequest = { res, timeout };

            // Buat pesan yang sesuai berdasarkan alasan perubahan
            let msgText;
            if (changeReason === 'config_changed') {
                msgText = `⚙️ *VERIFIKASI PERUBAHAN KONFIGURASI*

Bot Utama (\`main.js\`) mendeteksi bahwa file konfigurasi (\`.env\`) telah diperbarui dan membutuhkan konfirmasi Anda.

*Kemungkinan penyebab:*
• Anda baru saja mengubah konfigurasi lewat menu ⚙️ Pengaturan .env
• Anda baru saja menjalankan \`node setup.js\`

Masukkan kode 6-digit OTP dari *Google Authenticator* untuk menyetujui.
_(Abaikan jika Anda tidak melakukan perubahan)_`;
            } else {
                msgText = `🚨 *PERINGATAN KEAMANAN: Modifikasi File Kode Terdeteksi!*

Bot Utama (\`main.js\`) mendeteksi bahwa satu atau lebih *file kode program* telah diubah sejak terakhir kali dijalankan.

*Kemungkinan penyebab:*
• Update kode program terbaru dari GitHub
• Perubahan file secara manual di server

Masukkan kode 6-digit OTP dari *Google Authenticator* untuk menyetujui perubahan dan melanjutkan startup.
⛔ *Jika Anda tidak merasa mengubah apapun, jangan masukkan OTP dan segera periksa server Anda!*`;
            }

            bot.sendMessage(ADMIN_CHAT_ID, msgText, { parse_mode: 'Markdown' })
                .catch(err => {
                    console.error('Gagal mengirim pesan OTP ke admin:', err.message);
                    res.writeHead(500);
                    res.end(JSON.stringify({ verified: false, reason: 'telegram_send_failed' }));
                    clearTimeout(timeout);
                    pendingOtpRequest = null;
                });
        });

    } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`🌐 Controller HTTP server berjalan di http://127.0.0.1:${HTTP_PORT}`);
});

let _conflictRestartTimeout = null;

bot.on('polling_error', (error) => {
    if (error.message && error.message.includes('409 Conflict')) {
        console.warn('⚠️ Conflict terdeteksi (sisa proses lama). Restart polling dalam 5 detik...');
        // Jangan spam restart — hanya jadwalkan sekali
        if (!_conflictRestartTimeout) {
            _conflictRestartTimeout = setTimeout(async () => {
                _conflictRestartTimeout = null;
                try {
                    await bot.stopPolling();
                    await new Promise(r => setTimeout(r, 2000));
                    await bot.startPolling();
                    console.log('✅ Polling berhasil di-restart setelah conflict.');
                } catch (restartErr) {
                    console.error('❌ Gagal restart polling:', restartErr.message);
                }
            }, 5000);
        }
    } else {
        console.error(`Polling Error: ${error.code} - ${error.message}`);
    }
});
