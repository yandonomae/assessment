import { DiscordSDK, Events } from '@discord/embedded-app-sdk';
import './style.css';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '';
const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');
const LETTER_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const STATUS_RANK = { x: 1, y: 2, g: 3 };
const FLAG_CYCLE = [null, 'y', 'g', 'x'];

const local = {
  sdk: null,
  accessToken: null,
  auth: null,
  room: null,
  participants: [],
  activeRow: 0,
  input: '',
  mode: 'input',
  flagsByRow: new Map(),
  busy: false,
  error: null,
  pollTimer: null
};

const app = document.querySelector('#app');

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function patternEmoji(pattern = []) {
  return pattern.map((c) => c === 'g' ? '🟩' : c === 'y' ? '🟨' : '⬛').join('');
}

function tileClass(status) {
  return status === 'g' ? 'correct' : status === 'y' ? 'present' : status === 'x' ? 'absent' : '';
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function avatar(player, size = 'small') {
  if (player?.avatar) return `<img class="avatar ${size}" src="${esc(player.avatar)}" alt="" />`;
  return `<span class="avatar fallback ${size}">${esc(initials(player?.name))}</span>`;
}

function setError(message) {
  local.error = message;
  render();
  window.setTimeout(() => {
    if (local.error === message) {
      local.error = null;
      render();
    }
  }, 2600);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (local.accessToken) headers.Authorization = `Bearer ${local.accessToken}`;

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function mutate(path, payload) {
  if (local.busy) return;
  local.busy = true;
  render();
  try {
    local.room = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    local.input = '';
    chooseUsableActiveRow();
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    local.busy = false;
    render();
  }
}

async function setupDiscord() {
  if (!CLIENT_ID) throw new Error('VITE_DISCORD_CLIENT_ID が未設定です。');

  local.sdk = new DiscordSDK(CLIENT_ID);
  await local.sdk.ready();

  const { code } = await local.sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify']
  });

  const token = await api('/token', {
    method: 'POST',
    body: JSON.stringify({ code })
  });
  local.accessToken = token.access_token;
  local.auth = await local.sdk.commands.authenticate({ access_token: local.accessToken });
  if (!local.auth?.user) throw new Error('Discord authenticate に失敗しました。');

  local.room = await api('/activity/join', {
    method: 'POST',
    body: JSON.stringify({ instanceId: local.sdk.instanceId })
  });

  const connected = await local.sdk.commands.getInstanceConnectedParticipants();
  local.participants = connected?.participants || [];

  const onParticipants = (event) => {
    local.participants = event?.participants || [];
    render();
  };
  await local.sdk.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, onParticipants);

  startPolling();
}

function startPolling() {
  window.clearInterval(local.pollTimer);
  local.pollTimer = window.setInterval(async () => {
    if (!local.sdk?.instanceId || local.busy) return;
    try {
      local.room = await api(`/activity/state?instanceId=${encodeURIComponent(local.sdk.instanceId)}`);
      chooseUsableActiveRow();
      render();
    } catch (error) {
      console.warn('state poll failed', error);
    }
  }, 1200);
}

function chooseUsableActiveRow() {
  const rows = local.room?.me?.round2?.rows;
  if (!rows?.length) return;
  const current = rows[local.activeRow];
  if (current && !current.solved) return;
  const next = rows.findIndex((row) => !row.solved);
  if (next >= 0) local.activeRow = next;
}

function participantBar() {
  const roomPlayers = local.room?.players || [];
  if (!roomPlayers.length) return '';
  return `<div class="participants">${roomPlayers.map((p) => `
    <div class="participant ${p.id === local.auth?.user?.id ? 'me' : ''}">
      ${avatar(p)}
      <span>${esc(p.name)}</span>
      ${p.cpu ? '<b class="cpu-badge">CPU</b>' : ''}
    </div>`).join('')}</div>`;
}

function shell(content) {
  const phase = local.room?.phase || 'connecting';
  const phaseLabel = phase === 'lobby' ? 'LOBBY' : phase === 'round1' ? 'ROUND 1' : phase === 'round2' ? 'ROUND 2' : phase === 'finished' ? 'RESULT' : 'CONNECTING';
  app.innerHTML = `
    <main class="shell">
      <header>
        <div class="brand-row">
          <h1>RE:WORDLE</h1>
          <span class="phase-pill">${phaseLabel}</span>
        </div>
        <p class="subtitle">Solve it. Then reconstruct how your opponent solved it.</p>
        ${participantBar()}
      </header>
      ${content}
    </main>
    ${local.error ? `<div class="toast show">${esc(local.error)}</div>` : '<div class="toast"></div>'}
  `;
  bindCommon();
}

function bindCommon() {
  app.querySelectorAll('[data-row]').forEach((el) => {
    el.addEventListener('click', () => {
      local.activeRow = Number(el.dataset.row);
      local.input = '';
      render();
    });
  });
}

function lobbyScreen() {
  const players = local.room.players || [];
  shell(`
    <section class="card lobby-card">
      <h2>対戦準備</h2>
      <p>同じActivityに入ったプレイヤーで1ゲームを共有します。1人で開始すると練習用のRE:BOTが参加します。</p>
      <div class="lobby-list">
        ${players.map((p) => `<div class="lobby-player">${avatar(p, 'medium')}<div><b>${esc(p.name)}</b><span>${p.id === local.room.hostId ? 'HOST' : p.cpu ? 'CPU' : 'PLAYER'}</span></div></div>`).join('')}
      </div>
      ${local.room.isHost
        ? `<button id="start" class="primary big" ${local.busy ? 'disabled' : ''}>${players.length === 1 ? 'RE:BOTと開始' : `${players.length}人で開始`}</button>`
        : '<p class="waiting">ホストの開始を待っています…</p>'}
    </section>
  `);
  app.querySelector('#start')?.addEventListener('click', () => mutate('/activity/start', { instanceId: local.sdk.instanceId }));
}

function emptyTile(letter = '', status = '') {
  return `<div class="tile ${tileClass(status)}">${esc(letter)}</div>`;
}

function round1Board() {
  const guesses = local.room.me.round1.guesses || [];
  let html = '<div class="wordle-board">';
  for (let row = 0; row < 6; row += 1) {
    const guess = guesses[row];
    const preview = row === guesses.length && !local.room.me.round1.done ? local.input.padEnd(5, ' ') : null;
    html += '<div class="word-row">';
    for (let col = 0; col < 5; col += 1) {
      const letter = guess?.word?.[col] || preview?.[col]?.trim() || '';
      const status = guess?.pattern?.[col] || '';
      html += emptyTile(letter, status);
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function keyStatusesFromGuesses(guesses = []) {
  const statuses = {};
  for (const guess of guesses) {
    [...guess.word].forEach((letter, index) => {
      const status = guess.pattern[index];
      if (!statuses[letter] || STATUS_RANK[status] > STATUS_RANK[statuses[letter]]) statuses[letter] = status;
    });
  }
  return statuses;
}

function round2Row() {
  return local.room?.me?.round2?.rows?.[local.activeRow] || null;
}

function round2KeyStatuses() {
  const row = round2Row();
  return keyStatusesFromGuesses(row?.tries || []);
}

function flagsForActiveRow() {
  if (!local.flagsByRow.has(local.activeRow)) local.flagsByRow.set(local.activeRow, {});
  return local.flagsByRow.get(local.activeRow);
}

function keyboard({ round2 = false } = {}) {
  const statuses = round2 ? round2KeyStatuses() : keyStatusesFromGuesses(local.room?.me?.round1?.guesses || []);
  const flags = round2 ? flagsForActiveRow() : {};
  const disabled = local.busy || (round2 ? Boolean(round2Row()?.solved) : Boolean(local.room?.me?.round1?.done));

  const key = (letter) => {
    const status = statuses[letter] || '';
    const flag = flags[letter] || '';
    return `<button class="key ${tileClass(status)} ${flag ? `flag-${flag}` : ''}" data-key="${letter}" ${disabled ? 'disabled' : ''}>${letter}</button>`;
  };

  return `
    <div class="keyboard" data-round2="${round2 ? '1' : '0'}">
      <div class="key-row">${[...LETTER_ROWS[0]].map(key).join('')}</div>
      <div class="key-row inset">${[...LETTER_ROWS[1]].map(key).join('')}</div>
      <div class="key-row bottom">
        ${round2 ? `<div class="mode-switch" title="入力 / フラグ">
          <button data-mode="input" class="mode-mini ${local.mode === 'input' ? 'active' : ''}">⌨</button>
          <button data-mode="flag" class="mode-mini ${local.mode === 'flag' ? 'active' : ''}">⚑</button>
        </div>` : ''}
        <button class="key wide" data-action="enter" ${disabled ? 'disabled' : ''}>ENTER</button>
        ${[...LETTER_ROWS[2]].map(key).join('')}
        <button class="key wide" data-action="backspace" ${disabled ? 'disabled' : ''}>⌫</button>
      </div>
    </div>`;
}

function bindKeyboard({ round2 = false } = {}) {
  app.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const letter = button.dataset.key;
      if (round2 && local.mode === 'flag') {
        const flags = flagsForActiveRow();
        const current = flags[letter] || null;
        const next = FLAG_CYCLE[(FLAG_CYCLE.indexOf(current) + 1) % FLAG_CYCLE.length];
        if (next) flags[letter] = next;
        else delete flags[letter];
        render();
        return;
      }
      if (local.input.length < 5) {
        local.input += letter;
        render();
      }
    });
  });

  app.querySelector('[data-action="backspace"]')?.addEventListener('click', () => {
    if (round2 && local.mode === 'flag') return;
    local.input = local.input.slice(0, -1);
    render();
  });
  app.querySelector('[data-action="enter"]')?.addEventListener('click', submitCurrent);
  app.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    local.mode = button.dataset.mode;
    render();
  }));
}

async function submitCurrent() {
  if (local.input.length !== 5 || local.busy) {
    if (local.input.length !== 5) setError('英字5文字を入力してください');
    return;
  }
  if (local.room.phase === 'round1') {
    await mutate('/activity/round1/guess', { instanceId: local.sdk.instanceId, word: local.input });
  } else if (local.room.phase === 'round2') {
    if (local.mode === 'flag') {
      setError('入力モードに切り替えてください');
      return;
    }
    await mutate('/activity/round2/guess', { instanceId: local.sdk.instanceId, rowIndex: local.activeRow, word: local.input });
  }
}

function progressList() {
  return `<div class="progress-list">${(local.room.players || []).map((p) => {
    const done = p.round1.done;
    return `<div><span>${avatar(p)} ${esc(p.name)}</span><b>${done ? (p.round1.won ? 'CLEAR' : '6/6') : `${p.round1.guesses}/6`}</b></div>`;
  }).join('')}</div>`;
}

function round1Screen() {
  const me = local.room.me.round1;
  shell(`
    <section class="game-grid">
      <div class="game-main">
        <div class="round-heading"><div><span class="eyebrow">ROUND 1</span><h2>5文字の単語を当てる</h2></div><b>${me.guesses.length}/6</b></div>
        ${round1Board()}
        ${me.done ? `<div class="notice ${me.won ? 'success' : ''}">${me.won ? 'クリア。全員の終了を待っています…' : '6回終了。全員の終了を待っています…'}</div>` : `<div class="current-input">${local.input.padEnd(5, '·').split('').map((c) => `<span>${esc(c)}</span>`).join('')}</div>`}
        ${keyboard()}
      </div>
      <aside class="side-card"><h3>進行状況</h3>${progressList()}<p>全員がRound 1を終えると、入力した単語そのものが相手のRound 2の問題になります。</p></aside>
    </section>
  `);
  bindKeyboard();
}

function targetBoard() {
  const rows = local.room.me.round2.rows || [];
  return `<div class="reconstruct-board">${rows.map((row, index) => `
    <div class="reconstruct-line ${index === local.activeRow ? 'active' : ''} ${row.solved ? 'solved' : ''}" data-row="${index}">
      <span class="row-number">${index + 1}</span>
      <div class="word-row compact">${row.pattern.map((status, col) => emptyTile(row.revealedWord?.[col] || '', status)).join('')}</div>
      <span class="row-state">${row.solved ? 'SOLVED' : `${row.tries.length} tries`}</span>
    </div>`).join('')}</div>`;
}

function feedbackStrip(row) {
  const last = row?.tries?.at(-1);
  return `<div class="feedback-strip">${Array.from({ length: 5 }, (_, i) => emptyTile(last?.word?.[i] || '', last?.pattern?.[i] || '')).join('')}</div>`;
}

function attemptHistory(row) {
  if (!row?.tries?.length) return '<p class="muted center">まだ予測していません。</p>';
  return `<div class="history">${[...row.tries].reverse().map((trial) => `<div><b>${esc(trial.word)}</b><span>${patternEmoji(trial.pattern)}</span></div>`).join('')}</div>`;
}

function round2Screen() {
  const r2 = local.room.me.round2;
  const target = r2.target;
  const row = round2Row();
  shell(`
    <section class="game-grid round2-grid">
      <div class="game-main">
        <div class="round-heading"><div><span class="eyebrow">ROUND 2</span><h2>${esc(target?.name)} の盤面を復元</h2></div><div class="moves"><b>${r2.attempts}</b><span>MOVES</span></div></div>
        <div class="final-word">FINAL WORD <b>${esc(local.room.answer)}</b></div>
        ${targetBoard()}
        ${r2.done ? '<div class="notice success">完全復元！ 他のプレイヤーの終了を待っています。</div>' : `
          <div class="active-row-title">ROW ${local.activeRow + 1} を復元</div>
          <p class="pattern-hint">元盤面: ${patternEmoji(row?.pattern)}</p>
          ${feedbackStrip(row)}
          <div class="current-input">${(local.mode === 'flag' ? 'FLAG ' : local.input.padEnd(5, '·')).split('').map((c) => `<span>${esc(c)}</span>`).join('')}</div>
          ${keyboard({ round2: true })}
          <p class="mode-help">${local.mode === 'flag' ? 'キー外周を 黄 → 緑 → 黒 → 無印 と切替。これは自分用のメモです。' : '辞書にある5文字語だけ送信できます。ENTERで予測。'}</p>
          ${attemptHistory(row)}
        `}
      </div>
      <aside class="side-card"><h3>ルール</h3><p>色は相手がRound 1で実際に入力した単語の結果です。最後の正解だけを手掛かりに、各行の入力語を当ててください。</p><p>予測を送るたびに、その隠れた入力語を正解としたWordle形式のフィードバックが返ります。</p></aside>
    </section>
  `);
  bindKeyboard({ round2: true });
}

function finishedScreen() {
  const ranking = local.room.leaderboard || [];
  shell(`
    <section class="card result-card">
      <span class="eyebrow">RESULT</span>
      <h2>完全復元</h2>
      <div class="podium-list">${ranking.map((p, index) => `<div class="rank-row ${p.id === local.auth?.user?.id ? 'me' : ''}"><b class="rank">${index + 1}</b><span>${esc(p.name)}</span><strong>${p.attempts} moves</strong></div>`).join('')}</div>
      <div class="result-board"><h3>あなたが復元した盤面</h3><div class="final-word">FINAL WORD <b>${esc(local.room.answer)}</b></div>${targetBoard()}</div>
      ${local.room.isHost ? `<button id="reset" class="primary big">もう一度</button>` : '<p class="waiting">ホストが次のゲームを開始できます。</p>'}
    </section>
  `);
  app.querySelector('#reset')?.addEventListener('click', () => mutate('/activity/reset', { instanceId: local.sdk.instanceId }));
}

function loadingScreen(message = 'Discord Activityに接続しています…') {
  app.innerHTML = `<main class="shell"><section class="card loading"><div class="spinner"></div><h1>RE:WORDLE</h1><p>${esc(message)}</p></section></main>`;
}

function setupError(error) {
  app.innerHTML = `<main class="shell"><section class="card setup-error"><h1>RE:WORDLE</h1><h2>Activityの設定がまだ必要です</h2><p>${esc(error?.message || error)}</p><p class="muted">Discord Developer PortalのApplication IDと、Activity backendへの /api URL Mappingを設定すると起動できます。</p></section></main>`;
}

function render() {
  if (!local.room) return;
  if (local.room.phase === 'lobby') lobbyScreen();
  else if (local.room.phase === 'round1') round1Screen();
  else if (local.room.phase === 'round2') round2Screen();
  else if (local.room.phase === 'finished') finishedScreen();
}

window.addEventListener('keydown', (event) => {
  if (!local.room || local.busy) return;
  const phase = local.room.phase;
  if (phase !== 'round1' && phase !== 'round2') return;
  if (phase === 'round2' && local.mode === 'flag') return;

  if (/^[a-zA-Z]$/.test(event.key) && local.input.length < 5) {
    local.input += event.key.toUpperCase();
    render();
  } else if (event.key === 'Backspace') {
    local.input = local.input.slice(0, -1);
    render();
  } else if (event.key === 'Enter') {
    void submitCurrent();
  }
});

loadingScreen();
setupDiscord().then(render).catch((error) => {
  console.error(error);
  setupError(error);
});
