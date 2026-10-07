// Minimal PNG tEXt chunk reader/writer for SillyTavern / Chub character cards.
// Cards store base64 JSON in a tEXt chunk named "chara" (V2) and/or "ccv3" (V3).

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function isPng(buf) {
    return buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

function* chunks(buf) {
    let offset = 8;
    while (offset + 12 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('latin1', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + length);
        yield { type, data, start: offset, end: offset + 12 + length };
        offset += 12 + length;
        if (type === 'IEND') return;
    }
}

/** Returns { chara, ccv3 } with decoded JSON strings (or undefined). */
export function readCardText(buf) {
    if (!isPng(buf)) throw Object.assign(new Error('Not a PNG file'), { status: 400 });
    const out = {};
    for (const chunk of chunks(buf)) {
        if (chunk.type !== 'tEXt') continue;
        const sep = chunk.data.indexOf(0);
        if (sep < 0) continue;
        const keyword = chunk.data.toString('latin1', 0, sep).toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') {
            out[keyword] = Buffer.from(chunk.data.toString('latin1', sep + 1), 'base64').toString('utf8');
        }
    }
    return out;
}

function makeTextChunk(keyword, text) {
    const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write('tEXt', 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
}

/** Embed card JSON into a PNG, replacing any existing card chunks. */
export function writeCardText(buf, cardJson) {
    if (!isPng(buf)) throw Object.assign(new Error('Not a PNG file'), { status: 400 });
    const parts = [SIGNATURE];
    const json = typeof cardJson === 'string' ? cardJson : JSON.stringify(cardJson);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    let v3 = null;
    try {
        const parsed = JSON.parse(json);
        v3 = JSON.stringify({ ...parsed, spec: 'chara_card_v3', spec_version: '3.0' });
    } catch { /* keep v2 only */ }
    for (const chunk of chunks(buf)) {
        if (chunk.type === 'tEXt') {
            const sep = chunk.data.indexOf(0);
            const keyword = chunk.data.toString('latin1', 0, sep).toLowerCase();
            if (keyword === 'chara' || keyword === 'ccv3') continue;
        }
        if (chunk.type === 'IEND') {
            parts.push(makeTextChunk('chara', b64));
            if (v3) parts.push(makeTextChunk('ccv3', Buffer.from(v3, 'utf8').toString('base64')));
        }
        parts.push(buf.subarray(chunk.start, chunk.end));
    }
    return Buffer.concat(parts);
}
