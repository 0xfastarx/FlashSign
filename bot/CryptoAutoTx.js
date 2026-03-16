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

        this.dataDir = path.join(__dirname, '../data');
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

        this.masterKey = null;
        this.transactionCounts = new Map();

        this.currentRpc = this.config.DEFAULT_RPC_URL;
        this.currentChainId = this.config.DEFAULT_RPC_CHAIN_ID;
        this.currentRpcName = 'Default RPC (from .env)';

        // Auto-Save RPC (Default: True)
        this.autoSaveRpc = true;

        if (this.rl !== null) {
            this.initTelegramBot();
        }

        this.loadRpcConfig();
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
                const rpcConfig = JSON.parse(fs.readFileSync(this.rpcFile, 'utf8'));
                this.currentRpc = rpcConfig.currentRpc || this.currentRpc;
                this.currentChainId = rpcConfig.currentChainId || this.currentChainId;
                this.currentRpcName = rpcConfig.currentRpcName || this.currentRpcName;
                this.savedRpcs = rpcConfig.savedRpcs || this.getDefaultRpcs();

                if (rpcConfig.autoSaveRpc !== undefined) {
                    this.autoSaveRpc = rpcConfig.autoSaveRpc;
                }

                for (const key in this.savedRpcs) {
                    if (!this.savedRpcs[key].gasConfig) {
                        this.savedRpcs[key].gasConfig = { mode: 'auto', value: 0 };
                    }
                }

                console.log(`[Session ${this.sessionId}] Loaded RPC configuration:`, this.currentRpcName);
                console.log(`[Session ${this.sessionId}] Auto-Save RPC: ${this.autoSaveRpc ? 'ON' : 'OFF'}`);
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
        const defaultFromEnv = {
            name: 'Default RPC (from .env)',
            rpc: this.config.DEFAULT_RPC_URL,
            chainId: this.config.DEFAULT_RPC_CHAIN_ID,
            gasConfig: { mode: 'auto', value: 0 }
        };

        return {
            'default_env': defaultFromEnv,
            'mainnet': {
                name: 'Ethereum Mainnet',
                rpc: 'https://eth.llamarpc.com',
                chainId: 1,
                gasConfig: { mode: 'auto', value: 0 }
            },
            'bsc': {
                name: 'BNB Smart Chain',
                rpc: 'https://bsc-dataseed.binance.org/',
                chainId: 56,
                gasConfig: { mode: 'auto', value: 0 }
            },
            'polygon': {
                name: 'Polygon Mainnet',
                rpc: 'https://polygon-rpc.com',
                chainId: 137,
                gasConfig: { mode: 'auto', value: 0 }
            }
        };
    }

    saveRpcConfig() {
        try {
            const rpcConfig = {
                currentRpc: this.currentRpc,
                currentChainId: this.currentChainId,
                currentRpcName: this.currentRpcName,
                savedRpcs: this.savedRpcs,
                autoSaveRpc: this.autoSaveRpc,
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(this.rpcFile, JSON.stringify(rpcConfig, null, 2));
            console.log(`[Session ${this.sessionId}] RPC configuration saved`);
            return true;
        } catch (error) {
            console.log(`[Session ${this.sessionId}] Error saving RPC config:`, error.message);
            return false;
        }
    }

    setupProvider() {
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
            this.currentRpc = this.config.DEFAULT_RPC_URL;
            this.currentChainId = this.config.DEFAULT_RPC_CHAIN_ID;
            this.currentRpcName = 'Default Fallback';
            this.provider = new ethers.JsonRpcProvider(this.currentRpc);
        }
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
            const transactionCount = await this.provider.getTransactionCount(address);
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
        console.log(`🚀 FA STARX BOT v19.0 (Session: ${this.sessionId})`);
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
                const saved = JSON.parse(fs.readFileSync(this.rpcPortsFile, 'utf8'));
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
            fs.writeFileSync(this.rpcPortsFile, JSON.stringify(this.rpcPortsConfig, null, 2));
        } catch (e) {
            console.warn(`[RPC Ports] Gagal simpan config port: ${e.message}`);
        }
    }

    // --- Server lifecycle ---

    async startRpcServer(port, vpsMode = null) {
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

        const server = new MetaMaskRpcServer(this, portNum, useVpsMode);
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
                    console.log(`⏳ Memulai port ${portStatus.port} dalam mode ${cfg.vpsMode ? 'VPS' : 'Localhost'}...`);
                    const ok = await this.startRpcServer(portStatus.port, cfg.vpsMode);
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
                    console.log(`⏳ Memulai port ${portStatus.port}...`);
                    const ok = await this.startRpcServer(portStatus.port, newVps);
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
                this.bot.sendMessage(this.sessionNotificationChatId, `🔴 [${this.sessionId}] WALLETCONNECT DISCONNECTED`);
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
                    `⏳ [${this.sessionId}] Menunggu ${this.executionDelay} detik sebelum ${actionName}...`);
            }

            await new Promise(resolve => setTimeout(resolve, this.executionDelay * 1000));
            console.log(`[Session ${this.sessionId}] ▶️ RESUMING: Executing ${actionName} now.`);
        }
    }

    async handleSessionProposal(proposal) {
        try {
            const { id, params } = proposal;
            console.log(`[Session ${this.sessionId}] Processing session proposal...`);

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
                );
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

            if (!topic) throw new Error('Topic tidak ditemukan dalam request');

            await this.delayExecution(`Transaction (${method})`);

            let result;
            switch (method) {
                case 'eth_sendTransaction':
                    console.log(`[Session ${this.sessionId}] Transaction params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[0]), null, 2));
                    result = await this.handleSendTransaction(params.request.params[0]);
                    break;

                case 'eth_signTransaction':
                    console.log(`[Session ${this.sessionId}] Sign transaction params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[0]), null, 2));
                    result = await this.handleSignTransaction(params.request.params[0]);
                    break;

                case 'personal_sign':
                    console.log(`[Session ${this.sessionId}] Personal sign params:`, params.request.params);
                    result = await this.handlePersonalSign(params.request.params);
                    break;

                case 'eth_sign':
                    console.log(`[Session ${this.sessionId}] Eth sign params:`, params.request.params);
                    result = await this.handleEthSign(params.request.params);
                    break;

                case 'eth_signTypedData':
                case 'eth_signTypedData_v4':
                    console.log(`[Session ${this.sessionId}] Typed data params:`,
                        JSON.stringify(this.bigIntToString(params.request.params[1]), null, 2));
                    result = await this.handleSignTypedData(params.request.params);
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
                    this.bot.sendMessage(this.sessionNotificationChatId,
                        `✅ [${this.sessionId}] TRANSAKSI DI-APPROVE!\n` +
                        `📊 Total Transaksi: ${txCount}\n\n` +
                        `💳 ${this.wallet.address}\n` +
                        `Method: ${method}\n` +
                        `⛓️ Chain: ${this.currentChainId}\n` +
                        `🌐 RPC: ${this.currentRpcName}\n` +
                        `⏱️ Delay Used: ${this.executionDelay}s\n` +
                        `🕒 ${new Date().toLocaleString()}`
                    );
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
                );
            }
        }
    }

    async handleSendTransaction(txParams) {
        if (!this.wallet) throw new Error('Wallet belum aktif');
        const walletAddress = this.wallet.address;
        const chainId = this.currentChainId;
        if (globalTxQueue.isQueued(walletAddress, chainId)) {
            console.log(`[TxQueue][${this.sessionId}] ⏳ Tx masuk antrian — menunggu tx sebelumnya selesai...`);
            if (this.bot && this.sessionNotificationChatId) {
                this.bot.sendMessage(this.sessionNotificationChatId,
                    `⏳ [${this.sessionId}] TX MASUK ANTRIAN\n\nAda transaksi sebelumnya yang sedang diproses.\nTransaksi ini akan dieksekusi otomatis setelah selesai.\n💳 ${walletAddress}\n⛓️ Chain: ${chainId}`
                );
            }
        }
        return globalTxQueue.enqueue(walletAddress, chainId, this.sessionId, async () => {
            return await this._doSendTransaction(txParams);
        });
    }

    async _doSendTransaction(txParams) {
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

    async handleSignTransaction(txParams) {
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

    async handlePersonalSign(params) {
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
                );
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
                );
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
                        );
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
            const balance = await this.provider.getBalance(this.wallet.address);
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
            );
        }

        this.keepAlive();
    }

    keepAlive() {
        // SIGINT ditangani global
    }

    async cleanup() {
        console.log(`[Session ${this.sessionId}] Cleaning up session...`);

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

    async handleEthSign(params) {
        console.log(`[Session ${this.sessionId}] Handling eth_sign...`);
        // eth_sign: params[0] = address, params[1] = message hex
        const messageHex = params[1];
        const signedMessage = await this.wallet.signMessage(ethers.getBytes(messageHex));
        console.log(`[Session ${this.sessionId}] eth_sign completed`);
        return signedMessage;
    }

    async handleSignTypedData(params) {
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
}

module.exports = CryptoAutoTx;
