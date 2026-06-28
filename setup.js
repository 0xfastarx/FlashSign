/**
 * =============================================================================
 * == FA STARX BOT — SETUP.JS v2.0
 * ==
 * == Kondisi 1: Tidak ada .env     → DITOLAK langsung
 * == Kondisi 2: .env lama (no 2FA) → Verifikasi Password Admin → Upgrade
 * == Kondisi 3: .env baru (ada 2FA) → Verifikasi OTP 6 digit → Update
 * ==
 * == Input Manual: GitHub Main URL, GitHub Backup URL,
 * ==               Owner Telegram ID, Password Admin, Password Script
 * == Auto-Generate: encryptionSalt, systemId
 * == Dihapus: Default RPC URL & Chain ID (dikelola via bot)
 * == 2FA Bot (auth/TwoFactorAuth.js): TIDAK DISENTUH
 * ==
 * == Jalankan: node setup.js
 * =============================================================================
 */

const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Konstanta ────────────────────────────────────────────────────────────────

const HARDCODED = {
    telegramToken: '8959820342:AAHDXsPZPDzdpaCU9du2XnzL_dn0q8NEKJs',
    controllerToken: '8806274632:AAHgNFqBswOBAr0bdFMJyD0jaGVYhPggQ84',
    encryptionSalt: 'FASTARX_SECURE_SALT_2024',
    walletConnectId: '90389c47acff78d74136dc8d58fb757c',
    adminChatId: '6005128221',
};

// ─── UI ───────────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const CYAN   = '\x1b[38;5;51m';
const YELLOW = '\x1b[38;5;214m';
const GREEN  = '\x1b[38;5;46m';
const RED    = '\x1b[38;5;203m';
const PURPLE = '\x1b[38;5;141m';
const BOLD   = '\x1b[1m';

const ok   = m => console.log(GREEN  + '  ✅ ' + m + RESET);
const warn = m => console.log(YELLOW + '  ⚠️  ' + m + RESET);
const info = m => console.log(CYAN   + '  ℹ️  ' + m + RESET);
const err  = m => console.log(RED    + '  ❌ ' + m + RESET);

// ─── Enkripsi (Kunci Statis — untuk penulisan awal setup.js) ──────────────────

function generateStaticConfigKey() {
    return crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
}

function encryptValueStatic(plaintext) {
    const key = generateStaticConfigKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update(plaintext, 'utf8', 'base64');
    enc += cipher.final('base64');
    return `${enc}:${iv.toString('hex')}`;
}

function decryptValueStatic(encryptedValue) {
    try {
        const key = generateStaticConfigKey();
        const parts = encryptedValue.split(':');
        if (parts.length !== 2) return null;
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[1], 'hex'));
        let dec = decipher.update(parts[0], 'base64', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (e) { return null; }
}

// ─── Enkripsi dengan hash (untuk .env yang sudah diikat) ──────────────────────

function generateDynamicConfigKey(approvedHash) {
    return crypto.pbkdf2Sync(
        'FASTARX_CONFIG_KEY_2024' + approvedHash,
        'CONFIG_SALT_2024', 50000, 32, 'sha256'
    );
}

function decryptValueDynamic(encryptedValue, approvedHash) {
    try {
        const key = generateDynamicConfigKey(approvedHash);
        const parts = encryptedValue.split(':');
        if (parts.length !== 2) return null;
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[1], 'hex'));
        let dec = decipher.update(parts[0], 'base64', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (e) { return null; }
}

// ─── Baca field dari .env ─────────────────────────────────────────────────────

function readEnvField(envContent, fieldName) {
    const match = envContent.match(new RegExp(`^${fieldName}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
    return match ? match[1] : null;
}

function getApprovedHash() {
    const lockPath = path.join(__dirname, 'security', '.integrity.lock');
    if (!fs.existsSync(lockPath)) return '';
    try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        return data.approvedHash || '';
    } catch (e) { return ''; }
}

// ─── TOTP inline (RFC 6238) ───────────────────────────────────────────────────

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

function generateTOTP(secret) {
    const counter = Math.floor(Date.now() / 1000 / 30);
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
        ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
        (hmac[offset + 2] << 8) | hmac[offset + 3]
    ) % 1000000;
    return code.toString().padStart(6, '0');
}

function verifyTOTP(secret, token, window = 1) {
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
    return false;
}

function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function buildOtpAuthUri(secret, account, issuer = 'Fastarx Bot') {
    const enc = encodeURIComponent;
    return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function displaySecretInstructions(secret, account) {
    const uri = buildOtpAuthUri(secret, account);
    console.log('');
    console.log(CYAN + '┌─────────────────────────────────────────────────────────────┐');
    console.log('│          SETUP 2FA — FASTARX BOT (SETUP)                    │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  Buka Google Authenticator / Authy di HP Anda               │');
    console.log('│  Tambahkan akun baru → "Enter a setup key"                  │');
    console.log('│                                                              │');
    console.log(`│  Account : ${(account).padEnd(50)}│`);
    console.log(`│  Secret  : ${secret.padEnd(50)}│`);
    console.log('│                                                              │');
    console.log('│  ATAU scan QR dengan URL berikut di browser:                │');
    console.log('│  https://api.qrserver.com/v1/create-qr-code/?size=200x200&  │');
    console.log(`│  data=${enc(uri).substring(0, 54).padEnd(54)}│`);
    console.log('│                                                              │');
    console.log('│  ⚠️  SIMPAN SECRET INI DI TEMPAT AMAN!                       │');
    console.log('│  Jika HP hilang & secret hilang → akses setup.js terkunci   │');
    console.log('└─────────────────────────────────────────────────────────────┘' + RESET);
    console.log('');
    function enc(s) { return encodeURIComponent(s); }
}

// ─── Input helpers ────────────────────────────────────────────────────────────

function askQuestion(rl, prompt, defaultVal = '') {
    return new Promise(resolve => {
        const hint = defaultVal ? ` [${defaultVal.substring(0, 30)}${defaultVal.length > 30 ? '...' : ''}]` : '';
        rl.question(PURPLE + `  » ${prompt}${hint}: ` + RESET, ans => {
            resolve(ans.trim() || defaultVal);
        });
    });
}

async function askWithSameCheck(rl, prompt, oldVal, label) {
    const input = await askQuestion(rl, prompt, oldVal);
    if (input && input === oldVal) {
        warn(`Nilai ${label} sama dengan yang sudah ada di .env.`);
        const confirm = await askQuestion(rl, 'Tetap simpan ulang? (y/N)', 'n');
        if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
            info(`${label} dipertahankan (tidak diubah).`);
        } else {
            ok(`${label} disimpan ulang.`);
        }
    } else if (input !== oldVal) {
        ok(`${label} diperbarui.`);
    }
    return input;
}

function askPassword(prompt) {
    return new Promise(resolve => {
        process.stdout.write(PURPLE + `  » ${prompt}: ` + RESET);
        let input = '';
        const onData = (char) => {
            char = char.toString('utf8');
            if (char === '\n' || char === '\r' || char === '\u0004') {
                process.stdin.removeListener('data', onData);
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdout.write('\n');
                resolve(input);
            } else if (char === '\u0003') {
                process.exit();
            } else if (char === '\u007f') {
                if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
            } else {
                input += char;
                process.stdout.write('*');
            }
        };
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
}

async function askPasswordConfirm(label) {
    while (true) {
        const pw1 = await askPassword(label);
        if (pw1.length < 4) { err('Minimal 4 karakter.'); continue; }
        const pw2 = await askPassword(`Konfirmasi ${label}`);
        if (pw1 !== pw2) { err('Tidak cocok, ulangi.'); continue; }
        return pw1;
    }
}

// ─── Build .env ───────────────────────────────────────────────────────────────

function buildEnv(data, setup2FASecret, encSalt, sysId) {
    return [
        '# ============================================================',
        '# FA STARX BOT — Environment Configuration',
        `# Generated: ${new Date().toISOString()}`,
        '# JANGAN bagikan file ini ke siapapun!',
        '# ============================================================',
        '',
        '# System',
        `SYSTEM_ID=${sysId}`,
        '',
        '# ===================================',
        '# KONFIGURASI KEAMANAN',
        '# ===================================',
        `ADMIN_PASSWORD_ENCRYPTED="${encryptValueStatic(data.adminPassword)}"`,
        `SCRIPT_PASSWORD_ENCRYPTED="${encryptValueStatic(data.scriptPassword)}"`,
        `GITHUB_MAIN_URL_ENCRYPTED="${encryptValueStatic(data.githubMainUrl)}"`,
        `GITHUB_BACKUP_URL_ENCRYPTED="${encryptValueStatic(data.githubBackupUrl)}"`,
        `ENCRYPTION_SALT_ENCRYPTED="${encryptValueStatic(encSalt)}"`,
        `SETUP_2FA_SECRET_ENCRYPTED="${encryptValueStatic(setup2FASecret)}"`,
        '',
        '# ===================================',
        '# KONFIGURASI TELEGRAM (DUAL BOT)',
        '# ===================================',
        `TELEGRAM_BOT_TOKEN_ENCRYPTED="${encryptValueStatic(data.telegramToken)}"`,
        `CONTROLLER_BOT_TOKEN_ENCRYPTED="${encryptValueStatic(data.controllerToken)}"`,
        `ADMIN_CHAT_ID_ENCRYPTED="${encryptValueStatic(data.adminChatId)}"`,
        `OWNER_TELEGRAM_ID_ENCRYPTED="${encryptValueStatic(data.ownerTelegramId)}"`,
        '',
        '# ===================================',
        '# KONFIGURASI KRIPTO & RPC',
        '# ===================================',
        `WALLETCONNECT_PROJECT_ID_ENCRYPTED="${encryptValueStatic(data.walletConnectId)}"`,
        '# DEFAULT_RPC_URL dan DEFAULT_RPC_CHAIN_ID tidak diperlukan.',
        '# Tambahkan RPC melalui menu RPC Management di bot.',
    ].join('\n') + '\n';
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
    console.clear();
    console.log(CYAN + BOLD);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║         FA STARX BOT — SETUP KONFIGURASI v2.0       ║');
    console.log('║         Dengan Setup-2FA & Input Manual              ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(RESET + '');

    const envPath = path.join(__dirname, 'security', '.env');
    const secDir = path.join(__dirname, 'security');
    if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });

    // ── KONDISI 1: Tidak ada .env ──────────────────────────────────
    if (!fs.existsSync(envPath)) {
        err('File .env tidak ditemukan!');
        err('setup.js hanya bisa dijalankan jika file .env sudah ada.');
        err('Hubungi pemilik bot untuk mendapatkan file .env yang valid.');
        process.exit(1);
    }

    const envContent = fs.readFileSync(envPath, 'utf8');
    const approvedHash = getApprovedHash();

    // Cek apakah .env sudah punya Setup-2FA
    const setup2FAEncrypted = readEnvField(envContent, 'SETUP_2FA_SECRET_ENCRYPTED');

    // ── KONDISI 2: .env lama (tanpa Setup-2FA) → verifikasi Password Admin ──
    if (!setup2FAEncrypted) {
        warn('.env versi lama terdeteksi (belum ada Setup-2FA).');
        info('Masukkan Password Admin saat ini untuk melanjutkan upgrade.');
        console.log('');

        // Baca dan dekripsi Password Admin dari .env lama
        const adminPwdEncrypted = readEnvField(envContent, 'ADMIN_PASSWORD_ENCRYPTED');
        if (!adminPwdEncrypted) {
            err('Gagal membaca ADMIN_PASSWORD_ENCRYPTED dari .env.');
            process.exit(1);
        }

        // Coba dekripsi dengan hash dinamis, fallback ke kunci statis
        let savedAdminPwd = decryptValueDynamic(adminPwdEncrypted, approvedHash);
        if (!savedAdminPwd) savedAdminPwd = decryptValueStatic(adminPwdEncrypted);
        if (!savedAdminPwd) {
            err('Gagal mendekripsi password admin. File .env mungkin rusak.');
            process.exit(1);
        }

        const inputPwd = await askPassword('Password Admin saat ini');
        console.log('');
        if (inputPwd !== savedAdminPwd) {
            err('ACCESS DENIED: Password admin salah! Setup dibatalkan.');
            process.exit(1);
        }
        ok('Password terverifikasi! Melanjutkan upgrade...\n');
        await runSetupFlow(envPath, envContent, approvedHash, 'upgrade');

    // ── KONDISI 3: .env baru (ada Setup-2FA) → verifikasi OTP ──────
    } else {
        info('Silakan verifikasi identitas Anda terlebih dahulu.');
        console.log('');

        // Dekripsi Setup-2FA secret
        let secret = decryptValueDynamic(setup2FAEncrypted, approvedHash);
        if (!secret) secret = decryptValueStatic(setup2FAEncrypted);
        if (!secret) {
            err('Gagal membaca Setup-2FA secret. File .env mungkin rusak.');
            process.exit(1);
        }

        console.log(CYAN + '📱 Buka Google Authenticator → [Fastarx Bot - Setup]' + RESET);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const otpInput = await new Promise(resolve => {
            rl.question(PURPLE + '  » Masukkan kode 6 digit OTP: ' + RESET, ans => {
                rl.close();
                resolve(ans.trim());
            });
        });
        console.log('');

        if (!verifyTOTP(secret, otpInput)) {
            err('ACCESS DENIED: Kode OTP salah! Setup dibatalkan.');
            process.exit(1);
        }
        ok('OTP terverifikasi! Melanjutkan ke menu update...\n');
        await runSetupFlow(envPath, envContent, approvedHash, 'update', secret);
    }
}

// ─── Alur Setup Utama ─────────────────────────────────────────────────────────

async function runSetupFlow(envPath, envContent, approvedHash, mode, existing2FASecret = null) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Baca nilai lama dari .env sebagai default
    function getOldVal(fieldName) {
        const encrypted = readEnvField(envContent, fieldName);
        if (!encrypted) return '';
        let val = decryptValueDynamic(encrypted, approvedHash);
        if (!val) val = decryptValueStatic(encrypted);
        return val || '';
    }

    const oldGithubMain   = getOldVal('GITHUB_MAIN_URL_ENCRYPTED');
    const oldGithubBackup = getOldVal('GITHUB_BACKUP_URL_ENCRYPTED');
    const oldOwnerTgId    = getOldVal('OWNER_TELEGRAM_ID_ENCRYPTED');
    const oldTelegramToken   = getOldVal('TELEGRAM_BOT_TOKEN_ENCRYPTED') || HARDCODED.telegramToken;
    const oldControllerToken = getOldVal('CONTROLLER_BOT_TOKEN_ENCRYPTED') || HARDCODED.controllerToken;
    const oldAdminChatId     = getOldVal('ADMIN_CHAT_ID_ENCRYPTED') || HARDCODED.adminChatId;
    const walletConnectId    = getOldVal('WALLETCONNECT_PROJECT_ID_ENCRYPTED') || HARDCODED.walletConnectId;

    console.log(PURPLE + '┌──────────────────────────────────────────────────────┐');
    console.log('│  INPUT KONFIGURASI (Enter = pertahankan nilai lama)  │');
    console.log('└──────────────────────────────────────────────────────┘' + RESET);
    info('Tekan Enter pada setiap field untuk mempertahankan nilai saat ini.');
    info('Nilai dalam [...] adalah nilai lama yang tersimpan di .env.\n');

    // 1. GitHub Main URL
    const githubMainUrl = await askWithSameCheck(rl, '1/6 GitHub Main URL (raw.githubusercontent.com)', oldGithubMain, 'GitHub Main URL');
    if (!githubMainUrl) { rl.close(); err('GitHub Main URL wajib diisi!'); process.exit(1); }

    // 2. GitHub Backup URL
    const githubBackupUrl = await askWithSameCheck(rl, '2/6 GitHub Backup URL (raw.githubusercontent.com)', oldGithubBackup, 'GitHub Backup URL');
    if (!githubBackupUrl) { rl.close(); err('GitHub Backup URL wajib diisi!'); process.exit(1); }

    // 3. Owner Telegram ID
    let ownerTelegramId = '';
    while (true) {
        const input = await askQuestion(rl, '3/6 Owner Telegram ID', oldOwnerTgId || HARDCODED.adminChatId);
        if (/^\d+$/.test(input)) {
            if (input === (oldOwnerTgId || HARDCODED.adminChatId)) {
                warn('Owner Telegram ID sama dengan yang sudah ada di .env.');
                const confirm = await askQuestion(rl, 'Tetap simpan ulang? (y/N)', 'n');
                if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
                    info('Owner Telegram ID dipertahankan.');
                } else {
                    ok('Owner Telegram ID disimpan ulang.');
                }
            } else {
                ok(`Owner Telegram ID: ${input}`);
            }
            ownerTelegramId = input;
            break;
        }
        err('Harus berupa angka.');
    }

    // 4. Token Bot Utama
    const telegramToken = await askWithSameCheck(rl, '4/6 Token Bot Utama (TELEGRAM_BOT_TOKEN)', oldTelegramToken, 'Token Bot Utama');
    if (!telegramToken) { rl.close(); err('Token Bot Utama wajib diisi!'); process.exit(1); }

    // 5. Token Controller Bot
    const controllerToken = await askWithSameCheck(rl, '5/6 Token Controller Bot (CONTROLLER_BOT_TOKEN)', oldControllerToken, 'Token Controller Bot');
    if (!controllerToken) { rl.close(); err('Token Controller Bot wajib diisi!'); process.exit(1); }

    // 6. Admin Chat ID
    let adminChatId = '';
    while (true) {
        const input = await askQuestion(rl, '6/6 Admin Chat ID (Telegram Chat ID admin)', oldAdminChatId);
        if (/^\d+$/.test(input)) {
            if (input === oldAdminChatId) {
                warn('Admin Chat ID sama dengan yang sudah ada di .env.');
                const confirm = await askQuestion(rl, 'Tetap simpan ulang? (y/N)', 'n');
                if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
                    info('Admin Chat ID dipertahankan.');
                } else {
                    ok('Admin Chat ID disimpan ulang.');
                }
            } else {
                ok(`Admin Chat ID: ${input}`);
            }
            adminChatId = input;
            break;
        }
        err('Harus berupa angka.');
    }

    rl.close();
    console.log('');
    info('Karakter tersembunyi saat mengetik password.\n');

    // Password Admin
    const adminPassword = await askPasswordConfirm('Password Admin');
    ok('Password Admin tersimpan.\n');

    // Password Script
    const scriptPassword = await askPasswordConfirm('Password Script');
    ok('Password Script tersimpan.\n');

    // ── Setup-2FA ─────────────────────────────────────────────────────────────
    console.log(PURPLE + '┌──────────────────────────────────────────────────────┐');
    console.log('│  SETUP 2FA UNTUK PROTEKSI SETUP & INTEGRITAS         │');
    console.log('└──────────────────────────────────────────────────────┘' + RESET);

    let newSecret = existing2FASecret;
    let shouldSetup2FA = false;

    if (existing2FASecret) {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => {
            rl2.question(PURPLE + '❓ Apakah Anda ingin mengatur ulang (reset) Google Authenticator 2FA? (y/N): ' + RESET, ans => {
                rl2.close();
                resolve(ans.trim().toLowerCase());
            });
        });
        if (answer === 'y' || answer === 'yes') {
            shouldSetup2FA = true;
        }
    } else {
        shouldSetup2FA = true;
    }

    if (shouldSetup2FA) {
        newSecret = generateSecret();
        displaySecretInstructions(newSecret, 'Fastarx Bot - Setup');

        // Konfirmasi OTP
        let otpConfirmed = false;
        while (!otpConfirmed) {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            const confirmOtp = await new Promise(resolve => {
                rl2.question(PURPLE + '  » Masukkan kode 6 digit dari Authenticator untuk konfirmasi: ' + RESET, ans => {
                    rl2.close();
                    resolve(ans.trim());
                });
            });
            if (verifyTOTP(newSecret, confirmOtp)) {
                ok('Kode OTP terverifikasi! 2FA berhasil dikonfigurasi.\n');
                otpConfirmed = true;
            } else {
                err('Kode OTP salah. Pastikan Anda sudah menambahkan secret ke Authenticator dan coba lagi.');
            }
        }
    } else {
        ok('Mempertahankan Setup-2FA yang sudah ada.\n');
    }

    // Ambil SYSTEM_ID lama jika ada, atau buat baru jika tidak ada
    const oldSysId = readEnvField(envContent, 'SYSTEM_ID');
    const sysId = oldSysId || ('sys_id_' + crypto.randomBytes(16).toString('hex'));

    // Enkripsi Salt baru (boleh baru karena disimpan di .env)
    const encSalt = crypto.randomBytes(32).toString('hex');

    // Simpan .env
    info('Mengenkripsi semua data dan menyimpan .env...');
    const envData = {
        adminPassword,
        scriptPassword,
        githubMainUrl,
        githubBackupUrl,
        ownerTelegramId,
        telegramToken,
        controllerToken,
        adminChatId,
        walletConnectId,
    };
    fs.writeFileSync(envPath, buildEnv(envData, newSecret, encSalt, sysId), 'utf8');
    try { fs.chmodSync(envPath, 0o600); } catch (_) {}

    console.log('\n' + GREEN + '╔══════════════════════════════════════════════════════╗');
    console.log('║              ✅  SETUP SELESAI!                      ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  File .env berhasil dibuat/diperbarui.               ║');
    console.log('║  Setup-2FA aktif — gunakan Authenticator untuk OTP.  ║');
    console.log('║                                                      ║');
    console.log('║  Jalankan bot:  node main.js                         ║');
    console.log('╚══════════════════════════════════════════════════════╝' + RESET + '\n');
    process.exit(0);
}

main().catch(e => {
    console.error(RED + '❌ Error fatal:', e.message + RESET);
    process.exit(1);
});