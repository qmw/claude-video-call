# claude-video-call

A Claude Code plugin that puts Claude on your Google Meet call.

- **It talks.** You speak, Claude hears it as text and answers out loud.
- **It shares its screen.** Claude shares a real Chrome tab that it clicks, scrolls and types in while you watch. It shares by itself when it organized the meeting, and otherwise when you ask.
- **It watches your screen.** Share your screen and Claude takes labelled screenshots and writes notes, so a later session can implement what you showed.
- **It records.** The whole call is saved as `recording.mp4`: the meeting view, the sound, and captions of who said what.

At the end, Claude writes a summary next to the notes, screenshots, transcript and video, in `~/video-calls/<date>_<topic>/`.

## Install

In Claude Code:

```
/plugin marketplace add qmw/claude-video-call
/plugin install video-call@claude-video-call
```

Without the plugin system, run this to copy the skill into `~/.claude/skills/video-call`:

```sh
curl -fsSL https://raw.githubusercontent.com/qmw/claude-video-call/main/install.sh | sh
```

Then start a new session and say, for example, "create a Meet and share your screen", or paste a Meet link and say "join this call". On the first call Claude runs the setup and helps you create an AgentCall account.

## What you need

- Node.js 18 or newer, `curl`, `tar`, `npm`, and Google Chrome.
- Your own [AgentCall](https://agentcall.dev) account. Claude can create it with your email address. No keys come with this plugin.
- To let Claude create meetings: a Google Calendar connector on your own account. Without one, paste a Meet link.
- ffmpeg to build the video. If you don't have it, setup downloads a static build from npm (about 70 MB).
- Under WSL2: `networkingMode=mirrored` in `.wslconfig`.

## Good to know

- AgentCall is a paid third-party service. Meeting audio, video and the shared tab pass through it. Check its [pricing](https://agentcall.dev/pricing) and [privacy policy](https://agentcall.dev/privacy).
- Claude announces the recording when it greets people. Recording a call can need everyone's consent where you live. Say "don't record" to turn it off.
- The video is the meeting as the bot sees it, at one still every 2 seconds. That works for screens and slides, not for smooth motion.
- The audio is recorded by the bot's camera page, which receives the meeting audio as its microphone. If that ever fails, the video still has captions.
- English only.
- The shared Chrome is a separate, empty profile, so it isn't signed in to your accounts. Google and some other sites may show it a robot check.
- Session folders can contain whatever people showed on the call. They stay on your computer.
- Tested on Windows 11 with WSL2 and Google Meet. macOS, plain Linux, Teams and Zoom are untested.

## How it works

`skills/video-call/scripts/call.mjs` is the command line Claude uses. It starts:

- AgentCall's bridge, which runs the bot in the meeting. AgentCall's MIT-licensed client is downloaded at a pinned commit by `setup` and isn't bundled here.
- `browser-server.mjs`, a headless Chrome tab streamed into the meeting. Its control port is never exposed to the meeting.
- `session-server.mjs`, which serves the bot's camera page with a small audio recorder, saves screenshots, and keeps the transcript.

`stop` removes the bot through AgentCall's API so it stops charging, then builds the video with ffmpeg.

## License

MIT
