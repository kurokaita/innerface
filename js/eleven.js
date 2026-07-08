// ElevenLabs voice engine for innerFace.
// Fetches each sentence with character-level timestamps, plays it through
// WebAudio, and exposes:
//   - a viseme timeline fired at the exact moment each sound is spoken
//   - a live amplitude level (the face glows with the actual audio)
// Called directly from the browser; the key lives in localStorage only.
import { phonemeToViseme } from './face.js';

const KEY_STORAGE = 'innerface_eleven_key';
const VOICE_STORAGE = 'innerface_eleven_voice';
//const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';   // "Rachel" — warm, natural
const DEFAULT_VOICE = 'ZkDZ5VCyH0GGbxO7o4aO'; // "Ann" - Friendly, Relaxed, Australian
const MODEL_ID = 'eleven_turbo_v2_5';            // low latency, good quality

export class ElevenTTS {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this._data = null;
    this.queue = [];             // sentences fetching/awaiting playback
    this.playing = false;
    this.currentSource = null;
    this.visemeTimeline = [];    // [{t, v}] for the current utterance
    this.startedAt = 0;
    this.onViseme = null;        // set by main.js
    this.activeCount = 0;        // queued or playing
    this._aborts = new Set();
  }

  get key() { return localStorage.getItem(KEY_STORAGE) || ''; }
  setKey(k) {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  }
  get voiceId() { return localStorage.getItem(VOICE_STORAGE) || DEFAULT_VOICE; }
  get enabled() { return !!this.key; }
  get busy() { return this.activeCount > 0; }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this._data = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // live RMS of what's playing right now, 0..1
  get level() {
    if (!this.playing || !this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this._data);
    let sum = 0;
    for (let i = 0; i < this._data.length; i++) {
      const d = (this._data[i] - 128) / 128;
      sum += d * d;
    }
    return Math.min(1, Math.sqrt(sum / this._data.length) * 4);
  }

  // call once per frame: fires visemes whose timestamp has arrived
  update() {
    if (!this.playing || !this.visemeTimeline.length || !this.onViseme) return;
    const t = this.ctx.currentTime - this.startedAt;
    while (this.visemeTimeline.length && this.visemeTimeline[0].t <= t) {
      this.onViseme(this.visemeTimeline.shift().v);
    }
  }

  speak(text, cb = {}) {
    this._ensureCtx();
    const item = { text, cb, result: null, failed: null };
    item.promise = this._fetch(item);   // prefetch immediately (parallel)
    this.queue.push(item);
    this.activeCount++;
    if (!this.playing) this._playNext();
  }

  async _fetch(item) {
    const ac = new AbortController();
    this._aborts.add(ac);
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: item.text, model_id: MODEL_ID }),
          signal: ac.signal,
        },
      );
      if (!res.ok) {
        const err = new Error('ElevenLabs HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      const bytes = Uint8Array.from(atob(json.audio_base64), (c) => c.charCodeAt(0));
      const buffer = await this.ctx.decodeAudioData(bytes.buffer);
      item.result = { buffer, alignment: json.alignment };
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('ElevenLabs fetch failed:', e);
        item.failed = e;
      } else {
        item.failed = e;
      }
    } finally {
      this._aborts.delete(ac);
    }
  }

  _buildTimeline(alignment) {
    this.visemeTimeline = [];
    if (!alignment) return;
    const chars = alignment.characters || [];
    const starts = alignment.character_start_times_seconds || [];
    for (let i = 0; i < chars.length && i < starts.length; i++) {
      const c = chars[i].toUpperCase();
      if (/[A-Z]/.test(c)) {
        this.visemeTimeline.push({ t: starts[i], v: phonemeToViseme(c) });
      } else if (/\s/.test(c) || /[.,!?…]/.test(c)) {
        this.visemeTimeline.push({ t: starts[i], v: 'rest' });
      }
    }
  }

  async _playNext() {
    const item = this.queue.shift();
    if (!item) { this.playing = false; return; }
    this.playing = true;
    await item.promise;

    if (item.failed || !item.result) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (item.failed && item.failed.name !== 'AbortError' && item.cb.onError) {
        item.cb.onError(item.failed);
      }
      if (item.cb.onDone) item.cb.onDone();
      return this._playNext();
    }

    const { buffer, alignment } = item.result;
    this._buildTimeline(alignment);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    this.currentSource = src;
    this.startedAt = this.ctx.currentTime;
    if (item.cb.onStart) item.cb.onStart();
    src.onended = () => {
      this.currentSource = null;
      this.visemeTimeline = [];
      if (this.onViseme) this.onViseme('rest');
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (item.cb.onDone) item.cb.onDone();
      this._playNext();
    };
    src.start();
  }

  cancel() {
    for (const ac of this._aborts) ac.abort();
    this._aborts.clear();
    this.queue = [];
    this.visemeTimeline = [];
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch (e) { /* already stopped */ }
      this.currentSource = null;
    }
    this.playing = false;
    this.activeCount = 0;
  }
}
