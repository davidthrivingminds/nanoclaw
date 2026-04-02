import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../store/messages.db'));

const CHAT_JID = '61400487855@s.whatsapp.net'; // David's WhatsApp (Clara main group)
const NOW = new Date().toISOString();

const insert = db.prepare(`
  INSERT OR REPLACE INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
     context_mode, next_run, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Task 2: Midnight WhatsApp health check ────────────────────────────────────
insert.run(
  'knox-whatsapp-health',
  'knox',
  CHAT_JID,
  `You are Knox. The NanoClaw health check detected that the credential proxy did not respond normally at midnight. Investigate and send an email alert only (no WhatsApp — it may be down):

curl -s -X POST "\${ANTHROPIC_BASE_URL:-http://192.168.64.1:3001}/send-email" \\
  -H "Content-Type: application/json" \\
  -d "{\\"subject\\":\\"Knox ALERT: NanoClaw health check failed $(date '+%Y-%m-%d %H:%M')\\",\\"body\\":\\"The midnight health check found the proxy unresponsive (status: $(cat /tmp/knox_proxy_status 2>/dev/null || echo unknown)). Check the NanoClaw service. Time: $(date)\\"}"`,
  // Script: curl the proxy, wake agent only if it doesn't respond
  `PROXY="\${ANTHROPIC_BASE_URL:-http://192.168.64.1:3001}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "\${PROXY}/hubspot-token" 2>/dev/null || echo "000")
echo "$STATUS" > /tmp/knox_proxy_status
# 200 = HubSpot configured, 503 = proxy up but not configured — both mean proxy is alive
if [ "$STATUS" = "200" ] || [ "$STATUS" = "503" ]; then
  echo '{"wakeAgent": false}'
else
  echo '{"wakeAgent": true, "data": {"proxyStatus": "'"$STATUS"'"}}'
fi`,
  'cron',
  '0 0 * * *',
  'isolated',
  null, // next_run computed on first scheduler tick
  'active',
  NOW
);

// ── Task 4: Monthly deep security review (first Monday of month, 7:00 AM) ──────
insert.run(
  'knox-monthly-review',
  'knox',
  CHAT_JID,
  `You are Knox, Head of Technology for Thriving Minds Global. This is the monthly deep security review.

Conduct a thorough review covering:
1. SSL/TLS certificate status for thrivingmindsglobal.com (expiry date, days remaining)
   echo | openssl s_client -servername thrivingmindsglobal.com -connect thrivingmindsglobal.com:443 2>/dev/null | openssl x509 -noout -dates
2. Credential hygiene reminder — flag any API keys/tokens due for rotation (Anthropic, HubSpot, Power BI)
3. Infrastructure health summary (review /workspace/group/overnight_status.txt if present)
4. Any anomalies or incidents from the past month
5. Recommendations for the coming month

Send a comprehensive email report:
  POST \${ANTHROPIC_BASE_URL:-http://192.168.64.1:3001}/send-email
  Subject: "Knox Monthly Security Review — [Month Year]"
  Body: full formatted report

Also send a brief WhatsApp notification via mcp__nanoclaw__send_message:
"🔒 Knox Monthly Security Review complete for [Month Year] — report sent to david@thrivingmindsglobal.com"`,
  // Script: only run on first Monday of the month
  `node --input-type=module -e "
const now = new Date();
const isFirstMonday = now.getDay() === 1 && now.getDate() <= 7;
process.stdout.write(JSON.stringify({ wakeAgent: isFirstMonday }) + '\\n');
"`,
  'cron',
  '0 7 * * 1',
  'isolated',
  null,
  'active',
  NOW
);

// ── Task 5: Quarterly review reminder (first Mon of Mar/Jun/Sep/Dec, 7:00 AM) ──
insert.run(
  'knox-quarterly-reminder',
  'knox',
  CHAT_JID,
  `You are Knox. Send the quarterly security review reminder.

Send a WhatsApp message via mcp__nanoclaw__send_message:
"🔒 Knox Quarterly Security Reminder — [Quarter Year]

Time for the quarterly security review. Checklist:
• Rotate all API keys and access tokens (HubSpot, Power BI, Anthropic)
• Audit registered NanoClaw groups and sender allowlists
• Review container security posture
• Update NanoClaw dependencies
• Verify backup and recovery procedures

Tag @Clara when complete."

Also email the reminder:
  POST \${ANTHROPIC_BASE_URL:-http://192.168.64.1:3001}/send-email
  Subject: "Knox Quarterly Security Reminder — [Quarter Year]"
  Body: same checklist as above`,
  // Script: only run on first Monday of Mar/Jun/Sep/Dec
  `node --input-type=module -e "
const now = new Date();
const isFirstMonday = now.getDay() === 1 && now.getDate() <= 7;
const isQuarterMonth = [3, 6, 9, 12].includes(now.getMonth() + 1);
process.stdout.write(JSON.stringify({ wakeAgent: isFirstMonday && isQuarterMonth }) + '\\n');
"`,
  'cron',
  '0 7 * * 1',
  'isolated',
  null,
  'active',
  NOW
);

// Verify
const tasks = db.prepare(`SELECT id, schedule_value, status FROM scheduled_tasks WHERE group_folder = 'knox' ORDER BY id`).all();
console.log('Knox tasks in DB:');
for (const t of tasks) {
  console.log(` ✓ ${t.id}  [${t.schedule_value}]  ${t.status}`);
}

db.close();
