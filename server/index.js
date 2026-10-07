import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DIRS, ensureDirs } from './lib/storage.js';
import { collectionRouter } from './routes/collection.js';
import charactersRouter from './routes/characters.js';
import chatsRouter from './routes/chats.js';
import aiRouter from './routes/ai.js';
import filesRouter from './routes/files.js';
import { apiRouter as extensionsApi, serveRouter as extensionsServe } from './routes/extensions.js';
import stCompatRouter, { USER_FILES } from './routes/st-compat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.APP_PASSWORD || '';

ensureDirs();

// ---------- auth (single shared password, signed cookie) ----------
const secretFile = path.join(DATA_DIR, '.session-secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim() + PASSWORD;
const COOKIE = 'rv_auth';
const SESSION_DAYS = 60;

const sign = value => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');

function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

function isAuthed(req) {
    if (!PASSWORD) return true;
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const [expires, sig] = token.split('.');
    if (!expires || !sig || Number(expires) < Date.now()) return false;
    const expected = sign(expires);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const attempts = new Map();
function tooManyAttempts(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter(t => now - t < 60_000);
    attempts.set(ip, list);
    return list.length >= 8;
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '64mb' }));

app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
});

app.post('/api/login', (req, res) => {
    if (!PASSWORD) return res.json({ ok: true });
    const ip = req.ip;
    if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
    const given = Buffer.from(String(req.body?.password ?? ''));
    const wanted = Buffer.from(PASSWORD);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
        attempts.get(ip).push(Date.now());
        return res.status(401).json({ error: 'Wrong password' });
    }
    const expires = String(Date.now() + SESSION_DAYS * 864e5);
    res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/',
    });
    res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Hosted deployments must be password protected: otherwise anyone who finds the URL can spend your API credits.
const HOSTED = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.REQUIRE_PASSWORD);
if (HOSTED && !PASSWORD) {
    app.use((_req, res) => res.status(503).type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#0c0a13;color:#ece7f5;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center">
<div><h1 style="font-weight:600">✦ One more step</h1><p>Set an <code>APP_PASSWORD</code> variable for this service (Railway → your service → Variables), then redeploy.</p>
<p style="opacity:.6">This keeps strangers from using your API keys.</p></div></body>`));
}

// Login screen + the assets it needs are public.
const PUBLIC_PATHS = new Set(['/login.html', '/css/login.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.ico']);
app.use((req, res, next) => {
    // Media uses unguessable random names and must load inside sandboxed iframes (no cookies there).
    if (isAuthed(req) || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/files/')) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) return res.redirect('/login.html');
    return res.status(401).end();
});

// ---------- API ----------
// SillyTavern-compatible endpoints first: some share a prefix with Reverie's own routes.
app.use('/api', stCompatRouter);
app.use('/api/characters', charactersRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/presets', collectionRouter(DIRS.presets, { summary: p => ({ id: p.id, name: p.name, source: p.source, updated: p.updated }) }));
app.use('/api/worlds', collectionRouter(DIRS.worlds, { summary: w => ({ id: w.id, name: w.name, count: Object.keys(w.entries || {}).length, updated: w.updated }) }));
app.use('/api/themes', collectionRouter(DIRS.themes));
app.use('/api/personas', collectionRouter(DIRS.personas));
app.use('/api/extensions', extensionsApi);
app.use('/api', aiRouter);
app.use('/api', filesRouter);
app.get('/api/info', (_req, res) => res.json({ name: 'Reverie', version: process.env.npm_package_version || '0.1.0', auth: !!PASSWORD }));

// ---------- static ----------
const staticOpts = { fallthrough: true, index: false, maxAge: '7d' };
app.use('/files/avatars', express.static(DIRS.avatars, staticOpts));
app.use('/files/backgrounds', express.static(DIRS.backgrounds, staticOpts));
app.use('/files/images', express.static(DIRS.images, staticOpts));
// SillyTavern-style media paths returned by the ST-compatible upload endpoints.
app.use('/user/images', express.static(DIRS.images, staticOpts));
app.use('/user/files', express.static(USER_FILES, staticOpts));
const vendor = {
    'jquery.js': 'jquery/dist/jquery.min.js',
    'purify.js': 'dompurify/dist/purify.es.mjs',
    'marked.js': 'marked/lib/marked.esm.js',
    // Libraries SillyTavern bundles (lib.js) and extensions expect to find.
    'lodash.js': 'lodash/lodash.min.js',
    'handlebars.js': 'handlebars/dist/handlebars.min.js',
    'moment.js': 'moment/min/moment.min.js',
    'localforage.js': 'localforage/dist/localforage.min.js',
    'showdown.js': 'showdown/dist/showdown.min.js',
    'popper.js': '@popperjs/core/dist/umd/popper.min.js',
    'fuse.js': 'fuse.js/dist/fuse.min.mjs',
};
for (const [name, rel] of Object.entries(vendor)) {
    const file = path.join(ROOT, 'node_modules', rel);
    app.get(`/vendor/${name}`, (_req, res) => res.sendFile(file, { maxAge: '7d' }));
}
app.use('/vendor/fontawesome', express.static(path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free'), { maxAge: '30d' }));
app.use(extensionsServe);
app.use(express.static(PUBLIC, { index: 'index.html', setHeaders: res => res.set('Cache-Control', 'no-cache') }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: err.message || 'Server error' });
});

app.listen(PORT, HOST, () => {
    console.log(`\n  ✦ Reverie is running → http://localhost:${PORT}`);
    console.log(`    data folder: ${DATA_DIR}`);
    if (!PASSWORD) console.log('    ⚠ No APP_PASSWORD set — anyone who can reach this address can use it. Set one before exposing it online.\n');
    if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
        console.log('    ⚠ No Railway volume attached: characters and chats will be lost on every redeploy. Add a volume (any mount path).\n');
    }
});
