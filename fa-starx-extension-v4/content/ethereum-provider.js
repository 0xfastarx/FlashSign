/**
 * FA STARX v4 - Ethereum Provider
 * Diinject ke page context DApp — override window.ethereum
 */
(function () {
  if (window.__FASTARX_V4_INJECTED__) return;
  window.__FASTARX_V4_INJECTED__ = true;

  const FASTARX_CHANNEL = 'fastarx_rpc_v4';

  const pendingRequests = new Map();
  let requestId = 1;
  let _chainId = null;
  let _accounts = [];
  let _connected = false;

  // ─── Listen responses from injector ───────────────────────────────────────
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
  function sendRequest(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = requestId++;
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('FA STARX: Request timeout — pastikan bot sudah running'));
        }
      }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });
      window.postMessage({ channel: FASTARX_CHANNEL, id, method, params }, '*');
    });
  }

  // ─── EIP-1193 Provider ────────────────────────────────────────────────────
  const fastarxProvider = {
    isMetaMask: true,
    isFaStarX: true,
    selectedAddress: null,
    chainId: null,
    networkVersion: null,
    _isConnected: false,

    async request({ method, params = [] }) {
      console.log('[FA STARX v4] →', method);

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': {
          const result = await sendRequest(method, params);
          if (result && result[0]) {
            _accounts = result;
            fastarxProvider.selectedAddress = result[0];
            fastarxProvider._isConnected = true;
            _connected = true;
          }
          return result || [];
        }

        case 'eth_chainId': {
          const result = await sendRequest('eth_chainId', []);
          _chainId = result;
          fastarxProvider.chainId = result;
          fastarxProvider.networkVersion = result ? parseInt(result, 16).toString() : null;
          return result;
        }

        case 'net_version': {
          const cid = await sendRequest('eth_chainId', []);
          return cid ? parseInt(cid, 16).toString() : '1';
        }

        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];

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
      return this;
    },

    removeListener(event, callback) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(x => x !== callback);
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
      configurable: true   // configurable:true agar DApp modern bisa detect dengan benar
    });
    console.log('[FA STARX v4] ✅ window.ethereum injected');
  } catch (e) {
    try { window.ethereum = fastarxProvider; } catch (e2) {
      console.error('[FA STARX v4] Inject failed:', e2.message);
    }
  }

  // ─── EIP-6963: Multi-provider announcement ────────────────────────────────
  function announceProvider() {
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: 'fa-starx-bot-v4',
        name: 'FA STARX Bot',
        icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjMDAwIi8+PHRleHQgeD0iNiIgeT0iMjMiIGZvbnQtc2l6ZT0iMjAiPvCfmoA8L3RleHQ+PC9zdmc+',
        rdns: 'io.fastarx.bot'
      }),
      provider: fastarxProvider
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  }

  window.addEventListener('eip6963:requestProvider', announceProvider);
  announceProvider();

})();
