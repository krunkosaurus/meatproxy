const listMarker = /^[ \t]*(?:[-+*•]|\d+[.)])[ \t]+/;
const terminalBullet = /^ {0,3}•[ \t]+/;
const blockLine = /^(?:#{1,6}(?:\s|$)|>|\||.*\|\s*$|(?:[-*_]\s*){3,}$|[=-]+\s*$)/;
const boxLine = /^(?:[┌├└╭╰][─┬┼┴]+[┐┤┘╮╯]|│(?:.*│)?|(?:│[ \t]*)*[├└]─.*)$/;
// Claude Code draws a Markdown quote with this bar on every wrapped line.
const quoteBar = /^[ \t]*▎ ?/;
// Antigravity (agy) draws a light vertical rail down the left of a block.
const railBar = /^ {0,3}│(?: |$)/;
const railPrefix = /^ {0,3}│ ?/;
const hyphenWrap = /[\p{L}\p{N}]-$/u;
const suspendedHyphen = /^(?:and|or|nor|to)(?:\s|$)/i;
const proseWord = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;
const leadPunct = /^["'“”‘’(\[`*_~]+/;
const trailPunct = /["'“”‘’)\],.:;!?`*_~…\-—]/;
const cjkChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const wideChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/gu;
const codeStart = /^(?:\/\/|\/\*|\*\/|--\s|@@\s|<\/?[a-zA-Z][\w-]*(?:[\s/>]|$)|"""|''')/;
const diffLine = /^[-+][a-zA-Z_]/;
const bracketOnly = /^[{}()[\]]+$/;
const keyLine = /^(?:"[^"]+"|\.?[a-zA-Z_][\w.-]*):(?:\s|$)/;
const kvAssign = /^[a-zA-Z_][\w.-]*\s*=\s*/;
const declAssign = /^(?:export\s+)?(?:type|interface|const|let|var|val)\s+[A-Za-z_$][\w$]*\s*[=:{]|^from\s+[\w.]+\s+import\b/;
const logOrSha = /^(?:\[?(?:\d{4}-\d{2}-\d{2}[T ]?\d{2}:\d{2}(?:[:.]\d+)*Z?|\d{2}:\d{2}:\d{2}(?:\.\d+)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}(?::\d{2})?|(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL))\]?[\s:]|[0-9a-f]{7,40}\s+)/;
const funcCall = /\b[A-Za-z_]\w*!?\((?!(?:s|es|n)\))/;
const shellOp = /(?:^|\s)(?:&&|\|\||>>|>&\d)(?:\s|$)/;
const inlineAssign = /\b[A-Za-z_]\w*=[^\s]/;
const cliFlag = /(?:^|\s)--?[a-zA-Z][\w-]*(?:=|\s|$)/;
const upperKeyword = /^(?:SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|RUN|WORKDIR|COPY|ENV|CMD|ENTRYPOINT|EXPOSE|ARG)\b(?!:)/;
const cmdStart = /^(?:(?:npm|pnpm|yarn|npx|git|curl|wget|docker|kubectl|sudo|apt|apt-get|brew|pip|python3?|node|echo|printf|puts|abort|def|func|fn|println!|[a-z]+_[a-z]+)\b|\.{1,2}\/)/;
const stmtStart = /^(?:set|export|exit|return|raise|throw|import|class)\b/;
const shortCodeLine = /^(?:exit|return|break|continue|pass|raise|throw|yield|import|abort)\b/;
const commonProseStart = /^(?:the|we|you|it|this|that|in|on|for|if|when|also|and|but|or|so|to|a|an|our|your|they|there|here|all|each|one|two)$/i;
const indentation = line => line.match(/^ */)[0].length;
const hasHardBreak = line => line.endsWith('  ') || line.endsWith('\\');
const joinWrapped = (before, after) =>
  hyphenWrap.test(before) && /^[\p{L}\p{N}]/u.test(after) && !suspendedHyphen.test(after)
    ? before + after : `${before} ${after}`;

function stripEdgePunct(token) {
  const s = token.replace(leadPunct, '');
  let end = s.length;
  while (end > 0 && trailPunct.test(s[end - 1])) end--;
  return s.slice(0, end);
}

function proseStats(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let words = 0;
  for (const token of tokens) {
    if (proseWord.test(stripEdgePunct(token))) words++;
  }
  return { tokens: tokens.length, words, ratio: tokens.length ? words / tokens.length : 0 };
}

const displayWidth = line => line.length + (line.match(wideChar)?.length ?? 0);

function isCodeLike(line, atCodeBoundary, stats) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (codeStart.test(trimmed) || trimmed.endsWith('{') || trimmed.endsWith('}') || bracketOnly.test(trimmed)) return true;
  if (atCodeBoundary && diffLine.test(trimmed)) return true;
  if ((trimmed.startsWith('"') && trimmed.endsWith('",')) || (trimmed.startsWith("'") && trimmed.endsWith("',"))) return true;
  if (logOrSha.test(trimmed) || trimmed.split(/(?<![.!?]) {2,}/).length >= 3) return true;
  if (kvAssign.test(trimmed) || declAssign.test(trimmed) || upperKeyword.test(trimmed)) return true;
  if (atCodeBoundary && (cmdStart.test(trimmed) || stmtStart.test(trimmed))) return true;
  const plain = trimmed.replace(/`[^`]+`|https?:\/\/\S+/g, ' ');
  if (funcCall.test(plain) || shellOp.test(plain)) return true;
  if ((inlineAssign.test(plain) || cliFlag.test(plain)) && stats.ratio < 0.65) return true;
  if (trimmed.endsWith(';') && (stats.words < 5 || stats.ratio < 0.55)) return true;
  return false;
}

// Antigravity (agy) and other terminals render fenced ```text blocks four spaces
// in and hard-wrap long lines back to column four. Strip that four-space margin
// only when the pasted lines show terminal-wrapped prose rather than indented code.
function isWrappedFourSpaceProse(lines) {
  const firstIdx = lines.findIndex(line => line.trim());
  if (firstIdx === -1) return false;
  const dedent = line => line.slice(Math.min(4, indentation(line)));
  const firstWraps = firstIdx + 1 < lines.length && !!lines[firstIdx + 1].trim();

  // Estimate terminal wrap width from multi-token prose-region lines, ignoring
  // fenced code blocks, structural lines, and single-token overflow lines (e.g. URLs).
  let fence = null, maxLen = 0;
  for (let i = firstIdx; i < lines.length; i++) {
    const raw = lines[i], trimmed = raw.trim();
    if (fence) {
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null;
      continue;
    }
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    if (opening) { fence = opening[0]; continue; }
    if (!trimmed) continue;
    const d = dedent(raw).trimEnd(), dTrim = d.trim();
    if (i === firstIdx && indentation(raw) < 4 && (!firstWraps || dTrim.endsWith(':'))) continue;
    if (blockLine.test(dTrim) || boxLine.test(dTrim) || railBar.test(d) || quoteBar.test(d)) continue;
    const cjkCount = dTrim.match(cjkChar)?.length ?? 0;
    if (!/\s/.test(dTrim) && cjkCount < 10) continue;
    maxLen = Math.max(maxLen, displayWidth(d));
  }
  if (maxLen < 42) return false;

  fence = null;
  let wrapPairs = 0, codeLines = 0, unwrappedPairs = 0, inList = false, prevWasCode = false;
  for (let i = firstIdx; i < lines.length; i++) {
    const raw = lines[i], trimmed = raw.trim();
    if (fence) {
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null;
      continue;
    }
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    if (opening) { fence = opening[0]; inList = false; prevWasCode = false; continue; }
    if (!trimmed) { inList = false; prevWasCode = false; continue; }

    const indentA = indentation(raw);
    const a = dedent(raw).trimEnd(), aTrim = a.trim();
    const aBody = a.replace(listMarker, '');
    const aStats = proseStats(aBody);
    const atCodeBoundary = i === firstIdx || !lines[i - 1].trim() || prevWasCode;
    const aCode = isCodeLike(a, atCodeBoundary, aStats);
    prevWasCode = aCode;
    if (indentA <= 4 && aCode) codeLines++;
    const markerA = raw.match(listMarker);
    if (markerA && !aCode) inList = true;

    if (i + 1 >= lines.length || !lines[i + 1].trim()) continue;
    const rawB = lines[i + 1];
    const indentB = indentation(rawB);
    const b = dedent(rawB).trimEnd(), bTrim = b.trim();
    if (blockLine.test(aTrim) || boxLine.test(aTrim) || railBar.test(a) || quoteBar.test(a)
      || blockLine.test(bTrim) || boxLine.test(bTrim) || railBar.test(b) || quoteBar.test(b)
      || /^(`{3,}|~{3,})/.test(bTrim)) continue;
    if (listMarker.test(b) || hasHardBreak(raw)) continue;
    if (keyLine.test(aTrim) && keyLine.test(bTrim)) { if (indentA <= 4) codeLines++; continue; }

    const firstA = aTrim.split(/\s+/)[0], firstB = bTrim.split(/\s+/)[0];
    if (firstA === firstB && /^[A-Za-z_][\w.-]*$/.test(firstA) && !commonProseStart.test(firstA)) {
      if (indentA <= 4) codeLines++;
      continue;
    }

    const bStats = proseStats(b);
    const bCode = isCodeLike(b, aCode, bStats);
    if (aCode || bCode) continue;
    if (i === firstIdx && indentA < 4 && aTrim.endsWith(':')) continue;

    const sameWrapIndent = (indentA === 4 && indentB === 4)
      || (i === firstIdx && indentA < 4 && indentB === 4)
      || (markerA && (indentB === indentA || (indentB > indentA && indentB <= markerA[0].length)))
      || (inList && indentA > 4 && indentA <= 8 && indentB === indentA);
    if (!sameWrapIndent) continue;

    const aWidth = displayWidth(a);
    const aCjk = aTrim.match(cjkChar)?.length ?? 0;
    const isCjk = aCjk >= 10 && aCjk / aTrim.replace(/\s+/g, '').length >= 0.3;
    const wouldFit = aWidth + (isCjk ? 0 : 1) + (isCjk ? 2 : displayWidth(firstB));
    const partialMidFirst = i === firstIdx && indentA === 0 && !/[:.!?]$/.test(aTrim) && aWidth >= 20 && displayWidth(b) >= 45;
    if (!partialMidFirst && (aWidth < 36 || wouldFit < maxLen - 2 || wouldFit < 44)) {
      if (indentA <= 4 && aWidth >= 25 && aStats.tokens >= 4 && wouldFit < maxLen - 12 && !/[:,.!?]$/.test(aTrim)) unwrappedPairs++;
      continue;
    }

    if (isCjk) { wrapPairs++; continue; }
    const pairTokens = aStats.tokens + bStats.tokens;
    const pairRatio = pairTokens ? (aStats.words + bStats.words) / pairTokens : 0;
    const bOk = !(shortCodeLine.test(bTrim) && !/[.!?]$/.test(bTrim)) && (bStats.tokens <= 2
      ? (bStats.words >= 1 || /[.)?!]$/.test(bTrim))
      : (bStats.words >= 1 && (bStats.ratio >= 0.3 || pairRatio >= 0.5)));
    if (aStats.words >= 4 && aStats.ratio >= 0.35 && pairRatio >= 0.42 && bOk) {
      wrapPairs++;
    }
  }
  return wrapPairs > 0 && wrapPairs > codeLines && wrapPairs > unwrappedPairs;
}

// Strip Antigravity's left │ rail while leaving box tables, directory trees and
// fenced or indented code alone. A wrapped word that spills past the rail onto
// the next line without its own │ is joined back onto the line above it.
function stripRails(lines) {
  const out = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], trimmed = line.trim();
    if (fence) {
      out.push(line);
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null;
      continue;
    }
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    if (opening) {
      fence = opening[0]; out.push(line);
      continue;
    }
    if (!railBar.test(line)) { out.push(line); continue; }
    const railIndent = indentation(line);
    const isRail = row => railBar.test(row) && indentation(row) === railIndent;
    let end = index, hasProse = false;
    const items = [];
    while (end < lines.length) {
      if (isRail(lines[end])) {
        const row = lines[end], text = row.replace(railPrefix, '');
        if (text.trim() && !boxLine.test(row.trim())) hasProse = true;
        items.push({ kind: 'rail', text });
        end++;
        continue;
      }
      const prev = items[items.length - 1];
      if (!prev || prev.kind !== 'rail' || !prev.text.trim()) break;
      let look = end;
      while (look < lines.length && lines[look].trim() && indentation(lines[look]) <= railIndent
        && !isRail(lines[look]) && !/^(?:[┌├└]|`{3,}|~{3,})/.test(lines[look].trim())) look++;
      if (look === end || look >= lines.length || !isRail(lines[look])) break;
      for (let k = end; k < look; k++) items.push({ kind: 'overflow', text: lines[k].trim() });
      end = look;
    }
    if (!hasProse) {
      for (let k = index; k < end; k++) out.push(lines[k]);
      index = end - 1;
      continue;
    }
    const stripped = [];
    for (const item of items) {
      if (item.kind === 'overflow') stripped[stripped.length - 1] = joinWrapped(stripped[stripped.length - 1].trimEnd(), item.text);
      else stripped.push(item.text.trim() ? item.text : '');
    }
    if (index === 0 || !lines[index - 1].trim()) while (stripped.length && !stripped[0]) stripped.shift();
    if (end === lines.length || !lines[end].trim()) while (stripped.length && !stripped[stripped.length - 1]) stripped.pop();
    out.push(...stripped);
    index = end - 1;
  }
  return out;
}

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
    if (!table) {
      const stripped = railBar.test(text) && !boxLine.test(text.trim()) ? text.replace(railPrefix, '') : '';
      const line = stripped.trim() ? stripped : text;
      return terminalBullet.test(line) ? line.trimStart() : line;
    }
    text = table.join('\n');
  }
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content = lines.filter(line => line.trim());
  if (!content.length) return text;

  // Terminal selections can start partway through the first line's left margin.
  const first = content[0].trimStart();
  const firstIdx = lines.findIndex(line => line.trim());
  const nextLine = firstIdx + 1 < lines.length ? lines[firstIdx + 1] : '';
  const firstMarker = content[0].match(listMarker);
  const listStartsWrappedFour = !!firstMarker && firstMarker[0].length < 4
    && !!nextLine.trim() && !listMarker.test(nextLine) && indentation(nextLine) === 4 && !nextLine.trimEnd().endsWith(':')
    && content.slice(1).every(line => indentation(line) >= 4);
  const marginLines = content.length > 1 && (!firstMarker || listStartsWrappedFour)
    && !blockLine.test(first) && !/^(`{3,}|~{3,})/.test(first)
    ? content.slice(1) : content;
  const margin = marginLines.reduce((min, line) => Math.min(min, indentation(line)), Infinity);
  // Four spaces or more may be an intentional Markdown code block. Five is the
  // margin Hermes draws around an answer; four is also how terminals like agy
  // indent rendered ```text blocks, so strip four when it wraps prose.
  if (margin > 0 && (margin < 4 || margin === 5 || (margin === 4 && isWrappedFourSpaceProse(lines)))) {
    lines = lines.map(line => line.slice(Math.min(margin, indentation(line))));
  }
  lines = stripRails(lines);

  const result = [];
  let fence = null, listIndent = 0, listMargin = null, join = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], trimmed = line.trim();
    const indent = indentation(line);
    const tabCode = /^\t/.test(line);
    const rawMarker = line.match(listMarker);
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    const table = restoreBoxTable(line);
    const block = blockLine.test(trimmed) || boxLine.test(trimmed) || !!table;
    // A list has its own terminal margin, even beside unindented paragraphs.
    // Keep that margin across blank lines so loose nested lists stay nested.
    if (!fence && trimmed && listMargin !== null && (!rawMarker || tabCode) && indent < listIndent && (!join || opening || block || tabCode)) {
      listMargin = null; listIndent = 0;
    }
    const code = !fence && !!trimmed && (tabCode || indent >= listIndent + 4);
    const marker = code ? null : rawMarker;
    if (!fence && marker) {
      // Terminal • items can each have a copy margin after an unindented lead.
      if (terminalBullet.test(line)) listMargin = indent;
      else listMargin = listMargin === null ? indent : Math.min(listMargin, indent);
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
    const hardBreak = hasHardBreak(line);
    const value = hardBreak ? line.trimStart() : trimmed;
    if (marker) {
      result.push(hardBreak ? formatted : formatted.trimEnd()); listIndent = marker[0].length;
    } else if (join) result[result.length - 1] = joinWrapped(result[result.length - 1], value);
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
