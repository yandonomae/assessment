const builtClientId = import.meta.env.VITE_DISCORD_CLIENT_ID || '(unset)';
const proxyAppId = location.hostname.endsWith('.discordsays.com')
  ? location.hostname.split('.')[0]
  : '(not discordsays)';
const match = builtClientId !== '(unset)' && proxyAppId !== '(not discordsays)' && builtClientId === proxyAppId;

window.__REWORDLE_DIAG__ = {
  builtClientId,
  proxyAppId,
  match,
  host: location.hostname,
  frameId: new URLSearchParams(location.search).get('frame_id'),
  instanceId: new URLSearchParams(location.search).get('instance_id')
};

console.info('[RE:WORDLE diag]', window.__REWORDLE_DIAG__);

window.addEventListener('DOMContentLoaded', () => {
  const box = document.createElement('div');
  box.id = 'rewordle-diag';
  box.style.cssText = [
    'position:fixed','left:8px','bottom:8px','z-index:2147483647',
    'font:12px/1.35 monospace','background:rgba(0,0,0,.82)','color:#fff',
    'padding:8px 10px','border-radius:8px','max-width:92vw','word-break:break-all',
    'pointer-events:none'
  ].join(';');
  box.textContent = `build=${builtClientId} | proxy=${proxyAppId} | match=${match ? 'YES' : 'NO'}`;
  document.body.appendChild(box);
});
