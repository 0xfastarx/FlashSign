/**
 * 0xfastarx - Content Script (injector.js)
 * Berjalan di ISOLATED world.
 * Bertindak sebagai bridge/jembatan komunikasi antara page context (MAIN world) dan background service worker.
 */

const FASTARX_CHANNEL = 'fastarx_rpc_v4';

// ─── 1. Bridge: Page (MAIN world) → Background (RPC requests) ───────────────
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data) return;

  // ── RPC Request dari ethereum-provider.js ────────────────────────────────
  if (event.data.channel === FASTARX_CHANNEL) {
    const { id, method, params } = event.data;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'rpcRequest',
        id,
        method,
        params,
        origin: window.location.origin
      });

      if (!response) {
        window.postMessage({
          channel: FASTARX_CHANNEL + '_response',
          id,
          error: { code: -32603, message: '0xfastarx: No response from background' }
        }, '*');
        return;
      }

      window.postMessage({
        channel: FASTARX_CHANNEL + '_response',
        id,
        result: response.result,
        error: response.error
      }, '*');

    } catch (err) {
      window.postMessage({
        channel: FASTARX_CHANNEL + '_response',
        id,
        error: { code: -32603, message: err.message || 'Extension error' }
      }, '*');
    }
    return;
  }

  // ── DApp Disconnect Event ─────────────────────────────────────────────────
  if (event.data.channel === FASTARX_CHANNEL + '_dapp_disconnect') {
    const { origin, reason } = event.data;
    console.log('[0xfastarx] 📤 Forwarding disconnect ke background:', origin, reason);

    try {
      await chrome.runtime.sendMessage({
        action: 'dappDisconnect',
        origin: origin || window.location.origin,
        reason: reason || 'unknown'
      });
    } catch (err) {
      console.warn('[0xfastarx] Gagal kirim disconnect ke background:', err.message);
    }
    return;
  }
});

// ─── 2. Relay events background → page ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROVIDER_EVENT') {
    window.postMessage({
      channel: FASTARX_CHANNEL + '_event',
      event: message.event,
      data: message.data
    }, '*');
  }
});

// ─── 3. Kirim notif ke background: ada tab baru yang load ───────────────────
chrome.runtime.sendMessage({ action: 'tabReady', origin: window.location.origin })
  .catch(() => {});

console.log('[0xfastarx] Bridge content script (ISOLATED) ready:', window.location.origin);
