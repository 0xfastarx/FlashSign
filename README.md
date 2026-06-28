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
- [📦 Instalasi](#-instalasi)
- [⚙️ Konfigurasi](#️-konfigurasi)
- [▶️ Menjalankan Bot](#️-menjalankan-bot)
- [📱 Panduan Penggunaan Telegram](#-panduan-penggunaan-telegram)
- [🎛️ Bot Saklar (Controller)](#️-bot-saklar-controller)
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
| **Manual RPC Input Only** | Tidak ada RPC bawaan/default. Pengguna wajib memasukkan RPC secara manual melalui menu bot demi privasi dan keamanan. |

### 🔐 Keamanan Berlapis

| Fitur | Deskripsi |
|-------|-----------|
| **Two-Factor Auth (2FA)** | Google Authenticator (TOTP RFC 6238) untuk proteksi setup, login, dan persetujuan perubahan kode/konfigurasi |
| **Dual Password System** | Password terpisah untuk akses Administrator dan Script |
| **Proteksi Folder data/** | Deteksi otomatis jika folder data/ dihapus, bot memblokir startup dan meminta verifikasi OTP untuk memulihkan folder |
| **Enkripsi AES-256-GCM** | Semua data wallet dienkripsi dengan standar militer |
| **Enkripsi .env** | Seluruh nilai konfigurasi di `.env` dienkripsi (bukan plaintext) |
| **Whitelist Chat ID** | Hanya Telegram ID yang terdaftar yang bisa mengakses bot |
| **Sesi Terpisah** | Setiap pengguna mendapat session terenkripsi yang terisolasi |
| **OTP Login** | Opsi masuk via kode 6-digit Google Authenticator tanpa mengetik password |
| **Grace Period 2FA** | Periode tenggang 7 hari jika password diubah setelah 2FA dipasang |
| **OTP Startup via Telegram** | Saat ada perubahan file/konfigurasi, OTP diminta langsung via Bot Saklar di Telegram (bukan di terminal) |
| **Pesan Kontekstual** | Notifikasi Telegram membedakan antara perubahan konfigurasi (.env) dan modifikasi file kode program |

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
| **Gas-Safe Transfer** | Auto-kalkulasi biaya gas sebelum transfer agar saldo tidak habis untuk fee |

### 📊 Tracking Bot (Mainnet)

| Fitur | Deskripsi |
|-------|-----------|
| **16 Jaringan Mainnet** | Mendukung pemantauan di Ethereum, BNB Chain, Polygon, Avalanche, Fantom, Gnosis, Celo, Cronos, Arbitrum, Optimism, Base, Linea, zkSync Era, Scroll, Blast, dan Mantle |
| **Watch-Only (Read-Only)** | Memantau wallet hanya dengan alamat publik tanpa memerlukan Private Key atau Mnemonic Phrase |
| **USDT Valuation & Scam Alert** | Deteksi otomatis nilai USDT token masuk via CoinGecko/DexScreener API (menampilkan peringatan jika bernilai $0/tidak ada harga sebagai indikasi scam) |
| **Riwayat Tracking Terperinci** | Riwayat transaksi dengan 5 tombol navigasi interaktif + tombol "Lihat History Lainnya" (paginated) |
| **Filter Estimasi Nilai** | Filter notifikasi masuk berdasarkan minimum nilai estimasi dalam USDT |
| **Kontrol Fleksibel** | Nyalakan/matikan deteksi transaksi native gas token dan token ERC-20 secara independen |
| **Auto-Resume** | Polling tracker otomatis pulih dan aktif kembali secara otomatis ketika bot direstart |

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

Setup wizard akan memandu Anda mengisi **item konfigurasi manual**:

1. `GitHub Main URL` — URL source konfigurasi keamanan utama
2. `GitHub Backup URL` — URL source konfigurasi keamanan cadangan
3. `Owner Telegram ID` — Telegram ID Anda sebagai owner
4. `Password Admin` — Kata sandi akses Administrator
5. `Password Script` — Kata sandi akses Script

> ✅ Token Telegram, token controller, Admin Chat ID, dan WalletConnect ID akan dibaca secara dinamis dari file `.env` lama jika tersedia. Semua nilai akan **dienkripsi otomatis** menggunakan AES-256-CBC sebelum disimpan ke `.env`

### Struktur `.env` (Setelah Setup)

```env
# System
SYSTEM_ID=sys_id_xxxxx

# Keamanan
ADMIN_PASSWORD_ENCRYPTED="..."
SCRIPT_PASSWORD_ENCRYPTED="..."
GITHUB_MAIN_URL_ENCRYPTED="..."
GITHUB_BACKUP_URL_ENCRYPTED="..."
ENCRYPTION_SALT_ENCRYPTED="..."
SETUP_2FA_SECRET_ENCRYPTED="..."

# Telegram (Dual Bot)
TELEGRAM_BOT_TOKEN_ENCRYPTED="..."
CONTROLLER_BOT_TOKEN_ENCRYPTED="..."
ADMIN_CHAT_ID_ENCRYPTED="..."
OWNER_TELEGRAM_ID_ENCRYPTED="..."

# Kripto & RPC
WALLETCONNECT_PROJECT_ID_ENCRYPTED="..."
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
📂 Menu Lainnya         →  Transfer Bot, Morse Cipher, Tracking Bot (Mainnet), dll
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

### Alur & Panduan Tracking Bot

```
1. Buka menu 📂 Menu Lainnya → 📊 Tracking Bot
2. Tambah Wallet Pemantau:
   - Kirim alamat publik (read-only, tanpa private key/seed phrase)
   - Beri nama/label kustom
   - Pilih jaringan yang ingin dipantau (bisa pilih banyak dari 16 mainnet)
3. Set Explorer API Keys (Opsional):
   - Masuk ke menu ⚙️ Pengaturan → 🔑 Set Explorer API Keys
   - Masukkan API Key untuk BSC, Fantom, Cronos, atau Linea jika memantau jaringan tersebut
4. Nyalakan Polling:
   - Klik 🟢 Aktifkan Tracking untuk memulai pemantauan di latar belakang (tiap 45 detik)
5. Notifikasi & Riwayat:
   - Setiap ada transfer masuk akan dikirim detail nominal & nilai USDT estimasinya
   - Klik 📜 History Tracking untuk melihat riwayat transaksi masuk paginated (5 item per halaman)
```

---

## 🎛️ Bot Saklar (Controller)

Bot Saklar (`control.js`) adalah bot Telegram terpisah yang berfungsi sebagai **remote control** untuk mengelola Bot Utama dari jarak jauh.

### Cara Menjalankan

```bash
node control.js
```

### Fitur Bot Saklar

| Fitur | Deskripsi |
|-------|-----------|
| **Start / Stop Bot** | Nyalakan dan matikan Bot Utama & Bot Auto langsung dari Telegram |
| **Cek Status** | Pantau status aktif/nonaktif semua bot dan resource VPS secara real-time |
| **Kelola User** | Tambah, blokir, set masa aktif, dan hapus user Bot Utama |
| **⚙️ Pengaturan .env** | Edit semua variabel konfigurasi `.env` langsung dari Telegram tanpa perlu SSH |
| **Reset 2FA** | Generate secret Google Authenticator baru dan tampilkan QR Code via Telegram |
| **OTP Gateway** | Menerima dan memverifikasi kode OTP dari Admin saat Bot Utama membutuhkan persetujuan startup |

### Menu Pengaturan .env

Melalui menu **⚙️ Pengaturan .env**, Anda dapat mengubah:

```
🌐 GitHub Main URL        →  URL source konfigurasi utama (disensor, hanya nama file)
🌐 GitHub Backup URL      →  URL source konfigurasi cadangan (disensor)
👤 Owner Telegram ID      →  Telegram ID pemilik bot
🆔 Admin Chat ID          →  Chat ID admin Bot Saklar
🤖 Token Bot Utama        →  Token Telegram Bot Utama
🔌 Token Controller       →  Token Telegram Bot Saklar
🔑 Password Admin         →  Password akses Administrator
🔑 Password Script        →  Password akses Script
🔄 Reset 2FA              →  Buat ulang secret Google Authenticator
```

> 🔒 Semua nilai baru langsung dienkripsi dengan AES-256-CBC sebelum disimpan ke `.env`.

### Alur Verifikasi OTP Startup

Ketika Bot Utama dijalankan setelah ada perubahan file/konfigurasi:

```
1. Bot Utama (main.js) mendeteksi perubahan
2. Mengirim request ke Bot Saklar (port 3099)
3. Bot Saklar mengirim notifikasi ke Telegram Admin:
   - ⚙️ Pesan khusus jika perubahan KONFIGURASI (.env)
   - 🚨 Pesan peringatan jika perubahan FILE KODE PROGRAM
4. Admin memasukkan 6-digit OTP via chat Telegram
5. Bot Saklar memverifikasi OTP dan membalas ke Bot Utama
6. Bot Utama disetujui → startup dilanjutkan ✅
   (Jika OTP salah/timeout → Bot Utama berhenti otomatis)
```

> 💡 Jika Bot Saklar sedang offline, Bot Utama otomatis fallback ke input OTP via terminal.

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

### 🛡️ Sistem Integrity Guard (Self-Defeating Code)
Untuk mencegah AI atau pihak tidak berwenang memodifikasi basis kode bot secara diam-diam, sistem dilengkapi dengan **Integrity Guard** tingkat tinggi:

* **Live Hash Project Binding**: Kunci dekripsi untuk `.env` tidak lagi disimpan statis, melainkan diturunkan secara dinamis menggunakan gabungan master key dan **SHA-256 live hash** dari seluruh berkas kode sumber (`bot/`, `utils/`, `core/`, `transfer/`, `config/`, `modes/`, `auth/`, `rpc/`, `main.js`, `control.js`, `setup.js`, `package.json`, `package-lock.json`, serta file marker pertahanan ganda).
* **Self-Defeating (Auto-Brick)**: Jika kode sumber dimodifikasi sedikit saja (bahkan 1 karakter spasi pun), kunci dekripsi `.env` akan berubah secara matematis, mengakibatkan dekripsi konfigurasi gagal (`bad decrypt`), dan bot otomatis mengunci diri sebelum script berbahaya sempat dieksekusi.
* **Verifikasi OTP via Telegram**: Setiap ada perubahan kode/konfigurasi, Bot Utama menghubungi **Bot Saklar** secara lokal (HTTP port 3099). Bot Saklar mengirim notifikasi ke Telegram Admin dengan pesan yang **berbeda dan kontekstual** — pesan berbeda untuk perubahan konfigurasi `.env` vs modifikasi file kode program. Admin cukup memasukkan OTP 6 digit di Telegram, tanpa perlu akses terminal/SSH.
* **Fallback CLI**: Jika Bot Saklar tidak aktif saat startup, sistem otomatis fallback ke input OTP/password via terminal.
* **Auto-Recovery**: Jika file kunci integritas `.integrity.lock` hilang atau dirusak secara paksa, bot akan masuk ke mode pemulihan (recovery) dan meminta Password Admin untuk memulihkan database dari cadangan aman `.system-integrity-check`.
* **Proteksi Folder data/**: Jika folder `data/` hilang atau sengaja dihapus, bot akan memblokir startup dan meminta verifikasi OTP sebelum memulihkan folder data kosong secara aman untuk mencegah bypass atau kehilangan kunci enkripsi sesi.

### Sistem Enkripsi

| Data | Metode Enkripsi |
|------|----------------|
| File `.env` | AES-256-CBC (PBKDF2 key dinamis terikat Live Hash Proyek) |
| Data Wallet | AES-256-GCM (auth tag, per-session key) |
| File Pertahanan Ganda | AES-256-GCM (PBKDF2 master key 100K iterasi) |
| Pesan Morse | AES-256-CBC (Scrypt key derivation) |
| Mapping Morse | AES-256-CBC (embedded in source) |
| Password Hash | PBKDF2-SHA512 (1000 iterasi) |

### Best Practices

- ✅ Jalankan bot hanya di server yang Anda percaya
- ✅ Gunakan 2FA (Google Authenticator) untuk keamanan ekstra
- ✅ Aktifkan **DApp Approval Mode** untuk mencegah koneksi tidak dikenal
- ✅ Backup file `data/` secara berkala
- ❌ Jangan pernah membagikan file `.env`, folder `data/`, atau berkas marker keamanan bertitik (`.*`)
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
├── <chat_id>_tracked_wallets.json  ← Daftar wallet pemantauan tracker
├── <chat_id>_tracker_state.json     ← Status aktif & cursor filter tracker
├── <chat_id>_tracker_history.json   ← Riwayat notifikasi transaksi tracker
└── 2fa_*.json                      ← Data Google Authenticator
```

> 🔐 File `*.enc` dan `*.key` tidak dapat dibaca tanpa kunci enkripsi yang sesuai.

---

<div align="center">

**Dibuat dengan ❤️ oleh FA STARX**

*Gunakan dengan bijak dan bertanggung jawab.*

</div>
