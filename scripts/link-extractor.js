// Every link on the page in one filterable list. Copy as text / Markdown, or save as CSV.
let filter = '';
let externalOnly = false;

function links() {
  const seen = new Map();
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    if (!/^https?:/.test(href)) return;
    const text = (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    if (!seen.has(href) || (!seen.get(href).text && text)) seen.set(href, { href, text });
  });
  let list = [...seen.values()];
  if (externalOnly) list = list.filter((l) => new URL(l.href).hostname !== location.hostname);
  if (filter) { const q = filter.toLowerCase(); list = list.filter((l) => (l.href + ' ' + l.text).toLowerCase().includes(q)); }
  return list;
}

const csvCell = (s) => '"' + String(s).replace(/"/g, '""') + '"';

module.exports = {
  panel(tab, ctx) {
    const stat = tab.createStat('Links', '…');
    const table = tab.createTable(['Text', 'URL'], [], { height: 170, onRowClick: (row, i) => { const x = links()[i]; if (x) window.open(x.href, '_blank', 'noopener'); } });
    const refresh = () => {
      const l = links();
      stat.setValue(String(l.length));
      table.setRows(l.slice(0, 400).map((x) => [x.text || '—', x.href.replace(/^https?:\/\//, '')]));
      return l;
    };
    tab.createTextInput('Filter', (v) => { filter = v; refresh(); }, { placeholder: 'text or URL contains…', save: false });
    tab.createToggle('Other sites only', (v) => { externalOnly = v; refresh(); }, false, { save: false });
    const [a, b, c] = tab.createColumns(3);
    a.createButton('Copy URLs', async () => { const l = refresh(); await ctx.copy(l.map((x) => x.href).join('\n')); ctx.notify(`Copied ${l.length}`, 'success'); }, { icon: ctx.Icons.copy });
    b.createButton('Copy Markdown', async () => { const l = refresh(); await ctx.copy(l.map((x) => `- [${(x.text || x.href).replace(/[[\]]/g, '')}](${x.href})`).join('\n')); ctx.notify(`Copied ${l.length}`, 'success'); }, { icon: ctx.Icons.list });
    c.createButton('Save CSV', () => {
      const l = refresh();
      ctx.download('text,url\n' + l.map((x) => csvCell(x.text) + ',' + csvCell(x.href)).join('\n'), `${location.hostname}-links.csv`, 'text/csv');
    }, { icon: ctx.Icons.download });
    refresh();
  },
};
