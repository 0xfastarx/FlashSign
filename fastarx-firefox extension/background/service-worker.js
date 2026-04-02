'use strict';

/**
 * FA STARX Bot Connector v4.0.0 — Background Service Worker
 * Firefox compatible
 */

const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ─── STORAGE KEYS ───────────────────────────────────────────────────────────
const KEY_BOT_CONFIG = 'fastarx_bot_config';
const KEY_BOT_STATUS = 'fastarx_bot_status';

// ─── DEFAULT CONFIG ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  mode: 'localhost',
  vpsHost: '',
  activePort: 8545,
  ports: [
    { port: 8545, label: 'Port 8545 (Default)', isPermanent: true },
    { port: 8546, label: 'Port 8546 (Default)', isPermanent: true }
  ]
};

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────
function storageGet(key) {
  return new Promise(resolve =>
    _browser.storage.local.get(key, r => resolve(r[key]))
  );
}
function storageSet(key, value) {
  return new Promise(resolve =>
    _browser.storage.local.set({ [key]: value }, resolve)
  );
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

// ─── BUILD RPC URL ────────────────────────────────────────────────────────────
function buildRpcUrl(config, port = null) {
  const host = config.mode === 'vps' && config.vpsHost
    ? config.vpsHost
    : '127.0.0.1';
  const p = port || config.activePort || 8545;
  return `http://${host}:${p}`;
}

// ─── FETCH RPC ────────────────────────────────────────────────────────────────
async function fetchBotRpc(method, params = [], rpcUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
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
      connected: true,
      address,
      chainId,
      chainIdDec: chainId ? parseInt(chainId, 16) : null,
      rpcUrl,
      lastCheck: new Date().toISOString()
    };
    await storageSet(KEY_BOT_STATUS, status);
    return status;
  } catch (err) {
    const status = {
      connected: false,
      address: null,
      chainId: null,
      rpcUrl,
      error: err.message,
      lastCheck: new Date().toISOString()
    };
    await storageSet(KEY_BOT_STATUS, status);
    return status;
  }
}

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────
_browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    const config = await loadConfig();

    switch (msg.action) {

      case 'checkBot': {
        const status = await checkBotStatus(config);
        return status;
      }

      case 'rpcRequest': {
        const rpcUrl = buildRpcUrl(config);
        try {
          const result = await fetchBotRpc(msg.method, msg.params || [], rpcUrl);
          return { result };
        } catch (err) {
          return { error: { code: -32603, message: err.message } };
        }
      }

      case 'getConfig':
        return config;

      case 'getStatus': {
        const status = await storageGet(KEY_BOT_STATUS);
        return status || { connected: false };
      }

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

      case 'setActivePort': {
        const portNum = parseInt(msg.port);
        if (!config.ports.some(p => p.port === portNum)) {
          return { ok: false, msg: 'Port tidak ada dalam daftar' };
        }
        config.activePort = portNum;
        await saveConfig(config);
        return { ok: true };
      }

      default:
        return { error: 'Unknown action' };
    }
  };

  handle().then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
_browser.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet(KEY_BOT_CONFIG);
  if (!existing) {
    await saveConfig({ ...DEFAULT_CONFIG });
  }
  console.log('[FA STARX v4] Extension installed/updated');
});

console.log('[FA STARX v4] Background script started');
