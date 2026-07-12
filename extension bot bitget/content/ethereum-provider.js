/**
 * MetaMask/Bitget - Ethereum, Solana & Aptos Provider Spoofing
 * Diinject ke page context DApp — override window.ethereum & window.solana
 * + AIP-62 wallet-standard registration untuk Aptos
 * Berjalan di MAIN world secara sinkron saat document_start.
 */
(function () {
  if (window.__METAMASK_INJECTED_PROV__) return;
  window.__METAMASK_INJECTED_PROV__ = true;

  const FASTARX_CHANNEL = 'ethereum_provider_rpc_v4';
  const SOLANA_FASTARX_CHANNEL = 'solana_provider_rpc_v4';
  const APTOS_FASTARX_CHANNEL = 'aptos_provider_rpc_v4';
  const TON_FASTARX_CHANNEL = 'ton_provider_rpc_v1';

  const pendingRequests = new Map();
  let requestId = 1;

  const pendingSolanaRequests = new Map();
  let solanaRequestId = 1;

  const pendingAptosRequests = new Map();
  let aptosRequestId = 1;

  const pendingTonRequests = new Map();
  let tonRequestId = 1;

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

    if (event.data.channel === APTOS_FASTARX_CHANNEL + '_response') {
      const { id, result, error } = event.data;
      const pending = pendingAptosRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingAptosRequests.delete(id);
      if (error) {
        const err = new Error(error.message || 'RPC Error');
        err.code = error.code || -32603;
        pending.reject(err);
      } else {
        pending.resolve(result);
      }
    }

    if (event.data.channel === TON_FASTARX_CHANNEL + '_response') {
      const { id, result, error } = event.data;
      const pending = pendingTonRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingTonRequests.delete(id);
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

    if (event.data.channel === APTOS_FASTARX_CHANNEL + '_event') {
      emitAptos(event.data.event, event.data.data);
    }

    if (event.data.channel === TON_FASTARX_CHANNEL + '_event') {
      emitTon(event.data.event, event.data.data);
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

  // ─── Event emitter Aptos ──────────────────────────────────────────────────
  const aptosListeners = {};
  function emitAptos(event, ...args) {
    (aptosListeners[event] || []).forEach(fn => { try { fn(...args); } catch(e) {} });
  }

  // ─── Event emitter TON ────────────────────────────────────────────────────
  const tonListeners = {};
  function emitTon(event, ...args) {
    (tonListeners[event] || []).forEach(fn => { try { fn(...args); } catch(e) {} });
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

  // ─── Send RPC request (Aptos) ──────────────────────────────────────────────
  function sendAptosRequest(method, params = [], timeoutMs = 30000) {
    console.log('[0xfastarx] 📤 Aptos request initiated:', method, params);
    return new Promise((resolve, reject) => {
      const id = aptosRequestId++;
      const timer = setTimeout(() => {
        if (pendingAptosRequests.has(id)) {
          console.warn('[0xfastarx] ⏳ Aptos request timeout for method:', method);
          pendingAptosRequests.delete(id);
          reject(new Error('Aptos: Request timeout'));
        }
      }, timeoutMs);
      pendingAptosRequests.set(id, {
        resolve: (val) => {
          console.log('[0xfastarx] 📥 Aptos request succeeded:', method, val);
          resolve(val);
        },
        reject: (err) => {
          console.error('[0xfastarx] ❌ Aptos request rejected/failed:', method, err);
          reject(err);
        },
        timer
      });
      window.postMessage({ channel: APTOS_FASTARX_CHANNEL, id, method, params }, '*');
    });
  }

  // ─── Send RPC request (TON) ────────────────────────────────────────────────
  function sendTonRequest(method, params = [], timeoutMs = 60000) {
    console.log('[0xfastarx] 📤 TON request initiated:', method, params);
    return new Promise((resolve, reject) => {
      const id = tonRequestId++;
      const timer = setTimeout(() => {
        if (pendingTonRequests.has(id)) {
          console.warn('[0xfastarx] ⏳ TON request timeout for method:', method);
          pendingTonRequests.delete(id);
          reject(new Error('TON: Request timeout'));
        }
      }, timeoutMs);
      pendingTonRequests.set(id, {
        resolve: (val) => {
          console.log('[0xfastarx] 📥 TON request succeeded:', method, val);
          resolve(val);
        },
        reject: (err) => {
          console.error('[0xfastarx] ❌ TON request rejected/failed:', method, err);
          reject(err);
        },
        timer
      });
      window.postMessage({ channel: TON_FASTARX_CHANNEL, id, method, params }, '*');
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

  // ─── Aptos Provider (Bitget Aptos + Legacy & AIP-62) ────────────────────────
  let _aptosAddress = sessionStorage.getItem('__aptos_cache_addr__') || null;
  let _aptosPublicKey = sessionStorage.getItem('__aptos_cache_pubkey__') || null;
  let _aptosConnected = !!_aptosAddress;
  let _aptosNetwork = sessionStorage.getItem('__aptos_cache_network__') || 'Mainnet';

  const fastarxAptosProvider = {
    isPetra: true,
    async connect() {
      const result = await sendAptosRequest('aptos_requestAccounts', []);
      if (result && result.address) {
        _aptosAddress = result.address;
        _aptosPublicKey = result.publicKey;
        _aptosConnected = true;
        sessionStorage.setItem('__aptos_cache_addr__', result.address);
        if (result.publicKey) sessionStorage.setItem('__aptos_cache_pubkey__', result.publicKey);
        emitAptos('connect', { address: _aptosAddress, publicKey: _aptosPublicKey });
        return { address: _aptosAddress, publicKey: _aptosPublicKey };
      }
      throw new Error('User rejected the connection request');
    },

    async disconnect() {
      _aptosAddress = null;
      _aptosPublicKey = null;
      _aptosConnected = false;
      sessionStorage.removeItem('__aptos_cache_addr__');
      sessionStorage.removeItem('__aptos_cache_pubkey__');
      emitAptos('disconnect');
      window.postMessage({
        channel: APTOS_FASTARX_CHANNEL + '_dapp_disconnect',
        origin: window.location.origin,
        reason: 'wallet_disconnect'
      }, '*');
    },

    async isConnected() {
      return _aptosConnected;
    },

    async account() {
      if (!_aptosConnected || !_aptosAddress) {
        throw new Error('Wallet not connected');
      }
      return { address: _aptosAddress, publicKey: _aptosPublicKey };
    },

    async network() {
      return _aptosNetwork;
    },

    async getAccount() {
      return this.account();
    },

    async getNetwork() {
      return this.network();
    },

    async signAndSubmitTransaction(transaction) {
      const signed = await this.signTransaction(transaction);
      throw new Error('signAndSubmitTransaction not supported. Please sign and submit transaction via your DApp adapter.');
    },

    async signTransaction(transaction) {
      let rawBytes;
      let txType = 'SimpleTransaction';
      if (transaction && typeof transaction.bcsToBytes === 'function') {
        rawBytes = transaction.bcsToBytes();
        txType = transaction.constructor.name || 'SimpleTransaction';
      } else if (transaction && typeof transaction.serialize === 'function') {
        rawBytes = transaction.serialize();
      } else {
        rawBytes = transaction;
      }

      if (!rawBytes) {
        throw new Error('Invalid transaction object passed to signTransaction');
      }

      const txHex = bufToHex(rawBytes);
      const result = await sendAptosRequest('aptos_signTransaction', [txHex, txType]);
      if (!result || !result.signedTxHex) {
        throw new Error('User rejected or signing failed');
      }

      const authBytes = hexToBuf(result.signedTxHex);
      const publicKeyHex = bufToHex(authBytes.slice(2, 2 + 32));
      const signatureHex = bufToHex(authBytes.slice(2 + 32 + 1, 2 + 32 + 1 + 64));

      const authenticator = {
        public_key: {
          toUint8Array: () => authBytes.slice(2, 2 + 32),
          toString: () => '0x' + publicKeyHex,
          bcsToBytes: () => {
            const res = new Uint8Array(33);
            res[0] = 32;
            res.set(authBytes.slice(2, 2 + 32), 1);
            return res;
          },
          serialize: (serializer) => {
            serializer.serializeBytes(authBytes.slice(2, 2 + 32));
          }
        },
        signature: {
          toUint8Array: () => authBytes.slice(2 + 32 + 1),
          toString: () => '0x' + signatureHex,
          bcsToBytes: () => {
            const res = new Uint8Array(65);
            res[0] = 64;
            res.set(authBytes.slice(2 + 32 + 1), 1);
            return res;
          },
          serialize: (serializer) => {
            serializer.serializeBytes(authBytes.slice(2 + 32 + 1));
          }
        },
        bcsToBytes: () => authBytes,
        serialize: (serializer) => {
          serializer.serializeU32AsUleb128(0);
          serializer.serialize(authenticator.public_key);
          serializer.serialize(authenticator.signature);
        }
      };

      return authenticator;
    },

    async signMessage(payload) {
      if (!payload || !payload.message) {
        throw new Error('Invalid message payload');
      }

      let msgParts = [];
      msgParts.push("APTOS");
      if (payload.address && _aptosAddress) msgParts.push(`address: ${_aptosAddress}`);
      if (payload.application) msgParts.push(`application: ${window.location.origin}`);
      if (payload.chainId) msgParts.push(`chainId: ${_aptosNetwork === 'Mainnet' ? 1 : 2}`);
      msgParts.push(`message: ${payload.message}`);
      msgParts.push(`nonce: ${payload.nonce}`);
      
      const fullMessage = msgParts.join('\n');
      const messageHex = bufToHex(new TextEncoder().encode(fullMessage));

      const result = await sendAptosRequest('aptos_signMessage', [messageHex]);
      if (!result || !result.signatureHex) {
        throw new Error('User rejected or signing failed');
      }

      return {
        address: _aptosAddress,
        application: window.location.origin,
        chainId: _aptosNetwork === 'Mainnet' ? 1 : 2,
        fullMessage,
        message: payload.message,
        nonce: payload.nonce,
        prefix: "APTOS",
        signature: result.signatureHex
      };
    },

    on(event, callback) {
      if (!aptosListeners[event]) aptosListeners[event] = [];
      aptosListeners[event].push(callback);
      return this;
    },

    removeListener(event, callback) {
      if (aptosListeners[event]) {
        aptosListeners[event] = aptosListeners[event].filter(x => x !== callback);
      }
      return this;
    },

    onAccountChange(callback) {
      return this.on('accountChanged', callback);
    },

    onNetworkChange(callback) {
      return this.on('networkChanged', callback);
    }
  };

  // Register Wallet standard untuk AIP-62
  class RegisterWalletEvent extends Event {
    constructor(callback) {
      super('wallet-standard:register-wallet', {
        bubbles: false,
        cancelable: false,
        composed: false,
      });
      this._detail = callback;
    }
    get detail() { return this._detail; }
  }

  function registerAptosStandardWallet() {
    const walletAccount = {
      get address() { return _aptosAddress; },
      get publicKey() { return _aptosPublicKey ? hexToBuf(_aptosPublicKey) : new Uint8Array(); },
      chains: ['aptos:mainnet', 'aptos:testnet', 'aptos:devnet'],
      features: ['aptos:connect', 'aptos:disconnect', 'aptos:signTransaction', 'aptos:signMessage'],
      label: 'Petra',
      signingScheme: 0, // Ed25519
    };

    const wallet = {
      version: '1.0.0',
      name: 'Petra',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiB2aWV3Qm94PSIwIDAgMTI4IDEyOCI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyNiIgZmlsbD0iI0VBNDMzNSIvPjxwYXRoIGQ9Ik00MiA5NlYzMmgyN2MxNiAwIDI3IDEwIDI3IDIzcy0xMSAyMy0yNyAyM0g1N3YxOEg0MnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=',
      chains: ['aptos:mainnet', 'aptos:testnet', 'aptos:devnet'],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            const acc = await fastarxAptosProvider.connect();
            return { accounts: [walletAccount] };
          }
        },
        'standard:disconnect': {
          version: '1.0.0',
          disconnect: async () => {
            await fastarxAptosProvider.disconnect();
          }
        },
        'standard:events': {
          version: '1.0.0',
          on: (event, listener) => {
            fastarxAptosProvider.on(event, listener);
            return () => fastarxAptosProvider.removeListener(event, listener);
          }
        },
        'aptos:connect': {
          version: '1.0.0',
          connect: async (input) => {
            const acc = await fastarxAptosProvider.connect();
            return {
              status: 'Approved',
              args: {
                address: acc.address,
                publicKey: _aptosPublicKey ? hexToBuf(_aptosPublicKey) : new Uint8Array(),
              }
            };
          }
        },
        'aptos:disconnect': {
          version: '1.0.0',
          disconnect: async () => {
            await fastarxAptosProvider.disconnect();
          }
        },
        'aptos:signTransaction': {
          version: '1.0.0',
          signTransaction: async (transaction, asFeePayer) => {
            const authenticator = await fastarxAptosProvider.signTransaction(transaction);
            return {
              status: 'Approved',
              args: authenticator
            };
          }
        },
        'aptos:signMessage': {
          version: '1.0.0',
          signMessage: async (input) => {
            const response = await fastarxAptosProvider.signMessage(input);
            return {
              status: 'Approved',
              args: response
            };
          }
        },
        'aptos:account': {
          version: '1.0.0',
          account: async () => {
            return {
              address: _aptosAddress,
              publicKey: _aptosPublicKey ? hexToBuf(_aptosPublicKey) : new Uint8Array(),
            };
          }
        },
        'aptos:network': {
          version: '1.0.0',
          network: async () => {
            return {
              name: _aptosNetwork.toLowerCase(),
              chainId: _aptosNetwork.toLowerCase() === 'mainnet' ? 1 : (_aptosNetwork.toLowerCase() === 'testnet' ? 2 : 99),
              url: _aptosNetwork.toLowerCase() === 'mainnet' 
                ? 'https://fullnode.mainnet.aptoslabs.com/v1' 
                : 'https://fullnode.testnet.aptoslabs.com/v1'
            };
          }
        },
        'aptos:onAccountChange': {
          version: '1.0.0',
          onAccountChange: (listener) => {
            fastarxAptosProvider.on('accountChanged', listener);
            return () => fastarxAptosProvider.removeListener('accountChanged', listener);
          }
        },
        'aptos:onNetworkChange': {
          version: '1.0.0',
          onNetworkChange: (listener) => {
            fastarxAptosProvider.on('networkChanged', listener);
            return () => fastarxAptosProvider.removeListener('networkChanged', listener);
          }
        }
      },
      get accounts() {
        return _aptosConnected && _aptosAddress ? [walletAccount] : [];
      },
    };

    const callback = ({ register }) => register(wallet);
    try {
      window.dispatchEvent(new RegisterWalletEvent(callback));
    } catch (e) {}
    try {
      window.addEventListener('wallet-standard:app-ready', ({ detail: api }) => callback(api));
    } catch (e) {}

    try {
      window.navigator.wallets = window.navigator.wallets || [];
      window.navigator.wallets.push(({ register }) => register(wallet));
    } catch (e) {}
  }

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
    Object.defineProperty(window, 'aptos', {
      value: fastarxAptosProvider,
      writable: false,
      configurable: true
    });
  } catch (e) {
    try { window.aptos = fastarxAptosProvider; } catch (e2) {}
  }

  // ─── Inject sebagai Petra Wallet (DApp Aptos selalu prioritas Petra) ─────
  try {
    Object.defineProperty(window, 'petra', {
      value: fastarxAptosProvider,
      writable: false,
      configurable: true
    });
  } catch (e) {
    try { window.petra = fastarxAptosProvider; } catch (e2) {}
  }

  try {
    window.isBitKeep = true;
    if (!window.bitkeep) window.bitkeep = {};
    window.bitkeep.ethereum = fastarxProvider;
    window.bitkeep.solana = fastarxSolanaProvider;
    window.bitkeep.aptos = fastarxAptosProvider;

    window.isBitget = true;
    if (!window.bitget) window.bitget = {};
    window.bitget.ethereum = fastarxProvider;
    window.bitget.solana = fastarxSolanaProvider;
    window.bitget.aptos = fastarxAptosProvider;
    window.bitgetSolana = fastarxSolanaProvider;
  } catch (e) {}

  registerAptosStandardWallet();

  // ═══════════════════════════════════════════════════════════════════════════
  // ── TON CONNECT BRIDGE PROVIDER (TonConnect v2) ────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let _tonAddress = sessionStorage.getItem('__ton_cache_addr__') || null;
  let _tonUserFriendlyAddress = sessionStorage.getItem('__ton_cache_uf_addr__') || null;
  let _tonPublicKey = sessionStorage.getItem('__ton_cache_pubkey__') || null;
  let _tonStateInit = sessionStorage.getItem('__ton_cache_state_init__') || null;
  let _tonConnected = !!_tonAddress;
  const _tonListenCallbacks = [];

  function _notifyTonListeners(event) {
    _tonListenCallbacks.forEach(cb => { try { cb(event); } catch(e) {} });
  }

  function createTonProvider(appName) {
    const devInfo = {
      platform: 'browser',
      appName: appName,
      appVersion: '1.0.0',
      maxProtocolVersion: 2,
      features: [
        'SendTransaction',
        { name: 'SendTransaction', maxMessages: 4 }
      ]
    };

    return {
      deviceInfo: devInfo,
      protocolVersion: 2,
      isWalletBrowser: false,

      async connect(protocolVersion, message) {
        console.log(`[TON Connect - ${appName}] 🔗 connect() called`);
        try {
          const result = await sendTonRequest('ton_connect', [{ protocolVersion, message, isInteractive: true }]);
          if (!result || !result.address) {
            const errorEvent = {
              event: 'connect_error',
              id: Date.now(),
              payload: { code: 1, message: 'Wallet not available' }
            };
            _notifyTonListeners(errorEvent);
            return errorEvent;
          }

          _tonAddress = result.address;
          _tonUserFriendlyAddress = result.userFriendlyAddress;
          _tonPublicKey = result.publicKey;
          _tonStateInit = result.walletStateInit;
          _tonConnected = true;

          sessionStorage.setItem('__ton_cache_addr__', _tonAddress);
          sessionStorage.setItem('__ton_cache_uf_addr__', _tonUserFriendlyAddress);
          sessionStorage.setItem('__ton_cache_pubkey__', _tonPublicKey);
          if (_tonStateInit) sessionStorage.setItem('__ton_cache_state_init__', _tonStateInit);

          const connectItems = [];
          if (message && message.items) {
            for (const item of message.items) {
              if (item.name === 'ton_addr') {
                connectItems.push({
                  name: 'ton_addr',
                  address: _tonAddress,
                  network: '-239',
                  publicKey: _tonPublicKey,
                  walletStateInit: _tonStateInit || ''
                });
              }
              if (item.name === 'ton_proof') {
                connectItems.push({
                  name: 'ton_proof',
                  proof: {
                    timestamp: Math.floor(Date.now() / 1000),
                    domain: {
                      lengthBytes: window.location.hostname.length,
                      value: window.location.hostname
                    },
                    payload: item.payload || '',
                    signature: ''
                  }
                });
              }
            }
          }
          if (connectItems.length === 0) {
            connectItems.push({
              name: 'ton_addr',
              address: _tonAddress,
              network: '-239',
              publicKey: _tonPublicKey,
              walletStateInit: _tonStateInit || ''
            });
          }

          const successEvent = {
            event: 'connect',
            id: Date.now(),
            payload: {
              items: connectItems,
              device: devInfo
            }
          };

          console.log(`[TON Connect - ${appName}] ✅ Connected:`, _tonAddress);
          _notifyTonListeners(successEvent);
          return successEvent;
        } catch (err) {
          console.error(`[TON Connect - ${appName}] ❌ connect error:`, err);
          const errorEvent = {
            event: 'connect_error',
            id: Date.now(),
            payload: { code: 1, message: err.message || 'Connection failed' }
          };
          _notifyTonListeners(errorEvent);
          return errorEvent;
        }
      },

      async restoreConnection() {
        console.log(`[TON Connect - ${appName}] 🔄 restoreConnection() called`);
        if (_tonConnected && _tonAddress) {
          const event = {
            event: 'connect',
            id: Date.now(),
            payload: {
              items: [{
                name: 'ton_addr',
                address: _tonAddress,
                network: '-239',
                publicKey: _tonPublicKey,
                walletStateInit: _tonStateInit || ''
              }],
              device: devInfo
            }
          };
          _notifyTonListeners(event);
          return event;
        }

        if (!sessionStorage.getItem('__ton_cache_addr__')) {
          console.log(`[TON Connect - ${appName}] No session cache found, skipping restoreConnection`);
          return null;
        }

        try {
          const result = await sendTonRequest('ton_connect', [{ protocolVersion: 2, message: { items: [{ name: 'ton_addr' }] }, isInteractive: false }]);
          if (result && result.address) {
            _tonAddress = result.address;
            _tonUserFriendlyAddress = result.userFriendlyAddress;
            _tonPublicKey = result.publicKey;
            _tonStateInit = result.walletStateInit;
            _tonConnected = true;

            sessionStorage.setItem('__ton_cache_addr__', _tonAddress);
            sessionStorage.setItem('__ton_cache_uf_addr__', _tonUserFriendlyAddress);
            sessionStorage.setItem('__ton_cache_pubkey__', _tonPublicKey);
            if (_tonStateInit) sessionStorage.setItem('__ton_cache_state_init__', _tonStateInit);

            const event = {
              event: 'connect',
              id: Date.now(),
              payload: {
                items: [{
                  name: 'ton_addr',
                  address: _tonAddress,
                  network: '-239',
                  publicKey: _tonPublicKey,
                  walletStateInit: _tonStateInit || ''
                }],
                device: devInfo
              }
            };
            _notifyTonListeners(event);
            return event;
          }
        } catch (e) {
          console.log(`[TON Connect - ${appName}] restoreConnection failed:`, e.message);
        }
        return null;
      },

      async send(message) {
        console.log(`[TON Connect - ${appName}] 📤 send() called:`, message);
        if (!_tonConnected) {
          return {
            error: { code: 100, message: 'Unknown app' }
          };
        }

        const appRequest = typeof message === 'string' ? JSON.parse(message) : message;
        try {
          const result = await sendTonRequest('ton_send', [appRequest]);
          console.log(`[TON Connect - ${appName}] ✅ send() result:`, result);
          return {
            result: typeof result === 'string' ? result : JSON.stringify(result),
            id: String(appRequest.id || Date.now())
          };
        } catch (err) {
          console.error(`[TON Connect - ${appName}] ❌ send() error:`, err);
          if (err.message && err.message.includes('User rejected')) {
            return {
              error: { code: 300, message: 'User declined the transaction' },
              id: String(appRequest.id || Date.now())
            };
          }
          return {
            error: { code: 0, message: err.message || 'Unknown error' },
            id: String(appRequest.id || Date.now())
          };
        }
      },

      listen(callback) {
        console.log(`[TON Connect - ${appName}] 👂 listen() registered`);
        _tonListenCallbacks.push(callback);
        return () => {
          const idx = _tonListenCallbacks.indexOf(callback);
          if (idx >= 0) _tonListenCallbacks.splice(idx, 1);
        };
      },

      async disconnect() {
        console.log(`[TON Connect - ${appName}] 🔌 disconnect() called`);
        _tonAddress = null;
        _tonUserFriendlyAddress = null;
        _tonPublicKey = null;
        _tonStateInit = null;
        _tonConnected = false;

        sessionStorage.removeItem('__ton_cache_addr__');
        sessionStorage.removeItem('__ton_cache_uf_addr__');
        sessionStorage.removeItem('__ton_cache_pubkey__');
        sessionStorage.removeItem('__ton_cache_state_init__');

        const disconnectEvent = {
          event: 'disconnect',
          id: Date.now(),
          payload: {}
        };
        _notifyTonListeners(disconnectEvent);

        window.postMessage({
          channel: TON_FASTARX_CHANNEL + '_dapp_disconnect',
          origin: window.location.origin,
          reason: 'wallet_disconnect'
        }, '*');
      }
    };
  }

  const tonkeeperProvider = createTonProvider('tonkeeper');
  const bitgetTonWalletProvider = createTonProvider('bitgetTonWallet');

  function _injectTonBridge(windowKey, provider) {
    try {
      const bridgeObj = { tonconnect: provider };
      Object.defineProperty(window, windowKey, {
        value: bridgeObj,
        writable: true,
        configurable: true,
        enumerable: true
      });
      console.log(`[0xfastarx] Successfully defined window.${windowKey}`);
    } catch (e) {
      console.error(`[0xfastarx] Error defining window.${windowKey}:`, e);
      try {
        window[windowKey] = { tonconnect: provider };
      } catch (e2) {}
    }
  }

  _injectTonBridge('tonkeeper', tonkeeperProvider);
  _injectTonBridge('bitgetTonWallet', bitgetTonWalletProvider);

  try {
    Object.defineProperty(window, 'tonconnect', {
      value: tonkeeperProvider,
      writable: true,
      configurable: true
    });
  } catch (e) {
    try { window.tonconnect = tonkeeperProvider; } catch (e2) {}
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
        if (_solConnected && !sessionStorage.getItem('__sol_cache_addr__')) {
          _solAddress = null;
          _solConnected = false;
          emitSolana('disconnect');
        }
      }
    } catch (e) {}
  }

  async function autoRestoreAptosSession() {
    try {
      const result = await sendAptosRequest('aptos_accounts', [], 5000);
      if (result && result.address) {
        const oldAddr = _aptosAddress;
        _aptosAddress = result.address;
        _aptosPublicKey = result.publicKey;
        _aptosConnected = true;
        sessionStorage.setItem('__aptos_cache_addr__', result.address);
        if (result.publicKey) sessionStorage.setItem('__aptos_cache_pubkey__', result.publicKey);
        if (oldAddr !== result.address) {
          emitAptos('accountChanged', { address: result.address, publicKey: result.publicKey });
        }
      } else {
        if (_aptosConnected && !sessionStorage.getItem('__aptos_cache_addr__')) {
          _aptosAddress = null;
          _aptosPublicKey = null;
          _aptosConnected = false;
          emitAptos('disconnect');
        }
      }
    } catch (e) {}
  }

  async function autoRestoreTonSession() {
    // Hanya restore jika sudah pernah connect sebelumnya (ada cache)
    if (!sessionStorage.getItem('__ton_cache_addr__')) return;
    try {
      const result = await sendTonRequest('ton_connect', [{ protocolVersion: 2, message: { items: [{ name: 'ton_addr' }] }, isInteractive: false }], 5000);
      if (result && result.address) {
        const oldAddr = _tonAddress;
        _tonAddress = result.address;
        _tonUserFriendlyAddress = result.userFriendlyAddress;
        _tonPublicKey = result.publicKey;
        _tonStateInit = result.walletStateInit;
        _tonConnected = true;

        sessionStorage.setItem('__ton_cache_addr__', _tonAddress);
        sessionStorage.setItem('__ton_cache_uf_addr__', _tonUserFriendlyAddress);
        sessionStorage.setItem('__ton_cache_pubkey__', _tonPublicKey);
        if (_tonStateInit) sessionStorage.setItem('__ton_cache_state_init__', _tonStateInit);
      } else {
        if (_tonConnected) {
          _tonAddress = null;
          _tonUserFriendlyAddress = null;
          _tonPublicKey = null;
          _tonStateInit = null;
          _tonConnected = false;
          sessionStorage.removeItem('__ton_cache_addr__');
          sessionStorage.removeItem('__ton_cache_uf_addr__');
          sessionStorage.removeItem('__ton_cache_pubkey__');
          sessionStorage.removeItem('__ton_cache_state_init__');
          _notifyTonListeners({ event: 'disconnect', id: Date.now(), payload: {} });
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

  if (_aptosConnected && _aptosAddress) {
    setTimeout(() => {
      emitAptos('connect', { address: _aptosAddress, publicKey: _aptosPublicKey });
    }, 100);
  }

  if (_tonConnected && _tonAddress) {
    setTimeout(() => {
      _notifyTonListeners({
        event: 'connect',
        id: Date.now(),
        payload: {
          items: [{
            name: 'ton_addr',
            address: _tonAddress,
            network: '-239',
            publicKey: _tonPublicKey,
            walletStateInit: _tonStateInit || ''
          }],
          device: fastarxTonProvider.deviceInfo
        }
      });
    }, 100);
  }

  // Jalankan verifikasi ke bot secara berkala (setiap 5 detik) untuk mendeteksi disconnect otomatis
  setTimeout(() => {
    autoRestoreSession();
    autoRestoreSolanaSession();
    autoRestoreAptosSession();
    autoRestoreTonSession();

    // Jalankan pooling berkala
    setInterval(() => {
      autoRestoreSession();
      autoRestoreSolanaSession();
      autoRestoreAptosSession();
      autoRestoreTonSession();
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

