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

// Keep the core game server isolated on an internal port. This public entry point
// only normalizes Discord proxy paths and adds the lightweight Round 2 exclusion hint.
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
      answer: null,
      players: new Map(),
      publicPlayers: [],
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

function cpuDetail(answer) {
  const preset = presetForAnswer(answer);
  if (!preset) return null;
  return {
    id: 'cpu',
    round1: {
      guesses: preset.guesses.slice(0, 6).map((word) => ({
        word,
        pattern: scoreGuess(word, preset.answer)
      }))
    }
  };
}

function updateMirror(payload) {
  if (!payload?.instanceId || !payload?.me?.id) return null;
  const mirror = roomMirror(payload.instanceId);
  mirror.answer = payload.answer || mirror.answer;
  mirror.publicPlayers = Array.isArray(payload.players) ? payload.players : mirror.publicPlayers;
  mirror.updatedAt = Date.now();

  mirror.players.set(payload.me.id, {
    id: payload.me.id,
    round1: payload.me.round1
  });

  if (mirror.answer && mirror.publicPlayers.some((p) => p.cpu || p.id === 'cpu')) {
    const cpu = cpuDetail(mirror.answer);
    if (cpu) mirror.players.set('cpu', cpu);
  }

  return mirror;
}

function targetWords(mirror, targetId) {
  const guesses = mirror?.players.get(targetId)?.round1?.guesses;
  if (!Array.isArray(guesses)) return [];
  return guesses
    .map((guess) => String(guess?.word || '').toUpperCase())
    .filter((word) => /^[A-Z]{5}$/.test(word));
}

function unusedLetters(words) {
  if (!words.length) return [];
  const used = new Set(words.join(''));
  return [...ALPHABET].filter((letter) => !used.has(letter));
}

function enrichPayload(payload) {
  const mirror = updateMirror(payload);
  if (!mirror) return payload;
  const targetId = payload.me?.round2?.target?.id;
  if (targetId) {
    payload.me.round2.globalAbsentLetters = unusedLetters(targetWords(mirror, targetId));
  }
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
    const requestBody = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : Buffer.alloc(0);
    console.log(`[activity-proxy] -> ${req.method} ${incoming} host=${req.headers.host || '-'} mapped=${mappedPath}`);

    const headers = {
      ...req.headers,
      host: `127.0.0.1:${backendPort}`,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': 'https'
    };
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
  console.log(`[activity-proxy] listening on ${publicPort}; backend=${backendPort}; round2-exclusions=on`);
});

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [instanceId, mirror] of mirrors) {
    if (mirror.updatedAt < cutoff) mirrors.delete(instanceId);
  }
}, 15 * 60_000).unref();
