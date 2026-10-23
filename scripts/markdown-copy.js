// Copy the selection or the page's main article as clean Markdown (Turndown + Readability).
let Turndown, Readability, td;

function selectionMarkdown() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return '';
  const box = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
  return td.turndown(box);
}

function articleMarkdown() {
  const a = new Readability(document.cloneNode(true)).parse();
  if (!a) return '';
  const box = document.createElement('div');
  box.appendChild(new DOMParser().parseFromString(a.content, 'text/html').body);
  return `# ${a.title || document.title}\n\n<${location.href}>\n\n${td.turndown(box)}`;
}

async function copy(ctx, md, what) {
  if (!md) return ctx.notify(`Nothing to copy (${what})`, 'warn');
  await ctx.copy(md);
  ctx.notify(`Copied ${what} as Markdown (${md.length.toLocaleString()} chars)`, 'success');
}

module.exports = {
  async start(ctx) {
    Turndown = await ctx.require('turndown');
    Readability = await ctx.require('readability');
    td = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    td.remove(['script', 'style', 'noscript']);
    ctx.hotkey('Alt+Shift+M', () => {
      const s = selectionMarkdown();
      return s ? copy(ctx, s, 'selection') : copy(ctx, articleMarkdown(), 'article');
    });
  },

  panel(tab, ctx) {
    tab.createMultiLineLabel('Alt+Shift+M copies the selection, or the whole article when nothing is selected.');
    tab.createButton('Copy selection', () => copy(ctx, selectionMarkdown(), 'selection'), { icon: ctx.Icons.copy });
    tab.createButton('Copy article', () => copy(ctx, articleMarkdown(), 'article'), { icon: ctx.Icons.copy });
    tab.createButton('Download article (.md)', () => {
      const md = articleMarkdown();
      if (!md) return ctx.notify('No article found', 'warn');
      const name = (document.title || location.hostname).replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'page';
      ctx.download(md, name + '.md', 'text/markdown');
    }, { icon: ctx.Icons.download });
  },
};
