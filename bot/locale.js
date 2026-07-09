'use strict';

const WORD_MAP = {
    // 2FA & Login
    "Anda harus login. Kirim /start": "You must log in. Send /start",
    "Sesi Anda tidak ditemukan. Silakan /start untuk login.": "Your session was not found. Please send /start to log in.",
    "Sesi Anda error. Silakan /start ulang.": "Your session has an error. Please restart /start.",
    "❌ Sesi tidak ditemukan. Silakan /start ulang.": "❌ Session not found. Please restart /start.",
    "❌ Sesi berakhir. /start ulang.": "❌ Session ended. Please restart /start.",
    "Sesi tidak ditemukan. Silakan /start ulang.": "Session not found. Please restart /start.",
    "Welcome, Administrator!": "Welcome, Administrator!",
    "Welcome, User!": "Welcome, User!",
    "👑 Anda login sebagai Owner.": "👑 You are logged in as Owner.",
    "📜 Anda login sebagai Script.": "📜 You are logged in as Script.",
    "Pilihan metode login (password vs OTP) saat 2FA aktif": "Login method choice (password vs OTP) when 2FA is active",
    "Pilih menu di bawah:": "Select a menu below:",
    "Pilih menu:": "Select a menu:",

    // Main Keyboard Menu (physical reply keyboard)
    "💼 Wallet Management": "💼 Wallet Management",
    "🦊 Extension Inject": "🦊 Extension Inject",
    "🔗 WalletConnect": "🔗 WalletConnect",
    "🌐 RPC Management": "🌐 RPC Management",
    "📂 Menu Lainnya": "📂 More Menus",
    "⚙️ Pengaturan": "⚙️ Settings",

    // Sub-menu Titles & Headers
    "💼 WALLET MANAGEMENT:": "💼 WALLET MANAGEMENT:",
    "🌐 RPC MANAGEMENT:": "🌐 RPC MANAGEMENT:",
    "🔗 WALLETCONNECT": "🔗 WALLETCONNECT",
    "🦊 *EXTENSION INJECT — PORT MANAGER*": "🦊 *EXTENSION INJECT — PORT MANAGER*",
    "⚙️ *PENGATURAN*": "⚙️ *SETTINGS*",
    "📂 *MENU LAINNYA*": "📂 *MORE MENUS*",
    "💸 *TRANSFER BOT*": "💸 *TRANSFER BOT*",
    "💸 *TRANSFER MANUAL*": "💸 *MANUAL TRANSFER*",
    "📊 *TRACKING BOT*": "📊 *TRACKING BOT*",
    "🔐 *MORSE CIPHER TOOL*": "🔐 *MORSE CIPHER TOOL*",
    "📦 *MIGRASI / BACKUP DATA*": "📦 *DATA MIGRATION / BACKUP*",

    // Wallet Management Texts & Buttons
    "Total Wallet:": "Total Wallets:",
    "Pilih aksi:": "Select action:",
    "🌱 Import (Mnemonic)": "🌱 Import (Mnemonic)",
    "📥 Import (Private Key)": "📥 Import (Private Key)",
    "🌱 Impor (Mnemonic)": "🌱 Import (Mnemonic)",
    "📥 Impor (Private Key)": "📥 Import (Private Key)",
    "➕ Generate Wallet Baru": "➕ Generate New Wallet",
    "📥 Impor Wallet (Private Key/Mnemonic)": "📥 Import Wallet (Private Key/Mnemonic)",
    "📋 Lihat Daftar Wallet & Balance": "📋 View Wallet List & Balance",
    "🔑 Tampilkan Private Key": "🔑 Show Private Key",
    "📝 Ganti Nama/Label Wallet": "📝 Rename/Label Wallet",
    "❌ Hapus Wallet": "❌ Delete Wallet",
    "💾 Backup Phrase": "💾 Backup Phrase",
    "📋 List/Pilih Wallet": "📋 List/Select Wallet",
    "🗑️ Hapus Wallet": "🗑️ Delete Wallet",
    "🌐 Kelola DApps": "🌐 Manage DApps",
    "💰 Cek Balance": "💰 Check Balance",
    "🔄 Ganti/Pilih Wallet": "🔄 Change/Select Wallet",
    "❌ Wallet belum setup!": "❌ Wallet has not been set up!",
    "❌ Belum ada wallet aktif. Silakan pilih wallet dulu.": "❌ No active wallet. Please select a wallet first.",
    "❌ Pilih wallet aktif dulu sebelum start RPC server.": "❌ Please select an active wallet first before starting the RPC server.",
    "Wallet berhasil diimpor": "Wallet successfully imported",
    "Wallet berhasil dihapus": "Wallet successfully deleted",
    "Generate Wallet": "Generate Wallet",
    "List/Pilih Wallet": "List/Select Wallet",
    "Cek Balance": "Check Balance",
    "Kelola DApps": "Manage DApps",
    "Ganti/Pilih Wallet": "Change/Select Wallet",

    // RPC Management Texts & Buttons
    "RPC Aktif:": "Active RPC:",
    "Chain ID:": "Chain ID:",
    "Status: 🟢 ONLINE": "Status: 🟢 ONLINE",
    "Status: 🔴 OFFLINE": "Status: 🔴 OFFLINE",
    "📡 Pilih RPC": "📡 Select RPC",
    "➕ Tambah RPC": "➕ Add RPC",
    "✏️ Edit RPC": "✏️ Edit RPC",
    "🗑️ Hapus RPC": "🗑️ Delete RPC",
    "⛽ Atur Gas": "⛽ Manage Gas",
    "ℹ️ Info RPC": "ℹ️ RPC Info",
    "Auto-Save: ON": "Auto-Save: ON",
    "Auto-Save: OFF": "Auto-Save: OFF",
    "➕ Tambah RPC Baru": "➕ Add New RPC",
    "⚙️ Set Aktif RPC": "⚙️ Set Active RPC",
    "❌ Hapus RPC": "❌ Delete RPC",
    "Tidak ada RPC tersimpan.": "No saved RPCs.",
    "⛽ PILIH RPC UNTUK DIEDIT GAS-NYA:": "⛽ SELECT RPC TO EDIT ITS GAS CONFIGURATION:",
    "Halaman": "Page",

    // WalletConnect Texts & Buttons
    "Status: 🔴 TIDAK TERHUBUNG": "Status: 🔴 NOT CONNECTED",
    "Status: 🟢 TERHUBUNG": "Status: 🟢 CONNECTED",
    "Belum ada wallet aktif": "No active wallet yet",
    "Aktif:": "Active:",
    "Delay Aktif:": "Active Delay:",
    "Detik": "Seconds",
    "Delay: OFF (Instan)": "Delay: OFF (Instant)",
    "⏱️ Set Delay": "⏱️ Set Delay",
    "🔌 Disconnect": "🔌 Disconnect",
    "🔗 Connect WC": "🔗 Connect WC",
    "🔄 Status": "🔄 Status",
    "TIDAK TERHUBUNG": "NOT CONNECTED",
    "TERHUBUNG": "CONNECTED",

    // RPC Inject & Ports Texts & Buttons
    "Tidak ada server aktif": "No active server",
    "Daftar Port:": "Port List:",
    "Tiap port bisa diset Localhost atau VPS mode secara independen.": "Each port can be set to Localhost or VPS mode independently.",
    "(Dipakai User Lain)": "(Used by Other User)",
    "Dipakai User Lain": "Used by Other User",
    "Start 6060": "Start 6060",
    "Start 8545": "Start 8545",
    "Start 8546": "Start 8546",
    "→ Localhost (6060)": "→ Localhost (6060)",
    "→ VPS (8545)": "→ VPS (8545)",
    "→ Localhost (8546)": "→ Localhost (8546)",
    "💻 → Localhost": "💻 → Localhost",
    "🌐 → VPS": "🌐 → VPS",
    "➕ Tambah Port Custom": "➕ Add Custom Port",
    "🗑️ Hapus Port Custom": "🗑️ Delete Custom Port",
    "📦 Download Extension": "📦 Download Extension",
    "📦 *DOWNLOAD BROWSER EXTENSION*\n\nSilakan pilih ekstensi yang ingin Anda unduh:": "📦 *DOWNLOAD BROWSER EXTENSION*\n\nPlease select the extension you want to download:",
    "🦊 MetaMask / Chrome Extension": "🦊 MetaMask / Chrome Extension",
    "💳 Bitget Extension": "💳 Bitget Extension",
    "🦊 Firefox Extension": "🦊 Firefox Extension",
    "⏳ Sedang mengompres ekstensi, harap tunggu...": "⏳ Compressing extension, please wait...",
    "❌ Gagal mengompres ekstensi:": "❌ Failed to compress extension:",
    "❌ File ekstensi tidak ditemukan.": "❌ Extension file not found.",
    "✅ Ekstensi berhasil dikirim!": "✅ Extension successfully sent!",
    "AKTIF — port": "ACTIVE — port",

    // Settings (Pengaturan)
    "👑 Owner Mode": "👑 Owner Mode",
    "📊 Info & Status": "📊 Info & Status",
    "🔐 Kelola 2FA": "🔐 Manage 2FA",
    "🔑 Ubah Sandi": "🔑 Change Password",
    "📦 Migrasi/Backup Data": "📦 Data Migration/Backup",
    "🚪 Logout": "🚪 Logout",
    "🔙 Main Menu": "🔙 Main Menu",
    "🔙 Kembali": "🔙 Back",
    "❌ Batal": "❌ Cancel",
    "Konfirmasi": "Confirm",
    "Bahasa": "Language",

    // More Menus (Menu Lainnya)
    "Pilih fitur yang ingin digunakan:": "Select the feature you want to use:",
    "💸 Transfer Bot": "💸 Transfer Bot",
    "💸 Transfer Manual": "💸 Manual Transfer",
    "🔐 Morse Cipher Tool": "🔐 Morse Cipher Tool",
    "📊 Tracking Bot": "📊 Tracking Bot",

    // Transfer Bot Texts & Buttons
    "Ada transfer yang sedang berjalan.": "There is an active transfer running.",
    "Wallet diambil dari *Wallet Management*.": "Wallet is retrieved from *Wallet Management*.",
    "Pilih mode transfer:": "Select transfer mode:",
    "🪙 ETH Auto-Forward": "🪙 ETH Auto-Forward",
    "🪙 Token Auto-Forward": "🪙 Token Auto-Forward",
    "🪙 Token Transfer Once": "🪙 Token Transfer Once",
    "🎯 Auto Token Detection": "🎯 Auto Token Detection",
    "🛑 Stop Transfer Aktif": "🛑 Stop Active Transfer",

    // Transfer Manual
    "➕ Tambah RPC Manual": "➕ Add Manual RPC",
    "⚙️ Set RPC Aktif": "⚙️ Set Active RPC",
    "➕ Tambah Token Manual": "➕ Add Manual Token",
    "📋 Daftar Token Manual": "📋 List Manual Tokens",
    "💸 Kirim Transaksi": "💸 Send Transaction",
    "🌐 Jaringan Lain nya": "🌐 Other Networks",
    "💸 *TRANSFER MANUAL — PILIH JARINGAN*": "💸 *MANUAL TRANSFER — SELECT NETWORK*",
    "Silakan pilih jaringan untuk transfer manual Anda:": "Please select a network for your manual transfer:",
    "🔑 *EXPLORER API KEYS (MANUAL TRANSFER)*": "🔑 *EXPLORER API KEYS (MANUAL TRANSFER)*",
    "API Key ini disimpan secara terenkripsi di folder \`.data/\` untuk mengambil riwayat transaksi Anda secara aman.": "This API Key is stored encrypted in the \`.data/\` folder to securely retrieve your transaction history.",
    "Pilih salah satu tombol di bawah untuk mengatur/mengubah kunci:": "Select one of the buttons below to set/change keys:",
    "🔄 Menghubungkan provider & memuat riwayat transaksi...": "🔄 Connecting provider & loading transaction history...",
    "ℹ️ Belum ada riwayat transaksi.": "ℹ️ No transaction history yet.",
    "🔍 Lihat Transaksi Lainnya": "🔍 View Other Transactions",
    "📊 *DASHBOARD ASET — TRANSFER MANUAL*": "📊 *ASSET DASHBOARD — MANUAL TRANSFER*",
    "🌐 Jaringan:": "🌐 Network:",
    "🪙 Aset:": "🪙 Asset:",
    "💼 Wallet:": "💼 Wallet:",
    "💰 Saldo:": "💰 Balance:",
    "🪙 Saldo Token:": "🪙 Token Balance:",
    "Gagal memuat": "Failed to load",
    "\n*4 Transaksi Terakhir:*": "\n*Last 4 Transactions:*",
    "🌐 *Jaringan Kustom (Manual Transfer)*": "🌐 *Custom Networks (Manual Transfer)*",
    "Berikut adalah daftar jaringan kustom Anda untuk transfer manual:": "Here is the list of your custom networks for manual transfer:",
    "➕ Tambah Jaringan / RPC": "➕ Add Network / RPC",
    "🔑 Setup Explorer API Keys": "🔑 Setup Explorer API Keys",

    // Morse Tool
    "🔐 *MORSE CIPHER TOOL*": "🔐 *MORSE CIPHER TOOL*",
    "Fitur ini memungkinkan Anda melakukan enkripsi dan dekripsi menggunakan sandi Morse Kustom secara aman.": "This feature allows you to securely encrypt and decrypt using Custom Morse Cipher.",
    "📁 *Dukungan File .txt:*": "📁 *.txt File Support:*",
    "Anda bisa mengunggah file \`.txt\` secara langsung untuk diproses otomatis! Bot akan memproses isinya secara aman tanpa menyimpan file di server, lalu mengirimkan hasilnya kembali berupa file \`.txt\` baru.": "You can upload a \`.txt\` file directly for automatic processing! The bot will process its content securely without saving the file on the server, then send the results back as a new \`.txt\` file.",

    // Tracking Bot
    "📊 *TRACKING BOT (MAINNET)*": "📊 *TRACKING BOT (MAINNET)*",
    "Wallet dipantau:": "Tracked wallets:",
    " wallet*": " wallet(s)*",
    "Pelacak ini memantau transaksi token masuk secara real-time pada 16 jaringan mainnet.": "This tracker monitors incoming token transactions in real-time across 16 mainnet networks.",
    "➕ Tambah Wallet": "➕ Add Wallet",
    "📋 Daftar Pantauan": "📋 Track List",
    "📜 History Tracking": "📜 Tracking History",
    "🔴 Hentikan Tracker": "🔴 Stop Tracker",
    "🟢 Aktifkan Tracker": "🟢 Start Tracker",
    "⚙️ *PENGATURAN TRACKER*": "⚙️ *TRACKER SETTINGS*",
    "Atur filter dan jenis notifikasi untuk tracking bot:": "Configure filters and notification types for tracking bot:",
    "✏️ *PILIH MINIMUM ESTIMASI NILAI USDT*": "✏️ *SELECT MINIMUM ESTIMATED USDT VALUE*",
    "Filter Min Value:": "Filter Min Value:",
    "Native Alerts:": "Native Alerts:",
    "ERC20 Alerts:": "ERC20 Alerts:",
    "Input Manual": "Manual Input",
    "(Semua)": "(All)",
    "📋 *DAFTAR PANTAUAN*": "📋 *TRACK LIST*",
    "Belum ada wallet yang dipantau.": "No wallets monitored yet.",

    // Migration
    "📦 *MIGRASI / BACKUP DATA*": "📦 *DATA MIGRATION / BACKUP*",
    "Fitur ini memungkinkan Anda mencadangkan seluruh data (Wallet, RPC, Port, dan Morse) ke dalam satu file terenkripsi yang dikirim langsung ke Telegram Anda.": "This feature allows you to back up all data (Wallet, RPC, Port, and Morse) into a single encrypted file sent directly to your Telegram.",
    "• *Backup*: Membuat file cadangan terenkripsi password.": "• *Backup*: Create a password-encrypted backup file.",
    "• *Impor*: Memulihkan data dari file cadangan yang diunggah.": "• *Import*: Restore data from the uploaded backup file.",
    "• *Backup*:": "• *Backup*:",
    "• *Impor*:": "• *Import*:",
    "Membuat file cadangan terenkripsi password.": "Create a password-encrypted backup file.",
    "Memulihkan data dari file cadangan yang diunggah.": "Restore data from the uploaded backup file.",

    // Info Menu
    "📊 *INFO & STATUS*": "📊 *INFO & STATUS*",
    "🔐 *STATUS GOOGLE AUTHENTICATOR*": "🔐 *GOOGLE AUTHENTICATOR STATUS*",
    "🤖 Status Bot": "🤖 Bot Status",
    "ℹ️ Info RPC": "ℹ️ RPC Info",
    "🔄 Mengecek balance...": "🔄 Checking balance...",
    "❌ Belum ada wallet yang dipilih.": "❌ No wallet selected.",

    // 2FA status detail translations
    "Belum dipasang": "Not set up",
    "HANGUS": "EXPIRED",
    "Password diubah": "Password changed",
    "Grace period sudah >7 hari. Setup ulang dengan password baru.": "Grace period >7 days. Re-setup with new password.",
    "Hangus pada": "Expires on",
    "Sisa masa aktif": "Remaining time",
    "Dipasang": "Set up on",
    "Login bisa pakai Password atau OTP": "Can login using Password or OTP",
    "hari": "days",
    "jam": "hours",
    "menit": "minutes",
    "detik": "seconds",

    // 2FA & Login Screen Translations
    "» Masukkan password:": "» Enter password:",
    "Masukkan kode 6-digit dari Google Authenticator:": "Enter the 6-digit code from Google Authenticator:",
    "SETUP GOOGLE AUTHENTICATOR (OPSIONAL)": "SETUP GOOGLE AUTHENTICATOR (OPTIONAL)",
    "Anda belum memasang 2FA untuk level": "You have not set up 2FA for level",
    "hanya terikat ke password": "only bound to password",
    "Jika password diubah, 2FA lama": "If password is changed, old 2FA",
    "Ketik *ya* untuk setup sekarang, atau *tidak* untuk skip.": "Type *yes* to setup now, or *no* to skip.",
    "Ketik ya untuk setup sekarang, atau tidak untuk skip.": "Type yes to setup now, or no to skip.",
    "LOGIN PASSWORD": "LOGIN PASSWORD",
    "PILIH METODE LOGIN": "SELECT LOGIN METHOD",
    "Masuk dengan *Password*": "Log in with *Password*",
    "Masuk dengan *Google Authenticator (OTP)*": "Log in with *Google Authenticator (OTP)*",
    "Balas dengan *1* atau *2*:": "Reply with *1* or *2*:",
    "OTP Verified! Selamat datang": "OTP Verified! Welcome",
    "Kode OTP salah.": "Incorrect OTP code.",
    "percobaan tersisa.": "attempts remaining.",
    "Masukkan ulang:": "Enter again:",
    "OTP GAGAL": "OTP FAILED",
    "Terlalu banyak percobaan salah. Akses ditolak.": "Too many incorrect attempts. Access denied.",
    "Google Authenticator telah expired.": "Google Authenticator has expired.",
    "Password diubah sejak:": "Password changed since:",
    "Login dilanjutkan dengan password biasa.": "Login continued with normal password.",
    "2FA di-skip. Login dilanjutkan.": "2FA skipped. Login continued.",
    "2FA GAGAL — Terlalu banyak percobaan salah. Login ditolak.": "2FA FAILED — Too many incorrect attempts. Login denied.",
    "Kode salah.": "Incorrect code.",
    "Masukkan ulang, atau ketik *skip*.": "Enter again, or type *skip*.",
    "Setelah itu kirim kode 6-digit untuk verifikasi:": "After that, send the 6-digit code for verification:",
    "2FA tidak dipasang.": "2FA not installed.",
    "GOOGLE AUTHENTICATOR BERHASIL DIPASANG!": "GOOGLE AUTHENTICATOR SUCCESSFULLY INSTALLED!",
    "Saat login berikutnya, Anda akan ditanya kode 2FA.": "During your next login, you will be asked for the 2FA code.",
    "Kode bisa di-skip jika tidak mau verifikasi.": "The code can be skipped if you do not want to verify.",
    "Simpan secret key di tempat aman sebagai backup!": "Save the secret key in a safe place as a backup!",
    "Verifikasi gagal. 2FA tidak dipasang.": "Verification failed. 2FA not installed.",
    "percobaan tersisa.\nCoba lagi:": "attempts remaining.\nTry again:",
    "💬 *NOTIFIKASI TELEGRAM (PRIBADI)*": "💬 *TELEGRAM NOTIFICATION (PRIVATE)*",
    "Aktifkan notifikasi transaksi untuk sesi ini?": "Activate transaction notifications for this session?",
    "Notifikasi akan dikirim ke chat ini": "Notifications will be sent to this chat",
    "Ketik *ya* untuk aktifkan, atau *tidak* untuk skip.": "Type *yes* to activate, or *no* to skip.",
    "Ketik ya untuk aktifkan, atau tidak untuk skip.": "Type yes to activate, or no to skip.",
    "NOTIFIKASI AKTIF!": "NOTIFICATIONS ACTIVE!",
    "Notifikasi transaksi akan dikirim ke chat ini.": "Transaction notifications will be sent to this chat.",
    "Tes Notifikasi": "Notification Test",
    "Koneksi berhasil!": "Connection successful!",
    "Notifikasi dinonaktifkan untuk sesi ini.": "Notifications disabled for this session."
};

// Sort keys by length descending to match longest phrases first
const sortedKeys = Object.keys(WORD_MAP).sort((a, b) => b.length - a.length);

function translateText(text, lang) {
    if (lang !== 'en' || !text) return text;
    let result = text;
    for (const key of sortedKeys) {
        result = result.replaceAll(key, WORD_MAP[key]);
    }
    return result;
}

function translateButton(text) {
    if (!text) return text;
    let result = text;
    for (const key of sortedKeys) {
        result = result.replaceAll(key, WORD_MAP[key]);
    }
    return result;
}

function translateMarkup(markup, lang) {
    if (lang !== 'en' || !markup) return markup;
    const newMarkup = JSON.parse(JSON.stringify(markup));
    if (newMarkup.inline_keyboard) {
        newMarkup.inline_keyboard = newMarkup.inline_keyboard.map(row =>
            row.map(btn => {
                btn.text = translateButton(btn.text);
                return btn;
            })
        );
    }
    if (newMarkup.keyboard) {
        newMarkup.keyboard = newMarkup.keyboard.map(row =>
            row.map(btn => {
                if (typeof btn === 'string') {
                    return translateButton(btn);
                } else if (btn && btn.text) {
                    btn.text = translateButton(btn.text);
                }
                return btn;
            })
        );
    }
    return newMarkup;
}

module.exports = {
    translateText,
    translateMarkup
};
