'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const SignClient = require('@walletconnect/sign-client').default;
const TelegramBot = require('node-telegram-bot-api');
const MetaMaskRpcServer = require('../rpc/MetaMaskRpcServer');
const { globalTxQueue } = require('../core/TransactionQueue');
const TwoFactorAuth = require('../auth/TwoFactorAuth');
const { Keypair, VersionedTransaction, Transaction, nacl } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const { Account: AptosAccount } = require('@aptos-labs/ts-sdk');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');

class CryptoAutoTx {
    constructor(rl, secureConfig, sessionId) {
        this.config = secureConfig;
        this.rl = rl;
        this.sessionId = sessionId;

        // FIX: Added theme for mnemonic display coloring in CLI mode
        this.theme = {
            warning: '\x1b[38;5;214m',
            success: '\x1b[38;5;46m',
            error: '\x1b[38;5;203m',
            reset: '\x1b[0m'
        };

        const isPkg = typeof process.pkg !== 'undefined';
        const projectRoot = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
        this.dataDir = path.join(projectRoot, '.data');
        this.ensureDataDirectory();

        this.wallet = null;
        this.provider = null;
        this.signClient = null;
        this.bot = null;
        this.isConnected = false;
        this.session = null;

        // [v19] MetaMask RPC Inject — Multi-port manager
        // Map<port, MetaMaskRpcServer>
        this.rpcServers = new Map();
        // Config port tersimpan: { port, vpsMode, isPermanent, label }
        this.rpcPortsFile = path.join(this.dataDir, `${this.sessionId}_rpc-ports.json`);
        this.rpcPortsConfig = this._loadRpcPortsConfig();

        // Variabel pribadi untuk notifikasi sesi ini
        this.sessionNotificationChatId = null;

        // Smart Delay Execution
        this.executionDelay = 0;

        this.walletFile = path.join(this.dataDir, `${this.sessionId}_wallets.enc`);
        this.rpcFile = path.join(this.dataDir, `${this.sessionId}_rpc-config.json`);
        this.solanaRpcFile = path.join(this.dataDir, `${this.sessionId}_solana-rpc-config.json`);
        this.currentSolanaRpc = null;
        this.currentSolanaRpcName = null;
        this.savedSolanaRpcs = {};

        this.aptosRpcFile = path.join(this.dataDir, `${this.sessionId}_aptos-rpc-config.json`);
        this.currentAptosRpc = null;
        this.currentAptosRpcName = null;
        this.savedAptosRpcs = {};

        this.suiRpcFile = path.join(this.dataDir, `${this.sessionId}_sui-rpc-config.json`);
        this.currentSuiRpc = null;
        this.currentSuiRpcName = null;
        this.savedSuiRpcs = {};

        this.tonRpcFile = path.join(this.dataDir, `${this.sessionId}_ton-rpc-config.json`);
        this.currentTonRpc = null;
        this.currentTonRpcName = null;
        this.savedTonRpcs = {};

        this.nearRpcFile = path.join(this.dataDir, `${this.sessionId}_near-rpc-config.json`);
        this.currentNearRpc = null;
        this.currentNearRpcName = null;
        this.savedNearRpcs = {};

        this.masterKey = null;
        this.transactionCounts = new Map();

        this.currentRpc = null;
        this.currentChainId = null;
        this.currentRpcName = null;

        // Auto-Save RPC (Default: True)
        this.autoSaveRpc = true;

        // [v19.2] DApp Connection Approval — Saklar persetujuan koneksi DApp
        this.dappApprovalRequired = false;  // false = auto-connect, true = manual approval via Telegram
        this.globalDappApproval = false; // [v20.2] Global DApp Approval: true = selalu minta konfirmasi (tidak tergantung RPC)
        this.pendingDappApprovals = new Map(); // Map<approvalId, {resolve, reject, timer, details}>
        this._dappApprovalCounter = 0;
        this.connectedDapps = []; // Array of { id, url, name, connectedAt, via }

        // [v20.1] Auto Approve Transaction / Message Sign (per-RPC)
        this.pendingTxApprovals = new Map();
        this._txApprovalCounter = 0;

        // Inactivity Timer
        this.dappInactivityTimeout = 30; // default 30 minutes
        this.dappLastActiveTimes = {};
        this.inactivityInterval = setInterval(() => {
            try {
                this.checkDappsInactivity();
            } catch (err) {
                console.error(`[InactivityChecker] Error in session ${this.sessionId}:`, err.message);
            }
        }, 60000); // Check every 1 minute

        if (this.rl !== null) {
            this.initTelegramBot();
        }

        this.loadRpcConfig();
        this.loadSolanaRpcConfig();
        this.loadAptosRpcConfig();
        this.loadSuiRpcConfig();
        this.loadTonRpcConfig();
        this.loadNearRpcConfig();
    }

    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            try {
                fs.mkdirSync(this.dataDir, { recursive: true });
                console.log(`[Session ${this.sessionId}] Membuat folder data: ${this.dataDir}`);
            } catch (error) {
                console.error(`[Session ${this.sessionId}] FATAL: Gagal membuat folder data: ${error.message}`);
                process.exit(1);
            }
        }
    }

    // 🔧 RPC CONFIGURATION SYSTEM
    loadRpcConfig() {
        try {
            if (fs.existsSync(this.rpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.rpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                this.currentRpc = rpcConfig.currentRpc || this.currentRpc;
                this.currentChainId = rpcConfig.currentChainId || this.currentChainId;
                this.currentRpcName = rpcConfig.currentRpcName || this.currentRpcName;
                this.savedRpcs = rpcConfig.savedRpcs || this.getDefaultRpcs();

                // Hapus bawaan RPC (default_env, mainnet, bsc, polygon) agar wajib input manual
                delete this.savedRpcs['default_env'];
                delete this.savedRpcs['mainnet'];
                delete this.savedRpcs['bsc'];
                delete this.savedRpcs['polygon'];

                const defaultUrls = [
                    'rpc.hoodi.ethpandaops.io',
                    'eth.llamarpc.com',
                    'bsc-dataseed.binance.org',
                    'polygon-rpc.com'
                ];
                if (this.currentRpc && defaultUrls.some(url => this.currentRpc.includes(url))) {
                    this.currentRpc = null;
                    this.currentChainId = null;
                    this.currentRpcName = null;
                }

                if (rpcConfig.autoSaveRpc !== undefined) {
                    this.autoSaveRpc = rpcConfig.autoSaveRpc;
                }

                if (rpcConfig.dappApprovalRequired !== undefined) {
                    this.dappApprovalRequired = rpcConfig.dappApprovalRequired;
                }

                if (rpcConfig.globalDappApproval !== undefined) {
                    this.globalDappApproval = rpcConfig.globalDappApproval;
                }

                if (rpcConfig.connectedDapps !== undefined) {
                    this.connectedDapps = rpcConfig.connectedDapps;
                }

                if (rpcConfig.dappInactivityTimeout !== undefined) {
                    this.dappInactivityTimeout = rpcConfig.dappInactivityTimeout;
                }

                for (const key in this.savedRpcs) {
                    if (!this.savedRpcs[key].gasConfig) {
                        this.savedRpcs[key].gasConfig = { mode: 'auto', value: 0 };
                    }
                }

                console.log(`[Session ${this.sessionId}] Loaded RPC configuration:`, this.currentRpcName);
                console.log(`[Session ${this.sessionId}] Auto-Save RPC: ${this.autoSaveRpc ? 'ON' : 'OFF'}`);
                console.log(`[Session ${this.sessionId}] DApp Connection: ${this.globalDappApproval ? 'ON (Global Manual)' : 'OFF (Ikut per-RPC)'}`);
                console.log(`[Session ${this.sessionId}] Auto Approve Tx (active RPC): ${this.isAutoApproveActive() ? 'ON (Auto)' : 'OFF (Manual)'}`);

            } else {
                console.log(`[Session ${this.sessionId}] File RPC tidak ditemukan, membuat default...`);
                this.savedRpcs = this.getDefaultRpcs();
                this.saveRpcConfig();
            }
            this.setupProvider();
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading RPC config, using default:`, error.message);
            this.savedRpcs = this.getDefaultRpcs();
            this.setupProvider();
        }
    }

    getDefaultRpcs() {
        return {};
    }

    getActiveRpcExplorer() {
        if (!this.savedRpcs) return null;
        for (const key in this.savedRpcs) {
            const rpc = this.savedRpcs[key];
            if (rpc && rpc.rpc === this.currentRpc) {
                return rpc.explorer || null;
            }
        }
        return null;
    }

    saveRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentRpc,
                currentChainId: this.currentChainId,
                currentRpcName: this.currentRpcName,
                savedRpcs: this.savedRpcs,
                autoSaveRpc: this.autoSaveRpc,
                dappApprovalRequired: this.dappApprovalRequired,
                globalDappApproval: this.globalDappApproval,
                connectedDapps: this.connectedDapps,
                dappInactivityTimeout: this.dappInactivityTimeout,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.rpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] RPC configuration saved (encrypted)`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving RPC config:`, error.message);
            return false;
        }
    }

    // 🟣 SOLANA RPC CONFIGURATION SYSTEM
    loadSolanaRpcConfig() {
        try {
            if (fs.existsSync(this.solanaRpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.solanaRpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                if (rpcConfig) {
                    this.currentSolanaRpc = rpcConfig.currentRpc || null;
                    this.currentSolanaRpcName = rpcConfig.currentRpcName || null;
                    this.savedSolanaRpcs = rpcConfig.savedRpcs || {};
                }
            } else {
                console.log(`[Session ${this.sessionId}] File RPC Solana tidak ditemukan, membuat default...`);
                this.savedSolanaRpcs = {};
                this.currentSolanaRpc = null;
                this.currentSolanaRpcName = null;
                this.saveSolanaRpcConfig();
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading Solana RPC config:`, error.message);
        }
    }

    saveSolanaRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentSolanaRpc,
                currentRpcName: this.currentSolanaRpcName,
                savedRpcs: this.savedSolanaRpcs,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.solanaRpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] Solana RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving Solana RPC config:`, error.message);
            return false;
        }
    }

    addSolanaRpc(rpcUrl, name) {
        if (!rpcUrl || !name) return null;
        const key = `solana_${Date.now()}`;
        this.savedSolanaRpcs[key] = {
            rpc: rpcUrl,
            name: name,
            priorityFee: 'Medium', // Default: Medium (Low, Medium, High, Very High)
            commitment: 'confirmed', // Default: confirmed (processed, confirmed, finalized)
            createdAt: new Date().toISOString()
        };
        if (!this.currentSolanaRpc) {
            this.currentSolanaRpc = rpcUrl;
            this.currentSolanaRpcName = name;
        }
        this.saveSolanaRpcConfig();
        return key;
    }

    deleteSolanaRpc(key) {
        if (!this.savedSolanaRpcs[key]) return false;
        const targetRpc = this.savedSolanaRpcs[key].rpc;
        delete this.savedSolanaRpcs[key];
        
        if (this.currentSolanaRpc === targetRpc) {
            const remainingKeys = Object.keys(this.savedSolanaRpcs);
            if (remainingKeys.length > 0) {
                const nextKey = remainingKeys[0];
                this.currentSolanaRpc = this.savedSolanaRpcs[nextKey].rpc;
                this.currentSolanaRpcName = this.savedSolanaRpcs[nextKey].name;
            } else {
                this.currentSolanaRpc = null;
                this.currentSolanaRpcName = null;
            }
        }
        this.saveSolanaRpcConfig();
        return true;
    }

    selectSolanaRpc(key) {
        if (!this.savedSolanaRpcs[key]) return false;
        const selected = this.savedSolanaRpcs[key];
        this.currentSolanaRpc = selected.rpc;
        this.currentSolanaRpcName = selected.name;
        this.saveSolanaRpcConfig();
        return true;
    }

    updateSolanaRpcProperty(key, property, value) {
        if (!this.savedSolanaRpcs[key]) return false;
        this.savedSolanaRpcs[key][property] = value;
        this.saveSolanaRpcConfig();
        return true;
    }

    // 🔵 APTOS RPC CONFIGURATION SYSTEM
    loadAptosRpcConfig() {
        try {
            if (fs.existsSync(this.aptosRpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.aptosRpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                if (rpcConfig) {
                    this.currentAptosRpc = rpcConfig.currentRpc || null;
                    this.currentAptosRpcName = rpcConfig.currentRpcName || null;
                    this.savedAptosRpcs = rpcConfig.savedRpcs || {};
                }
            } else {
                console.log(`[Session ${this.sessionId}] File RPC Aptos tidak ditemukan, membuat default...`);
                this.savedAptosRpcs = {};
                this.currentAptosRpc = null;
                this.currentAptosRpcName = null;
                this.saveAptosRpcConfig();
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading Aptos RPC config:`, error.message);
        }
    }

    saveAptosRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentAptosRpc,
                currentRpcName: this.currentAptosRpcName,
                savedRpcs: this.savedAptosRpcs,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.aptosRpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] Aptos RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving Aptos RPC config:`, error.message);
            return false;
        }
    }

    addAptosRpc(rpcUrl, name) {
        if (!rpcUrl || !name) return null;
        const key = `aptos_${Date.now()}`;
        this.savedAptosRpcs[key] = {
            rpc: rpcUrl,
            name: name,
            createdAt: new Date().toISOString()
        };
        if (!this.currentAptosRpc) {
            this.currentAptosRpc = rpcUrl;
            this.currentAptosRpcName = name;
        }
        this.saveAptosRpcConfig();
        return key;
    }

    deleteAptosRpc(key) {
        if (!this.savedAptosRpcs[key]) return false;
        const targetRpc = this.savedAptosRpcs[key].rpc;
        delete this.savedAptosRpcs[key];

        if (this.currentAptosRpc === targetRpc) {
            const remainingKeys = Object.keys(this.savedAptosRpcs);
            if (remainingKeys.length > 0) {
                const nextKey = remainingKeys[0];
                this.currentAptosRpc = this.savedAptosRpcs[nextKey].rpc;
                this.currentAptosRpcName = this.savedAptosRpcs[nextKey].name;
            } else {
                this.currentAptosRpc = null;
                this.currentAptosRpcName = null;
            }
        }
        this.saveAptosRpcConfig();
        return true;
    }

    selectAptosRpc(key) {
        if (!this.savedAptosRpcs[key]) return false;
        const selected = this.savedAptosRpcs[key];
        this.currentAptosRpc = selected.rpc;
        this.currentAptosRpcName = selected.name;
        this.saveAptosRpcConfig();
        return true;
    }

    updateAptosRpcProperty(key, property, value) {
        if (!this.savedAptosRpcs[key]) return false;
        this.savedAptosRpcs[key][property] = value;
        this.saveAptosRpcConfig();
        return true;
    }

    // 🟡 SUI RPC CONFIGURATION SYSTEM
    loadSuiRpcConfig() {
        try {
            if (fs.existsSync(this.suiRpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.suiRpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                if (rpcConfig) {
                    this.currentSuiRpc = rpcConfig.currentRpc || null;
                    this.currentSuiRpcName = rpcConfig.currentRpcName || null;
                    this.savedSuiRpcs = rpcConfig.savedRpcs || {};
                }
            } else {
                console.log(`[Session ${this.sessionId}] File RPC Sui tidak ditemukan, membuat default...`);
                this.savedSuiRpcs = {};
                this.currentSuiRpc = null;
                this.currentSuiRpcName = null;
                this.saveSuiRpcConfig();
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading Sui RPC config:`, error.message);
        }
    }

    saveSuiRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentSuiRpc,
                currentRpcName: this.currentSuiRpcName,
                savedRpcs: this.savedSuiRpcs,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.suiRpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] Sui RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving Sui RPC config:`, error.message);
            return false;
        }
    }

    addSuiRpc(rpcUrl, name) {
        if (!rpcUrl || !name) return null;
        const key = `sui_${Date.now()}`;
        this.savedSuiRpcs[key] = {
            rpc: rpcUrl,
            name: name,
            createdAt: new Date().toISOString()
        };
        if (!this.currentSuiRpc) {
            this.currentSuiRpc = rpcUrl;
            this.currentSuiRpcName = name;
        }
        this.saveSuiRpcConfig();
        return key;
    }

    deleteSuiRpc(key) {
        if (!this.savedSuiRpcs[key]) return false;
        const targetRpc = this.savedSuiRpcs[key].rpc;
        delete this.savedSuiRpcs[key];

        if (this.currentSuiRpc === targetRpc) {
            const remainingKeys = Object.keys(this.savedSuiRpcs);
            if (remainingKeys.length > 0) {
                const nextKey = remainingKeys[0];
                this.currentSuiRpc = this.savedSuiRpcs[nextKey].rpc;
                this.currentSuiRpcName = this.savedSuiRpcs[nextKey].name;
            } else {
                this.currentSuiRpc = null;
                this.currentSuiRpcName = null;
            }
        }
        this.saveSuiRpcConfig();
        return true;
    }

    selectSuiRpc(key) {
        if (!this.savedSuiRpcs[key]) return false;
        const selected = this.savedSuiRpcs[key];
        this.currentSuiRpc = selected.rpc;
        this.currentSuiRpcName = selected.name;
        this.saveSuiRpcConfig();
        return true;
    }

    updateSuiRpcProperty(key, property, value) {
        if (!this.savedSuiRpcs[key]) return false;
        this.savedSuiRpcs[key][property] = value;
        this.saveSuiRpcConfig();
        return true;
    }

    // 💎 TON RPC CONFIGURATION SYSTEM
    loadTonRpcConfig() {
        try {
            if (fs.existsSync(this.tonRpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.tonRpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                if (rpcConfig) {
                    this.currentTonRpc = rpcConfig.currentRpc || null;
                    this.currentTonRpcName = rpcConfig.currentRpcName || null;
                    this.savedTonRpcs = rpcConfig.savedRpcs || {};
                }
            } else {
                console.log(`[Session ${this.sessionId}] File RPC TON tidak ditemukan, membuat default...`);
                this.savedTonRpcs = {};
                this.currentTonRpc = null;
                this.currentTonRpcName = null;
                this.saveTonRpcConfig();
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading TON RPC config:`, error.message);
        }
    }

    saveTonRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentTonRpc,
                currentRpcName: this.currentTonRpcName,
                savedRpcs: this.savedTonRpcs,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.tonRpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] TON RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving TON RPC config:`, error.message);
            return false;
        }
    }

    addTonRpc(rpcUrl, name) {
        if (!rpcUrl || !name) return null;
        const key = `ton_${Date.now()}`;
        this.savedTonRpcs[key] = {
            rpc: rpcUrl,
            name: name,
            createdAt: new Date().toISOString()
        };
        if (!this.currentTonRpc) {
            this.currentTonRpc = rpcUrl;
            this.currentTonRpcName = name;
        }
        this.saveTonRpcConfig();
        return key;
    }

    deleteTonRpc(key) {
        if (!this.savedTonRpcs[key]) return false;
        const targetRpc = this.savedTonRpcs[key].rpc;
        delete this.savedTonRpcs[key];

        if (this.currentTonRpc === targetRpc) {
            const remainingKeys = Object.keys(this.savedTonRpcs);
            if (remainingKeys.length > 0) {
                const nextKey = remainingKeys[0];
                this.currentTonRpc = this.savedTonRpcs[nextKey].rpc;
                this.currentTonRpcName = this.savedTonRpcs[nextKey].name;
            } else {
                this.currentTonRpc = null;
                this.currentTonRpcName = null;
            }
        }
        this.saveTonRpcConfig();
        return true;
    }

    selectTonRpc(key) {
        if (!this.savedTonRpcs[key]) return false;
        const selected = this.savedTonRpcs[key];
        this.currentTonRpc = selected.rpc;
        this.currentTonRpcName = selected.name;
        this.saveTonRpcConfig();
        return true;
    }

    updateTonRpcProperty(key, property, value) {
        if (!this.savedTonRpcs[key]) return false;
        this.savedTonRpcs[key][property] = value;
        this.saveTonRpcConfig();
        return true;
    }

    // 🌿 NEAR RPC CONFIGURATION SYSTEM
    loadNearRpcConfig() {
        try {
            if (fs.existsSync(this.nearRpcFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.nearRpcFile, 'utf8');
                let rpcConfig;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        rpcConfig = this.decrypt(parsed);
                    } else {
                        rpcConfig = parsed;
                    }
                } catch (e) {
                    rpcConfig = JSON.parse(raw);
                }

                if (rpcConfig) {
                    this.currentNearRpc = rpcConfig.currentRpc || null;
                    this.currentNearRpcName = rpcConfig.currentRpcName || null;
                    this.savedNearRpcs = rpcConfig.savedRpcs || {};
                }
            } else {
                console.log(`[Session ${this.sessionId}] File RPC NEAR tidak ditemukan, membuat default...`);
                this.savedNearRpcs = {};
                this.currentNearRpc = null;
                this.currentNearRpcName = null;
                this.saveNearRpcConfig();
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading NEAR RPC config:`, error.message);
        }
    }

    saveNearRpcConfig() {
        try {
            this.ensureMasterKey();
            const rpcConfig = {
                currentRpc: this.currentNearRpc,
                currentRpcName: this.currentNearRpcName,
                savedRpcs: this.savedNearRpcs,
                updatedAt: new Date().toISOString()
            };
            const encryptedData = this.encrypt(rpcConfig);
            fs.writeFileSync(this.nearRpcFile, JSON.stringify(encryptedData, null, 2));
            console.log(`[Session ${this.sessionId}] NEAR RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving NEAR RPC config:`, error.message);
            return false;
        }
    }

    addNearRpc(rpcUrl, name) {
        if (!rpcUrl || !name) return null;
        const key = `near_${Date.now()}`;
        this.savedNearRpcs[key] = {
            rpc: rpcUrl,
            name: name,
            createdAt: new Date().toISOString()
        };
        if (!this.currentNearRpc) {
            this.currentNearRpc = rpcUrl;
            this.currentNearRpcName = name;
        }
        this.saveNearRpcConfig();
        return key;
    }

    deleteNearRpc(key) {
        if (!this.savedNearRpcs[key]) return false;
        const targetRpc = this.savedNearRpcs[key].rpc;
        delete this.savedNearRpcs[key];

        if (this.currentNearRpc === targetRpc) {
            const remainingKeys = Object.keys(this.savedNearRpcs);
            if (remainingKeys.length > 0) {
                const nextKey = remainingKeys[0];
                this.currentNearRpc = this.savedNearRpcs[nextKey].rpc;
                this.currentNearRpcName = this.savedNearRpcs[nextKey].name;
            } else {
                this.currentNearRpc = null;
                this.currentNearRpcName = null;
            }
        }
        this.saveNearRpcConfig();
        return true;
    }

    selectNearRpc(key) {
        if (!this.savedNearRpcs[key]) return false;
        const selected = this.savedNearRpcs[key];
        this.currentNearRpc = selected.rpc;
        this.currentNearRpcName = selected.name;
        this.saveNearRpcConfig();
        return true;
    }

    updateNearRpcProperty(key, property, value) {
        if (!this.savedNearRpcs[key]) return false;
        this.savedNearRpcs[key][property] = value;
        this.saveNearRpcConfig();
        return true;
    }

    setupProvider() {
        if (!this.currentRpc) {
            console.log(`[Session ${this.sessionId}] ⚠️ Belum ada RPC dikonfigurasi. Tambahkan RPC melalui menu 🌐 RPC Management di bot.`);
            this.provider = null;
            return;
        }
        try {
            this.provider = new ethers.JsonRpcProvider(this.currentRpc);
            console.log(`[Session ${this.sessionId}] Connected to RPC: ${this.currentRpcName}`);
            console.log(`[Session ${this.sessionId}] URL: ${this.currentRpc}`);
            console.log(`[Session ${this.sessionId}] Chain ID: ${this.currentChainId}`);

            if (this.wallet) {
                this.wallet = this.wallet.connect(this.provider);
                console.log(`[Session ${this.sessionId}] Wallet reconnected to new RPC`);
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error setting up provider:`, error.message);
            console.log(`[Session ${this.sessionId}] ⚠️ Provider tidak aktif. Silakan ganti RPC via menu bot.`);
            this.provider = null;
        }
    }

    async runWithFailover(fn) {
        let attempts = 0;
        let maxAttempts = 1;

        let activeRpcConfig = null;
        for (const key in this.savedRpcs) {
            const rpc = this.savedRpcs[key];
            if (rpc && (rpc.rpc === this.currentRpc || (rpc.backupRpcs && rpc.backupRpcs.includes(this.currentRpc)))) {
                activeRpcConfig = rpc;
                break;
            }
        }
        if (activeRpcConfig && activeRpcConfig.backupRpcs) {
            maxAttempts += activeRpcConfig.backupRpcs.length;
        }

        while (attempts < maxAttempts) {
            try {
                return await fn();
            } catch (error) {
                const isNetworkError = error.message.includes('fetch') ||
                    error.message.includes('timeout') ||
                    error.message.includes('SERVER_ERROR') ||
                    error.message.includes('502') ||
                    error.message.includes('503') ||
                    error.message.includes('504') ||
                    error.message.includes('bad response') ||
                    error.message.includes('could not detect network') ||
                    error.code === 'TIMEOUT' ||
                    error.code === 'SERVER_ERROR';

                if (isNetworkError) {
                    console.log(`[Session ${this.sessionId}] Network error detected on ${this.currentRpc}: ${error.message}`);
                    attempts++;
                    if (attempts >= maxAttempts) {
                        throw error;
                    }
                    const switched = await this.switchToNextBackupRpc();
                    if (!switched) {
                        throw error;
                    }
                } else {
                    throw error;
                }
            }
        }
    }

    async switchToNextBackupRpc() {
        if (!this.savedRpcs) return false;

        let activeRpcConfig = null;
        for (const key in this.savedRpcs) {
            const rpc = this.savedRpcs[key];
            if (rpc && (rpc.rpc === this.currentRpc || (rpc.backupRpcs && rpc.backupRpcs.includes(this.currentRpc)))) {
                activeRpcConfig = rpc;
                break;
            }
        }

        if (!activeRpcConfig) {
            console.log(`[Session ${this.sessionId}] Active RPC configuration not found for failover.`);
            return false;
        }

        const backups = activeRpcConfig.backupRpcs || [];
        if (backups.length === 0) {
            console.log(`[Session ${this.sessionId}] No backup RPCs configured for ${activeRpcConfig.name}.`);
            return false;
        }

        const allUrls = [activeRpcConfig.rpc, ...backups];
        const currentIndex = allUrls.indexOf(this.currentRpc);
        const nextIndex = (currentIndex + 1) % allUrls.length;
        const nextUrl = allUrls[nextIndex];

        console.log(`[Session ${this.sessionId}] Switching from ${this.currentRpc} to backup URL: ${nextUrl}`);

        this.currentRpc = nextUrl;
        this.setupProvider();

        if (this.bot && this.sessionNotificationChatId) {
            this.bot.sendMessage(
                this.sessionNotificationChatId,
                `⚠️ *[Session ${this.sessionId}] KONEKSI RPC DOWN!*\n` +
                `🔌 Otomatis beralih ke RPC alternatif:\n` +
                `🌐 RPC: *${this.currentRpcName}*\n` +
                `🔗 URL Baru: \`${this.currentRpc}\`\n` +
                `⛓️ Chain ID: *${this.currentChainId}*`,
                { parse_mode: 'Markdown' }
            ).catch(err => console.warn(`[Telegram] Failover notification error: ${err.message}`));
        }

        return true;
    }

    getActiveRpcGasConfig() {
        for (const key in this.savedRpcs) {
            if (this.savedRpcs[key].rpc === this.currentRpc) {
                return this.savedRpcs[key].gasConfig || { mode: 'auto', value: 0 };
            }
        }
        return { mode: 'auto', value: 0 };
    }

    // 🎛️ RPC MANAGEMENT MENU (CLI)
    async rpcManagementMode() {
        console.log('\n🔧 PENGATURAN RPC');
        console.log('1. Pilih RPC yang tersedia');
        console.log('2. Tambah RPC baru (Manual)');
        console.log('3. Hapus RPC');
        console.log('4. Lihat RPC saat ini');
        const status = this.autoSaveRpc ? 'ON (Otomatis Simpan)' : 'OFF (Manual Input)';
        console.log(`5. Ubah Auto-Save RPC [Saat ini: ${status}]`);
        console.log('6. Kembali ke Menu Utama');

        const choice = await this.question('Pilih opsi (1-6): ');

        switch (choice) {
            case '1': await this.selectRpc(); break;
            case '2': await this.addNewRpc(); break;
            case '3': await this.deleteRpc(); break;
            case '4': await this.showCurrentRpc(); break;
            case '5':
                this.autoSaveRpc = !this.autoSaveRpc;
                this.saveRpcConfig();
                console.log(`✅ Fitur Auto-Save RPC berhasil diubah ke: ${this.autoSaveRpc ? 'ON' : 'OFF'}`);
                break;
            case '6': return;
            default: console.log('❌ Pilihan tidak valid!');
        }
        await this.rpcManagementMode();
    }

    async selectRpc() {
        console.log('\n📡 PILIH RPC:');
        const rpcList = Object.entries(this.savedRpcs);
        if (rpcList.length === 0) {
            console.log('❌ Tidak ada RPC yang tersimpan');
            return;
        }
        let index = 1;
        for (const [key, rpc] of rpcList) {
            console.log(`${index}. ${rpc.name}`);
            console.log(`   URL: ${rpc.rpc}`);
            console.log(`   Chain ID: ${rpc.chainId}`);
            console.log('-'.repeat(40));
            index++;
        }
        const choice = await this.question(`Pilih RPC (1-${rpcList.length}): `);
        const selectedIndex = parseInt(choice) - 1;
        if (selectedIndex >= 0 && selectedIndex < rpcList.length) {
            const [key, selectedRpc] = rpcList[selectedIndex];
            this.currentRpc = selectedRpc.rpc;
            this.currentChainId = selectedRpc.chainId;
            this.currentRpcName = selectedRpc.name;
            this.setupProvider();
            this.saveRpcConfig();
            console.log(`✅ RPC berhasil diubah ke: ${selectedRpc.name}`);
        } else {
            console.log('❌ Pilihan tidak valid!');
        }
    }

    async addNewRpc() {
        console.log('\n➕ TAMBAH RPC BARU');
        const name = await this.question('Nama RPC (contoh: RPC Sepolia): ');
        const url = await this.question('URL RPC (contoh: https://...): ');
        const chainId = await this.question('Chain ID (contoh: 11155111): ');
        if (!name || !url || !chainId) {
            console.log('❌ Semua field harus diisi!');
            return;
        }
        if (!url.startsWith('http')) {
            console.log('❌ URL harus dimulai dengan http atau https');
            return;
        }
        const chainIdNum = parseInt(chainId);
        if (isNaN(chainIdNum) || chainIdNum <= 0) {
            console.log('❌ Chain ID harus angka positif');
            return;
        }
        console.log('🔄 Testing koneksi RPC...');
        try {
            const testProvider = new ethers.JsonRpcProvider(url);
            const network = await testProvider.getNetwork();
            console.log(`✅ Koneksi berhasil! Chain ID: ${network.chainId}`);
            if (network.chainId !== BigInt(chainIdNum)) {
                console.log(`⚠️ Warning: Chain ID tidak match. Input: ${chainIdNum}, Actual: ${network.chainId}`);
            }
        } catch (error) {
            console.log('❌ Gagal terkoneksi ke RPC:', error.message);
            const continueAnyway = await this.question('Tetap simpan RPC? (y/n): ');
            if (continueAnyway.toLowerCase() !== 'y') return;
        }
        const save = await this.question('Simpan RPC ini? (y/n): ');
        if (save.toLowerCase() === 'y') {
            const key = `custom_${Date.now()}`;
            this.savedRpcs[key] = { name: name, rpc: url, chainId: chainIdNum, gasConfig: { mode: 'auto', value: 0 } };
            if (this.saveRpcConfig()) {
                console.log(`✅ RPC "${name}" berhasil disimpan!`);
                const useNow = await this.question('Gunakan RPC ini sekarang? (y/n): ');
                if (useNow.toLowerCase() === 'y') {
                    this.currentRpc = url;
                    this.currentChainId = chainIdNum;
                    this.currentRpcName = name;
                    this.setupProvider();
                    console.log(`✅ Sekarang menggunakan: ${name}`);
                }
            }
        }
    }

    async deleteRpc() {
        console.log('\n🗑️ HAPUS RPC');
        const rpcList = Object.entries(this.savedRpcs);
        if (rpcList.length === 0) {
            console.log('❌ Tidak ada RPC yang tersimpan');
            return;
        }
        let index = 1;
        for (const [key, rpc] of rpcList) {
            console.log(`${index}. ${rpc.name} (${rpc.rpc})`);
            index++;
        }
        const choice = await this.question(`Pilih RPC yang akan dihapus (1-${rpcList.length}): `);
        const selectedIndex = parseInt(choice) - 1;
        if (selectedIndex >= 0 && selectedIndex < rpcList.length) {
            const [key, selectedRpc] = rpcList[selectedIndex];
            if (this.currentRpc === selectedRpc.rpc) {
                console.log('❌ Tidak bisa menghapus RPC yang sedang aktif!');
                return;
            }
            const confirm = await this.question(`Yakin hapus "${selectedRpc.name}"? (y/n): `);
            if (confirm.toLowerCase() === 'y') {
                delete this.savedRpcs[key];
                if (this.saveRpcConfig()) {
                    console.log(`✅ RPC "${selectedRpc.name}" berhasil dihapus!`);
                }
            }
        } else {
            console.log('❌ Pilihan tidak valid!');
        }
    }

    async showCurrentRpc() {
        console.log('\n📊 RPC SAAT INI:');
        console.log(`🏷️ Nama: ${this.currentRpcName}`);
        console.log(`🔗 URL: ${this.currentRpc}`);
        console.log(`⛓️ Chain ID: ${this.currentChainId}`);
        const gasConf = this.getActiveRpcGasConfig();
        console.log(`⛽ Gas Mode: ${gasConf.mode.toUpperCase()} ${gasConf.mode !== 'auto' ? `(${gasConf.value})` : ''}`);
        console.log(`💾 Total RPC tersimpan: ${Object.keys(this.savedRpcs).length}`);
        console.log(`⚙️ Auto-Save DApp: ${this.autoSaveRpc ? 'ON' : 'OFF'}`);
    }

    // 🔐 ENCRYPTION SYSTEM
    ensureMasterKey() {
        if (this.masterKey) return;
        const keyFile = path.join(this.dataDir, `${this.sessionId}_master.key`);
        try {
            if (fs.existsSync(keyFile)) {
                const keyBase64 = fs.readFileSync(keyFile, 'utf8');
                this.masterKey = Buffer.from(keyBase64, 'base64');
            } else {
                this.masterKey = crypto.randomBytes(32);
                fs.writeFileSync(keyFile, this.masterKey.toString('base64'));
                try { fs.chmodSync(keyFile, 0o600); } catch (error) { }
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error ensuring encryption key:`, error.message);
        }
    }

    async initializeEncryption() {
        const keyFile = path.join(this.dataDir, `${this.sessionId}_master.key`);
        try {
            if (fs.existsSync(keyFile)) {
                const keyBase64 = fs.readFileSync(keyFile, 'utf8');
                this.masterKey = Buffer.from(keyBase64, 'base64');
                console.log(`[Session ${this.sessionId}] Loaded existing encryption key`);
            } else {
                this.masterKey = crypto.randomBytes(32);
                fs.writeFileSync(keyFile, this.masterKey.toString('base64'));
                console.log(`[Session ${this.sessionId}] Generated new encryption key`);
                try { fs.chmodSync(keyFile, 0o600); } catch (error) { }
            }
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error initializing encryption:`, error.message);
            return false;
        }
    }

    encrypt(data) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
            let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();
            return {
                iv: iv.toString('hex'), data: encrypted, authTag: authTag.toString('hex'), version: '2.0'
            };
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Encryption error:`, error.message);
            throw error;
        }
    }

    decrypt(encryptedData) {
        try {
            const iv = Buffer.from(encryptedData.iv, 'hex');
            const authTag = Buffer.from(encryptedData.authTag, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return JSON.parse(decrypted);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Decryption error:`, error.message);
            throw error;
        }
    }

    // 🔢 Get transaction count
    async getTransactionCount(address) {
        try {
            console.log(`[Session ${this.sessionId}] Getting transaction count from blockchain...`);
            const transactionCount = await this.runWithFailover(() => this.provider.getTransactionCount(address));
            console.log(`[Session ${this.sessionId}] Total transaksi di blockchain: ${transactionCount}`);
            return transactionCount;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getting transaction count:`, error.message);
            return 0;
        }
    }

    // 🔢 Get wallet info
    async getWalletInfo(address) {
        try {
            console.log(`[Session ${this.sessionId}] Getting wallet info from blockchain...`);
            const currentBlock = await this.provider.getBlockNumber();
            const txCount = await this.provider.getTransactionCount(address);
            let firstSeen = (txCount > 0) ? `Active (${txCount} tx)` : 'New wallet';
            return { transactionCount: txCount, firstSeen: firstSeen, currentBlock: currentBlock };
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getting wallet info:`, error.message);
            return { transactionCount: 0, firstSeen: 'Unknown', currentBlock: 0 };
        }
    }

    // 🔐 WALLET MANAGEMENT
    async loadWallets() {
        try {
            if (!this.masterKey) {
                await this.initializeEncryption();
            }
            if (fs.existsSync(this.walletFile)) {
                const encryptedData = JSON.parse(fs.readFileSync(this.walletFile, 'utf8'));
                if (encryptedData.iv && encryptedData.data && encryptedData.authTag) {
                    const wallets = this.decrypt(encryptedData);
                    console.log(`[Session ${this.sessionId}] Loaded encrypted wallets file`);
                    return wallets;
                } else {
                    console.log(`[Session ${this.sessionId}] Loaded plain text wallets file (legacy)`);
                    return encryptedData;
                }
            } else {
                console.log(`[Session ${this.sessionId}] File wallet tidak ditemukan. Mulai fresh.`);
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error loading wallets, using empty:`, error.message);
        }
        return {};
    }

    async saveWallets(wallets) {
        try {
            if (!this.masterKey) {
                await this.initializeEncryption();
            }
            const encryptedData = this.encrypt(wallets);
            fs.writeFileSync(this.walletFile, JSON.stringify(encryptedData, null, 2));
            try { fs.chmodSync(this.walletFile, 0o600); } catch (error) { }
            console.log(`[Session ${this.sessionId}] Saved wallets with encryption`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Encryption failed:`, error.message);
            // FIX: Removed dangerous plaintext fallback that would write private keys unencrypted to disk.
            // If encryption fails, it's safer to fail completely than to store keys as plaintext.
            console.log(`[Session ${this.sessionId}] CRITICAL: Cannot save wallets without encryption. Aborting save.`);
            return false;
        }
    }

    async saveWallet(privateKey, nickname = '') {
        try {
            const wallets = await this.loadWallets();
            const wallet = new ethers.Wallet(privateKey);
            const address = wallet.address;
            const txCount = await this.getTransactionCount(address);

            // Generate nickname otomatis jika kosong
            if (!nickname) {
                nickname = `Wallet_${Object.keys(wallets).length + 1}`;
            }

            wallets[address] = {
                privateKey: privateKey,
                nickname: nickname,
                createdAt: new Date().toISOString(),
                lastUsed: new Date().toISOString(),
                initialTxCount: txCount,
                isGenerated: false // Tandai sebagai wallet import manual
            };
            if (await this.saveWallets(wallets)) {
                console.log(`[Session ${this.sessionId}] Wallet disimpan: ${address} (${wallets[address].nickname})`);
                console.log(`[Session ${this.sessionId}] Initial transaction count: ${txCount}`);
                return true;
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving wallet:`, error.message);
        }
        return false;
    }

    // ==============================================
    // [FITUR BARU 1] GENERATE WALLET OTOMATIS
    // ==============================================

    async generateNewWallet() {
        try {
            console.log(`[Session ${this.sessionId}] 🔐 Mengenerate wallet baru...`);

            const wallet = ethers.Wallet.createRandom();
            const mnemonic = wallet.mnemonic?.phrase;

            if (!mnemonic) {
                throw new Error('Gagal generate mnemonic');
            }

            console.log(`[Session ${this.sessionId}] ✅ Wallet baru berhasil digenerate`);
            console.log(`[Session ${this.sessionId}] 📍 Address: ${wallet.address}`);

            return {
                privateKey: wallet.privateKey,
                address: wallet.address,
                mnemonic: mnemonic,
                wallet: wallet
            };
        } catch (error) {
            console.log(`[Session ${this.sessionId}] ❌ Error generate wallet:`, error.message);
            throw error;
        }
    }

    async saveWalletWithMnemonic(privateKey, mnemonic, nickname = '') {
        try {
            const wallets = await this.loadWallets();
            const wallet = new ethers.Wallet(privateKey);
            const address = wallet.address;
            const txCount = await this.getTransactionCount(address);

            if (!nickname) {
                nickname = `Wallet_${Object.keys(wallets).length + 1}`;
            }

            wallets[address] = {
                privateKey: privateKey,
                mnemonic: mnemonic,
                nickname: nickname,
                createdAt: new Date().toISOString(),
                lastUsed: new Date().toISOString(),
                initialTxCount: txCount,
                isGenerated: true
            };

            if (await this.saveWallets(wallets)) {
                console.log(`[Session ${this.sessionId}] ✅ Wallet baru disimpan: ${address}`);
                console.log(`[Session ${this.sessionId}] 🏷️ Nama: ${nickname}`);
                return true;
            }
            return false;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] ❌ Error saving wallet:`, error.message);
            return false;
        }
    }

    deriveSolanaAddress(mnemonic) {
        try {
            if (!mnemonic) return null;
            const m = ethers.Mnemonic.fromPhrase(mnemonic);
            const seedHex = m.computeSeed().slice(2);
            const derived = derivePath("m/44'/501'/0'/0'", seedHex);
            const keypair = Keypair.fromSeed(derived.key);
            return keypair.publicKey.toBase58();
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error deriving Solana address:`, error.message);
            return null;
        }
    }

    deriveAptosAddress(mnemonic) {
        try {
            if (!mnemonic) return null;
            const account = AptosAccount.fromDerivationPath({
                path: "m/44'/637'/0'/0'/0'",
                mnemonic: mnemonic,
            });
            return account.accountAddress.toString();
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error deriving Aptos address:`, error.message);
            return null;
        }
    }

    deriveSuiAddress(mnemonic) {
        try {
            if (!mnemonic) return null;
            const keypair = Ed25519Keypair.deriveKeypair(mnemonic, "m/44'/784'/0'/0'/0'");
            return keypair.toSuiAddress();
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error deriving Sui address:`, error.message);
            return null;
        }
    }

    async deriveTonAddress(mnemonic) {
        try {
            if (!mnemonic) return null;
            const key = await mnemonicToWalletKey(mnemonic.split(' '));
            const wallet = WalletContractV4.create({
                workchain: 0,
                publicKey: key.publicKey
            });
            return wallet.address.toString({ bounceable: false, testOnly: false });
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error deriving TON address:`, error.message);
            return null;
        }
    }

    deriveNearAddress(mnemonic) {
        try {
            if (!mnemonic) return null;
            const bip39 = require('bip39');
            const nacl = require('tweetnacl');
            const seed = bip39.mnemonicToSeedSync(mnemonic);
            const { key } = derivePath("m/44'/397'/0'", seed.toString('hex'));
            const keyPair = nacl.sign.keyPair.fromSeed(key);
            return Buffer.from(keyPair.publicKey).toString('hex');
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error deriving NEAR address:`, error.message);
            return null;
        }
    }

    // ==============================================
    // [FITUR BARU 2] LIHAT BACKUP PHRASE (MNEMONIC)
    // ==============================================

    async getWalletMnemonic(address) {
        try {
            const wallets = await this.loadWallets();
            const walletData = wallets[address];

            if (!walletData) {
                return { success: false, message: 'Wallet tidak ditemukan' };
            }

            // Selalu return privateKey, mnemonic opsional
            return {
                success: true,
                privateKey: walletData.privateKey,
                mnemonic: walletData.mnemonic || null,
                address: address,
                nickname: walletData.nickname,
                isGenerated: walletData.isGenerated || false
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async listWalletsWithMnemonic() {
        const wallets = await this.loadWallets();
        const result = [];
        for (const [address, data] of Object.entries(wallets)) {
            if (data.mnemonic) {
                result.push({
                    address: address,
                    nickname: data.nickname,
                    mnemonic: data.mnemonic,
                    privateKey: data.privateKey
                });
            }
        }
        return result;
    }

    // Return SEMUA wallet (dengan atau tanpa mnemonic) beserta privateKey
    async listAllWalletsBackup() {
        const wallets = await this.loadWallets();
        const result = [];
        for (const [address, data] of Object.entries(wallets)) {
            result.push({
                address: address,
                nickname: data.nickname || address.slice(0, 8),
                privateKey: data.privateKey,
                mnemonic: data.mnemonic || null,
                isGenerated: data.isGenerated || false
            });
        }
        return result;
    }

    // ==============================================
    // AKHIR FITUR BARU
    // ==============================================

    async listSavedWallets() {
        const wallets = await this.loadWallets();
        if (Object.keys(wallets).length === 0) {
            console.log('📭 Tidak ada wallet yang disimpan');
            return [];
        }
        console.log('\n💼 WALLET YANG DISIMPAN:');
        console.log('='.repeat(70));
        const walletList = [];
        let index = 1;
        for (const [address, data] of Object.entries(wallets)) {
            const hasMnemonic = data.mnemonic ? '🔐 (Ada Mnemonic)' : '🔑 (Private Key Only)';
            const isActive = this.wallet && this.wallet.address.toLowerCase() === address.toLowerCase() ? '🟢 AKTIF' : '';
            console.log(`${index}. ${data.nickname} ${isActive}`);
            console.log(`   Address: ${address}`);
            console.log(`   Tipe: ${hasMnemonic}`);
            console.log(`   Dibuat: ${new Date(data.createdAt).toLocaleDateString()}`);
            console.log(`   TX: ${data.initialTxCount || 0}`);
            console.log('-'.repeat(40));
            walletList.push({ address, ...data });
            index++;
        }
        return walletList;
    }

    async deleteWallet(address) {
        const wallets = await this.loadWallets();
        if (wallets[address]) {
            if (this.wallet && this.wallet.address.toLowerCase() === address.toLowerCase()) {
                this.wallet = null;
                console.log(`[Session ${this.sessionId}] Wallet aktif saat ini telah dihapus dan di-deaktivasi.`);
            }
            delete wallets[address];
            if (await this.saveWallets(wallets)) {
                console.log(`[Session ${this.sessionId}] Wallet dihapus: ${address}`);
                return true;
            }
        }
        console.log(`[Session ${this.sessionId}] Wallet tidak ditemukan`);
        return false;
    }

    initTelegramBot() {
        if (!this.config.TELEGRAM_BOT_TOKEN) {
            console.log(`[Session ${this.sessionId}] Peringatan: Token Telegram tidak ada. Notifikasi dinonaktifkan.`);
            return;
        }
        try {
            this.bot = new TelegramBot(this.config.TELEGRAM_BOT_TOKEN, { polling: false });
            console.log(`[Session ${this.sessionId}] Telegram Notification Bot (CLI-Mode) initialized`);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error initializing Notification bot:`, error.message);
        }
    }

    question(prompt) {
        if (!this.rl) {
            console.error(`FATAL: CryptoAutoTx.question dipanggil tanpa readline interface.`);
            return Promise.resolve('');
        }
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    async showMenu() {
        const wallets = await this.loadWallets();
        const runningPorts = [...this.rpcServers.entries()]
            .filter(([, s]) => s.isRunning)
            .map(([p]) => p);
        const rpcStatus = runningPorts.length > 0
            ? `🟢 AKTIF (port: ${runningPorts.join(', ')})`
            : '🔴 OFF';

        console.log('\n' + '='.repeat(60));
        console.log(`🚀 FA STARX BOT v20.0 (Session: ${this.sessionId})`);
        console.log('='.repeat(60));
        console.log('⛓️ Chain ID  :', this.currentChainId);
        console.log('🌐 RPC      :', this.currentRpcName);
        console.log('💼 Wallets  :', Object.keys(wallets).length);
        console.log('🦊 RPC Inject:', rpcStatus);
        console.log('='.repeat(60));
        // ── Tampilkan info 2FA real-time di menu utama ──
        const tfa2 = new TwoFactorAuth(this.dataDir);
        const salt2 = process.env.SYSTEM_ID || 'FASTARX_2FA_DEFAULT_SALT';
        console.log(tfa2.renderCLI('admin', salt2));
        console.log(tfa2.renderCLI('script', salt2));
        console.log('='.repeat(60));
        console.log('Pilih Mode:');
        console.log('1. Setup Wallet & Connect WalletConnect');
        console.log('2. 🦊 MetaMask RPC Inject [BARU]');
        console.log('3. Cek Balance & Transaction Stats');
        console.log('4. Kelola Wallet');
        console.log('5. Pengaturan RPC');
        console.log('6. 🔐 Kelola Google Authenticator (2FA)');
        console.log('7. Keluar');
        console.log('='.repeat(60));
    }

    async walletManagementMode() {
        console.log('\n💼 KELOLA WALLET');
        console.log('1. Gunakan Wallet yang Disimpan');
        console.log('2. Import Wallet Baru (Private Key)');
        console.log('3. 🌱 Import Wallet via Mnemonic / Seed Phrase');
        console.log('4. 🔐 BUAT WALLET BARU (Generate Otomatis)');
        console.log('5. 🔑 Lihat Backup Phrase / Mnemonic');
        console.log('6. Hapus Wallet');
        console.log('7. Kembali ke Menu Utama');

        const choice = await this.question('Pilih opsi (1-7): ');

        switch (choice) {
            case '1': await this.useSavedWallet(); break;
            case '2': await this.importNewWalletCLI(); break;
            case '3': await this.importWalletFromMnemonicCLI(); break;
            case '4': await this.generateNewWalletCLI(); break;
            case '5': await this.showMnemonicCLI(); break;
            case '6': await this.deleteWalletMenu(); break;
            case '7': return;
            default: console.log('❌ Pilihan tidak valid!');
        }
        await this.walletManagementMode();
    }

    async importNewWalletCLI() {
        console.log('\n📥 IMPORT WALLET — PRIVATE KEY');
        const privateKey = await this.question('Masukkan private key (0x...): ');
        if (!privateKey) {
            console.log('❌ Batal.');
            return;
        }

        let pkeyFormatted = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;

        try {
            const tempWallet = new ethers.Wallet(pkeyFormatted);
            console.log(`📍 Address terdeteksi: ${tempWallet.address}`);
            const nickname = await this.question('Beri nama wallet (optional): ');

            if (await this.saveWallet(pkeyFormatted, nickname)) {
                console.log(`💾 Wallet berhasil disimpan!`);
            } else {
                console.log(`❌ Gagal menyimpan wallet.`);
            }
        } catch (e) {
            console.log('❌ Private key tidak valid.');
            return;
        }
    }

    async importWalletFromMnemonicCLI() {
        console.log('\n🌱 IMPORT WALLET — MNEMONIC / SEED PHRASE');
        console.log('='.repeat(50));
        console.log('Masukkan 12 atau 24 kata mnemonic, pisahkan dengan spasi.');
        console.log('Contoh: word1 word2 word3 ... word12');
        console.log('='.repeat(50));

        const mnemonicInput = await this.question('Mnemonic: ');
        if (!mnemonicInput || mnemonicInput.trim() === '') {
            console.log('❌ Batal.');
            return;
        }

        const mnemonic = mnemonicInput.trim().toLowerCase().replace(/\s+/g, ' ');
        const wordCount = mnemonic.split(' ').length;

        if (wordCount !== 12 && wordCount !== 24) {
            console.log(`❌ Jumlah kata tidak valid. Kamu memasukkan ${wordCount} kata. Harus 12 atau 24 kata.`);
            return;
        }

        try {
            const defaultPath = "m/44'/60'/0'/0/0";
            console.log(`\n⏳ Memvalidasi mnemonic dan menurunkan wallet...`);

            const hdWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, defaultPath);

            console.log('\n' + '='.repeat(50));
            console.log('✅ MNEMONIC VALID!');
            console.log('='.repeat(50));
            console.log(`📍 Address  : ${hdWallet.address}`);
            console.log(`🔑 Priv Key : ${hdWallet.privateKey}`);
            console.log(`🛤️  Path     : ${defaultPath}`);
            console.log('='.repeat(50));

            const customPath = await this.question('\nGunakan derivation path custom? (y/n, default: n): ');
            let finalWallet = hdWallet;

            if (customPath.toLowerCase() === 'y') {
                console.log("Contoh path: m/44'/60'/0'/0/1 (index wallet ke-2)");
                const pathInput = await this.question('Masukkan derivation path: ');
                if (pathInput.trim()) {
                    try {
                        finalWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, pathInput.trim());
                        console.log(`✅ Path custom berhasil: ${finalWallet.address}`);
                    } catch (e) {
                        console.log(`❌ Path tidak valid: ${e.message}. Menggunakan path default.`);
                        finalWallet = hdWallet;
                    }
                }
            }

            const nickname = await this.question('\nBeri nama wallet (optional): ');
            const saveChoice = await this.question('Simpan wallet ini? (y/n): ');

            if (saveChoice.toLowerCase() !== 'y') {
                console.log('⏭️ Wallet tidak disimpan.');
                return;
            }

            if (await this.saveWalletWithMnemonic(finalWallet.privateKey, mnemonic, nickname)) {
                console.log(`\n✅ Wallet berhasil disimpan!`);
                console.log(`📍 Address : ${finalWallet.address}`);
                console.log(`🏷️  Nama    : ${nickname || '(tanpa nama)'}`);

                const useNow = await this.question('Gunakan wallet ini sekarang? (y/n): ');
                if (useNow.toLowerCase() === 'y') {
                    this.setupWallet(finalWallet.privateKey);
                    console.log(`✅ Wallet aktif: ${finalWallet.address}`);
                    await this.checkBalance();
                }
            } else {
                console.log('❌ Gagal menyimpan wallet.');
            }

        } catch (e) {
            console.log(`❌ Mnemonic tidak valid: ${e.message}`);
        }
    }

    // ==============================================
    // [FITUR BARU] Generate Wallet CLI
    // ==============================================

    async generateNewWalletCLI() {
        console.log('\n🔐 MEMBUAT WALLET BARU OTOMATIS');
        console.log('='.repeat(50));

        try {
            const nickname = await this.question('Beri nama untuk wallet baru ini (optional): ');

            console.log('⏳ Mengenerate wallet...');
            const newWallet = await this.generateNewWallet();

            console.log('\n' + '='.repeat(50));
            console.log('✅ WALLET BERHASIL DIBUAT!');
            console.log('='.repeat(50));
            console.log(`📍 Address: ${newWallet.address}`);
            console.log(`🔑 Private Key: ${newWallet.privateKey}`);
            console.log('\n🔐 BACKUP PHRASE (12 KATA):');
            console.log(this.theme?.warning || '', newWallet.mnemonic, this.theme?.reset || '');
            console.log('\n⚠️ PERINGATAN PENTING:');
            console.log('1. Simpan 12 kata di atas di tempat AMAN!');
            console.log('2. Jangan pernah bagikan ke siapapun!');
            console.log('3. Jika hilang, wallet TIDAK BISA dipulihkan!');
            console.log('='.repeat(50));

            const saveWallet = await this.question('\nSimpan wallet ini? (y/n): ');
            if (saveWallet.toLowerCase() === 'y') {
                if (await this.saveWalletWithMnemonic(newWallet.privateKey, newWallet.mnemonic, nickname)) {
                    console.log('✅ Wallet berhasil disimpan!');

                    const useNow = await this.question('Gunakan wallet ini sekarang? (y/n): ');
                    if (useNow.toLowerCase() === 'y') {
                        this.setupWallet(newWallet.privateKey);
                        console.log(`✅ Wallet aktif: ${newWallet.address}`);
                        await this.checkBalance();
                    }
                }
            } else {
                console.log('⏭️ Wallet tidak disimpan.');
            }

        } catch (error) {
            console.log('❌ Gagal membuat wallet:', error.message);
        }
    }

    // ==============================================
    // [FITUR BARU] Lihat Mnemonic CLI
    // ==============================================

    async showMnemonicCLI() {
        console.log('\n🔑 LIHAT BACKUP WALLET (Private Key & Mnemonic)');

        const allWallets = await this.listAllWalletsBackup();

        if (allWallets.length === 0) {
            console.log('📭 Tidak ada wallet yang tersimpan.');
            return;
        }

        console.log('\n📋 Daftar wallet tersimpan:');
        allWallets.forEach((w, i) => {
            const tag = w.mnemonic ? '🌱 (Ada Mnemonic)' : '🔑 (Private Key Only)';
            console.log(`${i + 1}. ${w.nickname} ${tag}`);
            console.log(`   📍 ${w.address}`);
        });

        const choice = await this.question(`\nPilih wallet (1-${allWallets.length}): `);
        const index = parseInt(choice) - 1;

        if (index >= 0 && index < allWallets.length) {
            const selected = allWallets[index];

            console.log('\n' + '='.repeat(55));
            console.log(`🔐 BACKUP DATA UNTUK: ${selected.nickname}`);
            console.log('='.repeat(55));
            console.log(`📍 Address    : ${selected.address}`);
            console.log('');
            console.log('🔑 PRIVATE KEY:');
            console.log(this.theme?.warning || '', selected.privateKey, this.theme?.reset || '');

            if (selected.mnemonic) {
                console.log('');
                console.log('🌱 MNEMONIC / SEED PHRASE:');
                console.log(this.theme?.warning || '', selected.mnemonic, this.theme?.reset || '');
            } else {
                console.log('');
                console.log('ℹ️  Wallet ini tidak memiliki mnemonic (diimpor via private key).');
            }

            console.log('');
            console.log('⚠️  PERINGATAN KEAMANAN:');
            console.log('  1. Hanya tampilkan di layar pribadi!');
            console.log('  2. Jangan screenshot atau simpan di cloud!');
            console.log('  3. Simpan offline (kertas / hardware wallet)');
            console.log('='.repeat(55));

            await this.question('\nTekan Enter untuk kembali...');
        }
    }

    async useSavedWallet() {
        const walletList = await this.listSavedWallets();
        if (walletList.length === 0) return;

        const choice = await this.question(`Pilih wallet (1-${walletList.length}): `);
        const index = parseInt(choice) - 1;

        if (index >= 0 && index < walletList.length) {
            const selectedWallet = walletList[index];
            console.log(`✅ Memilih wallet: ${selectedWallet.nickname}`);
            console.log(`📍 ${selectedWallet.address}`);
            this.setupWallet(selectedWallet.privateKey);

            const currentTxCount = await this.getTransactionCount(selectedWallet.address);
            const initialTxCount = selectedWallet.initialTxCount || 0;
            const newTransactions = currentTxCount - initialTxCount;

            console.log(`📊 Transaction Stats:`);
            console.log(`   Initial: ${initialTxCount}`);
            console.log(`   Current: ${currentTxCount}`);
            console.log(`   New TX: +${newTransactions}`);

            await this.checkBalance();

            const wallets = await this.loadWallets();
            if (wallets[selectedWallet.address]) {
                wallets[selectedWallet.address].lastUsed = new Date().toISOString();
                await this.saveWallets(wallets);
            }
        } else {
            console.log('❌ Pilihan tidak valid!');
        }
    }

    async deleteWalletMenu() {
        const walletList = await this.listSavedWallets();
        if (walletList.length === 0) return;

        const choice = await this.question(`Pilih wallet yang akan dihapus (1-${walletList.length}): `);
        const index = parseInt(choice) - 1;

        if (index >= 0 && index < walletList.length) {
            const selectedWallet = walletList[index];
            const confirm = await this.question(`Yakin hapus ${selectedWallet.nickname}? (y/n): `);
            if (confirm.toLowerCase() === 'y') {
                await this.deleteWallet(selectedWallet.address);
            }
        } else {
            console.log('❌ Pilihan tidak valid!');
        }
    }

    setupWallet(privateKey) {
        try {
            if (!privateKey.startsWith('0x')) {
                privateKey = '0x' + privateKey;
            }
            this.wallet = new ethers.Wallet(privateKey, this.provider);
            console.log(`[Session ${this.sessionId}] Wallet berhasil setup: ${this.wallet.address}`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error setup wallet:`, error.message);
            return false;
        }
    }

    // ============================================================
    // [v20] METAMASK RPC INJECT — MULTI-PORT MANAGER
    // ============================================================

    // --- Port config persistence ---

    _loadRpcPortsConfig() {
        // Default: port 8545 & 8546 permanen, localhost mode
        const defaults = {
            8545: { port: 8545, vpsMode: false, isPermanent: true, label: 'Port 8545 (Default)' },
            8546: { port: 8546, vpsMode: false, isPermanent: true, label: 'Port 8546 (Default)' },
        };
        try {
            if (fs.existsSync(this.rpcPortsFile)) {
                this.ensureMasterKey();
                const raw = fs.readFileSync(this.rpcPortsFile, 'utf8');
                let saved;
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.iv && parsed.data && parsed.authTag) {
                        saved = this.decrypt(parsed);
                    } else {
                        saved = parsed;
                    }
                } catch (e) {
                    saved = JSON.parse(raw);
                }
                // Merge: pastikan port permanen selalu ada
                return Object.assign({}, defaults, saved,
                    {
                        8545: Object.assign({}, defaults[8545], saved[8545] || {}),
                        8546: Object.assign({}, defaults[8546], saved[8546] || {})
                    }
                );
            }
        } catch (e) {
            console.warn(`[RPC Ports] Gagal load config port: ${e.message}`);
        }
        return defaults;
    }

    _saveRpcPortsConfig() {
        try {
            this.ensureMasterKey();
            const encryptedData = this.encrypt(this.rpcPortsConfig);
            fs.writeFileSync(this.rpcPortsFile, JSON.stringify(encryptedData, null, 2));
        } catch (e) {
            console.warn(`[RPC Ports] Gagal simpan config port: ${e.message}`);
        }
    }

    // --- Server lifecycle ---

    async startRpcServer(port, vpsMode = null, password = null) {
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
            console.log(`[RPC Ports] ❌ Port ${port} tidak valid.`);
            return false;
        }

        if (this.rpcServers.has(portNum) && this.rpcServers.get(portNum).isRunning) {
            console.log(`[RPC Ports] Port ${portNum} sudah berjalan.`);
            return true;
        }

        // Tentukan mode: pakai argumen, atau ambil dari config tersimpan, atau default localhost
        const cfg = this.rpcPortsConfig[portNum] || {};
        const useVpsMode = vpsMode !== null ? vpsMode : (cfg.vpsMode || false);

        const server = new MetaMaskRpcServer(this, portNum, useVpsMode, password);
        const started = await server.start();

        if (started) {
            this.rpcServers.set(portNum, server);
            // Update config
            if (!this.rpcPortsConfig[portNum]) {
                this.rpcPortsConfig[portNum] = { port: portNum, vpsMode: useVpsMode, isPermanent: false, label: `Port ${portNum} (Custom)` };
            } else {
                this.rpcPortsConfig[portNum].vpsMode = useVpsMode;
            }
            this._saveRpcPortsConfig();

            if (this.bot && this.sessionNotificationChatId) {
                const info = server.getConnectionInfo();
                await this.bot.sendMessage(this.sessionNotificationChatId,
                    `🦊 [${this.sessionId}] RPC INJECT AKTIF!\n\n` +
                    `🔌 Mode  : ${info.modeLabel}\n` +
                    `🔗 URL   : ${info.rpcUrl}\n` +
                    `⛓️ Chain : ${info.chainId} (${info.chainIdHex})\n` +
                    `💳 Wallet: ${this.wallet?.address || '-'}`
                ).catch(err => console.warn(`[RPC Ports] Telegram notify failed: ${err.message}`));
            }
        }
        return started;
    }

    async stopRpcServer(port) {
        const portNum = parseInt(port);
        const server = this.rpcServers.get(portNum);
        if (server) {
            server.stop();
            this.rpcServers.delete(portNum);
            console.log(`[RPC Ports] Port ${portNum} dihentikan.`);
            return true;
        }
        console.log(`[RPC Ports] Port ${portNum} tidak sedang berjalan.`);
        return false;
    }

    async stopAllRpcServers() {
        for (const [port, server] of this.rpcServers.entries()) {
            server.stop();
            console.log(`[RPC Ports] Port ${port} dihentikan.`);
        }
        this.rpcServers.clear();
    }

    addRpcPort(port, vpsMode = false, label = '') {
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) return false;
        if (portNum === 8545 || portNum === 8546) {
            // Port permanen, hanya update mode-nya
            this.rpcPortsConfig[portNum].vpsMode = vpsMode;
            this._saveRpcPortsConfig();
            return true;
        }
        if (this.rpcPortsConfig[portNum]) {
            console.log(`[RPC Ports] Port ${portNum} sudah ada.`);
            return false;
        }
        this.rpcPortsConfig[portNum] = {
            port: portNum,
            vpsMode,
            isPermanent: false,
            label: label || `Port ${portNum} (Custom)`
        };
        this._saveRpcPortsConfig();
        return true;
    }

    removeRpcPort(port) {
        const portNum = parseInt(port);
        const cfg = this.rpcPortsConfig[portNum];
        if (!cfg) return { ok: false, msg: `Port ${portNum} tidak ditemukan.` };
        if (cfg.isPermanent) return { ok: false, msg: `Port ${portNum} adalah port permanen dan tidak bisa dihapus.` };
        // Stop dulu kalau sedang jalan
        if (this.rpcServers.has(portNum)) {
            this.rpcServers.get(portNum).stop();
            this.rpcServers.delete(portNum);
        }
        delete this.rpcPortsConfig[portNum];
        this._saveRpcPortsConfig();
        return { ok: true, msg: `Port ${portNum} berhasil dihapus.` };
    }

    getRpcServerInfo(port) {
        const portNum = parseInt(port);
        const server = this.rpcServers.get(portNum);
        if (!server || !server.isRunning) return null;
        return server.getConnectionInfo();
    }

    getAllRpcPortsStatus() {
        return Object.values(this.rpcPortsConfig).map(cfg => {
            const running = this.rpcServers.has(cfg.port) && this.rpcServers.get(cfg.port).isRunning;
            return {
                ...cfg,
                isRunning: running,
                statusIcon: running ? '🟢' : '🔴',
                modeLabel: cfg.vpsMode ? '🌐 VPS' : '💻 Localhost'
            };
        }).sort((a, b) => a.port - b.port);
    }

    // --- CLI Menu RPC Inject ---

    async rpcInjectMode() {
        if (!this.wallet) {
            console.log('❌ Wallet belum aktif. Pilih wallet dulu dari menu Kelola Wallet.');
            return;
        }

        while (true) {
            console.log('\n' + '='.repeat(55));
            console.log('🦊 METAMASK RPC INJECT — PORT MANAGER');
            console.log('='.repeat(55));

            const allPorts = this.getAllRpcPortsStatus();
            allPorts.forEach((p, i) => {
                console.log(`${i + 1}. ${p.statusIcon} Port ${p.port} | ${p.modeLabel} | ${p.isPermanent ? '🔒 Permanen' : '🗑️  Custom'}`);
                console.log(`   ${p.label}`);
            });

            console.log('-'.repeat(55));
            console.log(`${allPorts.length + 1}. ➕ Tambah Port Baru`);
            console.log(`${allPorts.length + 2}. 🔙 Kembali ke Menu Utama`);
            console.log('='.repeat(55));

            const choice = await this.question(`Pilih (1-${allPorts.length + 2}): `);
            const choiceNum = parseInt(choice);

            if (choiceNum === allPorts.length + 2 || choice === '') {
                break; // Kembali
            }

            if (choiceNum === allPorts.length + 1) {
                await this._rpcAddPortMenu();
                continue;
            }

            if (choiceNum >= 1 && choiceNum <= allPorts.length) {
                await this._rpcPortDetailMenu(allPorts[choiceNum - 1]);
                continue;
            }

            console.log('❌ Pilihan tidak valid.');
        }
    }

    async _rpcPortDetailMenu(portStatus) {
        while (true) {
            console.log(`\n📡 PORT ${portStatus.port} — ${portStatus.label}`);
            console.log('='.repeat(50));
            console.log(`Status : ${portStatus.statusIcon} ${portStatus.isRunning ? 'AKTIF' : 'MATI'}`);
            console.log(`Mode   : ${portStatus.modeLabel}`);
            console.log(`Tipe   : ${portStatus.isPermanent ? '🔒 Permanen (tidak bisa dihapus)' : '🗑️  Custom'}`);
            console.log('='.repeat(50));

            const options = [];
            if (portStatus.isRunning) {
                options.push({ key: '1', label: '🛑 Stop Server' });
                options.push({ key: '2', label: '📋 Lihat Info Koneksi / Panduan MetaMask' });
            } else {
                options.push({ key: '1', label: '▶️  Start Server (mode saat ini)' });
                options.push({ key: '2', label: '🔄 Ganti Mode (Localhost ↔ VPS) lalu Start' });
            }
            if (!portStatus.isPermanent) {
                options.push({ key: '3', label: '🗑️  Hapus Port ini' });
            }
            options.push({ key: '0', label: '🔙 Kembali' });

            options.forEach(o => console.log(`${o.key}. ${o.label}`));

            const choice = await this.question('Pilih: ');

            if (choice === '0' || choice === '') break;

            // Re-fetch status terbaru
            const cfg = this.rpcPortsConfig[portStatus.port];
            const isRunning = this.rpcServers.has(portStatus.port) && this.rpcServers.get(portStatus.port).isRunning;

            if (isRunning) {
                if (choice === '1') {
                    await this.stopRpcServer(portStatus.port);
                    portStatus.isRunning = false;
                    portStatus.statusIcon = '🔴';
                } else if (choice === '2') {
                    const info = this.getRpcServerInfo(portStatus.port);
                    if (info) this.printRpcInjectGuide(info);
                }
            } else {
                if (choice === '1') {
                    const pass = await this.question('Masukkan password keamanan untuk port ini: ');
                    if (!pass.trim()) {
                        console.log('❌ Password tidak boleh kosong.');
                        continue;
                    }
                    console.log(`⏳ Memulai port ${portStatus.port} dalam mode ${cfg.vpsMode ? 'VPS' : 'Localhost'}...`);
                    const ok = await this.startRpcServer(portStatus.port, cfg.vpsMode, pass.trim());
                    if (ok) {
                        portStatus.isRunning = true;
                        portStatus.statusIcon = '🟢';
                        const info = this.getRpcServerInfo(portStatus.port);
                        if (info) this.printRpcInjectGuide(info);
                    } else {
                        console.log(`❌ Gagal start port ${portStatus.port}. Port mungkin sudah dipakai proses lain.`);
                    }
                } else if (choice === '2') {
                    const newVps = !cfg.vpsMode;
                    console.log(`🔄 Mode diubah ke: ${newVps ? '🌐 VPS (0.0.0.0)' : '💻 Localhost (127.0.0.1)'}`);
                    this.rpcPortsConfig[portStatus.port].vpsMode = newVps;
                    this._saveRpcPortsConfig();
                    portStatus.vpsMode = newVps;
                    portStatus.modeLabel = newVps ? '🌐 VPS' : '💻 Localhost';
                    const pass = await this.question('Masukkan password keamanan untuk port ini: ');
                    if (!pass.trim()) {
                        console.log('❌ Password tidak boleh kosong.');
                        continue;
                    }
                    console.log(`⏳ Memulai port ${portStatus.port}...`);
                    const ok = await this.startRpcServer(portStatus.port, newVps, pass.trim());
                    if (ok) {
                        portStatus.isRunning = true;
                        portStatus.statusIcon = '🟢';
                        const info = this.getRpcServerInfo(portStatus.port);
                        if (info) this.printRpcInjectGuide(info);
                    } else {
                        console.log(`❌ Gagal start. Port mungkin sudah dipakai proses lain.`);
                    }
                } else if (choice === '3' && !portStatus.isPermanent) {
                    const confirm = await this.question(`Yakin hapus port ${portStatus.port}? (y/n): `);
                    if (confirm.toLowerCase() === 'y') {
                        const result = this.removeRpcPort(portStatus.port);
                        console.log(result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`);
                        if (result.ok) break; // Kembali ke list setelah dihapus
                    }
                }
            }
        }
    }

    async _rpcAddPortMenu() {
        console.log('\n➕ TAMBAH PORT BARU');
        console.log('='.repeat(40));

        const portInput = await this.question('Nomor port (1024–65535): ');
        const portNum = parseInt(portInput);

        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
            console.log('❌ Port tidak valid.');
            return;
        }

        if (this.rpcPortsConfig[portNum]) {
            console.log(`❌ Port ${portNum} sudah ada dalam daftar.`);
            return;
        }

        console.log('Pilih mode untuk port ini:');
        console.log('1. 💻 Localhost (127.0.0.1) — hanya bisa diakses dari PC yang sama');
        console.log('2. 🌐 VPS (0.0.0.0)         — bisa diakses dari luar via IP VPS');
        const modeChoice = await this.question('Mode (1/2): ');
        const vpsMode = modeChoice === '2';

        const labelInput = await this.question(`Label/nama port (optional, Enter untuk skip): `);
        const label = labelInput || `Port ${portNum} (Custom)`;

        const added = this.addRpcPort(portNum, vpsMode, label);
        if (added) {
            console.log(`✅ Port ${portNum} berhasil ditambahkan (${vpsMode ? '🌐 VPS' : '💻 Localhost'}).`);
            console.log(`ℹ️  Port belum distart. Pilih port dari menu untuk start.`);
        } else {
            console.log(`❌ Gagal menambahkan port ${portNum}.`);
        }
    }

    printRpcInjectGuide(info) {
        console.log('\n' + '='.repeat(55));
        console.log('📋 CARA CONNECT DI METAMASK:');
        console.log('='.repeat(55));
        if (info.vpsMode) {
            console.log('⚠️  VPS MODE: Ganti <IP_VPS> dengan IP publik VPS kamu!');
        }
        console.log('1. Buka MetaMask → Settings → Networks → Add Network');
        console.log('2. Isi dengan data berikut:');
        console.log(`   Network Name : ${info.networkName} (Bot)`);
        console.log(`   RPC URL      : ${info.rpcUrl}`);
        if (info.vpsMode) {
            console.log(`   (Localhost)  : ${info.rpcUrlLocal}`);
        }
        console.log(`   Chain ID     : ${info.chainId}`);
        console.log(`   Currency     : ETH`);
        console.log(`   Password RPC : ${info.password || '-'}`);
        console.log('3. Simpan, lalu ganti network ke network tersebut');
        console.log('4. Setiap transaksi dari DApp akan otomatis di-approve bot!');
        console.log('='.repeat(55));
    }

    // ============================================================
    // [v19] HD WALLET (MNEMONIC) METHODS
    // ============================================================

    // 🔌 WALLETCONNECT METHODS
    async initializeWalletConnect() {
        try {
            console.log(`[Session ${this.sessionId}] Initializing WalletConnect...`);
            this.signClient = await SignClient.init({
                projectId: this.config.WALLETCONNECT_PROJECT_ID,
                metadata: {
                    name: 'Crypto Auto-Tx Bot',
                    description: 'Bot untuk auto-approve transaksi',
                    url: 'https://github.com/',
                    icons: ['https://avatars.githubusercontent.com/u/37784886']
                }
            });
            console.log(`[Session ${this.sessionId}] WalletConnect initialized`);
            this.setupWalletConnectEvents();
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error initializing WalletConnect:`, error.message);
            return false;
        }
    }

    setupWalletConnectEvents() {
        if (!this.signClient) return;

        this.signClient.on('session_proposal', async (proposal) => {
            console.log(`[Session ${this.sessionId}] Received session proposal`);
            await this.handleSessionProposal(proposal);
        });

        this.signClient.on('session_request', async (request) => {
            console.log(`[Session ${this.sessionId}] Received session request`);
            await this.handleSessionRequest(request);
        });

        this.signClient.on('session_delete', () => {
            console.log(`[Session ${this.sessionId}] Session disconnected`);
            this.isConnected = false;
            this.session = null;
            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId, `🔴 [${this.sessionId}] WALLETCONNECT DISCONNECTED`)
                    .catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }
        });
    }

    async connectWalletConnect(uri) {
        try {
            if (!this.signClient) {
                await this.initializeWalletConnect();
            }
            console.log(`[Session ${this.sessionId}] Connecting to WalletConnect URI...`);

            let correctedUri = uri;
            // FIX: Only pass the URI as-is if it starts with "wc:", which is the correct WalletConnect v2 format.
            // Previously this code was incorrectly prepending "walletconnect:" which created an invalid URI.
            // The @walletconnect/sign-client pair() method expects the raw "wc:..." URI directly.
            if (!uri.startsWith('wc:') && uri.startsWith('walletconnect:wc:')) {
                correctedUri = uri.replace('walletconnect:', '');
                console.log(`[Session ${this.sessionId}] Auto-corrected URI: stripped walletconnect: prefix`);
            }

            console.log(`[Session ${this.sessionId}] Using URI:`, correctedUri);
            await this.signClient.pair({ uri: correctedUri });
            console.log(`[Session ${this.sessionId}] Pairing initiated, menunggu session proposal...`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error connecting to WalletConnect:`, error.message);
            return false;
        }
    }

    async delayExecution(actionName) {
        if (this.executionDelay > 0) {
            console.log(`[Session ${this.sessionId}] ⏳ WAITING: ${this.executionDelay}s before ${actionName}...`);

            if (this.bot && this.sessionNotificationChatId && this.executionDelay > 2) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `⏳ [${this.sessionId}] Menunggu ${this.executionDelay} detik sebelum ${actionName}...`)
                    .catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }

            await new Promise(resolve => setTimeout(resolve, this.executionDelay * 1000));
            console.log(`[Session ${this.sessionId}] ▶️ RESUMING: Executing ${actionName} now.`);
        }
    }

    // ============================================================
    // [v19.2] DAPP CONNECTION APPROVAL SYSTEM
    // ============================================================

    /**
     * Minta persetujuan koneksi DApp via Telegram.
     * Return Promise yang resolve(true) jika disetujui, reject jika ditolak/timeout.
     * @param {object} details - { dappName, dappUrl, dappIcon, chainId, walletAddress, via }
     */
    requestDappApproval(details) {
        return new Promise((resolve, reject) => {
            // Jika tidak ada chatId untuk notifikasi, auto-approve (fallback safety)
            if (!this.bot || !this.sessionNotificationChatId) {
                console.log(`[Session ${this.sessionId}] ⚠️ DApp Approval: No Telegram chatId, auto-approving...`);
                resolve(true);
                return;
            }

            const approvalId = `da_${Date.now()}_${++this._dappApprovalCounter}`;

            // Timeout 60 detik — auto-reject jika tidak dijawab
            const timer = setTimeout(() => {
                if (this.pendingDappApprovals.has(approvalId)) {
                    this.pendingDappApprovals.delete(approvalId);
                    console.log(`[Session ${this.sessionId}] ⏰ DApp Approval TIMEOUT: ${approvalId}`);

                    // Update pesan Telegram
                    if (details._messageId) {
                        this.bot.editMessageText(
                            `⏰ *DAPP CONNECTION TIMEOUT*\n\n` +
                            `🌐 DApp: ${details.dappName || 'Unknown'}\n` +
                            `🔗 URL: ${details.dappUrl || 'Unknown'}\n\n` +
                            `❌ Koneksi ditolak otomatis karena tidak ada respons dalam 60 detik.`,
                            {
                                chat_id: this.sessionNotificationChatId,
                                message_id: details._messageId,
                                parse_mode: 'Markdown'
                            }
                        ).catch(() => { });
                    }

                    reject(new Error('DApp connection request timed out (60s)'));
                }
            }, 60000);

            // Simpan ke pending queue
            this.pendingDappApprovals.set(approvalId, {
                resolve,
                reject,
                timer,
                details,
                createdAt: Date.now()
            });

            // Kirim notifikasi ke Telegram dengan tombol
            const dappIcon = details.dappIcon ? `🖼️ Icon: ${details.dappIcon}\n` : '';
            const message =
                `🔔 *DAPP CONNECTION REQUEST*\n\n` +
                `🌐 *DApp:* ${this._escapeMarkdown(details.dappName || 'Unknown DApp')}\n` +
                `🔗 *URL:* ${this._escapeMarkdown(details.dappUrl || 'Unknown')}\n` +
                `⛓️ *Chain ID:* ${details.chainId || this.currentChainId}\n` +
                `💳 *Wallet:* \`${details.walletAddress || this.wallet?.address || 'N/A'}\`\n` +
                `📡 *Via:* ${details.via || 'Unknown'}\n` +
                `🕒 *Waktu:* ${new Date().toLocaleString()}\n\n` +
                `⏳ _Auto-reject dalam 60 detik jika tidak dijawab_`;

            this.bot.sendMessage(this.sessionNotificationChatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Connect', callback_data: `dapp_connect_approve_${approvalId}` },
                            { text: '❌ Reject', callback_data: `dapp_connect_reject_${approvalId}` }
                        ]
                    ]
                }
            }).then(sentMsg => {
                // Simpan message_id untuk edit nanti
                const pending = this.pendingDappApprovals.get(approvalId);
                if (pending) {
                    pending.details._messageId = sentMsg.message_id;
                }
            }).catch(err => {
                console.warn(`[Session ${this.sessionId}] ⚠️ DApp Approval: Telegram send error:`, err.message);
                // Fallback: auto-approve jika gagal kirim ke Telegram
                this.pendingDappApprovals.delete(approvalId);
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    /**
     * Resolve pending DApp approval.
     * @param {string} approvalId
     * @param {boolean} approved - true = connect, false = reject
     */
    resolveDappApproval(approvalId, approved) {
        const pending = this.pendingDappApprovals.get(approvalId);
        if (!pending) {
            return { ok: false, msg: 'Approval request sudah expired atau tidak ditemukan.' };
        }

        clearTimeout(pending.timer);
        this.pendingDappApprovals.delete(approvalId);

        const details = pending.details;

        if (approved) {
            console.log(`[Session ${this.sessionId}] ✅ DApp Approval APPROVED: ${details.dappName || 'Unknown'}`);

            // Update pesan Telegram
            if (details._messageId && this.bot && this.sessionNotificationChatId) {
                this.bot.editMessageText(
                    `✅ *DAPP CONNECTED!*\n\n` +
                    `🌐 *DApp:* ${this._escapeMarkdown(details.dappName || 'Unknown DApp')}\n` +
                    `🔗 *URL:* ${this._escapeMarkdown(details.dappUrl || 'Unknown')}\n` +
                    `⛓️ *Chain ID:* ${details.chainId || this.currentChainId}\n` +
                    `💳 *Wallet:* \`${details.walletAddress || this.wallet?.address || 'N/A'}\`\n` +
                    `📡 *Via:* ${details.via || 'Unknown'}\n` +
                    `🕒 *Waktu:* ${new Date().toLocaleString()}\n\n` +
                    `👤 Disetujui oleh user`,
                    {
                        chat_id: this.sessionNotificationChatId,
                        message_id: details._messageId,
                        parse_mode: 'Markdown'
                    }
                ).catch(() => { });
            }

            pending.resolve(true);
            return { ok: true, msg: 'DApp connection approved.' };
        } else {
            console.log(`[Session ${this.sessionId}] ❌ DApp Approval REJECTED: ${details.dappName || 'Unknown'}`);

            // Update pesan Telegram
            if (details._messageId && this.bot && this.sessionNotificationChatId) {
                this.bot.editMessageText(
                    `❌ *DAPP CONNECTION REJECTED*\n\n` +
                    `🌐 *DApp:* ${this._escapeMarkdown(details.dappName || 'Unknown DApp')}\n` +
                    `🔗 *URL:* ${this._escapeMarkdown(details.dappUrl || 'Unknown')}\n` +
                    `⛓️ *Chain ID:* ${details.chainId || this.currentChainId}\n` +
                    `💳 *Wallet:* \`${details.walletAddress || this.wallet?.address || 'N/A'}\`\n` +
                    `📡 *Via:* ${details.via || 'Unknown'}\n` +
                    `🕒 *Waktu:* ${new Date().toLocaleString()}\n\n` +
                    `🚫 Ditolak oleh user`,
                    {
                        chat_id: this.sessionNotificationChatId,
                        message_id: details._messageId,
                        parse_mode: 'Markdown'
                    }
                ).catch(() => { });
            }

            pending.reject(new Error('DApp connection rejected by user'));
            return { ok: true, msg: 'DApp connection rejected.' };
        }
    }

    /**
     * Request manual transaction/signing approval from user via Telegram.
     */
    requestTxApproval(method, params, requestOrigin = null) {
        return new Promise(async (resolve, reject) => {
            // Safety fallback: if bot or chatId is not available, auto-approve
            if (!this.bot || !this.sessionNotificationChatId) {
                console.log(`[Session ${this.sessionId}] ⚠️ Tx Approval: No Telegram session, auto-approving...`);
                resolve(true);
                return;
            }

            const approvalId = `tx_${Date.now()}_${++this._txApprovalCounter}`;

            // Timeout 120s
            const timer = setTimeout(() => {
                const pending = this.pendingTxApprovals.get(approvalId);
                if (pending) {
                    this.pendingTxApprovals.delete(approvalId);
                    console.log(`[Session ${this.sessionId}] ⏰ Tx Approval TIMEOUT: ${approvalId}`);

                    if (pending.messageId && this.bot && this.sessionNotificationChatId) {
                        this.bot.editMessageText(
                            `⏰ *TRANSACTION TIMEOUT*\n\n` +
                            `❌ Transaksi ditolak otomatis karena tidak ada respons dalam 120 detik.`,
                            {
                                chat_id: this.sessionNotificationChatId,
                                message_id: pending.messageId,
                                parse_mode: 'Markdown'
                            }
                        ).catch(() => { });
                    }

                    reject(new Error('User rejected the transaction: timeout (120s)'));
                }
            }, 120000);

            const approvalState = {
                resolve,
                reject,
                timer,
                method,
                params,
                requestOrigin,
                createdAt: Date.now(),
                messageId: null
            };
            this.pendingTxApprovals.set(approvalId, approvalState);

            let detailText = '';
            if (method === 'eth_sendTransaction' || method === 'eth_signTransaction') {
                const tx = params[0] || {};
                const to = tx.to || 'None/Contract Creation';
                let valueEth = '0';
                try {
                    const val = tx.value ? BigInt(tx.value) : 0n;
                    valueEth = ethers.formatEther(val);
                } catch (e) { }

                const data = tx.data || '0x';
                const gasLimit = tx.gasLimit || tx.gas || 'Auto';
                const gasPrice = tx.gasPrice ? `${ethers.formatUnits(tx.gasPrice, 'gwei')} Gwei` : 'Auto';

                let isTokenTransfer = false;
                let tokenTarget = '';
                let tokenAmount = '';
                if (data.startsWith('0xa9059cbb') && data.length >= 138) {
                    isTokenTransfer = true;
                    try {
                        const targetAddr = '0x' + data.substring(34, 74);
                        const rawAmount = '0x' + data.substring(74, 138);
                        tokenTarget = ethers.getAddress(targetAddr);
                        tokenAmount = BigInt(rawAmount).toString();
                    } catch (e) {
                        isTokenTransfer = false;
                    }
                }

                let isTokenApprove = false;
                let approveSpender = '';
                let approveAmount = '';
                if (data.startsWith('0x095ea7b3') && data.length >= 138) {
                    isTokenApprove = true;
                    try {
                        const spenderAddr = '0x' + data.substring(34, 74);
                        const rawAmount = '0x' + data.substring(74, 138);
                        approveSpender = ethers.getAddress(spenderAddr);
                        approveAmount = BigInt(rawAmount).toString();
                    } catch (e) {
                        isTokenApprove = false;
                    }
                }

                detailText = `📝 *Tipe:* ${method === 'eth_sendTransaction' ? 'Kirim Transaksi' : 'Tanda Tangan Transaksi'}\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain ID:* \`${this.currentChainId}\`\n` +
                    `🌐 *RPC:* \`${this._escapeMarkdown(this.currentRpcName || 'Unknown')}\`\n` +
                    `💳 *Dari:* \`${this.wallet?.address || 'N/A'}\`\n` +
                    `🎯 *Kepada:* \`${to}\`\n` +
                    `💰 *Nilai:* \`${valueEth} Native Token\`\n`;

                if (isTokenTransfer) {
                    detailText += `🪙 *Transfer Token Terdeteksi:*\n` +
                        `  👉 *Ke:* \`${tokenTarget}\`\n` +
                        `  👉 *Jumlah (Raw):* \`${tokenAmount}\`\n`;
                }

                if (isTokenApprove) {
                    detailText += `🔑 *Approve Token Terdeteksi:*\n` +
                        `  👉 *Spender:* \`${approveSpender}\`\n` +
                        `  👉 *Jumlah (Raw):* \`${approveAmount}\`\n`;
                }

                detailText += `⛽ *Gas Limit:* \`${gasLimit}\`\n` +
                    `⛽ *Gas Price:* \`${gasPrice}\`\n` +
                    `💾 *Data Hex:* \`${data.length > 100 ? data.substring(0, 100) + '...' : data}\` (${(data.length - 2) / 2} bytes)`;

            } else if (method === 'personal_sign' || method === 'eth_sign') {
                const messageHex = method === 'personal_sign' ? params[0] : params[1];
                let decodedMessage = '';
                if (ethers.isHexString(messageHex)) {
                    try {
                        decodedMessage = ethers.toUtf8String(messageHex);
                    } catch (e) {
                        decodedMessage = messageHex;
                    }
                } else {
                    decodedMessage = messageHex;
                }

                // Hindari crash jika pesan dari DApp mengandung triple backticks
                const safeMessage = decodedMessage.replace(/```/g, "'''");

                detailText = `📝 *Tipe:* Tanda Tangan Pesan (\`${method}\`)\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain ID:* \`${this.currentChainId}\`\n` +
                    `💳 *Wallet:* \`${this.wallet?.address || 'N/A'}\`\n` +
                    `💬 *Pesan:* \n\`\`\`\n${safeMessage}\n\`\`\``;

            } else if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v4') {
                const rawTypedData = params[1];
                let typedDataStr = '';
                try {
                    if (typeof rawTypedData === 'string') {
                        typedDataStr = JSON.stringify(JSON.parse(rawTypedData), null, 2);
                    } else {
                        typedDataStr = JSON.stringify(rawTypedData, null, 2);
                    }
                } catch (e) {
                    typedDataStr = String(rawTypedData);
                }

                detailText = `📝 *Tipe:* Tanda Tangan Typed Data (EIP-712)\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain ID:* \`${this.currentChainId}\`\n` +
                    `💳 *Wallet:* \`${this.wallet?.address || 'N/A'}\`\n` +
                    `📊 *Data:* \n\`\`\`json\n${typedDataStr.length > 500 ? typedDataStr.substring(0, 500) + '\n... (data terlalu panjang)' : typedDataStr}\n\`\`\``;

            } else if (method === 'solana_signTransaction') {
                const txHex = params[0] || '';
                const solAddress = (await this.getActiveSolanaAddress()) || 'N/A';
                detailText = `🟣 *Tipe:* Solana Sign Transaction\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain:* Solana\n` +
                    `🌐 *RPC:* \`${this._escapeMarkdown(this.currentSolanaRpcName || 'Default')}\`\n` +
                    `💳 *Wallet:* \`${solAddress}\`\n` +
                    `💾 *Data Hex:* \`${txHex.length > 100 ? txHex.substring(0, 100) + '...' : txHex}\` (${Math.floor(txHex.length / 2)} bytes)`;

            } else if (method === 'solana_signMessage') {
                const messageHex = params[0] || '';
                const solAddress = (await this.getActiveSolanaAddress()) || 'N/A';
                let decodedMessage = '';
                try {
                    decodedMessage = Buffer.from(messageHex, 'hex').toString('utf8');
                } catch (e) {
                    decodedMessage = messageHex;
                }
                const safeMessage = decodedMessage.replace(/```/g, "'''");
                detailText = `🟣 *Tipe:* Solana Sign Message\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain:* Solana\n` +
                    `💳 *Wallet:* \`${solAddress}\`\n` +
                    `💬 *Pesan:* \n\`\`\`\n${safeMessage}\n\`\`\``;

            } else {
                detailText = `📝 *Tipe:* \`${method}\`\n` +
                    `👤 *DApp:* \`${this._escapeMarkdown(requestOrigin || 'Unknown DApp')}\`\n` +
                    `⛓️ *Chain ID:* \`${this.currentChainId}\`\n` +
                    `📋 *Params:* \n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
            }

            const message = `⚠️ *PERMINTAAN KONFIRMASI TRANSAKSI*\n\n` +
                `${detailText}\n\n` +
                `⏳ _Auto-reject dalam 120 detik jika tidak ada respons._`;

            this.bot.sendMessage(this.sessionNotificationChatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Accept', callback_data: `tx_approve_${approvalId}` },
                            { text: '❌ Reject', callback_data: `tx_reject_${approvalId}` }
                        ]
                    ]
                }
            }).then(sentMsg => {
                const currentPending = this.pendingTxApprovals.get(approvalId);
                if (currentPending) {
                    currentPending.messageId = sentMsg.message_id;
                }
            }).catch(err => {
                console.warn(`[Session ${this.sessionId}] ⚠️ Tx Approval: Telegram send error:`, err.message);
                this.pendingTxApprovals.delete(approvalId);
                clearTimeout(timer);
                resolve(false); // FAIL-SAFE: Tolak transaksi jika gagal kirim notifikasi
            });
        });
    }

    /**
     * Resolve/Reject manual transaction approval.
     */
    resolveTxApproval(approvalId, approved) {
        const pending = this.pendingTxApprovals.get(approvalId);
        if (!pending) {
            return { ok: false, msg: 'Permintaan sudah expired atau tidak ditemukan.' };
        }

        clearTimeout(pending.timer);
        this.pendingTxApprovals.delete(approvalId);

        if (approved) {
            console.log(`[Session ${this.sessionId}] ✅ Transaction APPROVED: ${pending.method}`);
            if (pending.messageId && this.bot && this.sessionNotificationChatId) {
                this.bot.editMessageText(
                    `✅ *TRANSAKSI DISETUJUI*\n\n` +
                    `Tipe: \`${pending.method}\`\n` +
                    `Status: Disetujui oleh user dan sedang dieksekusi...`,
                    {
                        chat_id: this.sessionNotificationChatId,
                        message_id: pending.messageId,
                        parse_mode: 'Markdown'
                    }
                ).catch(() => { });
            }
            pending.resolve(true);
            return { ok: true, msg: 'Transaction approved.' };
        } else {
            console.log(`[Session ${this.sessionId}] ❌ Transaction REJECTED: ${pending.method}`);
            if (pending.messageId && this.bot && this.sessionNotificationChatId) {
                this.bot.editMessageText(
                    `❌ *TRANSAKSI DITOLAK*\n\n` +
                    `Tipe: \`${pending.method}\`\n` +
                    `Status: Ditolak oleh user`,
                    {
                        chat_id: this.sessionNotificationChatId,
                        message_id: pending.messageId,
                        parse_mode: 'Markdown'
                    }
                ).catch(() => { });
            }
            pending.reject(new Error('User rejected the transaction'));
            return { ok: true, msg: 'Transaction rejected.' };
        }
    }

    /**
     * Menambahkan DApp ke daftar yang disetujui (connected).
     */
    addConnectedDapp(details) {
        if (!this.connectedDapps) this.connectedDapps = [];
        // Gunakan URL DApp sebagai pengenal unik agar tidak duplikat
        const exists = this.connectedDapps.some(d => d.url === details.dappUrl);
        if (!exists) {
            // Generate id unik pendek
            const id = 'dapp_' + Math.random().toString(36).substring(2, 9);
            this.connectedDapps.push({
                id,
                url: details.dappUrl,
                name: details.dappName || 'Unknown DApp',
                connectedAt: new Date().toISOString(),
                via: details.via || 'Unknown'
            });
            this.saveRpcConfig();
        }
        if (details.dappUrl) {
            this.updateDappActivity(details.dappUrl);
        }
    }

    /**
     * Menghapus DApp dari daftar koneksi disetujui berdasarkan ID.
     */
    removeConnectedDapp(id) {
        if (!this.connectedDapps) this.connectedDapps = [];
        const dapp = this.connectedDapps.find(d => d.id === id);
        if (dapp) {
            // Jika via WalletConnect, putuskan koneksi di level WalletConnect juga secara aktif
            if (dapp.via === 'WalletConnect' && this.signClient) {
                try {
                    const sessions = this.signClient.session.values || [];
                    const wcSession = sessions.find(s => s.peer?.metadata?.url === dapp.url);
                    if (wcSession) {
                        console.log(`[Session ${this.sessionId}] Active disconnect of WC session for URL: ${dapp.url}`);
                        this.signClient.disconnect({
                            topic: wcSession.topic,
                            reason: { code: 6000, message: 'User disconnected' }
                        }).catch(() => { });
                    }
                } catch (err) {
                    console.log(`[Session ${this.sessionId}] Error disconnecting WC session:`, err.message);
                }
            }
            this.connectedDapps = this.connectedDapps.filter(d => d.id !== id);
            this.saveRpcConfig();

            // Bersihkan tracker aktivitas jika ada
            const normUrl = dapp.url.trim().replace(/\/$/, '');
            if (this.dappLastActiveTimes) {
                delete this.dappLastActiveTimes[normUrl];
            }
        }
    }

    /**
     * Menyegarkan waktu aktivitas terakhir untuk DApp tertentu.
     */
    updateDappActivity(url) {
        if (!url) return;
        if (!this.dappLastActiveTimes) {
            this.dappLastActiveTimes = {};
        }
        const normUrl = url.trim().replace(/\/$/, '');
        this.dappLastActiveTimes[normUrl] = Date.now();
    }

    /**
     * Memeriksa ketidakaktifan seluruh DApp yang terhubung.
     */
    checkDappsInactivity() {
        if (!this.connectedDapps || this.connectedDapps.length === 0) return;

        const timeoutMinutes = this.dappInactivityTimeout || 30;
        if (timeoutMinutes <= 0) return; // 0 artinya dinonaktifkan

        const timeoutMs = timeoutMinutes * 60 * 1000;
        const now = Date.now();
        const dappsToDisconnect = [];

        if (!this.dappLastActiveTimes) {
            this.dappLastActiveTimes = {};
        }

        for (const dapp of this.connectedDapps) {
            const normUrl = dapp.url.trim().replace(/\/$/, '');
            const lastActive = this.dappLastActiveTimes[normUrl];

            // Jika belum tercatat, set ke waktu sekarang agar tidak langsung terputus
            if (!lastActive) {
                this.dappLastActiveTimes[normUrl] = now;
                continue;
            }

            if (now - lastActive > timeoutMs) {
                dappsToDisconnect.push(dapp);
            }
        }

        for (const dapp of dappsToDisconnect) {
            console.log(`[Session ${this.sessionId}] Auto-disconnecting DApp due to inactivity: ${dapp.name} (${dapp.url})`);

            this.removeConnectedDapp(dapp.id);

            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(
                    this.sessionNotificationChatId,
                    `🔌 *DAPP AUTO-DISCONNECT (INACTIVITY)*\n\n` +
                    `📛 DApp   : *${this._escapeMarkdown(dapp.name)}*\n` +
                    `🌐 URL    : \`${this._escapeMarkdown(dapp.url)}\`\n` +
                    `📡 Via    : ${this._escapeMarkdown(dapp.via)}\n` +
                    `⏱️ Batas  : ${timeoutMinutes} menit tanpa aktivitas\n` +
                    `🕒 Waktu  : ${new Date().toLocaleString('id-ID')}\n\n` +
                    `⚠️ DApp ini otomatis diputus karena tidak ada aktivitas transaksi selama ${timeoutMinutes} menit.`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.warn(`[Session ${this.sessionId}] Telegram notify error:`, e.message));
            }
        }
    }

    /**
     * Memeriksa apakah DApp dengan URL tertentu sudah disetujui (connected).
     */
    isDappConnected(url) {
        if (!url || url === 'Unknown Origin') return false;
        if (!this.connectedDapps) this.connectedDapps = [];
        const normUrl = url.trim().replace(/\/$/, '').toLowerCase();
        return this.connectedDapps.some(d => {
            const dNorm = d.url.trim().replace(/\/$/, '').toLowerCase();
            return dNorm === normUrl || dNorm.includes(normUrl) || normUrl.includes(dNorm);
        });
    }

    /**
     * Kirim notifikasi info-only ke Telegram (mode OFF).
     */
    sendDappConnectNotification(details) {
        if (!this.bot || !this.sessionNotificationChatId) return;

        const message =
            `ℹ️ *DAPP AUTO-CONNECTED*\n\n` +
            `🌐 *DApp:* ${this._escapeMarkdown(details.dappName || 'Unknown DApp')}\n` +
            `🔗 *URL:* ${this._escapeMarkdown(details.dappUrl || 'Unknown')}\n` +
            `⛓️ *Chain ID:* ${details.chainId || this.currentChainId}\n` +
            `💳 *Wallet:* \`${details.walletAddress || this.wallet?.address || 'N/A'}\`\n` +
            `📡 *Via:* ${details.via || 'Unknown'}\n` +
            `🕒 *Waktu:* ${new Date().toLocaleString()}\n\n` +
            `_DApp Connection: Auto-Connect (RPC Auto)_`;

        this.bot.sendMessage(this.sessionNotificationChatId, message, {
            parse_mode: 'Markdown'
        }).catch(err => console.warn(`[Telegram] DApp notify error: ${err.message}`));
    }

    /**
     * [v20.1] Cek apakah Auto Approve Tx aktif untuk RPC yang sedang digunakan.
     * Membaca properti autoApprove dari objek RPC yang sedang aktif di savedRpcs.
     * Default: true (auto) jika properti tidak ditemukan.
     */
    isAutoApproveActive() {
        if (!this.savedRpcs || !this.currentRpc) return true;
        for (const key in this.savedRpcs) {
            if (this.savedRpcs[key].rpc === this.currentRpc) {
                return this.savedRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    /**
     * [v20.2] Cek apakah DApp connection approval diperlukan.
     * - globalDappApproval ON  → selalu minta konfirmasi (tidak tergantung RPC)
     * - globalDappApproval OFF → ikut setting Auto Approve per RPC aktif
     */
    isDappConnectionApprovalRequired() {
        if (this.globalDappApproval) return true;
        return !this.isAutoApproveActive();
    }

    /**
     * Helper: Escape karakter Markdown khusus agar tidak break formatting.
     */
    _escapeMarkdown(text) {
        if (!text) return '';
        return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
    }

    async handleSessionProposal(proposal) {
        try {
            const { id, params } = proposal;
            console.log(`[Session ${this.sessionId}] Processing session proposal...`);

            // Extract DApp metadata dari proposal
            const proposerMeta = params?.proposer?.metadata || {};
            const dappDetails = {
                dappName: proposerMeta.name || 'Unknown DApp',
                dappUrl: proposerMeta.url || 'Unknown',
                dappIcon: (proposerMeta.icons && proposerMeta.icons[0]) || null,
                chainId: this.currentChainId,
                walletAddress: this.wallet?.address || 'N/A',
                via: 'WalletConnect'
            };

            // [v20.2] DApp Approval Check — gunakan isDappConnectionApprovalRequired()
            const isConnected = this.isDappConnected(dappDetails.dappUrl);
            const dappApprovalRequired = this.isDappConnectionApprovalRequired();

            if (dappApprovalRequired && !isConnected) {
                const approvalSource = this.globalDappApproval ? 'Global ON' : 'Manual RPC';
                console.log(`[Session ${this.sessionId}] 🔐 DApp Approval ON (${approvalSource}) — menunggu persetujuan user...`);
                try {
                    await this.requestDappApproval(dappDetails);
                    console.log(`[Session ${this.sessionId}] ✅ DApp disetujui oleh user.`);
                    this.addConnectedDapp(dappDetails);
                } catch (approvalError) {
                    console.log(`[Session ${this.sessionId}] ❌ DApp ditolak: ${approvalError.message}`);
                    // Reject session proposal
                    try {
                        await this.signClient.reject({ id, reason: { code: 4001, message: 'User rejected the connection' } });
                    } catch (rejectErr) {
                        console.warn(`[Session ${this.sessionId}] Error rejecting proposal: ${rejectErr.message}`);
                    }
                    return;
                }
            } else if (!isConnected) {
                // Mode OFF dan belum ada di list: simpan dan kirim notifikasi info-only
                this.addConnectedDapp(dappDetails);
                this.sendDappConnectNotification(dappDetails);
            }

            await this.delayExecution('Approving Session Connection');

            const namespaces = {
                eip155: {
                    accounts: [`eip155:${this.currentChainId}:${this.wallet.address}`],
                    methods: [
                        'eth_sendTransaction', 'eth_signTransaction', 'eth_sign',
                        'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4',
                        'wallet_addEthereumChain', 'wallet_switchEthereumChain'
                    ],
                    events: ['chainChanged', 'accountsChanged']
                }
            };

            console.log(`[Session ${this.sessionId}] Approving with namespaces...`);
            const approveResponse = await this.signClient.approve({ id, namespaces });
            this.session = approveResponse;
            this.isConnected = true;
            console.log(`[Session ${this.sessionId}] Session approved successfully!`);
            console.log(`[Session ${this.sessionId}] Session topic:`, this.session.topic);

            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `🟢 [${this.sessionId}] WALLETCONNECT TERHUBUNG!\n\n` +
                    `💳 ${this.wallet.address}\n` +
                    `⛓️ Chain ${this.currentChainId}\n` +
                    `🌐 RPC: ${this.currentRpcName}\n` +
                    `⚙️ Auto-Save RPC: ${this.autoSaveRpc ? 'ON' : 'OFF'}\n` +
                    `⏱️ Delay Mode: ${this.executionDelay}s\n` +
                    `🤖 Bot siap auto-approve transaksi!`
                ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error approving session:`, error.message);
        }
    }

    async handleSessionRequest(request) {
        try {
            const { id, topic, params } = request;
            const method = params.request?.method;
            console.log(`[Session ${this.sessionId}] Handling session request:`, method);

            if (method && (
                method.startsWith('eth_') ||
                method === 'personal_sign' ||
                method === 'eth_signTypedData' ||
                method === 'wallet_addEthereumChain' ||
                method === 'wallet_switchEthereumChain'
            )) {
                console.log(`[Session ${this.sessionId}] Transaction request detected`);
                await this.handleTransactionRequest(request);
                return;
            }

            await this.signClient.respond({
                topic, response: { id, jsonrpc: '2.0', result: '0x' }
            });
            console.log(`[Session ${this.sessionId}] Session request approved`);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error handling session request:`, error.message);
            if (request.topic) {
                try {
                    await this.signClient.respond({
                        topic: request.topic,
                        response: { id: request.id, jsonrpc: '2.0', error: { code: -32000, message: error.message } }
                    });
                } catch (respondError) {
                    console.log(`[Session ${this.sessionId}] Error responding to session request:`, respondError.message);
                }
            }
        }
    }

    bigIntToString(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'bigint') return obj.toString();
        if (Array.isArray(obj)) return obj.map(item => this.bigIntToString(item));
        if (typeof obj === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = this.bigIntToString(value);
            }
            return result;
        }
        return obj;
    }

    async handleTransactionRequest(request) {
        let method;
        try {
            const { id, topic, params } = request;
            method = params.request?.method;
            console.log('\n' + '🔔'.repeat(20));
            console.log(`[Session ${this.sessionId}] TRANSAKSI DITERIMA!`);
            console.log(`[Session ${this.sessionId}] Method:`, method);
            console.log(`[Session ${this.sessionId}] Topic:`, topic);

            let requestOrigin = null;
            // Reset inactivity timer untuk WalletConnect DApp
            if (this.signClient && topic) {
                try {
                    const session = this.signClient.session.get(topic);
                    const url = session?.peer?.metadata?.url;
                    if (url) {
                        requestOrigin = url;
                        this.updateDappActivity(url);
                    }
                } catch (err) { }
            }

            if (!topic) throw new Error('Topic tidak ditemukan dalam request');

            await this.delayExecution(`Transaction (${method})`);

            let result;
            switch (method) {
                case 'eth_sendTransaction':
                    console.log(`[Session ${this.sessionId}] Transaction params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[0]), null, 2));
                    result = await this.handleSendTransaction(params.request.params[0], requestOrigin);
                    break;

                case 'eth_signTransaction':
                    console.log(`[Session ${this.sessionId}] Sign transaction params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[0]), null, 2));
                    result = await this.handleSignTransaction(params.request.params[0], requestOrigin);
                    break;

                case 'personal_sign':
                    console.log(`[Session ${this.sessionId}] Personal sign params:`, params.request.params);
                    result = await this.handlePersonalSign(params.request.params, requestOrigin);
                    break;

                case 'eth_sign':
                    console.log(`[Session ${this.sessionId}] Eth sign params:`, params.request.params);
                    result = await this.handleEthSign(params.request.params, requestOrigin);
                    break;

                case 'eth_signTypedData':
                case 'eth_signTypedData_v4':
                    console.log(`[Session ${this.sessionId}] Typed data params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[1]), null, 2));
                    result = await this.handleSignTypedData(params.request.params, requestOrigin);
                    break;

                case 'wallet_addEthereumChain':
                    console.log(`[Session ${this.sessionId}] Wallet addEthereumChain params:`, params.request.params);
                    result = await this.handleAddEthereumChain(params.request.params);
                    break;

                case 'wallet_switchEthereumChain':
                    console.log(`[Session ${this.sessionId}] Wallet switchEthereumChain params:`, params.request.params);
                    result = await this.handleSwitchEthereumChain(params.request.params);
                    break;

                default:
                    console.log(`[Session ${this.sessionId}] Method tidak didukung:`, method);
                    throw new Error(`Method ${method} tidak didukung`);
            }

            await this.signClient.respond({
                topic, response: { id, jsonrpc: '2.0', result }
            });
            console.log(`[Session ${this.sessionId}] Transaksi diapprove!`);

            if (method.startsWith('eth_') || method === 'personal_sign') {
                const txCount = await this.getTransactionCount(this.wallet.address);
                console.log(`[Session ${this.sessionId}] Total transaksi: ${txCount}`);

                if (this.bot && this.sessionNotificationChatId) {
                    let txHashText = '';
                    if (method === 'eth_sendTransaction' && result) {
                        const explorer = this.getActiveRpcExplorer();
                        if (explorer) {
                            txHashText = `🔍 Tx Hash: [${result}](${explorer}/tx/${result})\n`;
                        } else {
                            txHashText = `🔍 Tx Hash: \`${result}\`\n`;
                        }
                    }

                    this.bot.sendMessage(this.sessionNotificationChatId,
                        `✅ *[${this.sessionId}] TRANSAKSI DI-APPROVE!*\n` +
                        `📊 Total Transaksi: ${txCount}\n\n` +
                        `💳 \`${this.wallet.address}\`\n` +
                        `Method: \`${method}\`\n` +
                        `⛓️ Chain: *${this.currentChainId}*\n` +
                        `🌐 RPC: *${this.currentRpcName}*\n` +
                        txHashText +
                        `⏱️ Delay Used: ${this.executionDelay}s\n` +
                        `🕒 ${new Date().toLocaleString()}`,
                        { parse_mode: 'Markdown' }
                    ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
                }
            } else {
                console.log(`[Session ${this.sessionId}] Respon sukses dikirim untuk method: ${method}`);
            }

        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error handling transaction:`, error.message);
            if (request.topic) {
                try {
                    await this.signClient.respond({
                        topic: request.topic,
                        response: { id: request.id, jsonrpc: '2.0', error: { code: -32000, message: error.message } }
                    });
                } catch (respondError) {
                    console.log(`[Session ${this.sessionId}] Error responding to transaction request:`, respondError.message);
                }
            }

            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `❌ [${this.sessionId}] TRANSAKSI GAGAL!\n\n` +
                    `💳 ${this.wallet.address}\n` +
                    `Method: ${method}\n` +
                    `Error: ${error.message}\n` +
                    `⛓️ Chain: ${this.currentChainId}\n` +
                    `🌐 RPC: ${this.currentRpcName}\n` +
                    `🕒 ${new Date().toLocaleString()}`
                ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }
        }
    }

    async handleSendTransaction(txParams, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        if (!this.isAutoApproveActive()) {
            const approved = await this.requestTxApproval('eth_sendTransaction', [txParams], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }
        const walletAddress = this.wallet.address;
        const chainId = this.currentChainId;
        if (globalTxQueue.isQueued(walletAddress, chainId)) {
            console.log(`[TxQueue][${this.sessionId}] ⏳ Tx masuk antrian — menunggu tx sebelumnya selesai...`);
            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `⏳ [${this.sessionId}] TX MASUK ANTRIAN\n\nAda transaksi sebelumnya yang sedang diproses.\nTransaksi ini akan dieksekusi otomatis setelah selesai.\n💳 ${walletAddress}\n⛓️ Chain: ${chainId}`
                ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }
        }
        return globalTxQueue.enqueue(walletAddress, chainId, this.sessionId, async () => {
            return await this._doSendTransaction(txParams);
        });
    }

    async _doSendTransaction(txParams) {
        return this.runWithFailover(async () => {
            console.log(`[Session ${this.sessionId}] Handling send transaction...`);
            const safeTxParams = { ...txParams };

            if (!safeTxParams.chainId) {
                safeTxParams.chainId = this.currentChainId;
            }

            if (safeTxParams.gasLimit && typeof safeTxParams.gasLimit === 'bigint') {
                safeTxParams.gasLimit = safeTxParams.gasLimit.toString();
            }

            if (safeTxParams.value && typeof safeTxParams.value === 'bigint') {
                safeTxParams.value = safeTxParams.value.toString();
            }

            // Gas Configuration Logic
            const gasConfig = this.getActiveRpcGasConfig();
            console.log(`[Session ${this.sessionId}] Gas Strategy: ${gasConfig.mode.toUpperCase()}`);

            if (gasConfig.mode === 'manual' && gasConfig.value > 0) {
                const gweiValue = ethers.parseUnits(gasConfig.value.toString(), 'gwei');
                console.log(`[Session ${this.sessionId}] 🛠 FORCE GAS: ${gasConfig.value} Gwei`);

                // FIX: Don't mix legacy gasPrice with EIP-1559 params (maxFeePerGas/maxPriorityFeePerGas)
                // Remove any existing EIP-1559 params and use legacy gasPrice only
                delete safeTxParams.maxFeePerGas;
                delete safeTxParams.maxPriorityFeePerGas;
                safeTxParams.gasPrice = gweiValue;

            } else if (gasConfig.mode === 'aggressive' && gasConfig.value > 0) {
                try {
                    const feeData = await this.provider.getFeeData();
                    const boostFactor = 100n + BigInt(Math.floor(gasConfig.value));

                    if (feeData.maxFeePerGas) {
                        safeTxParams.maxFeePerGas = (feeData.maxFeePerGas * boostFactor) / 100n;
                        // FIX: Guard against null maxPriorityFeePerGas before multiplying
                        safeTxParams.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
                            ? (feeData.maxPriorityFeePerGas * boostFactor) / 100n
                            : safeTxParams.maxFeePerGas;
                        // FIX: Ensure maxPriorityFeePerGas doesn't exceed maxFeePerGas
                        if (safeTxParams.maxPriorityFeePerGas > safeTxParams.maxFeePerGas) {
                            safeTxParams.maxPriorityFeePerGas = safeTxParams.maxFeePerGas;
                        }
                        // FIX: Remove legacy gasPrice if using EIP-1559 params
                        delete safeTxParams.gasPrice;
                        console.log(`[Session ${this.sessionId}] 🚀 AGGRESSIVE GAS (+${gasConfig.value}%)`);
                    } else if (feeData.gasPrice) {
                        safeTxParams.gasPrice = (feeData.gasPrice * boostFactor) / 100n;
                        // FIX: Remove EIP-1559 params if using legacy gasPrice
                        delete safeTxParams.maxFeePerGas;
                        delete safeTxParams.maxPriorityFeePerGas;
                        console.log(`[Session ${this.sessionId}] 🚀 AGGRESSIVE GAS PRICE (+${gasConfig.value}%)`);
                    }
                } catch (e) {
                    console.log(`[Session ${this.sessionId}] ⚠️ Gagal fetch fee data, fallback ke Auto.`);
                }
            }

            // Auto Mode Fallback
            if (!safeTxParams.gasPrice && !safeTxParams.maxFeePerGas) {
                try {
                    const feeData = await this.provider.getFeeData();
                    if (feeData.maxFeePerGas) {
                        safeTxParams.maxFeePerGas = feeData.maxFeePerGas?.toString();
                        // FIX: Guard against null maxPriorityFeePerGas
                        safeTxParams.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas?.toString()
                            ?? safeTxParams.maxFeePerGas;
                        // FIX: Don't mix EIP-1559 with legacy
                        delete safeTxParams.gasPrice;
                        console.log(`[Session ${this.sessionId}] Using Auto maxFeePerGas`);
                    } else if (feeData.gasPrice) {
                        safeTxParams.gasPrice = feeData.gasPrice?.toString();
                        delete safeTxParams.maxFeePerGas;
                        delete safeTxParams.maxPriorityFeePerGas;
                        console.log(`[Session ${this.sessionId}] Using Auto gasPrice (legacy)`);
                    }
                } catch (error) {
                    console.log(`[Session ${this.sessionId}] Failed to get fee data, using defaults`);
                    safeTxParams.gasPrice = '1000000000';
                    delete safeTxParams.maxFeePerGas;
                    delete safeTxParams.maxPriorityFeePerGas;
                }
            }

            console.log(`[Session ${this.sessionId}] Estimating gas limit...`);
            try {
                const estimateParams = { ...safeTxParams };
                if (estimateParams.gasLimit) delete estimateParams.gasLimit;
                const estimatedGas = await this.provider.estimateGas(estimateParams);
                if (estimatedGas) {
                    // FIX: Ensure estimatedGas is BigInt before arithmetic, then convert to string
                    const estimatedBig = BigInt(estimatedGas.toString());
                    safeTxParams.gasLimit = (estimatedBig * 120n / 100n).toString();
                    console.log(`[Session ${this.sessionId}] Estimated gas: ${estimatedBig}, using: ${safeTxParams.gasLimit}`);
                } else {
                    throw new Error('Gas estimation returned undefined');
                }
            } catch (error) {
                console.log(`[Session ${this.sessionId}] Gas estimation failed:`, error.message);
                safeTxParams.gasLimit = (safeTxParams.data && safeTxParams.data !== '0x') ? '100000' : '25000';
                console.log(`[Session ${this.sessionId}] Using default gas: ${safeTxParams.gasLimit}`);
            }

            console.log(`[Session ${this.sessionId}] Sending transaction...`);
            try {
                const tx = await this.wallet.sendTransaction(safeTxParams);
                console.log(`[Session ${this.sessionId}] Transaction sent:`, tx.hash);
                this.waitForConfirmation(tx.hash);
                return tx.hash;
            } catch (error) {
                console.log(`[Session ${this.sessionId}] Error sending transaction:`, error.message);
                if (error.message.includes('insufficient funds') || error.code === 'INSUFFICIENT_FUNDS') {
                    throw new Error('Saldo tidak cukup untuk melakukan transaksi');
                }
                if (error.message.includes('nonce') || error.code === 'NONCE_EXPIRED') {
                    throw new Error('Nonce invalid, coba restart bot');
                }
                throw error;
            }
        });
    }

    async waitForConfirmation(txHash) {
        try {
            console.log(`[Session ${this.sessionId}] Waiting for confirmation...`);
            const receipt = await this.provider.waitForTransaction(txHash);
            if (receipt.status === 1) {
                console.log(`[Session ${this.sessionId}] Transaction confirmed in block:`, receipt.blockNumber);
            } else {
                console.log(`[Session ${this.sessionId}] Transaction failed in block:`, receipt.blockNumber);
            }
            return receipt;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error waiting for confirmation:`, error.message);
            return null;
        }
    }

    async handleSignTransaction(txParams, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        if (!this.isAutoApproveActive()) {
            const approved = await this.requestTxApproval('eth_signTransaction', [txParams], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }
        console.log(`[Session ${this.sessionId}] Handling sign transaction...`);
        const safeTxParams = { ...txParams };
        if (!safeTxParams.chainId) safeTxParams.chainId = this.currentChainId;
        if (safeTxParams.gasLimit && typeof safeTxParams.gasLimit === 'bigint') {
            safeTxParams.gasLimit = safeTxParams.gasLimit.toString();
        }
        if (safeTxParams.value && typeof safeTxParams.value === 'bigint') {
            safeTxParams.value = safeTxParams.value.toString();
        }
        const signedTx = await this.wallet.signTransaction(safeTxParams);
        console.log(`[Session ${this.sessionId}] Transaction signed`);
        return signedTx;
    }

    async handlePersonalSign(params, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        if (!this.isAutoApproveActive()) {
            const approved = await this.requestTxApproval('personal_sign', params, requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }
        console.log(`[Session ${this.sessionId}] Handling personal sign...`);
        const messageHex = params[0];
        const address = params[1];
        console.log(`[Session ${this.sessionId}] Original hex message: ${messageHex.substring(0, 60)}...`);

        let messageToSign;
        if (ethers.isHexString(messageHex)) {
            try {
                messageToSign = ethers.toUtf8String(messageHex);
                console.log(`[Session ${this.sessionId}] Message decoded to: ${messageToSign.substring(0, 60)}...`);
            } catch (e) {
                console.log(`[Session ${this.sessionId}] Warning: Gagal decode hex, tanda tangan mentah.`);
                messageToSign = messageHex;
            }
        } else {
            messageToSign = messageHex;
        }

        const signedMessage = await this.wallet.signMessage(messageToSign);
        console.log(`[Session ${this.sessionId}] Message signed`);
        return signedMessage;
    }

    async handleAddEthereumChain(params) {
        const chainParams = params[0];
        console.log(`[Session ${this.sessionId}] Handling addEthereumChain:`, JSON.stringify(chainParams, null, 2));

        if (!this.autoSaveRpc) {
            console.log(`[Session ${this.sessionId}] ⚠️ Auto-Save RPC is OFF. Ignoring DApp request.`);
            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `⚠️ [${this.sessionId}] PERMINTAAN GANTI RPC DIABAIKAN\n\n` +
                    `DApp meminta menambahkan jaringan baru, tetapi Auto-Save RPC sedang OFF.`
                ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }
            throw new Error("User rejected the request (Auto-Save RPC is disabled).");
        }

        try {
            const chainId = parseInt(chainParams.chainId, 16);
            if (!chainId || !chainParams.rpcUrls || !chainParams.rpcUrls[0]) {
                throw new Error('Invalid chain parameters from DApp');
            }

            const newRpc = {
                name: chainParams.chainName || `DApp Network ${chainId}`,
                rpc: chainParams.rpcUrls[0],
                chainId: chainId,
                symbol: chainParams.nativeCurrency?.symbol || 'ETH',
                gasConfig: { mode: 'auto', value: 0 }
            };

            const key = `dapp_${chainId}`;
            this.savedRpcs[key] = newRpc;
            console.log(`[Session ${this.sessionId}] RPC baru disimpan: ${newRpc.name}`);
            console.log(`[Session ${this.sessionId}] Otomatis beralih ke RPC baru...`);

            this.currentRpc = newRpc.rpc;
            this.currentChainId = newRpc.chainId;
            this.currentRpcName = newRpc.name;

            this.setupProvider();
            this.saveRpcConfig();

            console.log(`[Session ${this.sessionId}] Berhasil beralih ke Chain ID: ${this.currentChainId}`);

            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `🔄 [${this.sessionId}] RPC OTOMATIS DISIMPAN\n\n` +
                    `Nama: ${newRpc.name}\n` +
                    `Chain ID: ${newRpc.chainId}`
                ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
            }

            if (this.session && this.session.topic) {
                console.log(`[Session ${this.sessionId}] Mengirim updateSession ke DApp...`);
                const newNamespaces = {
                    eip155: {
                        accounts: [`eip155:${this.currentChainId}:${this.wallet.address}`],
                        methods: [
                            'eth_sendTransaction', 'eth_signTransaction', 'eth_sign',
                            'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4',
                            'wallet_addEthereumChain', 'wallet_switchEthereumChain'
                        ],
                        events: ['chainChanged', 'accountsChanged']
                    }
                };
                await this.signClient.updateSession({
                    topic: this.session.topic,
                    namespaces: newNamespaces
                });
                console.log(`[Session ${this.sessionId}] Sesi berhasil diupdate`);
            }

            return null;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error adding chain:`, error.message);
            throw error;
        }
    }

    async handleSwitchEthereumChain(params) {
        const { chainId: chainIdHex } = params[0];
        console.log(`[Session ${this.sessionId}] Handling switchEthereumChain to: ${chainIdHex}`);

        try {
            const chainIdNum = parseInt(chainIdHex, 16);
            let mustUpdateSession = false;

            if (this.currentChainId === chainIdNum) {
                console.log(`[Session ${this.sessionId}] Sudah berada di Chain ID ${chainIdNum}.`);
                mustUpdateSession = true;

            } else {
                let foundRpc = null;
                for (const key in this.savedRpcs) {
                    if (this.savedRpcs[key].chainId === chainIdNum) {
                        foundRpc = this.savedRpcs[key];
                        break;
                    }
                }

                if (foundRpc) {
                    console.log(`[Session ${this.sessionId}] RPC ditemukan, beralih ke: ${foundRpc.name}`);
                    this.currentRpc = foundRpc.rpc;
                    this.currentChainId = foundRpc.chainId;
                    this.currentRpcName = foundRpc.name;
                    this.setupProvider();
                    this.saveRpcConfig();
                    mustUpdateSession = true;

                    if (this.bot && this.sessionNotificationChatId) {
                        this.bot.sendMessage(this.sessionNotificationChatId,
                            `🔄 [${this.sessionId}] RPC DIGANTI\n\n` +
                            `Nama: ${foundRpc.name}\n` +
                            `Chain ID: ${foundRpc.chainId}`
                        ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
                    }
                } else {
                    console.log(`[Session ${this.sessionId}] RPC untuk Chain ID ${chainIdNum} tidak ditemukan.`);

                    if (!this.autoSaveRpc) {
                        throw new Error(`Unrecognized chain ID ${chainIdHex}. Auto-Save is OFF.`);
                    }

                    throw new Error(`Unrecognized chain ID ${chainIdHex}. Please add it first.`);
                }
            }

            if (mustUpdateSession && this.session && this.session.topic) {
                console.log(`[Session ${this.sessionId}] Mengirim updateSession ke DApp...`);

                const newNamespaces = {
                    eip155: {
                        accounts: [`eip155:${this.currentChainId}:${this.wallet.address}`],
                        methods: [
                            'eth_sendTransaction', 'eth_signTransaction', 'eth_sign',
                            'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4',
                            'wallet_addEthereumChain', 'wallet_switchEthereumChain'
                        ],
                        events: ['chainChanged', 'accountsChanged']
                    }
                };

                await this.signClient.updateSession({
                    topic: this.session.topic,
                    namespaces: newNamespaces
                });

                console.log(`[Session ${this.sessionId}] Sesi berhasil diupdate`);
            }

            return null;

        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error switching chain:`, error.message);
            throw error;
        }
    }

    async checkBalance() {
        if (!this.wallet) {
            const msg = '❌ Wallet belum setup!';
            if (this.rl) console.log(msg);
            return null;
        }

        try {
            console.log(`[Session ${this.sessionId}] Checking balance...`);
            const balance = await this.runWithFailover(() => this.provider.getBalance(this.wallet.address));
            const balanceEth = ethers.formatEther(balance);
            const txCount = await this.getTransactionCount(this.wallet.address);

            if (this.rl) {
                console.log(`💰 Balance: ${balanceEth} ETH`);
                console.log(`💳 Address: ${this.wallet.address}`);
                console.log(`📊 Total Transactions: ${txCount}`);
                console.log(`🌐 RPC: ${this.currentRpcName}`);
            }

            return { balance: balanceEth, txCount: txCount };

        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error checking balance:`, error.message);
            if (this.rl) console.log(`❌ Error: ${error.message}`);
            return null;
        }
    }

    async autoTransactionMode() {
        console.log('\n🎯 SETUP WALLET & CONNECT WALLETCONNECT');
        console.log(`🌐 RPC Saat Ini: ${this.currentRpcName}`);
        console.log(`🔗 URL: ${this.currentRpc}`);
        console.log(`⛓️ Chain ID: ${this.currentChainId}`);
        console.log(`⚙️ Auto-Save RPC: ${this.autoSaveRpc ? 'ON' : 'OFF'}`);

        const changeRpc = await this.question('Ganti RPC sebelum lanjut? (y/n): ');
        if (changeRpc.toLowerCase() === 'y') {
            await this.selectRpc();
        }

        await this.initializeEncryption();

        if (!this.wallet) {
            const wallets = await this.loadWallets();
            if (Object.keys(wallets).length > 0) {
                const useSaved = await this.question('Gunakan wallet yang disimpan? (y/n): ');
                if (useSaved.toLowerCase() === 'y') {
                    await this.useSavedWallet();
                    if (!this.wallet) return;
                } else {
                    const privateKey = await this.question('Masukkan private key: ');
                    if (!this.setupWallet(privateKey)) return;

                    const saveWallet = await this.question('Simpan wallet ini? (y/n): ');
                    if (saveWallet.toLowerCase() === 'y') {
                        const nickname = await this.question('Beri nama wallet (optional): ');
                        await this.saveWallet(privateKey, nickname);
                    }
                }
            } else {
                const privateKey = await this.question('Masukkan private key: ');
                if (!this.setupWallet(privateKey)) return;

                const saveWallet = await this.question('Simpan wallet ini? (y/n): ');
                if (saveWallet.toLowerCase() === 'y') {
                    const nickname = await this.question('Beri nama wallet (optional): ');
                    await this.saveWallet(privateKey, nickname);
                }
            }
        }

        await this.checkBalance();

        console.log('\n📝 Masukkan URI WalletConnect:');
        console.log('Format: wc:... atau walletconnect:wc:...');
        const uri = await this.question('URI: ');

        if (!uri || (!uri.startsWith('wc:') && !uri.startsWith('walletconnect:'))) {
            console.log('❌ URI WalletConnect tidak valid!');
            return;
        }

        const connected = await this.connectWalletConnect(uri);
        if (!connected) return;

        console.log('\n' + '🎉'.repeat(20));
        console.log(`🤖 BOT AKTIF & STANDBY! (Session: ${this.sessionId})`);
        console.log('📡 Menunggu transaksi real dari DApp...');
        console.log('💳 Wallet:', this.wallet.address);
        console.log('⛓️ Chain ID:', this.currentChainId);
        console.log('🌐 RPC:', this.currentRpcName);
        console.log('🎉'.repeat(20));
        console.log('\nTekan Ctrl+C untuk keluar');

        if (this.bot && this.sessionNotificationChatId) {
            this.bot.sendMessage(this.sessionNotificationChatId,
                `🟢 [${this.sessionId}] BOT CLI AKTIF!\n\n` +
                `Status: STANDBY (Menunggu Transaksi)\n` +
                `Wallet: ${this.wallet.address}\n` +
                `Chain: ${this.currentChainId}\n` +
                `Auto-Save RPC: ${this.autoSaveRpc ? 'ON' : 'OFF'}`
            ).catch(err => console.warn(`[Telegram] Notify error: ${err.message}`));
        }

        this.keepAlive();
    }

    keepAlive() {
        // SIGINT ditangani global
    }

    async cleanup() {
        console.log(`[Session ${this.sessionId}] Cleaning up session...`);

        if (this.inactivityInterval) {
            clearInterval(this.inactivityInterval);
        }

        // [v20] Stop semua RPC Inject servers yang sedang berjalan
        if (this.rpcServers && this.rpcServers.size > 0) {
            await this.stopAllRpcServers();
            console.log(`[Session ${this.sessionId}] Semua RPC Inject server dihentikan.`);
        }

        if (this.signClient && this.session) {
            try {
                console.log(`[Session ${this.sessionId}] Disconnecting WalletConnect session...`);
                await this.signClient.disconnect({
                    topic: this.session.topic,
                    reason: { code: 6000, message: 'User disconnected' }
                });
                console.log(`[Session ${this.sessionId}] WalletConnect session disconnected.`);
            } catch (error) {
                if (error.message.includes('Missing or invalid')) {
                    console.log(`[Session ${this.sessionId}] Session was already disconnected.`);
                } else {
                    console.log(`[Session ${this.sessionId}] Error disconnecting:`, error.message);
                }
            }
        }

        this.session = null;
        this.isConnected = false;
    }

    // ═══════════════════════════════════════════════════════
    // 🔐 MANAGE 2FA CLI
    // ═══════════════════════════════════════════════════════

    async manage2FACLI() {
        const tfa = new TwoFactorAuth(this.dataDir);
        const salt = process.env.SYSTEM_ID || 'FASTARX_2FA_DEFAULT_SALT';

        while (true) {
            console.log('\n' + '═'.repeat(55));
            console.log('  🔐 KELOLA GOOGLE AUTHENTICATOR (2FA)');
            console.log('═'.repeat(55));

            // Tampilkan status real-time kedua level
            for (const level of ['admin', 'script']) {
                console.log('  ' + tfa.renderCLI(level, salt).replace(/\n/g, '\n  '));
            }

            console.log('─'.repeat(55));
            console.log('  1. Ganti 2FA Admin (Reset & Setup Baru)');
            console.log('  2. Ganti 2FA Script (Reset & Setup Baru)');
            console.log('  3. Hapus 2FA Admin');
            console.log('  4. Hapus 2FA Script');
            console.log('  5. 🔙 Kembali ke Menu Utama');
            console.log('═'.repeat(55));

            const choice = await this.question('Pilih opsi (1-5): ');

            if (choice === '5' || choice === '') break;

            if (choice === '1' || choice === '2') {
                const level = choice === '1' ? 'admin' : 'script';
                await this._cli2FASetupNew(tfa, salt, level);

            } else if (choice === '3' || choice === '4') {
                const level = choice === '3' ? 'admin' : 'script';
                await this._cli2FADelete(tfa, salt, level);

            } else {
                console.log('❌ Pilihan tidak valid.');
            }
        }
    }

    async _cli2FASetupNew(tfa, salt, level) {
        const lbl = level.toUpperCase();
        const status = tfa.getStatus(level, salt);

        // ── BLOKIR saat grace period ──
        if (status.active && status.inGrace) {
            console.log('\n' + '═'.repeat(55));
            console.log(`  🔒 TIDAK BISA MENGGANTI 2FA ${lbl}`);
            console.log('═'.repeat(55));
            console.log(`  Password ${lbl} telah diubah.`);
            console.log(`  2FA sedang dalam masa grace period.`);
            console.log(`  ⏳ Sisa masa aktif: ${status.graceDetail ? (new TwoFactorAuth(this.dataDir))._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}`);
            console.log('');
            console.log('  Kamu tidak bisa mengubah 2FA selama grace period.');
            console.log('  Tunggu sampai 2FA hangus, lalu login dengan');
            console.log('  password baru untuk setup ulang.');
            console.log('═'.repeat(55));
            await new Promise(r => setTimeout(r, 2000));
            return;
        }

        // ── Jika 2FA expired: harus verifikasi password BARU ──
        if (status.expired || !status.exists) {
            const reason = status.expired
                ? `2FA ${lbl} telah hangus. Verifikasi dengan password ${lbl} yang sekarang.`
                : `2FA ${lbl} belum pernah dipasang.`;
            console.log(`\n🔐 ${reason}`);

            const correctPw = level === 'admin' ? this.config.ADMIN_PASSWORD : this.config.SCRIPT_PASSWORD;
            if (!correctPw) {
                console.log('⚠️ Tidak dapat memverifikasi password. Coba login ulang.');
                return;
            }

            let verified = false;
            for (let i = 0; i < 3; i++) {
                const pw = await this.question(`Password ${lbl} (yang sekarang/baru): `);
                if (pw === correctPw) { verified = true; break; }
                console.log(`❌ Salah. ${2 - i} percobaan tersisa.`);
            }
            if (!verified) {
                console.log('🚫 Verifikasi gagal. Operasi dibatalkan.');
                return;
            }
        } else {
            // 2FA aktif normal: verifikasi OTP lama
            console.log(`\n🔐 GANTI 2FA ${lbl} — Verifikasi OTP lama terlebih dahulu.`);
            const secret = tfa.getSecret(level, salt);
            let verified = false;
            for (let i = 0; i < 3; i++) {
                const token = await this.question('Masukkan kode OTP saat ini: ');
                if (tfa.verifyTOTP(secret, token.trim())) { verified = true; break; }
                console.log(`❌ Salah. ${2 - i} percobaan tersisa.`);
            }
            if (!verified) {
                console.log('🚫 Verifikasi gagal. Operasi dibatalkan.');
                return;
            }
        }

        // Hapus 2FA lama jika ada
        if (status.exists) {
            tfa.remove(level, salt);
            console.log(`🗑️ 2FA ${lbl} lama dihapus.`);
        }

        // Setup baru
        const secret = tfa.generateSecret();
        const accountName = `FA_STARX_${lbl}`;
        const uri = tfa.buildOtpAuthUri(secret, accountName);
        const qrAscii = tfa.generateQrAscii(uri);

        console.clear();
        console.log('\n' + '═'.repeat(55));
        console.log(`  🔐 SETUP 2FA BARU — ${lbl}`);
        console.log('═'.repeat(55));
        console.log(qrAscii);
        console.log('\n📋 SECRET KEY:');
        console.log('\x1b[38;5;214m  ' + secret + '\x1b[0m');
        console.log('\n🔗 OTPAUTH URI:');
        const uriDisplay = uri.length > 80 ? uri.substring(0, 77) + '...' : uri;
        console.log('\x1b[38;5;51m  ' + uriDisplay + '\x1b[0m');
        console.log('\n' + '─'.repeat(55));
        console.log('  LANGKAH:');
        console.log('  1. Buka Google Authenticator di HP');
        console.log('  2. Ketuk (+) → "Enter a setup key"');
        console.log('  3. Isi Account : ' + accountName);
        console.log('  4. Isi Key     : ' + secret);
        console.log('  5. Time based  → Save');
        console.log('─'.repeat(55) + '\n');

        let verified2 = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const token = await this.question(`Masukkan kode 6-digit dari GA (verifikasi ${attempt}/3): `);
            if (tfa.verifyTOTP(secret, token.trim())) { verified2 = true; break; }
            console.log(`❌ Kode salah. ${3 - attempt} percobaan tersisa.`);
        }

        if (!verified2) {
            console.log('❌ Verifikasi gagal. 2FA baru tidak dipasang.');
            return;
        }

        const config = tfa.load(salt);
        const correctPwNow = level === 'admin' ? this.config.ADMIN_PASSWORD : this.config.SCRIPT_PASSWORD;
        const pwHashNow = correctPwNow
            ? require('crypto').createHash('sha256').update(correctPwNow).digest('hex')
            : null;
        config[level] = {
            secret,
            passwordHash: pwHashNow,
            createdAt: Date.now(),
            passwordChangedAt: null,
            active: true
        };
        tfa.save(config, salt);
        console.log(`\n✅ 2FA ${lbl} berhasil dipasang!`);
        console.log('⚠️ SIMPAN secret key di tempat aman sebagai backup!');
        await new Promise(r => setTimeout(r, 1500));
    }

    async _cli2FADelete(tfa, salt, level) {
        const lbl = level.toUpperCase();
        const status = tfa.getStatus(level, salt);

        if (!status.exists || status.expired) {
            console.log(`ℹ️ 2FA ${lbl} ${!status.exists ? 'belum dipasang' : 'sudah hangus dan tidak aktif'}. Tidak ada yang dihapus.`);
            return;
        }

        // ── BLOKIR saat grace period ──
        if (status.active && status.inGrace) {
            console.log('\n' + '═'.repeat(55));
            console.log(`  🔒 TIDAK BISA MENGHAPUS 2FA ${lbl}`);
            console.log('═'.repeat(55));
            console.log(`  Password ${lbl} telah diubah.`);
            console.log(`  2FA sedang dalam masa grace period.`);
            console.log(`  ⏳ Sisa masa aktif: ${status.graceDetail ? (new TwoFactorAuth(this.dataDir))._fmtRemaining(status.graceDetail) : status.graceDaysLeft + ' hari'}`);
            console.log('');
            console.log('  Kamu tidak bisa menghapus 2FA selama grace period.');
            console.log('═'.repeat(55));
            await new Promise(r => setTimeout(r, 2000));
            return;
        }

        // 2FA aktif normal: verifikasi OTP sebelum hapus
        console.log(`\n⚠️ HAPUS 2FA — ${lbl}`);
        console.log('Setelah dihapus, login hanya bisa dengan password.');
        const confirm = await this.question(`Konfirmasi hapus 2FA ${lbl}? (ketik "hapus" untuk lanjut): `);
        if (confirm.toLowerCase() !== 'hapus') {
            console.log('⏭️ Dibatalkan.');
            return;
        }

        const secret = tfa.getSecret(level, salt);
        let ok = false;
        for (let i = 0; i < 3; i++) {
            const token = await this.question('Verifikasi OTP sebelum hapus: ');
            if (tfa.verifyTOTP(secret, token.trim())) { ok = true; break; }
            console.log(`❌ Salah. ${2 - i} percobaan tersisa.`);
        }
        if (!ok) {
            console.log('🚫 Verifikasi gagal. 2FA tidak dihapus.');
            return;
        }

        tfa.remove(level, salt);
        console.log(`✅ 2FA ${lbl} berhasil dihapus.`);
        await new Promise(r => setTimeout(r, 1000));
    }

    async run() {
        try {
            await this.showMenu();
            const choice = await this.question('Pilih mode (1-7): ');

            switch (choice) {
                case '1':
                    await this.autoTransactionMode();
                    break;
                case '2':
                    await this.rpcInjectMode();
                    await this.run();
                    break;
                case '3':
                    await this.checkBalance();
                    await this.run();
                    break;
                case '4':
                    await this.walletManagementMode();
                    await this.run();
                    break;
                case '5':
                    await this.rpcManagementMode();
                    await this.run();
                    break;
                case '6':
                    await this.manage2FACLI();
                    await this.run();
                    break;
                case '7':
                    console.log('👋 Keluar...');
                    await this.cleanup();
                    this.rl.close();
                    break;
                default:
                    console.log('❌ Pilihan tidak valid!');
                    await this.run();
                    break;
            }
        } catch (error) {
            console.log('❌ Error:', error.message);
            await this.cleanup();
            if (this.rl) {
                this.rl.close();
            }
        }
    }

    async handleEthSign(params, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        if (!this.isAutoApproveActive()) {
            const approved = await this.requestTxApproval('eth_sign', params, requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }
        console.log(`[Session ${this.sessionId}] Handling eth_sign...`);
        // eth_sign: params[0] = address, params[1] = message hex
        const messageHex = params[1];
        const signedMessage = await this.wallet.signMessage(ethers.getBytes(messageHex));
        console.log(`[Session ${this.sessionId}] eth_sign completed`);
        return signedMessage;
    }

    async handleSignTypedData(params, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        if (!this.isAutoApproveActive()) {
            const approved = await this.requestTxApproval('eth_signTypedData', params, requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }
        console.log(`[Session ${this.sessionId}] Handling eth_signTypedData...`);
        // params[0] = address, params[1] = typed data JSON string or object
        let typedData = params[1];
        if (typeof typedData === 'string') {
            typedData = JSON.parse(typedData);
        }
        const { domain, types, message } = typedData;
        // Remove EIP712Domain from types if present (ethers v6 adds it automatically)
        const filteredTypes = { ...types };
        delete filteredTypes.EIP712Domain;
        const signedData = await this.wallet.signTypedData(domain, filteredTypes, message);
        console.log(`[Session ${this.sessionId}] eth_signTypedData completed`);
        return signedData;
    }

    async getActiveSolanaAddress() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return this.deriveSolanaAddress(walletData.mnemonic);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveSolanaAddress:`, error.message);
            return null;
        }
    }

    async getActiveSolanaKeypair() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;

            const m = ethers.Mnemonic.fromPhrase(walletData.mnemonic);
            const seedHex = m.computeSeed().slice(2);
            const derived = derivePath("m/44'/501'/0'/0'", seedHex);
            return Keypair.fromSeed(derived.key);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveSolanaKeypair:`, error.message);
            return null;
        }
    }

    isSolanaAutoApproveActive() {
        if (!this.savedSolanaRpcs || !this.currentSolanaRpc) return true;
        for (const key in this.savedSolanaRpcs) {
            if (this.savedSolanaRpcs[key].rpc === this.currentSolanaRpc) {
                return this.savedSolanaRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    async getActiveAptosAddress() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return this.deriveAptosAddress(walletData.mnemonic);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveAptosAddress:`, error.message);
            return null;
        }
    }

    isAptosAutoApproveActive() {
        if (!this.savedAptosRpcs || !this.currentAptosRpc) return true;
        for (const key in this.savedAptosRpcs) {
            if (this.savedAptosRpcs[key].rpc === this.currentAptosRpc) {
                return this.savedAptosRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    async getActiveSuiAddress() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return this.deriveSuiAddress(walletData.mnemonic);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveSuiAddress:`, error.message);
            return null;
        }
    }

    async getActiveSuiKeypair() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return Ed25519Keypair.deriveKeypair(walletData.mnemonic, "m/44'/784'/0'/0'/0'");
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveSuiKeypair:`, error.message);
            return null;
        }
    }

    isSuiAutoApproveActive() {
        if (!this.savedSuiRpcs || !this.currentSuiRpc) return true;
        for (const key in this.savedSuiRpcs) {
            if (this.savedSuiRpcs[key].rpc === this.currentSuiRpc) {
                return this.savedSuiRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    async getActiveTonAddress() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return await this.deriveTonAddress(walletData.mnemonic);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveTonAddress:`, error.message);
            return null;
        }
    }

    isTonAutoApproveActive() {
        if (!this.savedTonRpcs || !this.currentTonRpc) return true;
        for (const key in this.savedTonRpcs) {
            if (this.savedTonRpcs[key].rpc === this.currentTonRpc) {
                return this.savedTonRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    async getActiveNearAddress() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return this.deriveNearAddress(walletData.mnemonic);
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveNearAddress:`, error.message);
            return null;
        }
    }

    isNearAutoApproveActive() {
        if (!this.savedNearRpcs || !this.currentNearRpc) return true;
        for (const key in this.savedNearRpcs) {
            if (this.savedNearRpcs[key].rpc === this.currentNearRpc) {
                return this.savedNearRpcs[key].autoApprove !== false;
            }
        }
        return true;
    }

    async handleSolanaSignTransaction(txHex, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        const keypair = await this.getActiveSolanaKeypair();
        if (!keypair) throw new Error('Solana wallet tidak tersedia (diimpor via Private Key)');

        if (!this.isSolanaAutoApproveActive()) {
            const approved = await this.requestTxApproval('solana_signTransaction', [txHex], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }

        console.log(`[Session ${this.sessionId}] Handling solana_signTransaction...`);
        const txBuf = Buffer.from(txHex, 'hex');
        let tx;
        let isVersioned = false;
        try {
            tx = VersionedTransaction.deserialize(txBuf);
            isVersioned = true;
        } catch (e) {
            tx = Transaction.from(txBuf);
        }

        if (isVersioned) {
            tx.sign([keypair]);
        } else {
            tx.sign(keypair);
        }

        const signedTxHex = Buffer.from(tx.serialize()).toString('hex');
        console.log(`[Session ${this.sessionId}] solana_signTransaction completed`);
        return { signedTxHex };
    }

    async handleSolanaSignMessage(messageHex, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        const keypair = await this.getActiveSolanaKeypair();
        if (!keypair) throw new Error('Solana wallet tidak tersedia (diimpor via Private Key)');

        if (!this.isSolanaAutoApproveActive()) {
            const approved = await this.requestTxApproval('solana_signMessage', [messageHex], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }

        console.log(`[Session ${this.sessionId}] Handling solana_signMessage...`);
        const msgBuf = Buffer.from(messageHex, 'hex');
        const signature = nacl.sign.detached(msgBuf, keypair.secretKey);
        const signatureHex = Buffer.from(signature).toString('hex');
        console.log(`[Session ${this.sessionId}] solana_signMessage completed`);
        return { signatureHex };
    }

    async getActiveAptosAccount() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            return AptosAccount.fromDerivationPath({
                path: "m/44'/637'/0'/0'/0'",
                mnemonic: walletData.mnemonic,
            });
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveAptosAccount:`, error.message);
            return null;
        }
    }

    async getActiveAptosAccountDetails() {
        try {
            if (!this.wallet) return null;
            const account = await this.getActiveAptosAccount();
            if (!account) return null;
            return {
                address: account.accountAddress.toString(),
                publicKey: account.publicKey.toString()
            };
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveAptosAccountDetails:`, error.message);
            return null;
        }
    }


    async handleAptosSignTransaction(txHex, txType = 'SimpleTransaction', requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        const account = await this.getActiveAptosAccount();
        if (!account) throw new Error('Aptos wallet tidak tersedia (diimpor via Private Key)');

        if (!this.isAptosAutoApproveActive()) {
            const approved = await this.requestTxApproval('aptos_signTransaction', [txHex], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }

        console.log(`[Session ${this.sessionId}] Handling aptos_signTransaction...`);
        const { Deserializer } = require('@aptos-labs/ts-sdk');
        const txBuf = Buffer.from(txHex, 'hex');
        const deserializer = new Deserializer(txBuf);
        
        let deserializedTx;
        if (txType === 'MultiAgentTransaction') {
            const { MultiAgentTransaction } = require('@aptos-labs/ts-sdk');
            deserializedTx = MultiAgentTransaction.deserialize(deserializer);
        } else {
            const { SimpleTransaction } = require('@aptos-labs/ts-sdk');
            deserializedTx = SimpleTransaction.deserialize(deserializer);
        }

        const authenticator = account.signTransactionWithAuthenticator(deserializedTx);
        const authenticatorBytes = authenticator.bcsToBytes();
        const signedTxHex = Buffer.from(authenticatorBytes).toString('hex');
        
        console.log(`[Session ${this.sessionId}] aptos_signTransaction completed`);
        return { signedTxHex };
    }

    async handleAptosSignMessage(messageHex, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        const account = await this.getActiveAptosAccount();
        if (!account) throw new Error('Aptos wallet tidak tersedia (diimpor via Private Key)');

        if (!this.isAptosAutoApproveActive()) {
            const approved = await this.requestTxApproval('aptos_signMessage', [messageHex], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }

        console.log(`[Session ${this.sessionId}] Handling aptos_signMessage...`);
        const msgBuf = Buffer.from(messageHex, 'hex');
        const signature = account.sign(msgBuf);
        const signatureHex = signature.toString(); // returns hex with 0x prefix
        const publicKeyHex = account.publicKey.toString(); // returns hex with 0x prefix

        console.log(`[Session ${this.sessionId}] aptos_signMessage completed`);
        return { signatureHex, publicKeyHex };
    }

    async getActiveTonAccountDetails() {
        try {
            if (!this.wallet) return null;
            const wallets = await this.loadWallets();
            const walletData = wallets[this.wallet.address];
            if (!walletData || !walletData.mnemonic) return null;
            
            const key = await mnemonicToWalletKey(walletData.mnemonic.split(' '));
            const wallet = WalletContractV4.create({
                workchain: 0,
                publicKey: key.publicKey
            });
            const { Address, beginCell, storeStateInit } = require('@ton/ton');
            const rawAddress = wallet.address.toRawString();
            const publicKeyHex = key.publicKey.toString('hex');
            const userFriendlyAddress = wallet.address.toString({ bounceable: false, testOnly: false });
            
            const stateInitCell = beginCell()
                .store(storeStateInit(wallet.init))
                .endCell();
            const stateInitBase64 = stateInitCell.toBoc().toString('base64');

            return {
                address: rawAddress,
                userFriendlyAddress,
                publicKey: publicKeyHex,
                walletStateInit: stateInitBase64
            };
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error getActiveTonAccountDetails:`, error.message);
            return null;
        }
    }

    async handleTonSend(appRequest, requestOrigin = null) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        
        const method = appRequest.method;
        if (method !== 'sendTransaction') {
            throw new Error(`Unsupported TON method: ${method}`);
        }

        const txParamsStr = appRequest.params[0];
        const txParams = JSON.parse(txParamsStr);

        if (!this.isTonAutoApproveActive()) {
            const approved = await this.requestTxApproval('ton_sendTransaction', [txParams], requestOrigin);
            if (!approved) {
                throw new Error('User rejected the transaction');
            }
        }

        console.log(`[Session ${this.sessionId}] Handling TON sendTransaction...`);

        const wallets = await this.loadWallets();
        const walletData = wallets[this.wallet.address];
        if (!walletData || !walletData.mnemonic) {
            throw new Error('Mnemonic wallet tidak tersedia');
        }

        const key = await mnemonicToWalletKey(walletData.mnemonic.split(' '));
        const wallet = WalletContractV4.create({
            workchain: 0,
            publicKey: key.publicKey
        });

        const rpcUrl = this.currentTonRpc || 'https://toncenter.com/api/v2/jsonRPC';
        const { TonClient, Address, Cell, internal } = require('@ton/ton');
        const client = new TonClient({
            endpoint: rpcUrl,
            apiKey: this.config.tonApiKey || undefined
        });

        const contract = client.open(wallet);
        let seqno = 0;
        try {
            seqno = await contract.getSeqno();
        } catch (e) {
            console.log(`[Session ${this.sessionId}] Warning: Failed to fetch seqno from RPC (wallet might be uninitialized):`, e.message);
        }

        const transferMessages = [];
        for (const msg of txParams.messages) {
            const destAddress = Address.parse(msg.address);
            const amountNano = BigInt(msg.amount);
            
            let bodyCell = undefined;
            if (msg.payload) {
                bodyCell = Cell.fromBase64(msg.payload);
            }
            
            let stateInitCell = undefined;
            if (msg.stateInit) {
                stateInitCell = Cell.fromBase64(msg.stateInit);
            }

            transferMessages.push(internal({
                to: destAddress,
                value: amountNano,
                bounce: true,
                body: bodyCell,
                init: stateInitCell ? {
                    code: stateInitCell.beginParse().loadRef(),
                    data: stateInitCell.beginParse().loadRef()
                } : undefined
            }));
        }

        const transfer = wallet.createTransfer({
            seqno,
            secretKey: key.secretKey,
            messages: transferMessages,
            sendMode: 3
        });

        const signedBoc = transfer.toBoc().toString('base64');

        try {
            await client.sendExternalMessage(wallet, transfer);
            console.log(`[Session ${this.sessionId}] TON Transaction broadcasted successfully`);
        } catch (broadcastErr) {
            console.warn(`[Session ${this.sessionId}] Warning: TON broadcast failed/rejected:`, broadcastErr.message);
        }

        return JSON.stringify({ boc: signedBoc });
    }
}

module.exports = CryptoAutoTx;
