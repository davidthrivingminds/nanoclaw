import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../store/messages.db'));

const CHAT_JID = '61400487855@s.whatsapp.net'; // David's WhatsApp
const NOW = new Date().toISOString();

const insert = db.prepare(`
  INSERT OR REPLACE INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
     context_mode, next_run, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const BRIEFING_PROMPT = `You are Clara. This is your automated daily morning briefing for David at Thriving Minds Global.

Deliver the briefing in two formats:

1. WhatsApp 5-line summary — send via mcp__nanoclaw__send_message FIRST, before the email.
2. Full email report — send to david@thrivingmindsglobal.com via the credential proxy.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHATSAPP SUMMARY — exactly 5 lines, WhatsApp formatting (*bold*)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Clara Morning Briefing — [Day DD MMM]*
1. Calendar: [one-line summary of today's meetings/commitments]
2. Pipeline: [one-line HubSpot deal status]
3. Finance: [one-line flag, or "No flags today"]
4. Tasks: [X active] | Security: [Green ✓ / Amber ⚠ / Red ✗]
5. Focus: [single top priority for David today]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EMAIL REPORT — full detail, all 8 sections
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Subject: Clara Morning Briefing — [Weekday, DD MMM YYYY]

## 1. Today's Calendar
Check today's date/time (Brisbane): run \`date\` in bash.
List all meetings and commitments for today. If no calendar data is available, note it and remind David to connect Google Calendar.

## 2. Communications Summary
Query the last 24 hours of inbound messages across all registered groups:

  sqlite3 /workspace/project/store/messages.db "
    SELECT m.jid, m.message, m.timestamp
    FROM messages m
    WHERE m.timestamp > datetime('now', '-24 hours')
      AND NOT m.is_from_me
    ORDER BY m.timestamp DESC
    LIMIT 30;
  "

Summarise: who reached out, what they asked, what was actioned or is pending a response.

## 3. Pipeline Pulse
Use mcp__hubspot__* tools to check the TMG sales pipeline:
- Deals that changed stage in the last 7 days (name, old stage → new stage, owner)
- Deals with no activity in 7+ days (stale — name, stage, days since last touch)
- Pipeline total value by stage
If HubSpot is unavailable, note it clearly.

## 4. Financial Flags
Use mcp__powerbi__powerbi_read_budget_excel to read the FY26 budget spreadsheet.
Then use mcp__powerbi__powerbi_list_workspaces → mcp__powerbi__powerbi_execute_dax to surface:
- Any budget line significantly over or under target
- Cash flow concerns
- Items that require David's attention or decision this week
If Power BI is unavailable, note it clearly.

## 5. Active Task Board Summary
Query all scheduled tasks:

  sqlite3 /workspace/project/store/messages.db "
    SELECT id, group_folder, schedule_value, status, last_run, next_run
    FROM scheduled_tasks
    WHERE status = 'active'
    ORDER BY group_folder, id;
  "

Report: total active tasks, breakdown by agent, and flag any task that has never run (last_run IS NULL after >24 hours) or that last ran more than 48 hours ago when its schedule suggests it should have run sooner.

## 6. AI Workforce Cost
Estimate agent activity this week:

  sqlite3 /workspace/project/store/messages.db "
    SELECT
      COUNT(*) AS total_messages_sent,
      COUNT(DISTINCT jid) AS active_chats
    FROM messages
    WHERE timestamp > datetime('now', '-7 days') AND is_from_me;
  "

  sqlite3 /workspace/project/store/messages.db "
    SELECT group_folder, COUNT(*) AS task_runs
    FROM scheduled_tasks
    WHERE last_run > datetime('now', '-7 days')
    GROUP BY group_folder
    ORDER BY task_runs DESC;
  "

Report: agent message volume and task invocations for the week. Remind David that token-level cost detail is available at console.anthropic.com.

## 7. Security Status
Read Knox's overnight check output:

  bash -c 'FILE=/workspace/project/groups/knox/overnight_status.txt; if [ -f "$FILE" ]; then AGE=$(( $(date +%s) - $(stat -c %Y "$FILE" 2>/dev/null || stat -f %m "$FILE") )); if [ $AGE -gt 129600 ]; then echo "STALE: file is older than 36 hours"; else cat "$FILE"; fi; else echo "NOT FOUND"; fi'

Report exactly ONE status line:
- Green ✓ All clear — [brief summary]
- Amber ⚠ [specific issue found]
- Red ✗ [critical details requiring immediate attention]

If the file is missing or stale, report Amber: Knox overnight check not found — verify Knox tasks are running.

## 8. Priority Focus
Based on everything above, state the single most important thing for David to action today.
One sentence. Specific. Actionable. No preamble.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DELIVERY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1 — Send the WhatsApp 5-line summary first via mcp__nanoclaw__send_message.

Step 2 — Compile the full report, then send the email. Write the report body to /tmp/briefing.txt, then:

  node --input-type=module << 'EOF'
  import fs from 'fs';
  const body = fs.readFileSync('/tmp/briefing.txt', 'utf-8');
  const dateStr = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Australia/Brisbane'
  });
  const proxy = process.env.ANTHROPIC_BASE_URL || 'http://192.168.64.1:3001';
  const r = await fetch(\`\${proxy}/send-email\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: 'david@thrivingmindsglobal.com',
      subject: \`Clara Morning Briefing — \${dateStr}\`,
      body,
    }),
  });
  console.log(await r.text());
  EOF

Step 3 — If the WhatsApp send_message call fails, include the 5-line summary at the top of the email body as a fallback so David always gets the key points.

Wrap all working notes and intermediate tool output in <internal> tags. Only the final WhatsApp summary and a brief confirmation should appear in your visible output.`;

insert.run(
  'clara-morning-briefing',
  'whatsapp_main',
  CHAT_JID,
  BRIEFING_PROMPT,
  null, // no script — briefing always runs; cron handles Mon-Fri filtering
  'cron',
  '0 7 * * 1-5', // weekdays 7:00 AM Brisbane time
  'group',
  null, // next_run computed on first scheduler tick
  'active',
  NOW,
);

// Verify
const tasks = db
  .prepare(
    `SELECT id, group_folder, schedule_value, context_mode, status
     FROM scheduled_tasks ORDER BY group_folder, id`,
  )
  .all();
console.log('All scheduled tasks:');
for (const t of tasks) {
  console.log(` ✓ ${t.id.padEnd(30)} [${t.schedule_value.padEnd(12)}] ${t.context_mode.padEnd(10)} ${t.status}`);
}

db.close();
