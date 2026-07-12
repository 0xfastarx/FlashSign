<div align="center">

```
███████╗ █████╗     ███████╗████████╗ █████╗ ██████╗ ██╗  ██╗    ██████╗  ██████╗ ████████╗
██╔════╝██╔══██╗    ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔═══██╗╚══██╔══╝
█████╗  ███████║    ███████╗   ██║   ███████║██████╔╝ ╚███╔╝     ██████╔╝██║   ██║   ██║   
██╔══╝  ██╔══██║    ╚════██║   ██║   ██╔══██║██╔══██╗ ██╔██╗     ██╔══██╗██║   ██║   ██║   
██║     ██║  ██║    ███████║   ██║   ██║  ██║██║  ██║██╔╝ ██╗    ██████╔╝╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝    ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═════╝  ╚═════╝    ╚═╝  
```

# 🚀 FA STARX BOT `v20.0.0`

**Multi-Chain Auto-Transaction Bot** for EVM, Solana, Aptos, Sui, TON, and NEAR with WalletConnect, Extension Inject, and full control via Telegram.

[![Node.js](https://img.shields.io/badge/Node.js-≥18.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Ethers.js](https://img.shields.io/badge/Ethers.js-v6.x-764ABC?style=for-the-badge&logo=ethereum&logoColor=white)](https://ethers.org)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![WalletConnect](https://img.shields.io/badge/WalletConnect-v2.x-3B99FC?style=for-the-badge)](https://walletconnect.com)
[![License](https://img.shields.io/badge/License-ISC-green?style=for-the-badge)](LICENSE)

</div>

---

## 📋 Table of Contents

- [✨ Key Features](#-key-features)
- [📦 Installation](#-installation)
- [⚙️ Configuration & Licensing](#️-configuration--licensing)
- [▶️ Running the Bot](#️-running-the-bot)
- [📱 Telegram Usage Guide](#-telegram-usage-guide)
- [🎛️ Management & Licensing (Admin Side)](#️-management--licensing-admin-side)
- [🦊 Browser Extension](#-browser-extension)
- [🔒 Security](#-security)
- [📁 Directory Structure](#-directory-structure)

---

## ✨ Key Features

### 🔗 Connection & Transactions

| Feature | Description |
|-------|-----------|
| **Multi-Chain Support** | Full support for EVM chains (Ethereum, BSC, Polygon, etc.) & Non-EVM chains (Solana, Aptos, Sui, TON, NEAR) |
| **WalletConnect v2** | Auto-approve transactions from DApps via WalletConnect protocol |
| **Extension Inject** | Custom server acting as a transaction bridge from browser extensions |
| **Multi-Port RPC** | Run multiple RPC servers on different ports simultaneously |
| **VPS / Localhost Mode** | Flexible server modes: local (`127.0.0.1`) or public VPS (`0.0.0.0`) |
| **Auto-Save DApp RPC** | Auto-save RPC URLs from DApps to configuration |
| **Smart Delay Execution** | Delay transaction execution with adjustable delay times |

### 💼 Wallet Management

| Feature | Description |
|-------|-----------|
| **Import Private Key** | Directly import wallets using private keys |
| **Import via Mnemonic** | Import wallets from 12/24-word Seed Phrases with custom derivation paths |
| **Auto-Generate Wallet** | Randomly generate new wallets, complete with Mnemonic Phrases |
| **Backup Phrase Viewer** | View Mnemonics / Private Keys of stored wallets |
| **Multi-Wallet** | Manage and store multiple wallets simultaneously; switch the active one at any time |
| **Delete Wallet** | Delete wallets from encrypted storage with confirmation |
| **Balance Checker** | Monitor native coin balances (ETH, SOL, APT, SUI, TON, NEAR) in real-time |
| **Transaction Statistics** | View total transactions and history from the blockchain |

### 🌐 RPC & Gas Management

| Feature | Description |
|-------|-----------|
| **Multi-RPC Manager** | Easily save, select, and delete RPC configurations (EVM, Solana, Aptos, Sui, TON, NEAR) |
| **Gas Mode: Auto** | Automatic gas price estimation from the network |
| **Gas Mode: Manual** | Force specific gas values (Gwei) for each transaction |
| **Gas Mode: Aggressive** | Boost gas price by a certain percentage for high priority |
| **Manual RPC Input Only** | No default/built-in RPCs. Users must enter RPCs manually via the bot menu for privacy and security. |

### 🔐 Layered Security

| Feature | Description |
|-------|-----------|
| **Two-Factor Auth (2FA)** | Google Authenticator (TOTP RFC 6238) for setup, login, and configuration change approval |
| **Dual Password System** | Separate passwords for Administrator and Script access |
| **Folder Protection (.data/)** | Auto-detection if the hidden `.data/` directory is deleted, blocking startup and demanding OTP verification to safely restore |
| **RAM-Cached Localization** | Optimized RAM-cached multi-language system (ID/EN) to prevent disk decryption delays |
| **AES-256-GCM Encryption** | Military-grade encryption for all wallet data |
| **.env Encryption** | All `.env` configuration values are encrypted (not plaintext) |
| **Chat ID Whitelist** | Only registered Telegram IDs can access the bot |
| **Isolated Sessions** | Every user has an isolated, encrypted session |
| **OTP Login** | Option to log in via a 6-digit Google Authenticator code without typing a password |
| **2FA Grace Period** | 7-day grace period if the password is changed after 2FA is active |
| **Telegram Startup OTP** | Upon program/configuration changes, OTP is requested directly via a Telegram Switch Bot (not in terminal) |
| **Contextual Alerts** | Telegram notifications distinguish between configuration changes (`.env`) and source code modifications |

### 🌐 DApp Connection Approval

| Feature | Description |
|-------|-----------|
| **Auto-Connect Mode** | New DApps connect automatically without confirmation (default) |
| **Manual Approval Mode** | Every new DApp connection requires manual approval via Telegram |
| **DApp Connect Notifications** | Telegram sends detailed notifications of newly connected DApps |
| **Connected DApp Management** | View the list of connected DApps and disconnect them at any time |
| **Toggle Approval** | Turn approval mode on/off directly from the Telegram menu |

### 🔐 Morse Cipher Tool

| Feature | Description |
|-------|-----------|
| **Text Encryption** | Convert plain text into custom encrypted Morse code |
| **Code Decryption** | Decrypt Morse code back to its original plain text |
| **Process .txt Files** | Upload `.txt` files directly to Telegram for encryption/decryption |
| **Save Messages** | Save encrypted results on the server with custom names/labels |
| **Password Protection** | Lock saved messages with an optional additional password |
| **Delete Messages** | Delete saved messages from the list at any time |
| **Encrypted Database** | Morse mapping stored encrypted using AES-256-CBC inside the program |

### 💸 Transfer Bot

| Feature | Description |
|-------|-----------|
| **ETH Auto-Forward** | Auto-forward ETH to a destination address when balance is detected |
| **Token Auto-Forward** | Auto-forward ERC-20 tokens to a destination address |
| **Auto Token Detection** | Scan and automatically detect all ERC-20 tokens with a balance |
| **Continuous Monitoring** | Monitor wallets continuously with a 30-second interval |
| **Gas-Safe Transfer** | Auto-calculate gas fees before transferring to ensure the balance is not drained |

### 📊 Tracking Bot (Mainnet)

| Feature | Description |
|-------|-----------|
| **16 Mainnets Supported** | Monitor Ethereum, BNB Chain, Polygon, Avalanche, Fantom, Gnosis, Celo, Cronos, Arbitrum, Optimism, Base, Linea, zkSync Era, Scroll, Blast, and Mantle |
| **Watch-Only (Read-Only)** | Monitor wallets using only public addresses without requiring Private Keys or Mnemonics |
| **USDT Valuation & Scam Alert** | Auto-detect incoming ERC-20 token values in USDT via CoinGecko/DexScreener API (flags $0/no-price tokens as potential scams) |
| **Detailed Tracking History** | View transaction history with 5 interactive navigation buttons + "View More History" (paginated) |
| **Value Estimation Filter** | Filter incoming transaction alerts based on minimum estimated value in USDT |
| **Flexible Control** | Independently toggle native gas token and ERC-20 token transfer monitoring |
| **Auto-Resume** | Tracker polling automatically resumes when the bot restarts |

---

## 📦 Installation

### Prerequisites

- **Node.js** version 18 or later
- **npm** (included with Node.js)
- Telegram Account & Bot Token from [@BotFather](https://t.me/BotFather)

### Installation Steps

```bash
# 1. Clone or download the project from GitHub
git clone https://github.com/ferystarx123x/fastarx-bot.git
cd fastarx-bot

# 2. Install all dependencies
npm install

# 3. Run the bot (Registration Wizard appears automatically on the first launch)
node main.js
```

When run for the **first time**, the bot will display the **Registration Wizard**. Simply enter the following 4 parameters:

| Parameter | Example / Value | Description |
|-----------|-----------------|-------------|
| **URL VPS Controller** | `ws://47.88.65.187:4433` | Enter this URL (Active Controller) |
| **Your Name** | `John` | Any name for account identification |
| **Telegram Bot Token** | `123456:ABC-DEF...` | Obtained from [@BotFather](https://t.me/BotFather) |
| **Telegram Chat ID** | `987654321` | Your Telegram Chat ID (numeric) |

Once registration is successful, the configuration is saved automatically. Running the main bot on subsequent launches will connect directly without requiring re-entry.

### Dependencies

| Package | Version | Description |
|---------|-------|--------|
| `ethers` | ^6.16.0 | Ethereum / EVM blockchain interactions |
| `@solana/web3.js` | ^1.98.4 | Solana blockchain interactions |
| `@aptos-labs/ts-sdk` | ^7.2.0 | Aptos blockchain interactions |
| `@mysten/sui` | ^2.20.1 | Sui blockchain interactions |
| `@ton/ton` | ^16.3.0 | TON blockchain interactions |
| `@ton/crypto` | ^3.3.0 | Cryptography helper for TON |
| `near-api-js` | ^7.2.0 | NEAR blockchain interactions |
| `@walletconnect/sign-client` | ^2.23.8 | WalletConnect v2 protocol |
| `node-telegram-bot-api` | ^0.64.0 | Telegram Bot API |
| `dotenv` | ^16.0.0 | Loads `.env` configuration |
| `node-os-utils` | ^2.0.1 | System resource monitoring |
| `systeminformation` | ^5.31.4 | Hardware & OS information |

---

## ⚙️ Configuration & Licensing

Unlike older versions, the bot **no longer stores sensitive configuration files locally**. All configuration (tokens, security variables, etc.) is managed centrally on the **Server Controller (VPS)** and delivered to your bot after successful registration.

### How It Works

```
1. Bot is launched for the first time  →  Registration Wizard (see Installation)
2. Registration data is sent to        →  VPS Controller
3. VPS verifies and saves your account
4. On every startup, the bot fetches encrypted configuration from the VPS
5. The bot runs according to the permissions/licenses granted by the admin
```

### Local Configuration Files

After registration, only one small file is saved on your machine:

```
.data/client-config.json   ← Client ID & VPS URL (NO sensitive data)
```

> 🔐 Bot tokens and security data are **never** stored on your local computer — they are sent directly from the VPS at runtime and processed solely in memory.

> ⚠️ **DO NOT share your `.data/` directory with anyone!**

---

## ▶️ Running the Bot

```bash
# Normal mode
node main.js

# Development mode (auto-restart on file changes)
npm run dev
```

The bot will automatically detect its running mode:

- **🤖 Telegram Mode** → If `TELEGRAM_BOT_TOKEN` is available
- **💻 Terminal Mode** → If no token is found (CLI mode)

---

## 📱 Telegram Usage Guide

### Login

1. Open the bot on Telegram → send `/start`
2. Select your access level: **Administrator** or **Script**
3. Enter your password, or use **Google Authenticator** if 2FA is active.

### Main Menu

```
💼 Wallet Management    →  Manage wallets (import, generate, backup, delete)
🌐 RPC Management       →  Manage RPC & gas configurations
🔗 WalletConnect        →  Connect to DApps via WalletConnect
🦊 Extension Inject     →  Manage Extension Inject server
📂 Other Menus          →  Transfer Bot, Morse Cipher, Tracking Bot (Mainnet), etc.
⚙️ Settings              →  DApp Approval, change password, etc.
```

### Telegram Commands

| Command | Function |
|----------|--------|
| `/start` | Start the bot & log in |
| `/menu` | Display the main menu |
| `/status` | Check current bot & connection status |

### Extension Inject Flow

```
1. Open the 🦊 Extension Inject menu in Telegram
2. Select a port → Start Server
3. Copy the RPC URL: http://127.0.0.1:<port>
4. Open MetaMask → Settings → Networks → Add Network
   - Network Name: (any name)
   - RPC URL     : http://127.0.0.1:<port>
   - Chain ID    : (matching your configuration)
5. Switch to the new network in MetaMask
6. Any transaction initiated from DApps → the bot will automatically sign & send! ✅
```

### Tracking Bot Setup & Guide

```
1. Open 📂 Other Menus → 📊 Tracking Bot
2. Add Watcher Wallet:
   - Send the public address (read-only, no private key or seed phrase required)
   - Set a custom name/label
   - Select the mainnets you want to monitor (up to 16 supported mainnets)
3. Set Explorer API Keys (Optional):
   - Go to ⚙️ Settings → 🔑 Set Explorer API Keys
   - Enter API Keys for BSC, Fantom, Cronos, or Linea to monitor those networks
4. Enable Polling:
   - Click 🟢 Enable Tracking to start background monitoring (every 45 seconds)
5. Notifications & History:
   - Incoming transactions will trigger alerts showing details and estimated USDT values
   - Click 📜 Tracking History to view paginated incoming transaction history (5 items per page)
```

---

## 🎛️ Management & Licensing (Admin Side)

This bot is centrally managed by the **admin/provider** via the **Server Controller** running on the VPS. As a user, you **do not need** to run or manage this part — everything happens automatically after registration.

### Admin Controls

| Feature | Description |
|-------|-----------|
| **Account Activation** | Admin activates your account after successful registration |
| **License Expiration** | Admin configures your license duration |
| **Real-Time Control** | Admin can enable/disable your bot access at any time via Telegram |
| **Config Distribution** | Tokens & security configurations are auto-sent from the VPS to your bot |

### Troubleshooting Connections

```
1. Ensure your internet connection is active
2. Verify that the VPS Controller URL entered is correct (ws://IP:PORT)
3. Contact the admin/provider to check:
   - If your license/account is still active
   - If the Controller Server is currently running
```

> 💡 The bot will only run while the Controller Server is active and your license is approved by the admin.

---

## 🦊 Browser Extension

The bot includes **three versions of browser extensions** for seamless integration with DApps:

### Chrome Extension (Manifest V3)
> Location: `extension bot metamaks/`
```
Version    : 4.0.0
Supports   : Chrome, Brave, Edge (Chromium)
```

### Bitget Wallet Extension (Manifest V3)
> Location: `extension bot bitget/`
```
Version    : 1.0.0
Supports   : Chrome, Brave, Edge (Chromium)
Description: A custom extension disguised as Bitget Wallet to safely route DApp requests to the local Extension Inject server.
```

### Firefox Extension
> Location: `fastarx-firefox extension/`
```
Supports   : Firefox, Firefox ESR
```

### How to Install Extensions

**Chrome / Bitget Extension:**
1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the desired extension folder (`extension bot metamaks/` or `extension bot bitget/`)

**Firefox:**
1. Open `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select the `manifest.json` file inside the `fastarx-firefox extension/` folder

> 💡 Extensions automatically inject the Ethereum provider into DApps and redirect requests to the bot's local RPC server.

---

## 🔒 Security

### 🛡️ Integrity Guard System (Self-Defeating Code)
To prevent unauthorized modifications or tampering with the codebase, the bot is protected by a high-grade **Integrity Guard**:

* **Live Hash Project Binding**: The decryption key for `.env` is dynamically derived using a combination of the master key and the **SHA-256 live hash** of all project source files (`bot/`, `utils/`, `core/`, `transfer/`, `config/`, `modes/`, `auth/`, `rpc/`, `main.js`, `package.json`, `package-lock.json`, and all dual-defense security markers).
* **Self-Defeating (Auto-Brick)**: If the source code is modified by even 1 character (including spaces), the decryption key will mismatch, causing configuration decryption to fail (`bad decrypt`), and the bot will lock itself before any malicious code can execute.
* **Telegram OTP Verification**: When a code/configuration change is detected, the main bot contacts the local **Switch Bot** (HTTP port 3099). The Switch Bot sends a **contextual notification** to the admin's Telegram (differentiating between `.env` edits and source code modifications). The admin enters a 6-digit OTP via Telegram to authorize the changes without needing SSH/terminal access.
* **CLI Fallback**: If the Switch Bot is offline at startup, the system automatically falls back to requesting the OTP/password via terminal.
* **Auto-Recovery**: If the integrity lock file `.integrity.lock` is deleted or tampered with, the bot enters recovery mode and requests the Admin Password to restore the database from the secure backup `.system-integrity-check`.
* **Folder Protection (.data/)**: If the hidden `.data/` directory is missing or deleted, the bot will block startup and request OTP verification before safely restoring a fresh data directory, preventing session bypasses.

### Encryption Details

| Data | Encryption Method |
|------|----------------|
| `.env` File | AES-256-CBC (dynamic PBKDF2 key bound to Live Hash) |
| Wallet Data | AES-256-GCM (auth tag, per-session key) |
| Dual Defense Markers | AES-256-GCM (PBKDF2 master key 100K iterations) |
| Morse Messages | AES-256-CBC (Scrypt key derivation) |
| Morse Mappings | AES-256-CBC (embedded in source) |
| Password Hashes | PBKDF2-SHA512 (1000 iterations) |

### Best Practices

- ✅ Run the bot only on servers you fully trust
- ✅ Enable 2FA (Google Authenticator) for maximum security
- ✅ Turn on **DApp Approval Mode** to prevent unknown connections
- ✅ Regularly backup the `.data/` directory
- ❌ Never share your `.env` file, `.data/` folder, or hidden security markers (`.*`)
- ❌ Do not expose the Extension Inject ports to the internet without a firewall

---

## 📁 Directory Structure `.data/`

Per-session data is stored in the hidden `.data/` folder in the following format:

```
.data/
├── <session_id>_wallets.enc        ← Encrypted wallets (AES-256-GCM)
├── <session_id>_rpc-config.json    ← RPC & DApp configurations
├── <session_id>_rpc-ports.json     ← Extension Inject port settings
├── <session_id>_master.key         ← Session encryption key (SECRET!)
├── <chat_id>_tracked_wallets.json  ← List of tracked addresses for watcher bot
├── <chat_id>_tracker_state.json     ← Watcher bot active status and filter cursor
├── <chat_id>_tracker_history.json   ← Watcher bot notification history
└── .2fa_config.enc                 ← Encrypted 2FA configuration
```

> 🔐 Files with `*.enc` and `*.key` extensions cannot be read without the correct cryptographic keys.

---

<div align="center">

**Made with ❤️ by FA STARX**

*Use wisely and responsibly.*

</div>
