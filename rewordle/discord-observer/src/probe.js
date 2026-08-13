const ACTIVITY_ORIGIN = 'https://1211781489931452447.discordsays.com';

function uniq(values, limit = 500) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function nearby(text, needle, radius = 220) {
  const results = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  while (results.length < 12) {
    const i = lower.indexOf(target, from);
    if (i < 0) break;
    const start = Math.max(0, i - radius);
    const end = Math.min(text.length, i + target.length + radius);
    results.push(text.slice(start, end).replace(/\s+/g, ' '));
    from = i + target.length;
  }
  return results;
}

function extractAssets(html, baseUrl) {
  const found = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    const raw = match[1];
    if (!raw || raw.startsWith('data:')) continue;
    try {
      const url = new URL(raw, baseUrl).href;
      if (/\.(?:js|mjs)(?:[?#].*)?$/i.test(url)) found.push(url);
    } catch {}
  }
  return uniq(found, 50);
}

function extractSignals(text, sourceUrl) {
  const absoluteUrls = uniq([...text.matchAll(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g)].map(m => m[0].replaceAll('\\/', '/')), 250);
  const websocketUrls = uniq([...text.matchAll(/wss?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g)].map(m => m[0].replaceAll('\\/', '/')), 100);
  const routeStrings = uniq([...text.matchAll(/["'`](\/(?:api|graphql|socket|ws|game|wordle|puzzle|session|guess|daily|state|auth|user|room|instance)[^"'`\s\\]{0,180})["'`]/gi)].map(m => m[1]), 300);
  const sourceMaps = uniq([...text.matchAll(/sourceMappingURL=([^\s*]+)/g)].map(m => {
    try { return new URL(m[1], sourceUrl).href; } catch { return m[1]; }
  }), 30);

  const keywords = [
    'guess', 'guesses', 'answer', 'solution', 'puzzle', 'wordle', 'gameState',
    'localStorage', 'sessionStorage', 'indexedDB', 'WebSocket', 'fetch(', 'graphql',
    'session', 'instance', 'preview.png', 'daily', 'share', 'result'
  ];
  const contexts = {};
  for (const keyword of keywords) {
    const values = nearby(text, keyword);
    if (values.length) contexts[keyword] = values;
  }

  return {
    sourceUrl,
    bytes: Buffer.byteLength(text),
    absoluteUrls,
    websocketUrls,
    routeStrings,
    sourceMaps,
    contexts
  };
}

async function fetchText(url, { timeoutMs = 15000, maxBytes = 12_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 WordleRound2Observer/0.1',
        'accept': 'text/html,application/javascript,text/javascript,*/*'
      }
    });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      return { ok: false, status: response.status, url: response.url, error: `content-length ${contentLength} exceeds limit` };
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      return { ok: false, status: response.status, url: response.url, error: `body exceeds ${maxBytes} bytes` };
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get('content-type'),
      headers: Object.fromEntries([...response.headers.entries()].filter(([k]) => ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified'].includes(k.toLowerCase()))),
      text
    };
  } catch (error) {
    return { ok: false, status: null, url, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeWordleActivity() {
  const startedAt = new Date().toISOString();
  const root = await fetchText(`${ACTIVITY_ORIGIN}/`);
  if (!root.ok || !root.text) {
    return { startedAt, origin: ACTIVITY_ORIGIN, root: { ...root, text: undefined }, error: 'Could not fetch activity root' };
  }

  const assetUrls = extractAssets(root.text, root.url || `${ACTIVITY_ORIGIN}/`);
  const assets = [];
  const combinedSignals = {
    absoluteUrls: [],
    websocketUrls: [],
    routeStrings: [],
    sourceMaps: []
  };

  for (const url of assetUrls.slice(0, 30)) {
    const fetched = await fetchText(url);
    if (!fetched.ok || !fetched.text) {
      assets.push({ url, ok: false, status: fetched.status, error: fetched.error });
      continue;
    }
    const signals = extractSignals(fetched.text, fetched.url || url);
    assets.push({
      url,
      ok: true,
      status: fetched.status,
      contentType: fetched.contentType,
      ...signals
    });
    combinedSignals.absoluteUrls.push(...signals.absoluteUrls);
    combinedSignals.websocketUrls.push(...signals.websocketUrls);
    combinedSignals.routeStrings.push(...signals.routeStrings);
    combinedSignals.sourceMaps.push(...signals.sourceMaps);
  }

  const mapChecks = [];
  for (const mapUrl of uniq(combinedSignals.sourceMaps, 10)) {
    const result = await fetchText(mapUrl, { maxBytes: 1_000_000, timeoutMs: 8000 });
    mapChecks.push({
      url: mapUrl,
      ok: result.ok,
      status: result.status,
      contentType: result.contentType,
      bytes: result.text ? Buffer.byteLength(result.text) : null,
      error: result.error ?? null,
      preview: result.text ? result.text.slice(0, 500) : null
    });
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    origin: ACTIVITY_ORIGIN,
    root: {
      status: root.status,
      finalUrl: root.url,
      contentType: root.contentType,
      headers: root.headers,
      bytes: Buffer.byteLength(root.text),
      htmlPreview: root.text.slice(0, 5000),
      assetUrls
    },
    combined: {
      absoluteUrls: uniq(combinedSignals.absoluteUrls, 500),
      websocketUrls: uniq(combinedSignals.websocketUrls, 200),
      routeStrings: uniq(combinedSignals.routeStrings, 500),
      sourceMaps: uniq(combinedSignals.sourceMaps, 100)
    },
    assets,
    mapChecks
  };
}
