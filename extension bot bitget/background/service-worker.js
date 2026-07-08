'use strict';

/**
 * 0xfastarx — Background Service Worker
 *
 * Fitur:
 * - Multi-port: port 8545 & 8546 permanen + bisa tambah custom
 * - Mode Localhost (127.0.0.1) atau VPS (custom IP)
 * - Config tersimpan di chrome.storage.local (tidak hilang saat browser restart)
 * - Aktif port: user pilih sendiri dari popup
 * - FIX: Session persistence — eth_accounts & solana_accounts tidak perlu approval ulang setelah reload
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
async function notifyBotDisconnect(config, origin, reason) {
  const rpcUrl = buildRpcUrl(config);
  try {
    await fetchBotRpc(
      'dapp_forceDisconnect',
      [{ origin, reason }],
      rpcUrl,
      origin,
      5000
    );
    console.log('[0xfastarx] ✅ Bot notified: DApp disconnect:', origin);
  } catch (err) {
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

      // ── Forward RPC request ke bot (EVM) ──────────────────────────────────
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
              // FIX: Kirim origin di body agar bot bisa mengenali DApp yang sudah connect
              const res = await fetch(rpcUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  jsonrpc: '2.0', id: Date.now(),
                  method: 'eth_accounts', params: [],
                  origin: origin
                }),
                signal: controller.signal
              });
              clearTimeout(t);
              const data = await res.json();
              const accounts = data.result || [];
              if (accounts.length > 0) return { result: accounts };
              
              // FIX: Bot mengembalikan empty TAPI kita punya cache —
              // Jangan disconnect! Return cached address agar session tetap hidup.
              console.log('[0xfastarx] Bot returned empty eth_accounts, returning cached address');
              return { result: [storedStatus.address] };
            } catch (e) {
              // Bot offline — tetap return cached address
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
          }
          // FIX: Jangan disconnect origin jika eth_accounts mengembalikan [] pada polling.
          // Disconnect hanya terjadi secara eksplisit via ethDappDisconnect action.

          return { result };
        } catch (err) {
          return { error: { code: -32603, message: err.message } };
        }
      }

      // ── Forward RPC request ke bot (Solana) ───────────────────────────────
      case 'solanaRpcRequest': {
        const rpcUrl = buildRpcUrl(config);
        const origin = msg.origin || '';

        // SESSION PERSISTENCE: solana_accounts tanpa re-approval
        if (msg.method === 'solana_accounts') {
          const storedStatus = await storageGet(KEY_BOT_STATUS + '_solana');
          const originConnected = await isOriginConnected(origin + '_solana');

          if (originConnected && storedStatus && storedStatus.address) {
            try {
              const controller = new AbortController();
              const t = setTimeout(() => controller.abort(), 3000);
              const headers = { 'Content-Type': 'application/json' };
              if (config.rpcPassword) {
                headers['Authorization'] = 'Bearer ' + config.rpcPassword;
              }
              // FIX: Kirim origin di body agar bot bisa mengenali DApp yang sudah connect
              const res = await fetch(rpcUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  jsonrpc: '2.0', id: Date.now(),
                  method: 'solana_accounts', params: [],
                  origin: origin
                }),
                signal: controller.signal
              });
              clearTimeout(t);
              const data = await res.json();
              const accounts = data.result || [];
              if (accounts.length > 0) return { result: accounts };
              
              // FIX: Bot mengembalikan empty TAPI kita punya cache —
              // Jangan disconnect! Return cached address agar session tetap hidup.
              // Bot mungkin mengembalikan [] karena origin tidak match di sisi isDappConnected().
              console.log('[0xfastarx] Bot returned empty solana_accounts, returning cached address');
              return { result: [storedStatus.address] };
            } catch (e) {
              // Bot offline — tetap return cached address
              return { result: [storedStatus.address] };
            }
          }
        }

        try {
          const result = await fetchBotRpc(msg.method, msg.params || [], rpcUrl, origin);

          if ((msg.method === 'solana_requestAccounts' || msg.method === 'solana_accounts')
              && result && result[0]) {
            await markOriginConnected(origin + '_solana', result[0]);
            const storedStatus = {
              connected: true,
              address: result[0],
              lastCheck: new Date().toISOString()
            };
            await storageSet(KEY_BOT_STATUS + '_solana', storedStatus);
          }
          // FIX: Jangan disconnect origin jika solana_accounts mengembalikan [] pada polling.
          // Disconnect hanya terjadi secara eksplisit via solanaDappDisconnect action.

          return { result };
        } catch (err) {
          // FIX: Jika bot offline saat polling, return cached address alih-alih error
          if (msg.method === 'solana_accounts') {
            const storedStatus = await storageGet(KEY_BOT_STATUS + '_solana');
            if (storedStatus && storedStatus.address) {
              return { result: [storedStatus.address] };
            }
          }
          return { error: { code: -32603, message: err.message } };
        }
      }

      // ── DApp Disconnect (EVM) ─────────────────────────────────────────────
      case 'dappDisconnect': {
        const origin = msg.origin || '';
        const reason = msg.reason || 'unknown';

        console.log('[0xfastarx] 🔌 Disconnect diterima dari DApp:', origin, '|', reason);

        const wasConnected = await disconnectOrigin(origin);

        if (wasConnected) {
          await notifyBotDisconnect(config, origin, reason);
        }

        return { ok: true, wasConnected };
      }

      // ── DApp Disconnect (Solana) ──────────────────────────────────────────
      case 'solanaDappDisconnect': {
        const origin = msg.origin || '';
        const reason = msg.reason || 'unknown';

        console.log('[0xfastarx] 🔌 Solana Disconnect diterima dari DApp:', origin, '|', reason);

        const wasConnected = await disconnectOrigin(origin + '_solana');

        if (wasConnected) {
          const rpcUrl = buildRpcUrl(config);
          try {
            await fetchBotRpc(
              'solana_dapp_forceDisconnect',
              [{ origin, reason }],
              rpcUrl,
              origin,
              5000
            );
            console.log('[0xfastarx] ✅ Bot notified: Solana DApp disconnect:', origin);
          } catch (err) {
            console.warn('[0xfastarx] ⚠️ Gagal notif bot Solana disconnect:', err.message);
          }
        }

        return { ok: true, wasConnected };
      }

      // ── Forward RPC request ke bot (Aptos) ────────────────────────────────
      case 'aptosRpcRequest': {
        const rpcUrl = buildRpcUrl(config);
        const origin = msg.origin || '';

        // SESSION PERSISTENCE: aptos_accounts tanpa re-approval
        if (msg.method === 'aptos_accounts') {
          const storedStatus = await storageGet(KEY_BOT_STATUS + '_aptos');
          const originConnected = await isOriginConnected(origin + '_aptos');

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
                body: JSON.stringify({
                  jsonrpc: '2.0', id: Date.now(),
                  method: 'aptos_accounts', params: [],
                  origin: origin
                }),
                signal: controller.signal
              });
              clearTimeout(t);
              const data = await res.json();
              const result = data.result;
              if (result && result.address) return { result };

              console.log('[0xfastarx] Bot returned empty aptos_accounts, returning cached');
              return { result: { address: storedStatus.address, publicKey: storedStatus.publicKey } };
            } catch (e) {
              return { result: { address: storedStatus.address, publicKey: storedStatus.publicKey } };
            }
          }
        }

        try {
          const result = await fetchBotRpc(msg.method, msg.params || [], rpcUrl, origin);

          if ((msg.method === 'aptos_requestAccounts' || msg.method === 'aptos_accounts')
              && result && result.address) {
            await markOriginConnected(origin + '_aptos', result.address);
            const storedStatus = {
              connected: true,
              address: result.address,
              publicKey: result.publicKey,
              lastCheck: new Date().toISOString()
            };
            await storageSet(KEY_BOT_STATUS + '_aptos', storedStatus);
          }

          return { result };
        } catch (err) {
          // Deteksi error Unauthorized — password RPC di extension popup tidak cocok/belum diisi
          if (err.message && err.message.includes('Unauthorized')) {
            console.error('[0xfastarx] ❌ APTOS RPC ERROR: Password RPC salah atau belum diset!');
            console.error('[0xfastarx] 💡 Buka Extension Popup → Tab Config → Isi RPC Password → Save Config');
          } else {
            console.warn('[0xfastarx] ⚠️ Aptos RPC error:', err.message);
          }

          // Fallback: jika ada cached address, kembalikan itu agar DApp tidak mati
          if (msg.method === 'aptos_accounts' || msg.method === 'aptos_requestAccounts') {
            const storedStatus = await storageGet(KEY_BOT_STATUS + '_aptos');
            if (storedStatus && storedStatus.address) {
              console.log('[0xfastarx] 🔄 Returning cached Aptos account for', msg.method);
              return { result: { address: storedStatus.address, publicKey: storedStatus.publicKey } };
            }
          }
          return { error: { code: -32603, message: err.message } };
        }
      }

      // ── DApp Disconnect (Aptos) ───────────────────────────────────────────
      case 'aptosDappDisconnect': {
        const origin = msg.origin || '';
        const reason = msg.reason || 'unknown';

        console.log('[0xfastarx] 🔌 Aptos Disconnect diterima dari DApp:', origin, '|', reason);

        const wasConnected = await disconnectOrigin(origin + '_aptos');

        if (wasConnected) {
          const rpcUrl = buildRpcUrl(config);
          try {
            await fetchBotRpc(
              'aptos_dapp_forceDisconnect',
              [{ origin, reason }],
              rpcUrl,
              origin,
              5000
            );
            console.log('[0xfastarx] ✅ Bot notified: Aptos DApp disconnect:', origin);
          } catch (err) {
            console.warn('[0xfastarx] ⚠️ Gagal notif bot Aptos disconnect:', err.message);
          }
        }

        return { ok: true, wasConnected };
      }

      // ── Forward RPC request ke bot (TON) ──────────────────────────────────
      case 'tonRpcRequest': {
        const rpcUrl = buildRpcUrl(config);
        const origin = msg.origin || '';

        // SESSION PERSISTENCE: ton_connect tanpa re-approval
        if (msg.method === 'ton_connect') {
          const paramsObj = msg.params?.[0] || {};
          const isInteractive = paramsObj.isInteractive !== false;

          const storedStatus = await storageGet(KEY_BOT_STATUS + '_ton');
          const originConnected = await isOriginConnected(origin + '_ton');

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
                body: JSON.stringify({
                  jsonrpc: '2.0', id: Date.now(),
                  method: 'ton_connect', params: msg.params || [],
                  origin: origin
                }),
                signal: controller.signal
              });
              clearTimeout(t);
              const data = await res.json();
              const result = data.result;
              if (result && result.address) return { result };

              console.log('[0xfastarx] Bot returned empty ton_connect, returning cached');
              return { result: { 
                address: storedStatus.address, 
                userFriendlyAddress: storedStatus.userFriendlyAddress,
                publicKey: storedStatus.publicKey,
                walletStateInit: storedStatus.walletStateInit
              }};
            } catch (e) {
              return { result: { 
                address: storedStatus.address, 
                userFriendlyAddress: storedStatus.userFriendlyAddress,
                publicKey: storedStatus.publicKey,
                walletStateInit: storedStatus.walletStateInit
              }};
            }
          } else if (!isInteractive) {
            console.log('[0xfastarx] Silent ton_connect restore skipped (not connected/not interactive)');
            return { result: null };
          }
        }

        try {
          const result = await fetchBotRpc(msg.method, msg.params || [], rpcUrl, origin);

          if (msg.method === 'ton_connect' && result && result.address) {
            await markOriginConnected(origin + '_ton', result.address);
            const storedStatus = {
              connected: true,
              address: result.address,
              userFriendlyAddress: result.userFriendlyAddress,
              publicKey: result.publicKey,
              walletStateInit: result.walletStateInit,
              lastCheck: new Date().toISOString()
            };
            await storageSet(KEY_BOT_STATUS + '_ton', storedStatus);
          }

          return { result };
        } catch (err) {
          if (err.message && err.message.includes('Unauthorized')) {
            console.error('[0xfastarx] ❌ TON RPC ERROR: Password RPC salah atau belum diset!');
            console.error('[0xfastarx] 💡 Buka Extension Popup → Tab Config → Isi RPC Password → Save Config');
          } else {
            console.warn('[0xfastarx] ⚠️ TON RPC error:', err.message);
          }

          // Fallback: jika ada cached address, kembalikan itu agar DApp tidak mati
          if (msg.method === 'ton_connect') {
            const storedStatus = await storageGet(KEY_BOT_STATUS + '_ton');
            if (storedStatus && storedStatus.address) {
              console.log('[0xfastarx] 🔄 Returning cached TON account for ton_connect');
              return { result: { 
                address: storedStatus.address, 
                userFriendlyAddress: storedStatus.userFriendlyAddress,
                publicKey: storedStatus.publicKey,
                walletStateInit: storedStatus.walletStateInit
              }};
            }
          }
          return { error: { code: -32603, message: err.message } };
        }
      }

      // ── DApp Disconnect (TON) ─────────────────────────────────────────────
      case 'tonDappDisconnect': {
        const origin = msg.origin || '';
        const reason = msg.reason || 'unknown';

        console.log('[0xfastarx] 🔌 TON Disconnect diterima dari DApp:', origin, '|', reason);

        const wasConnected = await disconnectOrigin(origin + '_ton');

        if (wasConnected) {
          const rpcUrl = buildRpcUrl(config);
          try {
            await fetchBotRpc(
              'ton_dapp_forceDisconnect',
              [{ origin, reason }],
              rpcUrl,
              origin,
              5000
            );
            console.log('[0xfastarx] ✅ Bot notified: TON DApp disconnect:', origin);
          } catch (err) {
            console.warn('[0xfastarx] ⚠️ Gagal notif bot TON disconnect:', err.message);
          }
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
