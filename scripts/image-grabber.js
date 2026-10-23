// Lists every image on the page and downloads them as one ZIP (JSZip). Fetches go through the
// userscript manager, so images on other domains/CDNs work too.
let JSZip;
let minSize = 64;

function collect() {
  const seen = new Map();
  const add = (url, w, h, alt) => {
    if (!url || url.startsWith('blob:')) return;
    try { url = new URL(url, location.href).href; } catch (e) { return; }
    const prev = seen.get(url);
    if (!prev || w * h > prev.w * prev.h) seen.set(url, { url, w: w || 0, h: h || 0, alt: alt || '' });
  };
  document.querySelectorAll('img').forEach((i) => add(i.currentSrc || i.src, i.naturalWidth, i.naturalHeight, i.alt));
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((m) => add(m.content, 9999, 9999, 'preview'));
  document.querySelectorAll('svg image').forEach((i) => add(i.href && i.href.baseVal, 0, 0, ''));
  return [...seen.values()].filter((x) => (x.w === 0 && x.h === 0) || Math.max(x.w, x.h) >= minSize);
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };

function fileName(url, type, used) {
  let base = 'image';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image'); } catch (e) { /* data: url */ }
  base = base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'image';
  const ext = EXT[(type || '').split(';')[0]];
  if (ext && !/\.\w{2,5}$/.test(base)) base += '.' + ext;
  let name = base, i = 1;
  while (used.has(name)) name = base.replace(/(\.\w+)?$/, `-${i++}$1`);
  used.add(name);
  return name;
}

async function fetchImage(ctx, url) {
  if (url.startsWith('data:')) { const r = await fetch(url); return { buf: await r.arrayBuffer(), type: r.headers.get('content-type') }; }
  const r = await ctx.request(url, { responseType: 'arraybuffer', timeout: 20000 });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = (/content-type:\s*([^\r\n]+)/i.exec(r.headers || '') || [])[1];
  return { buf: r.response, type };
}

module.exports = {
  async start(ctx) {
    JSZip = await ctx.require('jszip');
    minSize = await ctx.store.get('minSize', 64);
  },

  panel(tab, ctx) {
    const stat = tab.createStat('Images found', '…');
    const table = tab.createTable(['Size', 'Image'], [], { height: 170, onRowClick: (row, i) => { const x = collect()[i]; if (x) window.open(x.url, '_blank', 'noopener'); } });
    const refresh = () => {
      const list = collect();
      stat.setValue(String(list.length));
      table.setRows(list.slice(0, 300).map((x) => [x.w && x.h && x.w !== 9999 ? `${x.w}×${x.h}` : '?', x.url.replace(/^https?:\/\//, '').slice(0, 90)]));
      return list;
    };
    tab.createSlider('Skip images smaller than', (v) => { minSize = v; ctx.store.set('minSize', v); refresh(); }, { min: 0, max: 600, step: 16, value: minSize, suffix: 'px', save: false });
    const bar = tab.createProgressbar('Progress', 0);
    bar.setVisible(false);
    const [a, b, c] = tab.createColumns(3);
    a.createButton('Rescan', refresh, { icon: ctx.Icons.refresh });
    b.createButton('Copy URLs', async () => { const l = refresh(); await ctx.copy(l.map((x) => x.url).join('\n')); ctx.notify(`Copied ${l.length} URLs`, 'success'); }, { icon: ctx.Icons.copy });
    c.createButton('Download ZIP', async () => {
      const list = refresh();
      if (!list.length) return ctx.notify('No images to download', 'warn');
      const zip = new JSZip();
      const used = new Set();
      let done = 0, failed = 0;
      bar.setVisible(true);
      bar.setValue(0);
      const queue = list.slice();
      const worker = async () => {
        while (queue.length) {
          const x = queue.shift();
          try { const { buf, type } = await fetchImage(ctx, x.url); zip.file(fileName(x.url, type, used), buf); }
          catch (e) { failed++; ctx.log('skip', x.url, e.message); }
          bar.setValue(Math.round((++done / list.length) * 100));
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      const blob = await zip.generateAsync({ type: 'blob' });
      ctx.download(blob, `${location.hostname}-images.zip`);
      bar.setVisible(false);
      ctx.notify(`Zipped ${list.length - failed} images${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'success');
    }, { icon: ctx.Icons.download });
    refresh();
  },
};
