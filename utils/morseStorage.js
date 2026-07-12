'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isPkg = typeof process.pkg !== 'undefined';
const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DATA_DIR = path.join(projectRoot, '.data');
const FILE_PATH = path.join(DATA_DIR, '.morse-messages-secure.json');
const OLD_FILE_PATH = path.join(projectRoot, '.morse-messages-secure.json');

// Auto-migrasi: pindahkan file lama ke folder data/ jika ada
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(OLD_FILE_PATH) && !fs.existsSync(FILE_PATH)) {
    try {
        fs.renameSync(OLD_FILE_PATH, FILE_PATH);
        console.log('✅ [Morse] Migrasi data dari root → data/ berhasil.');
    } catch (e) {
        console.error('⚠️ [Morse] Gagal migrasi:', e.message);
    }
}

const SYSTEM_PASSPHRASE = "fery-morse-secure-passphrase-2026-system-storage";
const SYSTEM_SALT = "fery-storage-salt-9876";
const SYSTEM_KEY = crypto.scryptSync(SYSTEM_PASSPHRASE, SYSTEM_SALT, 32);

function loadRawMessages() {
    if (!fs.existsSync(FILE_PATH)) {
        return [];
    }
    try {
        const content = fs.readFileSync(FILE_PATH, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error('Failed to parse morse messages database:', e);
        return [];
    }
}

function saveRawMessages(messages) {
    try {
        fs.writeFileSync(FILE_PATH, JSON.stringify(messages, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('Failed to save morse messages database:', e);
        return false;
    }
}

function encrypt(text, key, iv) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

function decrypt(encryptedText, key, iv) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function saveMessage({ chatId, morseCode, fileName, password, customName }) {
    const messages = loadRawMessages();
    const id = 'msg_' + crypto.randomBytes(8).toString('hex');
    const timestamp = new Date().toISOString();
    
    let key;
    let saltHex = crypto.randomBytes(16).toString('hex');
    let ivHex = crypto.randomBytes(16).toString('hex');
    let passwordHash = null;
    let isPasswordProtected = false;

    if (password) {
        key = crypto.scryptSync(password, saltHex, 32);
        passwordHash = hashPassword(password, saltHex);
        isPasswordProtected = true;
    } else {
        key = SYSTEM_KEY;
        saltHex = SYSTEM_SALT;
    }

    // HANYA morseCode dan fileName yang disimpan — data asli TIDAK pernah disimpan
    const payload = JSON.stringify({ morseCode, fileName });
    const encryptedContent = encrypt(payload, key, Buffer.from(ivHex, 'hex'));

    const newMessage = {
        id,
        chatId: chatId.toString(),
        timestamp,
        customName: customName || `Pesan ${new Date(timestamp).toLocaleString('id-ID')}`,
        isPasswordProtected,
        passwordHash,
        encryptedContent,
        iv: ivHex,
        salt: saltHex
    };

    messages.push(newMessage);
    saveRawMessages(messages);
    return newMessage;
}

function getMessagesByChatId(chatId) {
    const messages = loadRawMessages();
    return messages.filter(m => m.chatId === chatId.toString());
}

function getMessageById(id) {
    const messages = loadRawMessages();
    return messages.find(m => m.id === id);
}

function deleteMessage(id) {
    let messages = loadRawMessages();
    const initialLength = messages.length;
    messages = messages.filter(m => m.id !== id);
    if (messages.length !== initialLength) {
        saveRawMessages(messages);
        return true;
    }
    return false;
}

function decryptMessage(message, password) {
    let key;
    if (message.isPasswordProtected) {
        if (!password) throw new Error('Password required to decrypt this message');
        // Verify password hash
        const hash = hashPassword(password, message.salt);
        if (hash !== message.passwordHash) {
            throw new Error('Incorrect password');
        }
        key = crypto.scryptSync(password, message.salt, 32);
    } else {
        key = SYSTEM_KEY;
    }

    const decrypted = decrypt(message.encryptedContent, key, Buffer.from(message.iv, 'hex'));
    return JSON.parse(decrypted);
}

module.exports = {
    saveMessage,
    getMessagesByChatId,
    getMessageById,
    deleteMessage,
    decryptMessage
};
