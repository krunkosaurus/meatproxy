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
