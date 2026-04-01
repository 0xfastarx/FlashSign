'use strict';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function sendMsg(action, data) {
  data = data || {};
  return new Promise(function(resolve) {
    try {
      chrome.runtime.sendMessage(Object.assign({ action: action }, data), function(resp) {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

function toast(msg, type, ms) {
  type = type || 'ok';
  ms = ms || 2500;
  var el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  setTimeout(function() { el.classList.remove('show'); }, ms);
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var config = null;
var currentMode = 'localhost';

// ─── TAB / MODE ───────────────────────────────────────────────────────────────
window.switchTab = function(tab) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  $('screen-' + tab).classList.add('active');
  $('tab-' + tab).classList.add('active');
};

window.setMode = function(mode) {
  currentMode = mode;
  $('btnModeLocal').classList.toggle('active', mode === 'localhost');
  $('btnModeVps').classList.toggle('active', mode === 'vps');
  $('vpsHostSection').style.display = mode === 'vps' ? 'block' : 'none';
};

// ─── RENDER STATUS ────────────────────────────────────────────────────────────
async function renderStatus() {
  var results = await Promise.all([sendMsg('getStatus'), sendMsg('getConfig')]);
  var status = results[0];
  var cfg = results[1];
  config = cfg;

  var connected = status && status.connected;
  $('sStatus').textContent = connected ? '🟢 ONLINE' : '🔴 OFFLINE';
  $('sStatus').className   = connected ? 'ok' : 'err';

  $('sMode').textContent = cfg && cfg.mode === 'vps' ? '🌐 VPS' : '💻 Localhost';
  $('sMode').className   = 'ok';

  var host = (cfg && cfg.mode === 'vps' && cfg.vpsHost) ? cfg.vpsHost : '127.0.0.1';
  var port = (cfg && cfg.activePort) ? cfg.activePort : 8545;
  $('sHostPort').textContent = host + ':' + port;
  $('sHostPort').className   = connected ? 'ok' : 'dim';

  if (status && status.chainId) {
    var dec = parseInt(status.chainId, 16);
    $('sChainId').textContent = dec + ' (' + status.chainId + ')';
    $('sChainId').className   = 'ok';
  } else {
    $('sChainId').textContent = '—';
    $('sChainId').className   = 'dim';
  }

  if (status && status.address) {
    var a = status.address;
    $('sWallet').textContent = a.slice(0, 10) + '...' + a.slice(-8);
    $('sWallet').className   = 'card-value ok';
  } else {
    $('sWallet').textContent = 'Bot offline / wallet belum aktif';
    $('sWallet').className   = 'card-value dim';
  }
}

// ─── RENDER CONFIG ────────────────────────────────────────────────────────────
async function renderConfig() {
  if (!config) config = await sendMsg('getConfig');
  if (!config) return;
  window.setMode(config.mode || 'localhost');
  $('inputVpsHost').value = config.vpsHost || '';
  renderPortList();
}

function renderPortList() {
  if (!config) return;
  var list = $('portList');
  list.innerHTML = '';
  var ports = config.ports || [];

  ports.forEach(function(p) {
    var item = document.createElement('div');
    item.className = 'port-item' + (p.port === config.activePort ? ' selected' : '');
    item.dataset.port = p.port;

    var right = p.isPermanent
      ? '<span class="pi-perm">🔒</span>'
      : '<button class="pi-del" data-del="' + p.port + '">✕</button>';

    item.innerHTML =
      '<div class="pi-left">' +
        '<span class="pi-num">' + p.port + '</span>' +
        '<span class="pi-lbl">' + p.label + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px">' + right + '</div>';

    // Klik item = pilih port aktif
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('pi-del')) return;
      config.activePort = p.port;
      document.querySelectorAll('.port-item').forEach(function(el) {
        el.classList.toggle('selected', parseInt(el.dataset.port) === p.port);
      });
      toast('Port ' + p.port + ' dipilih', 'ok', 1500);
    });

    list.appendChild(item);
  });

  // Hapus port
  list.querySelectorAll('.pi-del').forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.stopPropagation();
      var port = parseInt(btn.dataset.del);
      var res = await sendMsg('removePort', { port: port });
      if (res && res.ok) {
        config = await sendMsg('getConfig');
        renderPortList();
        toast('Port ' + port + ' dihapus', 'ok');
      } else {
        toast((res && res.msg) ? res.msg : 'Gagal hapus port', 'err');
      }
    });
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  await renderStatus();
  await renderConfig();
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // Tab buttons
  $('tab-status').addEventListener('click', function() { switchTab('status'); });
  $('tab-config').addEventListener('click', function() { switchTab('config'); renderConfig(); });

  // Mode buttons
  $('btnModeLocal').addEventListener('click', function() { setMode('localhost'); });
  $('btnModeVps').addEventListener('click', function() { setMode('vps'); });

  // Refresh status
  $('btnRefresh').addEventListener('click', async function() {
    $('btnRefresh').disabled = true;
    $('btnRefresh').textContent = '⏳ Checking...';
    config = await sendMsg('getConfig');
    var status = await sendMsg('checkBot');
    await renderStatus();
    $('btnRefresh').disabled = false;
    $('btnRefresh').textContent = '🔄 Refresh Status';
    if (status && status.connected) {
      toast('Bot terdeteksi! ✅', 'ok');
    } else {
      toast('Bot tidak terdeteksi', 'err');
    }
  });

  // Tambah port
  $('btnAddPort').addEventListener('click', async function() {
    var portVal = $('inputNewPort').value.trim();
    var labelVal = $('inputNewPortLabel').value.trim();
    if (!portVal) { toast('Masukkan nomor port', 'err'); return; }
    var res = await sendMsg('addPort', {
      port: parseInt(portVal),
      label: labelVal || ('Port ' + portVal + ' (Custom)')
    });
    if (res && res.ok) {
      config = await sendMsg('getConfig');
      renderPortList();
      $('inputNewPort').value = '';
      $('inputNewPortLabel').value = '';
      toast('Port ' + portVal + ' ditambahkan!', 'ok');
    } else {
      toast((res && res.msg) ? res.msg : 'Gagal tambah port', 'err');
    }
  });

  // Enter di input port
  $('inputNewPort').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') $('btnAddPort').click();
  });

  // Simpan config
  $('btnSaveConfig').addEventListener('click', async function() {
    var vpsHost = $('inputVpsHost').value.trim();
    if (currentMode === 'vps' && !vpsHost) {
      toast('Masukkan IP/Host VPS terlebih dahulu', 'err');
      return;
    }
    var newConfig = Object.assign({}, config, {
      mode: currentMode,
      vpsHost: vpsHost,
      activePort: config ? (config.activePort || 8545) : 8545,
      ports: config ? (config.ports || []) : []
    });
    var res = await sendMsg('saveConfig', { config: newConfig });
    if (res && res.ok) {
      config = await sendMsg('getConfig');
      toast('Config tersimpan! ✅', 'ok');
      await renderStatus();
    } else {
      toast('Gagal menyimpan config', 'err');
    }
  });

  // Test koneksi
  $('btnTestConn').addEventListener('click', async function() {
    $('btnTestConn').disabled = true;
    $('btnTestConn').textContent = '⏳ Testing...';
    var vpsHost = $('inputVpsHost').value.trim();
    var testConfig = Object.assign({}, config, {
      mode: currentMode,
      vpsHost: vpsHost,
      activePort: config ? (config.activePort || 8545) : 8545
    });
    await sendMsg('saveConfig', { config: testConfig });
    var status = await sendMsg('checkBot');
    $('btnTestConn').disabled = false;
    $('btnTestConn').textContent = '🔌 Test Koneksi';
    if (status && status.connected) {
      toast('Terhubung! Chain: ' + (status.chainIdDec || status.chainId), 'ok', 3000);
    } else {
      toast('Gagal: ' + (status && status.error ? status.error : 'Bot tidak merespons'), 'err', 3500);
    }
  });

  // Auto refresh setiap 5 detik
  var autoRefresh = setInterval(renderStatus, 5000);
  window.addEventListener('unload', function() { clearInterval(autoRefresh); });

  init();
});
