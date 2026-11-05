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
    else out._.push(args[i]);
  }
  return out;
}

async function start(args) {
  const opts = parseFlags(args);
  const url = opts._[0];
  if (!url) die('Usage: start <meeting-url> [--name Claude] [--title "topic"] [--no-record] [--out DIR]');
  requireSetup();
  if (existsSync(f('bridge.pid'))) die('A call is already running. Run stop first.');
  const name = opts.name || 'Claude';
  const record = !opts.noRecord;
  const slug = (opts.title || 'call').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'call';
  const dir = resolve(opts.out || join(SESSIONS, `${stamp()}_${slug}`));
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  writeFileSync(f('session-dir'), dir);
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ started: Date.now(), meet_url: url, bot_name: name, title: opts.title || '', record }, null, 2));
  if (!existsSync(join(dir, 'notes.md'))) writeFileSync(join(dir, 'notes.md'), `# ${opts.title || 'Call notes'}\n\n${new Date().toLocaleString()}, ${url}\n\n`);

  await browserUp();
  for (const file of ['commands.jsonl', 'events.jsonl', 'bridge.err']) writeFileSync(f(file), '');
  killGroup('session');
  detached('session', process.execPath, [join(HERE, 'session-server.mjs')], {
    VIDEO_CALL_STATE: HOME, VIDEO_CALL_SESSION_DIR: dir, VIDEO_CALL_CLIENT: CLIENT,
    VIDEO_CALL_AVATAR_PORT: String(AVATAR_PORT), VIDEO_CALL_RECORD: record ? '1' : '0',
  });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try { if ((await fetch(`http://127.0.0.1:${AVATAR_PORT}/`)).ok) break; } catch { if (i === 19) die(`Session server did not start. See ${f('session.log')}`); }
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const bridge = join(NODE_CLIENT, 'bridge-visual.js');
  const vad = env.VIDEO_CALL_VAD_SECONDS || '2';
  const shell = `tail -n0 -f ${q(f('commands.jsonl'))} | ${q(process.execPath)} ${q(bridge)} ${q(url)} --name ${q(name)}`
    + ` --voice ${q(env.VIDEO_CALL_VOICE || 'af_heart')} --ui-port ${AVATAR_PORT} --screenshare-port ${VIEW_PORT}`
    + ` --vad-timeout ${q(vad)} --max-duration 55 --alone-timeout 600 --silence-timeout 900`
    + ` > ${q(f('events.jsonl'))} 2> ${q(f('bridge.err'))}`;
  detached('bridge', 'sh', ['-c', shell]);
  console.log(`Bot joining ${url}\nRecording: ${record ? 'on' : 'off'}\nSession folder: ${dir}\nEvents: ${f('events.jsonl')}`);
}

const send = (obj) => appendFileSync(f('commands.jsonl'), `${JSON.stringify(obj)}\n`);

function say(text) {
  if (!text) die('Usage: say "<text>"');
  send({ command: 'tts.speak', text });
  const name = readJson(sessionFile('session.json')).bot_name || 'Claude';
  appendFileSync(sessionFile('transcript.jsonl'), `${JSON.stringify({ t: Date.now(), speaker: name, text, bot: true })}\n`);
}

// Takes a meeting screenshot. With a label it is also kept in screenshots/ and linked from notes.md.
async function shot(label) {
  const dir = sessionDir();
  const id = `shot-${Date.now()}`;
  send({ command: 'screenshot', request_id: id });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const hit = readdirSync(join(dir, 'frames')).find((n) => n.endsWith(`_${id}.jpg`));
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
  const entries = transcriptEntries(dir).filter((e) => e.t >= t0 - 5000);
  const srt = entries.map((e, i) => {
    const lead = e.bot ? 0 : Math.min(4000, 600 + e.text.split(/\s+/).length * 300);
    const from = e.t - t0 - lead;
    const until = Math.min(from + 2000 + e.text.length * 60, (entries[i + 1] ? entries[i + 1].t - t0 : end - t0));
    return `${i + 1}\n${srtTime(from)} --> ${srtTime(Math.max(until, from + 1000))}\n${e.speaker}: ${e.text}\n`;
  }).join('\n');
  writeFileSync(join(dir, 'recording.srt'), srt);

  const audio = readJson(join(dir, 'audio.json'), null);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.ffconcat')];
  let hasAudio = false;
  if (audio?.file && existsSync(audio.file) && statSync(audio.file).size > 1000) {
    // The page's clock says when recording began; fall back to when the first piece arrived.
    let audioStart = audio.pageStarted;
    if (!audioStart || Math.abs(audioStart - audio.firstChunkAt) > 60000) audioStart = audio.firstChunkAt - 3000;
    const offset = (audioStart - t0) / 1000;
    if (offset >= 0) args.push('-itsoffset', offset.toFixed(3), '-i', audio.file);
    else args.push('-ss', (-offset).toFixed(3), '-i', audio.file);
    hasAudio = true;
  }
  args.push('-i', join(dir, 'recording.srt'));
  const subIndex = hasAudio ? 2 : 1;
  args.push('-map', '0:v', ...(hasAudio ? ['-map', '1:a'] : []), '-map', `${subIndex}:s`,
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
    frames, audio_chunks: a.chunks || 0, audio_error: a.error || null }, null, 2));
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
  case 'status': status(); break;
  case 'browser': await browser(rest[0], rest[1]); break;
  case 'browser-up': await browserUp(); break;
  case 'browser-down': await browserDown(); break;
  case 'stop': await stop({ noVideo: rest.includes('--no-video') }); break;
  case 'video': {
    const dir = resolve(rest[0] || die('Usage: video <session-folder>'));
    writeTranscript(dir);
    buildVideo(dir) || process.exit(1);
    break;
  }
  default:
    die('Commands: setup, register, start <url> [--name N] [--title T] [--no-record] [--out DIR], say <text>, chat <text>,'
      + ' share, unshare, shot [label], note <text>, status, browser <action> [json], stop [--no-video], video <session-folder>');
}
