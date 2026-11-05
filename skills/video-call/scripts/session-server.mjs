// Runs for the length of one call. call.mjs starts it before the bot joins.
//  - Serves the bot's camera page (AgentCall's "pattern" avatar) on AVATAR_PORT. The bot loads it
//    through the AgentCall tunnel. When recording, a small script added to that page records the
//    meeting audio (which the page receives as its microphone) plus the bot's own voice, and
//    uploads it back here in short pieces.
//  - Asks the bot for a meeting screenshot every FRAME_MS and saves every screenshot it gets.
//  - Writes a running transcript of what people said.
// All output goes to the session folder SESSION_DIR.
import http from 'node:http';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const STATE = env.VIDEO_CALL_STATE;
const SESSION = env.VIDEO_CALL_SESSION_DIR;
const CLIENT = env.VIDEO_CALL_CLIENT;
const PORT = Number(env.VIDEO_CALL_AVATAR_PORT || 3004);
const RECORD = env.VIDEO_CALL_RECORD === '1';
const FRAME_MS = Number(env.VIDEO_CALL_FRAME_MS || 2000);

const FRAMES = join(SESSION, 'frames');
mkdirSync(FRAMES, { recursive: true });
const S = (name) => join(SESSION, name);
const now = () => Date.now();
const log = (...a) => console.error(new Date().toISOString(), ...a);

// ---------- camera page with the audio recorder ----------

const RECORDER_JS = `(() => {
  const post = (obj) => fetch('rec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => {});
  try {
    const rec = new AudioContext();
    const mix = rec.createMediaStreamDestination();
    const taps = new WeakMap();
    const connect = AudioNode.prototype.connect;
    // Whatever the page plays (the bot's voice) is also sent into the recording.
    AudioNode.prototype.connect = function (target, ...rest) {
      const out = connect.call(this, target, ...rest);
      try {
        if (target instanceof AudioDestinationNode && this.context !== rec) {
          let tap = taps.get(this.context);
          if (!tap) {
            tap = this.context.createMediaStreamDestination();
            taps.set(this.context, tap);
            connect.call(rec.createMediaStreamSource(tap.stream), mix);
          }
          connect.call(this, tap);
        }
      } catch (e) { post({ type: 'status', error: 'tap: ' + e.message }); }
      return out;
    };
    // The meeting audio arrives as this page's microphone. It goes only into the recording,
    // never to the speakers, so nothing echoes back into the meeting.
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .then((mic) => {
        connect.call(rec.createMediaStreamSource(mic), mix);
        rec.resume();
        const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
        const mr = new MediaRecorder(mix.stream, { mimeType: type, audioBitsPerSecond: 48000 });
        let seq = 0, chain = Promise.resolve();
        mr.ondataavailable = (e) => {
          if (!e.data.size) return;
          const n = seq++;
          chain = chain.then(() => new Promise((done) => {
            const fr = new FileReader();
            fr.onload = () => post({ type: 'chunk', seq: n, mime: type, data: String(fr.result).split(',')[1] }).then(done);
            fr.readAsDataURL(e.data);
          }));
        };
        mr.start(3000);
        post({ type: 'status', started: Date.now(), mime: type });
      })
      .catch((e) => post({ type: 'status', error: 'microphone: ' + e.message }));
  } catch (e) { post({ type: 'status', error: e.message }); }
})();`;

function avatarHtml() {
  const html = readFileSync(join(CLIENT, 'ui-templates', 'pattern', 'index.html'), 'utf8');
  if (!RECORD) return html;
  return html.replace('<head>', '<head><script src="recorder.js"></script>');
}

let audioFile = null, audioMeta = { chunks: 0 };
function saveAudio(msg) {
  if (msg.type === 'status') {
    Object.assign(audioMeta, msg.error ? { error: msg.error } : { pageStarted: msg.started, mime: msg.mime });
    log('recorder status', JSON.stringify(msg));
  } else if (msg.type === 'chunk') {
    if (audioMeta.chunks === 0) audioMeta.firstChunkAt = now();
    audioFile ||= S(String(msg.mime || '').includes('ogg') ? 'audio.ogg' : 'audio.webm');
    appendFileSync(audioFile, Buffer.from(msg.data, 'base64'));
    audioMeta.chunks++;
    audioMeta.file = audioFile;
  }
  writeFileSync(S('audio.json'), JSON.stringify(audioMeta, null, 2));
}

// The tunnel may hand the request body over as plain text or as base64 of it.
function parseBody(raw) {
  const text = raw.toString('utf8');
  try { return JSON.parse(text); } catch { /* try base64 */ }
  return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
}

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^.*\//, '/');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (req.method === 'POST' && path === '/rec') {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      try { saveAudio(parseBody(Buffer.concat(parts))); send(200, 'text/plain', 'ok'); } catch (e) { log('bad upload', e.message); send(400, 'text/plain', 'bad'); }
    });
    return;
  }
  if (path === '/' || path === '/index.html') return send(200, 'text/html; charset=utf-8', avatarHtml());
  if (path === '/recorder.js') return send(200, 'application/javascript', RECORDER_JS);
  if (path === '/agentcall-audio.js') return send(200, 'application/javascript', readFileSync(join(CLIENT, 'ui-templates', 'agentcall-audio.js')));
  if (path === '/tasks.json') return send(200, 'application/json', '{"tasks":[]}');
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => log(`camera page on :${PORT}, recording ${RECORD ? 'on' : 'off'}`));

// ---------- meeting events ----------

const EVENTS = join(STATE, 'events.jsonl');
const COMMANDS = join(STATE, 'commands.jsonl');
let offset = 0, rest = '', session = { started: now() };
if (existsSync(S('session.json'))) session = JSON.parse(readFileSync(S('session.json'), 'utf8'));
const saveSession = () => writeFileSync(S('session.json'), JSON.stringify(session, null, 2));
saveSession();

function onEvent(e) {
  const kind = e.event || e.type;
  if (kind === 'call.created' && e.call_id) { session.call_id = e.call_id; saveSession(); }
  if (kind === 'call.bot_ready') { session.bot_ready = now(); saveSession(); }
  if (kind === 'user.message') {
    appendFileSync(S('transcript.jsonl'), `${JSON.stringify({ t: now(), speaker: e.speaker || 'Someone', text: e.text || '' })}\n`);
  }
  if (kind === 'screenshot.result' && e.data) {
    const id = String(e.request_id || 'shot').replace(/[^\w.-]/g, '_');
    const file = `${now()}_${id}.jpg`;
    writeFileSync(join(FRAMES, file), Buffer.from(e.data, 'base64'));
    appendFileSync(S('frames.jsonl'), `${JSON.stringify({ t: now(), file, request_id: e.request_id || '' })}\n`);
  }
}

function pump() {
  try {
    const size = statSync(EVENTS).size;
    if (size < offset) { offset = 0; rest = ''; }
    if (size > offset) {
      const fd = openSync(EVENTS, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) { try { onEvent(JSON.parse(line)); } catch { /* not an event line */ } }
    }
  } catch { /* events file not created yet */ }
  setTimeout(pump, 200);
}
pump();

// Video frames: only while the bot is in the meeting, and only when recording.
let frameNo = 0;
if (RECORD) {
  setInterval(() => {
    if (!session.bot_ready) return;
    appendFileSync(COMMANDS, `${JSON.stringify({ command: 'screenshot', request_id: `rec-${frameNo++}` })}\n`);
  }, FRAME_MS);
}

process.on('SIGTERM', () => process.exit(0));
