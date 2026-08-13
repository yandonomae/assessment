import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { probeWordleActivity } from './probe.js';
import { deepProbe } from './deep-probe.js';

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.PROBE_CHANNEL_ID || '1379481540773281922';

async function sendFile({ content, buffer, filename, contentType = 'application/gzip' }) {
  if (!token) throw new Error('DISCORD_TOKEN is required');

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content }));
  form.append('files[0]', new Blob([buffer], { type: contentType }), filename);

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

async function sendJsonReport(report, prefix, message) {
  const json = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  const gz = gzipSync(json, { level: 9 });
  await sendFile({
    content: `${message} Raw JSON ${json.byteLength} bytes → gzip ${gz.byteLength} bytes.`,
    buffer: gz,
    filename: `${prefix}-${Date.now()}.json.gz`
  });
}

async function sendRawBundles(report) {
  for (const url of report.root?.assetUrls ?? []) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 WordleRound2Observer/0.2',
          'accept': 'application/javascript,text/javascript,*/*'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const raw = Buffer.from(text, 'utf8');
      const gz = gzipSync(raw, { level: 9 });
      const urlObj = new URL(url);
      const baseName = urlObj.pathname.split('/').pop() || 'wordle-activity.js';
      await sendFile({
        content: `Wordle Activityの生JSバンドルです (${raw.byteLength} bytes → gzip ${gz.byteLength} bytes)。`,
        buffer: gz,
        filename: `${baseName}.gz`
      });
      console.log(`Raw bundle sent: ${baseName} (${raw.byteLength} -> ${gz.byteLength})`);
    } catch (error) {
      console.warn(`Could not send raw bundle ${url}:`, error?.message ?? error);
    }
  }
}

try {
  console.log('Starting Wordle Activity public bundle probe...');
  const report = await probeWordleActivity();
  console.log(`Probe finished: ${report.assets?.length ?? 0} JS assets, ${report.combined?.routeStrings?.length ?? 0} route strings, ${report.combined?.absoluteUrls?.length ?? 0} URLs.`);
  await sendJsonReport(report, 'wordle-activity-probe', 'Wordle Activity probe complete.');

  const deep = await deepProbe();
  await sendJsonReport(deep, 'wordle-deep-probe', 'Wordle game-state deep probe complete. これをChatGPTにアップロードしてください。');

  await sendRawBundles(report);
  console.log('Probe reports and raw bundle(s) sent to Discord.');
} catch (error) {
  console.error('Probe runner failed:', error);
  process.exitCode = 0;
}
