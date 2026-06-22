'use strict';

class ModernUI {
    constructor() {
        this.theme = {
            primary: '\x1b[38;5;51m',
            secondary: '\x1b[38;5;141m',
            success: '\x1b[38;5;46m',
            warning: '\x1b[38;5;214m',
            error: '\x1b[38;5;203m',
            info: '\x1b[38;5;249m',
            accent: '\x1b[38;5;213m',
            reset: '\x1b[0m'
        };
        this.currentLoadingText = '';
        this.loadingInterval = null;
        this.box = {
            tl: '┏', tr: '┓', bl: '┗', br: '┛',
            h: '━', v: '│',
            lt: '┣', rt: '┫'
        };
        this.width = process.stdout.columns || 80;
        this.boxWidth = 70;

        process.stdout.on('resize', () => {
            this.width = process.stdout.columns || 80;
        });
    }

    stripAnsi(str) {
        if (!str) return '';
        return str.replace(/\x1b\[[0-9;]*m/g, '');
    }

    getCenterPadding(elementWidth) {
        return ' '.repeat(Math.max(0, Math.floor((this.width - elementWidth) / 2)));
    }

    async typewriterEffect(text, delay = 10) {
        process.stdout.write(this.theme.accent);
        const leftPad = this.getCenterPadding(this.stripAnsi(text).length);
        process.stdout.write(leftPad);
        for (let i = 0; i < text.length; i++) {
            process.stdout.write(text[i]);
            if (delay > 0) await this.sleep(delay);
        }
        process.stdout.write(this.theme.reset + '\n');
    }

    async showAnimatedBanner(charDelay = 1, finalWait = 0) {
        console.clear();
        const bannerLines = [
            '╔══════════════════════════════════════════════════════════════════════════════╗',
            '║                                                                              ║',
            '║  ███████╗ █████╗     ███████╗████████╗ █████╗ ██████╗ ██╗  ██╗███████╗      ║',
            '║  ██╔════╝██╔══██╗    ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚██╗██╔╝██╔════╝      ║',
            '║  █████╗  ███████║    ███████╗   ██║   ███████║██████╔╝ ╚███╔╝ ███████╗      ║',
            '║  ██╔══╝  ██╔══██║    ╚════██║   ██║   ██╔══██║██╔══██╗ ██╔██╗ ╚════██║      ║',
            '║  ██║     ██║  ██║    ███████║   ██║   ██║  ██║██║  ██║██╔╝ ██╗███████║      ║',
            '║  ╚═╝     ╚═╝  ╚═╝    ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝      ║',
            '║                                                                              ║',
            '║                   🚀 MULTI-CHAIN TRANSFER BOT v20.0.0 🚀                    ║',
            '║                   (Generate Wallet & Backup Phrase)                         ║',
            '║                                                                              ║',
            '╚══════════════════════════════════════════════════════════════════════════════╝'
        ];
        for (const line of bannerLines) {
            await this.typewriterEffect(line, charDelay);
        }
        console.log(this.theme.reset + '\n');
        if (finalWait > 0) await this.sleep(finalWait);
    }

    createBox(title, content, type = 'info') {
        const colors = {
            info: this.theme.primary,
            success: this.theme.success,
            warning: this.theme.warning,
            error: this.theme.error
        };
        const color = colors[type] || this.theme.primary;
        const innerWidth = this.boxWidth - 4;
        const leftPad = this.getCenterPadding(this.boxWidth);

        console.log(leftPad + color + this.box.tl + this.box.h.repeat(innerWidth + 2) + this.box.tr + this.theme.reset);
        const cleanTitle = this.stripAnsi(title);
        const titlePadding = ' '.repeat(innerWidth + 1 - cleanTitle.length);
        console.log(leftPad + color + this.box.v + this.theme.reset + ' ' + this.theme.accent + title + this.theme.reset + titlePadding + color + this.box.v + this.theme.reset);
        console.log(leftPad + color + this.box.lt + this.box.h.repeat(innerWidth + 2) + this.box.rt + this.theme.reset);
        const lines = Array.isArray(content) ? content : content.split('\n');
        lines.forEach(line => {
            const cleanLine = this.stripAnsi(line);
            const linePadding = ' '.repeat(Math.max(0, innerWidth + 1 - cleanLine.length));
            console.log(leftPad + color + this.box.v + this.theme.reset + ' ' + line + linePadding + color + this.box.v + this.theme.reset);
        });
        console.log(leftPad + color + this.box.bl + this.box.h.repeat(innerWidth + 2) + this.box.br + this.theme.reset + '\n');
    }

    showNotification(type, message, title = null) {
        const icons = {
            success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️',
        };
        const titles = {
            success: 'SUCCESS', error: 'ERROR', warning: 'WARNING', info: 'INFO',
        };
        this.stopLoading();
        const notifTitle = title || titles[type];
        const icon = icons[type] || '📢';

        if (Array.isArray(title)) {
            this.createBox(`${icon} ${message}`, title, type);
        } else {
            this.createBox(`${icon} ${notifTitle}`, [message], type);
        }
    }

    startLoading(text) {
        this.stopLoading();
        this.currentLoadingText = text;
        const frames = ['⣾', '⣽', '⣻', '⢿', '⣟', '⣯', '⣷'];
        let i = 0;
        const textWidth = this.stripAnsi(text).length + 2;
        const leftPad = this.getCenterPadding(textWidth);
        this.loadingInterval = setInterval(() => {
            process.stdout.write(`\r\x1b[K`);
            process.stdout.write(leftPad + this.theme.secondary + frames[i] + this.theme.reset + ' ' + text);
            i = (i + 1) % frames.length;
        }, 120);
    }

    stopLoading() {
        if (this.loadingInterval) {
            clearInterval(this.loadingInterval);
            this.loadingInterval = null;
            process.stdout.write('\r\x1b[K');
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    showTokenScanProgress(current, total, network) {
        process.stdout.write(`\r\x1b[K  🔍 Scanning ${network}: ${current}/${total} tokens...`);
    }

    showTransactionSummary(tokenInfo, amount, gasCost, extra, networkName) {
        const name = tokenInfo?.symbol || tokenInfo?.name || 'Token';
        const gwei = gasCost?.gasPrice ? (Number(gasCost.gasPrice) / 1e9).toFixed(2) : '?';
        console.log(`\n💸 TRANSACTION SUMMARY`);
        console.log(`   Token   : ${name}`);
        console.log(`   Amount  : ${amount}`);
        console.log(`   Network : ${networkName}`);
        console.log(`   Gas     : ~${gasCost?.gasCostFormatted || '?'} ETH (${gwei} Gwei)`);
    }

    maskAddress(address) {
        if (!address || address.length < 10) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    showTokenScanResults(tokens) {
        if (!tokens || tokens.length === 0) {
            console.log('📭 No tokens found.');
            return;
        }
        console.log(`\n🎯 TOKEN SCAN RESULTS (${tokens.length} found):`);
        tokens.forEach((t, i) => {
            console.log(`  ${i + 1}. ${t.symbol} — ${t.balance} (${t.address})`);
        });
    }
}

module.exports = ModernUI;