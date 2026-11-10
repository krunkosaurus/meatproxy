const listMarker = /^[ \t]*(?:[-+*•]|\d+[.)])[ \t]+/;
const terminalBullet = /^ {0,3}•[ \t]+/;
const blockLine = /^(?:#{1,6}(?:\s|$)|>|\||.*\|\s*$|(?:[-*_]\s*){3,}$|[=-]+\s*$)/;
const boxLine = /^(?:[┌├└][─┬┼┴]+[┐┤┘]|│.*│)$/;
// Claude Code draws a Markdown quote with this bar on every wrapped line.
const quoteBar = /^[ \t]*▎ ?/;
const indentation = line => line.match(/^ */)[0].length;

// Some terminal clipboards replace a table's row breaks with spaces. Its top
// border supplies the cell count, including rows with no separator between them.
function restoreBoxTable(text) {
  const top = text.match(/^([ \t]*)┌(─+(?:┬─+)*)┐/);
  if (!top) return null;
  const columns = top[2].split('┬').length, rows = [top[0]];
  let offset = top[0].length, hasCells = false;
  while (offset < text.length) {
    const rest = text.slice(offset).trimStart();
    if (rest.startsWith('│')) {
      let end = 0;
      for (let column = 0; column < columns; column++) {
        end = rest.indexOf('│', end + 1);
        if (end === -1) return null;
      }
      rows.push(top[1] + rest.slice(0, end + 1));
      offset = text.length - rest.length + end + 1; hasCells = true;
    } else {
      const border = rest.match(/^(?:├─+(?:┼─+)*┤|└─+(?:┴─+)*┘)/);
      if (!border || border[0].split(/[┼┴]/).length !== columns) return null;
      rows.push(top[1] + border[0]);
      offset = text.length - rest.length + border[0].length;
      if (border[0].startsWith('└')) return hasCells && !text.slice(offset).trim() ? rows : null;
    }
  }
  return null;
}

// Unwrap terminal-copied prose without flattening Markdown paragraphs or lists.
export function fixNoteFormatting(text) {
  if (!/[\r\n]/.test(text)) {
    if (/^(?: {4}| *\t)/.test(text)) return text;
    const table = restoreBoxTable(text);
    if (!table) return terminalBullet.test(text) ? text.trimStart() : text;
    text = table.join('\n');
  }
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content = lines.filter(line => line.trim());
  if (!content.length) return text;

  // Terminal selections can start partway through the first line's left margin.
  const first = content[0].trimStart();
  const marginLines = content.length > 1 && !listMarker.test(first) && !blockLine.test(first) && !/^(`{3,}|~{3,})/.test(first)
    ? content.slice(1) : content;
  const margin = marginLines.reduce((min, line) => Math.min(min, indentation(line)), Infinity);
  // Four spaces may be an intentional Markdown code block.
  if (margin > 0 && margin < 4) lines = lines.map(line => line.slice(Math.min(margin, indentation(line))));

  const result = [];
  let fence = null, listIndent = 0, listMargin = null, join = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], trimmed = line.trim();
    const indent = indentation(line);
    const marker = line.match(listMarker);
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    const table = restoreBoxTable(line);
    const block = blockLine.test(trimmed) || boxLine.test(trimmed) || !!table;
    // A list has its own terminal margin, even beside unindented paragraphs.
    // Keep that margin across blank lines so loose nested lists stay nested.
    if (!fence && trimmed && listMargin !== null && !marker && indent < listIndent && (!join || opening || block)) {
      listMargin = null; listIndent = 0;
    }
    if (!fence && marker) {
      // Terminal • items can each have a copy margin after an unindented lead.
      if (terminalBullet.test(line)) listMargin = indent;
      else listMargin = listMargin === null ? (indent < 4 ? indent : 0) : Math.min(listMargin, indent);
    }
    const formatted = listMargin === null ? line : line.slice(Math.min(listMargin, indent));
    if (fence) {
      result.push(formatted);
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null;
      continue;
    }
    if (opening) {
      fence = opening[0]; result.push(formatted); join = false;
      continue;
    }
    if (!trimmed) {
      result.push(''); join = false;
      continue;
    }
    const code = !marker && (/^\t/.test(line) || indent >= listIndent + 4);
    if (!code && quoteBar.test(line)) {
      let end = index;
      while (end < lines.length && quoteBar.test(lines[end])) end++;
      const margin = formatted.match(/^\s*/)[0];
      const quote = fixNoteFormatting(lines.slice(index, end).map(row => row.replace(quoteBar, '')).join('\n'));
      result.push(...quote.split('\n').map(row => margin + (row ? `> ${row}` : '>')));
      index = end - 1; join = false;
      continue;
    }
    if (table && !code) {
      result.push(...table.map(row => listMargin === null ? row : row.slice(Math.min(listMargin, indent)))); join = false;
      continue;
    }
    const pipes = code ? null : pipeTable(lines, index);
    if (pipes) {
      const margin = formatted.match(/^\s*/)[0];
      records(pipes.rows).forEach((record, number) => result.push(...(number ? [''] : []), ...record.split('\n').map(row => margin + row)));
      index += pipes.length - 1; join = false;
      continue;
    }
    if (block || code) {
      result.push(formatted); join = false;
      continue;
    }
    const hardBreak = / {2,}$|\\$/.test(line);
    const value = hardBreak ? line.trimStart() : trimmed;
    if (marker) {
      result.push(hardBreak ? formatted : formatted.trimEnd()); listIndent = marker[0].length;
    } else if (join) result[result.length - 1] += ` ${value}`;
    else result.push(listMargin !== null ? (hardBreak ? formatted : formatted.trimEnd()) : value);
    join = !hardBreak;
  }
  return result.join('\n');
}

const pipeRow = /^\|.*\|$/;
const delimiterRow = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/;
const cellsOf = row => row.slice(1, -1).replace(/\\\|/g, '\0').split('|').map(cell => cell.replaceAll('\0', '|').trim());

// A Markdown table, as a chat app's copy button writes it. A row a terminal
// wrapped no longer begins and ends with a pipe, so that table is left as it is.
function pipeTable(lines, start) {
  const header = lines[start].trim(), delimiter = lines[start + 1]?.trim() ?? '';
  if (!pipeRow.test(header) || !delimiterRow.test(delimiter) || cellsOf(header).length !== cellsOf(delimiter).length) return null;
  let end = start + 2;
  while (end < lines.length && lines[end].includes('|')) end++;
  const rows = lines.slice(start, end).map(line => line.trim());
  if (!rows.every(row => pipeRow.test(row))) return null;
  return { length: end - start, rows: [header, ...rows.slice(2)].map(cellsOf) };
}

// Wide cells wrap unreadably in a text table, so each row repeats its column names.
// Hard breaks keep a row's lines apart when Markdown renders or a paste unwraps them.
function records([header = [], ...body]) {
  const labels = body.length ? header : [];
  return (body.length ? body : [header])
    .map(cells => cells.map((cell, index) => cell && (labels[index] ? `${labels[index]}: ${cell}` : cell)).filter(Boolean).join('  \n'))
    .filter(Boolean);
}

const skippedTags = new Set(['button', 'script', 'style']);
const blockTags = new Set(['article', 'aside', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'header', 'li', 'main', 'nav', 'p', 'section', 'summary']);

// Browsers copy a page's list items and table cells onto bare adjacent lines in
// text/plain, which unwrapping would join. Their HTML still has the structure.
export function noteFromHtml(root, text = '') {
  const tables = root.querySelectorAll('table').length, items = root.querySelectorAll('li').length;
  if (!tables && !items) return null;
  // A copy button's text/plain is the answer's own Markdown, with the emphasis,
  // code and links this rebuild drops. Keep it when it has every table and item.
  const lines = text.split('\n').map(line => line.trim());
  if (lines.filter(line => delimiterRow.test(line)).length >= tables && lines.filter(line => listMarker.test(line)).length >= items) return null;
  return blocksOf(root.childNodes).join('\n\n');
}

function blocksOf(nodes) {
  const blocks = [];
  let lines = [''];
  const flush = () => {
    const text = lines.map(line => line.replace(/[ \t\n\r\f\u00a0]+/g, ' ').trim()).join('\n').trim();
    if (text) blocks.push(text);
    lines = [''];
  };
  const visit = node => {
    if (node.nodeType === 3) lines[lines.length - 1] += node.data;
    if (node.nodeType !== 1 || skippedTags.has(node.localName)) return;
    if (node.localName === 'br') {
      // Marks where the copied selection began or ended, not a line break.
      if (!/\bApple-interchange-newline\b/.test(node.getAttribute('class'))) lines.push('');
      return;
    }
    const converted = convertBlock(node);
    if (!converted) { for (const child of node.childNodes) visit(child); return; }
    flush(); blocks.push(...converted);
  };
  for (const node of nodes) visit(node);
  flush();
  return blocks;
}

const flatten = node => blocksOf(node.childNodes).join(' ').replace(/\s*\n\s*/g, ' ');

function convertBlock(node) {
  const tag = node.localName, heading = tag.match(/^h([1-6])$/);
  if (heading) { const text = flatten(node); return text ? [`${'#'.repeat(Number(heading[1]))} ${text}`] : []; }
  if (tag === 'ul' || tag === 'ol') return listBlocks(node, tag === 'ol');
  if (tag === 'table') return records(tableRows(node));
  if (tag === 'blockquote') {
    const text = blocksOf(node.childNodes).join('\n\n');
    return text ? [text.split('\n').map(line => line ? `> ${line}` : '>').join('\n')] : [];
  }
  if (tag === 'pre') {
    // Chat apps put a language label and copy button beside the code element.
    const code = (node.querySelector('code') ?? node).textContent.replace(/\n$/, '');
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`{3,}/g) ?? []).map(run => run.length + 1)));
    return code.trim() ? [`${fence}\n${code}\n${fence}`] : [];
  }
  return blockTags.has(tag) ? blocksOf(node.childNodes) : null;
}

function listBlocks(list, ordered) {
  let number = Number.parseInt(list.getAttribute('start'), 10);
  if (Number.isNaN(number)) number = 1;
  const items = [];
  for (const child of list.children) {
    const item = child.localName === 'li';
    const marker = !item ? '' : ordered ? `${number++}. ` : '- ';
    const text = blocksOf(item ? child.childNodes : [child]).join('\n');
    if (text) items.push(marker + text.replace(/\n(?=[^\n])/g, `\n${' '.repeat(marker.length)}`));
  }
  return items.length ? [items.join('\n')] : [];
}

const tableRows = table => [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table)
  .map(row => [...row.children].filter(cell => cell.localName === 'td' || cell.localName === 'th').map(flatten));
