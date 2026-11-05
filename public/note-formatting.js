const listMarker = /^[ \t]*(?:[-+*•]|\d+[.)])[ \t]+/;
const blockLine = /^(?:#{1,6}(?:\s|$)|>|\||.*\|\s*$|(?:[-*_]\s*){3,}$|[=-]+\s*$)/;
const boxLine = /^(?:[┌├└][─┬┼┴]+[┐┤┘]|│.*│)$/;
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
    if (!table) return text;
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
  for (const line of lines) {
    const trimmed = line.trim();
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
      listMargin = listMargin === null ? (indent < 4 ? indent : 0) : Math.min(listMargin, indent);
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
    if (table && !code) {
      result.push(...table.map(row => listMargin === null ? row : row.slice(Math.min(listMargin, indent)))); join = false;
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
