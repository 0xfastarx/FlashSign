/**
 * MetaMask/Bitget - Ethereum & Solana Provider Spoofing
 * Diinject ke page context DApp — override window.ethereum & window.solana
 * Berjalan di MAIN world secara sinkron saat document_start.
 */
(function () {
  if (window.__METAMASK_INJECTED_PROV__) return;
  window.__METAMASK_INJECTED_PROV__ = true;

  const FASTARX_CHANNEL = 'ethereum_provider_rpc_v4';
  const SOLANA_FASTARX_CHANNEL = 'solana_provider_rpc_v4';

  const pendingRequests = new Map();
  let requestId = 1;

  const pendingSolanaRequests = new Map();
  let solanaRequestId = 1;

  // ─── SYNCHRONOUS CACHE (sessionStorage) ───────────────────────────────────
  const cachedAccount = sessionStorage.getItem('__eth_cache_addr__');
  const cachedChain = sessionStorage.getItem('__eth_cache_chain__');

  let _chainId = cachedChain || null;
  let _accounts = cachedAccount ? [cachedAccount] : [];
  let _connected = !!cachedAccount;

  const cachedSolAccount = sessionStorage.getItem('__sol_cache_addr__');
  let _solAddress = cachedSolAccount || null;
  let _solConnected = !!cachedSolAccount;

  // Helper Base58 & Hex
  function bufToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBuf(hex) {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    const len = cleanHex.length;
    const view = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      view[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
    }
    return view;
  }

  class FakeSolanaPublicKey {
    constructor(base58String) {
      this._str = base58String;
    }
    toString() {
      return this._str;
    }
    toBase58() {
      return this._str;
    }
    toBuffer() {
      const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const ALPHABET_MAP = {};
      for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET.charAt(i)] = i;
      
      let bytes = [0];
      for (let i = 0; i < this._str.length; i++) {
        let c = this._str.charAt(i);
        if (!(c in ALPHABET_MAP)) throw new Error("Non-base58 character");
        let carry = ALPHABET_MAP[c];
        for (let j = 0; j < bytes.length; j++) {
          carry += bytes[j] * 58;
          bytes[j] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytes.push(carry & 0xff);
          carry >>= 8;
        }
      }
      for (let i = 0; i < this._str.length && this._str.charAt(i) === '1'; i++) {
        bytes.push(0);
      }
      return new Uint8Array(bytes.reverse());
    }
    toBytes() {
      return this.toBuffer();
    }
    equals(other) {
      return other && other.toString() === this._str;
    }
  }

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

    if (event.data.channel === SOLANA_FASTARX_CHANNEL + '_response') {
      const { id, result, error } = event.data;
      const pending = pendingSolanaRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSolanaRequests.delete(id);
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

    if (event.data.channel === SOLANA_FASTARX_CHANNEL + '_event') {
      emitSolana(event.data.event, event.data.data);
    }
  });

  // ─── Event emitter EVM ────────────────────────────────────────────────────
  const listeners = {};
  function emit(event, ...args) {
    (listeners[event] || []).forEach(fn => { try { fn(...args); } catch(e) {} });
  }

  // ─── Event emitter Solana ─────────────────────────────────────────────────
  const solanaListeners = {};
  function emitSolana(event, ...args) {
    (solanaListeners[event] || []).forEach(fn => { try { fn(...args); } catch(e) {} });
  }

  // ─── Send RPC request (EVM) ────────────────────────────────────────────────
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

  // ─── Send RPC request (Solana) ─────────────────────────────────────────────
  function sendSolanaRequest(method, params = [], timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = solanaRequestId++;
      const timer = setTimeout(() => {
        if (pendingSolanaRequests.has(id)) {
          pendingSolanaRequests.delete(id);
          reject(new Error('Solana: Request timeout'));
        }
      }, timeoutMs);
      pendingSolanaRequests.set(id, { resolve, reject, timer });
      window.postMessage({ channel: SOLANA_FASTARX_CHANNEL, id, method, params }, '*');
    });
  }

  // ─── Internal reset state & clear cache (EVM) ──────────────────────────────
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

  // ─── Update cache state (EVM) ──────────────────────────────────────────────
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

  // ─── Notify injector/background tentang disconnect (EVM) ────────────────────
  function _notifyDisconnect(reason) {
    window.postMessage({
      channel: FASTARX_CHANNEL + '_dapp_disconnect',
      origin: window.location.origin,
      reason: reason || 'dapp_disconnect'
    }, '*');
  }

  // ─── EIP-1193 Provider (EVM) ──────────────────────────────────────────────
  const fastarxProvider = {
    isMetaMask: true,
    isBitKeep: true,
    selectedAddress: cachedAccount || null,
    chainId: cachedChain || null,
    networkVersion: cachedChain ? parseInt(cachedChain, 16).toString() : null,
    _isConnected: !!cachedAccount,

    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': {
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

    sendAsync(payload, callback) {
      this.request(payload)
        .then(r => callback(null, { id: payload.id, jsonrpc: '2.0', result: r }))
        .catch(e => callback(e));
    },

    on(event, callback) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);

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

  // ─── Solana Provider (Bitget Solana) ───────────────────────────────────────
  const fastarxSolanaProvider = {
    isBitKeep: true,
    isBitget: true,
    isPhantom: true,

    get publicKey() {
      return _solAddress ? new FakeSolanaPublicKey(_solAddress) : null;
    },

    get isConnected() {
      return _solConnected;
    },

    async connect(options = {}) {
      if (options.onlyIfTrusted && _solConnected && _solAddress) {
        return { publicKey: this.publicKey };
      }
      const result = await sendSolanaRequest('solana_requestAccounts', []);
      if (result && result[0]) {
        _solAddress = result[0];
        _solConnected = true;
        sessionStorage.setItem('__sol_cache_addr__', result[0]);
        emitSolana('connect', this.publicKey);
        return { publicKey: this.publicKey };
      }
      throw new Error('User rejected the connection request');
    },

    async disconnect() {
      _solAddress = null;
      _solConnected = false;
      sessionStorage.removeItem('__sol_cache_addr__');
      emitSolana('disconnect');
      window.postMessage({
        channel: SOLANA_FASTARX_CHANNEL + '_dapp_disconnect',
        origin: window.location.origin,
        reason: 'wallet_disconnect'
      }, '*');
    },

    async signTransaction(transaction) {
      let rawBytes;
      if (typeof transaction.serialize === 'function') {
        try {
          rawBytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
        } catch (e) {
          rawBytes = transaction.serialize();
        }
      } else {
        throw new Error('Invalid transaction object passed to signTransaction');
      }

      const txHex = bufToHex(rawBytes);
      const result = await sendSolanaRequest('solana_signTransaction', [txHex]);
      if (!result || !result.signedTxHex) {
        throw new Error('User rejected or signing failed');
      }

      const signedBytes = hexToBuf(result.signedTxHex);
      const signedTx = transaction.constructor.deserialize 
        ? transaction.constructor.deserialize(signedBytes)
        : transaction.constructor.from(signedBytes);

      return signedTx;
    },

    async signAllTransactions(transactions) {
      const signed = [];
      for (const tx of transactions) {
        signed.push(await this.signTransaction(tx));
      }
      return signed;
    },

    async signMessage(message, encoding = 'utf8') {
      let messageHex;
      if (message instanceof Uint8Array) {
        messageHex = bufToHex(message);
      } else {
        messageHex = bufToHex(new TextEncoder().encode(message));
      }

      const result = await sendSolanaRequest('solana_signMessage', [messageHex]);
      if (!result || !result.signatureHex) {
        throw new Error('User rejected or signing failed');
      }

      const signature = hexToBuf(result.signatureHex);
      return {
        signature,
        publicKey: this.publicKey
      };
    },

    async request({ method, params = [] }) {
      return await sendSolanaRequest(method, params);
    },

    on(event, callback) {
      if (!solanaListeners[event]) solanaListeners[event] = [];
      solanaListeners[event].push(callback);
      return this;
    },

    removeListener(event, callback) {
      if (solanaListeners[event]) {
        solanaListeners[event] = solanaListeners[event].filter(x => x !== callback);
      }
      return this;
    },

    addListener(event, callback) {
      return this.on(event, callback);
    },

    off(event, callback) {
      return this.removeListener(event, callback);
    }
  };

  // ─── Inject ke window.ethereum & window.solana & window.bitkeep ───────────
  try {
    Object.defineProperty(window, 'ethereum', {
      value: fastarxProvider,
      writable: false,
      configurable: true
    });
  } catch (e) {
    try { window.ethereum = fastarxProvider; } catch (e2) {}
  }

  try {
    Object.defineProperty(window, 'solana', {
      value: fastarxSolanaProvider,
      writable: false,
      configurable: true
    });
  } catch (e) {
    try { window.solana = fastarxSolanaProvider; } catch (e2) {}
  }

  try {
    window.isBitKeep = true;
    if (!window.bitkeep) window.bitkeep = {};
    window.bitkeep.ethereum = fastarxProvider;
    window.bitkeep.solana = fastarxSolanaProvider;

    window.isBitget = true;
    if (!window.bitget) window.bitget = {};
    window.bitget.ethereum = fastarxProvider;
    window.bitget.solana = fastarxSolanaProvider;
    window.bitgetSolana = fastarxSolanaProvider;
  } catch (e) {}

  // ─── AUTO-RESTORE SESSION saat page reload (Double Check dengan Bot) ─────
  async function autoRestoreSession() {
    try {
      const accounts = await sendRequest('eth_accounts', [], 5000);

      if (accounts && accounts.length > 0) {
        const chainId = await sendRequest('eth_chainId', [], 5000);
        
        const oldAccount = _accounts[0];
        const oldChain = _chainId;

        _updateCache(accounts, chainId);

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
    } catch (e) {}
  }

  async function autoRestoreSolanaSession() {
    try {
      const result = await sendSolanaRequest('solana_accounts', [], 5000);
      if (result && result[0]) {
        const oldAddr = _solAddress;
        _solAddress = result[0];
        _solConnected = true;
        sessionStorage.setItem('__sol_cache_addr__', result[0]);
        if (oldAddr !== result[0]) {
          emitSolana('accountChanged', new FakeSolanaPublicKey(result[0]));
        }
      } else {
        if (_solConnected) {
          _solAddress = null;
          _solConnected = false;
          sessionStorage.removeItem('__sol_cache_addr__');
          emitSolana('disconnect');
        }
      }
    } catch (e) {}
  }

  // Emit event connect jika cache sudah ada sejak detik pertama
  if (_connected && _chainId) {
    setTimeout(() => {
      emit('connect', { chainId: _chainId });
    }, 100);
  }

  if (_solConnected && _solAddress) {
    setTimeout(() => {
      emitSolana('connect', new FakeSolanaPublicKey(_solAddress));
    }, 100);
  }

  // Jalankan verifikasi ke bot secara berkala (setiap 5 detik) untuk mendeteksi disconnect otomatis
  setTimeout(() => {
    autoRestoreSession();
    autoRestoreSolanaSession();

    // Jalankan pooling berkala
    setInterval(() => {
      autoRestoreSession();
      autoRestoreSolanaSession();
    }, 5000);
  }, 150);

  // ─── EIP-6963: Multi-provider announcement (EVM) ──────────────────────────
  function announceProvider() {
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: crypto.randomUUID ? crypto.randomUUID() : 'ec519c72-911e-450e-ac63-47209774618e',
        name: 'Bitget Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMDAwMDAwIi8+PHBhdGggZD0iTTM1IDMyTDYzIDY0TDM1IDk2SDU3TDg1IDY0TDU3IDMySDM1WiIgZmlsbD0iIzAwRjBGRiIvPjxwYXRoIGQ9Ik02MCAzMkw4OCA2NEw2MCA5Nkg4MkwxMTAgNjRMODIgMzJINjBaIiBmaWxsPSIjMDBGMEZGIi8+PC9zdmc+',
        rdns: 'com.bitkeep.wallet'
      }),
      provider: fastarxProvider
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  }

  window.addEventListener('eip6963:requestProvider', announceProvider);
  announceProvider();

})();
