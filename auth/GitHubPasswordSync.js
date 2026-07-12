'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const ModernUI = require('../core/ModernUI');
const InputHandler = require('../core/InputHandler');
const TwoFactorAuth = require('./TwoFactorAuth');

const isPkg = typeof process.pkg !== 'undefined';
const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

class GitHubPasswordSync {
    constructor(rl, adminPassword, scriptPassword, mainUrl, backupUrl, salt) {
        this.ui = new ModernUI();
        this.input = new InputHandler(rl);
        
        this.securityFiles = [
            '.security-system-marker', '.secure-backup-marker', '.fastarx-ultra-secure',
            '.system-integrity-check', '.permanent-security', '.admin-password-secure',
            '.github-validation-lock', '.dual-backup-evidence'
        ];
        this.githubSources = [
            { name: "MAIN", url: mainUrl },
            { name: "BACKUP", url: backupUrl }
        ];
        this.adminPassword = adminPassword;
        this.scriptPassword = scriptPassword;
        this.githubStatus = {
            MAIN: { connected: false, password: null },
            BACKUP: { connected: false, password: null }
        };
        this.consensusAchieved = false;
        this.systemLocked = false; 
        this.encryptionConfig = {
            algorithm: 'aes-256-gcm',
            keyIterations: 100000,
            keyLength: 32,
            salt: salt || crypto.randomBytes(16).toString('hex'), 
            digest: 'sha256'
        };
        this.masterKey = this.generateMasterKey();
    }

    generateMasterKey() {
        return crypto.pbkdf2Sync(
            'FASTARX_SECURE_MASTER_KEY_2024',
            this.encryptionConfig.salt,
            this.encryptionConfig.keyIterations,
            this.encryptionConfig.keyLength,
            this.encryptionConfig.digest
        );
    }

    encryptData(plaintext) {
        try {
            const key = this.masterKey;
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(this.encryptionConfig.algorithm, key, iv);
            let encrypted = cipher.update(plaintext, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();
            return {
                encrypted: encrypted,
                iv: iv.toString('hex'),
                authTag: authTag.toString('hex'),
                algorithm: this.encryptionConfig.algorithm,
                timestamp: new Date().toISOString()
            };
        } catch (error) { 
            throw new Error('Encryption failed'); 
        }
    }

    decryptData(encryptedData) {
        try {
            const key = this.masterKey;
            const iv = Buffer.from(encryptedData.iv, 'hex');
            const authTag = Buffer.from(encryptedData.authTag, 'hex');
            const decipher = crypto.createDecipheriv(this.encryptionConfig.algorithm, key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) { 
            throw new Error('Decryption failed: ' + error.message); 
        }
    }

    async initialize() {
        // ══════════════════════════════════════════════════════════════════════
        // ARSITEKTUR BARU (VPS-CENTRALIZED)
        // ----------------------------------------------------------------------
        // Semua konfigurasi keamanan (password admin & script) dikirim dari Server
        // Controller (VPS) dan sudah tersedia di memori lewat constructor
        // (this.adminPassword / this.scriptPassword). Bot TIDAK lagi menulis atau
        // membaca folder .security lokal — seluruh file keamanan hidup di controller
        // pada users/<id>/.security/. Folder bot user tetap BERSIH tanpa .security.
        //
        // Efek samping penting: karena tidak ada penulisan .security saat runtime,
        // project-hash tidak berubah saat bot berjalan, sehingga tamper-detection
        // tidak lagi salah menghukum bot atas tulisannya sendiri.
        // ══════════════════════════════════════════════════════════════════════
        console.log('🔐 Security system aktif (sumber: VPS Controller · in-memory · tanpa .security lokal).');
        this.systemLocked = false;

        if (!this.adminPassword || !this.scriptPassword) {
            console.warn('⚠️ Password admin/script belum lengkap dari VPS config — cek konfigurasi user di controller (users/<id>/.security/.env).');
        }
        return true;
    }

    async createSecurityFiles() {
        console.log('📁 Creating security files...');
        const secDir = path.join(projectRoot, '.security');
        if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });
        let createdCount = 0;
        const timestamp = new Date().toISOString();
        for (const file of this.securityFiles) {
            const filePath = path.join(projectRoot, '.security', file);
            if (!fs.existsSync(filePath)) {
                try {
                    let fileData = {};
                    if (file === '.admin-password-secure') {
                        fileData = { password: this.adminPassword, timestamp: timestamp, type: 'ADMIN_PASSWORD', filePurpose: file, securityLevel: 'HIGH' };
                    } else {
                        fileData = { password: this.scriptPassword, timestamp: timestamp, type: 'SECURITY_FILE', filePurpose: file, securityLevel: 'HIGH' };
                    }
                    // FIX: Backup markers should also store admin password for recovery
                    if (file === '.secure-backup-marker' || file === '.system-integrity-check') {
                        fileData = { ...fileData, password: this.adminPassword, timestamp: timestamp, type: 'ADMIN_PASSWORD', isBackup: true };
                    }
                    const encryptedData = this.encryptData(JSON.stringify(fileData));
                    const finalData = { ...encryptedData, metadata: { system: 'FA_STARX_BOT', created: timestamp, version: '1.0' } };
                    fs.writeFileSync(filePath, JSON.stringify(finalData, null, 2));
                    console.log(`✅ Created: ${file}`);
                    createdCount++;
                } catch (error) { 
                    console.log(`❌ Failed to create ${file}`); 
                }
            }
        }
        if (createdCount > 0) console.log(`🎯 ${createdCount} security files created`);
    }

    async readPasswordsFromFiles() {
        console.log('🔑 Reading passwords from security files...');
        const adminFiles = ['.admin-password-secure', '.secure-backup-marker', '.system-integrity-check'];
        const scriptFiles = this.securityFiles.filter(f => !adminFiles.includes(f));
        let adminFound = false, scriptFound = false;
        
        for (const file of adminFiles) {
            const filePath = path.join(projectRoot, '.security', file);
            if (fs.existsSync(filePath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const fileData = JSON.parse(this.decryptData(data));
                    if (fileData.password && fileData.type === 'ADMIN_PASSWORD') {
                        this.adminPassword = fileData.password;
                        adminFound = true;
                        console.log(`🔑 Admin password loaded from: ${file}`);
                        break;
                    }
                } catch (error) { 
                    console.log(`⚠️ Failed to read/decrypt ${file}, trying next...`); 
                }
            }
        }
        if (!adminFound) console.log('❌ CRITICAL: Could not load admin password from any source file.');
        
        for (const file of scriptFiles) {
            const filePath = path.join(projectRoot, '.security', file);
            if (fs.existsSync(filePath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const fileData = JSON.parse(this.decryptData(data));
                    if (fileData.password && fileData.type === 'SECURITY_FILE') {
                        this.scriptPassword = fileData.password;
                        scriptFound = true;
                        console.log(`🔑 Script password loaded from: ${file}`);
                        break;
                    }
                } catch (error) { /* Lanjut */ }
            }
        }
        if (!scriptFound) console.log('❌ Could not load script password from any source file.');
    }

    async validateGitHubSources() {
        this.ui.startLoading('🔍 Validating GitHub sources...');
        try {
            const results = await Promise.allSettled([
                this.fetchGitHubConfig(this.githubSources[0]),
                this.fetchGitHubConfig(this.githubSources[1])
            ]);
            const validResults = [];
            this.ui.stopLoading(); 
            
            results.forEach((result, index) => {
                const source = this.githubSources[index];
                if (result.status === 'fulfilled' && result.value) {
                    this.githubStatus[source.name] = { connected: true, password: result.value };
                    validResults.push(result.value);
                    console.log(`✅ ${source.name}: Connected`);
                } else {
                    this.githubStatus[source.name] = { connected: false, password: null };
                    console.log(`❌ ${source.name}: Offline/Not Configured`);
                }
            });
            
            if (validResults.length > 0) {
                if (validResults.length === 2 && validResults[0] !== validResults[1]) {
                    return { validated: false, message: 'Konsensus gagal: Password MAIN dan BACKUP tidak sama' };
                }
                const resolvedPassword = validResults[0];
                this.consensusAchieved = true;
                this.scriptPassword = resolvedPassword;
                await this.updateSecurityFilesWithGitHubPassword(resolvedPassword);
                return { validated: true, message: 'GitHub validation successful' };
            }
            return { validated: false, message: 'GitHub status: 0 connected' };
        } catch (error) {
            this.ui.stopLoading();
            return { validated: false, message: 'Validation error: ' + error.message };
        }
    }

    async fetchGitHubConfig(source) {
        return new Promise((resolve, reject) => {
            if (!source || !source.url || typeof source.url !== 'string' || !source.url.startsWith('http')) {
                return resolve(null);
            }
            try {
                const url = new URL(source.url);
                const options = {
                    hostname: url.hostname, port: 443, path: url.pathname, method: 'GET',
                    headers: { 'User-Agent': 'FASTARX-BOT/1.0' },
                    timeout: 10000
                };
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            if (res.statusCode === 200) {
                                const config = JSON.parse(data);
                                const password = this.extractPassword(config);
                                if (password) resolve(password);
                                else reject(new Error('No password found in JSON'));
                            } else reject(new Error(`HTTP ${res.statusCode}`));
                        } catch (error) { 
                            reject(new Error('Parse error')); 
                        }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { 
                    req.destroy(); 
                    reject(new Error('Timeout')); 
                });
                req.end();
            } catch (e) {
                reject(e);
            }
        });
    }

    extractPassword(config) {
        // ── Coba field terenkripsi dulu ──
        const encRaw =
            config.encryptedPassword ||
            (config.security && config.security.encryptedPassword) ||
            null;
        if (encRaw) {
            const dec = this._decryptGitHubPassword(encRaw);
            if (dec) return dec;
            // Kalau dekripsi gagal (misal key beda), jangan fallback ke plaintext
            console.log('⚠️ [GitHub] encryptedPassword gagal didekripsi — cek SYSTEM_ID');
            return null;
        }
        // ── Fallback: plaintext (backward compat) ──
        if (config.scriptPassword) return config.scriptPassword;
        if (config.password) return config.password;
        if (config.security && config.security.password) return config.security.password;
        return null;
    }

    /**
     * Dekripsi password dari GitHub yang dienkripsi dengan encrypt-github-password.js
     * Algoritma: AES-256-CBC, key dari PBKDF2(SYSTEM_ID, 'FASTARX_GH_SALT_V1', 100000)
     * Format: "<iv_hex>:<encrypted_base64>"
     */
    _decryptGitHubPassword(encryptedStr) {
        try {
            const systemId = process.env.SYSTEM_ID;
            if (!systemId) throw new Error('SYSTEM_ID tidak di-set di .env');
            const key = crypto.pbkdf2Sync(systemId, 'FASTARX_GH_SALT_V1', 100000, 32, 'sha256');
            const [ivHex, encBase64] = encryptedStr.split(':');
            if (!ivHex || !encBase64) throw new Error('Format tidak valid');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let dec = decipher.update(encBase64, 'base64', 'utf8');
            dec += decipher.final('utf8');
            return dec;
        } catch (e) {
            console.error('[GitHub Decrypt] Error:', e.message);
            return null;
        }
    }

    async updateSecurityFilesWithGitHubPassword(newPassword) {
        console.log('🔄 Updating security files with GitHub password...');

        // ── Deteksi apakah password SCRIPT benar-benar berubah ──
        const passwordChanged = this.scriptPassword && this.scriptPassword !== newPassword;
        if (passwordChanged) {
            console.log('🔑 [2FA] Password script berubah — mencatat waktu untuk grace period...');
            this.notify2FAPasswordChanged('script');
        }

        const secDir = path.join(projectRoot, '.security');
        if (fs.existsSync(secDir)) {
            const timestamp = new Date().toISOString();
            const adminFiles = ['.admin-password-secure', '.secure-backup-marker', '.system-integrity-check'];
            for (const file of this.securityFiles) {
                if (adminFiles.includes(file)) continue; 
                const filePath = path.join(projectRoot, '.security', file);
                try {
                    let fileData = {
                        password: newPassword, timestamp: timestamp, type: 'SECURITY_FILE',
                        filePurpose: file, securityLevel: 'GITHUB_VALIDATED', validatedBy: 'DUAL_GITHUB'
                    };
                    const encryptedData = this.encryptData(JSON.stringify(fileData));
                    const finalData = { ...encryptedData, metadata: { system: 'FA_STARX_BOT', created: timestamp, githubValidated: true } };
                    fs.writeFileSync(filePath, JSON.stringify(finalData, null, 2));
                } catch (error) { 
                    console.log(`❌ Failed to update ${file}`); 
                }
            }
            console.log('✅ Script password files updated with GitHub password');
        } else {
            console.log('🔐 [In-Memory Only] Password updated in memory, skipping disk write.');
        }
        
        this.scriptPassword = newPassword;
        if (passwordChanged) {
            console.log('⏳ [2FA] Grace period 7 hari dimulai untuk 2FA SCRIPT.');
        }
    }

    async showLoginOptions() {
        this.ui.createBox('🔐 SECURE LOGIN', [
            'FA STARX BOT SECURITY SYSTEM', '', '🔑 Login Methods:',
            '1. Administrator Access', '2. Script Password Access', '', 'Select login method:'
        ], 'info');
        return await this.input.question('Select option (1-2)');
    }

    async loginWithAdmin() {
        return await this._loginFlow('admin');
    }

    async loginWithScript() {
        return await this._loginFlow('script');
    }

    /**
     * Unified login flow untuk admin dan script.
     * Jika 2FA aktif: user pilih masuk pakai Password ATAU OTP.
     * Jika 2FA belum ada: masuk pakai password biasa, lalu tawarkan setup 2FA.
     */
    async _loginFlow(level) {
        const tfa = this._get2FA();
        const salt = this._get2FAMasterSalt();
        const status = tfa.getStatus(level, salt);
        const isAdmin = level === 'admin';
        const labelLevel = isAdmin ? 'ADMINISTRATOR' : 'SCRIPT';
        const colorType = isAdmin ? 'warning' : 'info';

        // Notif jika 2FA expired
        if (status.expired) {
            this.ui.showNotification('warning', `2FA ${labelLevel} HANGUS`, [
                'Google Authenticator untuk level ini telah hangus.',
                'Password sudah diubah lebih dari 7 hari yang lalu.',
                'Login dilanjutkan dengan password biasa.'
            ]);
            await this.ui.sleep(1500);
        }

        // Jika 2FA aktif: tampilkan pilihan metode login
        if (status.active) {
            const graceNote = status.inGrace
                ? (() => { const tfa=new TwoFactorAuth(this.dataDir||path.join(projectRoot, '.data')); return status.graceDetail ? `Grace period aktif: ${tfa._fmtRemaining(status.graceDetail)}` : `Grace period aktif: ${status.graceDaysLeft} hari tersisa`; })()
                : '2FA Aktif';

            this.ui.createBox(`PILIH METODE LOGIN — ${labelLevel}`, [
                '',
                '1. Masuk dengan Password',
                '2. Masuk dengan Google Authenticator (OTP)',
                '',
                graceNote,
                ''
            ], colorType);

            const choice = await this.input.question('Pilih metode (1/2)');

            if (choice.trim() === '2') {
                return await this._loginWithOTP(level, tfa, salt, status);
            } else {
                return await this._loginWithPassword(level);
            }
        }

        // 2FA belum ada: login password biasa, tawarkan setup 2FA setelah berhasil
        const result = await this._loginWithPassword(level);
        if (result.success) {
            await this._offerSetup2FA(level, salt, tfa);
        }
        return result;
    }

    /**
     * Login pakai password. Tidak ada cek OTP.
     */
    async _loginWithPassword(level) {
        const isAdmin = level === 'admin';
        const labelLevel = isAdmin ? 'ADMINISTRATOR' : 'SCRIPT';
        const colorType = isAdmin ? 'warning' : 'info';
        const correctPassword = isAdmin ? this.adminPassword : this.scriptPassword;

        this.ui.createBox(`${labelLevel} — MASUK DENGAN PASSWORD`, [
            isAdmin ? 'Full System Access' : 'Standard Bot Access',
            '',
            'Masukkan password untuk melanjutkan:'
        ], colorType);

        let attempts = 0;
        while (attempts < 3) {
            const inputPassword = await this.input.question(`${labelLevel} Password`);
            if (inputPassword === correctPassword) {
                // Cek apakah password berubah sejak 2FA dipasang
                const _tfa = this._get2FA();
                const _salt = this._get2FAMasterSalt();
                _tfa.checkAndUpdatePasswordHash(level, inputPassword, _salt);
                this.ui.showNotification('success', 'Password benar. Selamat datang!');
                await this.ui.sleep(500);
                return { success: true, accessLevel: level };
            } else {
                attempts++;
                const remaining = 3 - attempts;
                if (remaining > 0) {
                    this.ui.showNotification('error', `Wrong password. ${remaining} attempts left`);
                } else {
                    this.ui.showNotification('error', 'ACCESS DENIED');
                    return { success: false, accessLevel: level };
                }
            }
        }
        return { success: false, accessLevel: level };
    }

    /**
     * Login pakai OTP saja. Tidak perlu password.
     */
    async _loginWithOTP(level, tfa, salt, status) {
        const labelLevel = level === 'admin' ? 'ADMINISTRATOR' : 'SCRIPT';
        const secret = tfa.getSecret(level, salt);

        const graceNote = status.inGrace
            ? (() => { const tfa=new TwoFactorAuth(this.dataDir||path.join(projectRoot, '.data')); return status.graceDetail ? `Grace period: ${tfa._fmtRemaining(status.graceDetail)}` : `Grace period: ${status.graceDaysLeft} hari tersisa`; })()
            : '2FA Normal';

        this.ui.createBox(`${labelLevel} — MASUK DENGAN OTP`, [
            'Masukkan kode 6-digit dari Google Authenticator.',
            '',
            graceNote
        ], 'info');

        let attempts = 0;
        while (attempts < 3) {
            const token = await this.input.question('Kode OTP (6-digit)');
            if (tfa.verifyTOTP(secret, token.trim())) {
                // Cek apakah password berubah sejak 2FA dipasang
                const pwOtp = level === 'admin' ? this.adminPassword : this.scriptPassword;
                if (pwOtp) tfa.checkAndUpdatePasswordHash(level, pwOtp, salt);
                this.ui.showNotification('success', 'OTP Verified. Selamat datang!');
                await this.ui.sleep(500);
                return { success: true, accessLevel: level };
            } else {
                attempts++;
                const remaining = 3 - attempts;
                if (remaining > 0) {
                    this.ui.showNotification('error', `Kode OTP salah. ${remaining} percobaan tersisa.`);
                } else {
                    this.ui.showNotification('error', 'OTP GAGAL — Akses ditolak.');
                    return { success: false, accessLevel: level };
                }
            }
        }
        return { success: false, accessLevel: level };
    }

    /**
     * Tawarkan setup 2FA setelah login password berhasil (hanya saat belum ada 2FA).
     */
    async _offerSetup2FA(level, salt, tfa) {
        this.ui.createBox('SETUP GOOGLE AUTHENTICATOR (OPSIONAL)', [
            `Level: ${level.toUpperCase()}`,
            '',
            'Jika dipasang, login berikutnya bisa pilih:',
            '  > Masuk pakai Password, ATAU',
            '  > Masuk pakai kode OTP (tanpa password)',
            '',
            'Catatan:',
            '  2FA ADMIN hanya terikat ke password ADMIN',
            '  2FA SCRIPT hanya terikat ke password SCRIPT',
            '  Jika password diubah, 2FA lama valid 7 hari lagi',
            '',
            'Mau pasang sekarang? (y/n)'
        ], 'info');

        const setup = await this.input.question('Pasang 2FA');
        if (setup.toLowerCase() === 'y') {
            const password = level === 'admin' ? this.adminPassword : this.scriptPassword;
            await this._setup2FA(level, password, salt, tfa);
        } else {
            console.log('2FA tidak dipasang. Login dilanjutkan.');
        }
    }

    // ═══════════════════════════════════════════════════════
    // 2FA HELPERS — dipanggil dari loginWithAdmin/loginWithScript
    // ═══════════════════════════════════════════════════════

    _get2FA() {
        if (!this._twoFA) {
            const dataDir = path.join(projectRoot, '.data');
            this._twoFA = new TwoFactorAuth(dataDir);
        }
        return this._twoFA;
    }

    _get2FAMasterSalt() {
        // Pakai SYSTEM_ID dari .env sebagai master salt, dijamin unik per instalasi
        return process.env.SYSTEM_ID || 'FASTARX_2FA_DEFAULT_SALT';
    }


    /**
     * Panduan setup 2FA: generate secret, tampilkan QR + secret key, minta verifikasi.
     */
    async _setup2FA(level, password, salt, tfa) {
        const secret = tfa.generateSecret();
        const accountName = `FA_STARX_${level.toUpperCase()}`;
        const uri = tfa.buildOtpAuthUri(secret, accountName);
        const qrAscii = tfa.generateQrAscii(uri);

        console.clear();
        console.log('\n' + '═'.repeat(55));
        console.log(`  🔐 SETUP GOOGLE AUTHENTICATOR — ${level.toUpperCase()}`);
        console.log('═'.repeat(55));
        console.log(qrAscii);
        console.log('\n📋 SECRET KEY (ketik manual di Google Authenticator):');
        console.log('\x1b[38;5;214m  ' + secret + '\x1b[0m');
        console.log('\n🔗 OTPAUTH URI (untuk QR generator online):');
        // Potong URI agar tidak terlalu panjang di terminal
        const uriShort = uri.length > 80 ? uri.substring(0, 77) + '...' : uri;
        console.log('\x1b[38;5;51m  ' + uriShort + '\x1b[0m');
        console.log('\n' + '─'.repeat(55));
        console.log('  LANGKAH:');
        console.log('  1. Buka Google Authenticator di HP');
        console.log('  2. Ketuk (+) → "Enter a setup key"');
        console.log('  3. Isi Account: ' + accountName);
        console.log('  4. Isi Key: ' + secret);
        console.log('  5. Pilih "Time based" → Save');
        console.log('─'.repeat(55) + '\n');

        // Minta verifikasi sebelum menyimpan
        let verified = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const token = await this.input.question(`Masukkan kode 6-digit dari GA untuk verifikasi (percobaan ${attempt}/3)`);
            if (tfa.verifyTOTP(secret, token.trim())) {
                verified = true;
                break;
            }
            this.ui.showNotification('error', `❌ Kode salah. ${3 - attempt} percobaan tersisa.`);
        }

        if (!verified) {
            this.ui.showNotification('error', '❌ Verifikasi gagal. 2FA tidak dipasang.');
            await this.ui.sleep(1500);
            return;
        }

        if (tfa.setup(level, secret, password, salt)) {
            this.ui.showNotification('success', '✅ GOOGLE AUTHENTICATOR BERHASIL DIPASANG!', [
                `Level: ${level.toUpperCase()}`,
                '',
                'Saat login berikutnya, Anda akan ditanya kode 2FA.',
                'Kode bisa di-SKIP jika tidak mau verifikasi.',
                '',
                '⚠️ SIMPAN secret key di tempat aman sebagai backup!'
            ]);
            await this.ui.sleep(2500);
        } else {
            this.ui.showNotification('error', '❌ Gagal menyimpan konfigurasi 2FA.');
        }
    }

    /**
     * Dipanggil dari luar saat password berubah, agar grace period dicatat.
     */
    notify2FAPasswordChanged(level) {
        const tfa = this._get2FA();
        const salt = this._get2FAMasterSalt();
        tfa.onPasswordChanged(level, salt);
        console.log(`[2FA] Grace period 7 hari dimulai untuk level: ${level.toUpperCase()}`);
    }

    async verifyAccess(depth = 0) {
        if (this.systemLocked) {
            this.ui.showNotification('error', 'System is locked due to file tampering. Exiting.');
            await this.ui.sleep(3000);
            process.exit(1);
        }
        // FIX: Limit recursion depth to prevent stack overflow on repeated invalid selections
        if (depth >= 5) {
            this.ui.showNotification('error', 'Terlalu banyak pilihan tidak valid. Keluar...');
            process.exit(1);
        }
        const loginChoice = await this.showLoginOptions();
        if (loginChoice === '1') {
            return await this.loginWithAdmin();
        } else if (loginChoice === '2') {
            return await this.loginWithScript();
        } else {
            this.ui.showNotification('error', 'Invalid selection');
            return await this.verifyAccess(depth + 1);
        }
    }

    checkFileStatus() {
        let existing = 0, missing = 0;
        for (const file of this.securityFiles) {
            if (fs.existsSync(path.join(projectRoot, '.security', file))) existing++;
            else missing++;
        }
        return { existing, missing };
    }
    
    close() {
        this.input.close();
    }
}

module.exports = GitHubPasswordSync;
