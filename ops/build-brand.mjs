import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const logo = await readFile(new URL('../public/logo.svg', import.meta.url), 'utf8');
const mark = logo.slice(logo.indexOf('>') + 1, logo.lastIndexOf('</svg>'));
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f7f5ee"/>${mark}</svg>\n`;
await writeFile(new URL('../public/favicon.svg', import.meta.url), icon);
for (const [name, width] of [['favicon.png', 32], ['apple-touch-icon.png', 180]]) {
  const png = new Resvg(icon, { background: '#f7f5ee', fitTo: { mode: 'width', value: width } }).render().asPng();
  await writeFile(new URL(`../public/${name}`, import.meta.url), png);
}

const template = await readFile(new URL('../brand/social.svg', import.meta.url), 'utf8');
const card = new Resvg(template.replaceAll('{{mark}}', mark), {
  font: {
    loadSystemFonts: false,
    fontFiles: ['Regular', 'Bold'].map(weight => fileURLToPath(new URL(`../brand/fonts/AtkinsonHyperlegible-${weight}.ttf`, import.meta.url))),
  },
});
await writeFile(new URL('../public/og.png', import.meta.url), card.render().asPng());
