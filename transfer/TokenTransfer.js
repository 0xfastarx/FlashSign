'use strict';
const { ethers } = require('ethers');
const ModernUI = require('../core/ModernUI');
const { SimpleGasOptimizer } = require('../utils/gasOptimizer');
const { GAS_CONFIG, ERC20_ABI } = require('../utils/constants');
const { sleep } = require('../utils/validators');
const ui = new ModernUI();

// ===== TOKEN TRANSFER CLASS =====
class TokenTransfer {
    constructor(providerUrl, privateKey, chainId, networkName, telegramNotifier = null) {
        this.provider = new ethers.JsonRpcProvider(providerUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.networkName = networkName;
        this.telegramNotifier = telegramNotifier;
        this.gasOptimizer = new SimpleGasOptimizer(this.provider, chainId);
        this.isRunning = true;
        this.lastBalance = 0;
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
    }

    async getTokenInfo(tokenAddress) {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const [name, symbol, decimals] = await Promise.all([
            tokenContract.name(), tokenContract.symbol(), tokenContract.decimals()
        ]);
        return { name, symbol, decimals: parseInt(decimals), contract: tokenContract };
    }

    async getTokenBalance(tokenAddress) {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const balance = await tokenContract.balanceOf(this.wallet.address);
        const tokenInfo = await this.getTokenInfo(tokenAddress);
        return {
            rawBalance: balance,
            formattedBalance: parseFloat(ethers.formatUnits(balance, tokenInfo.decimals)),
            symbol: tokenInfo.symbol
        };
    }

    async sendToken(tokenAddress, toAddress) {
        try {
            const tokenBalance = await this.getTokenBalance(tokenAddress);
            if (tokenBalance.formattedBalance <= 0) {
                return null;
            }

            const tokenInfo = await this.getTokenInfo(tokenAddress);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
            
            const gasCost = await this.gasOptimizer.calculateTransactionCost(GAS_CONFIG.GAS_LIMIT);
            
            ui.showTransactionSummary(tokenInfo, tokenBalance.formattedBalance, gasCost, null, this.networkName);

            const currentNonce = await this.gasOptimizer.getCurrentNonce(this.wallet.address);
            
            ui.startLoading('📤 Mengirim transaksi token...');
            const gasPrice = await this.gasOptimizer.getOptimalGasPrice();

            const tx = await tokenContract.transfer(toAddress, tokenBalance.rawBalance, {
                gasPrice,
                gasLimit: GAS_CONFIG.GAS_LIMIT,
                nonce: currentNonce
            });

            this.gasOptimizer.updateNonce(this.wallet.address);

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    this.telegramNotifier.formatTransferAlert(
                        tokenInfo,
                        tokenBalance.formattedBalance,
                        this.networkName,
                        tx.hash
                    )
                );
            }

            ui.stopLoading();
            ui.startLoading('⏳ Menunggu konfirmasi transaksi...');
            const receipt = await tx.wait();

            ui.stopLoading();
            ui.showNotification('success', `Berhasil kirim ${tokenBalance.formattedBalance} ${tokenInfo.symbol}`);
            this.consecutiveErrors = 0;

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    this.telegramNotifier.formatForwardSuccess(
                        tokenInfo,
                        tokenBalance.formattedBalance,
                        receipt.hash,
                        this.networkName
                    )
                );
            }

            return { hash: receipt.hash, amount: tokenBalance.formattedBalance, symbol: tokenInfo.symbol };
            
        } catch (error) {
            ui.stopLoading();
            
            const errorMsg = error.message || '';
            const isInsufficientFunds = errorMsg.toLowerCase().includes('insufficient funds') || 
                                        errorMsg.toLowerCase().includes('intrinsic transaction cost') ||
                                        error.code === 'INSUFFICIENT_FUNDS';

            if (isInsufficientFunds) {
                ui.showNotification('warning', 'Saldo ETH tidak cukup untuk membayar gas fee transfer token. Menunggu refill...');
            } else if (errorMsg.includes('nonce') || errorMsg.includes('NONCE_EXPIRED')) {
                ui.showNotification('warning', 'Nonce error detected. Clearing cache...');
                this.gasOptimizer.clearNonceCache(this.wallet.address);
                await sleep(2000);
            } else {
                ui.showNotification('error', `Transfer failed: ${error.message}`);
            }
            
            return null;
        }
    }

    async checkAndForward(tokenAddress, toAddress) {
        try {
            const tokenBalance = await this.getTokenBalance(tokenAddress);
            
            if (tokenBalance.formattedBalance <= 0) {
                ui.startLoading(`Monitoring ${tokenBalance.symbol} - Balance: 0`);
                this.lastBalance = 0;
                this.consecutiveErrors = 0;
                return;
            }

            // Cek saldo native ETH untuk gas fee sebelum kirim token
            const ethBalance = await this.provider.getBalance(this.wallet.address);
            const gasCost = await this.gasOptimizer.calculateTransactionCost(GAS_CONFIG.GAS_LIMIT);

            if (ethBalance < gasCost.gasCostWei) {
                const ethBalFormatted = parseFloat(ethers.formatEther(ethBalance));
                ui.startLoading(`Monitoring ${tokenBalance.symbol} - Waiting for ETH gas fee (Has: ${ethBalFormatted.toFixed(6)} ETH, Needs: ${gasCost.gasCostFormatted} ETH)`);
                this.lastBalance = 0;
                this.consecutiveErrors = 0;
                return;
            }

            // Kirim jika: sebelumnya kosong ATAU ada saldo baru masuk (refill)
            if (tokenBalance.formattedBalance > 0 && 
                (this.lastBalance === 0 || tokenBalance.formattedBalance > this.lastBalance)) {
                const result = await this.sendToken(tokenAddress, toAddress);
                if (result) {
                    this.lastBalance = tokenBalance.formattedBalance;
                } else {
                    // Reset agar dicoba kembali
                    this.lastBalance = 0;
                }
            } else {
                this.lastBalance = tokenBalance.formattedBalance;
            }
            
            this.consecutiveErrors = 0;
            
        } catch (error) {
            ui.showNotification('warning', `Monitoring tokens error: ${error.message}`);
            ui.startLoading('Monitoring tokens - Checking balance...');
        }
    }

    startAutoForward(tokenAddress, toAddress, accountName = null) {
        ui.showNotification('info', `Started token monitoring on ${this.networkName}`);
        
        if (this.telegramNotifier) {
            this.telegramNotifier.sendNotification(
                this.telegramNotifier.formatBotStarted(
                    'TOKEN AUTO-FORWARD',
                    this.networkName,
                    this.wallet.address,
                    toAddress,
                    tokenAddress,
                    accountName
                )
            );
        }

        this.checkAndForward(tokenAddress, toAddress);
        
        this.intervalId = setInterval(() => {
            if (this.isRunning) this.checkAndForward(tokenAddress, toAddress);
        }, GAS_CONFIG.CHECK_INTERVAL_MS);
    }

    stop() {
        this.isRunning = false;
        if (this.intervalId) clearInterval(this.intervalId);
        ui.stopLoading();
        ui.showNotification('info', 'Token monitoring stopped');
    }
}

module.exports = TokenTransfer;
