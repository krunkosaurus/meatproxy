// Synthetic values retain the reported clipboard layout without storing account data.
export const terminalTable = [
  '┌───────────────────────────────────────────┬────────────┬────────────────────┬───────────────┐',
  '│                                           │ We booked  │ ExampleAPI charged │ Overstated by │',
  '├───────────────────────────────────────────┼────────────┼────────────────────┼───────────────┤',
  '│ August (all 1,234 jobs)                   │  $2,500.00 │          $1,250.00 │     $1,250.00 │',
  '├───────────────────────────────────────────┼────────────┼────────────────────┼───────────────┤',
  '│ September (the 56,789 jobs in the export) │ $25,000.00 │         $22,500.00 │     $2,500.00 │',
  '└───────────────────────────────────────────┴────────────┴────────────────────┴───────────────┘',
].join('\n');

const introduction = `Our records say we paid ExampleAPI about $3,750 more for August and September than it actually charged. These sample figures illustrate the recorded costs and the provider's actual charges.

What was wrong

Our system calculated each job's cost itself instead of recording ExampleAPI's actual charge. Those figures were compared against the provider's own task export:

`;
export const collapsedTerminalNote = introduction + terminalTable.replaceAll('\n', ' ');
export const restoredTerminalNote = introduction + terminalTable;

export const pastedTerminalBullets = `• The overall results look reassuring.

  • CPU: No recent processor errors were found.

  • RAM: The memory diagnostic passed.

  • SSD: The storage reports healthy.

  • Graphics: One cooling problem needs attention.`;

export const alignedTerminalBullets = `• The overall results look reassuring.

• CPU: No recent processor errors were found.

• RAM: The memory diagnostic passed.

• SSD: The storage reports healthy.

• Graphics: One cooling problem needs attention.`;

// A chat answer copied from a browser, with the reported markup and its
// text/plain alternative: tab-separated cells and bare list lines.
export const pastedPageHtml = `<meta charset='utf-8'><p class="Paragraph" dir="auto" style="margin: 0px 0px 4px; font-weight: 400;"><strong class="font-semibold"><span><br class="Apple-interchange-newline">Summary:</span></strong><span> the upload failures came from a full disk, not the network.</span></p>`
  + `<p dir="auto"><span>Here is how the options compare:</span></p>`
  + `<div class="TableWrapper"><div><div><table dir="auto"><thead><tr><th data-col-size="md"><span>Option</span></th><th data-col-size="xl"><span>Assessment</span></th></tr></thead>`
  + `<tbody><tr><td><span>Keep the current host</span></td><td><span>Lowest effort, but the disk fills again within a month.</span></td></tr>`
  + `<tr><td><span>Move uploads to object storage</span></td><td><span>About $40 a month, and it removes the disk limit.</span></td></tr></tbody></table></div></div>`
  + `<div data-block-actions="true" data-markdown-copy="exclude"><button type="button" aria-label="Copy table"><span aria-hidden="true"></span></button><button type="button" aria-label="Expand table"><span aria-hidden="true"></span></button></div></div>`
  + `<p dir="auto"><strong><span>The deciding question.</span></strong></p><p dir="auto"><span>Which costs more: an outage or the storage bill?</span></p>`
  + `<blockquote><p dir="auto"><span>“We can’t lose another weekend of uploads.”</span></p></blockquote>`
  + `<p dir="auto"><span>The review raised three questions:</span></p><ul dir="auto"><li><span>What happens when a transfer is interrupted.</span></li>`
  + `<li><span>Whether old files are deleted automatically.</span></li><li><span>Who receives the alert when the disk is nearly full.</span></li></ul>`
  + `<p dir="auto"><span>The plan:</span></p><ol dir="auto" start="1"><li><strong><span>Move the uploads first.</span></strong><span> Then remove the old disk.</span></li>`
  + `<li><strong><span>Set an alert</span></strong><span> at 80% full.</span></li></ol>`;

export const pastedPageText = `
Summary: the upload failures came from a full disk, not the network.

Here is how the options compare:

Option\tAssessment
Keep the current host\tLowest effort, but the disk fills again within a month.
Move uploads to object storage\tAbout $40 a month, and it removes the disk limit.
The deciding question.

Which costs more: an outage or the storage bill?

“We can’t lose another weekend of uploads.”

The review raised three questions:

What happens when a transfer is interrupted.
Whether old files are deleted automatically.
Who receives the alert when the disk is nearly full.
The plan:

Move the uploads first. Then remove the old disk.
Set an alert at 80% full.`;

// Each table row becomes one record, its lines joined by Markdown hard breaks.
export const record = (...lines) => lines.join('  \n');
const optionRecords = `${record('Option: Keep the current host', 'Assessment: Lowest effort, but the disk fills again within a month.')}

${record('Option: Move uploads to object storage', 'Assessment: About $40 a month, and it removes the disk limit.')}`;

export const pastedPageNote = `Summary: the upload failures came from a full disk, not the network.

Here is how the options compare:

${optionRecords}

The deciding question.

Which costs more: an outage or the storage bill?

> “We can’t lose another weekend of uploads.”

The review raised three questions:

- What happens when a transfer is interrupted.
- Whether old files are deleted automatically.
- Who receives the alert when the disk is nearly full.

The plan:

1. Move the uploads first. Then remove the old disk.
2. Set an alert at 80% full.`;

// The same answer from the chat app's copy button: its own Markdown as
// text/plain, beside HTML rendered from that Markdown.
export const copiedMarkdown = `**Summary:** the upload failures came from a full disk, not the \`/var\` network share.

Here is how the options compare:

| Option | Assessment |
|---|---|
| Keep the current host | Lowest effort, but the disk fills again within a month. |
| Move uploads to [object storage](https://example.com/storage) | About $40 a month, and it removes the disk limit. |

**The deciding question.**

> “We can’t lose another weekend of uploads.”

The review raised two questions:

- What happens when a transfer is interrupted.
- Whether old files are *deleted* automatically.

1. **Move the uploads first.** Then remove the old disk.
2. **Set an alert** at 80% full.`;

export const copiedMarkdownHtml = `<meta charset='utf-8'><html><head></head><body><p><strong><span>Summary:</span></strong><span> the upload failures came from a full disk, not the </span><code>/var</code><span> network share.</span></p>`
  + `<p><span>Here is how the options compare:</span></p><div><div><div><table><thead><tr><th><span>Option</span></th><th><span>Assessment</span></th></tr></thead>`
  + `<tbody><tr><td><span>Keep the current host</span></td><td><span>Lowest effort, but the disk fills again within a month.</span></td></tr>`
  + `<tr><td><span>Move uploads to </span><a href="https://example.com/storage">object storage</a></td><td><span>About $40 a month, and it removes the disk limit.</span></td></tr></tbody></table></div></div></div>`
  + `<p><strong><span>The deciding question.</span></strong></p><blockquote><p><span>“We can’t lose another weekend of uploads.”</span></p></blockquote>`
  + `<p><span>The review raised two questions:</span></p><ul><li><span>What happens when a transfer is interrupted.</span></li><li><span>Whether old files are </span><em>deleted</em><span> automatically.</span></li></ul>`
  + `<ol start="1"><li><strong><span>Move the uploads first.</span></strong><span> Then remove the old disk.</span></li><li><strong><span>Set an alert</span></strong><span> at 80% full.</span></li></ol></body></html>`;

// The Markdown as written, with only its table turned into records.
export const copiedMarkdownNote = copiedMarkdown.replace(/\| Option \|[^]*?disk limit\. \|/, `${record('Option: Keep the current host', 'Assessment: Lowest effort, but the disk fills again within a month.')}

${record('Option: Move uploads to [object storage](https://example.com/storage)', 'Assessment: About $40 a month, and it removes the disk limit.')}`);
