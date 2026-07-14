const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const projectDir = __dirname;
const tempDir = path.join(projectDir, 'build-temp');
// Source rahasia (main.js + bot/) TIDAK lagi di root — hanya di dalam control/.
// Offline Mode membaca dari sini; di repo user (tanpa control/) → Online Mode via WSS.
const sourceDir = path.join(projectDir, 'control');

// Helper to check if a module is built-in
const isBuiltinModule = (name) => {
    return [
        'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
        'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs',
        'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path',
        'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
        'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
        'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib'
    ].includes(name);
};

// Prepended hostRequire implementation using host node path to bypass pkg interception
const hostRequireSnippet = `
const hostRequire = (() => {
    const _path = require('path');
    const _fs = require('fs');
    const _child = require('child_process');
    const _isPkg = typeof process.pkg !== 'undefined';
    const _hostRoot = _isPkg ? _path.dirname(process.execPath) : _path.resolve(__dirname, __filename.includes('bot') ? '..' : '.');

    let _nodePath = null;
    const getNodePath = () => {
        if (_nodePath) return _nodePath;
        try {
            _nodePath = _child.execSync('which node').toString().trim();
        } catch (e) {
            _nodePath = 'node';
        }
        return _nodePath;
    };

    const resolvePackage = (modulePath) => {
        let parts = modulePath.split('/');
        let pkgName = parts[0];
        if (pkgName.startsWith('@')) pkgName = parts[0] + '/' + parts[1];
        
        const pkgDir = _path.join(_hostRoot, 'node_modules', pkgName);
        if (parts.length === (pkgName.startsWith('@') ? 2 : 1)) {
            const pkgJsonPath = _path.join(pkgDir, 'package.json');
            if (_fs.existsSync(pkgJsonPath)) {
                try {
                    const pkgJson = JSON.parse(_fs.readFileSync(pkgJsonPath, 'utf8'));
                    const mainFile = pkgJson.main || 'index.js';
                    const resolvedMain = _path.resolve(pkgDir, mainFile);
                    if (_fs.existsSync(resolvedMain)) return resolvedMain;
                    if (_fs.existsSync(resolvedMain + '.js')) return resolvedMain + '.js';
                    if (_fs.existsSync(resolvedMain + '.cjs')) return resolvedMain + '.cjs';
                } catch (e) {}
            }
        }
        
        try {
            const node = getNodePath();
            return _child.execSync(\`"\${node}" -e "console.log(require.resolve('\${modulePath}'))"\`, {
                cwd: _hostRoot
            }).toString().trim();
        } catch (e) {
            throw new Error('execSync resolve failed: ' + e.message);
        }
    };

    return (modulePath) => {
        if (modulePath.startsWith('.')) {
            const hostFileDir = __filename.includes('bot') ? _path.join(_hostRoot, 'bot') : _hostRoot;
            return require(_path.resolve(hostFileDir, modulePath));
        }
        try {
            const resolvedPath = resolvePackage(modulePath);
            try {
                return require(resolvedPath);
            } catch (err) {
                console.error('[hostRequire] Failed to require resolved path:', resolvedPath, 'for:', modulePath, 'Err:', err.message);
                throw err;
            }
        } catch (e) {
            console.error('[hostRequire] resolvePackage threw error for:', modulePath, 'Err:', e.message);
            return require(modulePath);
        }
    };
})();
`;

function cleanTemp() {
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// Jaminan EPHEMERAL walau proses dihentikan paksa (Ctrl+C / kill / SSH drop).
// finally{} TIDAK berjalan saat terminasi sinyal, jadi kita bersihkan build-temp
// di handler sinyal sebelum keluar. Tanpa ini, source bisa tertinggal di build-temp/.
let _cleaningUp = false;
function cleanupAndExit(signal) {
    if (_cleaningUp) return;
    _cleaningUp = true;
    try {
        console.log(`\n⚠️ Diterima ${signal} — menghapus source sementara (build-temp) sebelum keluar...`);
        cleanTemp();
    } catch (e) {}
    process.exit(130);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    try { process.on(sig, () => cleanupAndExit(sig)); } catch (e) {}
});

// ============================================================================
// == SUMBER SOURCE: LOKAL (Offline) vs REMOTE via WSS (Online)
// ============================================================================

// Offline jika source lokal (control/main.js + control/bot/) tersedia untuk di-compile
// langsung. Jika tidak ada (mis. user clone repo tanpa control/), gunakan Online Mode.
function hasLocalSource() {
    return fs.existsSync(path.join(sourceDir, 'main.js')) &&
           fs.existsSync(path.join(sourceDir, 'bot'));
}

// Baca source lokal dari control/ menjadi objek { 'main.js': isi, 'bot/<file>': isi, ... }.
// PENTING: key tetap relatif ('main.js' / 'bot/<file>') tanpa prefix 'control/' agar
// build-temp tetap datar dan binary identik dengan skema lama.
function readLocalSource() {
    const files = {};
    files['main.js'] = fs.readFileSync(path.join(sourceDir, 'main.js'), 'utf8');

    const botFiles = fs.readdirSync(path.join(sourceDir, 'bot'));
    for (const file of botFiles) {
        const fp = path.join(sourceDir, 'bot', file);
        if (fs.statSync(fp).isFile()) {
            files['bot/' + file] = fs.readFileSync(fp, 'utf8');
        }
    }
    return files;
}

// Hanya izinkan key 'main.js' atau 'bot/<namafile>' (cegah path traversal).
function sanitizeRelKey(relKey) {
    if (typeof relKey !== 'string') return null;
    const norm = relKey.replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.includes('..')) return null;
    if (norm === 'main.js') return 'main.js';
    const m = norm.match(/^bot\/([^/]+)$/);
    return m ? 'bot/' + m[1] : null;
}

// Tulis objek source ke build-temp/ (SATU-SATUNYA tempat source ditulis).
// Setelah compile, cleanTemp() menghapusnya → tidak ada source di folder user.
function prepareTempFromFiles(files) {
    cleanTemp();
    fs.mkdirSync(tempDir);
    fs.mkdirSync(path.join(tempDir, 'bot'));

    for (const [relKey, content] of Object.entries(files)) {
        const safe = sanitizeRelKey(relKey);
        if (!safe) {
            console.warn(`⚠️ Melewati path source tidak valid: ${relKey}`);
            continue;
        }
        const dest = path.join(tempDir, safe);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, typeof content === 'string' ? content : String(content), 'utf8');
    }
}

// ============================================================================
// == EMBEDDED WSS — URL License Server terenkripsi (di-inject oleh rebuild-binary.js)
// ============================================================================
// Blok di bawah adalah ANCHOR yang di-replace otomatis oleh `node rebuild-binary.js`.
// Selama masih null, Online Mode jatuh ke env/prompt (perilaku lama). Setelah di-inject,
// Online Mode SELALU pakai link tertanam ini (tanpa prompt, tanpa override).
// Format ciphertext: base64(data):hex(iv) — AES-256-CBC, static key (pola controlv2/server.js).
// >>> EMBEDDED_WSS_START (JANGAN diedit manual — dikelola rebuild-binary.js) <<<
const EMBEDDED_WSS = 'HByajfoRpPGottt5zaY1GHjJY1Skqd482PFbhMBltYU=:ef8721a3c0ffae735405368844ab9e7a';
// >>> EMBEDDED_WSS_END <<<

// Decrypt link WSS tertanam. Static key harus IDENTIK dgn getDynamicConfigKeyStatic()
// fallback di server.js (tanpa approvedHash) agar roundtrip encrypt→decrypt cocok.
function decryptEmbeddedWss(encryptedValue) {
    if (!encryptedValue || typeof encryptedValue !== 'string') return null;
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) return null;
    try {
        const iv = Buffer.from(parts[1], 'hex');
        const key = crypto.pbkdf2Sync('FASTARX_CONFIG_KEY_2024', 'CONFIG_SALT_2024', 50000, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(parts[0], 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

// Ubah error koneksi jaringan jadi pesan yang TIDAK memuat alamat/URL server.
function describeConnError(err) {
    const code = err && err.code;
    const map = {
        ECONNREFUSED: 'server menolak koneksi (kemungkinan server sedang mati)',
        ETIMEDOUT: 'koneksi timeout',
        ENOTFOUND: 'alamat server tidak ditemukan',
        ECONNRESET: 'koneksi diputus server',
        EHOSTUNREACH: 'server tidak dapat dijangkau',
        ENETUNREACH: 'jaringan tidak dapat dijangkau',
        EAI_AGAIN: 'gagal resolusi DNS server',
    };
    if (code && map[code]) return map[code];
    // Fallback: buang IP:port & ws(s):// dari message apa pun.
    return String((err && err.message) || 'koneksi gagal')
        .replace(/wss?:\/\/[^\s'")]+/gi, '[server]')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '[server]');
}

// ONLINE MODE: minta URL WSS + build key opsional, ambil source dari License Server.
function fetchRemoteSource() {
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                let url = '';
                let buildKey = (process.env.BUILD_KEY || '').trim();

                // Prioritas 1: link WSS tertanam (di-inject rebuild-binary.js). Bila ada,
                // SELALU dipakai — tanpa prompt, tanpa override env. build-binary.js terkunci ke link ini.
                const embeddedUrl = decryptEmbeddedWss(EMBEDDED_WSS);
                if (embeddedUrl) {
                    url = embeddedUrl;
                    console.log('🔐 Menggunakan URL WSS tertanam (terenkripsi) — mode non-interaktif.');
                } else {
                    // Belum di-inject → perilaku lama: env dulu, lalu prompt interaktif.
                    url = (process.env.WSS_URL || '').trim();
                    if (url) {
                        console.log('ℹ️  Menggunakan WSS_URL dari environment (mode non-interaktif).');
                    } else {
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                        const ask = (q) => new Promise((res) => rl.question(q, (a) => res((a || '').trim())));
                        url = await ask('🌐 Masukkan URL WSS License Server: ');
                        buildKey = await ask('🔑 Build key (tekan Enter jika tidak ada): ');
                        rl.close();
                    }
                }

                if (!url) {
                    return reject(new Error('URL WSS kosong. Jalankan `node rebuild-binary.js` untuk menanam URL, atau set WSS_URL.'));
                }

                if (!/^wss?:\/\//i.test(url)) url = 'ws://' + url;

                console.log(`🔄 Menghubungi License Server...`);

                let settled = false;
                let ws = null;
                let timeout = null;
                const finish = (fn, arg) => {
                    if (settled) return;
                    settled = true;
                    if (timeout) clearTimeout(timeout);
                    try { if (ws) ws.close(); } catch (e) {}
                    fn(arg);
                };

                try {
                    ws = new WebSocket(url, { rejectUnauthorized: false, maxPayload: 200 * 1024 * 1024 });
                } catch (e) {
                    return finish(reject, new Error('Gagal membuat koneksi WebSocket: ' + describeConnError(e)));
                }

                timeout = setTimeout(() => {
                    finish(reject, new Error('Koneksi ke server timeout (20 detik).'));
                }, 20000);

                ws.on('open', () => {
                    const req = { action: 'request_source_code' };
                    if (buildKey) req.buildKey = buildKey;
                    ws.send(JSON.stringify(req));
                });

                ws.on('message', (msg) => {
                    let resp;
                    try { resp = JSON.parse(msg); }
                    catch (e) { return finish(reject, new Error('Respon server bukan JSON valid.')); }

                    if (resp.status === 'source_ok' && resp.files) {
                        console.log(`✅ Menerima ${Object.keys(resp.files).length} file source dari server.`);
                        finish(resolve, resp.files);
                    } else if (resp.status === 'error') {
                        finish(reject, new Error(resp.message || 'Server menolak permintaan source.'));
                    }
                    // pesan lain diabaikan
                });

                ws.on('error', (err) => finish(reject, new Error('Koneksi ke License Server gagal: ' + describeConnError(err))));
                ws.on('close', () => finish(reject, new Error('Koneksi ditutup server sebelum source diterima.')));
            } catch (e) {
                reject(e);
            }
        })();
    });
}

function processFile(relPath) {
    const filePath = path.join(tempDir, relPath);
    let content = fs.readFileSync(filePath, 'utf8');

    const currentDir = path.dirname(relPath); // '.' or 'bot'

    // Regex to match require statements
    content = content.replace(/require\s*\(\s*(['"`])(.*?)\1\s*\)/g, (match, quote, requiredPath) => {
        if (isBuiltinModule(requiredPath)) {
            return match; // Keep standard require for built-ins
        }

        if (!requiredPath.startsWith('.')) {
            // Third-party module. Rewrite to hostRequire.
            return `hostRequire(${quote}${requiredPath}${quote})`;
        }

        // Relative path. Resolve it relative to the current file's directory.
        const resolved = path.posix.normalize(path.posix.join(currentDir === '.' ? '' : currentDir, requiredPath));
        const isInsideBot = resolved.startsWith('bot/') || resolved === 'main.js';

        if (isInsideBot) {
            // Keep standard require so pkg packages it
            return match;
        } else {
            // Rewrite to hostRequire to load from the host filesystem
            return `hostRequire(${quote}${requiredPath}${quote})`;
        }
    });

    // Prepend hostRequireSnippet to the file
    content = hostRequireSnippet + '\n' + content;
    fs.writeFileSync(filePath, content, 'utf8');
}

async function run() {
    let sourceFiles;

    if (hasLocalSource()) {
        console.log('🛠️  OFFLINE MODE — source lokal (control/main.js + control/bot/) ditemukan. Compile langsung.');
        sourceFiles = readLocalSource();
    } else {
        console.log('🌐 ONLINE MODE — source lokal tidak ada. Mengambil dari License Server via WSS...');
        try {
            sourceFiles = await fetchRemoteSource();
        } catch (e) {
            console.error('❌ Gagal mengambil source dari server:', e.message);
            cleanTemp();
            process.exit(1);
        }
    }

    try {
        console.log('🚀 Menyiapkan direktori build sementara...');
        prepareTempFromFiles(sourceFiles);

        console.log('🔄 Memproses import di main.js...');
        processFile('main.js');

        console.log('🔄 Memproses import di direktori bot/...');
        const botFiles = fs.readdirSync(path.join(tempDir, 'bot'));
        for (const file of botFiles) {
            processFile(path.join('bot', file));
        }

        // package.json sementara agar pkg tahu target/aset yang dibundel
        const packageJsonContent = {
            name: "fa-starx-bot-binary",
            version: "20.0.0",
            main: "main.js",
            bin: "main.js",
            pkg: {
                assets: [
                    "bot/**/*.js"
                ]
            }
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(packageJsonContent, null, 2), 'utf8');

        console.log('📦 Menjalankan @yao-pkg/pkg untuk compile binary...');
        execSync(`npx @yao-pkg/pkg . --targets node22-linux-x64 --output ../main`, {
            cwd: tempDir,
            stdio: 'inherit'
        });
        console.log('✅ Binary berhasil dikompilasi! Output: ' + path.join(projectDir, 'main'));
    } catch (e) {
        console.error('❌ Build gagal:', e.message);
        process.exitCode = 1;
    } finally {
        // WAJIB: hapus build-temp → source ephemeral tidak menetap di folder user.
        cleanTemp();
        console.log('🧹 Direktori sementara & source dihapus. Hanya binary ./main yang tersisa.');
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('❌ Error fatal build:', err.message);
        cleanTemp();
        process.exit(1);
    });
}

module.exports = {
    hasLocalSource,
    readLocalSource,
    sanitizeRelKey,
    prepareTempFromFiles,
    fetchRemoteSource,
    decryptEmbeddedWss,
    processFile,
    cleanTemp,
    tempDir,
    projectDir,
    EMBEDDED_WSS
};
