// Big QR code of the current page (or any text) so you can open it on your phone.
let qrcode;
let host = null;

function svgFor(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 3, scalable: true });
}

function close() { if (host) { host.remove(); host = null; } }

function show(ctx, text) {
  close();
  let svg;
  try { svg = svgFor(text); } catch (e) { return ctx.notify('Too long for a QR code', 'error'); }
  host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .bg { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; background: rgba(8,8,10,.72); backdrop-filter: blur(4px); }
    .card { background: #fff; padding: 22px; border-radius: 16px; width: min(380px, 86vw); box-shadow: 0 20px 60px rgba(0,0,0,.5); text-align: center; font: 13px system-ui, sans-serif; color: #333; }
    .card svg { width: 100%; height: auto; display: block; }
    .t { margin-top: 10px; word-break: break-all; max-height: 3.9em; overflow: hidden; }`);
  root.adoptedStyleSheets = [sheet];
  const bg = document.createElement('div');
  bg.className = 'bg';
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = text;
  card.appendChild(t);
  bg.appendChild(card);
  bg.onclick = (e) => { if (e.target === bg) close(); };
  root.appendChild(bg);
  document.documentElement.appendChild(host);
}

module.exports = {
  async start(ctx) {
    qrcode = await ctx.require('qrcode');
    ctx.hotkey('Alt+Shift+Q', () => (host ? close() : show(ctx, location.href)));
    ctx.on(window, 'keydown', (e) => { if (host && e.key === 'Escape') close(); }, true);
  },

  stop() { close(); },

  panel(tab, ctx) {
    tab.createButton('QR for this page', () => show(ctx, location.href), { icon: ctx.Icons.monitor }).setTooltip('Alt+Shift+Q');
    tab.createTextInput('QR for text', null, { placeholder: 'Type and press Enter', save: false, onEnter: (v) => v && show(ctx, v) });
    tab.createButton('QR for selection', () => {
      const s = String(getSelection() || '').trim();
      s ? show(ctx, s) : ctx.notify('Select some text first', 'warn');
    });
  },
};
