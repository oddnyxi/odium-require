// ==UserScript==
// @name         OdiumRequire
// @namespace    https://github.com/oddnyxi/odium-require
// @version      1.0.0
// @description  require() for the browser. Load packages and scripts from JSON registries on any site, managed with Odium UI.
// @author       Nyxi
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addElement
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Two worlds:
 *   sandbox  – the userscript's own world. Scripts, the manager UI and the Console tab run here.
 *   page     – the site's world. `odium.require()` in DevTools and autoloaded packages live here.
 *
 * Code is always downloaded by the userscript (GM_xmlhttpRequest, no cookies), so page CORS and
 * connect-src rules don't apply. Page-world code is injected with GM_addElement, which the
 * userscript manager lets through the page's CSP.
 */
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const W = window;
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const HAS_GM = typeof GM !== 'undefined';

  const DEFAULTS = {
    registries: ['https://raw.githubusercontent.com/oddnyxi/odium-require/main/registry.json'],
    localRegistry: '',   // JSON pasted in the manager, merged last
    autoload: [],        // packages injected into every page
    scripts: {},         // script name -> enabled (overrides the registry's "default")
    exposePage: true,    // answer odium.require() calls made from the page
    exposeGlobals: true, // autoloaded packages also define their global (e.g. window._) when it's free
    pageUrls: false,     // let the page require() arbitrary https:// URLs
    hotkey: 'Alt+O',
    uiUrl: 'https://raw.githubusercontent.com/oddnyxi/odium-ui/main/dist/odium-ui.js',
    ttl: 6,              // hours to trust unversioned files before re-downloading
    registryTtl: 1,      // hours for registry JSON
  };

  /* ───────────────────────── GM adapter (Tampermonkey / Violentmonkey / Greasemonkey 4) ───────────────────────── */

  const GMX = {
    async get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        if (HAS_GM && GM.getValue) return await GM.getValue(k, d);
      } catch (e) { /* fall through */ }
      return d;
    },
    async set(k, v) {
      if (typeof GM_setValue === 'function') return GM_setValue(k, v);
      if (HAS_GM && GM.setValue) return GM.setValue(k, v);
    },
    async del(k) {
      if (typeof GM_deleteValue === 'function') return GM_deleteValue(k);
      if (HAS_GM && GM.deleteValue) return GM.deleteValue(k);
    },
    xhr(o) {
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(o);
      if (HAS_GM && GM.xmlHttpRequest) return GM.xmlHttpRequest(o);
      throw new Error('OdiumRequire needs GM_xmlhttpRequest');
    },
    addElement(parent, tag, attrs) {
      if (typeof GM_addElement === 'function') return GM_addElement(parent, tag, attrs);
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) { if (k === 'textContent') el.textContent = v; else el.setAttribute(k, v); }
      parent.appendChild(el);
      return el;
    },
    menu(name, fn) {
      try {
        if (typeof GM_registerMenuCommand === 'function') return GM_registerMenuCommand(name, fn);
        if (HAS_GM && GM.registerMenuCommand) return GM.registerMenuCommand(name, fn);
      } catch (e) { /* not supported */ }
    },
    clip(text) {
      if (typeof GM_setClipboard === 'function') return GM_setClipboard(text, 'text');
      if (HAS_GM && GM.setClipboard) return GM.setClipboard(text);
      return navigator.clipboard.writeText(text);
    },
  };

  let S = { ...DEFAULTS };
  const saveSettings = () => GMX.set('settings', S);

  /* ───────────────────────── events / log ───────────────────────── */

  const logBuffer = [];
  const listeners = new Set();
  function log(type, msg) {
    const line = { type, msg, t: Date.now() };
    logBuffer.push(line);
    if (logBuffer.length > 300) logBuffer.shift();
    const fn = type === 'error' ? console.error : type === 'warn' ? console.warn : console.log;
    fn.call(console, '%c[OdiumRequire]', 'color:#E11D2E;font-weight:bold', msg);
    listeners.forEach((l) => { try { l(line); } catch (e) { /* ignore */ } });
  }

  /* ───────────────────────── network + cache ───────────────────────── */

  function request(url, o = {}) {
    return new Promise((resolve, reject) => {
      GMX.xhr({
        method: o.method || 'GET',
        url,
        headers: o.headers,
        data: o.data,
        responseType: o.responseType,
        timeout: o.timeout || 30000,
        anonymous: o.anonymous,
        onload(r) {
          let text;
          try { text = r.responseText; } catch (e) { text = undefined; }
          resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, text, response: r.response, headers: r.responseHeaders, finalUrl: r.finalUrl });
        },
        onerror: () => reject(new Error('Network error: ' + url)),
        ontimeout: () => reject(new Error('Timed out: ' + url)),
      });
    });
  }

  // npm "@1.2.3" or a pinned git commit never change, so they're cached forever and pinned by hash.
  const IMMUTABLE = /@\d+\.\d+\.\d+[^/]*\/|@[0-9a-f]{40}\//i;

  async function cacheIndex() { return GMX.get('cacheIndex', []); }

  async function fetchText(url, o = {}) {
    const key = 'cache:' + url;
    const hit = o.force ? null : await GMX.get(key, null);
    const ttl = (o.ttl != null ? o.ttl : S.ttl) * 3600e3;
    if (hit && (IMMUTABLE.test(url) || Date.now() - hit.t < ttl)) {
      if (o.integrity) await verify(url, hit.code, o.integrity); // the same URL may be cached for another entry
      return hit.code;
    }

    let code;
    try {
      const r = await request(url, { anonymous: true });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      code = r.text;
    } catch (e) {
      if (hit) { log('warn', `${e.message}; using cached copy`); return hit.code; }
      throw e;
    }
    await verify(url, code, o.integrity);
    await GMX.set(key, { code, t: Date.now() });
    const idx = await cacheIndex();
    if (!idx.includes(url)) { idx.push(url); await GMX.set('cacheIndex', idx); }
    return code;
  }

  async function clearCache(url) {
    const idx = await cacheIndex();
    const drop = url ? idx.filter((u) => u === url) : idx;
    for (const u of drop) await GMX.del('cache:' + u);
    await GMX.set('cacheIndex', url ? idx.filter((u) => u !== url) : []);
    return drop.length;
  }

  async function cacheStats() {
    let bytes = 0;
    const idx = await cacheIndex();
    for (const u of idx) { const h = await GMX.get('cache:' + u, null); if (h && h.code) bytes += h.code.length; }
    return { files: idx.length, bytes };
  }

  async function digest(alg, text) {
    const buf = await W.crypto.subtle.digest(alg, new TextEncoder().encode(text));
    let s = '';
    new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s);
  }

  /** "integrity" in a registry entry is checked like SRI; versioned URLs without one are pinned on first download. */
  async function verify(url, code, integrity) {
    const subtle = W.crypto && W.crypto.subtle;
    if (integrity) {
      if (!subtle) throw new Error(`Can't check integrity of ${url} on an insecure (http) page`);
      const algs = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
      for (const want of String(integrity).trim().split(/\s+/)) {
        const [alg, hash] = want.split(/-(.+)/);
        if (algs[alg] && (await digest(algs[alg], code)) === hash) return;
      }
      throw new Error(`Integrity check failed for ${url}. Refusing to run it.`);
    }
    if (!IMMUTABLE.test(url) || !subtle) return;
    const got = 'sha256-' + (await digest('SHA-256', code));
    const pins = await GMX.get('pins', {});
    if (pins[url] && pins[url] !== got) {
      throw new Error(`${url} changed since it was first downloaded (pinned ${pins[url]}, got ${got}). Refusing to run it. Clear pins in Registries if this is expected.`);
    }
    if (!pins[url]) { pins[url] = got; await GMX.set('pins', pins); }
  }

  /* ───────────────────────── registry ───────────────────────── */

  let REG = { packages: {}, scripts: {}, sources: [] };

  function resolveUrl(u, base) {
    if (!u) return u;
    if (u.startsWith('npm:')) return 'https://cdn.jsdelivr.net/npm/' + u.slice(4);
    if (u.startsWith('gh:')) return 'https://cdn.jsdelivr.net/gh/' + u.slice(3);
    try { return new URL(u, base || undefined).href; } catch (e) { return u; }
  }

  function normalize(kind, name, v, base, source) {
    if (typeof v === 'string') v = { url: v };
    const list = (x) => [].concat(x == null ? [] : x);
    const e = {
      kind,
      name,
      title: v.title || name,
      url: resolveUrl(v.url, base),
      code: typeof v.code === 'string' ? v.code : null,
      version: v.version || '',
      description: v.description || '',
      category: v.category || 'Other',
      homepage: v.homepage || '',
      global: v.global || '',
      integrity: v.integrity || '',
      deps: list(v.deps || v.requires),
      css: list(v.css).map((c) => resolveUrl(c, base)),
      source,
    };
    if (kind === 'script') {
      e.match = list(v.match);
      e.exclude = list(v.exclude);
      e.default = !!v.default;
      e.icon = v.icon || '';
    }
    if (!e.url && !e.code) throw new Error(`${kind} "${name}" has no url or code`);
    return e;
  }

  function merge(reg, data, base, source) {
    let count = 0;
    for (const [n, v] of Object.entries(data.packages || {})) {
      try { reg.packages[n] = normalize('package', n, v, base, source); count++; } catch (e) { log('warn', `${source}: ${e.message}`); }
    }
    for (const [n, v] of Object.entries(data.scripts || {})) {
      try { reg.scripts[n] = normalize('script', n, v, base, source); count++; } catch (e) { log('warn', `${source}: ${e.message}`); }
    }
    return count;
  }

  async function loadRegistries(force) {
    const reg = { packages: {}, scripts: {}, sources: [] };
    for (const url of S.registries) {
      try {
        const data = JSON.parse(await fetchText(url, { force, ttl: S.registryTtl }));
        const count = merge(reg, data, url, data.name || url);
        reg.sources.push({ url, ok: true, name: data.name || url, count });
      } catch (e) {
        reg.sources.push({ url, ok: false, error: e.message, count: 0 });
        log('error', `Registry ${url}: ${e.message}`);
      }
    }
    if (S.localRegistry.trim()) {
      try {
        const count = merge(reg, JSON.parse(S.localRegistry), null, 'local');
        reg.sources.push({ url: 'local', ok: true, name: 'Local registry', count });
      } catch (e) {
        reg.sources.push({ url: 'local', ok: false, error: e.message, count: 0 });
        log('error', 'Local registry: ' + e.message);
      }
    }
    REG = reg;
    return reg;
  }

  function specFor(name) {
    if (REG.packages[name]) return REG.packages[name];
    if (name === 'odium-ui') return normalize('package', 'odium-ui', { url: S.uiUrl, global: 'OdiumUI' }, null, 'built-in');
    if (/^(npm:|gh:|https:\/\/)/.test(name)) return normalize('package', name, { url: name }, null, 'url');
    return null;
  }

  /* ───────────────────────── loader ───────────────────────── */

  const worlds = { sandbox: new Map(), page: new Map() }; // name -> Promise
  const resolved = { sandbox: new Map(), page: new Set() };

  const isEvalBlocked = (e) => e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(String(e && e.message));
  const sourceUrl = (world, name) => `\n//# sourceURL=odium-require://${world}/${encodeURIComponent(name)}.js`;

  function requireSync(name) {
    if (resolved.sandbox.has(name)) return resolved.sandbox.get(name);
    throw new Error(`OdiumRequire: "${name}" isn't loaded yet. List it in "deps", or use await require("${name}").`);
  }

  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

  function pickExports(module, initial, spec, root) {
    const ex = module.exports;
    const changed = ex !== initial || (ex && Object.keys(ex).length > 0);
    if (changed) return ex;
    if (spec.global) return getPath(root, spec.global);
    return ex;
  }

  function explain(e, spec) {
    if (e instanceof SyntaxError && /import|export/.test(e.message)) {
      return new Error(`${spec.name}: looks like an ES module. Point the registry at a UMD / IIFE / CommonJS build instead. (${e.message})`);
    }
    return e;
  }

  /** Some builds just do `var TurndownService = …` at the top level. Inside our wrapper that var is
   *  local, so hand it to module.exports from the same scope. */
  function globalTail(spec) {
    const g = spec.global;
    if (!g || !/^[A-Za-z_$][\w$]*$/.test(g)) return '';
    return `\n;if (typeof ${g} !== 'undefined' && module.exports === exports && !Object.keys(exports).length) module.exports = ${g};`;
  }

  function runSandbox(spec, code) {
    const module = { exports: {} };
    const initial = module.exports;
    let fn;
    try {
      // `define` is shadowed so UMD bundles take the CommonJS branch instead of an AMD loader on the page.
      fn = new Function('module', 'exports', 'require', 'define', code + globalTail(spec) + sourceUrl('sandbox', spec.name));
    } catch (e) {
      if (isEvalBlocked(e)) {
        // The manager runs inside the page world (strict CSP + page injection). Share the page copy.
        log('warn', `${spec.name}: eval is blocked here; using the page-world copy`);
        injectPage(spec, code);
        return getPath(PAGE, '__odiumRequire.modules')[spec.name];
      }
      throw explain(e, spec);
    }
    fn.call(W, module, module.exports, requireSync, undefined);
    return pickExports(module, initial, spec, W);
  }

  /* page world */

  const PAGE_BOOT = `(function(){
  if (window.__odiumRequire) return;
  var modules = Object.create(null), pending = {}, seq = 0;
  document.addEventListener('odium:res', function (e) {
    var d; try { d = JSON.parse(e.detail); } catch (_) { return; }
    var p = pending[d.id]; if (!p) return; delete pending[d.id];
    if (!d.ok) return p[1](new Error(d.error));
    p[0](d.list !== undefined ? d.list : modules[d.key]);
  });
  function send(op, name) {
    return new Promise(function (res, rej) {
      var id = ++seq; pending[id] = [res, rej];
      document.dispatchEvent(new CustomEvent('odium:req', { detail: JSON.stringify({ id: id, op: op, name: name }) }));
    });
  }
  function req(name) {
    if (Array.isArray(name)) return Promise.all(name.map(req));
    return name in modules ? Promise.resolve(modules[name]) : send('require', String(name));
  }
  var api = {
    version: '${VERSION}',
    require: req,
    modules: modules,
    list: function () { return send('list'); },
    help: function () {
      console.log('%cOdiumRequire', 'color:#E11D2E;font-weight:bold;font-size:14px',
        '\\n  await odium.require("lodash")          load a registry package' +
        '\\n  await odium.require(["dayjs","marked"]) load several' +
        '\\n  await odium.require("npm:pkg@1.0.0/dist/pkg.umd.js")  any UMD file on npm' +
        '\\n  odium.modules                          everything loaded so far' +
        '\\n  await odium.list()                     what the registries offer');
    }
  };
  window.__odiumRequire = api;
  if (window.odium === undefined) window.odium = api;
  if (window.orequire === undefined) window.orequire = req;
})();`;

  function injectScriptText(text) {
    const parent = document.head || document.documentElement;
    const el = GMX.addElement(parent, 'script', { textContent: text });
    if (el && el.remove) el.remove();
  }

  let bootInjected = false;
  function ensurePageBoot() {
    if (bootInjected) return;
    injectScriptText(PAGE_BOOT);
    bootInjected = true;
  }

  /** A parse error in an injected <script> never reaches our try/catch, so check syntax up front. */
  function syntaxCheck(spec, code) {
    try { new Function(code); } catch (e) {
      if (e instanceof SyntaxError) throw explain(e, spec);
      // eval blocked in this world: nothing to check with
    }
  }

  function injectPage(spec, code, defineGlobal) {
    ensurePageBoot();
    syntaxCheck(spec, code);
    const n = JSON.stringify(spec.name);
    const text = `;(function(){
var __n=${n},__g=${JSON.stringify(spec.global || '')},__dg=${defineGlobal ? 'true' : 'false'};
var __R=window.__odiumRequire, module={exports:{}}, __init=module.exports;
var __req=function(x){ if (__R && x in __R.modules) return __R.modules[x]; throw new Error('OdiumRequire: "'+x+'" is not loaded (add it to deps)'); };
try {
(function(module,exports,require,define){
${code}${globalTail(spec)}
}).call(window,module,module.exports,__req,void 0);
var e=module.exports;
if (e===__init && !Object.keys(e).length && __g) e=__g.split('.').reduce(function(o,k){return o==null?o:o[k];},window);
__R.modules[__n]=e;
if (__dg && __g && __g.indexOf('.')<0 && typeof window[__g]==='undefined') window[__g]=e;
document.dispatchEvent(new CustomEvent('odium:inj',{detail:JSON.stringify({n:__n,ok:true})}));
} catch (err) {
document.dispatchEvent(new CustomEvent('odium:inj',{detail:JSON.stringify({n:__n,ok:false,e:String(err&&err.message||err)})}));
}
})();${sourceUrl('page', spec.name)}`;

    let result = null;
    const onInj = (e) => {
      try { const d = JSON.parse(e.detail); if (d.n === spec.name) result = d; } catch (_) { /* not ours */ }
    };
    document.addEventListener('odium:inj', onInj);
    try { injectScriptText(text); } finally { document.removeEventListener('odium:inj', onInj); }
    if (!result) throw new Error(`${spec.name}: the page blocked script injection (CSP). It's still available to scripts and the Console tab.`);
    if (!result.ok) throw explain(new Error(`${spec.name}: ${result.e}`), spec);
    return true;
  }

  async function injectCss(url) {
    const css = await fetchText(url);
    addStyle(css);
  }

  /**
   * Load a package into a world. Resolves to its exports in the sandbox, or `true` for the page
   * (page code reads it from odium.modules).
   */
  function load(name, world = 'sandbox', stack = []) {
    const spec = specFor(name);
    if (!spec) return Promise.reject(new Error(`Unknown package "${name}". It isn't in any registry.`));
    const cache = worlds[world];
    if (cache.has(spec.name)) return cache.get(spec.name);
    if (stack.includes(spec.name)) return Promise.reject(new Error('Circular dependency: ' + [...stack, spec.name].join(' → ')));

    const p = (async () => {
      for (const d of spec.deps) await load(d, world, [...stack, spec.name]);
      for (const c of spec.css) await injectCss(c).catch((e) => log('warn', `${spec.name} css: ${e.message}`));
      const code = spec.code != null ? spec.code : await fetchText(spec.url, { integrity: spec.integrity });
      const t0 = performance.now();
      let out;
      if (world === 'page') {
        out = injectPage(spec, code, S.exposeGlobals && S.autoload.includes(spec.name));
        resolved.page.add(spec.name);
      } else {
        out = runSandbox(spec, code);
        resolved.sandbox.set(spec.name, out);
      }
      log('success', `${spec.name}${spec.version ? '@' + spec.version : ''} → ${world} (${Math.round(performance.now() - t0)} ms)`);
      return out;
    })();
    cache.set(spec.name, p);
    p.catch((e) => { cache.delete(spec.name); log('error', e.message); });
    return p;
  }

  const sandboxRequire = (name) => (Array.isArray(name) ? Promise.all(name.map((n) => load(n))) : load(name));

  /* page <-> userscript bridge */

  function installBridge() {
    document.addEventListener('odium:req', async (e) => {
      let d;
      try { d = JSON.parse(e.detail); } catch (_) { return; }
      if (!d || typeof d.id !== 'number') return;
      const reply = (o) => document.dispatchEvent(new CustomEvent('odium:res', { detail: JSON.stringify({ id: d.id, ...o }) }));
      if (!S.exposePage) return reply({ ok: false, error: 'odium.require() from the page is turned off in OdiumRequire options.' });
      if (d.op === 'list') {
        const list = Object.values(REG.packages).map((p) => ({ name: p.name, version: p.version, description: p.description, category: p.category, global: p.global, loaded: resolved.page.has(p.name) }));
        return reply({ ok: true, list });
      }
      const name = String(d.name || '');
      if (/^https:\/\//.test(name) && !S.pageUrls) {
        return reply({ ok: false, error: 'Loading arbitrary URLs from the page is off. Add the file to a registry, use npm:..., or enable it in OdiumRequire options.' });
      }
      try {
        await load(name, 'page');
        reply({ ok: true, key: specFor(name).name });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });
  }

  /* ───────────────────────── helpers shared with scripts ───────────────────────── */

  function addStyle(css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; // not subject to style-src CSP
      return { remove: () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); } };
    } catch (e) {
      const el = GMX.addElement(document.head || document.documentElement, 'style', { textContent: css });
      return { remove: () => el.remove() };
    }
  }

  function parseKey(spec) {
    const parts = String(spec).split('+').map((s) => s.trim()).filter(Boolean);
    const key = (parts.pop() || '').toLowerCase();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return { key, ctrl: mods.has('ctrl') || mods.has('control'), alt: mods.has('alt'), shift: mods.has('shift'), meta: mods.has('meta') || mods.has('cmd') };
  }

  const PUNCT = { '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', ',': 'comma', '.': 'period', '/': 'slash', ';': 'semicolon', "'": 'quote', '-': 'minus', '=': 'equal', '`': 'backquote' };
  function keyMatches(e, k) {
    if (e.ctrlKey !== k.ctrl || e.altKey !== k.alt || e.shiftKey !== k.shift || e.metaKey !== k.meta) return false;
    const code = (e.code || '').toLowerCase();
    // e.code fallbacks: Alt/Option changes e.key on macOS (Alt+O gives "ø").
    return (e.key || '').toLowerCase() === k.key || code === 'key' + k.key || code === 'digit' + k.key || code === k.key || code === PUNCT[k.key];
  }

  function isTyping(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''));
  }

  function bindHotkey(spec, fn) {
    const k = parseKey(spec);
    const h = (e) => {
      if (!keyMatches(e, k)) return;
      if (isTyping(e) && !(k.ctrl || k.alt || k.meta)) return;
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    };
    W.addEventListener('keydown', h, true);
    return () => W.removeEventListener('keydown', h, true);
  }

  let toastRoot = null;
  function notify(text, type = 'info', ms = 2800) {
    if (UIM.ui && UIM.ui.win) return UIM.ui.notify(text, type, ms);
    if (!toastRoot) {
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none';
      toastRoot = host.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(host);
    }
    const colors = { success: '#10B981', warn: '#F59E0B', error: '#E11D2E', info: '#3B82F6' };
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `font:13px/1.45 system-ui,sans-serif;color:#fafafa;background:#141416;border-left:3px solid ${colors[type] || colors.info};padding:9px 13px;margin-top:8px;border-radius:7px;box-shadow:0 8px 28px rgba(0,0,0,.45);max-width:360px`;
    toastRoot.appendChild(d);
    setTimeout(() => d.remove(), ms);
  }

  function download(data, filename, type = 'application/octet-stream') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ───────────────────────── scripts ───────────────────────── */

  const running = new Map(); // name -> { spec, ctx, mod }
  const scriptErrors = new Map();

  function globRe(p) {
    if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
    return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  }

  function matchesHere(spec) {
    const href = location.href;
    const inc = spec.match.length ? spec.match : ['*://*/*'];
    return inc.some((m) => globRe(m).test(href)) && !spec.exclude.some((m) => globRe(m).test(href));
  }

  const scriptEnabled = (spec) => (spec.name in S.scripts ? !!S.scripts[spec.name] : spec.default);

  function makeCtx(spec) {
    const cleanups = [];
    const ns = `store:${spec.name}:`;
    const ctx = {
      name: spec.name,
      spec,
      version: VERSION,
      window: W,
      page: PAGE,
      require: sandboxRequire,
      get ui() { return UIM.ui; },
      get Icons() { return UIM.Icons || {}; },
      notify,
      log: (...a) => log('info', `[${spec.name}] ${a.join(' ')}`),
      request,
      download,
      copy: (text) => GMX.clip(text),
      store: {
        get: (k, d) => GMX.get(ns + k, d),
        set: (k, v) => GMX.set(ns + k, v),
        del: (k) => GMX.del(ns + k),
      },
      addStyle(css) { const s = addStyle(css); cleanups.push(s.remove); return s.remove; },
      on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        const off = () => target.removeEventListener(type, fn, opts);
        cleanups.push(off);
        return off;
      },
      hotkey(k, fn) { const off = bindHotkey(k, fn); cleanups.push(off); return off; },
      onCleanup(fn) { cleanups.push(fn); },
      _cleanup() { while (cleanups.length) { try { cleanups.pop()(); } catch (e) { log('warn', `[${spec.name}] cleanup: ${e.message}`); } } },
    };
    return ctx;
  }

  async function startScript(spec) {
    if (running.has(spec.name)) return;
    const ctx = makeCtx(spec);
    const entry = { spec, ctx, mod: null };
    running.set(spec.name, entry);
    scriptErrors.delete(spec.name);
    try {
      for (const d of spec.deps) await load(d, 'sandbox');
      const code = spec.code != null ? spec.code : await fetchText(spec.url, { integrity: spec.integrity });
      const module = { exports: {} };
      let fn;
      try {
        fn = new Function('module', 'exports', 'require', 'ctx', code + sourceUrl('script', spec.name));
      } catch (e) {
        if (isEvalBlocked(e)) throw new Error(`${spec.name}: this page's CSP blocks scripts in the page world. Switch your userscript manager to inject into the content/isolated world.`);
        throw e;
      }
      fn.call(W, module, module.exports, requireSync, ctx);
      entry.mod = module.exports || {};
      if (typeof entry.mod.start === 'function') await entry.mod.start(ctx);
      log('success', `script ${spec.name} started`);
    } catch (e) {
      ctx._cleanup();
      running.delete(spec.name);
      scriptErrors.set(spec.name, e.message);
      log('error', `script ${spec.name}: ${e.message}`);
      notify(`${spec.title}: ${e.message}`, 'error', 5000);
    }
    UIM.refresh();
  }

  async function stopScript(name) {
    const entry = running.get(name);
    if (!entry) return;
    try {
      if (entry.mod && typeof entry.mod.stop === 'function') await entry.mod.stop(entry.ctx);
    } catch (e) { log('warn', `script ${name} stop: ${e.message}`); }
    entry.ctx._cleanup();
    running.delete(name);
    if (!entry.mod || typeof entry.mod.start !== 'function') {
      notify(`${entry.spec.title} has no stop(); reload the page to fully undo it`, 'warn');
    }
    log('info', `script ${name} stopped`);
    UIM.refresh();
  }

  async function setScriptEnabled(spec, on) {
    S.scripts[spec.name] = on;
    await saveSettings();
    if (on && matchesHere(spec)) await startScript(spec);
    if (!on) await stopScript(spec.name);
  }

  async function setAutoload(name, on) {
    S.autoload = S.autoload.filter((n) => n !== name);
    if (on) S.autoload.push(name);
    await saveSettings();
    if (on) {
      try {
        await load(name, 'page');
        const g = specFor(name).global;
        notify(`${name} loaded → odium.modules["${name}"]${g && S.exposeGlobals ? ` / window.${g}` : ''}`, 'success');
      } catch (e) { notify(e.message, 'error', 5000); }
    }
  }

  /* ───────────────────────── manager UI (Odium UI) ───────────────────────── */

  const UIM = {
    ui: null,
    Icons: null,
    preKey: null,
    building: null,
    lastTab: null,

    async ensureLib() {
      if (this.UIClass) return;
      await load('odium-ui', 'sandbox');
      this.UIClass = W.OdiumUI || W.UI;
      this.Icons = W.OdiumIcons || {};
      if (typeof this.UIClass !== 'function') throw new Error('odium-ui loaded but window.OdiumUI is missing');
    },

    async toggle() {
      if (this.ui && this.ui.win) return this.ui.toggle();
      await this.open();
    },

    async open() {
      if (this.building) return this.building;
      this.building = (async () => {
        try {
          await this.ensureLib();
          this.build();
        } catch (e) {
          notify('Manager UI failed to load: ' + e.message, 'error', 6000);
          log('error', 'odium-ui: ' + e.message);
        }
      })();
      await this.building;
      this.building = null;
    },

    /** Rebuild when what it shows changed (registry refresh, scripts started/stopped). */
    refresh() {
      if (!this.ui || !this.ui.win) return;
      const visible = !this.ui.win.classList.contains('hidden');
      this.lastTab = this.ui.active && this.ui.active.name;
      const r = this.ui.win.getBoundingClientRect();
      this.geom = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      this.ui.destroy();
      this.ui = null;
      this.build();
      if (!visible) this.ui.hide();
    },

    build() {
      const I = this.Icons;
      const ui = new this.UIClass();
      this.ui = ui;
      if (this.preKey) { this.preKey(); this.preKey = null; }
      ui.createWindow('ODIUM REQUIRE', { subtitle: 'v' + VERSION, toggleKey: S.hotkey, width: 660, height: 470, ...(this.geom || {}) });
      ui.destroy = ((orig) => function () {
        orig.call(this);
        UIM.armHotkey();
      })(ui.destroy);

      this.tabPackages(ui, I);
      this.tabScripts(ui, I);
      this.tabTools(ui, I);
      this.tabConsole(ui, I);
      this.tabRegistries(ui, I);
      this.tabOptions(ui, I);
      ui.addSettingsTab('Appearance', { group: 'System', icon: I.palette });

      const want = this.lastTab && ui.tabs.find((t) => t.name === this.lastTab);
      if (want) ui.selectTab(want);
    },

    armHotkey() {
      if (!this.preKey) this.preKey = bindHotkey(S.hotkey, () => this.toggle());
    },

    byCategory(list) {
      const m = new Map();
      list.sort((a, b) => a.name.localeCompare(b.name)).forEach((x) => {
        if (!m.has(x.category)) m.set(x.category, []);
        m.get(x.category).push(x);
      });
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    },

    tabPackages(ui, I) {
      const t = ui.addTab('Packages', { group: 'Library', icon: I.grid });
      const pkgs = Object.values(REG.packages).filter((p) => p.name !== 'odium-ui');
      const [c1, c2, c3] = t.createColumns(3);
      c1.createStat('Available', String(pkgs.length));
      c2.createStat('Autoload', String(S.autoload.length));
      c3.createStat('On this page', String(resolved.page.size));
      t.createSearchBox('Search packages…');
      if (!pkgs.length) t.createMultiLineLabel('No packages yet. Add a registry in System → Registries.');

      for (const [cat, list] of this.byCategory(pkgs)) {
        const g = t.createGroup(cat, { collapsed: false });
        for (const p of list) {
          const loaded = resolved.page.has(p.name);
          const h = g.createToggle(`${p.name}${loaded ? ' ●' : ''}  ·  ${p.description}`, (v) => setAutoload(p.name, v), S.autoload.includes(p.name), { save: false, id: 'pkg/' + p.name });
          h.setTooltip(`${p.name}${p.version ? ' ' + p.version : ''}${p.global ? ` · window.${p.global}` : ''}\nOn = load on every site. Right-click for more.`);
          h.setContextMenu([
            { type: 'label', text: p.name + (p.version ? ' ' + p.version : '') },
            { text: 'Load into this page now', icon: I.download, action: () => load(p.name, 'page').then(() => { notify(`${p.name} ready: odium.modules["${p.name}"]`, 'success'); this.refresh(); }, (e) => notify(e.message, 'error', 5000)) },
            { text: 'Copy require snippet', icon: I.copy, action: () => { GMX.clip(`const ${safeIdent(p.global || p.name)} = await odium.require('${p.name}');`); notify('Copied', 'success'); } },
            p.homepage && { text: 'Open homepage', icon: I.eye, action: () => W.open(p.homepage, '_blank', 'noopener') },
            { text: 'Re-download', icon: I.refresh, action: async () => { await clearCache(p.url); notify(`${p.name} will be downloaded fresh next load`); } },
          ].filter(Boolean));
        }
      }
    },

    tabScripts(ui, I) {
      const t = ui.addTab('Scripts', { group: 'Library', icon: I.terminal });
      const scripts = Object.values(REG.scripts);
      const [c1, c2, c3] = t.createColumns(3);
      c1.createStat('Available', String(scripts.length));
      c2.createStat('Enabled', String(scripts.filter(scriptEnabled).length));
      c3.createStat('Running here', String(running.size));
      t.createSearchBox('Search scripts…');
      if (!scripts.length) t.createMultiLineLabel('No scripts yet. Add a registry in System → Registries.');

      for (const [cat, list] of this.byCategory(scripts)) {
        const g = t.createGroup(cat, { collapsed: false });
        for (const s of list) {
          const here = matchesHere(s);
          const state = running.has(s.name) ? ' ●' : scriptErrors.has(s.name) ? ' ⚠' : '';
          const h = g.createToggle(`${s.title}${state}  ·  ${s.description}${here ? '' : '  (not on this site)'}`, (v) => setScriptEnabled(s, v), scriptEnabled(s), { save: false, id: 'script/' + s.name });
          h.setTooltip([
            scriptErrors.get(s.name) ? 'Error: ' + scriptErrors.get(s.name) : '',
            s.deps.length ? 'Uses: ' + s.deps.join(', ') : '',
            'Runs on: ' + (s.match.length ? s.match.join(', ') : 'every site'),
          ].filter(Boolean).join('\n'));
          h.setContextMenu([
            { type: 'label', text: s.title },
            { text: 'Run once on this page', icon: I.check, action: () => startScript(s) },
            { text: 'Stop on this page', icon: I.x, action: () => stopScript(s.name) },
            { text: 'Re-download', icon: I.refresh, action: async () => { if (s.url) await clearCache(s.url); notify(`${s.title} will be downloaded fresh next run`); } },
          ]);
        }
      }
    },

    tabTools(ui, I) {
      for (const { spec, ctx, mod } of running.values()) {
        if (!mod || typeof mod.panel !== 'function') continue;
        const tab = ui.addTab(spec.title, { group: 'Tools', icon: I[spec.icon] || spec.icon || I.sliders });
        const fail = (e) => { tab.createLabel('Panel error: ' + e.message); log('error', `[${spec.name}] panel: ${e.message}`); };
        try { Promise.resolve(mod.panel(tab, ctx)).catch(fail); } catch (e) { fail(e); }
      }
    },

    tabConsole(ui, I) {
      const t = ui.addTab('Console', { group: 'Dev', icon: I.terminal });
      t.createMultiLineLabel('Runs in the userscript sandbox. In scope: require(name) (async), page (the site\'s window), ui, notify(text, type), log(...). In DevTools, use odium.require() instead.');
      const out = t.createLog('Output', { height: 190, max: 400 });
      logBuffer.slice(-60).forEach((l) => out.log(l.msg, l.type));
      const onLog = (l) => out.log(l.msg, l.type);
      listeners.add(onLog);
      const prevDestroy = ui.destroy;
      ui.destroy = function () { listeners.delete(onLog); prevDestroy.call(this); };

      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const run = async (code) => {
        if (!code || !code.trim()) return;
        out.log('› ' + code.split('\n')[0] + (code.includes('\n') ? ' …' : ''), 'info');
        let fn;
        const args = ['require', 'page', 'ui', 'notify', 'log'];
        try { fn = new AsyncFunction(...args, 'return (' + code + '\n)'); } catch (e) {
          try { fn = new AsyncFunction(...args, code); } catch (e2) { return out.log(e2.message, 'error'); }
        }
        try {
          const v = await fn(sandboxRequire, PAGE, ui, notify, (...a) => out.log(a.map(fmt).join(' '), 'info'));
          if (v !== undefined) out.log(fmt(v), 'success');
        } catch (e) { out.log(e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : String(e), 'error'); }
      };
      const input = t.createTextInput('Run', null, { placeholder: "(await require('lodash')).chunk([1,2,3,4], 2)", save: false, onEnter: (v) => { run(v); input.setValue('', true); } });
      t.createButton('Multi-line…', async () => {
        const code = await ui.prompt('JavaScript (async, top-level await works)', { multiline: true, title: 'Run' });
        if (code) run(code);
      }, { icon: I.edit });
    },

    tabRegistries(ui, I) {
      const t = ui.addTab('Registries', { group: 'System', icon: I.list });
      t.createSection('Sources');
      REG.sources.forEach((s) => {
        t.createStat(s.url === 'local' ? 'Local registry' : shortUrl(s.url), s.ok ? `${s.count} entries` : 'failed')
          .setTooltip(s.ok ? s.url : s.error);
      });
      const lb = t.createListBox('Registry URLs (later ones override earlier)', S.registries.slice(), null, { height: 96, save: false });
      const [a, b, c] = t.createColumns(3);
      a.createButton('Add', async () => {
        const url = await ui.prompt('Registry JSON URL', { placeholder: 'https://raw.githubusercontent.com/you/repo/main/registry.json', title: 'Add registry' });
        if (!url) return;
        try { new URL(url); } catch (e) { return notify('That is not a URL', 'error'); }
        if (!S.registries.includes(url)) S.registries.push(url);
        await saveSettings();
        await reloadEverything(true);
      }, { icon: I.plus });
      b.createButton('Remove selected', async () => {
        const sel = [].concat(lb.getValue() || []);
        if (!sel.length) return notify('Select a registry first', 'warn');
        if (!(await ui.confirm(`Remove ${sel.join(', ')}?`))) return;
        S.registries = S.registries.filter((u) => !sel.includes(u));
        await saveSettings();
        await reloadEverything(false);
      }, { icon: I.trash });
      c.createButton('Refresh all', () => reloadEverything(true), { icon: I.refresh });

      t.createButton('Edit local registry…', async () => {
        const json = await ui.prompt('Same format as registry.json. Merged after the URLs above.', { multiline: true, title: 'Local registry', value: S.localRegistry || '{\n  "packages": {},\n  "scripts": {}\n}' });
        if (json == null) return;
        try { JSON.parse(json); } catch (e) { return notify('Invalid JSON: ' + e.message, 'error', 5000); }
        S.localRegistry = json;
        await saveSettings();
        await reloadEverything(false);
      }, { icon: I.edit });

      t.createSection('Cache');
      const st = t.createStat('Cached files', '…');
      cacheStats().then((s) => st.setValue(`${s.files} files · ${(s.bytes / 1024).toFixed(0)} KB`));
      const [d, e] = t.createColumns(2);
      d.createButton('Clear cache', async () => { const n = await clearCache(); notify(`Cleared ${n} files`, 'success'); st.setValue('0 files'); }, { icon: I.eraser });
      e.createButton('Reset pins', async () => {
        if (!(await ui.confirm('Forget the hashes recorded for versioned files? Only do this if a CDN file legitimately changed.'))) return;
        await GMX.set('pins', {});
        notify('Pins cleared', 'success');
      }, { icon: I.warning });
    },

    tabOptions(ui, I) {
      const t = ui.addTab('Options', { group: 'System', icon: I.settings });
      t.createSection('Page access');
      t.createToggle('odium.require() works in DevTools / page scripts', async (v) => { S.exposePage = v; await saveSettings(); }, S.exposePage, { save: false, id: 'opt/exposePage' });
      t.createToggle('Autoloaded packages also set their global (window._ etc.)', async (v) => { S.exposeGlobals = v; await saveSettings(); }, S.exposeGlobals, { save: false, id: 'opt/exposeGlobals' })
        .setTooltip("Only when that name isn't already taken by the site.");
      const urls = t.createToggle('Let pages require() any https:// URL', async (v) => {
        if (v && !(await ui.confirm('Any site you visit could then make OdiumRequire download and run a script of its choosing in its own page. Enable anyway?'))) { urls.setValue(false, true); return; }
        S.pageUrls = v;
        await saveSettings();
      }, S.pageUrls, { save: false, id: 'opt/pageUrls' });

      t.createSection('Manager');
      t.createKeybind('Open / close hotkey', (v) => { S.hotkey = v; saveSettings(); ui.setToggleKey(v); }, { value: S.hotkey, save: false, id: 'opt/hotkey' });
      t.createTextInput('Odium UI build URL', (v) => { S.uiUrl = v.trim(); saveSettings(); }, { value: S.uiUrl, save: false, id: 'opt/uiUrl' })
        .setTooltip('Used when no registry defines an "odium-ui" package.');
      t.createNumberInput('Re-check unversioned files every (hours)', (v) => { S.ttl = v; saveSettings(); }, { min: 0, max: 720, step: 1, value: S.ttl, save: false, id: 'opt/ttl' });

      t.createSection('About');
      t.createMultiLineLabel(`OdiumRequire ${VERSION}. Packages: ${Object.keys(REG.packages).length}, scripts: ${Object.keys(REG.scripts).length}. Type odium.help() in DevTools.`);
    },
  };

  function safeIdent(s) { const id = String(s).replace(/[^a-zA-Z0-9_$]/g, '_'); return /^[0-9]/.test(id) ? '_' + id : id; }
  function shortUrl(u) { try { const x = new URL(u); return x.hostname + x.pathname.replace(/^(.{0,28}).*?(.{0,22})$/, '$1…$2'); } catch (e) { return u; } }
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`;
    if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>`;
    try {
      const seen = new WeakSet();
      const s = JSON.stringify(v, (k, x) => {
        if (typeof x === 'function') return `ƒ ${x.name || ''}()`;
        if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
        return x;
      }, 2);
      return s && s.length > 2000 ? s.slice(0, 2000) + ' …' : String(s);
    } catch (e) { return String(v); }
  }

  /* ───────────────────────── boot ───────────────────────── */

  async function startAll() {
    for (const name of S.autoload) {
      if (!specFor(name)) { log('warn', `autoload: "${name}" is no longer in any registry`); continue; }
      load(name, 'page').catch(() => {});
    }
    for (const spec of Object.values(REG.scripts)) {
      if (scriptEnabled(spec) && matchesHere(spec)) startScript(spec);
    }
  }

  async function reloadEverything(force) {
    await loadRegistries(force);
    // Stop scripts that vanished or no longer apply.
    for (const name of [...running.keys()]) {
      const spec = REG.scripts[name];
      if (!spec || !scriptEnabled(spec) || !matchesHere(spec)) await stopScript(name);
    }
    await startAll();
    notify(`Registries: ${Object.keys(REG.packages).length} packages, ${Object.keys(REG.scripts).length} scripts`, 'success');
    UIM.refresh();
  }

  async function boot() {
    S = { ...DEFAULTS, ...(await GMX.get('settings', {})) };
    ensurePageBoot();
    installBridge();
    UIM.armHotkey();
    GMX.menu('Open OdiumRequire', () => UIM.open().then(() => UIM.ui && UIM.ui.show()));
    GMX.menu('Refresh registries', () => reloadEverything(true));
    await loadRegistries(false);
    await startAll();
  }

  // For other userscripts on @grant none pages and for debugging.
  W.OdiumRequire = { version: VERSION, require: sandboxRequire, load, registry: () => REG, open: () => UIM.open(), reload: reloadEverything };

  boot().catch((e) => log('error', 'boot: ' + e.message));
})();
