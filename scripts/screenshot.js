// Page screenshots with html2canvas: the visible area or the full page, saved as PNG.
// html2canvas re-renders the DOM, so it's a close approximation rather than a pixel-perfect capture.
let html2canvas;

async function shoot(ctx, full) {
  ctx.notify('Rendering…', 'info', 1200);
  const opts = {
    useCORS: true,
    logging: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff',
    ignoreElements: (el) => el.id === 'odium-ui-host',
    scale: Math.min(2, devicePixelRatio || 1),
  };
  if (!full) Object.assign(opts, { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight });
  try {
    const canvas = await html2canvas(document.body, opts);
    canvas.toBlob((blob) => {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      ctx.download(blob, `${location.hostname}-${stamp}.png`);
      ctx.notify('Screenshot saved', 'success');
    }, 'image/png');
  } catch (e) {
    ctx.notify('Screenshot failed: ' + e.message, 'error', 5000);
  }
}

module.exports = {
  async start(ctx) {
    html2canvas = await ctx.require('html2canvas');
    ctx.hotkey('Alt+Shift+S', () => shoot(ctx, false));
  },

  panel(tab, ctx) {
    tab.createButton('Visible area', () => shoot(ctx, false), { icon: ctx.Icons.monitor }).setTooltip('Alt+Shift+S');
    tab.createButton('Full page', () => shoot(ctx, true), { icon: ctx.Icons.layout });
  },
};
