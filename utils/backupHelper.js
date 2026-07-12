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
    const solanaRpcFile = path.join(dataDir, `${idStr}_solana-rpc-config.json`);
    const aptosRpcFile = path.join(dataDir, `${idStr}_aptos-rpc-config.json`);
    const suiRpcFile = path.join(dataDir, `${idStr}_sui-rpc-config.json`);
    const tonRpcFile = path.join(dataDir, `${idStr}_ton-rpc-config.json`);
    const nearRpcFile = path.join(dataDir, `${idStr}_near-rpc-config.json`);
    const morseDbFile = path.join(dataDir, '.morse-messages-secure.json');

    // Baca konten masing-masing file jika ada
    const masterKey = fs.existsSync(masterKeyFile) ? fs.readFileSync(masterKeyFile).toString('base64') : null;
    const wallets = fs.existsSync(walletsFile) ? fs.readFileSync(walletsFile).toString('base64') : null;
    const rpcConfig = fs.existsSync(rpcConfigFile) ? fs.readFileSync(rpcConfigFile, 'utf8') : null;
    const rpcPorts = fs.existsSync(rpcPortsFile) ? fs.readFileSync(rpcPortsFile, 'utf8') : null;
    const solanaRpc = fs.existsSync(solanaRpcFile) ? fs.readFileSync(solanaRpcFile, 'utf8') : null;
    const aptosRpc = fs.existsSync(aptosRpcFile) ? fs.readFileSync(aptosRpcFile, 'utf8') : null;
    const suiRpc = fs.existsSync(suiRpcFile) ? fs.readFileSync(suiRpcFile, 'utf8') : null;
    const tonRpc = fs.existsSync(tonRpcFile) ? fs.readFileSync(tonRpcFile, 'utf8') : null;
    const nearRpc = fs.existsSync(nearRpcFile) ? fs.readFileSync(nearRpcFile, 'utf8') : null;

    // Backup explorer API keys
    const explorerKeysFile = path.join(dataDir, `${idStr}_explorer_keys.enc`);
    const explorerKeys = fs.existsSync(explorerKeysFile) ? fs.readFileSync(explorerKeysFile).toString('base64') : null;

    // Backup password guard (per-user subfolder)
    const backupGuardFile = path.join(dataDir, `user_${idStr}`, 'backup_guard.enc');
    const backupGuard = fs.existsSync(backupGuardFile) ? fs.readFileSync(backupGuardFile).toString('base64') : null;

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

    // Backup tracked wallets (.enc / .json)
    const trackedWalletsEnc = path.join(dataDir, `${idStr}_tracked_wallets.enc`);
    const trackedWalletsJson = path.join(dataDir, `${idStr}_tracked_wallets.json`);
    let trackedWallets = null;
    if (fs.existsSync(trackedWalletsEnc)) {
        trackedWallets = fs.readFileSync(trackedWalletsEnc).toString('base64');
    } else if (fs.existsSync(trackedWalletsJson)) {
        trackedWallets = fs.readFileSync(trackedWalletsJson).toString('base64');
    }

    // Backup tracker history (.enc / .json)
    const trackerHistoryEnc = path.join(dataDir, `${idStr}_tracker_history.enc`);
    const trackerHistoryJson = path.join(dataDir, `${idStr}_tracker_history.json`);
    let trackerHistory = null;
    if (fs.existsSync(trackerHistoryEnc)) {
        trackerHistory = fs.readFileSync(trackerHistoryEnc).toString('base64');
    } else if (fs.existsSync(trackerHistoryJson)) {
        trackerHistory = fs.readFileSync(trackerHistoryJson).toString('base64');
    }

    // Backup tracker state (.enc / .json)
    const trackerStateEnc = path.join(dataDir, `${idStr}_tracker_state.enc`);
    const trackerStateJson = path.join(dataDir, `${idStr}_tracker_state.json`);
    let trackerState = null;
    if (fs.existsSync(trackerStateEnc)) {
        trackerState = fs.readFileSync(trackerStateEnc).toString('base64');
    } else if (fs.existsSync(trackerStateJson)) {
        trackerState = fs.readFileSync(trackerStateJson).toString('base64');
    }

    // Backup manual RPCs (.enc / .json)
    const manualRpcsEnc = path.join(dataDir, `${idStr}_manual_rpcs.enc`);
    const manualRpcsJson = path.join(dataDir, `${idStr}_manual_rpcs.json`);
    let manualRpcs = null;
    if (fs.existsSync(manualRpcsEnc)) {
        manualRpcs = fs.readFileSync(manualRpcsEnc).toString('base64');
    } else if (fs.existsSync(manualRpcsJson)) {
        manualRpcs = fs.readFileSync(manualRpcsJson).toString('base64');
    }

    // Backup manual tokens (.enc / .json)
    const manualTokensEnc = path.join(dataDir, `${idStr}_manual_tokens.enc`);
    const manualTokensJson = path.join(dataDir, `${idStr}_manual_tokens.json`);
    let manualTokens = null;
    if (fs.existsSync(manualTokensEnc)) {
        manualTokens = fs.readFileSync(manualTokensEnc).toString('base64');
    } else if (fs.existsSync(manualTokensJson)) {
        manualTokens = fs.readFileSync(manualTokensJson).toString('base64');
    }

    // Satukan payload
    const payload = {
        masterKey,
        wallets,
        rpcConfig,
        rpcPorts,
        solanaRpc,
        aptosRpc,
        suiRpc,
        tonRpc,
        nearRpc,
        explorerKeys,
        backupGuard,
        morseMessages,
        trackedWallets,
        trackerHistory,
        trackerState,
        manualRpcs,
        manualTokens
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
 * Helper to check if a decoded buffer is plain JSON.
 */
function isPlainJson(buffer) {
    try {
        const str = buffer.toString('utf8').trim();
        return (str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'));
    } catch (_) {
        return false;
    }
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

    // Tulis ulang file ke folder .data/ dengan ID baru
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
    if (payload.solanaRpc) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_solana-rpc-config.json`), payload.solanaRpc, 'utf8');
    }
    if (payload.aptosRpc) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_aptos-rpc-config.json`), payload.aptosRpc, 'utf8');
    }
    if (payload.suiRpc) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_sui-rpc-config.json`), payload.suiRpc, 'utf8');
    }
    if (payload.tonRpc) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_ton-rpc-config.json`), payload.tonRpc, 'utf8');
    }
    if (payload.nearRpc) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_near-rpc-config.json`), payload.nearRpc, 'utf8');
    }

    // Restore explorer API keys
    if (payload.explorerKeys) {
        fs.writeFileSync(path.join(dataDir, `${idStr}_explorer_keys.enc`), Buffer.from(payload.explorerKeys, 'base64'));
    }

    // Restore backup password guard
    if (payload.backupGuard) {
        const userDir = path.join(dataDir, `user_${idStr}`);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
        const guardFile = path.join(userDir, 'backup_guard.enc');
        fs.writeFileSync(guardFile, Buffer.from(payload.backupGuard, 'base64'));
        try { fs.chmodSync(guardFile, 0o600); } catch (_) {}
    }

    // Restore tracked wallets
    if (payload.trackedWallets) {
        const decoded = Buffer.from(payload.trackedWallets, 'base64');
        if (isPlainJson(decoded)) {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracked_wallets.json`), decoded);
        } else {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracked_wallets.enc`), decoded);
        }
    }

    // Restore tracker history
    if (payload.trackerHistory) {
        const decoded = Buffer.from(payload.trackerHistory, 'base64');
        if (isPlainJson(decoded)) {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracker_history.json`), decoded);
        } else {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracker_history.enc`), decoded);
        }
    }

    // Restore tracker state
    if (payload.trackerState) {
        const decoded = Buffer.from(payload.trackerState, 'base64');
        if (isPlainJson(decoded)) {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracker_state.json`), decoded);
        } else {
            fs.writeFileSync(path.join(dataDir, `${idStr}_tracker_state.enc`), decoded);
        }
    }

    // Restore manual RPCs
    if (payload.manualRpcs) {
        const decoded = Buffer.from(payload.manualRpcs, 'base64');
        if (isPlainJson(decoded)) {
            fs.writeFileSync(path.join(dataDir, `${idStr}_manual_rpcs.json`), decoded);
        } else {
            fs.writeFileSync(path.join(dataDir, `${idStr}_manual_rpcs.enc`), decoded);
        }
    }

    // Restore manual tokens
    if (payload.manualTokens) {
        const decoded = Buffer.from(payload.manualTokens, 'base64');
        if (isPlainJson(decoded)) {
            fs.writeFileSync(path.join(dataDir, `${idStr}_manual_tokens.json`), decoded);
        } else {
            fs.writeFileSync(path.join(dataDir, `${idStr}_manual_tokens.enc`), decoded);
        }
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
