<div align="center">

```
███████╗ █████╗     ███████╗████████╗ █████╗ ██████╗ ██╗  ██╗    ██████╗  ██████╗ ████████╗
██╔════╝██╔══██╗    ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔═══██╗╚══██╔══╝
█████╗  ███████║    ███████╗   ██║   ███████║██████╔╝ ╚███╔╝     ██████╔╝██║   ██║   ██║   
██╔══╝  ██╔══██║    ╚════██║   ██║   ██╔══██║██╔══██╗ ██╔██╗     ██╔══██╗██║   ██║   ██║   
██║     ██║  ██║    ███████║   ██║   ██║  ██║██║  ██║██╔╝ ██╗    ██████╔╝╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝    ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═════╝  ╚═════╝    ╚═╝  
```

# 🚀 FA STARX BOT `v19.0.0`

**Multi-Chain Auto-Transaction Bot** dengan WalletConnect, MetaMask RPC Inject, dan kendali penuh via Telegram

[![Node.js](https://img.shields.io/badge/Node.js-≥18.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Ethers.js](https://img.shields.io/badge/Ethers.js-v6.x-764ABC?style=for-the-badge&logo=ethereum&logoColor=white)](https://ethers.org)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![WalletConnect](https://img.shields.io/badge/WalletConnect-v2.x-3B99FC?style=for-the-badge)](https://walletconnect.com)
[![License](https://img.shields.io/badge/License-ISC-green?style=for-the-badge)](LICENSE)

</div>

---

## 📋 Daftar Isi

- [✨ Fitur Utama](#-fitur-utama)
- [🏗️ Arsitektur Sistem](#️-arsitektur-sistem)
- [📦 Instalasi](#-instalasi)
- [⚙️ Konfigurasi](#️-konfigurasi)
- [▶️ Menjalankan Bot](#️-menjalankan-bot)
- [📱 Panduan Penggunaan Telegram](#-panduan-penggunaan-telegram)
- [🦊 Browser Extension](#-browser-extension)
- [🔒 Keamanan](#-keamanan)
- [📁 Struktur Direktori](#-struktur-direktori)

---

## ✨ Fitur Utama

### 🔗 Koneksi & Transaksi

| Fitur | Deskripsi |
|-------|-----------|
| **WalletConnect v2** | Auto-approve transaksi dari DApp via protokol WalletConnect |
| **MetaMask RPC Inject** | Server RPC kustom yang menjadi perantara transaksi dari MetaMask/browser |
| **Multi-Port RPC** | Jalankan beberapa server RPC di port berbeda secara bersamaan |
| **VPS / Localhost Mode** | Mode server fleksibel: lokal (`127.0.0.1`) atau VPS publik (`0.0.0.0`) |
| **Auto-Save DApp RPC** | URL RPC dari DApp otomatis disimpan ke konfigurasi |
| **Smart Delay Execution** | Tunda eksekusi transaksi dengan jeda waktu yang dapat diatur |

### 💼 Manajemen Wallet

| Fitur | Deskripsi |
|-------|-----------|
| **Import Private Key** | Import wallet menggunakan private key secara langsung |
| **Import via Mnemonic** | Import wallet dari 12/24 kata Seed Phrase dengan derivation path kustom |
| **Generate Wallet Otomatis** | Buat wallet baru secara acak, lengkap dengan Mnemonic Phrase |
| **Backup Phrase Viewer** | Lihat kembali Mnemonic / Private Key dari wallet yang tersimpan |
| **Multi-Wallet** | Kelola dan simpan banyak wallet sekaligus, ganti aktif kapan saja |
| **Hapus Wallet** | Hapus wallet dari penyimpanan terenkripsi dengan konfirmasi |
| **Cek Balance** | Pantau saldo ETH wallet aktif secara real-time |
| **Statistik Transaksi** | Lihat total transaksi dan riwayat dari blockchain |

### 🌐 Manajemen RPC & Gas

| Fitur | Deskripsi |
|-------|-----------|
| **Multi-RPC Manager** | Simpan, pilih, dan hapus konfigurasi RPC dengan mudah |
| **Gas Mode: Auto** | Gas price otomatis dari estimasi jaringan |
| **Gas Mode: Manual** | Paksa nilai Gas (Gwei) tertentu untuk setiap transaksi |
| **Gas Mode: Aggressive** | Boost gas price dengan persentase tertentu untuk prioritas tinggi |
| **Default RPC Built-in** | Ethereum Mainnet, BSC, Polygon, dan RPC kustom dari `.env` sudah tersedia |

### 🔐 Keamanan Berlapis

| Fitur | Deskripsi |
|-------|-----------|
| **Two-Factor Auth (2FA)** | Google Authenticator (TOTP RFC 6238) untuk login Admin & Script |
| **Dual Password System** | Password terpisah untuk akses Administrator dan Script |
| **Enkripsi AES-256-GCM** | Semua data wallet dienkripsi dengan standar militer |
| **Enkripsi .env** | Seluruh nilai konfigurasi di `.env` dienkripsi (bukan plaintext) |
| **Whitelist Chat ID** | Hanya Telegram ID yang terdaftar yang bisa mengakses bot |
| **Sesi Terpisah** | Setiap pengguna mendapat session terenkripsi yang terisolasi |
| **OTP Login** | Opsi masuk via kode 6-digit Google Authenticator tanpa mengetik password |
| **Grace Period 2FA** | Periode tenggang 7 hari jika password diubah setelah 2FA dipasang |

### 🌐 DApp Connection Approval

| Fitur | Deskripsi |
|-------|-----------|
| **Mode Auto-Connect** | DApp baru langsung terhubung tanpa konfirmasi (default) |
| **Mode Manual Approval** | Setiap koneksi DApp baru membutuhkan persetujuan via Telegram |
| **Notifikasi DApp Connect** | Telegram mengirim detail DApp yang baru terhubung |
| **Kelola DApp Terhubung** | Lihat daftar dan putuskan koneksi DApp kapan saja |
| **Toggle Approval** | Aktifkan/nonaktifkan mode approval langsung dari menu Telegram |

### 🔐 Morse Cipher Tool

| Fitur | Deskripsi |
|-------|-----------|
| **Enkripsi Teks** | Ubah teks biasa menjadi Morse kustom terenkripsi |
| **Dekripsi Kode** | Kembalikan kode Morse ke teks aslinya |
| **Proses File .txt** | Upload file `.txt` langsung ke Telegram untuk dienkripsi/didekripsi |
| **Simpan Pesan** | Simpan hasil enkripsi di server dengan nama/label kustom |
| **Proteksi Password** | Kunci pesan tersimpan dengan password tambahan (opsional) |
| **Hapus Pesan** | Hapus pesan tersimpan dari daftar kapan saja |
| **Database Terenkripsi** | Mapping Morse disimpan terenkripsi AES-256-CBC di dalam program |

### 💸 Transfer Bot

| Fitur | Deskripsi |
|-------|-----------|
| **ETH Auto-Forward** | Auto-kirim ETH ke alamat tujuan saat saldo terdeteksi |
| **Token Auto-Forward** | Auto-kirim ERC-20 token ke alamat tujuan |
| **Auto Token Detection** | Scan dan deteksi semua token ERC-20 yang memiliki saldo secara otomatis |
| **Continuous Monitoring** | Pantau wallet terus-menerus dengan interval 30 detik |
| **Gas-Safe Transfer** | Kalkulasi biaya gas sebelum transfer agar saldo tidak habis untuk fee |

---

## 🏗️ Arsitektur Sistem

```
fastarx-bot/
├── main.js                    ← Entry point (Telegram Mode / Terminal Mode)
├── setup.js                   ← Setup wizard interaktif & enkripsi .env
├── control.js                 ← Controller utama (opsional)
│
├── bot/
│   ├── TelegramFullController.js  ← Semua logika Telegram Bot (menu, callback, state)
│   └── CryptoAutoTx.js            ← Core: Wallet, WalletConnect, RPC, 2FA
│
├── rpc/
│   └── MetaMaskRpcServer.js   ← HTTP server sebagai custom RPC (RPC Inject)
│
├── transfer/
│   ├── EthTransfer.js             ← ETH auto-forward & monitoring
│   ├── TokenTransfer.js           ← ERC-20 token auto-forward
│   └── AutoTokenDetectionManager.js  ← Auto-detect & transfer semua token
│
├── auth/
│   └── TwoFactorAuth.js       ← TOTP 2FA (Google Authenticator)
│
├── utils/
│   ├── morse.js               ← Enkripsi/Dekripsi Morse Cipher
│   ├── morseStorage.js        ← Penyimpanan pesan Morse terenkripsi
│   ├── gasOptimizer.js        ← Kalkulasi gas optimal
│   ├── secureConfig.js        ← Dekripsi konfigurasi dari .env
│   ├── constants.js           ← Konstanta global (ABI, Gas Config)
│   └── validators.js          ← Fungsi utility & validasi
│
├── core/
│   ├── ModernUI.js            ← UI terminal (banner, loading, notifikasi)
│   ├── TransactionQueue.js    ← Antrian transaksi global
│   └── InputHandler.js        ← Handler input readline
│
├── config/
│   └── loadConfiguration.js   ← Load & dekripsi semua konfigurasi
│
├── modes/
│   └── terminalMode.js        ← Mode CLI (tanpa Telegram)
│
├── fa-starx-extension-v4/    ← Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background/service-worker.js
│   ├── content/
│   └── popup/
│
└── fastarx-firefox extension/ ← Firefox Extension
    ├── manifest.json
    ├── background/service-worker.js
    ├── content/
    └── popup/
```

---

## 📦 Instalasi

### Prasyarat

- **Node.js** versi 18 atau lebih baru
- **npm** (sudah termasuk dengan Node.js)
- Akun Telegram & Bot Token dari [@BotFather](https://t.me/BotFather)

### Langkah Instalasi

```bash
# 1. Clone atau ekstrak folder project
cd fastarx-bot

# 2. Install semua dependensi
npm install

# 3. Jalankan setup wizard (buat file .env terenkripsi)
node setup.js

# 4. Jalankan bot
node main.js
```

### Dependensi

| Package | Versi | Fungsi |
|---------|-------|--------|
| `ethers` | ^6.16.0 | Interaksi blockchain Ethereum |
| `@walletconnect/sign-client` | ^2.23.8 | Protokol WalletConnect v2 |
| `node-telegram-bot-api` | ^0.64.0 | Telegram Bot API |
| `dotenv` | ^16.0.0 | Load konfigurasi .env |
| `node-os-utils` | ^2.0.1 | Monitoring resource sistem |
| `systeminformation` | ^5.31.4 | Info hardware & OS |

---

## ⚙️ Konfigurasi

### Menggunakan Setup Wizard (Direkomendasikan)

```bash
node setup.js
```

Setup wizard akan memandu Anda mengisi **5 item manual**:

1. `Telegram Bot Token` — Token bot utama
2. `Controller Bot Token` — Token bot controller (opsional)
3. `Owner Telegram ID` — Telegram ID Anda sebagai owner
4. `Password Admin` — Kata sandi akses Administrator
5. `Password Script` — Kata sandi akses Script

> ✅ Semua nilai akan **dienkripsi otomatis** menggunakan AES-256-CBC sebelum disimpan ke `.env`

### Struktur `.env` (Setelah Setup)

```env
# System
SYSTEM_ID=sys_id_xxxxx

# Keamanan
ADMIN_PASSWORD_ENCRYPTED="..."
SCRIPT_PASSWORD_ENCRYPTED="..."
GITHUB_MAIN_URL_ENCRYPTED="..."
ENCRYPTION_SALT_ENCRYPTED="..."

# Telegram (Dual Bot)
TELEGRAM_BOT_TOKEN_ENCRYPTED="..."
CONTROLLER_BOT_TOKEN_ENCRYPTED="..."
ADMIN_CHAT_ID_ENCRYPTED="..."
OWNER_TELEGRAM_ID_ENCRYPTED="..."

# Kripto & RPC
WALLETCONNECT_PROJECT_ID_ENCRYPTED="..."
DEFAULT_RPC_URL_ENCRYPTED="..."
DEFAULT_RPC_CHAIN_ID_ENCRYPTED="..."
```

> ⚠️ **JANGAN bagikan file `.env` ke siapapun!**

---

## ▶️ Menjalankan Bot

```bash
# Mode normal
node main.js

# Mode development (auto-restart saat file berubah)
npm run dev
```

Bot akan otomatis mendeteksi mode:

- **🤖 Telegram Mode** → Jika `TELEGRAM_BOT_TOKEN` tersedia
- **💻 Terminal Mode** → Jika token tidak ditemukan (mode CLI)

---

## 📱 Panduan Penggunaan Telegram

### Login

1. Buka bot di Telegram → kirim `/start`
2. Pilih level akses: **Administrator** atau **Script**
3. Masukkan password, atau gunakan **Google Authenticator** jika 2FA aktif

### Menu Utama

```
💼 Wallet Management    →  Kelola wallet (import, generate, backup, hapus)
🌐 RPC Management       →  Kelola konfigurasi RPC & gas
🔗 WalletConnect        →  Connect ke DApp via WalletConnect
🦊 RPC Inject           →  Kelola server MetaMask RPC Inject
📂 Menu Lainnya         →  Transfer Bot, Morse Cipher, dll
⚙️ Pengaturan           →  DApp Approval, ganti password, dll
```

### Perintah Telegram

| Perintah | Fungsi |
|----------|--------|
| `/start` | Mulai bot & login |
| `/menu` | Tampilkan menu utama |
| `/status` | Status bot & koneksi saat ini |

### Alur MetaMask RPC Inject

```
1. Buka menu 🦊 RPC Inject di Telegram
2. Pilih port → Start Server
3. Salin URL RPC: http://127.0.0.1:<port>
4. Buka MetaMask → Settings → Networks → Add Network
   - Network Name: (bebas)
   - RPC URL      : http://127.0.0.1:<port>
   - Chain ID     : (sesuai konfigurasi)
5. Ganti ke network baru di MetaMask
6. Setiap transaksi dari DApp → bot otomatis sign & kirim! ✅
```

---

## 🦊 Browser Extension

Bot ini dilengkapi **dua versi browser extension** untuk kemudahan integrasi dengan DApp:

### Chrome Extension (Manifest V3)
> Lokasi: `fa-starx-extension-v4/`

```
Versi    : 4.0.0
Support  : Chrome, Brave, Edge (Chromium)
```

### Firefox Extension
> Lokasi: `fastarx-firefox extension/`

```
Support  : Firefox, Firefox ESR
```

### Cara Install Extension

**Chrome:**
1. Buka `chrome://extensions/`
2. Aktifkan **Developer Mode**
3. Klik **Load unpacked** → pilih folder `fa-starx-extension-v4/`

**Firefox:**
1. Buka `about:debugging`
2. Klik **This Firefox** → **Load Temporary Add-on**
3. Pilih file `manifest.json` dari folder `fastarx-firefox extension/`

> 💡 Extension otomatis menginject provider Ethereum ke DApp dan mengarahkan request ke server RPC lokal bot.

---

## 🔒 Keamanan

### Sistem Enkripsi

| Data | Metode Enkripsi |
|------|----------------|
| File `.env` | AES-256-CBC (PBKDF2 key derivation) |
| Data Wallet | AES-256-GCM (auth tag, per-session key) |
| Pesan Morse | AES-256-CBC (Scrypt key derivation) |
| Mapping Morse | AES-256-CBC (embedded in source) |
| Password Hash | PBKDF2-SHA512 (1000 iterasi) |

### Best Practices

- ✅ Jalankan bot hanya di server yang Anda percaya
- ✅ Gunakan 2FA (Google Authenticator) untuk keamanan ekstra
- ✅ Aktifkan **DApp Approval Mode** untuk mencegah koneksi tidak dikenal
- ✅ Backup file `data/` secara berkala
- ❌ Jangan bagikan file `.env` atau folder `data/`
- ❌ Jangan expose port RPC Inject ke internet tanpa firewall

---

## 📁 Struktur Direktori `data/`

Data per-sesi disimpan di folder `data/` dengan format:

```
data/
├── <session_id>_wallets.enc        ← Wallet terenkripsi (AES-256-GCM)
├── <session_id>_rpc-config.json    ← Konfigurasi RPC & DApp
├── <session_id>_rpc-ports.json     ← Konfigurasi port RPC Inject
├── <session_id>_master.key         ← Kunci enkripsi session (RAHASIA!)
└── 2fa_*.json                      ← Data Google Authenticator
```

> 🔐 File `*.enc` dan `*.key` tidak dapat dibaca tanpa kunci enkripsi yang sesuai.

---

<div align="center">

**Dibuat dengan ❤️ oleh FA STARX**

*Gunakan dengan bijak dan bertanggung jawab.*

</div>
