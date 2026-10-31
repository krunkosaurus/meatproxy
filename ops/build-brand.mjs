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
const renderOptions = {
  font: {
    loadSystemFonts: false,
    fontFiles: ['Regular', 'Bold'].map(weight => fileURLToPath(new URL(`../brand/fonts/AtkinsonHyperlegible-${weight}.ttf`, import.meta.url))),
  },
};
await writeFile(new URL('../public/og.png', import.meta.url), new Resvg(template.replaceAll('{{mark}}', mark), renderOptions).render().asPng());
const handoff = await readFile(new URL('../brand/handoff.svg', import.meta.url), 'utf8');
for (const [state, label, first, second, instruction] of [
  ['online', 'Sender online when previewed', 'Someone has', 'files for you.', 'Open the link. Accept the transfer.'],
  ['busy', 'Sender busy when previewed', 'Someone has', 'files for you.', 'Open the link to check availability.'],
  ['offline', 'Sender offline', 'This file link', 'has expired.', 'Ask the sender for a fresh link.'],
]) {
  const svg = handoff.replaceAll('{{mark}}', mark).replace('{{label}}', label).replace('{{first}}', first).replace('{{second}}', second).replace('{{instruction}}', instruction).replaceAll('{{statusColor}}', state === 'online' ? '#476541' : '#62675b');
  await writeFile(new URL(`../public/og-${state}.png`, import.meta.url), new Resvg(svg, renderOptions).render().asPng());
}
