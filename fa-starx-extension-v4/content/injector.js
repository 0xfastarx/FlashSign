/**
 * FA STARX v4 - Content Script (injector.js)
 * Inject ethereum-provider.js ke page context, bridge RPC ke background
 */

const FASTARX_CHANNEL = 'fastarx_rpc_v4';

// ─── 1. Inject provider ke page context ─────────────────────────────────────
(function injectProvider() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/ethereum-provider.js');
  (document.head || document.documentElement).insertBefore(
    script,
    (document.head || document.documentElement).firstChild
  );
  script.onload = () => script.remove();
})();

// ─── 2. Bridge: Page → Background ───────────────────────────────────────────
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.channel !== FASTARX_CHANNEL) return;

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
        error: { code: -32603, message: 'FA STARX: No response from background' }
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
});

// ─── 3. Relay events background → page ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROVIDER_EVENT') {
    window.postMessage({
      channel: FASTARX_CHANNEL + '_event',
      event: message.event,
      data: message.data
    }, '*');
  }
});

console.log('[FA STARX v4] Content script ready:', window.location.origin);
