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

**Multi-Chain Auto-Transaction Bot** untuk EVM, Solana, Aptos, Sui, TON, dan NEAR dengan WalletConnect, Extension Inject, serta kendali penuh via Telegram

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
- [⚙️ Konfigurasi & Lisensi](#️-konfigurasi--lisensi)
- [▶️ Menjalankan Bot](#️-menjalankan-bot)
- [📱 Panduan Penggunaan Telegram](#-panduan-penggunaan-telegram)
- [🎛️ Manajemen & Lisensi (Sisi Admin)](#️-manajemen--lisensi-sisi-admin)
- [🦊 Browser Extension](#-browser-extension)
- [🔒 Keamanan](#-keamanan)
- [📁 Struktur Direktori](#-struktur-direktori)

---

## ✨ Fitur Utama

### 🔗 Koneksi & Transaksi

| Fitur | Deskripsi |
|-------|-----------|
| **Multi-Chain Support** | Dukungan penuh jaringan EVM (Ethereum, BSC, Polygon, dll.) & Non-EVM (Solana, Aptos, Sui, TON, NEAR) |
| **WalletConnect v2** | Auto-approve transaksi dari DApp via protokol WalletConnect |
| **Extension Inject** | Server kustom yang menjadi perantara transaksi dari browser extension |
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
| **Cek Balance** | Pantau saldo koin native (ETH, SOL, APT, SUI, TON, NEAR) secara real-time |
| **Statistik Transaksi** | Lihat total transaksi dan riwayat dari blockchain |

### 🌐 Manajemen RPC & Gas

| Fitur | Deskripsi |
|-------|-----------|
| **Multi-RPC Manager** | Simpan, pilih, dan hapus konfigurasi RPC (EVM, Solana, Aptos, Sui, TON, NEAR) dengan mudah |
| **Gas Mode: Auto** | Gas price otomatis dari estimasi jaringan |
| **Gas Mode: Manual** | Paksa nilai Gas (Gwei) tertentu untuk setiap transaksi |
| **Gas Mode: Aggressive** | Boost gas price dengan persentase tertentu untuk prioritas tinggi |
| **Manual RPC Input Only** | Tidak ada RPC bawaan/default. Pengguna wajib memasukkan RPC secara manual melalui menu bot demi privasi dan keamanan. |

### 🔐 Keamanan Berlapis

| Fitur | Deskripsi |
|-------|-----------|
| **Two-Factor Auth (2FA)** | Google Authenticator (TOTP RFC 6238) untuk proteksi setup, login, dan persetujuan perubahan kode/konfigurasi |
| **Dual Password System** | Password terpisah untuk akses Administrator dan Script |
| **Proteksi Folder .data/** | Deteksi otomatis jika folder tersembunyi .data/ dihapus, bot memblokir startup dan meminta verifikasi OTP untuk memulihkan folder |
| **RAM-Cached Localization** | Sistem terjemahan multibahasa (ID/EN) instan yang dioptimalkan dengan memori RAM cache untuk menghindari kelambatan/delay dekripsi disk |
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
# 1. Clone atau download project dari GitHub
git clone https://github.com/ferystarx123x/fastarx-bot.git
cd fastarx-bot

# 2. Install semua dependensi
npm install

# 3. Jalankan bot (Wizard Registrasi muncul otomatis saat pertama kali)
node main.js
```

Saat **pertama kali** dijalankan, bot menampilkan **Wizard Registrasi**. Cukup isi 4 data berikut:

| Data | Contoh | Keterangan |
|------|--------|------------|
| **URL VPS Controller** | `wss://123.45.67.89:4433` | Diberikan oleh admin/penyedia bot |
| **Nama Anda** | `Budi` | Nama bebas untuk identitas akun |
| **Token Bot Telegram** | `123456:ABC-DEF...` | Dari [@BotFather](https://t.me/BotFather) |
| **Chat ID Telegram** | `987654321` | Chat ID Telegram Anda (angka) |

Setelah registrasi berhasil, konfigurasi tersimpan otomatis. Menjalankan `node main.js` berikutnya langsung terhubung tanpa perlu isi ulang.

### Dependensi

| Package | Versi | Fungsi |
|---------|-------|--------|
| `ethers` | ^6.16.0 | Interaksi blockchain Ethereum / EVM |
| `@solana/web3.js` | ^1.98.4 | Interaksi blockchain Solana |
| `@aptos-labs/ts-sdk` | ^7.2.0 | Interaksi blockchain Aptos |
| `@mysten/sui` | ^2.20.1 | Interaksi blockchain Sui |
| `@ton/ton` | ^16.3.0 | Interaksi blockchain TON |
| `@ton/crypto` | ^3.3.0 | Cryptography helper untuk TON |
| `near-api-js` | ^7.2.0 | Interaksi blockchain NEAR |
| `@walletconnect/sign-client` | ^2.23.8 | Protokol WalletConnect v2 |
| `node-telegram-bot-api` | ^0.64.0 | Telegram Bot API |
| `dotenv` | ^16.0.0 | Load konfigurasi .env |
| `node-os-utils` | ^2.0.1 | Monitoring resource sistem |
| `systeminformation` | ^5.31.4 | Info hardware & OS |

---

## ⚙️ Konfigurasi & Lisensi

Berbeda dengan versi lama, bot **tidak lagi menyimpan konfigurasi sensitif secara lokal**. Seluruh konfigurasi (token, keamanan, dll) dikelola terpusat di **Server Controller (VPS)** dan dikirim ke bot Anda setelah registrasi berhasil.

### Cara Kerja

```
1. Bot pertama kali dijalankan  →  Wizard Registrasi (lihat Instalasi)
2. Data registrasi dikirim ke   →  VPS Controller
3. VPS memverifikasi & menyimpan akun Anda
4. Setiap startup, bot mengambil konfigurasi terenkripsi dari VPS
5. Bot berjalan sesuai izin/lisensi yang diberikan admin
```

### File Konfigurasi Lokal

Setelah registrasi, hanya satu file kecil yang tersimpan di sisi Anda:

```
.data/client-config.json   ← ID klien & URL VPS (BUKAN data sensitif)
```

> 🔐 Token bot & data keamanan **tidak** disimpan di komputer Anda — dikirim langsung dari VPS saat runtime, lalu diproses di memori.

> ⚠️ **JANGAN bagikan folder `.data/` ke siapapun!**

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
3. Masukkan password:
   * **Password Admin Bawaan (Default)**: `0xfastarx`
   * Masukkan password tersebut untuk login pertama kali, atau gunakan **Google Authenticator** jika 2FA sudah aktif.

### Menu Utama

```
💼 Wallet Management    →  Kelola wallet (import, generate, backup, hapus)
🌐 RPC Management       →  Kelola konfigurasi RPC & gas
🔗 WalletConnect        →  Connect ke DApp via WalletConnect
🦊 Extension Inject     →  Kelola server Extension Inject
📂 Menu Lainnya         →  Transfer Bot, Morse Cipher, Tracking Bot (Mainnet), dll
⚙️ Pengaturan           →  DApp Approval, ganti password, dll
```

### Perintah Telegram

| Perintah | Fungsi |
|----------|--------|
| `/start` | Mulai bot & login |
| `/menu` | Tampilkan menu utama |
| `/status` | Status bot & koneksi saat ini |

### Alur Extension Inject

```
1. Buka menu 🦊 Extension Inject di Telegram
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

## 🎛️ Manajemen & Lisensi (Sisi Admin)

Bot ini dikelola secara terpusat oleh **admin/penyedia** melalui **Server Controller** yang berjalan di VPS. Sebagai pengguna, Anda **tidak perlu** menjalankan atau mengelola bagian ini — semuanya berjalan otomatis setelah registrasi.

### Yang Dikelola Admin

| Fitur | Deskripsi |
|-------|-----------|
| **Aktivasi Akun** | Admin mengaktifkan akun Anda setelah registrasi berhasil |
| **Masa Aktif Lisensi** | Admin mengatur masa berlaku penggunaan bot Anda |
| **Kontrol Real-Time** | Admin dapat mengaktifkan/menonaktifkan akses bot Anda kapan saja via Telegram |
| **Distribusi Konfigurasi** | Token & konfigurasi keamanan dikirim otomatis dari VPS ke bot Anda |

### Jika Bot Tidak Bisa Terhubung

```
1. Pastikan koneksi internet Anda aktif
2. Pastikan URL VPS Controller yang dimasukkan benar (wss://IP:PORT)
3. Hubungi admin/penyedia untuk memastikan:
   - Lisensi/akun Anda masih aktif
   - Server Controller sedang berjalan
```

> 💡 Bot hanya berjalan selama Server Controller aktif dan lisensi Anda diizinkan oleh admin.

---

## 🦊 Browser Extension

Bot ini dilengkapi **tiga versi browser extension** untuk kemudahan integrasi dengan DApp:

### Chrome Extension (Manifest V3)
> Lokasi: `extension bot metamaks/`
```
Versi    : 4.0.0
Support  : Chrome, Brave, Edge (Chromium)
```

### Bitget Wallet Extension (Manifest V3)
> Lokasi: `extension bot bitget/`
```
Versi    : 1.0.0
Support  : Chrome, Brave, Edge (Chromium)
Deskripsi: Ekstensi khusus yang menyamar sebagai Bitget Wallet untuk menyalurkan request DApp secara aman ke server Extension Inject lokal.
```

### Firefox Extension
> Lokasi: `fastarx-firefox extension/`
```
Support  : Firefox, Firefox ESR
```

### Cara Install Extension

**Chrome / Bitget Extension:**
1. Buka `chrome://extensions/`
2. Aktifkan **Developer Mode**
3. Klik **Load unpacked** → pilih folder extension yang diinginkan (`extension bot metamaks/` atau `extension bot bitget/`)

**Firefox:**
1. Buka `about:debugging`
2. Klik **This Firefox** → **Load Temporary Add-on**
3. Pilih file `manifest.json` dari folder `fastarx-firefox extension/`

> 💡 Extension otomatis menginject provider Ethereum ke DApp dan mengarahkan request ke server RPC lokal bot.

---

## 🔒 Keamanan

### 🛡️ Sistem Integrity Guard (Self-Defeating Code)
Untuk mencegah AI atau pihak tidak berwenang memodifikasi basis kode bot secara diam-diam, sistem dilengkapi dengan **Integrity Guard** tingkat tinggi:

* **Live Hash Project Binding**: Kunci dekripsi untuk `.env` tidak lagi disimpan statis, melainkan diturunkan secara dinamis menggunakan gabungan master key dan **SHA-256 live hash** dari seluruh berkas kode sumber (`bot/`, `utils/`, `core/`, `transfer/`, `config/`, `modes/`, `auth/`, `rpc/`, `main.js`, `package.json`, `package-lock.json`, serta file marker pertahanan ganda).
* **Self-Defeating (Auto-Brick)**: Jika kode sumber dimodifikasi sedikit saja (bahkan 1 karakter spasi pun), kunci dekripsi `.env` akan berubah secara matematis, mengakibatkan dekripsi konfigurasi gagal (`bad decrypt`), dan bot otomatis mengunci diri sebelum script berbahaya sempat dieksekusi.
* **Verifikasi OTP via Telegram**: Setiap ada perubahan kode/konfigurasi, Bot Utama menghubungi **Bot Saklar** secara lokal (HTTP port 3099). Bot Saklar mengirim notifikasi ke Telegram Admin dengan pesan yang **berbeda dan kontekstual** — pesan berbeda untuk perubahan konfigurasi `.env` vs modifikasi file kode program. Admin cukup memasukkan OTP 6 digit di Telegram, tanpa perlu akses terminal/SSH.
* **Fallback CLI**: Jika Bot Saklar tidak aktif saat startup, sistem otomatis fallback ke input OTP/password via terminal.
* **Auto-Recovery**: Jika file kunci integritas `.integrity.lock` hilang atau dirusak secara paksa, bot akan masuk ke mode pemulihan (recovery) dan meminta Password Admin untuk memulihkan database dari cadangan aman `.system-integrity-check`.
* **Proteksi Folder .data/**: Jika folder tersembunyi `.data/` hilang atau sengaja dihapus, bot akan memblokir startup dan meminta verifikasi OTP sebelum memulihkan folder data kosong secara aman untuk mencegah bypass atau kehilangan kunci enkripsi sesi.

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
- ✅ Backup file `.data/` secara berkala
- ❌ Jangan pernah membagikan file `.env`, folder `.data/`, atau berkas marker keamanan bertitik (`.*`)
- ❌ Jangan expose port Extension Inject ke internet tanpa firewall

---

## 📁 Struktur Direktori `.data/`

Data per-sesi disimpan di folder tersembunyi `.data/` dengan format:

```
.data/
├── <session_id>_wallets.enc        ← Wallet terenkripsi (AES-256-GCM)
├── <session_id>_rpc-config.json    ← Konfigurasi RPC & DApp
├── <session_id>_rpc-ports.json     ← Konfigurasi port Extension Inject
├── <session_id>_master.key         ← Kunci enkripsi session (RAHASIA!)
├── <chat_id>_tracked_wallets.json  ← Daftar wallet pemantauan tracker
├── <chat_id>_tracker_state.json     ← Status aktif & cursor filter tracker
├── <chat_id>_tracker_history.json   ← Riwayat notifikasi transaksi tracker
└── .2fa_config.enc                 ← Konfigurasi 2FA terenkripsi
```

> 🔐 File `*.enc` dan `*.key` tidak dapat dibaca tanpa kunci enkripsi yang sesuai.

---

<div align="center">

**Dibuat dengan ❤️ oleh FA STARX**

*Gunakan dengan bijak dan bertanggung jawab.*

</div>
