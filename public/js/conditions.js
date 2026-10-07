// A tiny, safe expression language for Reverie preset conditions ("Only include when…").
// No eval: tokenised and evaluated by a recursive-descent parser.
//
//   type == 'impersonate'            chat.length > 30           model ~ 'claude'
//   char.tags has 'fantasy'          var.tone == 'dark'          not var.nsfw
//   (provider == 'anthropic' or provider == 'openrouter') and chat.length >= 2
//
// Operators: == != > < >= <= ~ (case-insensitive contains, or /regex/), has (list/text contains),
// and / or / not, parentheses. Literals: 'text', "text", numbers, true, false.

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\/(?:[^/\\]|\\.)+\/[a-z]*)|(==|!=|>=|<=|>|<|~|\(|\))|([A-Za-z_][\w.]*))/y;

function tokenize(src) {
    const out = [];
    TOKEN.lastIndex = 0;
    let pos = 0;
    while (pos < src.length) {
        if (!src.slice(pos).trim()) break;
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(src);
        if (!m) throw new Error(`Unexpected "${src.slice(pos, pos + 12)}"`);
        pos = TOKEN.lastIndex;
        if (m[1]) out.push({ t: 'lit', v: Number(m[1]) });
        else if (m[2]) out.push({ t: 'lit', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
        else if (m[3]) out.push({ t: 'rx', v: m[3] });
        else if (m[4]) out.push({ t: 'op', v: m[4] });
        else {
            const w = m[5];
            if (['and', 'or', 'not', 'has'].includes(w.toLowerCase())) out.push({ t: 'op', v: w.toLowerCase() });
            else if (w === 'true' || w === 'false') out.push({ t: 'lit', v: w === 'true' });
            else out.push({ t: 'id', v: w });
        }
    }
    return out;
}

function lookup(ctx, path) {
    let v = ctx;
    for (const key of path.split('.')) {
        if (v === null || v === undefined) return undefined;
        v = typeof v.get === 'function' && !(key in v) ? v.get(key) : v[key];
    }
    return v;
}

function truthy(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
    return !!v;
}

function compare(op, a, b) {
    const na = Number(a);
    const nb = Number(b);
    const numeric = a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'boolean';
    switch (op) {
        case '==': return numeric ? na === nb : String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
        case '!=': return !compare('==', a, b);
        case '>': return numeric && na > nb;
        case '<': return numeric && na < nb;
        case '>=': return numeric && na >= nb;
        case '<=': return numeric && na <= nb;
        case '~': {
            if (b instanceof RegExp) return b.test(String(a ?? ''));
            return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
        }
        case 'has': {
            if (Array.isArray(a)) return a.some(x => String(x).toLowerCase() === String(b).toLowerCase());
            return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
        }
        default: return false;
    }
}

export function evaluateCondition(src, ctx) {
    const text = String(src ?? '').trim();
    if (!text) return true;
    const tokens = tokenize(text);
    let i = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];
    const value = () => {
        const tok = take();
        if (!tok) throw new Error('Unexpected end of condition');
        if (tok.t === 'lit') return tok.v;
        if (tok.t === 'rx') {
            const m = tok.v.match(/^\/(.+)\/([a-z]*)$/);
            return new RegExp(m[1], m[2] || 'i');
        }
        if (tok.t === 'id') return lookup(ctx, tok.v);
        if (tok.v === '(') {
            const v = orExpr();
            if (take()?.v !== ')') throw new Error('Missing )');
            return v;
        }
        throw new Error(`Unexpected "${tok.v}"`);
    };
    const cmp = () => {
        if (peek()?.v === 'not') {
            take();
            return !truthy(cmp());
        }
        const left = value();
        const op = peek();
        if (op && op.t === 'op' && ['==', '!=', '>', '<', '>=', '<=', '~', 'has'].includes(op.v)) {
            take();
            return compare(op.v, left, value());
        }
        return truthy(left);
    };
    const andExpr = () => {
        let v = cmp();
        while (peek()?.v === 'and') { take(); const r = cmp(); v = v && r; }
        return v;
    };
    function orExpr() {
        let v = andExpr();
        while (peek()?.v === 'or') { take(); const r = andExpr(); v = v || r; }
        return v;
    }
    const result = orExpr();
    if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].v}"`);
    return !!result;
}

/** Validate without a context; returns an error message or ''. */
export function checkCondition(src) {
    try {
        evaluateCondition(src, new Proxy({}, { get: () => '' }));
        return '';
    } catch (err) {
        return err.message;
    }
}

/** Does a model id match a profile pattern (substring, or /regex/)? */
export function modelMatches(pattern, model) {
    const p = String(pattern || '').trim();
    if (!p) return false;
    const rx = p.match(/^\/(.+)\/([a-z]*)$/);
    if (rx) {
        try { return new RegExp(rx[1], rx[2] || 'i').test(model); } catch { return false; }
    }
    return String(model || '').toLowerCase().includes(p.toLowerCase());
}
