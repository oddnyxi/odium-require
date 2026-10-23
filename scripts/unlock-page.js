// Gives back right-click, text selection, copy and drag on sites that block them.
// Works by swallowing those events in the capture phase before the page's own handlers can cancel them.
const BASE = ['contextmenu', 'copy', 'selectstart', 'dragstart'];
let opts = { paste: false };
let offs = [];

function arm(ctx) {
  offs.forEach((f) => f());
  const swallow = (e) => e.stopImmediatePropagation();
  const events = BASE.concat(opts.paste ? ['paste', 'cut'] : []);
  offs = events.map((t) => ctx.on(window, t, swallow, true));
  // Inline blockers like <body oncontextmenu="return false">
  for (const el of [document, document.documentElement, document.body]) {
    if (!el) continue;
    events.forEach((t) => { if (el['on' + t]) el['on' + t] = null; });
  }
}

module.exports = {
  async start(ctx) {
    opts = await ctx.store.get('opts', opts);
    ctx.addStyle('*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; }');
    arm(ctx);
  },

  panel(tab, ctx) {
    tab.createMultiLineLabel('Right-click, select, copy and drag are unlocked on this page.');
    tab.createToggle('Also unlock paste / cut', async (v) => { opts.paste = v; await ctx.store.set('opts', opts); arm(ctx); }, opts.paste, { save: false })
      .setTooltip('Off by default: rich editors (Docs, Notion…) need their own paste handling.');
  },
};
