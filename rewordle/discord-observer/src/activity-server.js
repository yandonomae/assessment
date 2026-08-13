import 'dotenv/config';
import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const clientId = process.env.DISCORD_CLIENT_ID?.trim() || '';
const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim() || '';
const botToken = process.env.DISCORD_TOKEN?.trim() || '';
const skipInstanceVerify = process.env.ACTIVITY_SKIP_INSTANCE_VERIFY === 'true';

const ANSWERS = [
  'PLANT','LIGHT','BEACH','TRAIN','HOUSE','WATER','BLACK','SMILE','ROUND','STONE',
  'CRANE','SHARE','CLOUD','BRAVE','POINT','GRACE','FRAME','MOUSE','SOUND','DREAM',
  'SWEET','BRICK','CHAIR','WORLD','FLAME','GREEN','BREAD','HEART','NIGHT','RIVER',
  'SCORE','PAINT','BRAIN','SPACE','STORM','GLASS','FRUIT','METAL','WATCH','TOUCH'
];

const CPU_PRESETS = [
  { answer: 'PLANT', guesses: ['CRANE','BLAST','PLANK','PLANT'] },
  { answer: 'LIGHT', guesses: ['CRANE','SOUTH','NIGHT','MIGHT','LIGHT'] },
  { answer: 'BEACH', guesses: ['STARE','REACH','TEACH','PEACH','BEACH'] },
  { answer: 'TRAIN', guesses: ['HOUSE','GRAIN','DRAIN','BRAIN','TRAIN'] },
  { answer: 'HOUSE', guesses: ['CRANE','MOUSE','LOUSE','ROUSE','HOUSE'] },
  { answer: 'WATER', guesses: ['SLING','CATER','LATER','HATER','WATER'] },
  { answer: 'BLACK', guesses: ['CRANE','BLAST','BLANK','BLACK'] },
  { answer: 'SMILE', guesses: ['CRANE','SPIKE','SHINE','SLIME','SMILE'] },
  { answer: 'ROUND', guesses: ['SLATE','MOUND','FOUND','BOUND','ROUND'] },
  { answer: 'STONE', guesses: ['CRAMP','SHINE','STORE','STOKE','STONE'] }
];

const FALLBACK_WORDS = new Set([
  ...ANSWERS,
  ...CPU_PRESETS.flatMap((p) => p.guesses),
  'STARE','SLATE','SOUTH','GRAIN','DRAIN','SPIKE','SHINE','MOUND','FOUND','BOUND',
  'CATER','LATER','HATER','BLAST','BLANK','PLANK','PEACH','TEACH','REACH','MIGHT'
]);

let dictionary = null;
let dictionaryPromise = null;
const rooms = new Map();
const authCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function scoreGuess(guess, answer) {
  const g = guess.toUpperCase();
  const a = answer.toUpperCase();
  const result = Array(5).fill('x');
  const remaining = new Map();

  for (let i = 0; i < 5; i += 1) {
    if (g[i] === a[i]) result[i] = 'g';
    else remaining.set(a[i], (remaining.get(a[i]) || 0) + 1);
  }
  for (let i = 0; i < 5; i += 1) {
    if (result[i] === 'g') continue;
    const count = remaining.get(g[i]) || 0;
    if (count > 0) {
      result[i] = 'y';
      remaining.set(g[i], count - 1);
    }
  }
  return result;
}

async function loadDictionary() {
  if (dictionary) return dictionary;
  if (dictionaryPromise) return dictionaryPromise;

  dictionaryPromise = (async () => {
    try {
      const response = await fetch('https://raw.githubusercontent.com/tabatkins/wordle-list/main/words', {
        headers: { 'user-agent': 'REWORDLE-Activity/0.1' },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const words = new Set(text.split(/\s+/).map((w) => w.trim().toUpperCase()).filter((w) => /^[A-Z]{5}$/.test(w)));
      for (const word of FALLBACK_WORDS) words.add(word);
      dictionary = words;
      console.log(`[activity] dictionary loaded: ${words.size} words`);
      return words;
    } catch (error) {
      console.warn(`[activity] dictionary fetch failed, using fallback: ${error?.message ?? error}`);
      dictionary = new Set(FALLBACK_WORDS);
      return dictionary;
    }
  })();

  return dictionaryPromise;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

async function readJson(req, maxBytes = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function bearerToken(req) {
  const value = req.headers.authorization || '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function currentUser(req) {
  const accessToken = bearerToken(req);
  if (!accessToken) throw Object.assign(new Error('Missing bearer token'), { statusCode: 401 });

  const cached = authCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Object.assign(new Error('Discord authentication failed'), { statusCode: 401 });
  const user = await response.json();
  authCache.set(accessToken, { user, expiresAt: Date.now() + 5 * 60_000 });
  return user;
}

async function verifyActivityInstance(instanceId, userId) {
  if (skipInstanceVerify) return;
  if (!clientId || !botToken) {
    console.warn('[activity] instance verification skipped because DISCORD_CLIENT_ID or DISCORD_TOKEN is missing');
    return;
  }

  const response = await fetch(`https://discord.com/api/v10/applications/${clientId}/activity-instances/${encodeURIComponent(instanceId)}`, {
    headers: { Authorization: `Bot ${botToken}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Object.assign(new Error('Activity instance is not active'), { statusCode: 403 });
  const instance = await response.json();
  if (Array.isArray(instance.users) && !instance.users.includes(userId)) {
    throw Object.assign(new Error('User is not connected to this Activity instance'), { statusCode: 403 });
  }
}

function displayName(user) {
  return user.global_name || user.username || 'Player';
}

function avatarUrl(user) {
  if (!user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

function newPlayer(user) {
  return {
    id: user.id,
    name: displayName(user),
    avatar: avatarUrl(user),
    cpu: false,
    joinedAt: nowIso(),
    round1: { guesses: [], done: false, won: false },
    round2: { targetId: null, attempts: 0, rows: {}, done: false }
  };
}

function cpuPlayer(preset) {
  return {
    id: 'cpu',
    name: 'RE:BOT',
    avatar: null,
    cpu: true,
    joinedAt: nowIso(),
    round1: {
      guesses: preset.guesses.slice(0, 6).map((word) => ({ word, pattern: scoreGuess(word, preset.answer) })),
      done: true,
      won: preset.guesses.includes(preset.answer)
    },
    round2: { targetId: null, attempts: 0, rows: {}, done: true }
  };
}

function makeRoom(instanceId, hostUser) {
  const room = {
    instanceId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    hostId: hostUser.id,
    phase: 'lobby',
    answer: null,
    players: new Map([[hostUser.id, newPlayer(hostUser)]])
  };
  rooms.set(instanceId, room);
  return room;
}

function touch(room) {
  room.updatedAt = nowIso();
}

function realPlayers(room) {
  return [...room.players.values()].filter((p) => !p.cpu);
}

function chooseAnswer(room) {
  const reals = realPlayers(room);
  if (reals.length === 1) {
    const preset = CPU_PRESETS[Math.floor(Math.random() * CPU_PRESETS.length)];
    room.answer = preset.answer;
    room.players.set('cpu', cpuPlayer(preset));
  } else {
    room.answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  }
}

function beginRound2(room) {
  const players = [...room.players.values()];
  if (players.length < 2) return;

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    const target = players[(i + 1) % players.length];
    player.round2 = { targetId: target.id, attempts: 0, rows: {}, done: player.cpu };

    for (let rowIndex = 0; rowIndex < target.round1.guesses.length; rowIndex += 1) {
      const targetGuess = target.round1.guesses[rowIndex];
      const autoSolved = targetGuess.word === room.answer;
      player.round2.rows[rowIndex] = {
        solved: autoSolved,
        tries: []
      };
    }

    if (!player.cpu) {
      player.round2.done = Object.values(player.round2.rows).every((row) => row.solved);
    }
  }

  room.phase = realPlayers(room).every((p) => p.round2.done) ? 'finished' : 'round2';
  touch(room);
}

function maybeAdvanceFromRound1(room) {
  const everyoneDone = [...room.players.values()].every((p) => p.round1.done);
  if (everyoneDone) beginRound2(room);
}

function maybeFinish(room) {
  if (room.phase === 'round2' && realPlayers(room).every((p) => p.round2.done)) {
    room.phase = 'finished';
    touch(room);
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    cpu: p.cpu,
    round1: {
      guesses: p.round1.guesses.length,
      done: p.round1.done,
      won: p.round1.done ? p.round1.won : null
    },
    round2: {
      attempts: p.cpu ? null : p.round2.attempts,
      done: p.cpu ? null : p.round2.done
    }
  }));
}

function playerView(room, userId) {
  const me = room.players.get(userId);
  if (!me) return null;

  const view = {
    instanceId: room.instanceId,
    phase: room.phase,
    hostId: room.hostId,
    isHost: room.hostId === userId,
    players: publicPlayers(room),
    me: {
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      round1: {
        guesses: me.round1.guesses,
        done: me.round1.done,
        won: me.round1.done ? me.round1.won : null
      }
    }
  };

  if (room.phase === 'round2' || room.phase === 'finished') {
    view.answer = room.answer;
    const target = room.players.get(me.round2.targetId);
    const rows = target
      ? target.round1.guesses.map((guess, index) => {
          const ownRow = me.round2.rows[index] || { solved: false, tries: [] };
          return {
            index,
            pattern: guess.pattern,
            solved: ownRow.solved,
            revealedWord: ownRow.solved ? guess.word : null,
            tries: ownRow.tries
          };
        })
      : [];

    view.me.round2 = {
      target: target ? { id: target.id, name: target.name, avatar: target.avatar, cpu: target.cpu } : null,
      attempts: me.round2.attempts,
      done: me.round2.done,
      rows
    };
  }

  if (room.phase === 'finished') {
    view.leaderboard = realPlayers(room)
      .map((p) => ({ id: p.id, name: p.name, attempts: p.round2.attempts, round1Guesses: p.round1.guesses.length, wonRound1: p.round1.won }))
      .sort((a, b) => a.attempts - b.attempts || a.round1Guesses - b.round1Guesses);
  }

  return view;
}

function requireRoom(instanceId) {
  const room = rooms.get(instanceId);
  if (!room) throw Object.assign(new Error('Room not found. Rejoin the Activity.'), { statusCode: 404 });
  return room;
}

async function requirePlayer(req, instanceId) {
  const user = await currentUser(req);
  await verifyActivityInstance(instanceId, user.id);
  const room = requireRoom(instanceId);
  const player = room.players.get(user.id);
  if (!player) throw Object.assign(new Error('Join the room first'), { statusCode: 403 });
  return { user, room, player };
}

async function exchangeToken(code) {
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('Discord OAuth is not configured on the server'), { statusCode: 503 });
  }
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code
    }),
    signal: AbortSignal.timeout(10000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    console.error('[activity] token exchange failed', response.status, payload);
    throw Object.assign(new Error('Discord OAuth token exchange failed'), { statusCode: 502 });
  }
  return payload;
}

async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return true;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    sendJson(res, 200, {
      ok: true,
      service: 'rewordle-activity-server',
      rooms: rooms.size,
      oauthConfigured: Boolean(clientId && clientSecret),
      instanceVerificationConfigured: Boolean(skipInstanceVerify || (clientId && botToken)),
      dictionaryWords: dictionary?.size ?? null
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/token') {
    const { code } = await readJson(req);
    if (!code || typeof code !== 'string') throw Object.assign(new Error('Missing authorization code'), { statusCode: 400 });
    const token = await exchangeToken(code);
    sendJson(res, 200, { access_token: token.access_token, expires_in: token.expires_in, scope: token.scope });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/activity/join') {
    const { instanceId } = await readJson(req);
    if (!instanceId || typeof instanceId !== 'string') throw Object.assign(new Error('Missing instanceId'), { statusCode: 400 });
    const user = await currentUser(req);
    await verifyActivityInstance(instanceId, user.id);

    let room = rooms.get(instanceId);
    if (!room) room = makeRoom(instanceId, user);
    else if (!room.players.has(user.id)) {
      if (room.phase !== 'lobby') throw Object.assign(new Error('This game has already started'), { statusCode: 409 });
      room.players.set(user.id, newPlayer(user));
      touch(room);
    } else {
      const player = room.players.get(user.id);
      player.name = displayName(user);
      player.avatar = avatarUrl(user);
      touch(room);
    }

    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/activity/state') {
    const instanceId = url.searchParams.get('instanceId');
    if (!instanceId) throw Object.assign(new Error('Missing instanceId'), { statusCode: 400 });
    const { user, room } = await requirePlayer(req, instanceId);
    touch(room);
    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/activity/start') {
    const { instanceId } = await readJson(req);
    const { user, room } = await requirePlayer(req, instanceId);
    if (room.hostId !== user.id) throw Object.assign(new Error('Only the host can start the game'), { statusCode: 403 });
    if (room.phase !== 'lobby') throw Object.assign(new Error('Game already started'), { statusCode: 409 });

    chooseAnswer(room);
    room.phase = 'round1';
    touch(room);
    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/activity/round1/guess') {
    const { instanceId, word } = await readJson(req);
    const { user, room, player } = await requirePlayer(req, instanceId);
    if (room.phase !== 'round1') throw Object.assign(new Error('Round 1 is not active'), { statusCode: 409 });
    if (player.round1.done) throw Object.assign(new Error('You already finished Round 1'), { statusCode: 409 });

    const normalized = String(word || '').trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(normalized)) throw Object.assign(new Error('Enter a five-letter word'), { statusCode: 400 });
    const words = await loadDictionary();
    if (!words.has(normalized)) throw Object.assign(new Error('Dictionary does not contain that word'), { statusCode: 422 });

    const pattern = scoreGuess(normalized, room.answer);
    player.round1.guesses.push({ word: normalized, pattern });
    if (normalized === room.answer) {
      player.round1.done = true;
      player.round1.won = true;
    } else if (player.round1.guesses.length >= 6) {
      player.round1.done = true;
      player.round1.won = false;
    }
    touch(room);
    maybeAdvanceFromRound1(room);
    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/activity/round2/guess') {
    const { instanceId, rowIndex, word } = await readJson(req);
    const { user, room, player } = await requirePlayer(req, instanceId);
    if (room.phase !== 'round2') throw Object.assign(new Error('Round 2 is not active'), { statusCode: 409 });
    if (player.round2.done) throw Object.assign(new Error('You already finished Round 2'), { statusCode: 409 });

    const target = room.players.get(player.round2.targetId);
    if (!target) throw Object.assign(new Error('Round 2 target is missing'), { statusCode: 500 });
    const index = Number(rowIndex);
    const targetGuess = target.round1.guesses[index];
    const row = player.round2.rows[index];
    if (!Number.isInteger(index) || !targetGuess || !row) throw Object.assign(new Error('Invalid row'), { statusCode: 400 });
    if (row.solved) throw Object.assign(new Error('That row is already solved'), { statusCode: 409 });

    const normalized = String(word || '').trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(normalized)) throw Object.assign(new Error('Enter a five-letter word'), { statusCode: 400 });
    const words = await loadDictionary();
    if (!words.has(normalized)) throw Object.assign(new Error('Dictionary does not contain that word'), { statusCode: 422 });

    const pattern = scoreGuess(normalized, targetGuess.word);
    row.tries.push({ word: normalized, pattern });
    player.round2.attempts += 1;
    if (normalized === targetGuess.word) row.solved = true;
    player.round2.done = Object.values(player.round2.rows).every((candidate) => candidate.solved);
    touch(room);
    maybeFinish(room);
    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/activity/reset') {
    const { instanceId } = await readJson(req);
    const { user, room } = await requirePlayer(req, instanceId);
    if (room.hostId !== user.id) throw Object.assign(new Error('Only the host can reset the game'), { statusCode: 403 });

    room.phase = 'lobby';
    room.answer = null;
    room.players.delete('cpu');
    for (const p of realPlayers(room)) {
      p.round1 = { guesses: [], done: false, won: false };
      p.round2 = { targetId: null, attempts: 0, rows: {}, done: false };
    }
    touch(room);
    sendJson(res, 200, playerView(room, user.id));
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const handled = await handleApi(req, res);
    if (handled) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('[activity] request failed:', error);
    sendJson(res, status, { error: error?.message || 'Internal server error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[activity] RE:WORDLE Activity backend listening on ${port}`);
  console.log(`[activity] OAuth configured=${Boolean(clientId && clientSecret)} instanceVerify=${Boolean(skipInstanceVerify || (clientId && botToken))}`);
  void loadDictionary();
});

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [instanceId, room] of rooms) {
    if (Date.parse(room.updatedAt) < cutoff) rooms.delete(instanceId);
  }
  for (const [token, cached] of authCache) {
    if (cached.expiresAt < Date.now()) authCache.delete(token);
  }
}, 15 * 60_000).unref();
