'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Mencadangkan semua file konfigurasi & data pengguna ke dalam string JSON terenkripsi.
 * @param {string|number} chatId ID telegram user
 * @param {string} password Password pengaman
 * @param {string} dataDir Direktori tempat menyimpan data
 * @returns {Buffer} Buffer data backup terenkripsi (JSON format)
 */
function createBackup(chatId, password, dataDir) {
    const idStr = chatId.toString();
    
    // Tentukan path file milik user
    const masterKeyFile = path.join(dataDir, `${idStr}_master.key`);
    const walletsFile = path.join(dataDir, `${idStr}_wallets.enc`);
    const rpcConfigFile = path.join(dataDir, `${idStr}_rpc-config.json`);
    const rpcPortsFile = path.join(dataDir, `${idStr}_rpc-ports.json`);
    const morseDbFile = path.join(dataDir, '.morse-messages-secure.json');

    // Baca konten masing-masing file jika ada
    const masterKey = fs.existsSync(masterKeyFile) ? fs.readFileSync(masterKeyFile).toString('base64') : null;
    const wallets = fs.existsSync(walletsFile) ? fs.readFileSync(walletsFile).toString('base64') : null;
    const rpcConfig = fs.existsSync(rpcConfigFile) ? fs.readFileSync(rpcConfigFile, 'utf8') : null;
    const rpcPorts = fs.existsSync(rpcPortsFile) ? fs.readFileSync(rpcPortsFile, 'utf8') : null;

    // Baca pesan morse user
    let morseMessages = [];
    if (fs.existsSync(morseDbFile)) {
        try {
            const allMorse = JSON.parse(fs.readFileSync(morseDbFile, 'utf8'));
            if (Array.isArray(allMorse)) {
                morseMessages = allMorse.filter(m => m.chatId === idStr);
            }
        } catch (e) {
            console.error('⚠️ [Backup] Gagal membaca pesan morse:', e.message);
        }
    }

    // Satukan payload
    const payload = {
        masterKey,
        wallets,
        rpcConfig,
        rpcPorts,
        morseMessages
    };

    const payloadStr = JSON.stringify(payload);

    // Enkripsi payload dengan password
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(payloadStr, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const backupJson = {
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        ciphertext: encrypted
    };

    return Buffer.from(JSON.stringify(backupJson, null, 2), 'utf-8');
}

/**
 * Mendekripsi file backup dan memulihkan seluruh data ke file system.
 * @param {string|number} chatId ID telegram user tujuan
 * @param {string} password Password dekripsi
 * @param {object} backupObj Object backup terenkripsi (berisi salt, iv, ciphertext)
 * @param {string} dataDir Direktori tempat menyimpan data
 */
function restoreBackup(chatId, password, backupObj, dataDir) {
    if (!backupObj || !backupObj.salt || !backupObj.iv || !backupObj.ciphertext) {
        throw new Error('Format file backup tidak valid atau rusak');
    }

    const idStr = chatId.toString();
    const salt = Buffer.from(backupObj.salt, 'hex');
    const iv = Buffer.from(backupObj.iv, 'hex');

    // Derivasi key dan dekripsi
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(backupObj.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    // Parse payload hasil dekripsi
    const payload = JSON.parse(decrypted);

    // Pastikan dataDir ada
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Tulis ulang file ke folder data/ dengan ID baru
    if (payload.masterKey) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_master.key`), Buffer.from(payload.masterKey, 'base64'));
    }
    if (payload.wallets) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_wallets.enc`), Buffer.from(payload.wallets, 'base64'));
    }
    if (payload.rpcConfig) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_rpc-config.json`), payload.rpcConfig, 'utf8');
    }
    if (payload.rpcPorts) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_rpc-ports.json`), payload.rpcPorts, 'utf8');
    }

    // Gabungkan data morse
    if (Array.isArray(payload.morseMessages) && payload.morseMessages.length > 0) {
        const morseDbFile = path.join(dataDir, '.morse-messages-secure.json');
        let existingMorse = [];
        if (fs.existsSync(morseDbFile)) {
            try {
                existingMorse = JSON.parse(fs.readFileSync(morseDbFile, 'utf8'));
                if (!Array.isArray(existingMorse)) existingMorse = [];
            } catch (e) {
                console.error('⚠️ [Restore] Gagal membaca existing morse:', e.message);
            }
        }

        // Update chatId dan merge
        for (const msg of payload.morseMessages) {
            msg.chatId = idStr; // Migrasikan ke ID user yang baru
            
            // Hapus duplikat ID lama jika ada, lalu masukkan yang baru
            existingMorse = existingMorse.filter(m => m.id !== msg.id);
            existingMorse.push(msg);
        }

        fs.writeFileSync(morseDbFile, JSON.stringify(existingMorse, null, 2), 'utf8');
    }
}

module.exports = {
    createBackup,
    restoreBackup
};
