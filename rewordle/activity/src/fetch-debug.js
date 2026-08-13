const originalFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  const method = String(init?.method || 'GET').toUpperCase();

  try {
    const response = await originalFetch(input, init);
    if (response.ok) return response;

    const body = await response.clone().text().catch(() => '');
    console.error(`[fetch-debug] ${method} ${url} -> HTTP ${response.status}`, body.slice(0, 800));

    // During setup, make proxy/upstream failures self-identifying in the in-Activity error card.
    // Preserve normal 4xx JSON responses so gameplay errors still use the backend's message.
    if (response.status >= 500) {
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json; charset=utf-8');
      const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240);
      return new Response(JSON.stringify({
        error: `FETCH ${method} ${url} -> HTTP ${response.status}${detail ? ` | ${detail}` : ''}`
      }), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return response;
  } catch (error) {
    console.error(`[fetch-debug] ${method} ${url} threw`, error);
    throw new Error(`FETCH ${method} ${url} failed: ${error?.message || error}`);
  }
};
