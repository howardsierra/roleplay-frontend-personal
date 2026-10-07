// Plain-file storage. Everything lives under DATA_DIR so a single volume
// (Railway, Docker, or a folder on your phone) holds all of your data.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// DATA_DIR wins; on Railway an attached volume is used automatically.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), 'data'));

export const DIRS = {
    characters: path.join(DATA_DIR, 'characters'),
    avatars: path.join(DATA_DIR, 'avatars'),
    chats: path.join(DATA_DIR, 'chats'),
    presets: path.join(DATA_DIR, 'presets'),
    worlds: path.join(DATA_DIR, 'worlds'),
    themes: path.join(DATA_DIR, 'themes'),
    backgrounds: path.join(DATA_DIR, 'backgrounds'),
    images: path.join(DATA_DIR, 'images'),
    extensions: path.join(DATA_DIR, 'extensions'),
    personas: path.join(DATA_DIR, 'personas'),
};

export function ensureDirs() {
    for (const dir of [DATA_DIR, ...Object.values(DIRS)]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function newId() {
    return crypto.randomBytes(9).toString('base64url');
}

/** Restrict ids/filenames to a safe charset so they can never escape their folder. */
export function safeName(name) {
    const cleaned = String(name ?? '').replace(/[^\p{L}\p{N} _.\-()]/gu, '').replace(/^\.+/, '').trim().slice(0, 120);
    if (!cleaned) throw Object.assign(new Error('Invalid name'), { status: 400 });
    return cleaned;
}

export function within(dir, name) {
    const full = path.resolve(dir, safeName(name));
    if (!full.startsWith(path.resolve(dir) + path.sep)) {
        throw Object.assign(new Error('Invalid path'), { status: 400 });
    }
    return full;
}

export async function readJson(file, fallback = null) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

/** Atomic write: write to a temp file and rename, so a crash never leaves half a file. */
export async function writeJson(file, data) {
    await writeAtomic(file, JSON.stringify(data, null, 2));
}

export async function writeAtomic(file, contents) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, contents);
    await fsp.rename(tmp, file);
}

export async function listJson(dir) {
    let names = [];
    try {
        names = await fsp.readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const out = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
        try {
            const data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
            out.push({ file: name, data });
        } catch {
            // Skip unreadable files rather than breaking the whole list.
        }
    }
    return out;
}

export async function removeFile(file) {
    await fsp.rm(file, { force: true, recursive: true });
}
