import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const data = readFileSync(path.join(root, 'data.json'), 'utf8');
const react = readFileSync(path.join(root, 'node_modules/react/umd/react.development.js'));
const reactDom = readFileSync(path.join(root, 'node_modules/react-dom/umd/react-dom.development.js'));
const client = readFileSync(path.join(root, '..', 'client.js'));

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Skill Pilot UI Harness</title>
<style>html,body,#root{margin:0;padding:0;background:#f8fafc;font-family:system-ui,sans-serif;height:100%}</style>
</head><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
  const captured = {};
  window.__ModuleLoader__ = { load({ id, factory }) {
    const mod = factory((name) => (name === 'react' ? window.React : null));
    const registered = [];
    mod.apply({ slots: {
      inject(slot, cb) { cb(); },
      register(options, component) { registered.push({ options, component }); },
    }});
    captured.module = mod; captured.registered = registered;
    window.__SKILL_PILOT_REGISTERED__ = registered;
  }};
</script>
<script src="/client.js"></script>
<script>
  const entry = (window.__SKILL_PILOT_REGISTERED__ || []).find((item) => item.options && item.options.name === 'settings.section');
  if (!entry) { document.getElementById('root').innerHTML = '<pre>no settings component</pre>'; }
  else { ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(entry.component, {})); }
  const overlays = (window.__SKILL_PILOT_REGISTERED__ || []).filter((item) => item.options && item.options.name === 'shell.overlay');
  for (const overlay of overlays) {
    const host = document.createElement('div'); host.id = 'overlay-' + (overlay.options.id || 'x'); document.body.appendChild(host);
    ReactDOM.createRoot(host).render(React.createElement(overlay.component, {}));
  }
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/react.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(react); return; }
  if (url.pathname === '/react-dom.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(reactDom); return; }
  if (url.pathname === '/client.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(client); return; }
  if (url.pathname === '/skill-pilot/data') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(data); return; }
  if (url.pathname === '/skill-pilot/usage') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, range: '7d', series: [], top: [], totals: { loads: 0, toggles: 0 } }));
    return;
  }
  if (url.pathname === '/skill-pilot/secrets') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, entries: [] }));
    return;
  }
  if (url.pathname.startsWith('/skill-pilot/usage')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, range: '7d', series: [], top: [], totals: { loads: 0, toggles: 0 } }));
    return;
  }
  if (url.pathname.startsWith('/skill-pilot/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, secrets: [], backups: [], alerts: [], settings: {} }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
const port = Number(process.env.PORT || 18777);
server.listen(port, '127.0.0.1', () => console.log('ui harness http://127.0.0.1:' + port));
