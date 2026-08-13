import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { probeWordleActivity } from './probe.js';

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.PROBE_CHANNEL_ID || '1379481540773281922';

async function sendReport(report) {
  if (!token) throw new Error('DISCORD_TOKEN is required');

  const json = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  const gz = gzipSync(json, { level: 9 });
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    content: `Wordle Activity probe complete. Raw JSON ${json.byteLength} bytes → gzip ${gz.byteLength} bytes. このファイルをChatGPTにアップロードしてください。`
  }));
  form.append('files[0]', new Blob([gz], { type: 'application/gzip' }), `wordle-activity-probe-${Date.now()}.json.gz`);

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: form
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord send failed HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }
}

try {
  console.log('Starting Wordle Activity public bundle probe...');
  const report = await probeWordleActivity();
  console.log(`Probe finished: ${report.assets?.length ?? 0} JS assets, ${report.combined?.routeStrings?.length ?? 0} route strings, ${report.combined?.absoluteUrls?.length ?? 0} URLs.`);
  await sendReport(report);
  console.log('Probe report sent to Discord.');
} catch (error) {
  console.error('Probe runner failed:', error);
  process.exitCode = 0;
}
