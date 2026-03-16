// controller.js (v3.7 - Full Fix)

const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');

// --- CEK FILE .env ---
if (!fs.existsSync('.env')) {
    console.error('❌ FATAL: File .env tidak ditemukan!');
    console.error('Harap jalankan "node setup.js" terlebih dahulu.');
    process.exit(1);
}

dotenv.config();
console.log('ℹ️ File .env dimuat oleh Controller.');

// ===================================
// == ENV DECRYPTOR ==
// ===================================
class EnvDecryptor {
    constructor() {
        this.configKey = this.generateConfigKey();
    }
    generateConfigKey() {
        return crypto.pbkdf2Sync(
            'FASTARX_CONFIG_KEY_2024',
            'CONFIG_SALT_2024',
            50000, 32, 'sha256'
        );
    }
    decryptValue(encryptedValue) {
        if (!encryptedValue) return null;
        try {
            const parts = encryptedValue.split(':');
            if (parts.length !== 2) throw new Error('Format tidak valid.');
            const encryptedData = parts[0];
            const iv = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', this.configKey, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error(`DECRYPTION FAILED: ${error.message}`);
            return null;
        }
    }
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
        command: 'node',
        args: ['main.js'],
        cwd: __dirname
    },
    'auto': {
        name: 'Bot Kedua',
        command: 'node',
        args: ['main.js'],
        cwd: path.join(__dirname, 'auto')
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

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// Pastikan folder data ada
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
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
                [{ text: `👥 Kelola User (${totalUsers} user, ${blockedUsers} blokir)`, callback_data: 'user_menu' }]
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

    console.log(`Mencoba menjalankan: "${config.command} ${config.args.join(' ')}"...`);
    console.log(`Working Directory: ${config.cwd}`);
    bot.sendMessage(chatId, `🔄 Menjalankan ${config.name}...`).catch(() => { });

    // [FIX #2] Nama variabel 'botProcess' bukan 'process'
    // agar tidak menimpa global process milik Node.js
    const botProcess = spawn(config.command, config.args, {
        stdio: 'inherit',
        cwd: config.cwd
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

http.createServer((req, res) => {
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

    } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    }
}).listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`🌐 Controller HTTP server berjalan di http://127.0.0.1:${HTTP_PORT}`);
});

bot.on('polling_error', (error) => {
    if (error.message && error.message.includes('409 Conflict')) {
        console.warn('⚠️ Conflict terdeteksi (sisa proses lama), mengabaikan...');
    } else {
        console.error(`Polling Error: ${error.code} - ${error.message}`);
    }
});
