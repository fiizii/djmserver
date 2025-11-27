'use strict';
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');

const express = require('express');
const Database = require('better-sqlite3');
const yazl = require('yazl');
const unzipper = require('unzipper');
const mime = require('mime-types');
const yaml = require('js-yaml');
const chokidar = require('chokidar');

let mm;
(async () => { mm = await import('music-metadata'); })();
const ACTIVE_SYNCS = new Set();

const ROOT = fs.realpathSync(process.cwd());
const SYS = path.join(ROOT, '.mrepo');
const PATHS = {
    CONF: path.join(SYS, 'conf.yaml'),
    DB: path.join(SYS, 'core.db'),
    TMP: path.join(SYS, 'tmp'),
    IMP: path.join(ROOT, 'imports')
};

const Boot = () => {
    [SYS, PATHS.TMP, PATHS.IMP].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

    if (!fs.existsSync(PATHS.CONF)) {
        const def = {
            system: { port: 3000, key: crypto.randomBytes(16).toString('hex'), ready: false },
            remotes: [], // remotes { name, url }
            security: {
                extensions: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.opus'],
                signatures: {
                    '494433': 'mp3', 'FFF3': 'mp3', 'FFF2': 'mp3',
                    '524946': 'wav', '664C61': 'flac', '4F6767': 'ogg', '000000': 'm4a'
                },
                dlThrottleMBPS: 5
            }
        };
        fs.writeFileSync(PATHS.CONF, yaml.dump(def));
        console.log(`[SETUP] Generated .mrepo/conf.yaml\n[KEY] ${def.system.key}\nSet 'ready: true' to start.`);
        process.exit(0);
    }

    const c = yaml.load(fs.readFileSync(PATHS.CONF, 'utf8'));
    if (!c.system.ready) process.exit(0);
    return c;
};
const CFG = Boot();

const db = new Database(PATHS.DB);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
        path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER, mtime INTEGER,
        title TEXT, artist TEXT, duration REAL, bitrate INTEGER, verified INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS remotes (
        name TEXT PRIMARY KEY, url TEXT, last_sync INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_meta ON tracks(title, artist);
    CREATE INDEX IF NOT EXISTS idx_hash ON tracks(hash);
`);

if (CFG.remotes && Array.isArray(CFG.remotes)) {
    const stmt = db.prepare('INSERT OR IGNORE INTO remotes (name, url, last_sync) VALUES (?, ?, 0)');
    CFG.remotes.forEach(r => stmt.run(r.name, r.url));
}

const SQL = {
    put: db.prepare(`INSERT OR REPLACE INTO tracks (path, hash, size, mtime, title, artist, duration, bitrate, verified) VALUES (@path, @hash, @size, @mtime, @title, @artist, @duration, @bitrate, 1)`),
    del: db.prepare(`DELETE FROM tracks WHERE path = ?`),
    getHash: db.prepare(`SELECT * FROM tracks WHERE hash = ?`),
    findMeta: db.prepare(`SELECT * FROM tracks WHERE title = ? AND artist = ?`),
    list: db.prepare(`SELECT path, hash, size, title, artist, bitrate FROM tracks WHERE verified = 1`),

    addRemote: db.prepare(`INSERT OR REPLACE INTO remotes (name, url, last_sync) VALUES (?, ?, ?)`),
    delRemote: db.prepare(`DELETE FROM remotes WHERE name = ?`),
    listRemotes: db.prepare(`SELECT * FROM remotes`),
    updateRemote: db.prepare(`UPDATE remotes SET last_sync = ? WHERE name = ?`)
};

const Util = {
    safePath: (raw) => {
        if (!raw || raw.includes('\0')) return null;
        const res = path.resolve(ROOT, raw);
        return (res.startsWith(ROOT) && !res.startsWith(SYS) && fs.existsSync(res)) ? res : null;
    },

    req: (u, o = {}) => new Promise((ok, no) => {
        const r = (u.startsWith('https') ? https : http).request(u, o, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => ok(JSON.parse(d))) });
        r.on('error', no); if (o.body) r.write(o.body); r.end();
    }),

    hash: async (fp) => {
        const h = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(fp), h);
        return h.digest('hex');
    },

    verifySig: async (fp) => {
        const ext = path.extname(fp).toLowerCase();
        if (!CFG.security.extensions.includes(ext)) return false;
        const fd = await fsp.open(fp, 'r');
        const buf = Buffer.alloc(12);
        await fd.read(buf, 0, 12, 0);
        await fd.close();
        const hex = buf.toString('hex').toUpperCase();
        const sigs = Object.keys(CFG.security.signatures).filter(k => CFG.security.signatures[k] === ext.replace('.', ''));
        return sigs.length ? sigs.some(s => hex.startsWith(s)) : true;
    }
};

const Ingest = {
    queue: [], busy: false,
    push(fp) { this.queue.push(fp); if (!this.busy) this.process(); },
    async process() {
        this.busy = true;
        while (this.queue.length) {
            const abs = this.queue.shift();
            try { await this.scan(abs); } catch (e) { console.error(`[INGEST] ${abs} err:`, e.message); }
        }
        this.busy = false;
    },
    async scan(abs) {
        const rel = path.relative(ROOT, abs);
        if (!fs.existsSync(abs)) return SQL.del.run(rel);
        if (!await Util.verifySig(abs)) return;

        const stat = await fsp.stat(abs);
        const hash = await Util.hash(abs);

        const exact = SQL.getHash.get(hash);
        if (exact && exact.path !== rel) { await fsp.unlink(abs); return; }

        let m = { common: { title: '', artist: '' }, format: { duration: 0, bitrate: 0 } };
        try { m = await mm.parseFile(abs); } catch { }

        const data = {
            path: rel, hash, size: stat.size, mtime: Math.floor(stat.mtimeMs),
            title: (m.common.title || path.basename(rel)).trim().toLowerCase(),
            artist: (m.common.artist || 'unknown').trim().toLowerCase(),
            duration: m.format.duration || 0, bitrate: m.format.bitrate || 0
        };

        if (data.title && data.duration > 0) {
            const exist = SQL.findMeta.all(data.title, data.artist);
            for (const old of exist) {
                if (old.path === rel) continue;
                if (Math.abs(old.duration - data.duration) < 5) {
                    if (data.bitrate > old.bitrate) {
                        const oldAbs = path.join(ROOT, old.path);
                        if (fs.existsSync(oldAbs)) await fsp.unlink(oldAbs);
                        SQL.del.run(old.path);
                    } else {
                        await fsp.unlink(abs); return;
                    }
                }
            }
        }
        SQL.put.run(data);
    }
};

chokidar.watch(ROOT, { ignored: [/(^|[\/\\])\../, 'node_modules', '.mrepo'], persistent: true, ignoreInitial: false })
    .on('add', p => Ingest.push(p)).on('change', p => Ingest.push(p)).on('unlink', p => SQL.del.run(path.relative(ROOT, p)));

const Jobs = {
    map: new Map(),
    create(files) {
        const id = crypto.randomUUID();
        const dest = path.join(PATHS.TMP, `${id}.zip`);
        const job = { id, status: 'processing', path: dest };
        this.map.set(id, job);
        (async () => {
            try {
                const z = new yazl.ZipFile();
                const o = fs.createWriteStream(dest);
                z.outputStream.pipe(o);
                for (const f of files) {
                    const abs = Util.safePath(f);
                    if (abs) z.addFile(abs, f);
                }
                z.end();
                o.on('finish', () => { job.status = 'ready'; setTimeout(() => { fs.unlink(dest, () => { }); this.map.delete(id); }, 6e4); });
            } catch { job.status = 'error'; }
        })();
        return job;
    }
};

const ADMIN_UI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>djmserver repos</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #050505; --p: #111; --acc: #00ff9d; --err: #ff3366; }
        body { background: var(--bg); color: #ccc; font-family: 'JetBrains Mono', monospace; margin: 0; padding: 20px; font-size: 13px; }
        .con { max-width: 800px; margin: 0 auto; }
        h1 { color: #fff; border-bottom: 1px solid #333; padding-bottom: 10px; display: flex; justify-content: space-between; }
        .card { background: var(--p); border: 1px solid #333; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
        input { background: #000; border: 1px solid #333; color: #fff; padding: 8px; font-family: inherit; width: 200px; }
        button { background: transparent; border: 1px solid var(--acc); color: var(--acc); padding: 8px 15px; cursor: pointer; font-family: inherit; font-weight: bold; }
        button:hover { background: var(--acc); color: #000; }
        button.del { border-color: var(--err); color: var(--err); }
        button.del:hover { background: var(--err); color: #000; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #222; }
        th { color: #888; text-transform: uppercase; font-size: 11px; }
        .tree-view { max-height: 300px; overflow-y: auto; background: #000; padding: 10px; border: 1px solid #333; display: none; margin-top: 10px; }
        .status { float: right; font-size: 11px; color: #666; }
    </style>
</head>
<body>
    <div class="con" style='display:none' id='a'>
        <h1>REPO MANAGER <span class="status" id="status">READY</span></h1>
        
        <div class="card">
            <h3>ADD REMOTE</h3>
            <div style="display:flex; gap:10px;">
                <input type="text" id="r_name" placeholder="Repo Name (e.g. HouseVault)">
                <input type="text" id="r_url" placeholder="URL (e.g. http://10.0.0.5:3000)" style="flex:1">
                <button onclick="addRemote()">ADD</button>
            </div>
            <p style="color:#666; font-size:11px; margin-top:10px;">
                Linked repos allow syncing. Files are saved to: <code>imports/&lt;RepoName&gt;/...</code>
            </p>
        </div>

        <div class="card">
            <h3>LINKED REMOTES</h3>
            <table id="r_list"></table>
        </div>

        <div class="tree-view" id="preview_box"></div>
    </div>

    <script>
        const API = '/api/admin';
        const KEY = prompt("Enter key from config:");
        
        const headers = { 'Content-Type': 'application/json', 'x-key': KEY };

        async function load() {
            const res = await fetch(API + '/list', { headers });
            if (res.status === 403) return location.reload();
            document.getElementById("a").style="display: block"
            const list = await res.json();
            const el = document.getElementById('r_list');
            el.innerHTML = '<tr><th>Name</th><th>URL</th><th>Synced</th><th>Actions</th></tr>' + 
            list.map(r => \`
                <tr>
                    <td>\${r.name}</td>
                    <td>\${r.url}</td>
                    <td>\${r.last_sync ? new Date(r.last_sync).toLocaleString() : 'Never'}</td>
                    <td>
                        <button onclick="preview('\${r.url}')">PREVIEW</button>
                        <button onclick="sync('\${r.name}', '\${r.url}')">SYNC</button>
                        <button class="del" onclick="del('\${r.name}')">X</button>
                    </td>
                </tr>
            \`).join('');
        }

        async function addRemote() {
            const name = document.getElementById('r_name').value;
            const url = document.getElementById('r_url').value;
            if(!name || !url) return alert('Missing fields');
            await fetch(API + '/add', { method: 'POST', headers, body: JSON.stringify({ name, url }) });
            load();
        }

        async function del(name) {
            if(!confirm('Unlink ' + name + '?')) return;
            await fetch(API + '/del', { method: 'POST', headers, body: JSON.stringify({ name }) });
            load();
        }

        async function preview(url) {
            const box = document.getElementById('preview_box');
            box.style.display = 'block';
            box.innerText = 'Fetching manifest...';
            try {
                const res = await fetch(url + '/api/manifest');
                const data = await res.json();
                box.innerHTML = '<strong>' + url + '</strong><br><br>' + 
                    data.tracks.map(t => '<div>' + t.path + '</div>').join('');
            } catch(e) { box.innerText = 'Error fetching manifest: ' + e; }
        }

        async function sync(name, url) {
            document.getElementById('status').innerText = 'SYNCING ' + name + '...';
            await fetch(API + '/sync', { method: 'POST', headers, body: JSON.stringify({ name, url }) });
            document.getElementById('status').innerText = 'SYNC STARTED (CHECK SERVER LOGS)';
            setTimeout(load, 2000);
        }

        load();
    </script>
</body>
</html>
`;

const app = express();
app.use(express.json({ limit: '80mb' }));
app.set('view engine', 'ejs');
app.set('views', ROOT);
app.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }); next(); });

const auth = (req, res, n) => (req.headers['x-key'] === CFG.system.key) ? n() : res.status(403).end();

app.get('/admin', (req, res) => res.send(ADMIN_UI));
app.get('/api/admin/list', auth, (req, res) => res.json(SQL.listRemotes.all()));
app.post('/api/admin/add', auth, (req, res) => {
    SQL.addRemote.run(req.body.name, req.body.url, 0);
    res.json({ ok: true });
});
app.post('/api/admin/del', auth, (req, res) => {
    if (!req.body.name) return res.sendStatus(501)
    SQL.delRemote.run(req.body.name);
    if (ACTIVE_SYNCS.has(req.body.name)) {
        console.log(`[ADMIN] Stopping sync for ${req.body.name}...`);
        ACTIVE_SYNCS.delete(req.body.name);
    }
    res.json({ ok: true });
});

app.post('/api/admin/sync', auth, async (req, res) => {
    const { name, url } = req.body;

    res.json({ status: 'started' });

    (async () => {
        try {
            console.log(`[SYNC] Connecting to ${name} (${url})`);
            if (ACTIVE_SYNCS.has(name)) {
                console.log("[SYNC] abort- already syncing.")
                return res.status(409).json({ error: 'Sync already in progress' });
            }

            const rem = await Util.req(`${url}/api/manifest`);

            const need = [];
            for (const r of rem.tracks) {
                const hasHash = SQL.getHash.get(r.hash);
                if (hasHash) continue;

                const meta = SQL.findMeta.all(r.title, r.artist);
                const better = meta.find(m => Math.abs(m.duration - r.duration) < 5 && m.bitrate >= r.bitrate);
                if (!better) need.push(r.path);
            }

            if (!need.length) {
                console.log(`[SYNC] ${name} is up to date.`);
                return SQL.updateRemote.run(Date.now(), name);
            }

            console.log(`[SYNC] Found ${need.length} tracks to sync.`);

            const CHUNK_SIZE = 30;
            const TOTAL_BATCHES = Math.ceil(need.length / CHUNK_SIZE);
            ACTIVE_SYNCS.add(name);

            for (let i = 0; i < need.length; i += CHUNK_SIZE) {
                const batch = need.slice(i, i + CHUNK_SIZE);
                const currentBatchNum = (i / CHUNK_SIZE) + 1;
                if (!ACTIVE_SYNCS.has(name)) throw new Error("Sync cancelled");

                console.log(`[SYNC] Processing Batch ${currentBatchNum}/${TOTAL_BATCHES} (${batch.length} files)...`);

                try {
                    const job = await Util.req(`${url}/api/job`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ files: batch })
                    });

                    let s = 'processing';
                    let attempts = 0;
                    while (s === 'processing') {
                        if (!ACTIVE_SYNCS.has(name)) return s = 'failed';

                        if (attempts++ > 60) throw new Error("Remote job timed out");
                        await new Promise(r => setTimeout(r, 1000));
                        s = (await Util.req(`${url}/api/job/${job.jobId}`)).status;
                    }

                    if (s === 'ready') {
                        const tmp = path.join(PATHS.TMP, `sync_${Date.now()}_${currentBatchNum}.zip`);

                        await new Promise((resolve, reject) => {
                            const f = fs.createWriteStream(tmp);
                            const req = (url.startsWith('https') ? https : http).get(`${url}/download/${job.jobId}`, r => {
                                if (r.statusCode !== 200) {
                                    f.close();
                                    return reject(new Error(`Download failed: ${r.statusCode}`));
                                }
                                r.pipe(f);
                                f.on('finish', () => { f.close(); resolve(); });
                            });
                            req.on('error', err => { fs.unlink(tmp, () => { }); reject(err); });
                        });

                        const dest = path.join(PATHS.IMP, name);
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

                        await fs.createReadStream(tmp)
                            .pipe(unzipper.Extract({ path: dest }))
                            .promise();

                        fs.unlink(tmp, () => { });
                    } else {
                        console.error(`[SYNC] Batch ${currentBatchNum} failed on remote.`);
                    }
                } catch (batchErr) {
                    console.error(`[SYNC ERR] Batch ${currentBatchNum} failed: ${batchErr.message}`);
                }
            }

            SQL.updateRemote.run(Date.now(), name);
            console.log(`[SYNC] Complete: ${name}`);

        } catch (e) {
            console.error(`[SYNC FATAL] ${e.message}`);
        }
    })();
});;

app.get('/', (req, res) => res.render('index', { tree: SQL.list.all() }));
app.get('/api/manifest', (req, res) => res.json({ tracks: SQL.list.all() }));
app.get('/stream', async (req, res) => {
    const p = Util.safePath(req.query.file);
    if (!p) return res.status(404).end();
    const s = (await fsp.stat(p)).size;
    const r = req.headers.range;
    const t = mime.lookup(p);
    if (r) {
        const [a, b] = r.replace(/bytes=/, "").split("-");
        const st = parseInt(a, 10), ed = b ? parseInt(b, 10) : s - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${st}-${ed}/${s}`, 'Content-Length': (ed - st) + 1, 'Content-Type': t });
        fs.createReadStream(p, { start: st, end: ed }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': s, 'Content-Type': t });
        fs.createReadStream(p).pipe(res);
    }
});
const { Transform } = require('stream');

class Throttler extends Transform {
    constructor(bytesPerSecond) {
        super();
        this.bps = bytesPerSecond;
        this.lastPush = Date.now();
    }

    _transform(chunk, encoding, callback) {
        this.push(chunk);

        const now = Date.now();
        const timeSinceLast = now - this.lastPush;
        const timeRequired = (chunk.length / this.bps) * 1000;

        const delay = Math.max(0, timeRequired - timeSinceLast);

        this.lastPush = now + delay;

        if (delay > 0) {
            setTimeout(callback, delay);
        } else {
            callback();
        }
    }
}
app.post('/api/job', (req, res) => {
    if (!req.body.files) return res.sendStatus(400);
    const j = Jobs.create(req.body.files);
    res.json({ jobId: j.id, status: j.status });
});
app.get('/api/job/:id', (req, res) => {
    const j = Jobs.map.get(req.params.id);
    j ? res.json(j) : res.status(404).json({ status: 'error' });
});
app.get('/download/:id', async (req, res) => {
    const j = Jobs.map.get(req.params.id);
    if (!j || j.status !== 'ready') return res.status(404).end();
    if (!fs.existsSync(j.path)) return res.status(404).end();

    try {
        const stat = await fsp.stat(j.path);
        const filename = `fizi_archive_${Date.now()}.zip`;
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache'
        });
        const RATE_LIMIT = CFG.security.dlThrottleMBPS * 1024 * 1024;
        const throttle = new Throttler(RATE_LIMIT);
        const source = fs.createReadStream(j.path);
        source.on('error', (e) => { console.error(e); res.end(); });
        source
            .pipe(throttle)
            .pipe(res);

    } catch (e) {
        console.error('[DL ERROR]', e);
        if (!res.headersSent) res.status(500).end();
    }
});
app.listen(CFG.system.port, () => console.log(`[DJMSERVER] Main: :${CFG.system.port} | Admin: /admin - your key: ${CFG.system.key}`));