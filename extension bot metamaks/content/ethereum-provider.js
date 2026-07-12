/**
 * MetaMask - Ethereum Provider Spoofing
 * Diinject ke page context DApp — override window.ethereum
 * Berjalan di MAIN world secara sinkron saat document_start.
 */
(function () {
  if (window.__METAMASK_INJECTED_PROV__) return;
  window.__METAMASK_INJECTED_PROV__ = true;

  const FASTARX_CHANNEL = 'ethereum_provider_rpc_v4';

  const pendingRequests = new Map();
  let requestId = 1;

  // ─── SYNCHRONOUS CACHE (sessionStorage) ───────────────────────────────────
  // Menyimpan address & chainId aktif agar langsung siap secara sinkron saat reload
  const cachedAccount = sessionStorage.getItem('__eth_cache_addr__');
  const cachedChain = sessionStorage.getItem('__eth_cache_chain__');

  let _chainId = cachedChain || null;
  let _accounts = cachedAccount ? [cachedAccount] : [];
  let _connected = !!cachedAccount;

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
          reject(new Error('MetaMask: Request timeout'));
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

    sessionStorage.removeItem('__eth_cache_addr__');
    sessionStorage.removeItem('__eth_cache_chain__');
  }

  // ─── Update cache state ──────────────────────────────────────────────────
  function _updateCache(accounts, chainId) {
    if (accounts && accounts[0]) {
      _accounts = accounts;
      fastarxProvider.selectedAddress = accounts[0];
      _connected = true;
      fastarxProvider._isConnected = true;
      sessionStorage.setItem('__eth_cache_addr__', accounts[0]);
    }
    if (chainId) {
      _chainId = chainId;
      fastarxProvider.chainId = chainId;
      fastarxProvider.networkVersion = parseInt(chainId, 16).toString();
      sessionStorage.setItem('__eth_cache_chain__', chainId);
    }
  }

  // ─── Notify injector/background tentang disconnect ────────────────────────
  function _notifyDisconnect(reason) {
    window.postMessage({
      channel: FASTARX_CHANNEL + '_dapp_disconnect',
      origin: window.location.origin,
      reason: reason || 'dapp_disconnect'
    }, '*');
  }

  // ─── EIP-1193 Provider ────────────────────────────────────────────────────
  const fastarxProvider = {
    isMetaMask: true,
    selectedAddress: cachedAccount || null,
    chainId: cachedChain || null,
    networkVersion: cachedChain ? parseInt(cachedChain, 16).toString() : null,
    _isConnected: !!cachedAccount,

    async request({ method, params = [] }) {
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
            _resetState();
            _notifyDisconnect('accountsChanged_empty');
          } else if (accounts.length > 0) {
            _updateCache(accounts, null);
          }
          callback(accounts);
        };
        callback.__metamask_wrapped__ = wrappedCallback;
        listeners[event][listeners[event].length - 1] = wrappedCallback;
      }

      return this;
    },

    removeListener(event, callback) {
      if (listeners[event]) {
        const target = callback.__metamask_wrapped__ || callback;
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
  } catch (e) {
    try { window.ethereum = fastarxProvider; } catch (e2) {}
  }

  // ─── AUTO-RESTORE SESSION saat page reload (Double Check dengan Bot) ─────
  async function autoRestoreSession() {
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
      } else {
        if (_connected) {
          _resetState();
          emit('accountsChanged', []);
          emit('disconnect', { code: 4900, message: 'Session expired' });
        }
      }
    } catch (e) {
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
        uuid: crypto.randomUUID ? crypto.randomUUID() : 'ec519c72-911e-450e-ac63-47209774618e',
        name: 'MetaMask',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGggZmlsbD0iI2UyNzYxYiIgZD0iTTE2IDRsLTkgOGg2bDMtNiAzIDZoNnoiLz48cGF0aCBmaWxsPSIjZTQ3NjFiIiBkPSJNMTYgMjhsLTgtOGgxNnoiLz48cGF0aCBmaWxsPSIjZDdjMWIxIiBkPSJNNyAxMmw5IDggOS04LTItNEg5eiIvPjxjaXJjbGUgY3g9IjExIiBjeT0iMTUiIHI9IjIiIGZpbGw9IiMwMDAiLz48Y2lyY2xlIGN4PSIyMSIgY3k9IjE1IiByPSIyIiBmaWxsPSIjMDAwIi8+PC9zdmc+',
        rdns: 'io.metamask'
      }),
      provider: fastarxProvider
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  }

  window.addEventListener('eip6963:requestProvider', announceProvider);
  announceProvider();

})();
