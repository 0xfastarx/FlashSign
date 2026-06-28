'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ModernUI = require('../core/ModernUI');
const ui = new ModernUI();

// ===== ENHANCED SECURE CONFIG
// ===== ENHANCED SECURE CONFIG MANAGER =====
class EnhancedSecureConfigManager {
    constructor() {
        const isPkg = typeof process.pkg !== 'undefined';
        const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
        this.configFile = path.join(projectRoot, 'multi-account-bot-config.enc');
    }

    saveMultipleAccounts(accounts, password) {
        try {
            const accountsData = {
                version: "2.1",
                accounts: accounts,
                lastUpdated: new Date().toISOString(),
                totalAccounts: accounts.length
            };
            const encrypted = this.encrypt(JSON.stringify(accountsData), password);
            fs.writeFileSync(this.configFile, encrypted);
            ui.showNotification('success', `Saved ${accounts.length} account configurations`);
            return true;
        } catch (error) {
            ui.showNotification('error', `Failed to save accounts: ${error.message}`);
            return false;
        }
    }

    loadMultipleAccounts(password) {
        try {
            if (!fs.existsSync(this.configFile)) {
                return [];
            }
            const encrypted = fs.readFileSync(this.configFile, 'utf8');
            const decrypted = this.decrypt(encrypted, password);
            const accountsData = JSON.parse(decrypted);

            if (accountsData.version === "2.0") {
                accountsData.accounts.forEach(acc => {
                    if (!acc.accountName) {
                        acc.accountName = 'Unnamed';
                    }
                });
                accountsData.version = "2.1";
            }

            return accountsData.accounts;
        } catch (error) {
            throw new Error(`Failed to load accounts: ${error.message}`);
        }
    }

    addAccount(newAccount, password) {
        try {
            const accounts = this.loadMultipleAccounts(password);

            const exists = accounts.some(acc =>
                acc.fromAddress === newAccount.fromAddress &&
                acc.network === newAccount.network &&
                acc.tokenAddress === newAccount.tokenAddress
            );

            if (exists) {
                ui.showNotification('warning', 'Account configuration already exists');
                return false;
            }

            accounts.push({
                ...newAccount,
                lastUsed: new Date().toLocaleString(),
                created: new Date().toISOString(),
                id: this.generateAccountId(newAccount.fromAddress, newAccount.network, newAccount.tokenAddress)
            });

            return this.saveMultipleAccounts(accounts, password);
        } catch (error) {
            ui.showNotification('error', `Failed to add account: ${error.message}`);
            return false;
        }
    }

    deleteAccount(accountIndex, password) {
        try {
            const accounts = this.loadMultipleAccounts(password);
            if (accountIndex >= 0 && accountIndex < accounts.length) {
                const deletedAccount = accounts.splice(accountIndex, 1)[0];
                this.saveMultipleAccounts(accounts, password);
                ui.showNotification('success', `Configuration for ${this.maskAddress(deletedAccount.fromAddress)} removed`);
                return true;
            }
            return false;
        } catch (error) {
            ui.showNotification('error', `Failed to delete account: ${error.message}`);
            return false;
        }
    }

    getAllAccounts(password) {
        return this.loadMultipleAccounts(password);
    }

    getAccountCount(password) {
        try {
            const accounts = this.loadMultipleAccounts(password);
            return accounts.length;
        } catch (error) {
            return 0;
        }
    }

    generateAccountId(fromAddress, network, tokenAddress = null) {
        const baseId = `${fromAddress}-${network}`;
        return tokenAddress ? `${baseId}-${tokenAddress}` : baseId;
    }

    maskAddress(address) {
        if (!address || address.length < 10) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    encrypt(text, password) {
        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        const result = { encrypted, iv: iv.toString('hex'), salt: salt.toString('hex'), authTag: authTag.toString('hex') };
        return Buffer.from(JSON.stringify(result)).toString('base64');
    }

    decrypt(encryptedData, password) {
        const data = JSON.parse(Buffer.from(encryptedData, 'base64').toString());
        const salt = Buffer.from(data.salt, 'hex');
        const iv = Buffer.from(data.iv, 'hex');
        const authTag = Buffer.from(data.authTag, 'hex');
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
}

const enhancedConfigManager = new EnhancedSecureConfigManager();

module.exports = { EnhancedSecureConfigManager, enhancedConfigManager };