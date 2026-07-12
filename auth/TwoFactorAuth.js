'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TwoFactorAuth {
    constructor(dataDir) {
        const isPkg = typeof process.pkg !== 'undefined';
        const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
        this.dataDir = dataDir || path.join(projectRoot, '.data');
        this.twoFAFile = path.join(this.dataDir, '.2fa_config.enc');
        this._ensureDir();
    }

    _ensureDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    // ── TOTP Core (RFC 6238) ──────────────────────────────────────

    _base32Decode(base32) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0, value = 0;
        const output = [];
        const input = base32.replace(/=+$/, '').toUpperCase();
        for (const char of input) {
            const idx = alphabet.indexOf(char);
            if (idx === -1) continue;
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) {
                output.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return Buffer.from(output);
    }

    _base32Encode(buffer) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0, value = 0, output = '';
        for (let i = 0; i < buffer.length; i++) {
            value = (value << 8) | buffer[i];
            bits += 8;
            while (bits >= 5) {
                output += alphabet[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
        while (output.length % 8) output += '=';
        return output;
    }

    generateSecret() {
        const buf = crypto.randomBytes(20);
        return this._base32Encode(buf);
    }

    generateTOTP(secret, timeStep = 30, digits = 6) {
        const counter = Math.floor(Date.now() / 1000 / timeStep);
        return this._hotp(secret, counter, digits);
    }

    _hotp(secret, counter, digits = 6) {
        const key = this._base32Decode(secret);
        const buf = Buffer.alloc(8);
        let c = counter;
        for (let i = 7; i >= 0; i--) {
            buf[i] = c & 0xff;
            c = Math.floor(c / 256);
        }
        const hmac = crypto.createHmac('sha1', key).update(buf).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code = (
            ((hmac[offset] & 0x7f) << 24) |
            (hmac[offset + 1] << 16) |
            (hmac[offset + 2] << 8) |
            hmac[offset + 3]
        ) % Math.pow(10, digits);
        return code.toString().padStart(digits, '0');
    }

    verifyTOTP(secret, token, window = 1) {
        const timeStep = 30;
        const counter = Math.floor(Date.now() / 1000 / timeStep);
        for (let delta = -window; delta <= window; delta++) {
            if (this._hotp(secret, counter + delta) === token.toString()) {
                return true;
            }
        }
        return false;
    }

    // ── QR Code ASCII (via otpauth URI) ──────────────────────────

    buildOtpAuthUri(secret, accountName, issuer = 'FASTARX BOT') {
        const enc = encodeURIComponent;
        return `otpauth://totp/${enc(issuer)}:${enc(accountName)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
    }

    // QR ASCII menggunakan modul QR sederhana berbasis binary matrix
    generateQrAscii(text) {
        // Mini QR generator: encode sebagai text di URL hint untuk terminal
        // Karena tidak ada library, tampilkan URI dalam format yang mudah di-scan manual
        // plus petunjuk cara manual input
        const lines = [];
        lines.push('┌─────────────────────────────────────────────┐');
        lines.push('│           SCAN KE GOOGLE AUTHENTICATOR      │');
        lines.push('├─────────────────────────────────────────────┤');
        lines.push('│  Buka Google Authenticator → (+) →          │');
        lines.push('│  "Enter a setup key" lalu input:            │');
        lines.push('│                                              │');
        // Tampilkan secret per baris 30 char
        const secret = text.match(/secret=([A-Z2-7=]+)/)?.[1] || '';
        const account = decodeURIComponent(text.match(/totp\/[^:]+:([^?]+)/)?.[1] || 'FASTARX');
        const issuer = decodeURIComponent(text.match(/issuer=([^&]+)/)?.[1] || 'FASTARX BOT');
        lines.push(`│  Account : ${account.padEnd(33)}│`);
        lines.push(`│  Issuer  : ${issuer.padEnd(33)}│`);
        lines.push('│                                              │');
        lines.push('│  ATAU scan QR via URL:                      │');
        lines.push('│  https://api.qrserver.com/v1/create-qr-     │');
        lines.push('│  code/?size=200x200&data=<URI di bawah>     │');
        lines.push('└─────────────────────────────────────────────┘');
        return lines.join('\n');
    }

    // ── Penyimpanan 2FA Terenkripsi ────────────────────────────────

    _deriveKey(masterSalt) {
        // Key derivasi sederhana dari salt tetap
        return crypto.pbkdf2Sync(
            'FASTARX_2FA_KEY_V1',
            masterSalt,
            100000, 32, 'sha256'
        );
    }

    _encryptData(data, masterSalt) {
        const key = this._deriveKey(masterSalt);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        enc += cipher.final('hex');
        const tag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            data: enc,
            tag: tag.toString('hex'),
            v: '1'
        };
    }

    _decryptData(blob, masterSalt) {
        const key = this._deriveKey(masterSalt);
        const iv = Buffer.from(blob.iv, 'hex');
        const tag = Buffer.from(blob.tag, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        let dec = decipher.update(blob.data, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return JSON.parse(dec);
    }

    load(masterSalt) {
        try {
            if (!fs.existsSync(this.twoFAFile)) return {};
            const raw = JSON.parse(fs.readFileSync(this.twoFAFile, 'utf8'));
            return this._decryptData(raw, masterSalt);
        } catch (e) {
            return {};
        }
    }

    save(config, masterSalt) {
        try {
            const enc = this._encryptData(config, masterSalt);
            fs.writeFileSync(this.twoFAFile, JSON.stringify(enc, null, 2));
            try { fs.chmodSync(this.twoFAFile, 0o600); } catch (_) {}
            return true;
        } catch (e) {
            console.error('[2FA] Gagal menyimpan config 2FA:', e.message);
            return false;
        }
    }

    // ── API Publik ─────────────────────────────────────────────────

    /**
     * Setup 2FA baru untuk level tertentu ('admin' | 'script').
     * Menyimpan: secret, passwordHash, createdAt, passwordChangedAt, active.
     */
    setup(level, secret, password, masterSalt) {
        const config = this.load(masterSalt);
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        config[level] = {
            secret,
            passwordHash,
            createdAt: Date.now(),
            passwordChangedAt: null,   // null = belum pernah ganti password sejak setup
            active: true
        };
        return this.save(config, masterSalt);
    }

    /**
     * Dipanggil saat password diganti. Catat waktu ganti password.
     * 2FA tetap valid selama 7 hari grace period.
     */
    onPasswordChanged(level, masterSalt) {
        const config = this.load(masterSalt);
        if (!config[level]) return;
        config[level].passwordChangedAt = Date.now();
        this.save(config, masterSalt);
    }

    /**
     * Dipanggil saat LOGIN BERHASIL dengan password.
     * Bandingkan hash password sekarang vs hash yang tersimpan.
     * Kalau berbeda → password sudah diganti → mulai grace period.
     * Ini cara yang reliable karena tidak bergantung pada timing GitHub sync.
     */
    checkAndUpdatePasswordHash(level, currentPassword, masterSalt) {
        const config = this.load(masterSalt);
        if (!config[level] || !config[level].active) return;

        const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');
        const storedHash  = config[level].passwordHash;

        // Kalau hash berbeda dan belum ada passwordChangedAt (atau sudah lebih lama dari yg tersimpan)
        if (storedHash && storedHash !== currentHash) {
            // Password berubah! Catat sekarang
            console.log(`[2FA] Password ${level.toUpperCase()} berubah terdeteksi — memulai grace period...`);
            config[level].passwordChangedAt = Date.now();
            config[level].passwordHash = currentHash; // update hash ke yang baru
            this.save(config, masterSalt);
        } else if (!storedHash) {
            // Hash belum pernah disimpan (2FA lama) — simpan sekarang
            config[level].passwordHash = currentHash;
            this.save(config, masterSalt);
        }
    }

    /**
     * Cek status 2FA untuk level tertentu.
     * Return: { exists, active, expired, graceDaysLeft, graceDetail, passwordChangedAt, createdAt }
     */
    getStatus(level, masterSalt) {
        const config = this.load(masterSalt);
        const entry = config[level];
        if (!entry || !entry.active) return { exists: !!entry, active: false, expired: !!entry, graceDaysLeft: 0 };

        const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
        if (entry.passwordChangedAt) {
            const elapsed = Date.now() - entry.passwordChangedAt;
            const remaining = GRACE_MS - elapsed;
            if (remaining <= 0) {
                // Auto-expire
                config[level].active = false;
                this.save(config, masterSalt);
                return {
                    exists: true, active: false, expired: true, graceDaysLeft: 0,
                    passwordChangedAt: entry.passwordChangedAt,
                    createdAt: entry.createdAt
                };
            }
            // Hitung sisa waktu presisi
            const totalSec  = Math.floor(remaining / 1000);
            const days      = Math.floor(totalSec / 86400);
            const hours     = Math.floor((totalSec % 86400) / 3600);
            const minutes   = Math.floor((totalSec % 3600) / 60);
            const seconds   = totalSec % 60;
            return {
                exists: true, active: true, expired: false, inGrace: true,
                graceDaysLeft: days,
                graceDetail: { days, hours, minutes, seconds, totalSec },
                passwordChangedAt: entry.passwordChangedAt,
                createdAt: entry.createdAt
            };
        }

        return {
            exists: true, active: true, expired: false, graceDaysLeft: null, inGrace: false,
            createdAt: entry.createdAt
        };
    }

    /**
     * Hapus 2FA untuk level tertentu.
     */
    remove(level, masterSalt) {
        const config = this.load(masterSalt);
        delete config[level];
        return this.save(config, masterSalt);
    }

    getSecret(level, masterSalt) {
        const config = this.load(masterSalt);
        return config[level]?.secret || null;
    }

    /**
     * Format timestamp ke string lengkap: DD/MM/YYYY HH:MM:SS
     */
    _fmtDateTime(ts) {
        if (!ts) return '?';
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * Format sisa waktu grace period: "X hari Y jam Z menit W detik"
     * Hanya tampilkan unit yang relevan (hapus unit 0 terdepan).
     */
    _fmtRemaining(detail) {
        const { days, hours, minutes, seconds } = detail;
        const parts = [];
        if (days > 0)    parts.push(`${days} hari`);
        if (hours > 0)   parts.push(`${hours} jam`);
        if (minutes > 0) parts.push(`${minutes} menit`);
        // Selalu tampilkan detik agar terasa real-time
        parts.push(`${seconds} detik`);
        return parts.join(' ');
    }

    /**
     * Format status 2FA menjadi string siap tampil.
     * Selalu hitung ulang sisa waktu secara real-time hingga detik.
     */
    formatStatus(level, masterSalt) {
        const status = this.getStatus(level, masterSalt);
        const lbl = level.toUpperCase();

        if (!status.exists) {
            return { icon: '⬜', line1: `2FA ${lbl}: Belum dipasang`, lines: [], status: 'none' };
        }
        if (status.expired) {
            const changedStr = this._fmtDateTime(status.passwordChangedAt);
            return {
                icon: '🔴',
                line1: `2FA ${lbl}: HANGUS`,
                lines: [
                    `Password diubah  : ${changedStr}`,
                    `Grace period sudah >7 hari. Setup ulang dengan password baru.`
                ],
                status: 'expired'
            };
        }
        if (status.inGrace) {
            const changedStr  = this._fmtDateTime(status.passwordChangedAt);
            const expireTs    = status.passwordChangedAt + (7 * 24 * 60 * 60 * 1000);
            const expireStr   = this._fmtDateTime(expireTs);
            const remaining   = this._fmtRemaining(status.graceDetail);
            return {
                icon: '🟡',
                line1: `2FA ${lbl}: GRACE PERIOD`,
                lines: [
                    `Password diubah  : ${changedStr}`,
                    `Hangus pada      : ${expireStr}`,
                    `Sisa masa aktif  : ${remaining}`
                ],
                status: 'grace'
            };
        }
        // Normal aktif
        const createdStr = this._fmtDateTime(status.createdAt);
        return {
            icon: '🟢',
            line1: `2FA ${lbl}: AKTIF`,
            lines: [
                `Dipasang         : ${createdStr}`,
                `Login bisa pakai Password atau OTP`
            ],
            status: 'active'
        };
    }

    /**
     * Render untuk Telegram (pakai \n, bisa Markdown bold)
     */
    renderTelegram(level, masterSalt) {
        const f = this.formatStatus(level, masterSalt);
        let text = `${f.icon} *${f.line1}*`;
        if (f.lines && f.lines.length > 0) {
            text += '\n' + f.lines.map(l => `   ${l}`).join('\n');
        }
        return text;
    }

    /**
     * Render untuk CLI terminal
     */
    renderCLI(level, masterSalt) {
        const f = this.formatStatus(level, masterSalt);
        let text = `${f.icon} ${f.line1}`;
        if (f.lines && f.lines.length > 0) {
            text += '\n' + f.lines.map(l => `   ${l}`).join('\n');
        }
        return text;
    }
}

module.exports = TwoFactorAuth;
