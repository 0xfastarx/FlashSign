'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * BackupPasswordGuard
 * --------------------
 * Mengelola "Kata Sandi Backup Wallet" — sandi khusus yang wajib dimasukkan
 * sebelum data backup (private key / mnemonic) sebuah wallet ditampilkan.
 *
 * Penyimpanan:
 *   - File terpisah dari .env: <dataDir>/backup_guard.enc
 *   - Sandi TIDAK pernah disimpan sebagai plaintext. Yang disimpan adalah
 *     hash PBKDF2 bergaram (per-sandi salt acak).
 *   - Seluruh blob JSON kemudian dienkripsi AES-256-GCM (authenticated)
 *     dengan key turunan PBKDF2 dari master salt per-chat.
 *   - File di-chmod 0o600 (hanya owner yang bisa baca/tulis).
 *
 * Pola enkripsi mengikuti auth/TwoFactorAuth.js agar konsisten dengan
 * standar keamanan project.
 */
class BackupPasswordGuard {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.guardFile = path.join(dataDir, 'backup_guard.enc');
    }

    // ── Enkripsi file (AES-256-GCM) ────────────────────────────────
    _deriveFileKey(masterSalt) {
        return crypto.pbkdf2Sync(
            'FASTARX_BACKUP_GUARD_KEY_V1',
            String(masterSalt),
            100000, 32, 'sha256'
        );
    }

    _encryptBlob(data, masterSalt) {
        const key = this._deriveFileKey(masterSalt);
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

    _decryptBlob(blob, masterSalt) {
        const key = this._deriveFileKey(masterSalt);
        const iv = Buffer.from(blob.iv, 'hex');
        const tag = Buffer.from(blob.tag, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        let dec = decipher.update(blob.data, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return JSON.parse(dec);
    }

    // ── Hash sandi (PBKDF2 bergaram) ───────────────────────────────
    _hashPassword(password, salt) {
        return crypto.pbkdf2Sync(
            String(password), Buffer.from(salt, 'hex'),
            120000, 32, 'sha256'
        ).toString('hex');
    }

    // ── Persistensi ────────────────────────────────────────────────
    _load(masterSalt) {
        try {
            if (!fs.existsSync(this.guardFile)) return null;
            const raw = JSON.parse(fs.readFileSync(this.guardFile, 'utf8'));
            return this._decryptBlob(raw, masterSalt);
        } catch (e) {
            return null;
        }
    }

    _save(record, masterSalt) {
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }
            const enc = this._encryptBlob(record, masterSalt);
            fs.writeFileSync(this.guardFile, JSON.stringify(enc, null, 2));
            try { fs.chmodSync(this.guardFile, 0o600); } catch (_) {}
            return true;
        } catch (e) {
            return false;
        }
    }

    // ── API Publik ─────────────────────────────────────────────────

    /** Apakah sandi backup sudah pernah dibuat & valid? */
    isSet(masterSalt) {
        const rec = this._load(masterSalt);
        return !!(rec && rec.salt && rec.hash);
    }

    /**
     * Set / timpa sandi backup.
     * @returns {boolean} berhasil tersimpan
     */
    setPassword(password, masterSalt) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = this._hashPassword(password, salt);
        const existing = this._load(masterSalt);
        return this._save({
            salt,
            hash,
            createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
            updatedAt: Date.now(),
            v: '1'
        }, masterSalt);
    }

    /**
     * Verifikasi sandi yang dimasukkan user (timing-safe).
     * @returns {boolean}
     */
    verify(password, masterSalt) {
        const rec = this._load(masterSalt);
        if (!rec || !rec.salt || !rec.hash) return false;
        const candidate = this._hashPassword(password, rec.salt);
        try {
            const a = Buffer.from(candidate, 'hex');
            const b = Buffer.from(rec.hash, 'hex');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch (_) {
            return false;
        }
    }
}

module.exports = BackupPasswordGuard;
