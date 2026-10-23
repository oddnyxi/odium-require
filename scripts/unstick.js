// Removes sticky headers, cookie walls, "subscribe" modals and scroll locks. Undo puts everything back.
let hidden = [];
let unlock = null;

function isOurs(el) { return el.id === 'odium-ui-host'; }

function sweep(ctx) {
  let n = 0;
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    if (isOurs(el) || hidden.some((h) => h.el === el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 400) continue; // leave tiny floating buttons alone
    if (el.querySelector('video') && r.width * r.height < vw * vh * 0.5) continue; // mini players
    hidden.push({ el, prev: el.style.getPropertyValue('display'), prio: el.style.getPropertyPriority('display') });
    el.style.setProperty('display', 'none', 'important');
    n++;
  }
  if (!unlock) {
    unlock = ctx.addStyle('html, body { overflow: auto !important; position: static !important; height: auto !important; } body { touch-action: auto !important; }');
  }
  for (const el of [document.documentElement, document.body]) el && el.classList.remove('modal-open', 'no-scroll', 'noscroll', 'overflow-hidden');
  ctx.notify(n ? `Hid ${n} fixed/sticky element${n === 1 ? '' : 's'}. Alt+Shift+U to undo.` : 'Nothing sticky found; scrolling unlocked', 'success');
}

function undo(ctx) {
  hidden.forEach(({ el, prev, prio }) => { if (prev) el.style.setProperty('display', prev, prio); else el.style.removeProperty('display'); });
  const n = hidden.length;
  hidden = [];
  if (unlock) { unlock(); unlock = null; }
  if (ctx) ctx.notify(`Restored ${n} element${n === 1 ? '' : 's'}`);
}

module.exports = {
  async start(ctx) {
    ctx.hotkey('Alt+Shift+K', () => sweep(ctx));
    ctx.hotkey('Alt+Shift+U', () => undo(ctx));
    const auto = await ctx.store.get('autoSites', []);
    if (auto.includes(location.hostname)) setTimeout(() => sweep(ctx), 1500);
  },

  stop() { undo(null); },

  async panel(tab, ctx) {
    tab.createButton('Remove sticky stuff', () => sweep(ctx), { icon: ctx.Icons.eraser }).setTooltip('Alt+Shift+K');
    tab.createButton('Undo', () => undo(ctx), { icon: ctx.Icons.refresh }).setTooltip('Alt+Shift+U');
    const auto = await ctx.store.get('autoSites', []);
    tab.createToggle(`Do it automatically on ${location.hostname}`, async (on) => {
      const list = (await ctx.store.get('autoSites', [])).filter((h) => h !== location.hostname);
      if (on) list.push(location.hostname);
      await ctx.store.set('autoSites', list);
    }, auto.includes(location.hostname), { save: false });
  },
};
