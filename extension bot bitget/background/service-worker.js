'use strict';

/**
 * 0xfastarx — Background Service Worker
 *
 * Fitur:
 * - Multi-port: port 8545 & 8546 permanen + bisa tambah custom
 * - Mode Localhost (127.0.0.1) atau VPS (custom IP)
 * - Config tersimpan di chrome.storage.local (tidak hilang saat browser restart)
 * - Aktif port: user pilih sendiri dari popup
 * - FIX: Session persistence — eth_accounts tidak perlu approval ulang setelah reload
 * - FIX: Auto-disconnect — kirim notif ke bot saat DApp disconnect
 */

// ─── STORAGE KEYS ───────────────────────────────────────────────────────────
const KEY_BOT_CONFIG        = 'fastarx_bot_config';
const KEY_BOT_STATUS        = 'fastarx_bot_status';
const KEY_CONNECTED_ORIGINS = 'fastarx_connected_origins';

// ─── DEFAULT CONFIG ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  mode: 'localhost',
  vpsHost: '',
  rpcPassword: '',
  activePort: 8545,
  ports: [
    { port: 8545, label: 'Port 8545 (Default)', isPermanent: true },
    { port: 8546, label: 'Port 8546 (Default)', isPermanent: true }
  ]
};

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────
function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])));
}
function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

// ─── CONFIG HELPERS ───────────────────────────────────────────────────────────
async function loadConfig() {
  const saved = await storageGet(KEY_BOT_CONFIG);
  if (!saved) return { ...DEFAULT_CONFIG };
  const ports = saved.ports || [];
  const has8545 = ports.some(p => p.port === 8545);
  const has8546 = ports.some(p => p.port === 8546);
  if (!has8545) ports.unshift({ port: 8545, label: 'Port 8545 (Default)', isPermanent: true });
  if (!has8546) ports.splice(1, 0, { port: 8546, label: 'Port 8546 (Default)', isPermanent: true });
  return { ...DEFAULT_CONFIG, ...saved, ports };
}

async function saveConfig(config) {
  await storageSet(KEY_BOT_CONFIG, config);
}

// ─── CONNECTED ORIGINS ────────────────────────────────────────────────────────
async function getConnectedOrigins() {
  const data = await storageGet(KEY_CONNECTED_ORIGINS);
  return data || {};
}

async function markOriginConnected(origin, address) {
  const origins = await getConnectedOrigins();
  origins[origin] = { address, connectedAt: new Date().toISOString() };
  await storageSet(KEY_CONNECTED_ORIGINS, origins);
}

async function isOriginConnected(origin) {
  const origins = await getConnectedOrigins();
  return !!origins[origin];
}

async function disconnectOrigin(origin) {
  const origins = await getConnectedOrigins();
  const wasConnected = !!origins[origin];
  delete origins[origin];
  await storageSet(KEY_CONNECTED_ORIGINS, origins);
  return wasConnected;
}

// ─── BUILD RPC URL ────────────────────────────────────────────────────────────
function buildRpcUrl(config, port = null) {
  const host = config.mode === 'vps' && config.vpsHost ? config.vpsHost : '127.0.0.1';
  const p = port || config.activePort || 8545;
  return `http://${host}:${p}`;
}

// ─── FETCH RPC (generic) ──────────────────────────────────────────────────────
async function fetchBotRpc(method, params = [], rpcUrl, origin = null, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const config = await loadConfig();
    const rpcPassword = config.rpcPassword || '';
    const bodyObj = { jsonrpc: '2.0', id: Date.now(), method, params };
    if (origin) bodyObj.origin = origin;
    const headers = { 'Content-Type': 'application/json' };
    if (rpcPassword) {
      headers['Authorization'] = 'Bearer ' + rpcPassword;
    }
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'RPC error');
    return data.result;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── CHECK BOT STATUS ─────────────────────────────────────────────────────────
async function checkBotStatus(config) {
  const rpcUrl = buildRpcUrl(config);
  try {
    const [accounts, chainId] = await Promise.all([
      fetchBotRpc('eth_accounts', [], rpcUrl),
      fetchBotRpc('eth_chainId', [], rpcUrl)
    ]);
    const address = accounts?.[0] || null;
    const status = {
      connected: true, address, chainId,
      chainIdDec: chainId ? parseInt(chainId, 16) : null,
      rpcUrl, lastCheck: new Date().toISOString()
    };
    await storageSet(KEY_BOT_STATUS, status);
    return status;
  } catch (err) {
    const status = {
      connected: false, address: null, chainId: null,
      rpcUrl, error: err.message, lastCheck: new Date().toISOString()
    };
    await storageSet(KEY_BOT_STATUS, status);
    return status;
  }
}

// ─── NOTIFY BOT: DApp Disconnect ──────────────────────────────────────────────
// Kirim HTTP request ke bot RPC dengan method khusus `dapp_forceDisconnect`
// Bot akan hapus DApp dari connectedDapps[] dan kirim notif Telegram
async function notifyBotDisconnect(config, origin, reason) {
  const rpcUrl = buildRpcUrl(config);
  try {
    await fetchBotRpc(
      'dapp_forceDisconnect',
      [{ origin, reason }],
      rpcUrl,
      origin,
      5000  // timeout 5 detik saja untuk disconnect
    );
    console.log('[0xfastarx] ✅ Bot notified: DApp disconnect:', origin);
  } catch (err) {
    // Bot mungkin offline — tidak masalah, storage lokal sudah dibersihkan
    console.warn('[0xfastarx] ⚠️ Gagal notif bot disconnect (bot offline?):', err.message);
  }
}

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    const config = await loadConfig();

    switch (msg.action) {

      // ── Cek status koneksi bot ────────────────────────────────────────────
      case 'checkBot': {
        const status = await checkBotStatus(config);
        return status;
      }

      // ── Forward RPC request ke bot ────────────────────────────────────────
      case 'rpcRequest': {
        const rpcUrl = buildRpcUrl(config);
        const origin = msg.origin || '';

        // SESSION PERSISTENCE: eth_accounts tanpa re-approval
        if (msg.method === 'eth_accounts') {
          const storedStatus = await storageGet(KEY_BOT_STATUS);
          const originConnected = await isOriginConnected(origin);

          if (originConnected && storedStatus && storedStatus.address) {
            try {
              const controller = new AbortController();
              const t = setTimeout(() => controller.abort(), 3000);
              const headers = { 'Content-Type': 'application/json' };
              if (config.rpcPassword) {
                headers['Authorization'] = 'Bearer ' + config.rpcPassword;
              }
              const res = await fetch(rpcUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_accounts', params: [] }),
                signal: controller.signal
              });
              clearTimeout(t);
              const data = await res.json();
              const accounts = data.result || [];
              if (accounts.length > 0) return { result: accounts };
              
              // Jika bot online tapi mengembalikan empty array, artinya DApp tidak terhubung di sisi bot.
              // Hapus status koneksi dari extension storage agar tersinkronisasi.
              console.log(`[0xfastarx] Bot returned empty accounts for ${origin}. Disconnecting in extension.`);
              await disconnectOrigin(origin);
              return { result: [] };
            } catch (e) {
              console.log('[0xfastarx] Bot offline sementara, return cached address');
              return { result: [storedStatus.address] };
            }
          }
        }

        // Forward ke bot & simpan origin setelah connect berhasil
        try {
          const result = await fetchBotRpc(msg.method, msg.params || [], rpcUrl, origin);

          if ((msg.method === 'eth_requestAccounts' || msg.method === 'eth_accounts')
              && result && result[0]) {
            await markOriginConnected(origin, result[0]);
            const storedStatus = await storageGet(KEY_BOT_STATUS) || {};
            storedStatus.connected = true;
            storedStatus.address = result[0];
            storedStatus.lastCheck = new Date().toISOString();
            await storageSet(KEY_BOT_STATUS, storedStatus);
          } else if ((msg.method === 'eth_requestAccounts' || msg.method === 'eth_accounts')
              && (!result || result.length === 0)) {
            // Jika bot online tapi mengembalikan empty array, pastikan di extension juga disconnect!
            await disconnectOrigin(origin);
          }

          return { result };
        } catch (err) {
          return { error: { code: -32603, message: err.message } };
        }
      }

      // ── DApp Disconnect — dikirim dari injector.js ────────────────────────
      case 'dappDisconnect': {
        const origin = msg.origin || '';
        const reason = msg.reason || 'unknown';

        console.log('[0xfastarx] 🔌 Disconnect diterima dari DApp:', origin, '|', reason);

        // 1. Hapus dari connected origins storage (sehingga reload tidak restore lagi)
        const wasConnected = await disconnectOrigin(origin);

        if (wasConnected) {
          // 2. Kirim notif ke bot agar bot juga hapus dari connectedDapps[]
          //    dan kirim pesan Telegram ke admin
          await notifyBotDisconnect(config, origin, reason);
        }

        return { ok: true, wasConnected };
      }

      // ── Ambil config ──────────────────────────────────────────────────────
      case 'getConfig':
        return config;

      // ── Ambil status tersimpan ────────────────────────────────────────────
      case 'getStatus': {
        const status = await storageGet(KEY_BOT_STATUS);
        return status || { connected: false };
      }

      // ── Simpan config ─────────────────────────────────────────────────────
      case 'saveConfig': {
        const newConfig = msg.config;
        const perms = [
          { port: 8545, label: 'Port 8545 (Default)', isPermanent: true },
          { port: 8546, label: 'Port 8546 (Default)', isPermanent: true }
        ];
        const customPorts = (newConfig.ports || []).filter(p => !p.isPermanent);
        newConfig.ports = [...perms, ...customPorts];
        await saveConfig(newConfig);
        return { ok: true };
      }

      // ── Tambah port custom ────────────────────────────────────────────────
      case 'addPort': {
        const { port, label } = msg;
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
          return { ok: false, msg: 'Port tidak valid (1024–65535)' };
        }
        if (config.ports.some(p => p.port === portNum)) {
          return { ok: false, msg: `Port ${portNum} sudah ada` };
        }
        config.ports.push({ port: portNum, label: label || `Port ${portNum} (Custom)`, isPermanent: false });
        await saveConfig(config);
        return { ok: true };
      }

      // ── Hapus port custom ─────────────────────────────────────────────────
      case 'removePort': {
        const portNum = parseInt(msg.port);
        const entry = config.ports.find(p => p.port === portNum);
        if (!entry) return { ok: false, msg: 'Port tidak ditemukan' };
        if (entry.isPermanent) return { ok: false, msg: `Port ${portNum} adalah port permanen` };
        config.ports = config.ports.filter(p => p.port !== portNum);
        if (config.activePort === portNum) config.activePort = 8545;
        await saveConfig(config);
        return { ok: true };
      }

      // ── Set port aktif ────────────────────────────────────────────────────
      case 'setActivePort': {
        const portNum = parseInt(msg.port);
        if (!config.ports.some(p => p.port === portNum)) {
          return { ok: false, msg: 'Port tidak ada dalam daftar' };
        }
        config.activePort = portNum;
        await saveConfig(config);
        return { ok: true };
      }

      // ── Disconnect origin secara manual (dari popup) ──────────────────────
      case 'disconnectOrigin': {
        await disconnectOrigin(msg.origin);
        await notifyBotDisconnect(config, msg.origin, 'manual_from_popup');
        return { ok: true };
      }

      // ── Lihat semua origin yang sudah connect ─────────────────────────────
      case 'getConnectedOrigins': {
        const origins = await getConnectedOrigins();
        return origins;
      }

      case 'tabReady':
        return { ok: true };

      default:
        return { error: 'Unknown action' };
    }
  };

  handle().then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

// Init
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet(KEY_BOT_CONFIG);
  if (!existing) {
    await saveConfig({ ...DEFAULT_CONFIG });
  }
  console.log('[0xfastarx] Extension installed/updated');
});

console.log('[0xfastarx] Service worker started');
