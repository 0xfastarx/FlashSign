/**
 * 0xfastarx - Ethereum Provider
 * Diinject ke page context DApp — override window.ethereum
 * Berjalan di MAIN world secara sinkron saat document_start.
 * 
 * FIX: Menggunakan sessionStorage cache untuk memulihkan koneksi secara 
 * sinkron instan saat reload (mencegah race condition dengan Wagmi/React).
 */
(function () {
  if (window.__FASTARX_V4_INJECTED__) return;
  window.__FASTARX_V4_INJECTED__ = true;

  const FASTARX_CHANNEL = 'fastarx_rpc_v4';

  const pendingRequests = new Map();
  let requestId = 1;

  // ─── SYNCHRONOUS CACHE (sessionStorage) ───────────────────────────────────
  // Menyimpan address & chainId aktif agar langsung siap secara sinkron saat reload
  const cachedAccount = sessionStorage.getItem('__0xfastarx_active_account__');
  const cachedChain = sessionStorage.getItem('__0xfastarx_active_chain__');

  let _chainId = cachedChain || null;
  let _accounts = cachedAccount ? [cachedAccount] : [];
  let _connected = !!cachedAccount;

  console.log('[0xfastarx] 📥 Cache loaded:', { cachedAccount, cachedChain });

  // ─── Listen responses dari injector.js (bridge) ───────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.channel === FASTARX_CHANNEL + '_response') {
      const { id, result, error } = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      if (error) {
        const err = new Error(error.message || 'RPC Error');
        err.code = error.code || -32603;
        pending.reject(err);
      } else {
        pending.resolve(result);
      }
    }

    if (event.data.channel === FASTARX_CHANNEL + '_event') {
      emit(event.data.event, event.data.data);
    }
  });

  // ─── Event emitter ────────────────────────────────────────────────────────
  const listeners = {};
  function emit(event, ...args) {
    (listeners[event] || []).forEach(fn => { try { fn(...args); } catch(e) {} });
  }

  // ─── Send RPC request ──────────────────────────────────────────────────────
  function sendRequest(method, params = [], timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = requestId++;
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('0xfastarx: Request timeout — pastikan bot sudah running'));
        }
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      window.postMessage({ channel: FASTARX_CHANNEL, id, method, params }, '*');
    });
  }

  // ─── Internal reset state & clear cache ──────────────────────────────────
  function _resetState() {
    _accounts = [];
    _connected = false;
    _chainId = null;
    fastarxProvider.selectedAddress = null;
    fastarxProvider._isConnected = false;
    fastarxProvider.chainId = null;
    fastarxProvider.networkVersion = null;

    sessionStorage.removeItem('__0xfastarx_active_account__');
    sessionStorage.removeItem('__0xfastarx_active_chain__');
  }

  // ─── Update cache state ──────────────────────────────────────────────────
  function _updateCache(accounts, chainId) {
    if (accounts && accounts[0]) {
      _accounts = accounts;
      fastarxProvider.selectedAddress = accounts[0];
      _connected = true;
      fastarxProvider._isConnected = true;
      sessionStorage.setItem('__0xfastarx_active_account__', accounts[0]);
    }
    if (chainId) {
      _chainId = chainId;
      fastarxProvider.chainId = chainId;
      fastarxProvider.networkVersion = parseInt(chainId, 16).toString();
      sessionStorage.setItem('__0xfastarx_active_chain__', chainId);
    }
  }

  // ─── Notify injector/background tentang disconnect ────────────────────────
  function _notifyDisconnect(reason) {
    console.log('[0xfastarx] 🔌 Disconnect event:', reason || 'DApp initiated disconnect');
    window.postMessage({
      channel: FASTARX_CHANNEL + '_dapp_disconnect',
      origin: window.location.origin,
      reason: reason || 'dapp_disconnect'
    }, '*');
  }

  // ─── EIP-1193 Provider ────────────────────────────────────────────────────
  const fastarxProvider = {
    isMetaMask: true,
    isFaStarX: true,
    selectedAddress: cachedAccount || null,
    chainId: cachedChain || null,
    networkVersion: cachedChain ? parseInt(cachedChain, 16).toString() : null,
    _isConnected: !!cachedAccount,

    async request({ method, params = [] }) {
      console.log('[0xfastarx] →', method);

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': {
          // SINKRON INSTAN: Jika di cache sudah ada, langsung return tanpa await
          if (method === 'eth_accounts' && _connected && _accounts.length > 0) {
            return _accounts;
          }

          const result = await sendRequest(method, params);
          if (result && result[0]) {
            _updateCache(result, null);
          }
          return result || [];
        }

        case 'eth_chainId': {
          if (_chainId) return _chainId;
          const result = await sendRequest('eth_chainId', []);
          _updateCache(null, result);
          return result;
        }

        case 'net_version': {
          if (_chainId) return parseInt(_chainId, 16).toString();
          const cid = await sendRequest('eth_chainId', []);
          _updateCache(null, cid);
          return cid ? parseInt(cid, 16).toString() : '1';
        }

        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        // ── AUTO-DISCONNECT: Tangkap saat DApp disconnect ─────────────────
        case 'wallet_revokePermissions':
        case 'wallet_disconnect':
        case 'wallet_revokeAllPermissions': {
          console.log('[0xfastarx] 🔌 DApp melakukan disconnect via:', method);
          _resetState();
          _notifyDisconnect(method);

          emit('accountsChanged', []);
          emit('disconnect', { code: 4900, message: 'User disconnected from DApp' });
          return null;
        }

        default:
          return await sendRequest(method, params);
      }
    },

    // Legacy send()
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return this.request({ method: methodOrPayload, params: paramsOrCallback || [] });
      }
      if (typeof paramsOrCallback === 'function') {
        this.request(methodOrPayload)
          .then(r => paramsOrCallback(null, { id: methodOrPayload.id, jsonrpc: '2.0', result: r }))
          .catch(e => paramsOrCallback(e));
        return;
      }
    },

    // Legacy sendAsync()
    sendAsync(payload, callback) {
      this.request(payload)
        .then(r => callback(null, { id: payload.id, jsonrpc: '2.0', result: r }))
        .catch(e => callback(e));
    },

    on(event, callback) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);

      // Intercept accountsChanged event
      if (event === 'accountsChanged') {
        const wrappedCallback = (accounts) => {
          if (accounts.length === 0 && _connected) {
            console.log('[0xfastarx] 🔌 Deteksi disconnect via accountsChanged([])');
            _resetState();
            _notifyDisconnect('accountsChanged_empty');
          } else if (accounts.length > 0) {
            _updateCache(accounts, null);
          }
          callback(accounts);
        };
        callback.__fastarx_wrapped__ = wrappedCallback;
        listeners[event][listeners[event].length - 1] = wrappedCallback;
      }

      return this;
    },

    removeListener(event, callback) {
      if (listeners[event]) {
        const target = callback.__fastarx_wrapped__ || callback;
        listeners[event] = listeners[event].filter(x => x !== target);
      }
      return this;
    },

    isConnected() { return _connected; },
    async enable() { return this.request({ method: 'eth_requestAccounts' }); }
  };

  // ─── Inject ke window.ethereum ────────────────────────────────────────────
  try {
    Object.defineProperty(window, 'ethereum', {
      value: fastarxProvider,
      writable: false,
      configurable: true
    });
    console.log('[0xfastarx] ✅ window.ethereum injected synchronously in MAIN world');
  } catch (e) {
    try { window.ethereum = fastarxProvider; } catch (e2) {
      console.error('[0xfastarx] Inject failed:', e2.message);
    }
  }

  // ─── AUTO-RESTORE SESSION saat page reload (Double Check dengan Bot) ─────
  async function autoRestoreSession() {
    console.log('[0xfastarx] 🔄 Memverifikasi session dengan bot...');
    try {
      const accounts = await sendRequest('eth_accounts', [], 5000);

      if (accounts && accounts.length > 0) {
        const chainId = await sendRequest('eth_chainId', [], 5000);
        
        const oldAccount = _accounts[0];
        const oldChain = _chainId;

        _updateCache(accounts, chainId);

        // Emit events jika ada perbedaan antara cache dengan data terbaru dari bot
        if (oldAccount !== accounts[0]) {
          emit('accountsChanged', accounts);
        }
        if (oldChain !== chainId) {
          emit('chainChanged', chainId);
        }

        console.log('[0xfastarx] ✅ Session terverifikasi dengan bot:', accounts[0]);
      } else {
        console.log('[0xfastarx] ℹ️ Bot mengembalikan empty session. Reset state.');
        if (_connected) {
          _resetState();
          emit('accountsChanged', []);
          emit('disconnect', { code: 4900, message: 'Session expired' });
        }
      }
    } catch (e) {
      console.log('[0xfastarx] ⚠️ Verifikasi session gagal (bot offline?):', e.message);
      // Jika bot offline, kita tetap pertahankan cache sementara agar UI tidak rusak
    }
  }

  // Emit event connect jika cache sudah ada sejak detik pertama
  if (_connected && _chainId) {
    setTimeout(() => {
      emit('connect', { chainId: _chainId });
    }, 100);
  }

  // Jalankan verifikasi ke bot
  setTimeout(autoRestoreSession, 150);

  // ─── EIP-6963: Multi-provider announcement ────────────────────────────────
  function announceProvider() {
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: 'fa-starx-bot-v4',
        name: '0xfastarx',
        icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjMDAwIi8+PHRleHQgeD0iNiIgeT0iMjMiIGZvbnQtc2l6ZT0iMjAiPvCfmoA8L3RleHQ+PC9zdmc+',
        rdns: 'io.0xfastarx'
      }),
      provider: fastarxProvider
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  }

  window.addEventListener('eip6963:requestProvider', announceProvider);
  announceProvider();

})();
