// Message formatting: markdown, quote highlighting, regex display scripts, and live
// HTML/CSS/JS (+ Python via Pyodide) widgets rendered inside sandboxed iframes.
import { marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
import { state } from './state.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
import { escapeHtml } from './ui.js';

marked.setOptions({ gfm: true, breaks: true });

const HTML_DOC = /<!doctype html|<html[\s>]|<body[\s>]|<script[\s>]|<style[\s>]|<canvas[\s>]|<svg[\s>]/i;
const FENCE = /(^|\n)[ \t]*(```|~~~)[ \t]*([\w+#.\-: ]*)[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
const RAW_DOC = /<!doctype html[\s\S]*?<\/html>|<html[\s>][\s\S]*?<\/html>/gi;
const PIC_TAGS = /<pic\s+prompt\s*=\s*(["'])([\s\S]*?)\1\s*\/?>(?:\s*<\/pic>)?|\[(?:img|pic|image)\s*:\s*([^\]]+)\]|<img\s+prompt\s*=\s*(["'])([\s\S]*?)\4[^>]*>/gi;

let scopeCounter = 0;

/**
 * @returns {{ html: string, widgets: Array<{kind, code}>, pics: string[], wholeDoc: boolean }}
 */
export function formatMessage(text, { isUser = false, depth, streaming = false, isReasoning = false } = {}) {
    const widgets = [];
    const pics = [];
    let src = applyRegex(String(text ?? ''), isReasoning ? REGEX_PLACEMENT.REASONING : (isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT), { isMarkdown: true, depth });
    const render = state.settings.render;

    if (state.settings.image.inlineTags) {
        src = src.replace(PIC_TAGS, (_m, _q, p1, p2, _q2, p3) => {
            pics.push(String(p1 ?? p2 ?? p3 ?? '').trim());
            return `<rv-pic data-i="${pics.length - 1}"></rv-pic>`;
        });
    }

    if (render.html) {
        src = src.replace(FENCE, (match, lead, _fence, langRaw, code) => {
            const lang = String(langRaw || '').trim().toLowerCase();
            if (/^(python|py|python3|pyodide)$/.test(lang) && render.python !== 'off') {
                widgets.push({ kind: 'python', code });
                return `${lead}\n<rv-widget data-i="${widgets.length - 1}"></rv-widget>\n`;
            }
            const htmlish = /^(html|htm|xhtml|svg|js-run|javascript-run|run|render)$/.test(lang) || (!lang && HTML_DOC.test(code));
            if (htmlish && !/^(xml)$/.test(lang)) {
                const body = /run$/.test(lang) && !/<script/i.test(code) ? `<script>\n${code}\n</script>` : code;
                widgets.push({ kind: 'html', code: body });
                return `${lead}\n<rv-widget data-i="${widgets.length - 1}"></rv-widget>\n`;
            }
            return match;
        });
        src = src.replace(RAW_DOC, doc => {
            widgets.push({ kind: 'html', code: doc });
            return `\n<rv-widget data-i="${widgets.length - 1}"></rv-widget>\n`;
        });
    }

    // Loose <script> tags (common in regex-generated status panels): render the whole message live.
    const wholeDoc = render.html && render.iframeScripts && /<script[\s>]/i.test(src.replace(FENCE, ''));

    let html = marked.parse(src);
    if (wholeDoc && !streaming) {
        widgets.push({ kind: 'html', code: html, whole: true });
        return { html: `<rv-widget data-i="${widgets.length - 1}"></rv-widget>`, widgets, pics, wholeDoc };
    }

    html = DOMPurify.sanitize(html, {
        FORCE_BODY: true,
        ADD_TAGS: ['style', 'rv-widget', 'rv-pic', 'q', 'details', 'summary', 'audio', 'video', 'source', 'font', 'center'],
        ADD_ATTR: ['data-i', 'target', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'open', 'color', 'face', 'size', 'align'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'link', 'meta', 'base'],
        FORBID_ATTR: ['srcdoc'],
    });
    return { html, widgets, pics, wholeDoc };
}

/** Post-process a rendered .mes_text: quote colouring, scoped <style>, widgets and inline images. */
export function hydrate(container, result, { streaming = false, onPic, message } = {}) {
    const scope = `s${++scopeCounter}`;
    container.dataset.rvscope = scope;
    for (const style of container.querySelectorAll('style')) {
        style.textContent = `@scope ([data-rvscope="${scope}"]) {\n${style.textContent}\n}`;
    }
    if (state.settings.render.quotes) highlightQuotes(container);
    for (const a of container.querySelectorAll('a[href]')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    }

    for (const node of container.querySelectorAll('rv-widget')) {
        const widget = result.widgets[Number(node.dataset.i)];
        if (!widget) continue;
        if (streaming) {
            node.replaceWith(buildingPlaceholder(widget.kind));
            continue;
        }
        node.replaceWith(widget.kind === 'python' ? pythonWidget(widget.code) : htmlWidget(widget.code, { whole: widget.whole }));
    }
    for (const node of container.querySelectorAll('rv-pic')) {
        const prompt = result.pics[Number(node.dataset.i)] || '';
        node.replaceWith(picWidget(prompt, message, { streaming, onPic }));
    }
}

function buildingPlaceholder(kind) {
    const div = document.createElement('div');
    div.className = 'rv-building';
    div.innerHTML = `<span class="spark">✦</span> ${kind === 'python' ? 'Writing code…' : 'Building scene…'}`;
    return div;
}

// ---------------- quotes ----------------
const SKIP = new Set(['CODE', 'PRE', 'STYLE', 'SCRIPT', 'Q', 'RV-WIDGET', 'RV-PIC', 'SVG', 'TEXTAREA']);
const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|TD|TH|DD|DT|SECTION|ARTICLE|DETAILS|SUMMARY|BODY)$/;

function blockOf(node) {
    let n = node.parentNode;
    while (n && !BLOCK.test(n.nodeName)) n = n.parentNode;
    return n;
}

export function highlightQuotes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            for (let p = node.parentNode; p && p !== root; p = p.parentNode) if (SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let inQuote = false;
    let lastBlock = null;
    for (const node of nodes) {
        const block = blockOf(node);
        if (block !== lastBlock) {
            inQuote = false;
            lastBlock = block;
        }
        const text = node.nodeValue;
        if (!/["“”«»]/.test(text) && !inQuote) continue;
        const frag = document.createDocumentFragment();
        let buf = '';
        const flush = () => {
            if (!buf) return;
            if (inQuote) {
                const q = document.createElement('q');
                q.textContent = buf;
                frag.append(q);
            } else frag.append(buf);
            buf = '';
        };
        for (const ch of text) {
            if (ch === '"') {
                if (inQuote) { buf += ch; flush(); inQuote = false; } else { flush(); inQuote = true; buf += ch; }
            } else if (ch === '“' || ch === '«') {
                flush(); inQuote = true; buf += ch;
            } else if ((ch === '”' || ch === '»') && inQuote) {
                buf += ch; flush(); inQuote = false;
            } else buf += ch;
        }
        flush();
        node.replaceWith(frag);
    }
}

// ---------------- iframe widgets ----------------
const frames = new Map(); // id -> iframe

function themeVars() {
    const cs = getComputedStyle(document.documentElement);
    const names = [
        '--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeQuoteColor', '--SmartThemeUnderlineColor',
        '--SmartThemeBlurTintColor', '--SmartThemeChatTintColor', '--SmartThemeBorderColor', '--SmartThemeShadowColor',
        '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor', '--rv-accent', '--rv-accent-2',
        '--rv-chat-font', '--rv-ui-font', '--mainFontSize', '--rv-surface', '--rv-surface-2', '--rv-text-dim', '--rv-radius',
    ];
    return names.map(n => `${n}: ${cs.getPropertyValue(n).trim() || 'initial'};`).join(' ');
}

const BRIDGE = `
(function(){
  var id = window.name; var seq = 0; var pending = {};
  function post(msg){ parent.postMessage(Object.assign({ rvFrame: id }, msg), '*'); }
  function call(method, args){ return new Promise(function(res, rej){ var n = ++seq; pending[n] = { res: res, rej: rej }; post({ rv: 'rpc', n: n, method: method, args: args || [] }); }); }
  addEventListener('message', function(e){ var d = e.data || {}; if (d.rvReply && pending[d.rvReply]) { var p = pending[d.rvReply]; delete pending[d.rvReply]; d.error ? p.rej(new Error(d.error)) : p.res(d.value); } });
  var last = 0;
  function measure(){ var b = document.body; if (!b) return; var cs = getComputedStyle(b); var h = Math.ceil(Math.max(b.scrollHeight, b.getBoundingClientRect().height) + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)); if (Math.abs(h - last) > 1) { last = h; post({ rv: 'height', h: h }); } }
  addEventListener('load', function(){ measure(); setTimeout(measure, 120); setTimeout(measure, 600); });
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.documentElement);
  setInterval(measure, 1000);
  window.Reverie = {
    send: function(text){ return call('send', [String(text)]); },
    sendSilently: function(text){ return call('sendSilently', [String(text)]); },
    setInput: function(text){ return call('setInput', [String(text)]); },
    generate: function(){ return call('generate'); },
    slash: function(cmd){ return call('slash', [String(cmd)]); },
    getVar: function(k){ return call('getVar', [k]); },
    setVar: function(k, v){ return call('setVar', [k, v]); },
    getGlobalVar: function(k){ return call('getGlobalVar', [k]); },
    setGlobalVar: function(k, v){ return call('setGlobalVar', [k, v]); },
    getVariables: function(){ return call('getVariables'); },
    getChat: function(){ return call('getChat'); },
    getContext: function(){ return call('getContext'); },
    toast: function(msg, type){ return call('toast', [String(msg), type || 'info']); },
    generateImage: function(prompt){ return call('generateImage', [String(prompt)]); },
    resize: measure
  };
  // TavernHelper / JS-Slash-Runner style aliases used by many interactive cards.
  window.triggerSlash = function(cmd){ return call('slash', [String(cmd)]); };
  window.getVariables = function(){ return call('getVariables'); };
  window.insertOrAssignVariables = function(vars){ return call('assignVariables', [vars]); };
  window.replaceVariables = function(vars){ return call('assignVariables', [vars]); };
  window.getChatMessages = function(){ return call('getChat'); };
  window.getLastMessageId = function(){ return call('lastMessageId'); };
  window.SillyTavern = window.SillyTavern || { getContext: function(){ return call('getContext'); } };
})();
`;

function frameDocument(code, { whole = false } = {}) {
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank">
<style>:root{ ${themeVars()} color-scheme: dark light; }
html,body{margin:0;padding:0;background:transparent;color:var(--SmartThemeBodyColor);font-family:${whole ? 'var(--rv-chat-font)' : 'var(--rv-ui-font)'},system-ui,sans-serif;font-size:var(--mainFontSize);line-height:1.6;overflow-x:hidden;}
${whole ? 'em,i{color:var(--SmartThemeEmColor)} q{color:var(--SmartThemeQuoteColor)} q::before,q::after{content:none} img{max-width:100%;border-radius:10px} p{margin:0 0 .8em}' : ''}
*{box-sizing:border-box} img,video,canvas,svg{max-width:100%}</style>
<script>${BRIDGE}</script>`;
    if (/<head[\s>]/i.test(code)) return code.replace(/<head([^>]*)>/i, `<head$1>${head}`);
    if (/<html[\s>]/i.test(code)) return code.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`;
}

export function htmlWidget(code, { whole = false } = {}) {
    const id = `rvf${Math.random().toString(36).slice(2)}`;
    const wrap = document.createElement('div');
    wrap.className = `rv-frame-wrap${whole ? ' whole' : ''}`;
    const iframe = document.createElement('iframe');
    iframe.name = id;
    iframe.className = 'rv-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-pointer-lock allow-downloads');
    iframe.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
    iframe.setAttribute('loading', 'lazy');
    iframe.style.height = whole ? '60px' : '48px';
    iframe.srcdoc = frameDocument(code, { whole });
    frames.set(id, iframe);
    wrap.append(iframe);
    if (!whole) {
        const bar = document.createElement('div');
        bar.className = 'rv-frame-bar';
        bar.innerHTML = '<button class="mini-btn" data-act="reload" title="Restart"><i class="fa-solid fa-rotate-right"></i></button><button class="mini-btn" data-act="source" title="View source"><i class="fa-solid fa-code"></i></button><button class="mini-btn" data-act="full" title="Fullscreen"><i class="fa-solid fa-expand"></i></button>';
        bar.addEventListener('click', e => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'reload') iframe.srcdoc = frameDocument(code);
            if (act === 'full') wrap.classList.toggle('fullscreen');
            if (act === 'source') {
                const pre = wrap.querySelector('pre.rv-source');
                if (pre) pre.remove();
                else {
                    const p = document.createElement('pre');
                    p.className = 'rv-source';
                    p.textContent = code;
                    wrap.append(p);
                }
            }
        });
        wrap.prepend(bar);
    }
    return wrap;
}

export function pythonWidget(code) {
    const wrap = document.createElement('div');
    wrap.className = 'rv-python';
    wrap.innerHTML = `<div class="rv-python-head"><span><i class="fa-brands fa-python"></i> Python</span><span class="grow"></span><button class="mini-btn run"><i class="fa-solid fa-play"></i> Run</button></div><pre class="rv-source"><code></code></pre>`;
    wrap.querySelector('code').textContent = code;
    const run = () => {
        wrap.querySelector('.rv-frame-wrap')?.remove();
        const base = state.settings.render.pyodideUrl.replace(/\/?$/, '/');
        const doc = `<div id="rv-py-root"></div><pre id="rv-py-out" style="white-space:pre-wrap;margin:0;font-family:'JetBrains Mono',monospace;font-size:.85em"></pre>
<div id="rv-py-status" style="opacity:.7;font-size:.85em">Loading Python…</div>
<script src="${escapeHtml(base)}pyodide.js"></script>
<script>
(async function(){
  var out = document.getElementById('rv-py-out'), status = document.getElementById('rv-py-status');
  try {
    var py = await loadPyodide({ indexURL: ${JSON.stringify(base)} });
    py.setStdout({ batched: function(s){ out.textContent += s + '\\n'; } });
    py.setStderr({ batched: function(s){ out.textContent += s + '\\n'; } });
    py.globals.set('display_html', function(h){ document.getElementById('rv-py-root').insertAdjacentHTML('beforeend', String(h)); });
    var code = ${JSON.stringify(code).replace(/<\//g, '<\\/')};
    status.textContent = 'Loading packages…';
    await py.loadPackagesFromImports(code);
    status.textContent = 'Running…';
    var result = await py.runPythonAsync(code);
    if (result !== undefined && result !== null) out.textContent += String(result) + '\\n';
    status.remove();
  } catch (e) { status.textContent = ''; out.textContent += '\\n' + String(e); out.style.color = '#ff8a8a'; }
})();
</script>`;
        wrap.append(htmlWidget(doc));
    };
    wrap.querySelector('.run').addEventListener('click', run);
    if (state.settings.render.python === 'auto') setTimeout(run, 0);
    return wrap;
}

function picWidget(prompt, message, { streaming, onPic }) {
    const url = message?.extra?.inline_images?.[prompt];
    const wrap = document.createElement('figure');
    wrap.className = 'rv-pic';
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = prompt;
        img.loading = 'lazy';
        img.className = 'rv-zoomable';
        wrap.append(img);
        const cap = document.createElement('figcaption');
        cap.innerHTML = '<button class="mini-btn" data-act="regen" title="Regenerate"><i class="fa-solid fa-rotate"></i></button>';
        cap.querySelector('button').addEventListener('click', () => onPic?.(prompt, true));
        wrap.append(cap);
        return wrap;
    }
    const pending = message?.extra?.inline_pending?.includes?.(prompt);
    wrap.classList.add('placeholder');
    wrap.innerHTML = `<div class="rv-pic-shimmer"></div><figcaption><span class="rv-pic-prompt"></span><button class="mini-btn" data-act="gen"><i class="fa-solid fa-wand-magic-sparkles"></i> ${pending ? 'Painting…' : 'Generate'}</button></figcaption>`;
    wrap.querySelector('.rv-pic-prompt').textContent = prompt;
    if (pending || streaming) wrap.classList.add('busy');
    wrap.querySelector('[data-act="gen"]').addEventListener('click', () => onPic?.(prompt, false));
    return wrap;
}

// ---------------- iframe messaging ----------------
let rpcHandler = null;
export function setFrameRpcHandler(fn) {
    rpcHandler = fn;
}

window.addEventListener('message', async e => {
    const data = e.data;
    if (!data || typeof data !== 'object' || !data.rvFrame) return;
    const iframe = frames.get(data.rvFrame);
    if (!iframe || iframe.contentWindow !== e.source) return;
    if (!iframe.isConnected) {
        frames.delete(data.rvFrame);
        return;
    }
    if (data.rv === 'height') {
        const max = iframe.closest('.whole') ? 6000 : 3200;
        iframe.style.height = `${Math.min(max, Math.max(24, Number(data.h) || 0)) + 2}px`;
    }
    if (data.rv === 'rpc' && rpcHandler) {
        let reply;
        try {
            reply = { rvReply: data.n, value: await rpcHandler(data.method, data.args || []) };
        } catch (err) {
            reply = { rvReply: data.n, error: err.message || String(err) };
        }
        try {
            e.source.postMessage(JSON.parse(JSON.stringify(reply)), '*');
        } catch { /* frame gone */ }
    }
});

// Forget frames that were removed from the DOM.
setInterval(() => {
    for (const [id, frame] of frames) if (!frame.isConnected) frames.delete(id);
}, 30000);

/** All inline image prompts in a message (<pic prompt="…">, [img: …], <img prompt="…">). */
export function extractPicPrompts(text) {
    const out = [];
    String(text ?? '').replace(PIC_TAGS, (_m, _q, p1, p2, _q2, p3) => {
        out.push(String(p1 ?? p2 ?? p3 ?? '').trim());
        return '';
    });
    return out.filter(Boolean);
}
