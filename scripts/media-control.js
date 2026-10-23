// Playback speed for every <video>/<audio>, plus picture-in-picture and loop. Survives sites that reset the rate.
let rate = 1;
let slider = null;

const media = () => [...document.querySelectorAll('video, audio')];
const biggestVideo = () => [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];

function setRate(r, ctx, quiet) {
  rate = Math.round(Math.min(16, Math.max(0.1, r)) * 100) / 100;
  media().forEach((m) => { m.playbackRate = rate; });
  if (slider) slider.setValue(rate, true);
  ctx.store.set('rate', rate);
  if (!quiet) ctx.notify(`Speed ${rate}×`, 'info', 900);
}

module.exports = {
  async start(ctx) {
    rate = await ctx.store.get('rate', 1);
    setRate(rate, ctx, true);
    // Media events don't bubble, but the window still sees them in the capture phase.
    // Players often reset to 1× when a new video loads, so re-apply on play and on new media.
    const reapply = (e) => { const m = e.target; if (m && 'playbackRate' in m && m.playbackRate !== rate) m.playbackRate = rate; };
    ctx.on(window, 'play', reapply, true);
    ctx.on(window, 'loadeddata', reapply, true);
    ctx.hotkey('Alt+]', () => setRate(rate + 0.25, ctx));
    ctx.hotkey('Alt+[', () => setRate(rate - 0.25, ctx));
    ctx.hotkey('Alt+\\', () => setRate(1, ctx));
  },

  stop() {
    media().forEach((m) => { m.playbackRate = 1; });
  },

  panel(tab, ctx) {
    slider = tab.createSlider('Speed', (v) => setRate(v, ctx, true), { min: 0.25, max: 4, step: 0.05, value: rate, suffix: '×', save: false });
    slider.setTooltip('Alt+] faster · Alt+[ slower · Alt+\\ reset');
    const [a, b, c, d] = tab.createColumns(4);
    a.createButton('1×', () => setRate(1, ctx));
    b.createButton('1.5×', () => setRate(1.5, ctx));
    c.createButton('2×', () => setRate(2, ctx));
    d.createButton('3×', () => setRate(3, ctx));
    tab.createButton('Picture-in-picture', async () => {
      const v = biggestVideo();
      if (!v) return ctx.notify('No video on this page', 'warn');
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else { v.disablePictureInPicture = false; await v.requestPictureInPicture(); }
      } catch (e) { ctx.notify(e.message, 'error'); }
    }, { icon: ctx.Icons.monitor });
    tab.createToggle('Loop', (on) => media().forEach((m) => { m.loop = on; }), media().some((m) => m.loop), { save: false });
    tab.createStat('Media on page', String(media().length));
  },
};
