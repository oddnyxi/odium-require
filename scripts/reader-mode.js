// Distraction-free reader view: Mozilla Readability extracts the article, DOMPurify sanitizes it.
let Readability, DOMPurify;
let host = null;
let prefs = { size: 19, theme: 'dark', width: 680 };

const THEMES = {
  dark: { bg: '#121214', fg: '#e7e7ea', muted: '#8b8b93', link: '#ff5a67' },
  light: { bg: '#fbfbfa', fg: '#1d1d1f', muted: '#6e6e73', link: '#c8102e' },
  sepia: { bg: '#f4ecd8', fg: '#433422', muted: '#7d6a50', link: '#9c3d10' },
};

function css() {
  const t = THEMES[prefs.theme] || THEMES.dark;
  return `
  :host { all: initial; }
  .wrap { position: fixed; inset: 0; z-index: 2147483646; overflow: auto; background: ${t.bg}; color: ${t.fg};
    font: ${prefs.size}px/1.7 Charter, "Iowan Old Style", Georgia, serif; -webkit-font-smoothing: antialiased; }
  .bar { position: sticky; top: 0; display: flex; gap: 6px; justify-content: flex-end; padding: 10px 16px;
    background: ${t.bg}; border-bottom: 1px solid color-mix(in srgb, ${t.fg} 10%, transparent); font: 13px system-ui, sans-serif; }
  .bar button { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 6px; color: ${t.muted}; }
  .bar button:hover { color: ${t.fg}; background: color-mix(in srgb, ${t.fg} 8%, transparent); }
  .wrap > article { max-width: ${prefs.width}px; margin: 0 auto; padding: 40px 20px 120px; }
  .wrap > article article, .wrap > article section { margin: 0; padding: 0; }
  h1.title { font-size: 1.9em; line-height: 1.2; margin: 0 0 .4em; }
  .meta { color: ${t.muted}; font: 14px system-ui, sans-serif; margin-bottom: 2.2em; }
  a { color: ${t.link}; }
  img, video, figure, iframe { max-width: 100%; height: auto; }
  figure { margin: 1.5em 0; } figcaption { color: ${t.muted}; font-size: .8em; }
  pre, code { font: .85em ui-monospace, Menlo, monospace; } pre { overflow: auto; padding: 12px; border-radius: 8px; background: color-mix(in srgb, ${t.fg} 6%, transparent); }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid ${t.link}; color: ${t.muted}; }
  table { border-collapse: collapse; } td, th { border: 1px solid color-mix(in srgb, ${t.fg} 15%, transparent); padding: 4px 8px; }`;
}

function close() {
  if (host) { host.remove(); host = null; document.documentElement.style.removeProperty('overflow'); }
}

async function open(ctx) {
  if (host) return close();
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article || !article.content) return ctx.notify("Couldn't find an article on this page", 'warn');

  host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css());
  root.adoptedStyleSheets = [sheet];

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; bar.appendChild(b); };
  const restyle = () => { sheet.replaceSync(css()); ctx.store.set('prefs', prefs); };
  btn('A−', () => { prefs.size = Math.max(14, prefs.size - 1); restyle(); });
  btn('A+', () => { prefs.size = Math.min(28, prefs.size + 1); restyle(); });
  btn('Theme', () => { const k = Object.keys(THEMES); prefs.theme = k[(k.indexOf(prefs.theme) + 1) % k.length]; restyle(); });
  btn('Close ✕', close);

  const el = document.createElement('article');
  const h1 = document.createElement('h1');
  h1.className = 'title';
  h1.textContent = article.title || document.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const words = (article.textContent || '').trim().split(/\s+/).length;
  meta.textContent = [article.byline, article.siteName || location.hostname, `${Math.max(1, Math.round(words / 230))} min read`].filter(Boolean).join(' · ');
  // A fragment rather than innerHTML keeps Trusted Types sites happy.
  const body = DOMPurify.sanitize(article.content, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form', 'input', 'button'] });
  const first = body.querySelector && body.querySelector('h1, h2');
  if (first && first.textContent.trim() === h1.textContent.trim()) first.remove(); // Readability often keeps the title too
  el.append(h1, meta, body);
  wrap.append(bar, el);
  root.appendChild(wrap);
  document.documentElement.appendChild(host);
  document.documentElement.style.overflow = 'hidden';
}

module.exports = {
  async start(ctx) {
    Readability = await ctx.require('readability');
    DOMPurify = await ctx.require('dompurify');
    prefs = await ctx.store.get('prefs', prefs);
    ctx.hotkey('Alt+Shift+R', () => open(ctx));
    ctx.on(window, 'keydown', (e) => { if (host && e.key === 'Escape') close(); }, true);
  },

  stop() { close(); },

  panel(tab, ctx) {
    tab.createButton('Open reader view', () => open(ctx), { icon: ctx.Icons.eye }).setTooltip('Alt+Shift+R · Esc to close');
    tab.createDropdown(Object.keys(THEMES), (v) => { prefs.theme = v; ctx.store.set('prefs', prefs); }, { label: 'Theme', selected: prefs.theme, save: false });
    tab.createSlider('Text size', (v) => { prefs.size = v; ctx.store.set('prefs', prefs); }, { min: 14, max: 28, value: prefs.size, suffix: 'px', save: false });
    tab.createSlider('Column width', (v) => { prefs.width = v; ctx.store.set('prefs', prefs); }, { min: 520, max: 960, step: 20, value: prefs.width, suffix: 'px', save: false });
  },
};
