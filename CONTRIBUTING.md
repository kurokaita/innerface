# Contributing to innerFace

Thanks for being interested — this is a weird, fun project and good help is
genuinely welcome. A few notes before you dive in.

## The two things to know up front

1. **The flat-photo path is the crown jewel.** It's the clear, reliable,
   beautiful default. Be careful making changes to anything in its shader
   branch (`js/shaders.js`, the photo block) or the photo pipeline
   (`js/photo.js`). When in doubt, branch off `main` and leave the flat path
   untouched.
2. **The 3D mesh (`G`) is an open research problem**, not a bug-fix target.
   It has a known ceiling (MediaPipe's learned z-depth + coarse noisy
   normals + backdrop compositing). Improvements are welcome but should be
   treated as experiments. See the "open problems" section below.

## Getting set up

```bash
git clone https://github.com/kurokaita/innerface.git
cd innerface
python3 server.py        # → http://localhost:8137
```

No `npm install`, no build step. Edit a `.js` file, reload the page (the dev
server disables caching). For shader changes, hard-refresh
(`Cmd+Shift+R` / `Ctrl+Shift+R`) to bust the browser's shader cache.

You'll want an Anthropic API key to exercise the voice loop, but the visual
core (rain, face, photo-drop, auto-talk demo via `T`) works with no key.

## Where help is especially welcome

- **The 3D mesh.** It needs real work. Promising directions: monocular depth
  estimation (e.g. Depth Anything V2 via transformers.js) to replace
  MediaPipe's z; proper G-buffer compositing so the mesh doesn't ghost over a
  static backdrop; normal reconstruction that preserves readable eye/mouth
  detail instead of turning them into shadow voids.
- **The procedural face's character.** It's built from symmetric gaussian
  bumps and can read as "alien." Real anthropometric proportions, controlled
  asymmetry, and breaking up the gaussian smoothness would all help.
- **TTS / lip sync.** The ElevenLabs path has timestamped visemes; the
  browser-TTS fallback uses word boundaries. More viseme coverage, better
  smoothing, or additional TTS providers all welcome.
- **Browser support.** Firefox has no SpeechRecognition; a Web Speech API
  polyfill or Whisper-in-browser path would close the gap.

## Open problems (good first issues for the brave)

- **Mesh readability.** Why does the mesh read as a "masquerade mask" instead
  of a face? The honest answer is "lit coarse geometry isn't a face," but
  partial fixes (eye-lift in the mesh branch, depth prior tuning) are
  worth attempting behind the `G` toggle.
- **Washout on flat-lit photos.** The mesh shader multiplies the photo's
  baked brightness by 3D lighting and clips. A tonemap + albedo rebalance is
  in place but flat-lit photos still don't look as good as dramatic ones.

## How to propose a change

1. **Open an issue first** for anything non-trivial — especially shader or
   mesh work. A quick "I'm thinking of doing X, does that sound right?" saves
   everyone time.
2. **Branch off `main`.** Keep the flat-photo path working.
3. **One concern per PR.** Easier to review, easier to revert if needed.
4. **Test on a few photos** if you touch the photo/mesh paths — behavior
   varies a lot between frontal, 3/4, and stylized images.
5. **Don't add a build step or a framework** without discussing it. The
   no-build, vanilla-JS, static-file architecture is a feature.

## Code style

- **Vanilla ES modules**, no bundler, no TypeScript. Keep it that way unless
  there's a compelling reason.
- **2-space indent**, semicolons, single quotes for strings.
- **Comments explain *why*, not *what*.** The shader especially benefits from
  notes on the math.
- **No secrets in code.** Keys are entered at runtime and stored in
  `localStorage`; never hardcode one, even for a test.

## Committing

We use **Conventional Commits**-ish messages, but don't stress about the
format — a clear subject line in the imperative mood ("add iterative
parallax to photo branch") is what matters. Keep history readable; squash
noisy WIP commits before a PR.

## Reporting bugs

A good bug report has:

- Browser + OS.
- What you did (which key, which image, frontal or 3/4 photo).
- What you saw vs. what you expected.
- The status-line text (bottom-left) — it often tells you what state she was
  in.
- A screenshot or screen recording if it's visual.

For visual bugs in the mesh path, note whether it reproduces on the flat path
too (it probably won't — they're isolated branches).

## Questions?

Open a [Discussion](https://github.com/kurokaita/innerface/discussions) or an
issue with the `question` label. Be patient and kind — see the
[Code of Conduct](CODE_OF_CONDUCT.md).
