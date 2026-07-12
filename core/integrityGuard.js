'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const PROTECTED_DIRS = [
    'bot',
    'utils',
    'core',
    'transfer',
    'config',
    'modes',
    'auth',
    'rpc'
];
const PROTECTED_FILES = [
    'main.js',
    'control.js',
    'setup.js',
    'package.json',
    'package-lock.json',
    '.security/.security-system-marker',
    '.security/.secure-backup-marker',
    '.security/.fastarx-ultra-secure',
    '.security/.permanent-security',
    '.security/.admin-password-secure',
    '.security/.github-validation-lock',
    '.security/.dual-backup-evidence'
];

class IntegrityGuard {
    constructor() {
        const isPkg = typeof process.pkg !== 'undefined';
        this.projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
        this.securityDir = path.join(this.projectRoot, '.security');
        // CATATAN: folder .security TIDAK dibuat di sini. Keamanan terpusat di VPS
        // controller (users/<id>/.security/), jadi folder bot user harus tetap bersih.
        // .security lokal hanya dibuat lewat _ensureSecurityDir() bila ada kode yang
        // benar-benar menulis (aksi admin), bukan sekadar me-require modul ini.
        this.lockFilePath = path.join(this.securityDir, '.integrity.lock');
        this.backupFilePath = path.join(this.securityDir, '.system-integrity-check');
        this.envPath = path.join(this.securityDir, '.env');
    }

    // Buat folder .security hanya saat benar-benar dibutuhkan untuk menulis.
    _ensureSecurityDir() {
        if (!fs.existsSync(this.securityDir)) {
            fs.mkdirSync(this.securityDir, { recursive: true });
        }
    }

    calculateProjectHash() {
        if (typeof process.pkg !== 'undefined') {
            return this.getApprovedHash() || '';
        }
        const fileHashes = [];

        for (const dirName of PROTECTED_DIRS) {
            const dirPath = path.join(this.projectRoot, dirName);
            if (fs.existsSync(dirPath)) {
                this._scanDirectoryRecursive(dirPath, fileHashes);
            }
        }

        for (const fileName of PROTECTED_FILES) {
            const filePath = path.join(this.projectRoot, fileName);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath);
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                const relPath = path.relative(this.projectRoot, filePath);
                fileHashes.push({ path: relPath, hash });
            }
        }

        fileHashes.sort((a, b) => a.path.localeCompare(b.path));

        const hasher = crypto.createHash('sha256');
        for (const item of fileHashes) {
            hasher.update(`${item.path}:${item.hash}`);
        }
        return hasher.digest('hex');
    }

    _scanDirectoryRecursive(dirPath, fileHashes) {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (item !== 'node_modules' && item !== 'temp' && !item.startsWith('.')) {
                    this._scanDirectoryRecursive(fullPath, fileHashes);
                }
            } else if (stat.isFile() && (
                item.endsWith('.js') ||
                item.endsWith('.json') ||
                item.endsWith('.cjs') ||
                item.endsWith('.mjs')
            )) {
                const content = fs.readFileSync(fullPath);
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                const relPath = path.relative(this.projectRoot, fullPath);
                fileHashes.push({ path: relPath, hash });
            }
        }
    }

    getApprovedHash() {
        if (fs.existsSync(this.lockFilePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
                if (data && data.approvedHash) {
                    return data.approvedHash;
                }
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    _calculateEnvHash() {
        if (!fs.existsSync(this.envPath)) return null;
        try {
            const content = fs.readFileSync(this.envPath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (e) {
            return null;
        }
    }

    _getApprovedEnvHash() {
        if (fs.existsSync(this.lockFilePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
                return data.approvedEnvHash || null;
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    _saveApprovedEnvHash(envHash) {
        try {
            let data = {};
            if (fs.existsSync(this.lockFilePath)) {
                data = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
            }
            data.approvedEnvHash = envHash;
            data.updatedAt = new Date().toISOString();
            this._ensureSecurityDir();
            fs.writeFileSync(this.lockFilePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn('⚠️ Gagal menyimpan env hash:', e.message);
        }
    }

    _loadEncryptionSalt(approvedHash) {
        if (!fs.existsSync(this.envPath)) return null;
        try {
            const configKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024' + approvedHash,
                'CONFIG_SALT_2024',
                50000,
                32,
                'sha256'
            );
            const envContent = fs.readFileSync(this.envPath, 'utf8');
            const match = envContent.match(/^ENCRYPTION_SALT_ENCRYPTED\s*=\s*["']?([^"'\r\n]+)["']?/m);
            if (!match) return null;

            const encryptedValue = match[1];
            const parts = encryptedValue.split(':');
            if (parts.length !== 2) return null;

            const encryptedData = parts[0];
            const iv = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', configKey, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            return null;
        }
    }

    _loadAdminPasswordFromMarker(approvedHash) {
        const adminSecureFile = path.join(this.securityDir, '.admin-password-secure');
        if (!fs.existsSync(adminSecureFile)) return null;

        try {
            const fileContent = JSON.parse(fs.readFileSync(adminSecureFile, 'utf8'));
            const systemId = process.env.SYSTEM_ID;
            if (!systemId) return null;

            const salt = this._loadEncryptionSalt(approvedHash);
            if (!salt) return null;

            const key = crypto.pbkdf2Sync(
                'FASTARX_SECURE_MASTER_KEY_2024',
                salt,
                100000,
                32,
                'sha256'
            );

            const iv = Buffer.from(fileContent.iv, 'hex');
            const authTag = Buffer.from(fileContent.authTag, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(fileContent.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            const data = JSON.parse(decrypted);
            return data.password;
        } catch (e) {
            return null;
        }
    }

    async _promptPassword(promptText) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const stdin = process.openStdin();
            const onDataHandler = (char) => {
                char = char + '';
                switch (char) {
                    case '\n':
                    case '\r':
                    case '\u0004':
                        stdin.removeListener('data', onDataHandler);
                        break;
                    default:
                        process.stdout.write('\x1B[2K\x1B[0G' + promptText + '*'.repeat(rl.line.length));
                        break;
                }
            };
            process.stdin.on('data', onDataHandler);

            rl.question(promptText, (answer) => {
                rl.close();
                console.log('');
                resolve(answer.trim());
            });
        });
    }

    async _promptOTP(promptText) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question(promptText, (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    // Implementasi TOTP inline (RFC 6238) — tidak memerlukan library eksternal
    _base32DecodeInline(base32) {
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

    _verifyOTPInline(secret, token, window = 1) {
        try {
            const timeStep = 30;
            const counter = Math.floor(Date.now() / 1000 / timeStep);
            const key = this._base32DecodeInline(secret);
            for (let delta = -window; delta <= window; delta++) {
                const c = counter + delta;
                const buf = Buffer.alloc(8);
                let tmp = c;
                for (let i = 7; i >= 0; i--) { buf[i] = tmp & 0xff; tmp = Math.floor(tmp / 256); }
                const hmac = crypto.createHmac('sha1', key).update(buf).digest();
                const offset = hmac[hmac.length - 1] & 0x0f;
                const code = (
                    ((hmac[offset] & 0x7f) << 24) |
                    (hmac[offset + 1] << 16) |
                    (hmac[offset + 2] << 8) |
                    hmac[offset + 3]
                ) % 1000000;
                if (code.toString().padStart(6, '0') === token.toString()) return true;
            }
        } catch (e) { }
        return false;
    }

    _readSetup2FASecret(approvedHash) {
        if (!fs.existsSync(this.envPath)) return null;
        try {
            const envContent = fs.readFileSync(this.envPath, 'utf8');
            const match = envContent.match(/^SETUP_2FA_SECRET_ENCRYPTED\s*=\s*["']?([^"'\r\n]+)["']?/m);
            if (!match) return null;
            const configKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024' + approvedHash,
                'CONFIG_SALT_2024', 50000, 32, 'sha256'
            );
            const parts = match[1].split(':');
            if (parts.length !== 2) return null;
            const decipher = crypto.createDecipheriv('aes-256-cbc', configKey, Buffer.from(parts[1], 'hex'));
            let decrypted = decipher.update(parts[0], 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            return null;
        }
    }

    _readSetup2FASecretStatic() {
        if (!fs.existsSync(this.envPath)) return null;
        try {
            const envContent = fs.readFileSync(this.envPath, 'utf8');
            const match = envContent.match(/^SETUP_2FA_SECRET_ENCRYPTED\s*=\s*["']?([^"'\r\n]+)["']?/m);
            if (!match) return null;
            const staticKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024',
                'CONFIG_SALT_2024',
                50000,
                32,
                'sha256'
            );
            const parts = match[1].split(':');
            if (parts.length !== 2) return null;
            const decipher = crypto.createDecipheriv('aes-256-cbc', staticKey, Buffer.from(parts[1], 'hex'));
            let decrypted = decipher.update(parts[0], 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            return null;
        }
    }

    async _requestOtpFromController(changeReason = 'file_modified') {
        const port = process.env.CONTROLLER_HTTP_PORT || 3099;
        return new Promise((resolve) => {
            const http = require('http');
            const body = JSON.stringify({ changeReason });
            const req = http.request({
                hostname: '127.0.0.1',
                port: port,
                path: '/request-otp-verification',
                method: 'POST',
                timeout: 65000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (err) {
                        resolve({ verified: false, reason: 'invalid_json' });
                    }
                });
            });

            req.on('error', (err) => {
                resolve({ verified: false, reason: 'controller_offline', error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ verified: false, reason: 'timeout' });
            });

            req.write(body);
            req.end();
        });
    }

    /**
     * Memulihkan sistem jika file lock hilang
     */
    async attemptRecovery() {
        console.log('\n⚠️  PERINGATAN KEAMANAN: File kunci integritas (.integrity.lock) tidak ditemukan!');
        console.log('Sistem mendeteksi kemungkinan penghapusan file secara tidak sah.');

        if (!fs.existsSync(this.backupFilePath)) {
            console.error('❌ ERROR: Cadangan integritas (.system-integrity-check) hilang. Sistem terkunci secara permanen.');
            process.exit(1);
        }

        const input = await this._promptPassword('🔑 Masukkan Password Admin untuk memulihkan sistem: ');

        let backupHash = null;
        try {
            const backupData = JSON.parse(fs.readFileSync(this.backupFilePath, 'utf8'));
            const key = crypto.pbkdf2Sync(input, 'INTEGRITY_RECOVERY_SALT', 50000, 32, 'sha256');
            const iv = Buffer.from(backupData.iv, 'hex');
            const authTag = Buffer.from(backupData.authTag, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(backupData.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            const parsed = JSON.parse(decrypted);
            backupHash = parsed.approvedHash;
        } catch (e) {
            console.error('❌ ACCESS DENIED: Password salah atau file backup rusak! Bot ditutup.');
            process.exit(1);
        }

        if (!backupHash) {
            console.error('❌ ERROR: Cadangan integritas tidak valid. Sistem terkunci secara permanen.');
            process.exit(1);
        }

        this._ensureSecurityDir();
        fs.writeFileSync(this.lockFilePath, JSON.stringify({
            approvedHash: backupHash,
            updatedAt: new Date().toISOString(),
            recovered: true
        }, null, 2));

        console.log('✅ Sistem berhasil dipulihkan dari cadangan aman!');
        return backupHash;
    }

    saveNewApprovedHash(hash, adminPassword) {
        const envHash = this._calculateEnvHash();
        this._ensureSecurityDir();
        fs.writeFileSync(this.lockFilePath, JSON.stringify({
            approvedHash: hash,
            approvedEnvHash: envHash,
            updatedAt: new Date().toISOString()
        }, null, 2));

        try {
            const key = crypto.pbkdf2Sync(adminPassword, 'INTEGRITY_RECOVERY_SALT', 50000, 32, 'sha256');
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const plaintext = JSON.stringify({ approvedHash: hash, timestamp: new Date().toISOString() });
            let encrypted = cipher.update(plaintext, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();

            fs.writeFileSync(this.backupFilePath, JSON.stringify({
                encrypted,
                iv: iv.toString('hex'),
                authTag: authTag.toString('hex')
            }, null, 2));
        } catch (e) {
            console.warn('⚠️ Gagal menulis file backup integritas:', e.message);
        }
    }

    reencryptEnv(oldHash, newHash, adminPassword) {
        if (!fs.existsSync(this.envPath)) {
            throw new Error('File .env tidak ditemukan.');
        }

        const oldConfigKey = crypto.pbkdf2Sync(
            'FASTARX_CONFIG_KEY_2024' + oldHash,
            'CONFIG_SALT_2024',
            50000,
            32,
            'sha256'
        );

        const newConfigKey = crypto.pbkdf2Sync(
            'FASTARX_CONFIG_KEY_2024' + newHash,
            'CONFIG_SALT_2024',
            50000,
            32,
            'sha256'
        );

        let envContent = fs.readFileSync(this.envPath, 'utf8');
        const lines = envContent.split(/\r?\n/);
        const updatedLines = lines.map(line => {
            if (!line || line.startsWith('#') || !line.includes('=')) {
                return line;
            }

            const eqIndex = line.indexOf('=');
            const key = line.substring(0, eqIndex).trim();
            const value = line.substring(eqIndex + 1).trim();

            if (key.endsWith('_ENCRYPTED') && value) {
                try {
                    const cleanValue = value.replace(/^["']|["']$/g, '');
                    const parts = cleanValue.split(':');
                    if (parts.length === 2) {
                        const encryptedData = parts[0];
                        const iv = Buffer.from(parts[1], 'hex');
                        const decipher = crypto.createDecipheriv('aes-256-cbc', oldConfigKey, iv);
                        let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
                        decrypted += decipher.final('utf8');

                        const newIv = crypto.randomBytes(16);
                        const cipher = crypto.createCipheriv('aes-256-cbc', newConfigKey, newIv);
                        let encrypted = cipher.update(decrypted, 'utf8', 'base64');
                        encrypted += cipher.final('base64');

                        return `${key}="${encrypted}:${newIv.toString('hex')}"`;
                    }
                } catch (e) {
                    console.error(`❌ Gagal re-enkripsi key: ${key}. Error: ${e.message}`);
                }
            }
            return line;
        });

        fs.writeFileSync(this.envPath, updatedLines.join('\n'), 'utf8');
        console.log('📝 File .env telah berhasil di-re-enkripsi ke signature baru.');
    }

    /**
     * Memeriksa apakah file .env saat ini dienkripsi dengan kunci statis bawaan setup.js.
     * Mengembalikan password admin jika berhasil didekripsi.
     */
    _tryDecryptWithStaticKey() {
        if (!fs.existsSync(this.envPath)) return null;
        try {
            const staticKey = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024',
                'CONFIG_SALT_2024',
                50000,
                32,
                'sha256'
            );
            const envContent = fs.readFileSync(this.envPath, 'utf8');
            const match = envContent.match(/^ADMIN_PASSWORD_ENCRYPTED\s*=\s*["']?([^"'\r\n]+)["']?/m);
            if (!match) return null;

            const parts = match[1].split(':');
            if (parts.length !== 2) return null;

            const decipher = crypto.createDecipheriv('aes-256-cbc', staticKey, Buffer.from(parts[1], 'hex'));
            let decrypted = decipher.update(parts[0], 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            // Gagal dekripsi berarti .env tidak pakai kunci statis (sudah diikat hash)
            return null;
        }
    }

    async verify() {
        const currentHash = this.calculateProjectHash();

        // JIKA BYPASS ENVIRONMENT TERDETEKSI (dari restart terverifikasi OTP)
        if (process.env.BYPASS_INTEGRITY_OTP === 'true') {
            console.log('\n\x1b[38;5;46m✅ BYPASS INTEGRITY: Restart terverifikasi (OTP sudah dimasukkan saat ganti password).\x1b[0m');
            try {
                const oldHash = this.getApprovedHash() || '';
                const adminPassword = this._loadAdminPasswordFromMarker(oldHash) || 'SETUP_2FA_VERIFIED';
                this.reencryptEnv(oldHash, currentHash, adminPassword);
                this.saveNewApprovedHash(currentHash, adminPassword);
                console.log('\x1b[38;5;46m✅ Konfigurasi dan tanda tangan integritas berhasil diperbarui secara otomatis!\x1b[0m');
            } catch (err) {
                console.warn('⚠️ Gagal memperbarui tanda tangan integritas otomatis:', err.message);
            }
            return;
        }

        // Cek deteksi pasca-setup: Apakah .env menggunakan kunci statis bawaan setup.js?
        const staticAdminPassword = this._tryDecryptWithStaticKey();
        if (staticAdminPassword) {
            console.log('\n🔄 Deteksi perubahan konfigurasi dari setup.js! Memerlukan verifikasi OTP...');

            let verified = false;

            // Coba verifikasi lewat Controller Bot terlebih dahulu
            console.log('🔄 Menghubungi Controller Bot untuk verifikasi OTP via Telegram...');
            const controllerResult = await this._requestOtpFromController('config_changed');

            if (controllerResult.verified) {
                console.log('✅ Verifikasi OTP disetujui via Telegram.');
                verified = true;
            } else if (controllerResult.reason !== 'controller_offline') {
                console.error(`\x1b[38;5;203m❌ ACCESS DENIED: Verifikasi Telegram gagal (${controllerResult.reason || 'Ditolak'}). Perubahan .env dibatalkan.\x1b[0m`);
                process.exit(1);
            } else {
                // Fallback ke prompt terminal manual
                console.log('ℹ️  Controller Bot offline. Fallback ke verifikasi terminal...');

                const setup2FASecret = this._readSetup2FASecretStatic();
                if (setup2FASecret) {
                    console.log('\x1b[38;5;51m📱 Buka Google Authenticator → [Fastarx Bot - Setup]\x1b[0m');
                    const otpInput = await this._promptOTP('\x1b[38;5;141m🔑 Masukkan kode 6 digit OTP untuk mengonfirmasi perubahan .env: \x1b[0m');
                    if (!this._verifyOTPInline(setup2FASecret, otpInput)) {
                        console.error('\x1b[38;5;203m❌ ACCESS DENIED: Kode OTP salah! Perubahan .env dibatalkan.\x1b[0m');
                        process.exit(1);
                    }
                    verified = true;
                } else {
                    console.log('\x1b[38;5;214m⚠️  Setup-2FA belum dikonfigurasi. Menggunakan Password Admin untuk konfirmasi...\x1b[0m');
                    const input = await this._promptPassword('🔑 Masukkan Password Admin untuk mengonfirmasi perubahan .env: ');
                    if (input !== staticAdminPassword) {
                        console.error('❌ ACCESS DENIED: Password salah! Perubahan .env dibatalkan.');
                        process.exit(1);
                    }
                    verified = true;
                }
            }

            if (verified) {
                try {
                    // Re-enkripsi dari static key (hash kosong) ke currentHash
                    this.reencryptEnv('', currentHash, staticAdminPassword);
                    this.saveNewApprovedHash(currentHash, staticAdminPassword);
                    console.log('✅ Perubahan konfigurasi berhasil diverifikasi dan diamankan!');
                    return;
                } catch (err) {
                    console.error('❌ Gagal memproses data setup baru:', err.message);
                    process.exit(1);
                }
            }
        }

        let approvedHash = this.getApprovedHash();

        if (!approvedHash) {
            if (fs.existsSync(this.envPath)) {
                approvedHash = await this.attemptRecovery();
            } else {
                console.log('🆕 Setup awal sistem integritas...');
                const defaultAdminPassword = 'admin';
                this.saveNewApprovedHash(currentHash, defaultAdminPassword);
                return;
            }
        }

        if (currentHash !== approvedHash) {
            console.log('\n\x1b[38;5;214m⚠️  PERINGATAN KEAMANAN: Modifikasi file atau file baru terdeteksi!\x1b[0m');

            let verified = false;

            // Coba verifikasi lewat Controller Bot terlebih dahulu
            console.log('🔄 Menghubungi Controller Bot untuk verifikasi OTP via Telegram...');
            const controllerResult = await this._requestOtpFromController('file_modified');

            if (controllerResult.verified) {
                console.log('✅ Verifikasi OTP disetujui via Telegram.');
                verified = true;
            } else if (controllerResult.reason !== 'controller_offline') {
                console.error(`\x1b[38;5;203m❌ ACCESS DENIED: Verifikasi Telegram gagal (${controllerResult.reason || 'Ditolak'}). Bot ditutup.\x1b[0m`);
                process.exit(1);
            } else {
                // Fallback ke prompt terminal manual
                console.log('ℹ️  Controller Bot offline atau tidak dapat dijangkau. Fallback ke verifikasi terminal...');

                // Coba baca Setup-2FA secret dari .env
                const setup2FASecret = this._readSetup2FASecret(approvedHash);

                if (setup2FASecret) {
                    // .env baru — verifikasi dengan OTP
                    console.log('\x1b[38;5;51m📱 Buka Google Authenticator → [Fastarx Bot - Setup]\x1b[0m');
                    const otpInput = await this._promptOTP('\x1b[38;5;141m🔑 Masukkan kode 6 digit OTP: \x1b[0m');
                    if (!this._verifyOTPInline(setup2FASecret, otpInput)) {
                        console.error('\x1b[38;5;203m❌ ACCESS DENIED: Kode OTP salah! Bot ditutup.\x1b[0m');
                        process.exit(1);
                    }
                    verified = true;
                } else {
                    // .env lama — fallback ke Password Admin
                    console.log('\x1b[38;5;214m⚠️  Setup-2FA belum dikonfigurasi. Menggunakan Password Admin (mode lama).\x1b[0m');
                    const adminPassword = this._loadAdminPasswordFromMarker(approvedHash);
                    if (!adminPassword) {
                        console.error('❌ ERROR: Master password tidak dapat dimuat. Bot dikunci.');
                        process.exit(1);
                    }
                    const input = await this._promptPassword('🔑 Masukkan Password Admin untuk menyetujui perubahan: ');
                    if (input !== adminPassword) {
                        console.error('❌ ACCESS DENIED: Password salah! Bot ditutup.');
                        process.exit(1);
                    }
                    verified = true;
                }
            }

            if (verified) {
                console.log('🔄 Memproses pembaruan kode...');
                try {
                    const adminPassword = this._loadAdminPasswordFromMarker(approvedHash);
                    this.reencryptEnv(approvedHash, currentHash, adminPassword || 'SETUP_2FA_VERIFIED');
                    this.saveNewApprovedHash(currentHash, adminPassword || 'SETUP_2FA_VERIFIED');
                    console.log('\x1b[38;5;46m✅ Perubahan berhasil diverifikasi dan ditandatangani!\x1b[0m');
                } catch (err) {
                    console.error('❌ Gagal memproses update:', err.message);
                    process.exit(1);
                }
            }
        }

        // === CEK PERUBAHAN FILE .env ===
        // Deteksi jika .env diubah via menu Telegram Controller atau cara lain
        const currentEnvHash = this._calculateEnvHash();
        const approvedEnvHash = this._getApprovedEnvHash();

        if (currentEnvHash && approvedEnvHash && currentEnvHash !== approvedEnvHash) {
            console.log('\n\x1b[38;5;214m⚙️  Perubahan konfigurasi .env terdeteksi!\x1b[0m');
            console.log('File .env telah dimodifikasi sejak terakhir kali Bot Utama dijalankan.');

            let envVerified = false;

            // Coba verifikasi lewat Controller Bot
            console.log('🔄 Menghubungi Controller Bot untuk verifikasi OTP via Telegram...');
            const envControllerResult = await this._requestOtpFromController('config_changed');

            if (envControllerResult.verified) {
                console.log('✅ Verifikasi OTP disetujui via Telegram.');
                envVerified = true;
            } else if (envControllerResult.reason !== 'controller_offline') {
                console.error(`\x1b[38;5;203m❌ ACCESS DENIED: Verifikasi Telegram gagal (${envControllerResult.reason || 'Ditolak'}). Bot ditutup.\x1b[0m`);
                process.exit(1);
            } else {
                // Fallback ke prompt terminal manual
                console.log('ℹ️  Controller Bot offline. Fallback ke verifikasi terminal...');

                const currentApprovedHash = this.getApprovedHash() || '';
                const setup2FASecret = this._readSetup2FASecret(currentApprovedHash);

                if (setup2FASecret) {
                    console.log('\x1b[38;5;51m📱 Buka Google Authenticator → [Fastarx Bot - Setup]\x1b[0m');
                    const otpInput = await this._promptOTP('\x1b[38;5;141m🔑 Masukkan kode 6 digit OTP untuk mengonfirmasi perubahan .env: \x1b[0m');
                    if (!this._verifyOTPInline(setup2FASecret, otpInput)) {
                        console.error('\x1b[38;5;203m❌ ACCESS DENIED: Kode OTP salah! Bot ditutup.\x1b[0m');
                        process.exit(1);
                    }
                    envVerified = true;
                } else {
                    console.log('\x1b[38;5;214m⚠️  Setup-2FA belum dikonfigurasi. Menggunakan Password Admin.\x1b[0m');
                    const currentApproved = this.getApprovedHash() || '';
                    const adminPassword = this._loadAdminPasswordFromMarker(currentApproved);
                    if (!adminPassword) {
                        console.error('❌ ERROR: Master password tidak dapat dimuat. Bot dikunci.');
                        process.exit(1);
                    }
                    const input = await this._promptPassword('🔑 Masukkan Password Admin untuk mengonfirmasi perubahan .env: ');
                    if (input !== adminPassword) {
                        console.error('❌ ACCESS DENIED: Password salah! Bot ditutup.');
                        process.exit(1);
                    }
                    envVerified = true;
                }
            }

            if (envVerified) {
                this._saveApprovedEnvHash(currentEnvHash);
                console.log('\x1b[38;5;46m✅ Perubahan konfigurasi .env berhasil diverifikasi!\x1b[0m');
            }
        } else if (currentEnvHash && !approvedEnvHash) {
            // Pertama kali — simpan hash .env tanpa minta verifikasi
            this._saveApprovedEnvHash(currentEnvHash);
        }
    }
}

module.exports = new IntegrityGuard();
