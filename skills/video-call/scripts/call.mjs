#!/usr/bin/env node
// Command-line helper for the video-call skill. See SKILL.md.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTCALL_COMMIT = '6f173169a92fa05099c493275705af494a1bb462';
const API = 'https://api.agentcall.dev';
const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const HOME = env.VIDEO_CALL_HOME || join(homedir(), '.video-call');
const SESSIONS = env.VIDEO_CALL_SESSIONS || join(homedir(), 'video-calls');
const CLIENT = join(HOME, 'agentcall');
const NODE_CLIENT = join(CLIENT, 'scripts', 'node');
const TOOLS = join(HOME, 'tools');
const f = (name) => join(HOME, name);
const CDP_PORT = Number(env.VIDEO_CALL_CDP_PORT || 9333);
const VIEW_PORT = Number(env.VIDEO_CALL_VIEW_PORT || 3002);
const CONTROL_PORT = Number(env.VIDEO_CALL_CONTROL_PORT || 3003);
const AVATAR_PORT = Number(env.VIDEO_CALL_AVATAR_PORT || 3004);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(message) { console.error(message); process.exit(1); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`${cmd} failed`);
}
const safeRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const jsonl = (path) => safeRead(path).split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const readJson = (path, fallback = {}) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
function requireSetup() {
  if (!existsSync(join(NODE_CLIENT, 'node_modules', 'ws'))) die('Run setup first.');
}
function apiKey() {
  return env.AGENTCALL_API_KEY || readJson(join(homedir(), '.agentcall', 'config.json')).api_key;
}

function detached(name, command, args, extraEnv = {}) {
  const log = openSync(f(`${name}.log`), 'a');
  const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], env: { ...env, ...extraEnv } });
  child.unref();
  writeFileSync(f(`${name}.pid`), String(child.pid));
}
function killGroup(name) {
  if (!existsSync(f(`${name}.pid`))) return;
  try { process.kill(-Number(readFileSync(f(`${name}.pid`), 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
  rmSync(f(`${name}.pid`));
}

// ---------- setup ----------

function systemFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0 ? 'ffmpeg' : null;
}
function ffmpegPath() {
  if (env.VIDEO_CALL_FFMPEG) return env.VIDEO_CALL_FFMPEG;
  const sys = systemFfmpeg();
  if (sys) return sys;
  try {
    const pkg = join(TOOLS, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`);
    const bin = join(pkg, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(bin)) return bin;
  } catch { /* fall through */ }
  return null;
}

function setup() {
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(join(CLIENT, 'SKILL.md'))) {
    mkdirSync(CLIENT, { recursive: true });
    const url = `https://github.com/pattern-ai-labs/agentcall/archive/${AGENTCALL_COMMIT}.tar.gz`;
    const tarball = f('agentcall.tgz');
    run('curl', ['-fsSL', '-o', tarball, url]);
    run('tar', ['xzf', tarball, '-C', CLIENT, '--strip-components=1']);
    rmSync(tarball);
  }
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: NODE_CLIENT });
  // ffmpeg turns a recording into a video. Use the system one, or fetch a static build from npm.
  if (!ffmpegPath()) {
    mkdirSync(TOOLS, { recursive: true });
    if (!existsSync(join(TOOLS, 'package.json'))) writeFileSync(join(TOOLS, 'package.json'), '{"private":true}');
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '@ffmpeg-installer/ffmpeg@1.1.0'], { cwd: TOOLS });
  }
  console.log(`Ready. AgentCall client: ${CLIENT}. ffmpeg: ${ffmpegPath() || 'not found, recordings will not become videos'}`);
}

// ---------- shared browser ----------

function findChrome() {
  if (env.VIDEO_CALL_CHROME) return env.VIDEO_CALL_CHROME;
  const wsl = existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || /microsoft/i.test(safeRead('/proc/version'));
  const candidates = wsl
    ? ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(existsSync);
  if (!found) die('Chrome not found. Set VIDEO_CALL_CHROME to its path.');
  return found;
}

// Windows Chrome under WSL needs a Windows path for its profile folder.
function profileDir(chrome) {
  if (!chrome.startsWith('/mnt/')) return f(`chrome-profile-${CDP_PORT}`);
  const r = spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8', cwd: '/mnt/c' });
  const temp = (r.stdout || '').trim();
  if (!temp) die('Could not find the Windows temp folder.');
  return `${temp}\\video-call-chrome-${CDP_PORT}`;
}

async function cdpUp() {
  try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok; } catch { return false; }
}

async function browserUp() {
  requireSetup();
  mkdirSync(HOME, { recursive: true });
  if (!(await cdpUp())) {
    const chrome = findChrome();
    detached('chrome', chrome, ['--headless=new', `--user-data-dir=${profileDir(chrome)}`, `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1280,720', '--no-first-run', '--no-default-browser-check', 'about:blank']);
    for (let i = 0; i < 30 && !(await cdpUp()); i++) await sleep(500);
    if (!(await cdpUp())) die(`Chrome did not open port ${CDP_PORT}. Under WSL this needs networkingMode=mirrored in .wslconfig.`);
  }
  killGroup('viewer');
  detached('viewer', process.execPath, [join(HERE, 'browser-server.mjs')], {
    VIDEO_CALL_NODE_CLIENT: NODE_CLIENT,
    VIDEO_CALL_CDP_PORT: String(CDP_PORT), VIDEO_CALL_VIEW_PORT: String(VIEW_PORT), VIDEO_CALL_CONTROL_PORT: String(CONTROL_PORT),
  });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try { if ((await fetch(`http://127.0.0.1:${VIEW_PORT}/state.json`)).ok) return; } catch { /* still starting */ }
  }
  die(`Shared browser did not start. See ${f('viewer.log')}`);
}

async function browser(action, json) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/`, {
    method: 'POST', body: JSON.stringify({ action, ...(json ? JSON.parse(json) : {}) }),
  });
  console.log(await res.text());
  if (!res.ok) process.exit(1);
}

async function browserDown() {
  try { await fetch(`http://127.0.0.1:${CONTROL_PORT}/`, { method: 'POST', body: JSON.stringify({ action: 'quit' }) }); } catch { /* gone */ }
  killGroup('viewer');
  await sleep(500);
  killGroup('chrome');
}

// ---------- session folder ----------

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
function sessionDir() {
  const dir = safeRead(f('session-dir')).trim();
  if (!dir) die('No call session. Run start first.');
  return dir;
}
const sessionFile = (name) => join(sessionDir(), name);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

// ---------- call ----------

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') out.name = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
    else if (args[i] === '--no-record') out.noRecord = true;
    else if (args[i] === '--title') out.title = args[++i];
    else if (args[i] === '--realtime') out.realtime = true;
    else if (args[i] === '--name-only') out.nameOnly = true;
    else if (args[i] === '--context') out.context = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

async function start(args) {
  const opts = parseFlags(args);
  const url = opts._[0];
  if (!url) die('Usage: start <meeting-url> [--name Claude] [--title "topic"] [--realtime [--name-only] [--context "..."]] [--no-record] [--out DIR]');
  requireSetup();
  if (existsSync(f('bridge.pid'))) die('A call is already running. Run stop first.');
  const name = opts.name || 'Claude';
  const record = !opts.noRecord;
  const slug = (opts.title || 'call').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'call';
  const dir = resolve(opts.out || join(SESSIONS, `${stamp()}_${slug}`));
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  writeFileSync(f('session-dir'), dir);
  const realtime = !!opts.realtime;
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ started: Date.now(), meet_url: url, bot_name: name, title: opts.title || '', record, realtime }, null, 2));
  if (!existsSync(join(dir, 'notes.md'))) writeFileSync(join(dir, 'notes.md'), `# ${opts.title || 'Call notes'}\n\n${new Date().toLocaleString()}, ${url}\n\n`);

  await browserUp();
  for (const file of ['commands.jsonl', 'events.jsonl', 'bridge.err']) writeFileSync(f(file), '');
  killGroup('session');
  detached('session', process.execPath, [join(HERE, 'session-server.mjs')], {
    VIDEO_CALL_STATE: HOME, VIDEO_CALL_SESSION_DIR: dir, VIDEO_CALL_CLIENT: CLIENT,
    VIDEO_CALL_AVATAR_PORT: String(AVATAR_PORT), VIDEO_CALL_RECORD: record ? '1' : '0',
    VIDEO_CALL_RECORD_MIC: env.VIDEO_CALL_RECORD_MIC || '0',
  });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try { if ((await fetch(`http://127.0.0.1:${AVATAR_PORT}/`)).ok) break; } catch { if (i === 19) die(`Session server did not start. See ${f('session.log')}`); }
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const bridge = join(NODE_CLIENT, 'bridge-visual.js');
  const vad = env.VIDEO_CALL_VAD_SECONDS || '2';
  // Realtime: AgentCall's voice intelligence answers by itself when addressed; Claude steers it.
  const voiceArgs = realtime
    ? ` --voice-strategy collaborative --voice ${q(env.VIDEO_CALL_RT_VOICE || 'voice.heart')}`
      + ` --trigger-words ${q(env.VIDEO_CALL_TRIGGER_WORDS || triggerWords(name, opts.nameOnly))} --context ${q(realtimeContext(name, opts.context))}`
    : ` --voice ${q(env.VIDEO_CALL_VOICE || 'af_heart')}`;
  const shell = `tail -n0 -f ${q(f('commands.jsonl'))} | ${q(process.execPath)} ${q(bridge)} ${q(url)} --name ${q(name)}`
    + `${voiceArgs} --ui-port ${AVATAR_PORT} --screenshare-port ${VIEW_PORT}`
    + ` --vad-timeout ${q(vad)} --max-duration 55 --alone-timeout 600 --silence-timeout 900`
    + ` > ${q(f('events.jsonl'))} 2> ${q(f('bridge.err'))}`;
  writeFileSync(f('bridge.sh'), shell);
  writeFileSync(f('alerts.jsonl'), '');
  detached('bridge', 'sh', ['-c', shell]);
  console.log(`Bot joining ${url}\nVoice: ${realtime ? 'realtime' : 'Claude speaks every line'}\nRecording: ${record ? 'on' : 'off'}\nSession folder: ${dir}\nEvents: ${f('events.jsonl')}`);
}

const send = (obj) => appendFileSync(f('commands.jsonl'), `${JSON.stringify(obj)}\n`);

// The voice answers when a line contains one of these. By default the list includes everyday words,
// so it answers practically everything (best one to one). --name-only keeps it to its name (group calls).
const EVERYDAY = ['i', 'you', 'the', 'a', 'what', 'is', 'can', 'please', 'okay', 'ok', 'so', 'and', 'it', 'this', 'that', 'how', 'why', 'hey', 'hi', 'yes', 'no'];
function triggerWords(name, nameOnly) {
  const base = name.toLowerCase();
  const heard = base === 'claude' ? ['cloud', 'clod', 'klaud', 'clawed', 'clyde'] : [];
  return [base, `hey ${base}`, ...heard, ...(nameOnly ? [] : EVERYDAY)].join(',');
}

function realtimeContext(name, extra) {
  const text = `You are ${name}, an AI assistant taking part in this video call by voice. Keep spoken answers short,`
    + ' one to three sentences, natural and friendly. A separate agent works alongside you: it drives the browser you'
    + ' share, takes screenshots and notes of what people show, and can look things up or change files. When someone'
    + ' asks for something that needs an action, say briefly that you are on it, and do not invent the result; the'
    + ' agent will tell you what happened. Never claim something was done unless you were told it was.'
    + ' You cannot see screens or video yourself: describe only what the agent has told you, and if asked what is'
    + ' on screen before that, say you are taking a look.'
    + (extra ? `\n\n${extra}` : '');
  return text.slice(0, 4000);
}

function say(text) {
  if (!text) die('Usage: say "<text>"');
  const s = readJson(sessionFile('session.json'));
  if (s.realtime) {
    // Exact words, retried by the voice if someone talks over it. The session server logs them from voice.text.
    send({ command: 'inject.verbatim', text, priority: 'high' });
    return;
  }
  send({ command: 'tts.speak', text });
  appendFileSync(sessionFile('transcript.jsonl'), `${JSON.stringify({ t: Date.now(), speaker: s.bot_name || 'Claude', text, bot: true })}\n`);
}

// Realtime only: replace what the voice knows (up to 4000 characters), and optionally make it answer now.
function context(text) {
  if (!text) die('Usage: context "<what the voice should know>"');
  if (!readJson(sessionFile('session.json')).realtime) die('context needs a call started with --realtime.');
  send({ command: 'voice.context_update', text: text.slice(0, 4000) });
}
function answer(text) {
  if (!readJson(sessionFile('session.json')).realtime) die('answer needs a call started with --realtime.');
  send({ command: 'trigger.speak', text: text || 'Please answer the last question.', speaker: 'agent' });
}

// Takes a meeting screenshot. With a label it is also kept in screenshots/ and linked from notes.md.
async function shot(label) {
  const dir = sessionDir();
  const asked = Date.now();
  const id = `shot-${asked}`;
  send({ command: 'screenshot', request_id: id });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    // AgentCall doesn't always echo request_id, so take the first screenshot that arrived after asking.
    const hit = readdirSync(join(dir, 'frames')).filter((n) => Number(n.split('_')[0]) > asked).sort()[0];
    if (!hit) continue;
    const src = join(dir, 'frames', hit);
    let out = f('meeting.jpg');
    copyFileSync(src, out);
    if (label) {
      const n = readdirSync(join(dir, 'screenshots')).length + 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      const name = `${String(n).padStart(2, '0')}-${slug || 'screenshot'}.jpg`;
      out = join(dir, 'screenshots', name);
      copyFileSync(src, out);
      appendFileSync(join(dir, 'notes.md'), `\n**${clock(Date.now())}** ${label}\n\n![${label}](screenshots/${name})\n`);
    }
    console.log(out);
    return;
  }
  die('No screenshot arrived within 20 seconds.');
}

function note(text) {
  if (!text) die('Usage: note "<text>"');
  appendFileSync(sessionFile('notes.md'), `\n- **${clock(Date.now())}** ${text}\n`);
  console.log(sessionFile('notes.md'));
}

async function fetchTranscript(callId, key) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`${API}/v1/calls/${callId}/transcript?format=json`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) {
        const data = await res.json();
        if ((data.entries || []).length) return data;
      }
    } catch { /* retry */ }
    await sleep(2500);
  }
  return null;
}

// Removes the bot and sends a fresh one into the same meeting, keeping the browser and session.
async function rejoin() {
  if (!existsSync(f('bridge.sh'))) die('No call to rejoin.');
  const callId = readJson(sessionFile('session.json')).call_id;
  const key = apiKey();
  if (existsSync(f('bridge.pid'))) send({ command: 'leave' });
  await sleep(1500);
  if (callId && key) {
    const res = await fetch(`${API}/v1/calls/${callId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
    console.log(`Old call ${callId}: delete returned ${res?.status}`);
  }
  killGroup('bridge');
  await sleep(1000);
  for (const file of ['commands.jsonl', 'events.jsonl', 'bridge.err']) writeFileSync(f(file), '');
  detached('bridge', 'sh', ['-c', readFileSync(f('bridge.sh'), 'utf8')]);
  console.log('Bot rejoining.');
}

async function stop({ noVideo } = {}) {
  const dir = safeRead(f('session-dir')).trim();
  const session = dir ? readJson(join(dir, 'session.json')) : {};
  const callId = session.call_id || jsonl(f('events.jsonl')).find((e) => e.call_id)?.call_id;
  if (existsSync(f('bridge.pid'))) { send({ command: 'leave' }); await sleep(2000); }
  // The API call is the guarantee: a dropped connection can leave the bot in the meeting, still charging.
  const key = apiKey();
  if (callId && key) {
    const res = await fetch(`${API}/v1/calls/${callId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
    console.log(`Call ${callId}: delete returned ${res.status}`);
    const transcript = await fetchTranscript(callId, key);
    if (transcript && dir) writeFileSync(join(dir, 'transcript-agentcall.json'), JSON.stringify(transcript, null, 2));
  } else if (callId) {
    console.error(`No API key found, so call ${callId} may still be running.`);
  }
  killGroup('bridge');
  await sleep(1000);
  killGroup('session');
  await browserDown();
  // Screenshots are kept as video frames; the raw event log is large and no longer needed.
  writeFileSync(f('events.jsonl'), '');
  writeFileSync(f('commands.jsonl'), '');
  rmSync(f('session-dir'), { force: true });
  if (dir) {
    writeTranscript(dir);
    if (!noVideo && session.record !== false) buildVideo(dir);
    console.log(`Session folder: ${dir}`);
  }
  console.log('Stopped.');
}

// ---------- transcript and video ----------

// People's lines come from the live speech events, the bot's from what it was told to say.
function transcriptEntries(dir) {
  return jsonl(join(dir, 'transcript.jsonl')).sort((a, b) => a.t - b.t);
}

function writeTranscript(dir) {
  const lines = transcriptEntries(dir).map((e) => `**${clock(e.t)} ${e.speaker}:** ${e.text}`);
  writeFileSync(join(dir, 'transcript.md'), `# Transcript\n\nSpeech recognition is approximate.\n\n${lines.join('\n\n')}\n`);
}

const srtTime = (ms) => {
  const v = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(v / 3600000))}:${p(Math.floor(v / 60000) % 60)}:${p(Math.floor(v / 1000) % 60)},${p(v % 1000, 3)}`;
};

function buildVideo(dir) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) { console.error('No ffmpeg, so no video. Run setup, or set VIDEO_CALL_FFMPEG.'); return null; }
  const frames = jsonl(join(dir, 'frames.jsonl')).filter((x) => existsSync(join(dir, 'frames', x.file))).sort((a, b) => a.t - b.t);
  if (frames.length < 2) { console.error('Not enough frames recorded for a video.'); return null; }
  const t0 = frames[0].t;
  const end = frames.at(-1).t + 2000;

  // Each still is shown until the next one arrived.
  const list = frames.map((x, i) => `file '${join(dir, 'frames', x.file).replace(/'/g, `'\\''`)}'\nduration ${(((frames[i + 1]?.t ?? end) - x.t) / 1000).toFixed(3)}`);
  list.push(`file '${join(dir, 'frames', frames.at(-1).file).replace(/'/g, `'\\''`)}'`);
  writeFileSync(join(dir, 'frames.ffconcat'), `ffconcat version 1.0\n${list.join('\n')}\n`);

  // Captions: speech recognition arrives after the words were spoken, so each line is shown a bit early.
  // Lines the same speaker said in one burst (the voice reports sentence by sentence) become one caption.
  const entries = [];
  for (const e of transcriptEntries(dir).filter((x) => x.t >= t0 - 5000)) {
    const last = entries.at(-1);
    if (last && last.speaker === e.speaker && e.t - last.t < 3000) last.text += ` ${e.text}`;
    else entries.push({ ...e });
  }
  const lead = (e) => (e.bot ? 0 : Math.min(4000, 600 + e.text.split(/\s+/).length * 300));
  const srt = entries.map((e, i) => {
    const from = e.t - t0 - lead(e);
    const natural = Math.min(10000, 1500 + e.text.length * 55);
    const next = entries[i + 1] ? entries[i + 1].t - t0 - lead(entries[i + 1]) : end - t0;
    // Cut a caption short only when the next one starts after it has been readable for a moment.
    const until = next > from + 1500 ? Math.min(from + natural, next) : from + natural;
    return `${i + 1}\n${srtTime(from)} --> ${srtTime(until)}\n${e.speaker}: ${e.text}\n`;
  }).join('\n');
  writeFileSync(join(dir, 'recording.srt'), srt);

  const audio = readJson(join(dir, 'audio.json'), {});
  // Older sessions kept one file; newer ones a part per bot join.
  const parts = (audio.parts || (audio.file ? [audio] : []))
    .filter((p) => p.file && existsSync(p.file) && statSync(p.file).size > 1000 && p.firstChunkAt);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.ffconcat')];
  for (const p of parts) {
    // The page's clock says when recording began; fall back to when the first piece arrived.
    let start = p.pageStarted;
    if (!start || Math.abs(start - p.firstChunkAt) > 60000) start = p.firstChunkAt - 3000;
    const offset = (start - t0) / 1000;
    if (offset >= 0) args.push('-itsoffset', offset.toFixed(3), '-i', p.file);
    else args.push('-ss', (-offset).toFixed(3), '-i', p.file);
  }
  const hasAudio = parts.length > 0;
  args.push('-i', join(dir, 'recording.srt'));
  const subIndex = parts.length + 1;
  if (parts.length > 1) {
    // The parts don't overlap, so mixing them back to full volume just lays them end to end.
    const ins = parts.map((_, i) => `[${i + 1}:a]`).join('');
    args.push('-filter_complex', `${ins}amix=inputs=${parts.length}:dropout_transition=0,volume=${parts.length}[a]`);
  }
  args.push('-map', '0:v', ...(parts.length > 1 ? ['-map', '[a]'] : hasAudio ? ['-map', '1:a'] : []), '-map', `${subIndex}:s`,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-r', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '26',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : []), '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
    '-movflags', '+faststart', join(dir, 'recording.mp4'));
  console.log('Building video...');
  const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('ffmpeg failed.'); return null; }
  console.log(`Video: ${join(dir, 'recording.mp4')}${hasAudio ? '' : ' (no audio was recorded)'}`);
  return join(dir, 'recording.mp4');
}

function status() {
  const dir = safeRead(f('session-dir')).trim();
  if (!dir) return console.log('No call running.');
  const s = readJson(join(dir, 'session.json'));
  const a = readJson(join(dir, 'audio.json'), {});
  const frames = jsonl(join(dir, 'frames.jsonl')).length;
  console.log(JSON.stringify({ session: dir, call_id: s.call_id, bot_ready: !!s.bot_ready, recording: s.record,
    frames, audio_chunks: a.chunks || 0, audio_parts: (a.parts || []).length, audio_error: a.error || null }, null, 2));
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'setup': setup(); break;
  case 'register':
    requireSetup();
    run(process.execPath, [join(NODE_CLIENT, 'register.js'), ...rest]);
    break;
  case 'start': await start(rest); break;
  case 'say': say(rest.join(' ')); break;
  case 'chat': send({ command: 'send_chat', message: rest.join(' ') }); break;
  case 'share': send({ command: 'screenshare.start', port: VIEW_PORT }); break;
  case 'unshare': send({ command: 'screenshare.stop' }); break;
  case 'shot': await shot(rest.join(' ')); break;
  case 'note': note(rest.join(' ')); break;
  case 'context': context(rest.join(' ')); break;
  case 'answer': answer(rest.join(' ')); break;
  case 'status': status(); break;
  case 'browser': await browser(rest[0], rest[1]); break;
  case 'browser-up': await browserUp(); break;
  case 'browser-down': await browserDown(); break;
  case 'rejoin': await rejoin(); break;
  case 'stop': await stop({ noVideo: rest.includes('--no-video') }); break;
  case 'video': {
    const dir = resolve(rest[0] || die('Usage: video <session-folder>'));
    writeTranscript(dir);
    buildVideo(dir) || process.exit(1);
    break;
  }
  default:
    die('Commands: setup, register, start <url> [--name N] [--title T] [--no-record] [--out DIR], say <text>, chat <text>,'
      + ' share, unshare, shot [label], note <text>, context <text>, answer [question], status, browser <action> [json], stop [--no-video], video <session-folder>');
}
