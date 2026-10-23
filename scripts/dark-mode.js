// Dark mode for any site, powered by Dark Reader. Remembers per-site exclusions and your tuning.
let DR = null;
let cfg = { brightness: 100, contrast: 95, sepia: 0 };
let excluded = [];

const host = () => location.hostname;

async function apply(ctx) {
  if (!DR) return;
  if (excluded.includes(host())) DR.disable();
  else DR.enable(cfg);
}

module.exports = {
  async start(ctx) {
    DR = await ctx.require('darkreader');
    cfg = await ctx.store.get('theme', cfg);
    excluded = await ctx.store.get('excluded', []);
    // Let Dark Reader read cross-origin stylesheets through the userscript manager.
    DR.setFetchMethod((url) => ctx.request(url, { responseType: 'blob' }).then((r) => new Response(r.response)));
    await apply(ctx);
    ctx.hotkey('Alt+Shift+D', async () => {
      excluded = excluded.includes(host()) ? excluded.filter((h) => h !== host()) : [...excluded, host()];
      await ctx.store.set('excluded', excluded);
      await apply(ctx);
      ctx.notify(`Dark mode ${excluded.includes(host()) ? 'off' : 'on'} for ${host()}`);
    });
  },

  stop() {
    if (DR) DR.disable();
  },

  panel(tab, ctx) {
    tab.createToggle(`Dark on ${host()}`, async (on) => {
      excluded = on ? excluded.filter((h) => h !== host()) : [...new Set([...excluded, host()])];
      await ctx.store.set('excluded', excluded);
      await apply(ctx);
    }, !excluded.includes(host()), { save: false }).setTooltip('Alt+Shift+D toggles this site');

    const save = async () => { await ctx.store.set('theme', cfg); await apply(ctx); };
    tab.createSlider('Brightness', (v) => { cfg.brightness = v; save(); }, { min: 50, max: 150, value: cfg.brightness, suffix: '%', save: false });
    tab.createSlider('Contrast', (v) => { cfg.contrast = v; save(); }, { min: 50, max: 150, value: cfg.contrast, suffix: '%', save: false });
    tab.createSlider('Sepia', (v) => { cfg.sepia = v; save(); }, { min: 0, max: 100, value: cfg.sepia, suffix: '%', save: false });
    if (excluded.length) tab.createMultiLineLabel('Excluded sites: ' + excluded.join(', '));
  },
};
