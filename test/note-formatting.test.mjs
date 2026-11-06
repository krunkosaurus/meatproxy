import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fixNoteFormatting, noteFromHtml } from '../public/note-formatting.js';
import { terminalTable, collapsedTerminalNote, restoredTerminalNote, pastedTerminalBullets, alignedTerminalBullets, pastedPageHtml, pastedPageText, pastedPageNote, copiedMarkdown, copiedMarkdownHtml, copiedMarkdownNote, record } from './note-formatting-fixture.mjs';

const pasted = ` The best clue is the timing: Washington drops happen only from about 6 AM to 7 PM Pacific, and almost never
  from 8 PM to 5 AM. Starlink congestion usually peaks in the evening, so this follows daytime activity
  instead.

  My suspects, in order:
  1. Starlink itself in the daytime: short outages or local congestion. Mark's Starlink app keeps an outage
     history. If it shows outages on Nov 4 between 8 and 10 AM PST, that settles it.
  2. Mark's router losing track of connections when the house is busy. It's worse if traffic passes through
     both the NETGEAR router and the Starlink router (Starlink not in bypass mode). Mark would know whether
     it's set up that way.`;
const expected = `The best clue is the timing: Washington drops happen only from about 6 AM to 7 PM Pacific, and almost never from 8 PM to 5 AM. Starlink congestion usually peaks in the evening, so this follows daytime activity instead.

My suspects, in order:
1. Starlink itself in the daytime: short outages or local congestion. Mark's Starlink app keeps an outage history. If it shows outages on Nov 4 between 8 and 10 AM PST, that settles it.
2. Mark's router losing track of connections when the house is busy. It's worse if traffic passes through both the NETGEAR router and the Starlink router (Starlink not in bypass mode). Mark would know whether it's set up that way.`;
test('unwraps the supplied Claude Code copy and keeps paragraphs and numbered items', () => {
  assert.equal(fixNoteFormatting(pasted), expected);
  assert.equal(fixNoteFormatting(expected), expected);
});

test('removes top-level list margins even when surrounding paragraphs have no indentation', () => {
  const intro = 'ok here is another example copied from Codex (last one was from Claude Code):\n\n';
  assert.equal(fixNoteFormatting(intro + pasted), intro + expected);
  const indentedItems = expected.replace(/^(?=\d+\.)/gm, '  ');
  assert.equal(fixNoteFormatting(intro + indentedItems), intro + expected);
});

test('preserves nested lists while unwrapping their continuation lines', () => {
  assert.equal(fixNoteFormatting('  - Parent item\n    continued\n    - Child item\n      continued\n  - Next item'), '- Parent item continued\n  - Child item continued\n- Next item');
  assert.equal(fixNoteFormatting('- Parent\n  - Child'), '- Parent\n  - Child');
  assert.equal(fixNoteFormatting('  10) Numbered item\n      continued\n  • Another item\n    continued'), '10) Numbered item continued\n• Another item continued');
  const hardBreak = '- First line  \n  second line\n- Next item';
  assert.equal(fixNoteFormatting(hardBreak), hardBreak);
  assert.equal(fixNoteFormatting('Intro\n  - Parent\n    continued\n    - Child\n      continued\n  - Next'), 'Intro\n- Parent continued\n  - Child continued\n- Next');
  assert.equal(fixNoteFormatting('Intro\n  - Parent\n\n    - Child\n\n  - Next\n\nOther intro\n - Item'), 'Intro\n- Parent\n\n  - Child\n\n- Next\n\nOther intro\n- Item');
});

test('left-aligns terminal bullet items after an unindented summary bullet', () => {
  assert.equal(fixNoteFormatting(pastedTerminalBullets), alignedTerminalBullets);
  assert.equal(fixNoteFormatting(alignedTerminalBullets), alignedTerminalBullets);
  assert.equal(fixNoteFormatting('  • Just one pasted item  '), '• Just one pasted item  ');
  assert.equal(fixNoteFormatting('• Summary\n\n  • First line\n    continued\n\n  • Next item'), '• Summary\n\n• First line continued\n\n• Next item');
  assert.equal(fixNoteFormatting('• Summary\n  • Item\n    - Markdown child\n      continuation'), '• Summary\n• Item\n  - Markdown child continuation');
});

test('terminal bullet alignment keeps fenced and indented code examples intact', () => {
  const code = '    • First literal\n    • Second literal';
  assert.equal(fixNoteFormatting(code), code);
  const fenced = '```text\n' + pastedTerminalBullets + '\n```';
  assert.equal(fixNoteFormatting(fenced), fenced);
});

test('keeps fenced code contents, including blank lines and shorter nested fences', () => {
  const code = '````markdown\n```js\nconst value = {\n  nested: true,\n};\n\n```\n````';
  assert.equal(fixNoteFormatting(`  Intro line\n  continued\n\n${code.split('\n').map(line => '  ' + line).join('\n')}\n\n  Last line\n  continued`), `Intro line continued\n\n${code}\n\nLast line continued`);
  assert.equal(fixNoteFormatting('~~~js\n  code\n~~~\nafter\nwrap'), '~~~js\n  code\n~~~\nafter wrap');
  assert.equal(fixNoteFormatting('```js\n  unfinished code\n  stays indented'), '```js\n  unfinished code\n  stays indented');
  assert.equal(fixNoteFormatting('Intro\n  - Item\n\n    ```js\n    const value = {\n      nested: true,\n    };\n    ```'), 'Intro\n- Item\n\n  ```js\n  const value = {\n    nested: true,\n  };\n  ```');
});

test('keeps indented code, headings, quotes and Markdown hard breaks', () => {
  const markdown = '# Heading\n\n    const value = {\n      nested: true,\n    };\n\n> Quoted line\n> Another line\n\nFirst line  \nSecond line\\\nThird line\n\n---\n\nTitle\n=====';
  assert.equal(fixNoteFormatting(markdown), markdown);
  assert.equal(fixNoteFormatting('\tcode\n\tmore code'), '\tcode\n\tmore code');
  assert.equal(fixNoteFormatting('- List item\n# Heading\n    code\n    more code'), '- List item\n# Heading\n    code\n    more code');
});

test('restores the reported collapsed table shape without changing its text or amounts', () => {
  assert.equal(fixNoteFormatting(collapsedTerminalNote), restoredTerminalNote);
  assert.equal(fixNoteFormatting(terminalTable.replaceAll('\n', ' ')), terminalTable);
  assert.equal(fixNoteFormatting(restoredTerminalNote), restoredTerminalNote);
});

test('keeps box-table rows apart from prose and restores adjacent rows without separator borders', () => {
  const table = '┌────┬─────┐\n│ A  │ B   │\n├────┼─────┤\n│ 1  │ 2   │\n│ 3  │ 4   │\n└────┴─────┘';
  assert.equal(fixNoteFormatting(table.replaceAll('\n', ' ')), table);
  assert.equal(fixNoteFormatting('Read these values:\n' + table + '\nAfter the table\ncontinued.'), 'Read these values:\n' + table + '\nAfter the table continued.');
  assert.equal(fixNoteFormatting('  ' + table.replaceAll('\n', '\n  ')), table);
  for (const margin of [' ', '  ', '   ']) {
    const cleaned = fixNoteFormatting(margin + table.replaceAll('\n', ' '));
    assert.equal(cleaned, table);
    assert.equal(fixNoteFormatting(cleaned), cleaned);
  }
  assert.equal(fixNoteFormatting('- Item\n┌──┐ │ cell │ └──┘\n    const a = 1;\n    const b = 2;'), '- Item\n┌──┐\n│ cell │\n└──┘\n    const a = 1;\n    const b = 2;');
});

test('leaves fenced, indented, inline and incomplete box-table examples alone', () => {
  const collapsed = terminalTable.replaceAll('\n', ' ');
  const fenced = '```text\n' + collapsed + '\n```';
  assert.equal(fixNoteFormatting(fenced), fenced);
  for (const indent of ['    ', '\t', ' \t', '  \t', '   \t']) assert.equal(fixNoteFormatting(indent + collapsed), indent + collapsed);
  assert.equal(fixNoteFormatting('Example: ' + collapsed), 'Example: ' + collapsed);
  for (const text of ['┌──┐ │ cell │', '┌──┐ prose └──┘', '┌──┐ ├──┤ └──┘']) assert.equal(fixNoteFormatting(text), text);
});

test('handles Windows newlines without changing inline text, Unicode or paragraph spacing', () => {
  assert.equal(fixNoteFormatting('  café **bold**\r\n  continued 🙂\r\n\r\n\r\n  next'), 'café **bold** continued 🙂\n\n\nnext');
  for (const text of ['', '  ', '\n \n', 'keep  inline   spacing', ' space at either end ']) assert.equal(fixNoteFormatting(text), text);
});

// Browsers parse a bare clipboard fragment into <body>; linkedom needs it explicit.
const body = html => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body;

test('rebuilds a copied chat answer from its HTML and repeats column names in each table row', () => {
  assert.equal(noteFromHtml(body(pastedPageHtml)), pastedPageNote);
  // Its plain-text alternative has no row or item boundaries that survive unwrapping.
  assert.match(fixNoteFormatting(pastedPageText), /Assessment Keep the current host\tLowest effort/);
});

test('leaves copied pages without lists or tables to the plain-text cleanup', () => {
  assert.equal(noteFromHtml(body('<p>One</p><p>Two <b>bold</b></p>')), null);
});

test('keeps headings, nested lists, list numbering, line breaks and code from copied pages', () => {
  const html = '<h2>Steps</h2><ol start="3"><li><p>Install&nbsp; it</p><ul><li>Run it<br>twice</li></ul></li><li>Check</li></ol>'
    + '<pre><div>bash</div><button>Copy code</button><code class="language-bash">if true; then\n  echo "a  b"\n\nfi\n</code></pre>'
    + '<script>alert(1)</script><style>p { color: red }</style><pre><code>```js\nquoted fence\n```</code></pre>';
  assert.equal(noteFromHtml(body(html)), '## Steps\n\n3. Install it\n   - Run it\n     twice\n4. Check\n\n```\nif true; then\n  echo "a  b"\n\nfi\n```\n\n````\n```js\nquoted fence\n```\n````');
});

test('labels table cells by column, including blank headers, one-row and nested tables', () => {
  assert.equal(noteFromHtml(body('<table><tr><th></th><th>Cost</th></tr><tr><td>August</td><td>$2,500.00</td></tr><tr><td>September</td><td></td></tr></table>')), 'August  \nCost: $2,500.00\n\nSeptember');
  assert.equal(noteFromHtml(body('<table><tr><td>Only</td><td>row</td></tr></table>')), 'Only  \nrow');
  assert.equal(noteFromHtml(body('<table><tr><th>Name</th><th>Detail</th></tr><tr><td>A</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr></table>')), 'Name: A  \nDetail: x y');
});

test('keeps a copy button\'s own Markdown and turns only its table into records', () => {
  assert.equal(noteFromHtml(body(copiedMarkdownHtml), copiedMarkdown), null);
  assert.equal(noteFromHtml(body(copiedMarkdownHtml), copiedMarkdown.replaceAll('\n', '\r\n')), null);
  assert.equal(fixNoteFormatting(copiedMarkdown), copiedMarkdownNote);
  // A browser selection's text has no Markdown for its rows and items, so the HTML is rebuilt.
  assert.equal(noteFromHtml(body(pastedPageHtml), pastedPageText), pastedPageNote);
  for (const partial of [copiedMarkdown.replace('- Whether', 'Whether'), copiedMarkdown.replace('|---|---|\n', '')]) {
    assert.notEqual(noteFromHtml(body(copiedMarkdownHtml), partial), null);
  }
  // Moving converted text within a note pastes it again.
  for (const note of [pastedPageNote, copiedMarkdownNote]) assert.equal(fixNoteFormatting(note), note);
});

test('turns Markdown tables into records without touching code, wrapped or malformed tables', () => {
  const table = '| Name | Cost |\n| :--- | ---: |\n| a \\| b | $1 |\n|  | $2 |';
  assert.equal(fixNoteFormatting(`Before\n\n${table}\n\nAfter`), `Before\n\n${record('Name: a | b', 'Cost: $1')}\n\nCost: $2\n\nAfter`);
  assert.equal(fixNoteFormatting(`- Item\n\n  ${table.replaceAll('\n', '\n  ')}`), `- Item\n\n  ${record('Name: a | b', 'Cost: $1').replace('\n', '\n  ')}\n\n  Cost: $2`);
  const wrapped = '| Name | Cost |\n|---|---|\n| a long cell that the terminal\nwrapped | $1 |';
  for (const kept of ['```\n' + table + '\n```', table.replace(/^/gm, '    '), wrapped, '| A | B |\n|---|\n| 1 | 2 |']) {
    assert.equal(fixNoteFormatting(kept), kept);
  }
});
