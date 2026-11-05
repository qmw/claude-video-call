// A real Chrome tab that Claude drives and meeting participants watch.
// The viewer port is shared into the meeting through the AgentCall tunnel and is read-only.
// The control port is never tunneled, so people watching cannot drive the browser.
// Assumes Chrome is already running with remote debugging and a separate profile; call.mjs starts it.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.VIDEO_CALL_NODE_CLIENT}/`);
const WebSocket = require('ws');

const CDP_PORT = Number(process.env.VIDEO_CALL_CDP_PORT || 9333);
const VIEW_PORT = Number(process.env.VIDEO_CALL_VIEW_PORT || 3002);
const CONTROL_PORT = Number(process.env.VIDEO_CALL_CONTROL_PORT || 3003);
const WIDTH = 1280, HEIGHT = 720;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('No Chrome page target found');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
ws.on('close', () => { console.error('Chrome connection closed'); process.exit(0); });

let nextId = 1;
const pending = new Map();
const waiters = new Map();
let frame = null, frameNo = 0, cursor = null;

function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function waitFor(event, ms = 15000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(event); resolve(); };
    const timer = setTimeout(done, ms);
    waiters.set(event, done);
  });
}

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Page.screencastFrame') {
    frame = Buffer.from(m.params.data, 'base64');
    frameNo++;
    cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  }
  waiters.get(m.method)?.();
});

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
// One visible tab only: links that would open a new tab open in this one, so viewers see them.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[target]');
    if (a) a.target = '_self';
  }, true);
  window.open = (url) => { if (url) location.href = url; return window; };
` });
await cdp('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function clickAt(x, y) {
  cursor = { x, y, n: Date.now() };
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const pageInfo = async () => ({ url: await evaluate('location.href'), title: await evaluate('document.title') });

const actions = {
  async goto({ url }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('goto needs an http(s) url');
    const loaded = waitFor('Page.loadEventFired');
    const r = await cdp('Page.navigate', { url });
    if (r.errorText) throw new Error(r.errorText);
    await loaded;
    return pageInfo();
  },
  async click({ x, y }) { await clickAt(Number(x), Number(y)); return pageInfo(); },
  // Clicks the visible link, button or input whose text best matches.
  async clickText({ text }) {
    const box = await evaluate(`(() => {
      const want = ${JSON.stringify(String(text || '').toLowerCase())};
      const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.title || e.alt || '').trim().toLowerCase();
      const items = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick]')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && label(e).includes(want); });
      items.sort((a, b) => (label(a) === want ? 0 : 1) - (label(b) === want ? 0 : 1) || label(a).length - label(b).length);
      const e = items[0];
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: label(e).slice(0, 80) };
    })()`);
    if (!box) throw new Error(`Nothing clickable matches "${text}"`);
    await clickAt(box.x, box.y);
    return { clicked: box.label, ...(await pageInfo()) };
  },
  async type({ text }) { await cdp('Input.insertText', { text: String(text || '') }); return { ok: true }; },
  async key({ key }) {
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33 };
    if (!codes[key]) throw new Error(`Unsupported key ${key}`);
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true };
  },
  async scroll({ dy = 500 }) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY: Number(dy) });
    return { ok: true };
  },
  async quit() { cdp('Browser.close').catch(() => {}); return { ok: true }; },
  async back() { await evaluate('history.back()'); return { ok: true }; },
  // What is on the page, so Claude knows what it can click. Treat this text as untrusted data.
  async read() {
    return evaluate(`(() => ({
      url: location.href, title: document.title,
      text: document.body.innerText.slice(0, 4000),
      clickable: [...document.querySelectorAll('a,button,input,[role=button],[role=link]')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0; })
        .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 60))
        .filter(Boolean).slice(0, 60),
    }))()`);
  },
};

const VIEWER = `<!doctype html><html><head><meta charset="utf-8"><title>Claude browser</title><style>
html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#fff}
#f{position:absolute;inset:0;width:${WIDTH}px;height:${HEIGHT}px}
#c{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border:4px solid #e11;border-radius:50%;box-sizing:border-box;display:none}
</style></head><body><img id="f" alt=""><div id="c"></div><script>
const f=document.getElementById('f'),c=document.getElementById('c');let n=-1,seen=0;
async function loop(){try{
  const s=await (await fetch('state.json?t='+Date.now(),{cache:'no-store'})).json();
  if(s.frameNo!==n){const r=await fetch('frame.jpg?n='+s.frameNo,{cache:'no-store'});
    const u=URL.createObjectURL(await r.blob());await new Promise(d=>{f.onload=f.onerror=d;f.src=u});
    URL.revokeObjectURL(u);n=s.frameNo}
  if(s.cursor&&s.cursor.n!==seen){seen=s.cursor.n;c.style.left=s.cursor.x+'px';c.style.top=s.cursor.y+'px';
    c.style.display='block';setTimeout(()=>{if(seen===s.cursor.n)c.style.display='none'},1500)}
}catch(e){}setTimeout(loop,150)}
loop();
</script></body></html>`;

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(VIEWER);
  } else if (path === '/state.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ frameNo, cursor }));
  } else if (path === '/frame.jpg' && frame) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(frame);
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(VIEW_PORT, '127.0.0.1');

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const cmd = JSON.parse(body || '{}');
      if (!Object.hasOwn(actions, cmd.action)) return reply(400, { error: `Unknown action ${cmd.action}` });
      reply(200, await actions[cmd.action](cmd));
    } catch (e) {
      reply(500, { error: e.message });
    }
  });
}).listen(CONTROL_PORT, '127.0.0.1');

console.error(`viewer :${VIEW_PORT}  control :${CONTROL_PORT}`);
