// Audio level meter.
// Tries to use the microphone; if denied/unavailable, falls back to a
// synthetic envelope so the face still "talks" in the demo.

export class AudioMeter {
  constructor() {
    this.level = 0.0;
    this.peak = 0.0;
    this.usingMic = false;
    this.enabled = false;
    this._ctx = null;
    this._analyser = null;
    this._data = null;
    this._fallbackT = 0;
  }

  async enableMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this._ctx.createMediaStreamSource(stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 512;
      this._analyser.smoothingTimeConstant = 0.6;
      src.connect(this._analyser);
      this._data = new Uint8Array(this._analyser.frequencyBinCount);
      this.usingMic = true;
      this.enabled = true;
      return true;
    } catch (e) {
      this.usingMic = false;
      return false;
    }
  }

  // synthetic speech-like envelope for the demo when no mic
  enableFallback() {
    this.enabled = true;
    this.usingMic = false;
    this._fallbackT = 0;
  }

  disable() {
    this.enabled = false;
    this.level = 0;
  }

  // call every frame; updates this.level (0..1)
  update(dt) {
    if (!this.enabled) {
      this.level *= 0.9;
      return;
    }

    if (this.usingMic && this._analyser) {
      this._analyser.getByteFrequencyData(this._data);
      // focus on speech band (~85Hz-3kHz)
      let sum = 0;
      const n = Math.min(this._data.length, 64);
      for (let i = 1; i < n; i++) sum += this._data[i];
      const avg = sum / (n - 1) / 255;
      this.level = Math.min(1, avg * 2.4);
    } else {
      // fallback: pulsing syllable-like envelope
      this._fallbackT += dt;
      const t = this._fallbackT;
      const syll = Math.max(0, Math.sin(t * 7.0)) * (0.6 + 0.4 * Math.sin(t * 0.7));
      const gap = Math.sin(t * 0.31) > -0.2 ? 1 : 0.15;
      this.level = Math.min(1, syll * gap * 0.8);
    }
  }
}
