'use strict';
const http = require('http');
const { ethers } = require('ethers');

class MetaMaskRpcServer {
    /**
     * Menjalankan HTTP server yang bertindak sebagai custom RPC.
     * Mendukung dua mode:
     *   - Localhost mode: listen di 127.0.0.1 (hanya PC yang sama)
     *   - VPS mode     : listen di 0.0.0.0   (bisa diakses dari luar via IP VPS)
     *
     * DApp / MetaMask cukup arahkan custom network ke:
     *   Localhost : http://127.0.0.1:<port>
     *   VPS       : http://<IP_VPS>:<port>
     */
    constructor(cryptoApp, port = 8545, vpsMode = false, password = null) {
        this.cryptoApp = cryptoApp;
        this.port = port;
        this.vpsMode = vpsMode; // false = localhost, true = VPS (0.0.0.0)
        this.password = password; // password/token keamanan
        this.server = null;
        this.isRunning = false;
        this.requestCount = 0;
        this.interceptedMethods = [
            'eth_sendTransaction',
            'eth_signTransaction',
            'personal_sign',
            'eth_sign',
            'eth_signTypedData',
            'eth_signTypedData_v4',
            'wallet_addEthereumChain',
            'wallet_switchEthereumChain'
        ];
    }

    async start() {
        if (this.isRunning) {
            console.log(`[RPC Inject] Server sudah berjalan di port ${this.port}`);
            return true;
        }

        return new Promise((resolve) => {
            this.server = http.createServer(async (req, res) => {
                // CORS headers — MetaMask & Chrome Extension membutuhkan ini
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, *');
                // [FIX v19.1] Wajib untuk Chrome Extension Manifest V3
                // Tanpa header ini, Chrome blokir request dari extension ke localhost
                res.setHeader('Access-Control-Allow-Private-Network', 'true');
                res.setHeader('Access-Control-Max-Age', '86400');
                res.setHeader('Content-Type', 'application/json');

                if (req.method === 'OPTIONS') {
                    // [FIX v19.1] Chrome Extension kirim preflight OPTIONS dengan
                    // header 'Access-Control-Request-Private-Network: true'
                    // Harus dibalas 204 (bukan 200) + header Allow-Private-Network
                    res.setHeader('Access-Control-Allow-Private-Network', 'true');
                    res.writeHead(204);
                    res.end();
                    return;
                }

                // [v20] Validasi Password RPC jika diset
                if (this.password) {
                    const authHeader = req.headers['authorization'];
                    const expectedAuth = `Bearer ${this.password}`;
                    if (authHeader !== expectedAuth) {
                        console.log(`[RPC Inject] ❌ Unauthorized request to port ${this.port}`);
                        res.writeHead(401);
                        res.end(JSON.stringify({
                            jsonrpc: '2.0',
                            id: null,
                            error: { code: -32001, message: 'Unauthorized: Invalid RPC Password' }
                        }));
                        return;
                    }
                }

                // FIX: Handle GET request — MetaMask kadang kirim GET untuk health check
                if (req.method === 'GET') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok', bot: '0xfastarx RPC Inject' }));
                    return;
                }

                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
                    return;
                }

                // [v19.2] Capture origin dari HTTP request headers untuk DApp identification
                const requestOrigin = req.headers.origin || req.headers.referer || null;

                let body = '';
                req.on('data', chunk => body += chunk.toString());
                req.on('end', async () => {
                    try {
                        const parsed = JSON.parse(body);

                        // FIX BUG 1: Handle batch requests (array of requests)
                        // MetaMask sering mengirim beberapa request sekaligus dalam array
                        if (Array.isArray(parsed)) {
                            const responses = await Promise.all(
                                parsed.map(rpcReq => {
                                    const actualOrigin = rpcReq.origin || requestOrigin;
                                    return this.handleRpcRequest(rpcReq, actualOrigin);
                                })
                            );
                            res.writeHead(200);
                            res.end(JSON.stringify(responses));
                        } else {
                            const actualOrigin = parsed.origin || requestOrigin;
                            const response = await this.handleRpcRequest(parsed, actualOrigin);
                            res.writeHead(200);
                            res.end(JSON.stringify(response));
                        }
                    } catch (error) {
                        console.error(`[RPC Inject] Parse error:`, error.message);
                        res.writeHead(200); // Tetap 200 agar MetaMask tidak retry
                        res.end(JSON.stringify({
                            jsonrpc: '2.0',
                            id: null,
                            error: { code: -32700, message: 'Parse error: ' + error.message }
                        }));
                    }
                });
            });

            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`[RPC Inject] ❌ Port ${this.port} sudah dipakai. Coba port lain.`);
                    resolve(false);
                } else {
                    console.log(`[RPC Inject] ❌ Error server:`, err.message);
                    resolve(false);
                }
            });

            const listenHost = this.vpsMode ? '0.0.0.0' : '127.0.0.1';
            const displayHost = this.vpsMode ? '<IP_VPS>' : '127.0.0.1';
            const modeLabel = this.vpsMode ? '🌐 VPS MODE' : '💻 LOCALHOST MODE';

            this.server.listen(this.port, listenHost, () => {
                this.isRunning = true;
                console.log(`[RPC Inject] ✅ ${modeLabel} — Server berjalan di http://${displayHost}:${this.port}`);
                if (this.vpsMode) {
                    console.log(`[RPC Inject] ⚠️  Pastikan firewall VPS membuka port ${this.port}!`);
                }
                resolve(true);
            });
        });
    }

    async handleRpcRequest(rpcRequest, requestOrigin = null) {
        const { id, method, params } = rpcRequest;
        this.requestCount++;

        // Reset inactivity timer untuk MetaMask RPC Inject DApp
        if (requestOrigin) {
            this.cryptoApp.updateDappActivity(requestOrigin);
        }

        // FIX: Suppress log noise untuk eth_call revert biasa (interface check dari DApp)
        // Hanya log method yang benar-benar unexpected
        const suppressLogMethods = ['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_getCode'];
        if (!suppressLogMethods.includes(method)) {
            console.log(`[RPC Inject] 📥 Request #${this.requestCount}: ${method}`);
        } else {
            // Log singkat tanpa spam
            process.stdout.write(`[RPC Inject] #${this.requestCount}:${method} `);
        }

        // FIX: eth_chainId WAJIB dikembalikan dalam format hex string
        // MetaMask strict soal ini — kalau bukan hex, dia stop dan tidak lanjut request berikutnya
        if (method === 'eth_chainId') {
            const chainId = this.cryptoApp.currentChainId;
            const hexChainId = '0x' + chainId.toString(16);
            console.log(`[RPC Inject] ⛓️ eth_chainId → ${hexChainId} (${chainId})`);
            return { jsonrpc: '2.0', id, result: hexChainId };
        }

        // FIX: net_version harus string desimal bukan hex
        if (method === 'net_version') {
            const chainId = this.cryptoApp.currentChainId;
            console.log(`[RPC Inject] 🌐 net_version → ${chainId.toString()}`);
            return { jsonrpc: '2.0', id, result: chainId.toString() };
        }

        // FIX BUG 2: Handle eth_accounts & eth_requestAccounts
        // Ini WAJIB direspon dengan address wallet — tanpa ini MetaMask tidak mau
        // kirim eth_sendTransaction karena tidak tahu siapa yang sign
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            const address = this.cryptoApp.wallet?.address;
            if (!address) {
                console.log(`[RPC Inject] ⚠️ ${method} dipanggil tapi wallet belum aktif`);
                return { jsonrpc: '2.0', id, result: [] };
            }

            const dappOrigin = requestOrigin || 'Unknown Origin';
            const isConnected = this.cryptoApp.isDappConnected(dappOrigin);

            // Jika eth_accounts, kembalikan address hanya jika DApp sudah terkoneksi
            if (method === 'eth_accounts') {
                if (!isConnected) {
                    return { jsonrpc: '2.0', id, result: [] };
                }
                console.log(`[RPC Inject] 👛 ${method} → ${address}`);
                return { jsonrpc: '2.0', id, result: [address.toLowerCase()] };
            }

            // [v19.2] DApp Connection Approval — hanya untuk eth_requestAccounts (first connect)
            if (method === 'eth_requestAccounts') {
                const dappDetails = {
                    dappName: this._extractDappName(dappOrigin),
                    dappUrl: dappOrigin,
                    chainId: this.cryptoApp.currentChainId,
                    walletAddress: address,
                    via: `RPC Inject (Port ${this.port})`
                };

                if (this.cryptoApp.dappApprovalRequired && !isConnected) {
                    console.log(`[RPC Inject] 🔐 DApp Approval ON — menunggu persetujuan user untuk: ${dappOrigin}`);
                    try {
                        await this.cryptoApp.requestDappApproval(dappDetails);
                        console.log(`[RPC Inject] ✅ DApp disetujui: ${dappOrigin}`);
                        this.cryptoApp.addConnectedDapp(dappDetails);
                    } catch (approvalError) {
                        console.log(`[RPC Inject] ❌ DApp ditolak: ${approvalError.message}`);
                        return {
                            jsonrpc: '2.0', id,
                            error: { code: 4001, message: 'User rejected the connection request' }
                        };
                    }
                } else if (!isConnected) {
                    // Mode OFF dan belum terhubung: simpan dan kirim notifikasi info-only
                    this.cryptoApp.addConnectedDapp(dappDetails);
                    this.cryptoApp.sendDappConnectNotification(dappDetails);
                }
            }

            console.log(`[RPC Inject] 👛 ${method} → ${address}`);
            return { jsonrpc: '2.0', id, result: [address.toLowerCase()] };
        }

        // FIX BUG 3: eth_estimateGas harus diforward ke provider asli
        // Tambahan: kalau estimasi gagal (revert), kembalikan error -32000 bukan -32603
        // supaya DApp tahu transaksi akan revert dan bisa tampilkan warning, bukan stuck.
        if (method === 'eth_estimateGas') {
            try {
                const result = await this.cryptoApp.provider.send('eth_estimateGas', params || []);
                return { jsonrpc: '2.0', id, result };
            } catch (error) {
                console.log(`[RPC Inject] ⚠️ eth_estimateGas failed: ${error.message}`);
                // Kembalikan -32000 (execution reverted) bukan -32603 (internal error)
                // DApp akan tampilkan warning "may fail" tapi tetap bisa lanjut kirim tx
                return {
                    jsonrpc: '2.0', id,
                    error: { code: -32000, message: error.message || 'execution reverted' }
                };
            }
        }

        // FIX: eth_maxPriorityFeePerGas — DApp modern (EIP-1559) panggil ini sebelum kirim tx
        // Kalau tidak ada handler dan return error, DApp terus polling dan tidak pernah kirim tx
        if (method === 'eth_maxPriorityFeePerGas') {
            try {
                const feeData = await this.cryptoApp.provider.getFeeData();
                const priority = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 1000000000n;
                const hexPriority = '0x' + priority.toString(16);
                console.log(`[RPC Inject] 💸 eth_maxPriorityFeePerGas → ${hexPriority}`);
                return { jsonrpc: '2.0', id, result: hexPriority };
            } catch (e) {
                return { jsonrpc: '2.0', id, result: '0x3B9ACA00' }; // fallback 1 Gwei
            }
        }

        // FIX: eth_feeHistory — beberapa DApp (Uniswap v3, dll) panggil ini untuk hitung base fee
        // Kalau tidak dihandle, DApp bisa stuck di loop gas calculation
        if (method === 'eth_feeHistory') {
            try {
                const result = await this.cryptoApp.provider.send('eth_feeHistory', params || []);
                return { jsonrpc: '2.0', id, result };
            } catch (e) {
                // Fallback minimal agar DApp tidak stuck
                return {
                    jsonrpc: '2.0', id,
                    result: { oldestBlock: '0x0', baseFeePerGas: ['0x0', '0x0'], gasUsedRatio: [0], reward: [[]] }
                };
            }
        }

        // FIX: eth_getTransactionCount (nonce) harus dikembalikan dari wallet aktif
        // Beberapa DApp cek nonce sebelum kirim eth_sendTransaction.
        // Kalau tidak direspon dengan benar, DApp anggap wallet tidak siap dan tidak kirim tx.
        if (method === 'eth_getTransactionCount') {
            try {
                const address = this.cryptoApp.wallet?.address;
                if (address && params && params[0]?.toLowerCase() === address.toLowerCase()) {
                    const nonce = await this.cryptoApp.provider.getTransactionCount(address, params[1] || 'latest');
                    const hexNonce = '0x' + nonce.toString(16);
                    console.log(`[RPC Inject] 🔢 eth_getTransactionCount → ${hexNonce}`);
                    return { jsonrpc: '2.0', id, result: hexNonce };
                }
            } catch (e) {}
            return await this.forwardToProvider(id, method, params);
        }

        // ── dapp_forceDisconnect — dikirim dari extension saat DApp disconnect ──────
        // Extension mengirim ini ke bot agar bot bisa:
        //   1. Hapus DApp dari connectedDapps[]
        //   2. Kirim notifikasi Telegram ke admin
        if (method === 'dapp_forceDisconnect') {
            const disconnectInfo = params?.[0] || {};
            const dappOrigin = disconnectInfo.origin || requestOrigin || 'Unknown';
            const reason = disconnectInfo.reason || 'unknown';

            console.log(`[RPC Inject] 🔌 DApp disconnect diterima: ${dappOrigin} (reason: ${reason})`);

            // Cari DApp di connectedDapps berdasarkan URL/origin
            if (this.cryptoApp.connectedDapps) {
                const dapp = this.cryptoApp.connectedDapps.find(
                    d => d.url === dappOrigin || dappOrigin.includes(d.url) || d.url.includes(dappOrigin)
                );

                if (dapp) {
                    // Hapus dari list
                    this.cryptoApp.removeConnectedDapp(dapp.id);
                    this.cryptoApp.saveRpcConfig();

                    console.log(`[RPC Inject] ✅ DApp dihapus dari connected list: ${dapp.name || dappOrigin}`);

                    // Kirim notifikasi Telegram ke admin
                    if (this.cryptoApp.bot && this.cryptoApp.sessionNotificationChatId) {
                        const reasonLabel = {
                            'wallet_revokePermissions': 'Revoke Permissions (EIP-7715)',
                            'wallet_disconnect': 'Wallet Disconnect',
                            'accountsChanged_empty': 'Akun dikosongkan oleh DApp',
                            'manual_from_popup': 'Disconnect manual dari popup extension',
                            'unknown': 'Tidak diketahui'
                        }[reason] || reason;

                        this.cryptoApp.bot.sendMessage(
                            this.cryptoApp.sessionNotificationChatId,
                            `🔌 *DAPP DISCONNECT OTOMATIS*\n\n` +
                            `📛 DApp   : *${dapp.name || 'Unknown'}*\n` +
                            `🌐 URL    : \`${dappOrigin}\`\n` +
                            `📋 Alasan : ${reasonLabel}\n` +
                            `🕒 Waktu  : ${new Date().toLocaleString('id-ID')}\n\n` +
                            `✅ DApp telah diputus dari bot secara otomatis.`,
                            { parse_mode: 'Markdown' }
                        ).catch(e => console.warn('[RPC Inject] Telegram notify error:', e.message));
                    }

                    return { jsonrpc: '2.0', id, result: { ok: true, dapp: dapp.name } };
                } else {
                    console.log(`[RPC Inject] ⚠️ DApp tidak ditemukan di list: ${dappOrigin}`);
                    return { jsonrpc: '2.0', id, result: { ok: false, reason: 'DApp tidak ada di connected list' } };
                }
            }

            return { jsonrpc: '2.0', id, result: { ok: false, reason: 'No connected dapps' } };
        }

        // Jika method perlu intercept (transaksi/signing)
        if (this.interceptedMethods.includes(method)) {
            return await this.interceptRequest(id, method, params);
        }

        // Method lain langsung diteruskan ke RPC provider asli
        return await this.forwardToProvider(id, method, params);
    }

    async interceptRequest(id, method, params) {
        if (!this.cryptoApp.wallet) {
            return {
                jsonrpc: '2.0', id,
                error: { code: 4100, message: 'Wallet belum aktif di bot' }
            };
        }

        console.log(`[RPC Inject] 🔔 INTERCEPT: ${method}`);

        // Terapkan delay yang diset user (sama seperti WalletConnect)
        await this.cryptoApp.delayExecution(`RPC Inject (${method})`);

        try {
            let result;

            // Buat fake request object sesuai format handleTransactionRequest
            const fakeRequest = {
                id,
                topic: `rpc_inject_${id}`,
                params: {
                    request: { method, params }
                }
            };

            switch (method) {
                case 'eth_sendTransaction':
                    result = await this.cryptoApp.handleSendTransaction(params[0]);
                    break;
                case 'eth_signTransaction':
                    result = await this.cryptoApp.handleSignTransaction(params[0]);
                    break;
                case 'personal_sign':
                    result = await this.cryptoApp.handlePersonalSign(params);
                    break;
                case 'eth_sign':
                    result = await this.cryptoApp.handleEthSign(params);
                    break;
                case 'eth_signTypedData':
                case 'eth_signTypedData_v4':
                    result = await this.cryptoApp.handleSignTypedData(params);
                    break;
                case 'wallet_addEthereumChain':
                    result = await this.cryptoApp.handleAddEthereumChain(params);
                    break;
                case 'wallet_switchEthereumChain':
                    result = await this.cryptoApp.handleSwitchEthereumChain(params);
                    break;
                default:
                    return await this.forwardToProvider(id, method, params);
            }

            // Kirim notifikasi Telegram
            if (method.startsWith('eth_') || method === 'personal_sign') {
                const txCount = await this.cryptoApp.getTransactionCount(this.cryptoApp.wallet.address);
                console.log(`[RPC Inject] Total transaksi: ${txCount}`);

                if (this.cryptoApp.bot && this.cryptoApp.sessionNotificationChatId) {
                    let txHashText = '';
                    if (method === 'eth_sendTransaction' && result) {
                        const explorer = this.cryptoApp.getActiveRpcExplorer();
                        if (explorer) {
                            txHashText = `🔍 Tx Hash: [${result}](${explorer}/tx/${result})\n`;
                        } else {
                            txHashText = `🔍 Tx Hash: \`${result}\`\n`;
                        }
                    }

                    this.cryptoApp.bot.sendMessage(
                        this.cryptoApp.sessionNotificationChatId,
                        `✅ *[RPC Inject] TRANSAKSI DI-APPROVE!*\n` +
                        `📊 Total Transaksi: ${txCount}\n\n` +
                        `💳 \`${this.cryptoApp.wallet.address}\`\n` +
                        `Method: \`${method}\`\n` +
                        `⛓️ Chain: *${this.cryptoApp.currentChainId}*\n` +
                        `🌐 RPC: *${this.cryptoApp.currentRpcName}*\n` +
                        txHashText +
                        `⏱️ Delay Used: ${this.cryptoApp.executionDelay}s\n` +
                        `🕒 ${new Date().toLocaleString()}`,
                        { parse_mode: 'Markdown' }
                    ).catch(err => console.warn(`[RPC Inject] Telegram notify error: ${err.message}`));
                }
            }

            return { jsonrpc: '2.0', id, result: result ?? null };

        } catch (error) {
            console.log(`[RPC Inject] ❌ Error intercept ${method}:`, error.message);

            if (this.cryptoApp.bot && this.cryptoApp.sessionNotificationChatId) {
                this.cryptoApp.bot.sendMessage(
                    this.cryptoApp.sessionNotificationChatId,
                    `❌ [RPC Inject] TRANSAKSI GAGAL!\n\n` +
                    `💳 ${this.cryptoApp.wallet.address}\n` +
                    `Method: ${method}\n` +
                    `Error: ${error.message}\n` +
                    `⛓️ Chain: ${this.cryptoApp.currentChainId}\n` +
                    `🌐 RPC: ${this.cryptoApp.currentRpcName}\n` +
                    `🕒 ${new Date().toLocaleString()}`
                ).catch(err => console.warn(`[RPC Inject] Telegram notify error: ${err.message}`));
            }

            return {
                jsonrpc: '2.0', id,
                error: { code: -32000, message: error.message }
            };
        }
    }

    async forwardToProvider(id, method, params) {
        try {
            const result = await this.cryptoApp.provider.send(method, params || []);
            return { jsonrpc: '2.0', id, result };
        } catch (error) {
            // FIX: eth_call revert harus dikembalikan sebagai execution revert (code -32000)
            // bukan internal error (-32603). DApp seperti OpenSea/Uniswap memperlakukan
            // -32603 sebagai "koneksi bermasalah" dan terus retry, menyebabkan stuck.
            // Dengan -32000 + data revert, DApp tahu contract memang tidak support interface
            // tersebut dan langsung lanjut ke request berikutnya (eth_sendTransaction).
            if (method === 'eth_call') {
                const revertData = error.data ?? error.transaction?.data ?? '0x';
                console.log(`[RPC Inject] ↩️ eth_call revert (normal) → kembalikan sebagai execution error`);
                return {
                    jsonrpc: '2.0', id,
                    error: { code: -32000, message: 'execution reverted', data: revertData }
                };
            }
            console.log(`[RPC Inject] ⚠️ Forward error (${method}):`, error.message);
            return {
                jsonrpc: '2.0', id,
                error: { code: -32603, message: error.message }
            };
        }
    }

    stop() {
        if (this.server && this.isRunning) {
            this.server.close();
            this.isRunning = false;
            console.log(`[RPC Inject] 🛑 Server port ${this.port} dihentikan`);
        }
    }

    getConnectionInfo() {
        const host = this.vpsMode ? '<IP_VPS>' : '127.0.0.1';
        return {
            rpcUrl: `http://${host}:${this.port}`,
            rpcUrlLocal: `http://127.0.0.1:${this.port}`,
            chainId: this.cryptoApp.currentChainId,
            chainIdHex: `0x${this.cryptoApp.currentChainId.toString(16)}`,
            networkName: this.cryptoApp.currentRpcName,
            port: this.port,
            vpsMode: this.vpsMode,
            modeLabel: this.vpsMode ? '🌐 VPS' : '💻 Localhost',
            password: this.password
        };
    }

    /**
     * Helper: Extract nama DApp dari origin URL.
     * Contoh: 'https://app.uniswap.org' -> 'app.uniswap.org'
     */
    _extractDappName(origin) {
        if (!origin || origin === 'Unknown Origin') return 'Unknown DApp';
        try {
            const url = new URL(origin);
            return url.hostname || origin;
        } catch {
            return origin;
        }
    }
}

module.exports = MetaMaskRpcServer;
