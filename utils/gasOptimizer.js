'use strict';
const { ethers } = require('ethers');
const ModernUI = require('../core/ModernUI');
const { ERC20_ABI } = require('./constants');
const ui = new ModernUI();

class AdvancedTokenDetector {
    constructor(provider, walletAddress) {
        this.provider = provider;
        this.walletAddress = walletAddress;
        this.detectedTokens = new Map();
    }

    // Enhanced token database with more tokens
    getTokenDatabase(network) {
        const database = {
            'BASE': [
                { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin' },
                { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ethereum' },
                { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', name: 'USD Base Coin' },
                { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin' },
                { address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', symbol: 'tBTC', name: 'Threshold Bitcoin' }
            ],
            'ARBITRUM': [
                { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC', name: 'USD Coin' },
                { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether USD' },
                { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', name: 'Wrapped Ethereum' },
                { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', name: 'Dai Stablecoin' },
                { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', name: 'Wrapped BTC' }
            ],
            'OPTIMISM': [
                { address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', symbol: 'USDC', name: 'USD Coin' },
                { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether USD' },
                { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ethereum' },
                { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', name: 'Dai Stablecoin' },
                { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', symbol: 'WBTC', name: 'Wrapped BTC' }
            ],
            'POLYGON': [
                { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', name: 'USD Coin' },
                { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether USD' },
                { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', name: 'Wrapped Ethereum' },
                { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', name: 'Dai Stablecoin' },
                { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', name: 'Wrapped BTC' }
            ],
            'ETHEREUM': [
                { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin' },
                { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD' },
                { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ethereum' },
                { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin' },
                { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped BTC' }
            ]
        };
        return database[network] || [];
    }

    async scanForTokens(network) {
        try {
            ui.startLoading(`🔍 Scanning blockchain for tokens on ${network}...`);
            
            const tokens = [];
            const networkTokens = this.getTokenDatabase(network);
            const totalTokens = networkTokens.length;
            
            for (let i = 0; i < networkTokens.length; i++) {
                const token = networkTokens[i];
                
                // Show progress
                ui.showTokenScanProgress(i + 1, totalTokens, network);
                
                try {
                    const tokenContract = new ethers.Contract(token.address, ERC20_ABI, this.provider);
                    
                    // Check if contract is valid by trying to get symbol
                    const symbol = await tokenContract.symbol();
                    const balance = await tokenContract.balanceOf(this.walletAddress);
                    const decimals = await tokenContract.decimals();
                    const name = await tokenContract.name();
                    
                    const balanceFormatted = parseFloat(ethers.formatUnits(balance, decimals));
                    
                    if (balanceFormatted > 0) {
                        const tokenInfo = {
                            address: token.address,
                            symbol: symbol,
                            name: name,
                            balance: balanceFormatted,
                            decimals: decimals,
                            contract: tokenContract
                        };
                        tokens.push(tokenInfo);
                        this.detectedTokens.set(token.address, tokenInfo);
                        
                        ui.showNotification('scan', `Found: ${balanceFormatted} ${symbol}`);
                    }
                } catch (error) {
                    // Skip invalid tokens
                    continue;
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            ui.stopLoading();
            return tokens;
        } catch (error) {
            ui.stopLoading();
            ui.showNotification('error', `Token scan failed: ${error.message}`);
            return [];
        }
    }

    async comprehensiveScan(network) {
        ui.startLoading(`🚀 Starting comprehensive token scan on ${network}...`);
        
        // Method 1: Database tokens
        const databaseTokens = await this.scanForTokens(network);
        
        ui.showNotification('success', `Scan completed: Found ${databaseTokens.length} tokens with balance`);
        
        return databaseTokens;
    }

    startContinuousScan(network, callback, interval = 30000) {
        ui.showNotification('info', `🔄 Starting continuous token monitoring every ${interval/1000} seconds`);
        
        let previousTokens = new Set();
        
        const scanInterval = setInterval(async () => {
            try {
                ui.startLoading(`🔄 Rescanning for new tokens on ${network}...`);
                const currentTokens = await this.scanForTokens(network);
                const currentTokenAddresses = new Set(currentTokens.map(t => t.address));
                
                // Check for new tokens
                for (const token of currentTokens) {
                    if (!previousTokens.has(token.address) && token.balance > 0) {
                        ui.showNotification('success', `🎯 New token detected: ${token.symbol} - ${token.balance} ${token.symbol}`);
                        if (callback) {
                            callback(token);
                        }
                    }
                }
                
                previousTokens = currentTokenAddresses;
                ui.stopLoading();
            } catch (error) {
                ui.stopLoading();
                ui.showNotification('error', `Monitoring error: ${error.message}`);
            }
        }, interval);

        return scanInterval;
    }
}

// ===== SIMPLE GAS OPTIMIZER
// ===== SIMPLE GAS OPTIMIZER =====
class SimpleGasOptimizer {
    constructor(provider, chainId) {
        this.provider = provider;
        this.chainId = chainId;
        this.nonceCache = new Map();
    }

    async getOptimalGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            // Use maxFeePerGas for EIP-1559 chains
            return feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("15", "gwei");
        } catch (error) {
            return ethers.parseUnits("15", "gwei");
        }
    }

    async calculateTransactionCost(gasLimit) {
        try {
            const gasPrice = await this.getOptimalGasPrice();
            const gasCostWei = gasPrice * BigInt(gasLimit);
            const gasCostETH = parseFloat(ethers.formatEther(gasCostWei));
            const gasCostIDR = Math.round(gasCostETH * 16000000);
            
            return {
                gasPrice,
                gasCostWei,
                gasCostETH,
                gasCostIDR,
                gasCostFormatted: gasCostETH.toFixed(8)
            };
        } catch (error) {
            // Fallback calculation
            const gasPrice = ethers.parseUnits("15", "gwei");
            const gasCostWei = gasPrice * BigInt(gasLimit);
            const gasCostETH = parseFloat(ethers.formatEther(gasCostWei));
            
            return {
                gasPrice,
                gasCostWei,
                gasCostETH,
                gasCostIDR: Math.round(gasCostETH * 16000000),
                gasCostFormatted: gasCostETH.toFixed(8)
            };
        }
    }

    async getCurrentNonce(walletAddress) {
        try {
            const key = `${walletAddress}-${this.chainId}`;
            
            if (this.nonceCache.has(key)) {
                const cached = this.nonceCache.get(key);
                if (Date.now() - cached.timestamp < 30000) {
                    return cached.nonce;
                }
            }
            
            const nonce = await this.provider.getTransactionCount(walletAddress, 'pending');
            this.nonceCache.set(key, { nonce, timestamp: Date.now() });
            return nonce;
        } catch (error) {
            const key = `${walletAddress}-${this.chainId}`;
            return this.nonceCache.has(key) ? this.nonceCache.get(key).nonce : 0;
        }
    }

    updateNonce(walletAddress) {
        const key = `${walletAddress}-${this.chainId}`;
        if (this.nonceCache.has(key)) {
            const current = this.nonceCache.get(key);
            this.nonceCache.set(key, {
                nonce: current.nonce + 1,
                timestamp: Date.now()
            });
        }
    }

    clearNonceCache(walletAddress) {
        const key = `${walletAddress}-${this.chainId}`;
        this.nonceCache.delete(key);
    }
}

module.exports = { AdvancedTokenDetector, SimpleGasOptimizer };
