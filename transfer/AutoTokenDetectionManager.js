'use strict';
const { ethers } = require('ethers');
const ModernUI = require('../core/ModernUI');
const { AdvancedTokenDetector, SimpleGasOptimizer } = require('../utils/gasOptimizer');
const { GAS_CONFIG, ERC20_ABI } = require('../utils/constants');
const { sleep } = require('../utils/validators');
const ui = new ModernUI();

// ===== AUTO TOKEN DETECTION
// ===== AUTO TOKEN DETECTION MANAGER =====
class AutoTokenDetectionManager {
    constructor(providerUrl, privateKey, chainId, networkName, telegramNotifier = null) {
        this.provider = new ethers.JsonRpcProvider(providerUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.networkName = networkName;
        this.telegramNotifier = telegramNotifier;
        this.gasOptimizer = new SimpleGasOptimizer(this.provider, chainId);
        this.tokenDetector = new AdvancedTokenDetector(this.provider, this.wallet.address);
        this.isRunning = true;
        this.scanInterval = null;
    }

    async startAutoDetection(toAddress, accountName = null) {
        ui.showNotification('info', `🚀 Starting Auto Token Detection on ${this.networkName}`);
        
        if (this.telegramNotifier) {
            await this.telegramNotifier.sendNotification(
                this.telegramNotifier.formatBotStarted(
                    'AUTO TOKEN DETECTION',
                    this.networkName,
                    this.wallet.address,
                    toAddress,
                    null,
                    accountName
                )
            );
        }

        // Initial comprehensive scan
        ui.showNotification('info', '🔍 Performing initial token scan...');
        const initialTokens = await this.tokenDetector.comprehensiveScan(this.networkName);
        
        if (initialTokens.length > 0) {
            ui.showTokenScanResults(initialTokens);
            ui.showNotification('success', `🎯 Found ${initialTokens.length} token(s) with balance - Starting transfers...`);
            
            // Transfer all found tokens
            for (const token of initialTokens) {
                await this.transferToken(token, toAddress);
                await sleep(5000); // Delay 5 detik antara transfer
            }
        } else {
            ui.showNotification('info', 'No tokens with balance found in initial scan');
        }

        ui.showNotification('success', '🔄 Starting continuous monitoring for new tokens...');

        // Start continuous monitoring
        this.scanInterval = this.tokenDetector.startContinuousScan(
            this.networkName,
            async (newToken) => {
                ui.showNotification('success', `🎯 New token detected: ${newToken.symbol} - ${newToken.balance}`);
                
                if (this.telegramNotifier) {
                    await this.telegramNotifier.sendNotification(
                        this.telegramNotifier.formatTokenDetected(newToken)
                    );
                }
                
                await this.transferToken(newToken, toAddress);
            },
            30000 // Scan every 30 seconds
        );

        ui.createBox('🎯 AUTO TOKEN DETECTION ACTIVE', [
            `🌐 Network: ${this.networkName}`,
            `📤 From: ${ui.maskAddress(this.wallet.address)}`,
            `📥 To: ${ui.maskAddress(toAddress)}`,
            `🪙 Tokens: Auto-Detect All`,
            `🏷️  Account: ${accountName || 'Unnamed'}`,
            `⏰ Scan Interval: 30 seconds`,
            `🔍 Monitoring: USDC, USDT, WETH, DAI, WBTC, etc`,
            `📊 Initial Scan: ${initialTokens.length} tokens found`,
            `⏸️  Press Ctrl+C to stop`
        ], 'success');
    }

    async transferToken(token, toAddress) {
        try {
            ui.startLoading(`🔄 Transferring ${token.balance} ${token.symbol}...`);
            
            const tokenContract = new ethers.Contract(token.address, ERC20_ABI, this.wallet);
            
            // Get current balance to ensure we have the latest
            const currentBalance = await tokenContract.balanceOf(this.wallet.address);
            const currentBalanceFormatted = parseFloat(ethers.formatUnits(currentBalance, token.decimals));
            
            if (currentBalanceFormatted <= 0) {
                ui.stopLoading();
                ui.showNotification('warning', `No balance for ${token.symbol}`);
                return;
            }

            const gasCost = await this.gasOptimizer.calculateTransactionCost(GAS_CONFIG.GAS_LIMIT);
            
            ui.showTransactionSummary(token, currentBalanceFormatted, gasCost, null, this.networkName);

            const currentNonce = await this.gasOptimizer.getCurrentNonce(this.wallet.address);
            const gasPrice = await this.gasOptimizer.getOptimalGasPrice();

            ui.startLoading('Sending transaction...');
            const tx = await tokenContract.transfer(toAddress, currentBalance, { 
                gasPrice: gasPrice,
                gasLimit: GAS_CONFIG.GAS_LIMIT,
                nonce: currentNonce
            });

            this.gasOptimizer.updateNonce(this.wallet.address);

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    this.telegramNotifier.formatTransferAlert(
                        token, 
                        currentBalanceFormatted, 
                        this.networkName,
                        tx.hash
                    )
                );
            }

            ui.startLoading('⏳ Waiting for transaction confirmation...');
            const receipt = await tx.wait();

            ui.stopLoading();
            ui.showNotification('success', `✅ Successfully sent ${currentBalanceFormatted} ${token.symbol}`);
            ui.showNotification('info', `📄 Transaction confirmed in block ${receipt.blockNumber}`);

            if (this.telegramNotifier) {
                await this.telegramNotifier.sendNotification(
                    this.telegramNotifier.formatForwardSuccess(
                        token, 
                        currentBalanceFormatted, 
                        receipt.hash,
                        this.networkName
                    )
                );
            }

        } catch (error) {
            ui.stopLoading();
            ui.showNotification('error', `❌ Failed to transfer ${token.symbol}: ${error.message}`);
            
            // Clear nonce cache on error
            if (error.message.includes('nonce') || error.message.includes('replacement')) {
                this.gasOptimizer.clearNonceCache(this.wallet.address);
                ui.showNotification('warning', '🔄 Nonce cache cleared due to error');
            }
        }
    }

    stop() {
        this.isRunning = false;
        if (this.scanInterval) clearInterval(this.scanInterval);
        ui.stopLoading();
        ui.showNotification('info', '🛑 Auto Token Detection stopped');
    }
}

module.exports = AutoTokenDetectionManager;
