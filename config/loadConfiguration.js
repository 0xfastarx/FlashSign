'use strict';
const crypto = require('crypto');

const integrityGuard = require('../core/integrityGuard');

class EnvDecryptor {
    decryptValue(encryptedValue) {
        if (!encryptedValue) return null;
        const parts = encryptedValue.split(':');
        if (parts.length !== 2) return null;

        const encryptedData = parts[0];
        const iv = Buffer.from(parts[1], 'hex');

        // Coba 1: Menggunakan liveHash
        try {
            const liveHash = integrityGuard.calculateProjectHash();
            const key = crypto.pbkdf2Sync(
                'FASTARX_CONFIG_KEY_2024' + liveHash,
                'CONFIG_SALT_2024',
                50000, 32, 'sha256'
            );
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {}

        // Coba 2: Menggunakan approvedHash
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

        // Coba 3: Menggunakan static key
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
// == LOAD CONFIGURATION
// ===================================

function loadConfiguration() {
    console.log('🔒 Memuat konfigurasi terenkripsi...');
    
    if (!process.env.ADMIN_PASSWORD_ENCRYPTED || !process.env.SYSTEM_ID) {
        console.error('❌ FATAL ERROR: File .env tidak ditemukan atau tidak lengkap.');
        process.exit(1);
    }

    const envDecryptor = new EnvDecryptor();
    const config = {};

    try {
        config.ADMIN_PASSWORD = envDecryptor.decryptValue(process.env.ADMIN_PASSWORD_ENCRYPTED);
        config.SCRIPT_PASSWORD = envDecryptor.decryptValue(process.env.SCRIPT_PASSWORD_ENCRYPTED);
        config.GITHUB_MAIN_URL = envDecryptor.decryptValue(process.env.GITHUB_MAIN_URL_ENCRYPTED);
        config.GITHUB_BACKUP_URL = envDecryptor.decryptValue(process.env.GITHUB_BACKUP_URL_ENCRYPTED);
        config.ENCRYPTION_SALT = envDecryptor.decryptValue(process.env.ENCRYPTION_SALT_ENCRYPTED);
        config.TELEGRAM_BOT_TOKEN = envDecryptor.decryptValue(process.env.TELEGRAM_BOT_TOKEN_ENCRYPTED);
        config.WALLETCONNECT_PROJECT_ID = envDecryptor.decryptValue(process.env.WALLETCONNECT_PROJECT_ID_ENCRYPTED);
        // DEFAULT_RPC sudah tidak wajib — dikelola via menu RPC Management di bot
        config.DEFAULT_RPC_URL = process.env.DEFAULT_RPC_URL_ENCRYPTED
            ? envDecryptor.decryptValue(process.env.DEFAULT_RPC_URL_ENCRYPTED)
            : null;
        config.DEFAULT_RPC_CHAIN_ID = process.env.DEFAULT_RPC_CHAIN_ID_ENCRYPTED
            ? parseInt(envDecryptor.decryptValue(process.env.DEFAULT_RPC_CHAIN_ID_ENCRYPTED), 10) || null
            : null;

        // Owner & Admin Chat ID — terenkripsi (fallback ke plain jika format lama)
        config.OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID_ENCRYPTED
            ? envDecryptor.decryptValue(process.env.OWNER_TELEGRAM_ID_ENCRYPTED)
            : (process.env.OWNER_TELEGRAM_ID ? process.env.OWNER_TELEGRAM_ID.trim() : null);

        config.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID_ENCRYPTED
            ? envDecryptor.decryptValue(process.env.ADMIN_CHAT_ID_ENCRYPTED)
            : (process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null);

        // Validasi — skip key yang memang opsional
        const optionalKeys = [
            'TELEGRAM_BOT_TOKEN', 'OWNER_TELEGRAM_ID', 'ADMIN_CHAT_ID',
            'DEFAULT_RPC_URL', 'DEFAULT_RPC_CHAIN_ID' // opsional — dikelola via bot
        ];
        for (const key in config) {
            if (!config[key] && !optionalKeys.includes(key)) {
                throw new Error(`Gagal mendekripsi "${key}" dari .env`);
            }
        }

    } catch (error) {
        console.error('❌ FATAL ERROR:', error.message);
        process.exit(1);
    }
    
    console.log('✅ Konfigurasi berhasil dimuat.');
    return config;
}

module.exports = { EnvDecryptor, loadConfiguration };
