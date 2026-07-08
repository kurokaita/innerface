// innerFace — main entry point.
// Wires the renderer, face, and audio into a state machine with a demo loop
// that shows the face emerging from the Matrix rain and "talking".
import { Renderer } from './renderer.js';
import { Face, EXPRESSION_NAMES, phonemeToViseme } from './face.js';
import { createGlyphAtlas } from './glyphs.js';
import { AudioMeter } from './audio.js';
import { processImage, savePhoto, loadSavedPhoto } from './photo.js';
import { buildFaceMesh } from './mesh.js';
import { LLM } from './llm.js';
import { STT, TTS } from './speech.js';
import { ElevenTTS } from './eleven.js';

function lerp(a, b, t) { return a + (b - a) * t; }

const canvas = document.getElementById('gl');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add('show');
}

// ---- init ----------------------------------------------------------------
let renderer, face, audio;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  showError('WebGL init failed:\n' + e.message);
  throw e;
}

const atlas = createGlyphAtlas();
renderer.setGlyphTexture(atlas.canvas, atlas.grid, atlas.count);

face = new Face();

audio = new AudioMeter();

// ---- state ---------------------------------------------------------------
const state = {
  faceOn: false,
  faceReveal: 0,         // smoothed 0..1
  targetReveal: 0,
  autoTalk: false,       // demo babble; off by default — she waits, blinks, watches
  exprIndex: 0,
  tint: [0.34, 0.99, 0.64],   // classic matrix green
  // demo talking timeline
  talkT: 0,
  nextVisemeAt: 0,
  nextExprAt: 0,
  // photo mode
  photoLoaded: false,
  photoOn: false,
  photoLm: null,
  meshOn: false,          // 3D face-mesh rendering (needs raw landmarks)
  // conversation
  brain: localStorage.getItem('innerface_brain') || 'chat',  // survives reload
  mode: 'idle',           // idle | listening | thinking | speaking
  llmDone: true,          // stream finished (speech may still be draining)
  visemeQueue: [],
  visemeAt: 0,
  speakEnergy: 0,         // synthetic "voice level" while TTS talks
};

// ---- voice conversation ------------------------------------------------
const llm = new LLM();
const stt = new STT();
const tts = new TTS();
const eleven = new ElevenTTS();
eleven.onViseme = (v) => face.setViseme(v, 1.0);

function voiceBusy() { return tts.busy || eleven.busy; }
function cancelSpeech() {
  tts.cancel();
  eleven.cancel();
  state.visemeQueue.length = 0;
}

const keybox = document.getElementById('keybox');
const keyinput = document.getElementById('keyinput');
const eleveninput = document.getElementById('eleveninput');
let keyboxCb = null;

function showKeyBox(cb) {
  keyboxCb = cb || null;
  keyinput.value = llm.key;
  eleveninput.value = eleven.key;
  keybox.classList.add('show');
  keyinput.focus();
}
function hideKeyBox() {
  keybox.classList.remove('show');
  keyinput.blur();
  eleveninput.blur();
}
keybox.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const k = keyinput.value.trim();
    if (k) llm.setKey(k);
    eleven.setKey(eleveninput.value.trim());
    hideKeyBox();
    setStatus(k
      ? 'keys saved (browser-local)' + (eleven.enabled ? ' · ElevenLabs voice ON' : '')
      : 'no Anthropic key entered');
    if (k && keyboxCb) { const cb = keyboxCb; keyboxCb = null; cb(); }
  } else if (e.key === 'Escape') {
    hideKeyBox();
    setStatus('key entry cancelled');
  }
});

// light-direction slider — relights the photo face (flat and mesh both use it)
const lightctl = document.getElementById('lightctl');
const lightaz = document.getElementById('lightaz');
const lightel = document.getElementById('lightel');
state.lightDir = [parseFloat(lightaz.value), parseFloat(lightel.value)];
const readLight = () => {
  state.lightDir = [parseFloat(lightaz.value), parseFloat(lightel.value)];
};
lightaz.addEventListener('input', readLight);
lightel.addEventListener('input', readLight);
// show the LIGHT control whenever a photo face is active (needs the depth
// field to compute normals); hidden for the procedural face.
function syncLightCtl() {
  lightctl.classList.toggle('show', !!(state.photoOn && state.photoLoaded && state.photoLm));
}

// help menu (the round "?" button)
const helpbtn = document.getElementById('helpbtn');
const helpmenu = document.getElementById('helpmenu');
function toggleHelp(force) {
  const show = force !== undefined ? force : !helpmenu.classList.contains('show');
  helpmenu.classList.toggle('show', show);
  helpbtn.classList.toggle('open', show);
}
helpbtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(); helpbtn.blur(); });
window.addEventListener('click', (e) => {
  if (helpmenu.classList.contains('show') && !helpmenu.contains(e.target)) toggleHelp(false);
});

const saybox = document.getElementById('saybox');
const sayinput = document.getElementById('sayinput');

function showSayBox() {
  if (state.brain !== 'agent' && !llm.hasKey()) { showKeyBox(() => showSayBox()); return; }
  sayinput.value = '';
  saybox.classList.add('show');
  sayinput.focus();
}
sayinput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const t = sayinput.value.trim();
    saybox.classList.remove('show');
    sayinput.blur();
    if (t) {
      cancelSpeech();
      handleUserText(t);
    }
  } else if (e.key === 'Escape') {
    saybox.classList.remove('show');
    sayinput.blur();
  }
});

function maybeFinishSpeaking() {
  if (state.llmDone && !voiceBusy() && state.mode === 'speaking') {
    state.mode = 'idle';
    state.visemeQueue.length = 0;
    face.setExpression('neutral');
    setStatus('your move — V to talk');
  }
}

function onSpeechStart() {
  if (state.mode !== 'speaking') {
    state.mode = 'speaking';
    face.setExpression('neutral');
    setStatus('speaking…');
  }
}

function speakSentence(text) {
  if (eleven.enabled) {
    eleven.speak(text, {
      onStart: onSpeechStart,
      onDone: () => maybeFinishSpeaking(),
      onError: (e) => {
        setStatus(e.status === 401
          ? 'bad ElevenLabs key — press K to fix it'
          : 'voice error: ' + (e.message || e));
      },
    });
    return;
  }
  tts.speak(text, {
    onStart: onSpeechStart,
    onWord: (word) => {
      state.speakEnergy = 1.0;
      for (const ch of word.toUpperCase()) {
        if (/[A-Z]/.test(ch)) state.visemeQueue.push(phonemeToViseme(ch));
      }
      state.visemeQueue.push('rest');
    },
    onDone: () => maybeFinishSpeaking(),
  });
}

// strip markdown so agent replies read well aloud (belt and braces — the
// agent is also instructed to answer in plain spoken English)
function speechify(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[*_#>|]/g, '');
}

async function askAgent(text) {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: text }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || data.error) throw new Error(data.error || 'agent HTTP ' + res.status);
  return data.text || '';
}

async function handleUserText(text) {
  state.mode = 'thinking';
  state.llmDone = false;
  state.autoTalk = false;
  face.setExpression('thinking');
  setStatus(state.brain === 'agent'
    ? 'coding agent working… (this can take a while)'
    : 'thinking… (“' + text + '”)');
  try {
    if (state.brain === 'agent') {
      const reply = await askAgent(text);
      for (const s of speechify(reply).split(/(?<=[.!?…])\s+/)) {
        if (s.trim()) speakSentence(s.trim());
      }
    } else {
      await llm.send(text, speakSentence);
    }
    state.llmDone = true;
    maybeFinishSpeaking();
    // reply may have been empty or TTS unsupported
    if (!voiceBusy() && state.mode !== 'speaking') {
      state.mode = 'idle';
      face.setExpression('neutral');
      setStatus('your move — V to talk');
    }
  } catch (e) {
    console.error('LLM request failed:', e);
    state.llmDone = true;
    state.mode = 'idle';
    face.setExpression('concerned');
    const msg = (e && e.status === 401)
      ? 'bad API key — press K to fix it'
      : 'LLM error: ' + (e.message || e);
    setStatus(msg);
  }
}

function startListening() {
  if (!stt.supported) {
    setStatus('speech recognition not supported in this browser (try Chrome)');
    return;
  }
  if (state.brain !== 'agent' && !llm.hasKey()) {
    showKeyBox(() => startListening());
    return;
  }
  // interrupt her if she's mid-sentence
  cancelSpeech();
  state.mode = 'listening';
  state.faceOn = true;
  state.targetReveal = 1;
  face.setExpression('neutral');
  face.nod();   // small acknowledging nod: I'm listening
  setStatus('listening… (speak, then pause)');
  stt.start({
    onInterim: (t) => setStatus('listening… “' + t + '”'),
    onFinal: (t) => { console.log('[stt] final transcript:', t); handleUserText(t); },
    onEnd: (t) => {
      if (!t && state.mode === 'listening') {
        state.mode = 'idle';
        setStatus('heard nothing — V to try again');
      }
    },
    onError: (err) => {
      state.mode = 'idle';
      setStatus('mic error: ' + err + (err === 'not-allowed' ? ' (allow microphone access)' : ''));
    },
  });
}

// ---- photo mode ------------------------------------------------------------
async function usePhoto(blob) {
  setStatus('processing photo…');
  try {
    const { canvas, landmarks, raw, connections, fit } = await processImage(blob);
    renderer.setPhotoTexture(canvas);
    state.photoLoaded = true;
    state.photoOn = true;
    state.photoLm = landmarks;

    // build the 3D mesh if we got the full landmark scan (kept opt-in via G:
    // the mesh's noisy MediaPipe depth + coarse normals can read as "not a
    // face" on many photos, so the clear flat-photo look stays the default)
    let meshBuilt = false;
    if (raw && connections) {
      try {
        renderer.setFaceMesh(buildFaceMesh(raw, connections, fit, fit.SIZE));
        meshBuilt = true;
      } catch (err) {
        console.warn('mesh build failed:', err);
        renderer.setFaceMesh(null);
      }
    } else {
      renderer.setFaceMesh(null);
    }
    state.meshOn = false;   // off by default — press G to try the 3D mesh
    syncLightCtl();

    state.faceOn = true;
    state.targetReveal = 1;
    setStatus(landmarks
      ? 'photo face ready — drag LIGHT to move the key light · P toggles procedural'
      : 'photo face ready — no landmarks found · P toggles procedural');
    savePhoto(canvas, landmarks);   // she remembers this face next time
  } catch (e) {
    setStatus('photo failed: ' + e.message);
  }
}

// ---- face reveal helper --------------------------------------------------
function revealFace(msg) {
  if (state.faceOn) return;            // already showing — don't fight a toggle
  state.faceOn = true;
  state.targetReveal = 1;
  if (msg) setStatus(msg);
}

// restore the last face she wore on startup (unless a fresh drop beats us).
// Coordinates with the timed reveal below so the procedural face never flashes
// over a photo that is still loading from IndexedDB.
let photoRestorePending = true;
loadSavedPhoto().then((saved) => {
  photoRestorePending = false;
  if (saved && !state.photoLoaded) {
    renderer.setPhotoTexture(saved.canvas);
    state.photoLoaded = true;
    state.photoOn = true;
    state.photoLm = saved.landmarks;
    syncLightCtl();
    revealFace(saved.landmarks
      ? 'welcome back — she remembers this face · V to talk'
      : 'welcome back · V to talk');
  } else if (!state.faceOn) {
    // no saved photo (or a drop beat us) — show the procedural face now
    revealFace('she’s listening for you — press V to talk');
  }
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) usePhoto(f);
});
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) { usePhoto(it.getAsFile()); break; }
  }
});

// cycle through a fake "speaking" stream of visemes
const PHONEMES = ['A','E','I','O','U','L','N','T','D','M','B','P','F','V'];
function pickViseme() {
  const p = PHONEMES[Math.floor(Math.random() * PHONEMES.length)];
  return phonemeToViseme(p);
}

function setStatus(s) {
  const tag = state.brain === 'agent' ? '[agent] ' : '[chat] ';
  statusEl.textContent = tag + s;
}

// ---- resize --------------------------------------------------------------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  renderer.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---- controls ------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (keybox.classList.contains('show') || saybox.classList.contains('show')) return;
  switch (e.code) {
    case 'Enter':
      showSayBox();
      break;
    case 'KeyV':
      if (state.mode === 'listening') {
        stt.stop();
      } else {
        startListening();
      }
      break;
    case 'KeyH':
      toggleHelp();
      break;
    case 'Escape':
      toggleHelp(false);
      break;
    case 'KeyK':
      showKeyBox();
      break;
    case 'KeyA':
      state.brain = state.brain === 'chat' ? 'agent' : 'chat';
      localStorage.setItem('innerface_brain', state.brain);
      setStatus(state.brain === 'agent'
        ? 'brain: coding agent (claude -p via local server)'
        : 'brain: chat (Anthropic API)');
      break;
    case 'Space':
      e.preventDefault();
      state.faceOn = !state.faceOn;
      state.targetReveal = state.faceOn ? 1 : 0;
      setStatus(state.faceOn ? 'face: ON' : 'face: off');
      break;
    case 'KeyM':
      if (audio.usingMic) {
        audio.disable();
        setStatus('mic: off (fallback)');
      } else {
        audio.enableMic().then(ok => {
          setStatus(ok ? 'mic: ON' : 'mic denied — using fallback');
          if (!ok) audio.enableFallback();
        });
      }
      break;
    case 'KeyG':
      if (renderer.mesh) {
        state.meshOn = !state.meshOn;
        setStatus('face: ' + (state.meshOn ? '3D mesh (experimental)' : 'flat photo'));
      } else {
        setStatus('no 3D mesh — drop a clear front-facing photo');
      }
      break;
    case 'KeyT':
      state.autoTalk = !state.autoTalk;
      setStatus('auto-talk: ' + (state.autoTalk ? 'ON' : 'off'));
      break;
    case 'KeyE':
      state.exprIndex = (state.exprIndex + 1) % EXPRESSION_NAMES.length;
      const name = EXPRESSION_NAMES[state.exprIndex];
      face.setExpression(name);
      setStatus('expression: ' + name);
      break;
    case 'KeyP':
      if (state.photoLoaded) {
        state.photoOn = !state.photoOn;
        syncLightCtl();
        setStatus(state.photoOn ? 'face: photo · drag LIGHT to move the key light' : 'face: procedural');
      } else {
        setStatus('no photo loaded — drop or paste an image');
      }
      break;
    case 'KeyF':
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
      break;
  }
});

// startup reveal: wait for the IndexedDB restore to resolve first, so a
// restored photo reveals cleanly instead of flashing the procedural face.
setTimeout(() => {
  if (photoRestorePending) return;     // restore still running — it will reveal
  if (!state.faceOn) revealFace('she’s listening for you — press V to talk');
}, 1200);

// ---- main loop -----------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // audio
  audio.update(dt);

  // reveal smoothing
  state.faceReveal += (state.targetReveal - state.faceReveal) * Math.min(1, dt * 2.5);

  // real speech: drain the viseme queue while she talks
  state.speakEnergy = Math.max(0, state.speakEnergy - dt * 2.2);
  eleven.update();   // fires timestamped visemes for the ElevenLabs voice
  if (eleven.playing) {
    const lvl = eleven.level;
    state.speakEnergy = Math.max(state.speakEnergy, lvl);
    // syllable sync: mouth magnitude follows the actual audio envelope.
    // Fast attack (mouth opens on the pulse), slower release (holds through
    // brief intra-syllable dips instead of fluttering).
    const target = Math.min(1, lvl * 2.2);
    face.voiceEnergy = target > face.voiceEnergy
      ? lerp(face.voiceEnergy, target, Math.min(1, dt * 30))
      : lerp(face.voiceEnergy, target, Math.min(1, dt * 8));
  } else {
    face.voiceEnergy = 1.0;   // no audio tap (browser TTS) → visemes at full
  }
  if (state.mode === 'speaking' && state.visemeQueue.length) {
    state.visemeAt -= dt;
    if (state.visemeAt <= 0) {
      face.setViseme(state.visemeQueue.shift(), 1.0);
      state.visemeAt = 0.075;
    }
  }

  // demo talking: drive visemes + rotate expressions while face is shown
  if (state.autoTalk && state.mode === 'idle' && state.faceReveal > 0.5) {
    state.talkT += dt;
    if (state.talkT >= state.nextVisemeAt) {
      const v = pickViseme();
      face.setViseme(v, 1.0);
      state.nextVisemeAt = state.talkT + 0.08 + Math.random() * 0.14;
    }
    if (state.talkT >= state.nextExprAt) {
      // mostly stay neutral/happy; occasionally think/surprised
      const roll = Math.random();
      let expr = 'neutral';
      if (roll < 0.15) expr = 'thinking';
      else if (roll < 0.25) expr = 'happy';
      else if (roll < 0.32) expr = 'surprised';
      else if (roll < 0.38) expr = 'concerned';
      face.setExpression(expr);
      state.nextExprAt = state.talkT + 1.5 + Math.random() * 2.5;
    }
  }

  // she turns toward you when the conversation is live, wanders when idle
  face.attentive = state.mode !== 'idle';

  // face update (computes params; no canvas)
  face.update(dt);

  // audio influences reveal subtly and drives mouth energy
  const aud = Math.max(audio.level, state.speakEnergy * 0.6);
  const reveal = Math.min(1, state.faceReveal + aud * 0.05);

  renderer.render(dt, {
    faceReveal: reveal,
    audio: aud,
    tint: state.tint,
    photoOn: state.photoOn ? 1 : 0,
    photoHasLm: state.photoLm ? 1 : 0,
    photoEyeL: state.photoLm ? state.photoLm.eyeL : [0, 0],
    photoEyeR: state.photoLm ? state.photoLm.eyeR : [0, 0],
    photoMouth: state.photoLm ? state.photoLm.mouth : [0, 0, 0],
    photoHasDepth: state.photoLm && state.photoLm.hasDepth ? 1 : 0,
    photoChinY: state.photoLm && state.photoLm.chinY ? state.photoLm.chinY : 0.85,
    ...face.params,
    meshOn: state.photoOn && state.meshOn ? 1 : 0,
    lightDir: state.lightDir,
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
