import http from 'node:http';

const publicPort = Number(process.env.PORT || 3000);
const backendPort = publicPort === 18081 ? 18082 : publicPort + 1;

// The Discord Activity URL proxy treats a mapping prefix like a virtual mount.
// Depending on the mapping target, `/api/token` may reach the origin as either
// `/api/token` or `/token`. Run the real Activity server on an internal port and
// normalize both forms here so the backend is robust to either mapping style.
process.env.PORT = String(backendPort);
await import('./activity-server.js');

function normalizePath(rawUrl = '/') {
  const url = new URL(rawUrl, 'http://activity.local');
  if (url.pathname === '/token') url.pathname = '/api/token';
  else if (url.pathname === '/activity' || url.pathname.startsWith('/activity/')) {
    url.pathname = `/api${url.pathname}`;
  }
  return `${url.pathname}${url.search}`;
}

const proxy = http.createServer((req, res) => {
  const incoming = req.url || '/';
  const mappedPath = normalizePath(incoming);
  console.log(`[activity-proxy] -> ${req.method} ${incoming} host=${req.headers.host || '-'} mapped=${mappedPath}`);

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: backendPort,
    method: req.method,
    path: mappedPath,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${backendPort}`,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': 'https'
    }
  }, (upstreamRes) => {
    console.log(`[activity-proxy] <- ${upstreamRes.statusCode || 0} ${req.method} ${incoming} mapped=${mappedPath}`);
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    console.error(`[activity-proxy] upstream error ${req.method} ${incoming}:`, error?.message || error);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Activity backend unavailable' }));
  });

  req.pipe(upstream);
});

proxy.listen(publicPort, '0.0.0.0', () => {
  console.log(`[activity-proxy] listening on ${publicPort}; backend=${backendPort}`);
});
