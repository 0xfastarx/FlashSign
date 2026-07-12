'use strict';
const { ethers } = require('ethers');
const ModernUI = require('../core/ModernUI');
const { SimpleGasOptimizer } = require('../utils/gasOptimizer');
const { GAS_CONFIG } = require('../utils/constants');
const { sleep } = require('../utils/validators');
const ui = new ModernUI();

// ===== ETH TRANSFER CLASS
// ===== ETH TRANSFER CLASS =====
class EthTransfer {
    constructor(providerUrl, privateKey, chainId, networkName, telegramNotifier = null) {
        this.provider = new ethers.JsonRpcProvider(providerUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.networkName = networkName;
        this.telegramNotifier = telegramNotifier;
        this.gasOptimizer = new SimpleGasOptimizer(this.provider, chainId);
        this.isRunning = true;
        this.lastBalance = 0n; // BigInt untuk konsistensi
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
    }

    async getEthBalance() {
        const balance = await this.provider.getBalance(this.wallet.address);
        return parseFloat(ethers.formatEther(balance));
    }

    async sendEth(toAddress) {
        try {
            // Gunakan BigInt untuk hindari floating point error
            const rawBalance = await this.provider.getBalance(this.wallet.address);
            const minBalanceWei = ethers.parseEther(GAS_CONFIG.MIN_ETH_BALANCE.toString());

            if (rawBalance <= minBalanceWei) {
                return null;
            }

            // Hitung gas dulu, lalu kurangi dari saldo
            const gasPrice = await this.gasOptimizer.getOptimalGasPrice();
            const gasLimitBig = BigInt(GAS_CONFIG.GAS_LIMIT);
            const gasCostWei = gasPrice * gasLimitBig;

            // amountToSend = balance - minBalance - gasCost (semua BigInt)
            const amountToSendWei = rawBalance - minBalanceWei - gasCostWei;

            if (amountToSendWei <= 0n) {
                ui.showNotification('warning', 'Balance terlalu kecil setelah dikurangi gas fee');
                return null;
            }

            const amountToSendEth = parseFloat(ethers.formatEther(amountToSendWei));
            const gasCost = await this.gasOptimizer.calculateTransactionCost(GAS_CONFIG.GAS_LIMIT);

            ui.showTransactionSummary({ name: 'Ethereum', symbol: 'ETH' }, amountToSendEth, gasCost, null, this.networkName);

            const currentNonce = await this.gasOptimizer.getCurrentNonce(this.wallet.address);

            ui.startLoading('Mengirim transaksi ETH...');

            const tx = await this.wallet.sendTransaction({
                to: toAddress,
                value: amountToSendWei,
                gasPrice: gasPrice,
                gasLimit: gasLimitBig,
                nonce: currentNonce
            });

            this.gasOptimizer.updateNonce(this.wallet.address);

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    `🟢 ETH TRANSFER TERDETEKSI\n\n` +
                    `💰 Amount: ${amountToSendEth.toFixed(8)} ETH\n` +
                    `🌐 Network: ${this.networkName}\n` +
                    `📄 TX Hash: ${tx.hash.slice(0, 10)}...${tx.hash.slice(-8)}\n` +
                    `⏰ Time: ${new Date().toLocaleString()}`
                );
            }

            ui.startLoading('⏳ Menunggu konfirmasi transaksi...');
            const receipt = await tx.wait();

            ui.stopLoading();
            ui.showNotification('success', `Berhasil kirim ${amountToSendEth.toFixed(8)} ETH`);
            this.consecutiveErrors = 0;

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    `🎉 ETH TRANSFER BERHASIL\n\n` +
                    `✅ Status: Confirmed\n` +
                    `💰 Amount: ${amountToSendEth.toFixed(8)} ETH\n` +
                    `🌐 Network: ${this.networkName}\n` +
                    `📄 TX Hash: ${receipt.hash.slice(0, 10)}...${receipt.hash.slice(-8)}\n` +
                    `⏰ Completed: ${new Date().toLocaleString()}`
                );
            }

            return { hash: receipt.hash, amount: amountToSendEth, symbol: 'ETH' };
            
        } catch (error) {
            ui.stopLoading();
            
            const errorMsg = error.message || '';
            const isInsufficientFunds = errorMsg.toLowerCase().includes('insufficient funds') || 
                                        errorMsg.toLowerCase().includes('intrinsic transaction cost') ||
                                        error.code === 'INSUFFICIENT_FUNDS';

            if (isInsufficientFunds) {
                ui.showNotification('warning', 'Saldo tidak cukup untuk membayar gas fee. Menunggu refill...');
            } else if (errorMsg.includes('nonce') || errorMsg.includes('NONCE_EXPIRED')) {
                ui.showNotification('warning', 'Nonce error detected. Clearing cache...');
                this.gasOptimizer.clearNonceCache(this.wallet.address);
                await sleep(2000);
            } else {
                ui.showNotification('error', `ETH transfer failed: ${error.message}`);
            }
            
            return null;
        }
    }

    async checkAndForward(toAddress) {
        try {
            const rawBalance = await this.provider.getBalance(this.wallet.address);
            const minBalanceWei = ethers.parseEther(GAS_CONFIG.MIN_ETH_BALANCE.toString());
            const ethBalance = parseFloat(ethers.formatEther(rawBalance));
            
            const gasCost = await this.gasOptimizer.calculateTransactionCost(GAS_CONFIG.GAS_LIMIT);
            const requiredMinWei = minBalanceWei + gasCost.gasCostWei;
            
            if (rawBalance <= requiredMinWei) {
                const requiredMinEth = parseFloat(ethers.formatEther(requiredMinWei));
                ui.startLoading(`Monitoring ETH - Balance: ${ethBalance.toFixed(8)} ETH (Needs: > ${requiredMinEth.toFixed(6)} ETH)`);
                this.lastBalance = rawBalance;
                this.consecutiveErrors = 0;
                return;
            }

            // Kirim jika: lastBalance kosong/kecil ATAU ada saldo baru masuk (refill)
            const lastBalWei = this.lastBalance || 0n;
            if (rawBalance > requiredMinWei && (lastBalWei <= requiredMinWei || rawBalance > lastBalWei)) {
                const result = await this.sendEth(toAddress);
                if (result) {
                    this.lastBalance = rawBalance;
                } else {
                    // Reset agar dicoba kembali
                    this.lastBalance = 0n;
                }
            } else {
                this.lastBalance = rawBalance;
            }
            
            this.consecutiveErrors = 0;
            
        } catch (error) {
            ui.showNotification('warning', `Monitoring ETH error: ${error.message}`);
            ui.startLoading('Monitoring ETH - Checking balance...');
        }
    }

    startAutoForward(toAddress, accountName = null) {
        ui.showNotification('info', `Started ETH monitoring on ${this.networkName}`);
        
        if (this.telegramNotifier) {
            this.telegramNotifier.sendNotification(
                this.telegramNotifier.formatBotStarted(
                    'ETH AUTO-FORWARD',
                    this.networkName,
                    this.wallet.address,
                    toAddress,
                    null,
                    accountName
                )
            );
        }

        this.checkAndForward(toAddress);
        
        this.intervalId = setInterval(() => {
            if (this.isRunning) this.checkAndForward(toAddress);
        }, GAS_CONFIG.CHECK_INTERVAL_MS);
    }

    stop() {
        this.isRunning = false;
        if (this.intervalId) clearInterval(this.intervalId);
        ui.stopLoading();
        ui.showNotification('info', 'ETH monitoring stopped');
    }
}

module.exports = EthTransfer;
