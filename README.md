# FA STARX BOT v19.0.0

Multi-Chain Transfer Bot dengan WalletConnect & MetaMask RPC Inject.

## Instalasi

```bash
npm install ethers@^6.10.0 @walletconnect/sign-client@^2.14.1 node-telegram-bot-api@^0.64.0 node-os-utils systeminformation
```

## Konfigurasi

1. Salin `.env.example` ke `.env`
2. Isi semua nilai yang diperlukan (enkripsi menggunakan script bawaan)

## Menjalankan

```bash
node main.js
```

## Fitur

- ✅ Auto Transaction dengan WalletConnect
- ✅ MetaMask RPC Inject (v19) — DApp connect via custom RPC
- ✅ RPC Management dengan Gas Config (Auto/Manual/Aggressive)
- ✅ Smart Delay Execution
- ✅ Auto-Save RPC dari DApp
- ✅ Multi-session dengan notifikasi Telegram pribadi
- ✅ Generate Wallet Otomatis + Backup Phrase
- ✅ Two Factor Auth (Google Authenticator) — TOTP RFC 6238
- ✅ Transfer Bot (ETH & Token auto-forward, auto-detect)
