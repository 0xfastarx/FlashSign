/**
 * =============================================================================
 * == FA STARX BOT — SETUP.JS (Semi Auto)
 * ==
 * == Input manual : Owner Telegram ID, Password Admin, Password Script
 * == Otomatis     : Semua konfigurasi lainnya
 * == SEMUA value di .env dienkripsi tanpa terkecuali
 * ==
 * == Jalankan: node setup.js
 * =============================================================================
 */

const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Enkripsi ─────────────────────────────────────────────────────────────────

function generateConfigKey() {
    return crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
}

function encryptValue(plaintext) {
    const key = generateConfigKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update(plaintext, 'utf8', 'base64');
    enc += cipher.final('base64');
    return `${enc}:${iv.toString('hex')}`;
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m', CYAN = '\x1b[38;5;51m', YELLOW = '\x1b[38;5;214m';
const GREEN = '\x1b[38;5;46m', RED = '\x1b[38;5;203m', PURPLE = '\x1b[38;5;141m';

const ok = m => console.log(GREEN + '  ✅ ' + m + RESET);
const warn = m => console.log(YELLOW + '  ⚠️  ' + m + RESET);
const info = m => console.log(CYAN + '  ℹ️  ' + m + RESET);

// ─── Data otomatis ────────────────────────────────────────────────────────────

const AUTO = {
    telegramToken: '8142291565:AAEH8GE9M80gElrNrkdJ0xufNBDnYF47qWo',
    controllerToken: '8635664416:AAEb9WYWjsVXEES8KymjMFeBBleBp7CPwSk',
    githubMainUrl: 'https://raw.githubusercontent.com/ferystarx7/project-cripto/main/security-config.json',
    githubBackupUrl: 'https://raw.githubusercontent.com/ferystarx/scryty/main/shelo.json',
    encryptionSalt: 'FASTARX_SECURE_SALT_2024',
    walletConnectId: '90389c47acff78d74136dc8d58fb757c',
    defaultRpcUrl: 'https://rpc.hoodi.ethpandaops.io/',
    defaultChainId: '560048',
    adminChatId: '1477269244',
    systemId: 'sys_id_cf148d86f85bdce07db7b016b88a2683',
};

// ─── Input helpers ────────────────────────────────────────────────────────────

function askQuestion(rl, prompt) {
    return new Promise(resolve => {
        rl.question(PURPLE + `  » ${prompt}: ` + RESET, ans => resolve(ans.trim()));
    });
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
        if (pw1.length < 4) { console.log(RED + '  ❌ Minimal 4 karakter.' + RESET); continue; }
        const pw2 = await askPassword(`Konfirmasi ${label}`);
        if (pw1 !== pw2) { console.log(RED + '  ❌ Tidak cocok, ulangi.' + RESET); continue; }
        return pw1;
    }
}

// ─── Build .env (SEMUA terenkripsi) ──────────────────────────────────────────

function buildEnv(ownerTelegramId, adminPassword, scriptPassword) {
    return [
        '# ============================================================',
        '# FA STARX BOT — Environment Configuration',
        `# Generated: ${new Date().toISOString()}`,
        '# JANGAN bagikan file ini ke siapapun!',
        '# ============================================================',
        '',
        '# System',
        `SYSTEM_ID=${AUTO.systemId}`,
        '',
        '# ===================================',
        '# KONFIGURASI KEAMANAN',
        '# ===================================',
        `ADMIN_PASSWORD_ENCRYPTED="${encryptValue(adminPassword)}"`,
        `SCRIPT_PASSWORD_ENCRYPTED="${encryptValue(scriptPassword)}"`,
        `GITHUB_MAIN_URL_ENCRYPTED="${encryptValue(AUTO.githubMainUrl)}"`,
        `GITHUB_BACKUP_URL_ENCRYPTED="${encryptValue(AUTO.githubBackupUrl)}"`,
        `ENCRYPTION_SALT_ENCRYPTED="${encryptValue(AUTO.encryptionSalt)}"`,
        '',
        '# ===================================',
        '# KONFIGURASI TELEGRAM (DUAL BOT)',
        '# ===================================',
        `TELEGRAM_BOT_TOKEN_ENCRYPTED="${encryptValue(AUTO.telegramToken)}"`,
        `CONTROLLER_BOT_TOKEN_ENCRYPTED="${encryptValue(AUTO.controllerToken)}"`,
        `ADMIN_CHAT_ID_ENCRYPTED="${encryptValue(AUTO.adminChatId)}"`,
        `OWNER_TELEGRAM_ID_ENCRYPTED="${encryptValue(ownerTelegramId)}"`,
        '',
        '# ===================================',
        '# KONFIGURASI KRIPTO & RPC',
        '# ===================================',
        `WALLETCONNECT_PROJECT_ID_ENCRYPTED="${encryptValue(AUTO.walletConnectId)}"`,
        `DEFAULT_RPC_URL_ENCRYPTED="${encryptValue(AUTO.defaultRpcUrl)}"`,
        `DEFAULT_RPC_CHAIN_ID_ENCRYPTED="${encryptValue(AUTO.defaultChainId)}"`,
    ].join('\n') + '\n';
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
    console.clear();
    console.log(CYAN + '╔══════════════════════════════════════════════════════╗');
    console.log('║         FA STARX BOT — SETUP KONFIGURASI            ║');
    console.log('║              v19.0.0 — ALL ENCRYPTED                ║');
    console.log('╚══════════════════════════════════════════════════════╝' + RESET + '\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const envPath = path.join(__dirname, '.env');

    if (fs.existsSync(envPath)) {
        warn('.env sudah ada dan akan DITIMPA.');
        info('Tekan Ctrl+C untuk batalkan. Lanjut dalam 3 detik...\n');
        await new Promise(r => setTimeout(r, 3000));
    }

    // Tampilkan data otomatis
    console.log(PURPLE + '┌──────────────────────────────────────────────────────┐');
    console.log('│  DATA OTOMATIS (akan dienkripsi)                     │');
    console.log('└──────────────────────────────────────────────────────┘' + RESET);
    ok(`Bot Token        : ${AUTO.telegramToken.slice(0, 10)}...${AUTO.telegramToken.slice(-6)}`);
    ok(`Controller Token : ${AUTO.controllerToken.slice(0, 10)}...${AUTO.controllerToken.slice(-6)}`);
    ok(`GitHub Main      : ${AUTO.githubMainUrl}`);
    ok(`GitHub Backup    : ${AUTO.githubBackupUrl}`);
    ok(`RPC URL          : ${AUTO.defaultRpcUrl}`);
    ok(`Chain ID         : ${AUTO.defaultChainId}`);
    ok(`WalletConnect ID : ${AUTO.walletConnectId.slice(0, 8)}...`);
    ok(`Admin Chat ID    : ${AUTO.adminChatId}`);
    console.log('');

    // Input manual
    console.log(PURPLE + '┌──────────────────────────────────────────────────────┐');
    console.log('│  INPUT MANUAL (3 item)                               │');
    console.log('└──────────────────────────────────────────────────────┘' + RESET);

    // 1. Owner Telegram ID
    info(`Tekan Enter langsung untuk pakai default: ${AUTO.adminChatId}`);
    let ownerTelegramId = '';
    while (true) {
        const input = await askQuestion(rl, `1/3 Owner Telegram ID [${AUTO.adminChatId}]`);
        const finalId = input || AUTO.adminChatId;
        if (/^\d+$/.test(finalId)) { ownerTelegramId = finalId; ok(`Owner ID: ${ownerTelegramId}`); break; }
        console.log(RED + '  ❌ Harus berupa angka.' + RESET);
    }

    rl.close();
    console.log('');
    info('Karakter tersembunyi saat mengetik password.\n');

    // 2. Password Admin
    const adminPassword = await askPasswordConfirm('2/3 Password Admin');
    ok('Password Admin tersimpan.\n');

    // 3. Password Script
    const scriptPassword = await askPasswordConfirm('3/3 Password Script');
    ok('Password Script tersimpan.\n');

    // Simpan .env
    info('Mengenkripsi semua data dan menyimpan .env...');
    fs.writeFileSync(envPath, buildEnv(ownerTelegramId, adminPassword, scriptPassword), 'utf8');
    try { fs.chmodSync(envPath, 0o600); } catch (_) { }

    console.log('\n' + GREEN + '╔══════════════════════════════════════════════════════╗');
    console.log('║              ✅  SETUP SELESAI!                      ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  File .env berhasil dibuat. Semua value terenkripsi. ║');
    console.log('║                                                      ║');
    console.log('║  Jalankan bot:  node main.js                         ║');
    console.log('╚══════════════════════════════════════════════════════╝' + RESET + '\n');
    process.exit(0);
}

main().catch(e => { console.error(RED + '❌ Error:', e.message + RESET); process.exit(1); });