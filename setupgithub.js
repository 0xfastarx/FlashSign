'use strict';
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   FA STARX BOT — Setup GitHub Password Encryptor    ║
 * ║   Enkripsi password untuk disimpan di GitHub JSON   ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Cara pakai:
 *   node setupgithub.js
 *
 * Script ini akan:
 *   1. Membaca SYSTEM_ID dari file .env lokal
 *   2. Meminta Anda menginput password script yang ingin dienkripsi
 *   3. Menghasilkan string encryptedPassword yang siap diupload ke GitHub
 *
 * Format hasil (paste ke file JSON di GitHub):
 *   { "encryptedPassword": "<hasil_di_sini>" }
 */

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const readline = require('readline');

// ── Warna Terminal ──────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const PURPLE = '\x1b[35m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function ok(msg)   { console.log(GREEN  + '  ✅ ' + msg + RESET); }
function info(msg) { console.log(CYAN   + '  ℹ️  ' + msg + RESET); }
function warn(msg) { console.log(YELLOW + '  ⚠️  ' + msg + RESET); }
function err(msg)  { console.log(RED    + '  ❌ ' + msg + RESET); }

// ── Helper 2FA & Decryption dari setup.js ──────────────────────────────
function generateStaticConfigKey() {
    return crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
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

function readEnvField(envContent, fieldName) {
    const match = envContent.match(new RegExp(`^${fieldName}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
    return match ? match[1] : null;
}

function getApprovedHash() {
    const lockPath = path.join(__dirname, '.integrity.lock');
    if (!fs.existsSync(lockPath)) return '';
    try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        return data.approvedHash || '';
    } catch (e) { return ''; }
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

// ── Enkripsi password menggunakan SYSTEM_ID ─────────────────────────
function encryptPassword(plainPassword, systemId) {
    const key = crypto.pbkdf2Sync(systemId, 'FASTARX_GH_SALT_V1', 100000, 32, 'sha256');
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(plainPassword, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return `${iv.toString('hex')}:${encrypted}`;
}

// ── Verifikasi: dekripsi kembali untuk memastikan hasil benar ────────
function decryptPassword(encryptedStr, systemId) {
    try {
        const key = crypto.pbkdf2Sync(systemId, 'FASTARX_GH_SALT_V1', 100000, 32, 'sha256');
        const [ivHex, encBase64] = encryptedStr.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let dec = decipher.update(encBase64, 'base64', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (e) {
        return null;
    }
}

// ── Input tersembunyi ────────────────────────────────────────────────
async function askPassword(prompt) {
    return new Promise((resolve) => {
        process.stdout.write(PURPLE + prompt + RESET);

        let password = '';
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (ch) => {
            if (ch === '\r' || ch === '\n') {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(password);
            } else if (ch === '\u0003') {
                process.stdin.setRawMode(false);
                console.log('\n');
                process.exit(1);
            } else if (ch === '\u007f' || ch === '\b') {
                if (password.length > 0) {
                    password = password.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else if (ch.charCodeAt(0) >= 32) {
                password += ch;
                process.stdout.write('*');
            }
        };
        process.stdin.on('data', onData);
    });
}

async function askOTP(prompt) {
    return new Promise((resolve) => {
        process.stdout.write(PURPLE + prompt + RESET);

        let otp = '';
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (ch) => {
            if (ch === '\r' || ch === '\n') {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(otp);
            } else if (ch === '\u0003') {
                process.stdin.setRawMode(false);
                console.log('\n');
                process.exit(1);
            } else if (ch === '\u007f' || ch === '\b') {
                if (otp.length > 0) {
                    otp = otp.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else if (ch.charCodeAt(0) >= 48 && ch.charCodeAt(0) <= 57) { // Angka saja
                if (otp.length < 6) {
                    otp += ch;
                    process.stdout.write(ch);
                }
            }
        };
        process.stdin.on('data', onData);
    });
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
    console.clear();
    console.log(CYAN + BOLD);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   FA STARX BOT — Setup GitHub Password Encryptor    ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(RESET + '');

    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        err('File .env tidak ditemukan! Jalankan setup.js terlebih dahulu.');
        process.exit(1);
    }
    const envContent = fs.readFileSync(envPath, 'utf8');

    // 1. Verifikasi 2FA
    const setup2FAEncrypted = readEnvField(envContent, 'SETUP_2FA_SECRET_ENCRYPTED');
    if (!setup2FAEncrypted) {
        err('Setup-2FA belum terkonfigurasi di .env Anda.');
        err('Silakan jalankan setup.js terlebih dahulu untuk membuat Setup-2FA.');
        process.exit(1);
    }

    const approvedHash = getApprovedHash();
    let secret = decryptValueDynamic(setup2FAEncrypted, approvedHash);
    if (!secret) secret = decryptValueStatic(setup2FAEncrypted);
    if (!secret) {
        err('Gagal mendekripsi Setup-2FA secret. File .env Anda mungkin rusak.');
        process.exit(1);
    }

    info('Verifikasi identitas Anda dengan OTP terlebih dahulu.');
    const otpInput = await askOTP('  » Masukkan kode 6 digit OTP: ');
    if (!otpInput) {
        err('OTP tidak boleh kosong!');
        process.exit(1);
    }

    if (!verifyTOTP(secret, otpInput)) {
        err('ACCESS DENIED: Kode OTP salah! Enkripsi dibatalkan.');
        process.exit(1);
    }
    ok('OTP terverifikasi!\n');

    // 2. Baca SYSTEM_ID
    const systemId = readEnvField(envContent, 'SYSTEM_ID');
    if (!systemId) {
        err('SYSTEM_ID tidak ditemukan di .env!');
        process.exit(1);
    }
    ok(`SYSTEM_ID aktif ditemukan.`);
    console.log('');

    info('Script ini akan mengenkripsi password Script Anda.');
    info('Hasil enkripsi digunakan untuk field "encryptedPassword" di file JSON GitHub Anda.');
    console.log('');

    // 3. Input password
    const password = await askPassword('  » Masukkan Password Script yang ingin dienkripsi: ');
    if (!password) {
        err('Password tidak boleh kosong!');
        process.exit(1);
    }
    console.log('');

    // 4. Enkripsi
    info('Mengenkripsi password...');
    const encryptedPassword = encryptPassword(password, systemId);

    // 5. Verifikasi
    const verified = decryptPassword(encryptedPassword, systemId);
    if (verified !== password) {
        err('Verifikasi enkripsi GAGAL! Ada masalah internal. Coba lagi.');
        process.exit(1);
    }
    ok('Verifikasi berhasil — enkripsi valid!\n');

    // 6. Tampilkan hasil
    console.log(GREEN + BOLD + '╔══════════════════════════════════════════════════════╗');
    console.log('║              ✅  HASIL ENKRIPSI                      ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(RESET + '');
    info('Salin JSON di bawah ini dan tempelkan ke KEDUA file di GitHub Anda:');
    info('  • shelo.json (repo: ferystarx/scryty)');
    info('  • security-config.json (repo: ferystarx7/project-cripto)');
    console.log('');
    console.log(YELLOW + BOLD + '─────────────────────────────────────────────────────');
    console.log(RESET + '');
    console.log(GREEN + JSON.stringify({ encryptedPassword }, null, 2) + RESET);
    console.log('');
    console.log(YELLOW + BOLD + '─────────────────────────────────────────────────────' + RESET);
    console.log('');

    // 7. Panduan upload
    console.log(CYAN + '📋 Langkah Upload ke GitHub:' + RESET);
    console.log('   1. Buka: https://github.com/ferystarx/scryty/blob/main/shelo.json');
    console.log('   2. Klik ikon pensil ✏️ (Edit this file)');
    console.log('   3. Ganti seluruh isinya dengan JSON di atas');
    console.log('   4. Klik "Commit changes"');
    console.log('   5. Ulangi untuk: https://github.com/ferystarx7/project-cripto/blob/main/security-config.json');
    console.log('');
    ok('Setelah diupload, jalankan kembali: node main.js');
    console.log('');
}

main().catch(e => {
    err('Error fatal: ' + e.message);
    process.exit(1);
});
