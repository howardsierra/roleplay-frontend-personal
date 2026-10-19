// Sandboxed iframes for Lumiverse extensions (ctx.dom.createSandboxFrame, ctx.messages.renderWidget),
// following Lumiverse's sandbox-frame protocol: an opaque-origin srcdoc iframe (allow-scripts only,
// strict CSP, no network) with a `window.spindleSandbox` bridge for postMessage/onMessage and
// auto-resize. Messages are matched by a per-frame token and the frame's own window.
const KEY = '__lumiverseSpindleSandbox';
const frames = new Map(); // token -> record
let installed = false;

function onMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object' || data[KEY] !== KEY || typeof data.token !== 'string') return;
    const rec = frames.get(data.token);
    if (!rec || rec.destroyed || event.source !== rec.iframe.contentWindow) return;
    if (typeof data.height === 'number' && Number.isFinite(data.height)) {
        rec.iframe.style.height = `${Math.max(rec.minHeight, Math.min(rec.maxHeight, Math.round(data.height)))}px`;
        return;
    }
    for (const fn of rec.handlers) {
        try { fn(data.payload); } catch (err) { console.error('[Spindle] sandbox frame message handler failed:', err); }
    }
}

const clamp = (v, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : min);
const token = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

function headInjection({ token: tok, autoResize, minHeight, maxHeight, allowEval }) {
    const scriptSrc = allowEval ? "'unsafe-inline' 'unsafe-eval'" : "'unsafe-inline'";
    return [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';">`,
        '<meta name="color-scheme" content="dark light">',
        '<style>html,body{margin:0;padding:0;background:transparent!important}body{box-sizing:border-box;overflow-x:hidden}:root{color-scheme:dark light}</style>',
        '<script>(function(){',
        `var KEY=${JSON.stringify(KEY)};var TOKEN=${JSON.stringify(tok)};var AUTO=${autoResize ? 'true' : 'false'};var MIN=${minHeight};var MAX=${maxHeight};`,
        'var handlers=[];var last=-1;',
        'function wire(x){try{window.parent.postMessage(Object.assign({__lumiverseSpindleSandbox:KEY,token:TOKEN},x),"*");}catch(e){}}',
        'function measure(){var b=document.body,d=document.documentElement;if(!b)return MIN;return Math.max(b.scrollHeight,b.offsetHeight,d?d.scrollHeight:0,d?d.offsetHeight:0,MIN);}',
        'function resize(h){var n=Math.max(MIN,Math.min(MAX,Math.ceil(typeof h==="number"&&isFinite(h)?h:measure())));if(n===last)return;last=n;wire({height:n});}',
        'window.addEventListener("message",function(e){var d=e.data;if(!d||typeof d!=="object"||d.__lumiverseSpindleSandbox!==KEY||d.token!==TOKEN||d.kind!=="host-message")return;for(var i=0;i<handlers.length;i++){try{handlers[i](d.payload);}catch(err){}}});',
        'function observe(){if(!AUTO||!document.body)return;resize();window.addEventListener("load",function(){resize();});window.addEventListener("resize",function(){resize();});if(typeof ResizeObserver!=="undefined"){try{var ro=new ResizeObserver(function(){resize();});ro.observe(document.documentElement);ro.observe(document.body);}catch(e){}}if(typeof MutationObserver!=="undefined"){try{new MutationObserver(function(){resize();}).observe(document.documentElement,{attributes:true,childList:true,characterData:true,subtree:true});}catch(e){}}}',
        'window.spindleSandbox=Object.freeze({postMessage:function(p){wire({payload:p});},onMessage:function(h){if(typeof h!=="function")return function(){};handlers.push(h);return function(){var i=handlers.indexOf(h);if(i!==-1)handlers.splice(i,1);};},requestResize:function(h){resize(typeof h==="number"?h:Number(h));}});',
        'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",observe,{once:true});else observe();',
        '})();</script>',
    ].join('');
}

function documentFor(html, opts) {
    const head = headInjection(opts);
    const src = String(html ?? '');
    if (/<(?:!doctype\b|html\b|head\b|body\b)/i.test(src)) {
        const m = src.match(/<head\b[^>]*>/i);
        return m ? src.slice(0, m.index + m[0].length) + head + src.slice(m.index + m[0].length) : head + src;
    }
    return `<!DOCTYPE html><html><head>${head}</head><body>${src}</body></html>`;
}

/**
 * @param {string} extensionId
 * @param {{ html?: string, minHeight?: number, maxHeight?: number, initialHeight?: number, autoResize?: boolean, allowEval?: boolean }} options
 * @returns {{ element: HTMLIFrameElement, setContent(html: string): void, postMessage(payload): void, onMessage(fn): () => void, destroy(): void }}
 */
export function createSandboxFrame(extensionId, options = {}) {
    if (!installed) { window.addEventListener('message', onMessage); installed = true; }
    const tok = token();
    const minHeight = clamp(options.minHeight ?? 40, 1, 4000);
    const maxHeight = clamp(options.maxHeight ?? 4000, minHeight, 4000);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-spindle-ext', extensionId);
    iframe.setAttribute('data-spindle-sandbox-frame', tok);
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'");
    iframe.referrerPolicy = 'no-referrer';
    Object.assign(iframe.style, { width: '100%', height: `${clamp(options.initialHeight ?? minHeight, minHeight, maxHeight)}px`, border: 'none', display: 'block', overflow: 'hidden', background: 'transparent' });
    const rec = { iframe, handlers: new Set(), minHeight, maxHeight, destroyed: false };
    frames.set(tok, rec);
    const opts = { token: tok, autoResize: options.autoResize !== false, minHeight, maxHeight, allowEval: options.allowEval === true };
    const handle = {
        element: iframe,
        setContent(html) { if (!rec.destroyed) iframe.srcdoc = documentFor(html, opts); },
        postMessage(payload) { if (!rec.destroyed) iframe.contentWindow?.postMessage({ [KEY]: KEY, token: tok, kind: 'host-message', payload }, '*'); },
        onMessage(fn) { if (typeof fn !== 'function') return () => {}; rec.handlers.add(fn); return () => rec.handlers.delete(fn); },
        destroy() {
            if (rec.destroyed) return;
            rec.destroyed = true;
            rec.handlers.clear();
            frames.delete(tok);
            iframe.remove();
        },
    };
    handle.setContent(options.html || '');
    return handle;
}
