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
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = process.env;
const STATE = env.VIDEO_CALL_STATE;
const SESSION = env.VIDEO_CALL_SESSION_DIR;
const CLIENT = env.VIDEO_CALL_CLIENT;
const PORT = Number(env.VIDEO_CALL_AVATAR_PORT || 3004);
const RECORD = env.VIDEO_CALL_RECORD === '1';
const FRAME_MS = Number(env.VIDEO_CALL_FRAME_MS || 2000);
// The page's microphone is meant to carry the meeting audio, but in screen-sharing calls it came
// through silent and once never started, so it is off unless asked for.
const RECORD_MIC = env.VIDEO_CALL_RECORD_MIC === '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(SESSION, 'frames');
mkdirSync(FRAMES, { recursive: true });
const S = (name) => join(SESSION, name);
const now = () => Date.now();
const log = (...a) => console.error(new Date().toISOString(), ...a);

// ---------- camera page with the audio recorder ----------

const RECORDER_JS = `(() => {
  const WANT_MIC = ${RECORD_MIC};
  const post = (obj) => fetch('rec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => {});
  const ping = (m) => fetch('ping?m=' + encodeURIComponent(m)).catch(() => {});
  ping('recorder loaded');
  try {
    const rec = new AudioContext();
    const mix = rec.createMediaStreamDestination();
    const connect = AudioNode.prototype.connect;
    // A silent source keeps the recording running in real time, so pauses stay the right length.
    const keep = rec.createConstantSource();
    keep.offset.value = 0;
    connect.call(keep, mix);
    keep.start();
    // Whatever the page plays (the bot's voice) is also copied into the recording. The original
    // connection is made first, so playback works even if the copy fails.
    const taps = new WeakMap();
    AudioNode.prototype.connect = function (target, ...rest) {
      const out = connect.call(this, target, ...rest);
      try {
        if (target instanceof AudioDestinationNode && this.context !== rec) {
          let tap = taps.get(this.context);
          if (!tap) {
            tap = this.context.createMediaStreamDestination();
            taps.set(this.context, tap);
            connect.call(rec.createMediaStreamSource(tap.stream), mix);
            rec.resume().catch(() => {});
          }
          connect.call(this, tap);
        }
      } catch (e) { /* recording is best effort */ }
      return out;
    };
    if (WANT_MIC) {
      const timer = setTimeout(() => ping('microphone not answering after 15 s'), 15000);
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((mic) => { clearTimeout(timer); connect.call(rec.createMediaStreamSource(mic), mix); ping('microphone ok'); })
        .catch((e) => { clearTimeout(timer); ping('microphone error ' + e.message); });
    }
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
    rec.resume().catch(() => {});
    mr.start(3000);
    ping('recording, context ' + rec.state);
    post({ type: 'status', started: Date.now(), mime: type });
  } catch (e) { ping('recorder error ' + e.message); post({ type: 'status', error: e.message }); }
})();`;

function avatarHtml() {
  const html = readFileSync(join(CLIENT, 'ui-templates', 'pattern', 'index.html'), 'utf8');
  if (!RECORD) return html;
  return html.replace('<head>', '<head><script src="recorder.js"></script>');
}

// Each time the bot joins, its page starts a new recording, saved as its own part.
const audioMeta = existsSync(S('audio.json')) ? JSON.parse(readFileSync(S('audio.json'), 'utf8')) : { parts: [] };
audioMeta.parts ||= [];
function newPart(msg) {
  const n = audioMeta.parts.length + 1;
  const ext = String(msg.mime || '').includes('ogg') ? 'ogg' : 'webm';
  audioMeta.parts.push({ file: S(`audio-${n}.${ext}`), pageStarted: msg.started || null, mime: msg.mime || '', chunks: 0 });
}
function saveAudio(msg) {
  if (msg.type === 'status') {
    log('recorder status', JSON.stringify(msg));
    if (msg.error) audioMeta.error = msg.error;
    else { delete audioMeta.error; newPart(msg); }
  } else if (msg.type === 'chunk') {
    if (!audioMeta.parts.length) newPart(msg);
    const part = audioMeta.parts.at(-1);
    if (part.chunks === 0) part.firstChunkAt = now();
    appendFileSync(part.file, Buffer.from(msg.data, 'base64'));
    part.chunks++;
  }
  audioMeta.chunks = audioMeta.parts.reduce((sum, p) => sum + p.chunks, 0);
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
  if (!(req.method === 'GET' && path === '/tasks.json')) log(req.method, req.url.slice(0, 120));
  if (path === '/ping') { log('page says', decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('m') || '')); res.writeHead(204); res.end(); return; }
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
const ALERTS = join(STATE, 'alerts.jsonl');
const alert = (obj) => { log('alert', JSON.stringify(obj)); appendFileSync(ALERTS, `${JSON.stringify({ t: now(), ...obj })}\n`); };
const COMMANDS = join(STATE, 'commands.jsonl');
let offset = 0, rest = '', session = { started: now() };
if (existsSync(S('session.json'))) session = JSON.parse(readFileSync(S('session.json'), 'utf8'));
const saveSession = () => writeFileSync(S('session.json'), JSON.stringify(session, null, 2));
saveSession();

function onEvent(e) {
  const kind = e.event || e.type;
  if (kind === 'call.created' && e.call_id) { session.call_id = e.call_id; session.bot_ready = null; seenInMeeting = false; saveSession(); }
  if (kind === 'call.bot_ready') { session.bot_ready = now(); saveSession(); }
  if (kind === 'participant.joined') seenInMeeting = true;
  if (kind === 'user.message') {
    appendFileSync(S('transcript.jsonl'), `${JSON.stringify({ t: now(), speaker: e.speaker || 'Someone', text: e.text || '' })}\n`);
  }
  // Realtime voice: what the bot actually said.
  if (kind === 'voice.text' && e.text) {
    appendFileSync(S('transcript.jsonl'), `${JSON.stringify({ t: now(), speaker: session.bot_name || 'Claude', text: e.text, bot: true })}\n`);
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

// Watchdog. AgentCall sometimes reports the bot ready while it is still stuck on Meet's
// "Enter your name to join" page. A bot that really got in sees participants join (at least
// itself), so if none show up, take it out and join again.
const STUCK_MS = Number(env.VIDEO_CALL_STUCK_SECONDS || 30) * 1000;
const MAX_REJOINS = Number(env.VIDEO_CALL_MAX_REJOINS || 2);
let seenInMeeting = false, rejoins = 0, gaveUp = false, rejoining = false;
setInterval(() => {
  if (!session.bot_ready || seenInMeeting || rejoining || gaveUp) return;
  if (now() - session.bot_ready < STUCK_MS) return;
  if (rejoins >= MAX_REJOINS) {
    gaveUp = true;
    alert({ event: 'video_call.join_stuck', message: 'The bot says it is ready but never appeared in the meeting. Run shot to see where it is stuck.' });
    return;
  }
  rejoins++;
  rejoining = true;
  alert({ event: 'video_call.rejoining', attempt: rejoins, message: 'The bot never appeared in the meeting, so it is rejoining. The host must admit it again; run share again after bot_ready.' });
  const child = spawn(process.execPath, [join(HERE, 'call.mjs'), 'rejoin'], { detached: true, stdio: 'ignore', env });
  child.unref();
  setTimeout(() => { rejoining = false; }, 15000);
}, 2000);

// Video frames: only while the bot is in the meeting, and only when recording.
let frameNo = 0;
if (RECORD) {
  setInterval(() => {
    if (!session.bot_ready) return;
    appendFileSync(COMMANDS, `${JSON.stringify({ command: 'screenshot', request_id: `rec-${frameNo++}` })}\n`);
  }, FRAME_MS);
}

process.on('SIGTERM', () => process.exit(0));
