import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits
} from 'discord.js';
import {
  CaptureStore,
  eventMatchesWatch,
  looksLikeWordle,
  summarizeCapture
} from './capture.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const controlUserId = process.env.CONTROL_USER_ID?.trim() || null;
const store = new CaptureStore({ dataDir });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let watch = null;
let lastWatch = null;

function isAuthorized(message) {
  if (message.author?.bot) return false;
  if (!controlUserId) return true;
  return message.author.id === controlUserId;
}

function addRecord(event, data, extra = {}) {
  const record = {
    receivedAt: new Date().toISOString(),
    event,
    wordleCandidate: looksLikeWordle(data),
    data,
    ...extra
  };
  store.add(record);

  const appId = data?.application_id ?? data?.applicationId ?? '-';
  const author = data?.author?.username ?? data?.author?.global_name ?? data?.author?.globalName ?? '-';
  console.log(`[capture] ${event} candidate=${record.wordleCandidate} app=${appId} author=${author}`);
}

for (const eventName of Object.values(GatewayDispatchEvents)) {
  client.ws.on(eventName, (data, shardId) => {
    if (!watch || !eventMatchesWatch(eventName, data, watch)) return;
    if (data?.author?.id && data.author.id === client.user?.id) return;
    addRecord(eventName, data, { shardId, source: 'gateway-raw' });
  });
}

async function addHydratedMessage(event, message) {
  if (!watch || message.channelId !== watch.channelId) return;
  if (message.author?.id === client.user?.id) return;

  let full = message;
  try {
    if (message.partial) full = await message.fetch();
  } catch (error) {
    console.warn('Could not fetch full message:', error?.message ?? error);
  }

  const json = typeof full.toJSON === 'function' ? full.toJSON() : full;
  addRecord(event, json, { source: 'discordjs-hydrated' });
}

async function scanHistory(message, requestedCount = 300) {
  const target = Math.max(1, Math.min(Number(requestedCount) || 300, 1000));
  const collected = [];
  let before;

  while (collected.length < target) {
    const pageSize = Math.min(100, target - collected.length);
    const batch = await message.channel.messages.fetch({
      limit: pageSize,
      ...(before ? { before } : {})
    });

    if (!batch.size) break;

    const page = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    collected.push(...page);
    before = page[0]?.id;

    if (batch.size < pageSize || !before) break;
  }

  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  store.clear();
  watch = null;

  let stored = 0;
  for (const historicalMessage of collected) {
    if (historicalMessage.author?.id === client.user?.id) continue;
    if (historicalMessage.content?.startsWith('!w2')) continue;

    let full = historicalMessage;
    try {
      if (historicalMessage.partial) full = await historicalMessage.fetch();
    } catch (error) {
      console.warn('Could not hydrate historical message:', error?.message ?? error);
    }

    const json = typeof full.toJSON === 'function' ? full.toJSON() : full;
    addRecord('HISTORY_MESSAGE', json, {
      source: 'discord-rest-history',
      messageCreatedAt: full.createdAt?.toISOString?.() ?? null,
      messageEditedAt: full.editedAt?.toISOString?.() ?? null
    });
    stored += 1;
  }

  lastWatch = {
    guildId: message.guildId,
    channelId: message.channelId,
    mode: 'history-scan',
    scannedAt: new Date().toISOString(),
    startedBy: message.author.id,
    requestedCount: target,
    fetchedCount: collected.length,
    storedCount: stored
  };

  return summarizeCapture(store.records);
}

client.on(Events.MessageCreate, async (message) => {
  if (message.content?.startsWith('!w2')) {
    if (!isAuthorized(message)) return;
    await handleCommand(message);
    return;
  }
  await addHydratedMessage('HYDRATED_MESSAGE_CREATE', message);
});

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  await addHydratedMessage('HYDRATED_MESSAGE_UPDATE', newMessage);
});

async function handleCommand(message) {
  const args = message.content.trim().split(/\s+/).slice(1);
  const command = (args[0] || 'help').toLowerCase();

  if (!message.guildId) {
    await message.reply('この観測Botはサーバー内のテスト用チャンネルで使ってください。');
    return;
  }

  switch (command) {
    case 'watch': {
      store.clear();
      watch = {
        guildId: message.guildId,
        channelId: message.channelId,
        startedAt: new Date().toISOString(),
        startedBy: message.author.id
      };
      await message.reply(
        '観測開始。ここで公式Wordleを1ゲーム遊んでください。終わったら `!w2 stop` → `!w2 export` です。\n' +
        'このテスト中、このチャンネルのメッセージ系イベントと同一サーバーの一部Voiceイベントを記録します。'
      );
      break;
    }

    case 'scan': {
      const requested = Number(args[1]) || 300;
      await message.reply(`過去ログを取得します（最大 ${Math.min(Math.max(requested, 1), 1000)} 件）。少し待ってください…`);
      try {
        const summary = await scanHistory(message, requested);
        await message.reply(
          `過去ログ取得完了。${summary.totalRecords}件保存しました（Wordle候補 ${summary.wordleCandidates}件）。\n` +
          '次に `!w2 inspect` → `!w2 export` を実行してください。'
        );
      } catch (error) {
        console.error('History scan failed:', error);
        await message.reply(
          `過去ログ取得に失敗しました: ${error?.message ?? error}\n` +
          'Botに「チャンネルを見る」「メッセージ履歴を読む」権限があるか確認してください。'
        );
      }
      break;
    }

    case 'stop': {
      if (!watch) {
        await message.reply('いまは観測していません。');
        break;
      }
      watch.stoppedAt = new Date().toISOString();
      const summary = summarizeCapture(store.records);
      const stoppedWatch = watch;
      watch = null;
      lastWatch = stoppedWatch;
      await message.reply(`観測停止。${summary.totalRecords}件記録しました（Wordle候補 ${summary.wordleCandidates}件）。次に \`!w2 export\`。`);
      break;
    }

    case 'status': {
      const summary = summarizeCapture(store.records);
      const target = watch ?? lastWatch;
      await message.reply(
        `状態: ${watch ? '観測中' : '停止中'}\n` +
        `記録: ${summary.totalRecords}件 / Wordle候補: ${summary.wordleCandidates}件\n` +
        `対象チャンネル: ${target?.channelId ? `<#${target.channelId}>` : '未設定'}`
      );
      break;
    }

    case 'inspect': {
      const summary = summarizeCapture(store.records);
      const text = '```json\n' + JSON.stringify(summary, null, 2).slice(0, 1800) + '\n```';
      await message.reply(text);
      break;
    }

    case 'export': {
      if (!store.records.length) {
        await message.reply('まだ記録がありません。今日すでにWordleを済ませた場合は `!w2 scan 300` を試してください。');
        break;
      }
      const payload = store.exportObject(watch ?? lastWatch);
      const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      if (buffer.byteLength > 7_500_000) {
        await message.reply('記録が大きすぎます。`!w2 clear` の後、`!w2 scan 100` など件数を減らして再試行してください。');
        break;
      }
      const attachment = new AttachmentBuilder(buffer, { name: `wordle-observer-${Date.now()}.json` });
      await message.reply({
        content: '観測データです。このJSONをChatGPTのこの会話にアップロードしてください。',
        files: [attachment]
      });
      break;
    }

    case 'clear': {
      watch = null;
      lastWatch = null;
      store.clear();
      await message.reply('観測データを消去しました。');
      break;
    }

    default:
      await message.reply(
        '**Wordle Round 2 Observer**\n' +
        '`!w2 scan 300` 過去メッセージを遡って取得（1〜1000件）\n' +
        '`!w2 watch` 今後のイベント観測開始（既存データを消去）\n' +
        '`!w2 stop` 観測停止\n' +
        '`!w2 status` 状態確認\n' +
        '`!w2 inspect` 記録の概要\n' +
        '`!w2 export` JSONを書き出す\n' +
        '`!w2 clear` データ消去'
      );
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Wordle observer ready as ${readyClient.user.tag}`);
  console.log(`Persistent capture path: ${store.jsonlPath}`);
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));
client.on(Events.Warn, (warning) => console.warn('Discord warning:', warning));

const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, discordReady: client.isReady(), watching: Boolean(watch), records: store.records.length }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Wordle Round 2 Observer is running.');
}).listen(port, '0.0.0.0', () => {
  console.log(`Health server listening on ${port}`);
});

await client.login(token);
