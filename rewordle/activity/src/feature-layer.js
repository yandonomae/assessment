const nativeFetch = window.fetch.bind(window);

let latestState = null;
let paintTimer = null;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  return input?.url || String(input || '');
}

function globalAbsentLetters() {
  return new Set(latestState?.me?.round2?.globalAbsentLetters || []);
}

function paintGlobalAbsent() {
  paintTimer = null;
  if (latestState?.phase !== 'round2' && latestState?.phase !== 'finished') return;
  const absent = globalAbsentLetters();
  if (!absent.size) return;

  document.querySelectorAll('.keyboard[data-round2="1"] [data-key]').forEach((key) => {
    if (absent.has(key.dataset.key)) {
      key.classList.add('absent');
      key.dataset.globalAbsent = '1';
      key.title = '相手がRound 1で一度も使っていない文字';
    }
  });
}

function schedulePaint() {
  if (paintTimer != null) return;
  paintTimer = window.setTimeout(paintGlobalAbsent, 0);
}

function rememberState(payload) {
  if (!payload?.instanceId || !payload?.me?.id) return;
  latestState = payload;
  schedulePaint();
}

window.fetch = async (input, init = {}) => {
  const response = await nativeFetch(input, init);
  const url = requestUrl(input);
  if (url.includes('/api/activity/')) {
    response.clone().json().then(rememberState).catch(() => {});
  }
  return response;
};

// main.js redraws the board after local input. Repaint once after that redraw;
// no MutationObserver, presence sync, or extra polling is needed.
document.addEventListener('click', schedulePaint);
window.addEventListener('keydown', schedulePaint);

// Globally absent letters are facts, not player notes, so flag mode cannot override them.
document.addEventListener('click', (event) => {
  const key = event.target.closest('.keyboard[data-round2="1"] [data-key]');
  if (!key) return;
  const flagMode = Boolean(document.querySelector('.mode-mini[data-mode="flag"].active'));
  if (flagMode && globalAbsentLetters().has(key.dataset.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
