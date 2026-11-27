import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fixNoteFormatting, noteFromHtml } from '../public/note-formatting.js';
import { terminalTable, collapsedTerminalNote, restoredTerminalNote, pastedTerminalBullets, alignedTerminalBullets, pastedPageHtml, pastedPageText, pastedPageNote, copiedMarkdown, copiedMarkdownHtml, copiedMarkdownNote, record } from './note-formatting-fixture.mjs';

// Made-up text in the layout of a reported Claude Code copy.
const pasted = ` The best clue is the timing: nightly builds fail only from about 1 AM to 3 AM UTC, and almost never
  from 9 AM to 6 PM. Cache traffic usually peaks during the day, so this follows the overnight backup
  instead.

  My suspects, in order:
  1. The cache server itself overnight: short outages or a full disk. The cache dashboard keeps an outage
     history. If it shows outages on Nov 4 between 1 and 2 AM UTC, that settles it.
  2. The build agent losing track of connections when the backup is busy. It's worse if traffic passes through
     both the office proxy and the VPN gateway (proxy not in bypass mode). The platform team would know whether
     it's set up that way.`;
const expected = `The best clue is the timing: nightly builds fail only from about 1 AM to 3 AM UTC, and almost never from 9 AM to 6 PM. Cache traffic usually peaks during the day, so this follows the overnight backup instead.

My suspects, in order:
1. The cache server itself overnight: short outages or a full disk. The cache dashboard keeps an outage history. If it shows outages on Nov 4 between 1 and 2 AM UTC, that settles it.
2. The build agent losing track of connections when the backup is busy. It's worse if traffic passes through both the office proxy and the VPN gateway (proxy not in bypass mode). The platform team would know whether it's set up that way.`;
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

test('turns a Claude Code quote bar into an unwrapped Markdown quote', () => {
  const quoted = ` Here's a reply you could send to Dana:

  ▎ I don't think that's it. The first charge (Mar 2, 00:34 UTC) is on batch 4 where you put it, and Mar 9's
  ▎ 06:34 charge is on batch 5. Batch 5 has seven lines and none for Mar 4. Can you add the Mar 4 one
  ▎ to batch 6?

  The transfer is still waiting on the review screen. If Dana would rather reissue batch 5 for $4,000
  before you click Submit, tell me and I'll change the amount.`;
  const expected = `Here's a reply you could send to Dana:

> I don't think that's it. The first charge (Mar 2, 00:34 UTC) is on batch 4 where you put it, and Mar 9's 06:34 charge is on batch 5. Batch 5 has seven lines and none for Mar 4. Can you add the Mar 4 one to batch 6?

The transfer is still waiting on the review screen. If Dana would rather reissue batch 5 for $4,000 before you click Submit, tell me and I'll change the amount.`;
  assert.equal(fixNoteFormatting(quoted), expected);
  assert.equal(fixNoteFormatting(expected), expected);
});

test('removes the five-column margin of a Hermes answer and unwraps its lines', () => {
  // Made-up text in the layout of a reported Hermes copy, selected from its first letter.
  const answer = `Quick note: the Tuesday supplier call moved to Thursday at 10 AM, and the room changed too. Please bring
     the printed order sheets with you:

     • Orchard Lane: the March delivery list with the missing crate counts filled in, plus the signed
     receipt from the driver
     • Mill Road: the two late invoices and the credit note that cancels the first one, so we can settle
     both at once
     • Harbor Street: nothing new

     The call is 30 minutes. Each shop gets five minutes, then we agree the April order together. Nobody
     places an order before the call ends.

     Notes:
     • The agenda leaves out prices on purpose. Two suppliers join the call, and they should not see each
     other's quotes.
     • If you can't make it, send your sheets to Priya and she will read them out.`;
  const expected = `Quick note: the Tuesday supplier call moved to Thursday at 10 AM, and the room changed too. Please bring the printed order sheets with you:

• Orchard Lane: the March delivery list with the missing crate counts filled in, plus the signed receipt from the driver
• Mill Road: the two late invoices and the credit note that cancels the first one, so we can settle both at once
• Harbor Street: nothing new

The call is 30 minutes. Each shop gets five minutes, then we agree the April order together. Nobody places an order before the call ends.

Notes:
• The agenda leaves out prices on purpose. Two suppliers join the call, and they should not see each other's quotes.
• If you can't make it, send your sheets to Priya and she will read them out.`;
  assert.equal(fixNoteFormatting(answer), expected);
  // A selection that starts at the left edge of the terminal has the margin on its first line too.
  assert.equal(fixNoteFormatting('     ' + answer), expected);
  assert.equal(fixNoteFormatting('Done.\n\n     The next step\n     comes later.'), 'Done.\n\nThe next step comes later.');
  assert.equal(fixNoteFormatting(expected), expected);
  // Code indented by four spaces, or by six under a list item, is still code.
  for (const code of ['Run this:\n\n    npm ci\n    npm test', '      const a = 1;\n      const b = 2;']) assert.equal(fixNoteFormatting(code), code);
});

test('strips Antigravity (agy) │ rails, bridges wrapped overflow words and keeps nested bullets', () => {
  // Made-up text in the layout of a reported Antigravity (agy) copy.
  const agy = `  │ Hi Marta (north-dock),
  │
  │ Sorry for the delay on this order. We checked the gate, yard, scale, and carrier logs for shipment
  │ #99481203 (pallet batch A4-7710). Below is everything we found so you have a full record for the claim.
  │
  │ Summary of What Happened
  │
  │ 1. The trailer seal had already been broken before Tuesday. Yard camera logs show the doors were first
  │ opened at the transfer hub on March 18, 2026 at 10:41 UTC (two crates missing), and again on March 20.
  │ 2. Second stop before the lock change: An unmarked van entered the south bay on October 30, 2026 and
  │ returned on November 15, 2026 at 11:10 UTC — before the keypad code was rotated.
  │ 3. The missing load after the gate opened: Right after the Monday release unlocked on November 16,
  2026
  │ at 00:00 UTC, the backup badge cleared dock 4 at 00:01 UTC and signed out 140 cartons at 00:02 UTC.
  │ 4. Why the new badge rule didn't stop it:
  │     • Our logs confirm the new badge rule took effect on November 16, 2026 at 07:40 UTC — seven hours
  │     after the transfer and dock sign-off
  had
  │     already finished.
  │     • Also, turning on the rule did not immediately expire already-
  │     issued gate passes (we have since fixed this), so the older pass kept working through November 19.
  │     • Most importantly, anyone holding the printed backup code could open the side locker without a
  │     badge check.
  │`;
  const expected = `Hi Marta (north-dock),

Sorry for the delay on this order. We checked the gate, yard, scale, and carrier logs for shipment #99481203 (pallet batch A4-7710). Below is everything we found so you have a full record for the claim.

Summary of What Happened

1. The trailer seal had already been broken before Tuesday. Yard camera logs show the doors were first opened at the transfer hub on March 18, 2026 at 10:41 UTC (two crates missing), and again on March 20.
2. Second stop before the lock change: An unmarked van entered the south bay on October 30, 2026 and returned on November 15, 2026 at 11:10 UTC — before the keypad code was rotated.
3. The missing load after the gate opened: Right after the Monday release unlocked on November 16, 2026 at 00:00 UTC, the backup badge cleared dock 4 at 00:01 UTC and signed out 140 cartons at 00:02 UTC.
4. Why the new badge rule didn't stop it:
    • Our logs confirm the new badge rule took effect on November 16, 2026 at 07:40 UTC — seven hours after the transfer and dock sign-off had already finished.
    • Also, turning on the rule did not immediately expire already-issued gate passes (we have since fixed this), so the older pass kept working through November 19.
    • Most importantly, anyone holding the printed backup code could open the side locker without a badge check.`;
  assert.equal(fixNoteFormatting(agy), expected);
  assert.equal(fixNoteFormatting(expected), expected);
  // Selections can start on the first letter, on the │ bar, or partway into a paragraph or list item.
  assert.equal(fixNoteFormatting(agy.replace(/^  │ /, '')), expected);
  assert.equal(fixNoteFormatting(agy.replace(/^  /, '')), expected);
  assert.equal(fixNoteFormatting('We checked the gate and\n  │ carrier logs for the shipment.'), 'We checked the gate and carrier logs for the shipment.');
  assert.equal(fixNoteFormatting('1. First line of item\n  │ continued on the rail.'), '1. First line of item continued on the rail.');
  // Mixed with surrounding prose, leading/trailing bare │ lines, single-line copy, and backtick/tilde overflow.
  assert.equal(fixNoteFormatting('Draft reply:\n\n  │\n  │ Line one wrapped to\n  `HANDOFF.md`\n  │ in\n  ~400ms\n  │\n\nSend when ready.'), 'Draft reply:\n\nLine one wrapped to `HANDOFF.md` in ~400ms\n\nSend when ready.');
  assert.equal(fixNoteFormatting('  │ Single rail line'), 'Single rail line');
  assert.equal(fixNoteFormatting('  │   • Single rail bullet  '), '• Single rail bullet  ');
  // Box tables and fenced code inside a rail keep their structure after the rail is removed.
  const boxedInRail = '  │ Summary:\n  │ ┌──┬──┐\n  │ │ A │ B │\n  │ └──┴──┘';
  assert.equal(fixNoteFormatting(boxedInRail), 'Summary:\n┌──┬──┐\n│ A │ B │\n└──┴──┘');
  const fencedInRail = '  │ Run this:\n  │\n  │ ```sh\n  │ npm ci\n  │   npm test\n  │ ```';
  assert.equal(fixNoteFormatting(fencedInRail), 'Run this:\n\n```sh\nnpm ci\n  npm test\n```');
  const treeInRail = '  │ Files:\n  │\n  │ src/\n  │ ├── a/\n  │ │   ├── b.js\n  │ │   └── c.js\n  │ └── d.js';
  assert.equal(fixNoteFormatting(treeInRail), 'Files:\n\nsrc/\n├── a/\n│   ├── b.js\n│   └── c.js\n└── d.js');
  // Standalone box rows, rounded panels, directory trees, lone │ and code blocks stay intact.
  for (const kept of [
    '│ A │ B │\n│ 1 │ 2 │',
    '╭───╮\n│ A │\n╰───╯',
    '│   ├── b.js\n│   └── c.js',
    '├── a/\n│\n└── b/',
    '    │ indented code\n    │ stays intact',
    '```text\n  │ fenced rail\n  │ stays intact\n```',
    '  │',
    '│   ├── helper.js',
  ]) assert.equal(fixNoteFormatting(kept), kept);
});

test('unwraps four-space wrapped prose blocks from agy without touching indented code', () => {
  // Made-up text in the layout of a ```text block copied from an Antigravity (agy) session.
  const agyTextBlock = `    Checked your @northbay station — good news, you're actually averaging $18.40/day per bay ($0.767 per
    active sensor-hour), not $9.20/day, which is right in line with the rest of our dock fleet (~$17-$19/day).

    Here is your April breakdown across your 4 active bays (units 412, 413, 608, 609):
    - Total April output so far: ~$1,380 ($1,342 contract pool + $38.15 spot usage), pacing
    ~$1,410 for the month
    - Total active time so far: 1,800 bay-hours (75.0 bay-days total — 412/413 started Apr 5 and were
    offline Apr 6, and 608/609 came online Apr 9)
    - Per active 24h by bay: #412 $17.10/day, #608 $17.55/day, #413 $18.90/day, #609 $19.45/day (on clear
    days #413 and #609 are hitting ~$20.50/day)

    A couple of ways it can look like ~$9.20/day:
    1. Double-counting the 50% split: $18.40 x 50% is ~$9.20/day. Both the Contract Output and
    Spot figures on the portal already reflect your 50% operator share, so you don't need to take 50%
    off again.
    2. Dividing a partial month by 30 calendar days (or across all 5 units on the lot — #610 hasn't been
    running): $1,380 / 5 / 30 is ~$9.20/day.

    On the portal, the cleanest way to check your true daily pace is Dock Bays -> All bays -> Output
    by period -> Month -> "Total per bay-hour" ($0.767/hr x 24 = $18.40/day).

    Two quick things I also noticed on your panel that are costing you a bit of upside:
    - Bays #412 and #608 are drawing ~240W under load vs ~295W on #413 and #609, running a bit warmer
    (peaking ~82C), and spent 36.4h and 31.2h in routine throttle (~10% of active time vs ~1% on
    #413/#609). That accounts for the ~$1.80/day gap between those two pairs.
    - Your harbor sync timeouts popped back up yesterday (58 final-sync failures on Apr 26 UTC across the 4
    bays after nearly zero Apr 20-24), which dipped yesterday to ~$15-$17.2/bay.`;
  const expected = `Checked your @northbay station — good news, you're actually averaging $18.40/day per bay ($0.767 per active sensor-hour), not $9.20/day, which is right in line with the rest of our dock fleet (~$17-$19/day).

Here is your April breakdown across your 4 active bays (units 412, 413, 608, 609):
- Total April output so far: ~$1,380 ($1,342 contract pool + $38.15 spot usage), pacing ~$1,410 for the month
- Total active time so far: 1,800 bay-hours (75.0 bay-days total — 412/413 started Apr 5 and were offline Apr 6, and 608/609 came online Apr 9)
- Per active 24h by bay: #412 $17.10/day, #608 $17.55/day, #413 $18.90/day, #609 $19.45/day (on clear days #413 and #609 are hitting ~$20.50/day)

A couple of ways it can look like ~$9.20/day:
1. Double-counting the 50% split: $18.40 x 50% is ~$9.20/day. Both the Contract Output and Spot figures on the portal already reflect your 50% operator share, so you don't need to take 50% off again.
2. Dividing a partial month by 30 calendar days (or across all 5 units on the lot — #610 hasn't been running): $1,380 / 5 / 30 is ~$9.20/day.

On the portal, the cleanest way to check your true daily pace is Dock Bays -> All bays -> Output by period -> Month -> "Total per bay-hour" ($0.767/hr x 24 = $18.40/day).

Two quick things I also noticed on your panel that are costing you a bit of upside:
- Bays #412 and #608 are drawing ~240W under load vs ~295W on #413 and #609, running a bit warmer (peaking ~82C), and spent 36.4h and 31.2h in routine throttle (~10% of active time vs ~1% on #413/#609). That accounts for the ~$1.80/day gap between those two pairs.
- Your harbor sync timeouts popped back up yesterday (58 final-sync failures on Apr 26 UTC across the 4 bays after nearly zero Apr 20-24), which dipped yesterday to ~$15-$17.2/bay.`;
  assert.equal(fixNoteFormatting(agyTextBlock), expected);
  assert.equal(fixNoteFormatting(expected), expected);
  // Selections can start on the first letter, partway through the margin, on a bullet, mid-sentence, or after a short greeting.
  assert.equal(fixNoteFormatting(agyTextBlock.replace(/^    /, '')), expected);
  assert.equal(fixNoteFormatting(agyTextBlock.replace(/^  /, '')), expected);
  assert.equal(
    fixNoteFormatting('Hi Marta,\n\n    Sorry for the delay on this order. We checked the gate, yard, scale, and carrier logs for shipment\n    #99481203 (pallet batch A4-7710).'),
    'Hi Marta,\n\nSorry for the delay on this order. We checked the gate, yard, scale, and carrier logs for shipment #99481203 (pallet batch A4-7710).',
  );
  assert.equal(
    fixNoteFormatting('- Total April output so far: ~$1,380 ($1,342 contract pool + $38.15 spot usage), pacing\n    ~$1,410 for the month\n    - Total active time so far: 1,800 bay-hours (75.0 bay-days total — 412/413 started Apr 5 and were\n    offline Apr 6, and 608/609 came online Apr 9)'),
    '- Total April output so far: ~$1,380 ($1,342 contract pool + $38.15 spot usage), pacing ~$1,410 for the month\n- Total active time so far: 1,800 bay-hours (75.0 bay-days total — 412/413 started Apr 5 and were offline Apr 6, and 608/609 came online Apr 9)',
  );
  assert.equal(
    fixNoteFormatting('averaging $18.40/day per bay ($0.767 per\n    active sensor-hour), not $9.20/day, which is right in line with the rest of our dock fleet (~$17-$19/day).'),
    'averaging $18.40/day per bay ($0.767 per active sensor-hour), not $9.20/day, which is right in line with the rest of our dock fleet (~$17-$19/day).',
  );
  // Long URLs, fenced blocks, nested code, semicolons, email autolinks, emphasis, and non-Latin/NFD/CJK prose unwrap cleanly.
  assert.equal(
    fixNoteFormatting('    We checked the deployment logs from last night and confirmed the webhook failed because the\n    signing secret rotated early.\n\n    Reference link:\n    https://console.example.com/organizations/acme-prod/projects/billing-pipeline/deployments/2026-04-26-abcdef123456\n\n    Please update the webhook secret in your staging settings and trigger a fresh test event so\n    we can verify delivery.'),
    'We checked the deployment logs from last night and confirmed the webhook failed because the signing secret rotated early.\n\nReference link: https://console.example.com/organizations/acme-prod/projects/billing-pipeline/deployments/2026-04-26-abcdef123456\n\nPlease update the webhook secret in your staging settings and trigger a fresh test event so we can verify delivery.',
  );
  assert.equal(
    fixNoteFormatting('    We checked the gate, yard, scale, and carrier logs for your shipment yesterday afternoon;\n    everything cleared dock four before the evening cutoff without any recorded delay.'),
    'We checked the gate, yard, scale, and carrier logs for your shipment yesterday afternoon; everything cleared dock four before the evening cutoff without any recorded delay.',
  );
  assert.equal(
    fixNoteFormatting('    To finish setting up your station account, send the confirmation email directly to\n    <support@example.com> so our operations team can activate the new dock sensors.'),
    'To finish setting up your station account, send the confirmation email directly to <support@example.com> so our operations team can activate the new dock sensors.',
  );
  assert.equal(
    fixNoteFormatting('    हमने आपके सभी सक्रिय केंद्रों के अप्रैल महीने के आंकड़ों की पूरी जांच की है और पाया कि आपका दैनिक\n    औसत प्रदर्शन हमारे पूरे बेड़े के औसत के बिल्कुल बराबर है और कोई समस्या नहीं है।'),
    'हमने आपके सभी सक्रिय केंद्रों के अप्रैल महीने के आंकड़ों की पूरी जांच की है और पाया कि आपका दैनिक औसत प्रदर्शन हमारे पूरे बेड़े के औसत के बिल्कुल बराबर है और कोई समस्या नहीं है।',
  );
  assert.equal(
    fixNoteFormatting('    我们已经检查了您四月份四个活跃工位的全部运行记录和每日统计数据，整体表现非常\n    稳定，完全符合我们车队目前的平均水平，不需要做任何额外的配置调整。'),
    '我们已经检查了您四月份四个活跃工位的全部运行记录和每日统计数据，整体表现非常 稳定，完全符合我们车队目前的平均水平，不需要做任何额外的配置调整。',
  );
  assert.equal(
    fixNoteFormatting('    Here is the quick explanation of why the handler failed during the nightly backup run on\n    dock four:\n\n        const a = 1;\n        const b = 2;\n        if (a < b) {\n          return a + b;\n        }'),
    'Here is the quick explanation of why the handler failed during the nightly backup run on dock four:\n\n    const a = 1;\n    const b = 2;\n    if (a < b) {\n      return a + b;\n    }',
  );
  // Real prose with query URLs, backtick functions, plural parens, signed amounts, wrapped words, double-spaced sentences, and email greetings/sign-offs unwraps cleanly.
  assert.equal(
    fixNoteFormatting('    You can check the full April breakdown directly on the dashboard at\n    https://portal.example.com/bays?month=2026-04 and compare each unit daily output.'),
    'You can check the full April breakdown directly on the dashboard at https://portal.example.com/bays?month=2026-04 and compare each unit daily output.',
  );
  assert.equal(
    fixNoteFormatting('    I looked at `fixNoteFormatting()` and confirmed that the four-space margin gets stripped\n    properly when the pasted lines wrap cleanly at column ninety.'),
    'I looked at `fixNoteFormatting()` and confirmed that the four-space margin gets stripped properly when the pasted lines wrap cleanly at column ninety.',
  );
  assert.equal(
    fixNoteFormatting('    Your April output came in much stronger than expected across all four bays, finishing at\n    +$38.15 above the contract pool estimate for the month.'),
    'Your April output came in much stronger than expected across all four bays, finishing at +$38.15 above the contract pool estimate for the month.',
  );
  assert.equal(
    fixNoteFormatting('    We checked the cluster health metrics across all regions and confirmed that the primary\n    node recovered automatically within thirty seconds of the overnight backup finishing.'),
    'We checked the cluster health metrics across all regions and confirmed that the primary node recovered automatically within thirty seconds of the overnight backup finishing.',
  );
  assert.equal(
    fixNoteFormatting('    We checked the gate, yard, scale, and carrier logs for shipment #99481203 and expect a quick\n    return.'),
    'We checked the gate, yard, scale, and carrier logs for shipment #99481203 and expect a quick return.',
  );
  assert.equal(
    fixNoteFormatting('    Make sure you pass --fail when testing the download command against the staging server so\n    any unexpected HTTP status code surfaces right away.'),
    'Make sure you pass --fail when testing the download command against the staging server so any unexpected HTTP status code surfaces right away.',
  );
  assert.equal(
    fixNoteFormatting('    Hi Marta,\n    Thanks for reaching out about shipment #99481203.\n\n    We checked the gate, yard, scale, and carrier logs for your April delivery and confirmed\n    that all four pallets cleared dock four before the evening cutoff without any delay.\n\n    Best,\n    Alex\n    Operations Lead'),
    'Hi Marta, Thanks for reaching out about shipment #99481203.\n\nWe checked the gate, yard, scale, and carrier logs for your April delivery and confirmed that all four pallets cleared dock four before the evening cutoff without any delay.\n\nBest, Alex Operations Lead',
  );
  // Standard 2-space Claude Code nested lists and double-digit ordered lists keep their nesting.
  assert.equal(
    fixNoteFormatting('  - Parent item with a long description that wraps onto the next line right at column\n    eighty in a normal two-space terminal copy:\n    - Child item one.\n    - Child item two.'),
    '- Parent item with a long description that wraps onto the next line right at column eighty in a normal two-space terminal copy:\n  - Child item one.\n  - Child item two.',
  );
  assert.equal(
    fixNoteFormatting('10. Parent item with a long description that wraps onto the next line aligned with the\n    text of item ten at column four:\n    - Child item one under item ten\n    - Child item two under item ten'),
    '10. Parent item with a long description that wraps onto the next line aligned with the text of item ten at column four:\n    - Child item one under item ten\n    - Child item two under item ten',
  );
  assert.equal(
    fixNoteFormatting(' 1. Parent item with a long description that wraps onto the next line right at column\n    eighty in a one-space terminal copy:\n    - Child item one'),
    '1. Parent item with a long description that wraps onto the next line right at column eighty in a one-space terminal copy:\n   - Child item one',
  );
  // Tab-indented code starting with a list marker terminates any preceding list cleanly.
  assert.equal(
    fixNoteFormatting('Intro\n  - Item\n\n\t- tab code\n    const a = 1;\n    const b = 2;'),
    'Intro\n- Item\n\n\t- tab code\n    const a = 1;\n    const b = 2;',
  );
  // Four-space indented code, commands, config, logs, diffs, CLI tables, comments, and literal bullet blocks stay intact.
  for (const kept of [
    'Run these two commands in the repository root to verify the release:\n    npm ci\n    npm test',
    'Run these commands:\n\n    curl --fail --show-error https://example.com/receive.mjs -o receive.mjs\n    node receive.mjs \'https://example.com/s/abcdef#secret\' ./handoff',
    '    set -e\n    echo "This is a very long warning message explaining why the staging deploy did not proceed"\n    exit 1',
    '    git commit -m "fix the bug where users cannot log in after resetting their password" --no-verify\n    git push origin main',
    '    npm install express cors helmet compression morgan dotenv winston zod\n    npm run build',
    '    cargo add serde tokio reqwest anyhow tracing clap chrono uuid regex\n    cargo build',
    '    uv add fastapi uvicorn pydantic sqlalchemy alembic httpx pytest ruff\n    uv run pytest',
    '    export DEPLOY_NOTE="Rolling out the updated worker pool across all four dock regions"\n    ./deploy.sh',
    '    const response = await fetch(\'https://example.com/api/v1/bays/summary?month=2026-04\');\n    const payload = await response.json();',
    '    type HandoffStatus = "pending" | "connecting" | "transferring" | "completed"\n    type Direction = "send" | "receive"',
    '    from billing import invoice, receipt, summary, totals, ledger, payout, balance\n    from models import Account',
    '    throw new Error("Unable to establish direct connection before the handshake deadline")\n    return null',
    '    raise ValueError("Expected a positive integer timeout for the worker retry loop")\n    return default_timeout',
    '    return fmt.Errorf("failed to verify checksum for uploaded handoff archive from peer")\n    return nil',
    '    println!("Finished verifying all incoming file digests across the active relay")\n    Ok(())',
    '    SELECT id, name, email, status, created, updated, role, plan, region, tier\n    FROM users\n    WHERE active = true',
    '    -- We checked the gate, yard, scale, and carrier logs for shipment before\n    -- filing the claim with the transfer hub.',
    '    description: Live encrypted file and context handoffs between browsers and agents\n    scripts:\n      test: node --test',
    '    description = "Live encrypted file and context handoffs between browsers and agents"\n    name = "meatproxy"',
    '    Description=Live encrypted file and context handoffs between browsers and agents\n    After=network.target',
    '    RUN apt-get update && apt-get install -y ca-certificates curl git tini\n    WORKDIR /app\n    COPY package.json .',
    '    .PHONY: build test lint clean format deploy check release publish docs\n    build:\n        npm run build',
    '    add_header Content-Security-Policy "default-src self; script-src self" always\n    add_header Referrer-Policy no-referrer',
    '    "Live encrypted file and context handoffs between browsers and agents with no server storage",\n    "Another long description entry inside a JSON array of plain text sentences"',
    '    \'Live encrypted file and context handoffs between browsers and agents with no server storage\',\n    \'Another long description entry inside a single-quoted array of plain text sentences\'',
    '    2026-04-26T10:15:02Z WARN worker pool exhausted waiting for available slot on primary queue\n    2026-04-26T10:15:03Z ERROR failed to acquire connection before deadline',
    '    Apr 26 10:15:02 north-dock worker: pool exhausted waiting for available slot on primary queue\n    Apr 26 10:15:03 north-dock worker: failed to acquire connection before deadline',
    '    [2026-04-26 10:15:02] WARN worker pool exhausted waiting for available slot on primary queue\n    [2026-04-26 10:15:03] ERROR failed to acquire connection before deadline',
    '    10:15:02 WARN worker pool exhausted waiting for available slot on primary queue\n    10:15:03 ERROR failed to acquire connection before deadline',
    '    [WARN] worker pool exhausted waiting for available slot on primary queue\n    [ERROR] failed to acquire connection before deadline',
    '    5c76b3b fix(notes): strip Antigravity rails and bridge wrapped overflow lines\n    58b14b0 fix(notes): remove the five-column margin of a Hermes answer',
    '    NAME                 STATUS    RESTARTS   AGE   DESCRIPTION\n    worker-alpha         Running   0          4d    Primary ingestion worker for north dock\n    worker-beta          Running   1          4d    Secondary ingestion worker for south dock',
    '    @@ -14,7 +14,7 @@\n    -The old behavior kept four spaces intact because it could be a code block in markdown\n    +The new behavior strips four spaces when the pasted lines look like wrapped prose',
    '    // We checked the gate, yard, scale, and carrier logs for shipment #99481203 before\n    // filing the claim with the transfer hub.',
    '    │ We checked the gate, yard, scale, and carrier logs for shipment #99481203 and confirmed that the\n    │ transfer finished on time.',
    '    • First literal\n    continued',
    '    - flag one\n    value one',
    '    ```text\n    We checked the gate, yard, scale, and carrier logs for shipment #99481203 and confirmed that the\n    transfer finished on time.\n    ```',
  ]) assert.equal(fixNoteFormatting(kept), kept);
});

test('joins wrapped hyphenated words without breaking suspended hyphens or dashes', () => {
  assert.equal(fixNoteFormatting('invalidate already-\nlogged-in sessions'), 'invalidate already-logged-in sessions');
  assert.equal(fixNoteFormatting('check EIP-\n7702 and up-\nto-date notes'), 'check EIP-7702 and up-to-date notes');
  assert.equal(fixNoteFormatting('supports pre-\nand post-checks, two-\nor three-day runs, and one-\nto two-hour windows'), 'supports pre- and post-checks, two- or three-day runs, and one- to two-hour windows');
  assert.equal(fixNoteFormatting('keep dash -\nseparated and double--\nhyphen spacing'), 'keep dash - separated and double-- hyphen spacing');
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
