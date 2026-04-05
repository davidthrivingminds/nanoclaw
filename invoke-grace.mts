import { runContainerAgent } from './src/container-runner.js';
import { initDatabase, getSession } from './src/db.js';
import type { RegisteredGroup } from './src/types.js';

initDatabase();

const group: RegisteredGroup = {
  name: 'Grace',
  folder: 'grace',
  trigger: '@Clara',
  isMain: false,
  requiresTrigger: false,
  added_at: new Date().toISOString(),
};

const sessionId = getSession('grace') ?? undefined;

const prompt = `David needs a follow-up email drafted for a client called James Wong who attended last month's leadership retreat and hasn't been in touch since. Draft a warm, professional follow-up email from David. Then deliver it using the dual-delivery process: send the full draft to David's inbox AND return a WhatsApp summary.`;

console.error('[invoke-grace] Starting Grace container...');

const output = await runContainerAgent(
  group,
  { prompt, sessionId, groupFolder: 'grace', chatJid: '61400487855@s.whatsapp.net', isMain: false, assistantName: 'Clara' },
  () => {},
  async (result) => {
    if (result.result) {
      console.log('\n=== Grace output ===\n');
      console.log(result.result);
    }
  },
);

console.error(`[invoke-grace] Done. Status: ${output.status}`);
if (output.error) console.error(`[invoke-grace] Error: ${output.error}`);
