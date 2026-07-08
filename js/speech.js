// Browser speech I/O for innerFace.
// STT: SpeechRecognition (built into Chrome/Safari — free, no key).
// TTS: speechSynthesis, with word-boundary events so the face can lip-sync.

export class STT {
  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.listening = false;
    this.rec = null;
    if (SR) {
      this.rec = new SR();
      this.rec.continuous = false;      // stop automatically on silence
      this.rec.interimResults = true;
      this.rec.lang = 'en-US';
    }
  }

  start({ onInterim, onFinal, onEnd, onError }) {
    if (!this.rec || this.listening) return;
    this.listening = true;

    let finalText = '';
    this.rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim && onInterim) onInterim(interim);
    };
    this.rec.onerror = (e) => {
      this.listening = false;
      if (onError) onError(e.error);
    };
    this.rec.onend = () => {
      this.listening = false;
      const text = finalText.trim();
      if (text && onFinal) onFinal(text);
      if (onEnd) onEnd(text);
    };
    this.rec.start();
  }

  stop() {
    if (this.rec && this.listening) this.rec.stop();
  }

  abort() {
    if (this.rec && this.listening) {
      this.rec.onend = null;
      this.rec.abort();
      this.listening = false;
    }
  }
}

export class TTS {
  constructor() {
    this.supported = 'speechSynthesis' in window;
    this.voice = null;
    this.activeCount = 0;   // utterances queued or speaking
    if (this.supported) {
      const pick = () => { this.voice = this._pickVoice(); };
      pick();
      window.speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  _pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const prefs = ['Samantha', 'Google US English', 'Google UK English Female', 'Karen', 'Daniel'];
    for (const name of prefs) {
      const v = voices.find(v => v.name.includes(name));
      if (v) return v;
    }
    return voices.find(v => v.lang.startsWith('en')) || voices[0];
  }

  // Queue a sentence. Callbacks:
  //   onStart()      — this utterance began
  //   onWord(word)   — word boundary (drives visemes)
  //   onDone()       — this utterance finished (also fired on error/cancel)
  speak(text, { onStart, onWord, onDone } = {}) {
    if (!this.supported) { if (onDone) onDone(); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.02;
    u.pitch = 0.95;

    this.activeCount++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (onDone) onDone();
    };

    u.onstart = () => { if (onStart) onStart(); };
    u.onboundary = (e) => {
      if (e.name !== 'word' || !onWord) return;
      const m = text.slice(e.charIndex).match(/^\S+/);
      if (m) onWord(m[0]);
    };
    u.onend = finish;
    u.onerror = finish;

    window.speechSynthesis.speak(u);   // queues natively behind prior utterances
  }

  cancel() {
    if (!this.supported) return;
    window.speechSynthesis.cancel();   // fires onerror/onend on queued utterances
    this.activeCount = 0;
  }

  get busy() {
    return this.activeCount > 0;
  }
}
