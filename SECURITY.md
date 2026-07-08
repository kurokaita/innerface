# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in innerFace, **please do
not open a public issue**. Instead, report it privately:

- Email: **mornslayer@gmail.com**
- Or open a private security advisory: GitHub repo → Security →
  "Report a vulnerability"

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce (proof of concept if possible).
- The browser and OS you tested on.

You'll get an acknowledgment within **72 hours**, and we'll work with you on
disclosure timing once a fix is ready. Please give us a reasonable window to
patch before any public disclosure.

## Supported Versions

innerFace is an early-stage, single-branch project. Only the latest `main` is
supported with security fixes.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| older commits | No |

## Threat Model & Trust Boundaries

innerFace is unusual in that **there is no backend of ours in the critical
path.** It's important to understand where your data actually goes:

### API keys

- Keys (Anthropic, ElevenLabs) are entered by you at runtime and stored in
  `localStorage` under `innerface_api_key` / `innerface_eleven_key`.
- They are sent **only** to the vendor whose key it is (Anthropic / ElevenLabs),
  directly from your browser over HTTPS.
- They are **never** sent to any innerFace server, because there isn't one in
  the default configuration.
- They are **never** hardcoded in the source.

**Risk:** `localStorage` is readable by any JavaScript running on the same
origin. If you load innerFace on an untrusted origin (e.g. a fork or a mirror
you don't control), that origin's code could read your keys. **Only enter keys
on an origin you trust** — ideally one you run yourself via `python3 server.py`.

### Photos

- Dropped/pasted images are processed entirely in the browser (canvas +
  MediaPipe landmarks, both client-side).
- The processed face is stored in **IndexedDB** locally so she remembers it
  across reloads.
- Photos **never** leave your browser in the default configuration.

### Microphone

- The microphone is opt-in (`M` to drive the glow, `V` for voice input).
- Audio is processed locally: the level meter uses a WebAudio `AnalyserNode`,
  and speech recognition uses the browser's built-in `SpeechRecognition` (the
  audio goes wherever your browser sends it for that feature — typically a
  cloud service operated by the browser vendor).

### The optional agent relay (`server.py`)

This is the one component that introduces a server, and it has a deliberate,
narrow design:

- **Bound to `127.0.0.1` only.** It does not listen on any public interface.
  It is not reachable from outside your machine.
- **`POST /api/agent`** relays a prompt to a local `claude -p` CLI on your
  machine. It runs a local subprocess with the prompt you sent.
- **No auth.** Because it's localhost-only, the trust boundary is "any local
  process on your machine." Any website you visit cannot reach it directly
  (browsers enforce CORS / same-origin), but be aware that local processes can.

**Risk:** If you change `server.py` to bind to `0.0.0.0` or a public
interface, you expose an unauthenticated endpoint that can run the agent CLI
on your machine. **Do not do this.** If you need remote access, put it behind
proper auth and a reverse proxy.

## What is explicitly out of scope

- **Content of conversations.** What you say to the LLM goes to the LLM
  provider (Anthropic) under your account, governed by their privacy policy.
  innerFace does not log or relay it anywhere else.
- **The LLM providers' own security.** Report those to the respective vendors.

## Hardening checklist (for self-hosters)

- Run `python3 server.py` and use `http://localhost:8137` — don't host it on
  a public origin unless you've thought about the key-exposure implications.
- Don't enter API keys on mirrors/forks you don't control.
- Keep `server.py` bound to `127.0.0.1`.
- Clear browser data for the origin to wipe saved keys/photos when you're done.
