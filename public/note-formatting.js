const listMarker = /^[ \t]*(?:[-+*•]|\d+[.)])[ \t]+/;
const blockLine = /^(?:#{1,6}(?:\s|$)|>|\||.*\|\s*$|(?:[-*_]\s*){3,}$|[=-]+\s*$)/;
const indentation = line => line.match(/^ */)[0].length;

// Unwrap terminal-copied prose without flattening Markdown paragraphs or lists.
export function fixNoteFormatting(text) {
  if (!/[\r\n]/.test(text)) return text;
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
  let fence = null, listIndent = 0, join = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence) {
      result.push(line);
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null;
      continue;
    }
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    if (opening) {
      fence = opening[0]; result.push(line); join = false;
      continue;
    }
    if (!trimmed) {
      result.push(''); join = false; listIndent = 0;
      continue;
    }
    const marker = line.match(listMarker);
    const block = blockLine.test(trimmed);
    if (block || (!marker && (/^\t/.test(line) || indentation(line) >= listIndent + 4))) {
      result.push(line); join = false;
      if (block) listIndent = 0;
      continue;
    }
    const hardBreak = / {2,}$|\\$/.test(line);
    const value = hardBreak ? line.trimStart() : trimmed;
    if (marker) {
      result.push(hardBreak ? line : line.trimEnd()); listIndent = marker[0].length;
    } else if (join) result[result.length - 1] += ` ${value}`;
    else result.push(listIndent ? (hardBreak ? line : line.trimEnd()) : value);
    join = !hardBreak;
  }
  return result.join('\n');
}
