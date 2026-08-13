import fs from 'node:fs';
import path from 'node:path';

const WORDLE_APP_ID = '1211781489931452447';

export const CAPTURE_EVENT_NAMES = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
  'CHANNEL_UPDATE',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_DELETE',
  'VOICE_STATE_UPDATE',
  'VOICE_CHANNEL_EFFECT_SEND'
]);

export function deepText(value) {
  const chunks = [];
  const walk = (v) => {
    if (typeof v === 'string') chunks.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return chunks.join(' ');
}

export function looksLikeWordle(data) {
  const applicationId = data?.application_id ?? data?.applicationId ?? data?.webhook_id ?? data?.webhookId;
  if (applicationId === WORDLE_APP_ID) return true;

  const text = deepText(data).toLowerCase();
  return /[🟩🟨⬛⬜]{3,}/u.test(text) || /\bwordle\b/.test(text);
}

export function summarizeCapture(records) {
  const eventCounts = new Map();
  const applicationIds = new Map();
  const authors = new Map();
  let wordleCandidates = 0;

  for (const record of records) {
    eventCounts.set(record.event, (eventCounts.get(record.event) ?? 0) + 1);
    if (record.wordleCandidate) wordleCandidates += 1;

    const applicationId = record.data?.application_id ?? record.data?.applicationId;
    if (applicationId) applicationIds.set(applicationId, (applicationIds.get(applicationId) ?? 0) + 1);

    const author = record.data?.author;
    if (author?.id) {
      const key = `${author.username ?? author.global_name ?? 'unknown'} (${author.id})`;
      authors.set(key, (authors.get(key) ?? 0) + 1);
    }
  }

  const sortedObject = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

  return {
    totalRecords: records.length,
    wordleCandidates,
    eventCounts: sortedObject(eventCounts),
    applicationIds: sortedObject(applicationIds),
    authors: sortedObject(authors)
  };
}

export function eventMatchesWatch(event, data, watch) {
  if (!watch || !CAPTURE_EVENT_NAMES.has(event) || !data) return false;

  const guildId = data.guild_id ?? data.guildId;
  const channelId = data.channel_id ?? data.channelId ?? data.id;

  if (event.startsWith('MESSAGE_')) return channelId === watch.channelId;

  if (event.startsWith('THREAD_')) {
    return guildId === watch.guildId && (data.parent_id === watch.channelId || channelId === watch.channelId);
  }

  if (event === 'CHANNEL_UPDATE') return channelId === watch.channelId;

  if (event.startsWith('VOICE_')) return guildId === watch.guildId;

  return guildId === watch.guildId && channelId === watch.channelId;
}

export class CaptureStore {
  constructor({ dataDir }) {
    this.records = [];
    this.dataDir = dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.jsonlPath = path.join(this.dataDir, 'capture.jsonl');
  }

  clear() {
    this.records = [];
    fs.writeFileSync(this.jsonlPath, '', 'utf8');
  }

  add(record) {
    this.records.push(record);
    fs.appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  exportObject(watch) {
    return {
      exportedAt: new Date().toISOString(),
      watch,
      summary: summarizeCapture(this.records),
      records: this.records
    };
  }
}
