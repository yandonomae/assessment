import http from 'node:http';

const publicPort = Number(process.env.PORT || 3000);
const backendPort = publicPort === 18081 ? 18082 : publicPort + 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
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

// The core game server stays isolated on an internal port. This public entry point
// normalizes Discord Activity proxy paths and keeps a lightweight mirror for the
// live opponent-status panel. Game truth still lives in activity-server.js.
process.env.PORT = String(backendPort);
await import('./activity-server.js');

const mirrors = new Map();

function normalizePath(rawUrl = '/') {
  const url = new URL(rawUrl, 'http://activity.local');
  if (url.pathname === '/token') url.pathname = '/api/token';
  else if (url.pathname === '/activity' || url.pathname.startsWith('/activity/')) {
    url.pathname = `/api${url.pathname}`;
  }
  return `${url.pathname}${url.search}`;
}

function roomMirror(instanceId) {
  if (!mirrors.has(instanceId)) {
    mirrors.set(instanceId, {
      instanceId,
      phase: 'lobby',
      answer: null,
      players: new Map(),
      publicPlayers: [],
      presence: new Map(),
      updatedAt: Date.now()
    });
  }
  return mirrors.get(instanceId);
}

function presetForAnswer(answer) {
  return CPU_PRESETS.find((preset) => preset.answer === answer) || null;
}

function scoreGuess(guess, answer) {
  const g = String(guess || '').toUpperCase();
  const a = String(answer || '').toUpperCase();
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

function cpuDetail(answer, publicPlayer) {
  const preset = presetForAnswer(answer);
  const guesses = preset
    ? preset.guesses.slice(0, 6).map((word) => ({ word, pattern: scoreGuess(word, preset.answer) }))
    : [];
  return {
    id: 'cpu',
    name: publicPlayer?.name || 'RE:BOT',
    avatar: publicPlayer?.avatar || null,
    cpu: true,
    round1: { guesses, done: true, won: Boolean(preset) },
    round2: { target: null, attempts: null, done: true, rows: [] }
  };
}

function updateMirror(payload) {
  if (!payload?.instanceId || !payload?.me?.id) return null;
  const mirror = roomMirror(payload.instanceId);
  mirror.phase = payload.phase || mirror.phase;
  mirror.answer = payload.answer || mirror.answer;
  mirror.publicPlayers = Array.isArray(payload.players) ? payload.players : mirror.publicPlayers;
  mirror.updatedAt = Date.now();

  const publicSelf = mirror.publicPlayers.find((p) => p.id === payload.me.id) || {};
  mirror.players.set(payload.me.id, {
    ...publicSelf,
    id: payload.me.id,
    name: payload.me.name || publicSelf.name || 'Player',
    avatar: payload.me.avatar ?? publicSelf.avatar ?? null,
    cpu: Boolean(publicSelf.cpu),
    round1: payload.me.round1,
    round2: payload.me.round2 || null
  });

  const cpu = mirror.publicPlayers.find((p) => p.cpu || p.id === 'cpu');
  if (cpu && mirror.answer) mirror.players.set(cpu.id, cpuDetail(mirror.answer, cpu));
  return mirror;
}

function targetWords(mirror, targetId) {
  const target = mirror?.players.get(targetId);
  const guesses = target?.round1?.guesses;
  if (!Array.isArray(guesses)) return [];
  return guesses.map((guess) => guess?.word).filter((word) => /^[A-Z]{5}$/.test(String(word || '')));
}

function unusedLetters(words) {
  if (!words.length) return [];
  const used = new Set(words.join('').toUpperCase());
  return [...ALPHABET].filter((letter) => !used.has(letter));
}

function sanitizedPresence(body) {
  const flagsByRow = {};
  if (body?.flagsByRow && typeof body.flagsByRow === 'object') {
    for (const [row, flags] of Object.entries(body.flagsByRow)) {
      if (!/^\d+$/.test(row) || !flags || typeof flags !== 'object') continue;
      const clean = {};
      for (const [letter, status] of Object.entries(flags)) {
        const upper = String(letter).toUpperCase();
        if (/^[A-Z]$/.test(upper) && ['y', 'g', 'x'].includes(status)) clean[upper] = status;
      }
      flagsByRow[row] = clean;
    }
  }
  return {
    input: String(body?.input || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5),
    activeRow: Math.max(0, Math.min(5, Number(body?.activeRow) || 0)),
    mode: body?.mode === 'flag' ? 'flag' : 'input',
    flagsByRow,
    updatedAt: Date.now()
  };
}

function livePlayers(mirror) {
  return (mirror.publicPlayers || []).map((publicPlayer) => {
    const detail = mirror.players.get(publicPlayer.id) || {
      ...publicPlayer,
      round1: { guesses: [], done: publicPlayer.round1?.done || false, won: publicPlayer.round1?.won ?? null },
      round2: null
    };
    return {
      ...detail,
      phase: mirror.phase,
      presence: mirror.presence.get(publicPlayer.id) || null,
      synced: mirror.players.has(publicPlayer.id)
    };
  });
}

function enrichPayload(payload) {
  const mirror = updateMirror(payload);
  if (!mirror) return payload;

  if (payload.me?.round2?.target?.id) {
    const words = targetWords(mirror, payload.me.round2.target.id);
    payload.me.round2.globalAbsentLetters = unusedLetters(words);
  }
  payload.livePlayers = livePlayers(mirror);
  return payload;
}

async function readBody(req, maxBytes = 128_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

const proxy = http.createServer(async (req, res) => {
  try {
    const incoming = req.url || '/';
    const mappedPath = normalizePath(incoming);
    const mappedUrl = new URL(mappedPath, 'http://activity.local');
    const requestBody = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : Buffer.alloc(0);
    console.log(`[activity-proxy] -> ${req.method} ${incoming} host=${req.headers.host || '-'} mapped=${mappedPath}`);

    if (req.method === 'POST' && mappedUrl.pathname === '/api/activity/presence') {
      let body = {};
      try { body = JSON.parse(requestBody.toString('utf8') || '{}'); } catch {}
      if (body.instanceId && body.playerId) {
        const mirror = roomMirror(String(body.instanceId));
        mirror.presence.set(String(body.playerId), sanitizedPresence(body));
        mirror.updatedAt = Date.now();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const headers = { ...req.headers, host: `127.0.0.1:${backendPort}`, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': 'https' };
    if (requestBody.length) headers['content-length'] = requestBody.length;

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: mappedPath,
      headers
    }, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks);
        const responseHeaders = { ...upstreamRes.headers };
        const contentType = String(responseHeaders['content-type'] || '');

        if (contentType.includes('application/json') && body.length) {
          try {
            const payload = JSON.parse(body.toString('utf8'));
            if (payload?.instanceId && payload?.me) {
              body = Buffer.from(JSON.stringify(enrichPayload(payload)), 'utf8');
              delete responseHeaders['content-length'];
              responseHeaders['content-length'] = body.length;
              responseHeaders['cache-control'] = 'no-store';
            }
          } catch {}
        }

        console.log(`[activity-proxy] <- ${upstreamRes.statusCode || 0} ${req.method} ${incoming} mapped=${mappedPath}`);
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        res.end(body);
      });
    });

    upstream.on('error', (error) => {
      console.error(`[activity-proxy] upstream error ${req.method} ${incoming}:`, error?.message || error);
      if (!res.headersSent) sendJson(res, 502, { error: 'Activity backend unavailable' });
    });

    if (requestBody.length) upstream.end(requestBody);
    else upstream.end();
  } catch (error) {
    console.error('[activity-proxy] request error:', error?.message || error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Activity proxy failed' });
  }
});

proxy.listen(publicPort, '0.0.0.0', () => {
  console.log(`[activity-proxy] listening on ${publicPort}; backend=${backendPort}; live-spectator=on`);
});

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [instanceId, mirror] of mirrors) {
    if (mirror.updatedAt < cutoff) mirrors.delete(instanceId);
  }
}, 15 * 60_000).unref();
