const nativeFetch = window.fetch.bind(window);

let latestState = null;
let authHeader = '';
let watchedPlayerId = null;
let presenceTimer = null;
let watchPollTimer = null;
let lastPresenceSignature = '';
const rememberedFlags = {};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  return input?.url || String(input || '');
}

function captureAuthorization(input, init) {
  try {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const value = headers.get('authorization');
    if (value) authHeader = value;
  } catch {}
}

function rememberState(payload) {
  if (!payload?.instanceId || !payload?.me?.id) return;
  latestState = payload;
  queueMicrotask(() => {
    applyEnhancements();
    renderWatch();
    schedulePresenceSync();
  });
}

window.fetch = async (input, init = {}) => {
  captureAuthorization(input, init);
  const response = await nativeFetch(input, init);
  const url = requestUrl(input);
  if (url.includes('/api/activity/') && !url.includes('/presence')) {
    response.clone().json().then(rememberState).catch(() => {});
  }
  return response;
};

function statusClass(status) {
  return status === 'g' ? 'correct' : status === 'y' ? 'present' : status === 'x' ? 'absent' : '';
}

function tile(letter = '', status = '') {
  return `<span class="watch-tile ${statusClass(status)}">${esc(letter)}</span>`;
}

function patternEmoji(pattern = []) {
  return pattern.map((status) => status === 'g' ? '🟩' : status === 'y' ? '🟨' : '⬛').join('');
}

function watchedPlayer() {
  return latestState?.livePlayers?.find((player) => player.id === watchedPlayerId) || null;
}

function round1Board(player) {
  const guesses = Array.isArray(player?.round1?.guesses) ? player.round1.guesses : [];
  const presence = player?.presence;
  const typing = player?.phase === 'round1' && !player?.round1?.done ? String(presence?.input || '') : '';
  const rows = [];

  for (let rowIndex = 0; rowIndex < 6; rowIndex += 1) {
    const guess = guesses[rowIndex];
    const preview = !guess && rowIndex === guesses.length ? typing : '';
    rows.push(`<div class="watch-word-row ${preview ? 'typing' : ''}">${Array.from({ length: 5 }, (_, col) => {
      const letter = guess?.word?.[col] || preview?.[col] || '';
      return tile(letter, guess?.pattern?.[col] || '');
    }).join('')}</div>`);
  }

  return `<div class="watch-board">${rows.join('')}</div>`;
}

function flagSummary(player, rowIndex) {
  const flags = player?.presence?.flagsByRow?.[String(rowIndex)] || {};
  const entries = Object.entries(flags);
  if (!entries.length) return '';
  return `<div class="watch-flags">${entries.map(([letter, status]) => `<span class="watch-flag flag-${esc(status)}">${esc(letter)}</span>`).join('')}</div>`;
}

function round2Detail(player) {
  const r2 = player?.round2;
  if (!r2) return '<p class="watch-muted">Round 2 はまだ始まっていません。</p>';
  const rows = Array.isArray(r2.rows) ? r2.rows : [];
  const activeRow = Number(player?.presence?.activeRow || 0);
  const typing = String(player?.presence?.input || '');
  const mode = player?.presence?.mode === 'flag' ? 'FLAG' : 'INPUT';

  return `
    <div class="watch-r2-head">
      <span>対象: <b>${esc(r2.target?.name || '—')}</b></span>
      <span><b>${r2.attempts ?? 0}</b> MOVES</span>
    </div>
    <div class="watch-r2-rows">
      ${rows.map((row, index) => `
        <section class="watch-r2-row ${index === activeRow ? 'active' : ''} ${row.solved ? 'solved' : ''}">
          <div class="watch-r2-title"><b>ROW ${index + 1}</b><span>${row.solved ? 'SOLVED' : `${row.tries?.length || 0} tries`}</span></div>
          <div class="watch-word-row">${(row.pattern || []).map((status, col) => tile(row.revealedWord?.[col] || '', status)).join('')}</div>
          ${index === activeRow && !row.solved ? `<div class="watch-now"><span>${mode}</span><b>${esc(typing || '·····')}</b></div>${flagSummary(player, index)}` : ''}
          ${(row.tries || []).length ? `<div class="watch-tries">${row.tries.map((trial) => `<div><b>${esc(trial.word)}</b><span>${patternEmoji(trial.pattern)}</span></div>`).join('')}</div>` : ''}
        </section>`).join('')}
    </div>`;
}

function renderWatch() {
  let overlay = document.querySelector('#live-watch-overlay');
  if (!watchedPlayerId) {
    overlay?.remove();
    stopWatchPolling();
    return;
  }

  const player = watchedPlayer();
  if (!player) return;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'live-watch-overlay';
    document.body.append(overlay);
  }

  overlay.innerHTML = `
    <div class="watch-backdrop" data-watch-close>
      <section class="watch-modal" role="dialog" aria-modal="true" aria-label="${esc(player.name)} のライブ状況">
        <button class="watch-close" type="button" data-watch-close aria-label="閉じる">×</button>
        <header class="watch-header">
          ${player.avatar ? `<img class="watch-avatar" src="${esc(player.avatar)}" alt="" />` : `<span class="watch-avatar fallback">${esc(String(player.name || '?').slice(0, 2))}</span>`}
          <div><div class="watch-live">● LIVE</div><h2>${esc(player.name)}</h2><p>${player.synced ? '相手の画面状態をリアルタイム表示' : '相手の同期を待っています…'}</p></div>
        </header>
        <div class="watch-section-title"><span>ROUND 1</span><b>${Array.isArray(player.round1?.guesses) ? player.round1.guesses.length : 0}/6</b></div>
        ${round1Board(player)}
        ${player.phase === 'round2' || player.phase === 'finished' ? `<div class="watch-section-title"><span>ROUND 2</span><b>${player.round2?.done ? 'DONE' : 'PLAYING'}</b></div>${round2Detail(player)}` : ''}
      </section>
    </div>`;

  overlay.querySelectorAll('[data-watch-close]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (element.classList.contains('watch-backdrop') && event.target !== element) return;
      watchedPlayerId = null;
      renderWatch();
    });
  });
  startWatchPolling();
}

function bindParticipants() {
  const players = latestState?.players || [];
  document.querySelectorAll('.participant').forEach((element, index) => {
    const player = players[index];
    if (!player || element.dataset.watchBound === player.id) return;
    element.dataset.watchBound = player.id;
    element.dataset.watchPlayer = player.id;
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('title', `${player.name} のライブ状況を見る`);
    const open = () => {
      watchedPlayerId = player.id;
      renderWatch();
    };
    element.addEventListener('click', open);
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

function globalAbsentLetters() {
  return new Set(latestState?.me?.round2?.globalAbsentLetters || []);
}

function paintGlobalAbsent() {
  if (latestState?.phase !== 'round2' && latestState?.phase !== 'finished') return;
  const absent = globalAbsentLetters();
  document.querySelectorAll('.keyboard[data-round2="1"] [data-key]').forEach((key) => {
    if (absent.has(key.dataset.key)) {
      key.classList.add('absent', 'global-absent');
      key.title = '相手がRound 1の全行で一度も使っていない文字';
    }
  });
}

function activeRowFromDom() {
  const rows = [...document.querySelectorAll('.reconstruct-line')];
  const index = rows.findIndex((row) => row.classList.contains('active'));
  return index >= 0 ? index : 0;
}

function flagsFromDom() {
  const result = {};
  document.querySelectorAll('.keyboard[data-round2="1"] [data-key]').forEach((key) => {
    if (key.classList.contains('flag-y')) result[key.dataset.key] = 'y';
    else if (key.classList.contains('flag-g')) result[key.dataset.key] = 'g';
    else if (key.classList.contains('flag-x')) result[key.dataset.key] = 'x';
  });
  return result;
}

function currentInputFromDom() {
  if (latestState?.phase !== 'round1' && latestState?.phase !== 'round2') return '';
  const chars = [...document.querySelectorAll('.current-input span')].map((span) => span.textContent || '').join('');
  return chars.replace(/[^A-Z]/g, '').slice(0, 5);
}

function currentModeFromDom() {
  return document.querySelector('.mode-mini[data-mode="flag"].active') ? 'flag' : 'input';
}

function schedulePresenceSync() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(syncPresence, 120);
}

async function syncPresence() {
  if (!latestState?.instanceId || !latestState?.me?.id || !authHeader) return;
  const activeRow = activeRowFromDom();
  if (latestState.phase === 'round2') rememberedFlags[String(activeRow)] = flagsFromDom();
  const payload = {
    instanceId: latestState.instanceId,
    playerId: latestState.me.id,
    input: currentInputFromDom(),
    activeRow,
    mode: currentModeFromDom(),
    flagsByRow: rememberedFlags
  };
  const signature = JSON.stringify(payload);
  if (signature === lastPresenceSignature) return;
  lastPresenceSignature = signature;
  try {
    await nativeFetch('/api/activity/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: signature
    });
  } catch {}
}

function applyEnhancements() {
  bindParticipants();
  paintGlobalAbsent();
}

function startWatchPolling() {
  if (watchPollTimer || !latestState?.instanceId || !authHeader) return;
  watchPollTimer = setInterval(async () => {
    if (!watchedPlayerId || !latestState?.instanceId) return;
    try {
      const response = await nativeFetch(`/api/activity/state?instanceId=${encodeURIComponent(latestState.instanceId)}`, {
        headers: { authorization: authHeader }
      });
      if (response.ok) rememberState(await response.json());
    } catch {}
  }, 450);
}

function stopWatchPolling() {
  clearInterval(watchPollTimer);
  watchPollTimer = null;
}

document.addEventListener('click', (event) => {
  const key = event.target.closest('.keyboard[data-round2="1"] [data-key]');
  if (!key) return;
  const flagMode = Boolean(document.querySelector('.mode-mini[data-mode="flag"].active'));
  if (flagMode && globalAbsentLetters().has(key.dataset.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && watchedPlayerId) {
    watchedPlayerId = null;
    renderWatch();
  }
});

const observer = new MutationObserver(() => {
  applyEnhancements();
  schedulePresenceSync();
  if (watchedPlayerId) renderWatch();
});
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
