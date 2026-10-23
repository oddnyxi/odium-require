// Turn the whole page into an editable document (designMode). Handy for mockups and screenshots.
let toggle = null;

const isOn = () => document.designMode === 'on';
function set(on, ctx) {
  document.designMode = on ? 'on' : 'off';
  if (toggle) toggle.setValue(on, true);
  ctx.notify(on ? 'Page is editable. Alt+Shift+E to stop.' : 'Editing off');
}

module.exports = {
  start(ctx) {
    ctx.hotkey('Alt+Shift+E', () => set(!isOn(), ctx));
  },

  stop() {
    document.designMode = 'off';
  },

  panel(tab, ctx) {
    toggle =tab.createToggle('Edit this page', (v) => set(v, ctx), isOn(), { save: false });
    toggle.setTooltip('Alt+Shift+E');
    tab.createButton('Copy edited HTML', async () => {
      await ctx.copy('<!doctype html>\n' + document.documentElement.outerHTML);
      ctx.notify('Copied page HTML', 'success');
    }, { icon: ctx.Icons.copy });
  },
};
