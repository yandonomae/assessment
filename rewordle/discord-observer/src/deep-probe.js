const ORIGIN = 'https://1211781489931452447.discordsays.com';

function nearbyAll(text, needle, radius = 1800, limit = 20) {
  const out = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let pos = 0;
  while (out.length < limit) {
    const i = lower.indexOf(target, pos);
    if (i < 0) break;
    out.push({
      needle,
      index: i,
      snippet: text.slice(Math.max(0, i - radius), Math.min(text.length, i + target.length + radius))
    });
    pos = i + target.length;
  }
  return out;
}

function assetsFromHtml(html, base) {
  const urls = [];
  for (const m of html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)) {
    try { urls.push(new URL(m[1], base).href); } catch {}
  }
  return [...new Set(urls)];
}

async function getText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 WordleRound2Observer/0.3' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return { url: r.url, text: await r.text() };
}

export async function deepProbe() {
  const root = await getText(`${ORIGIN}/`);
  const assets = assetsFromHtml(root.text, root.url);
  const terms = [
    'playerGuesses', 'updatePlayerGuesses', 'function pfe', 'function ffe',
    'persistent_state_id', 'activity_instance_id', 'instance_id',
    '/api/gateway/v1', '/game/ws?app_id=', 'game.discordactivities.com',
    'api.discordactivities.com', 'jwt.original', 'jwt:', 'auth=',
    'getInitialGameProperties', 'gamePropertiesUpdated', 'applyGameState',
    'netSendGameCommandGameAction', 'netSendGameProperties', 'defaultGameState',
    'frameworkStateActionRateLimitMs', 'presenceV2', 'initialize()',
    'authorize(', 'authenticate(', 'access_token', 'GetInstance', '/instances'
  ];

  const result = { startedAt: new Date().toISOString(), origin: ORIGIN, assets: [] };
  for (const assetUrl of assets) {
    const fetched = await getText(assetUrl);
    const matches = {};
    for (const term of terms) {
      const hits = nearbyAll(fetched.text, term);
      if (hits.length) matches[term] = hits;
    }
    result.assets.push({ url: fetched.url, bytes: Buffer.byteLength(fetched.text), matches });
  }
  result.finishedAt = new Date().toISOString();
  return result;
}
