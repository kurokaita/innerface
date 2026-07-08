// Claude client for innerFace.
// Calls the Anthropic API directly from the browser (officially supported via
// CORS) using the official SDK loaded from a CDN. The API key is supplied by
// the user at runtime and stored in localStorage — it never touches a server
// of ours because there isn't one.
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk';

const KEY_STORAGE = 'innerface_api_key';

const SYSTEM = `You are innerFace — a calm, slightly wry presence that \
materializes out of falling green code to talk with the user, face to face. \
Your replies are spoken aloud by a voice synthesizer, so write for the ear: \
natural conversational spoken English, short sentences, no markdown, no \
bullet lists, no code blocks, no emoji, no URLs. Keep replies to one to \
three sentences unless the user clearly wants depth. Be warm, curious, and \
direct.`;

export class LLM {
  constructor() {
    this.model = 'claude-opus-4-8';
    this.history = [];
    this._client = null;
    this._clientKey = null;
  }

  get key() { return localStorage.getItem(KEY_STORAGE) || ''; }
  setKey(k) {
    localStorage.setItem(KEY_STORAGE, k);
    this._client = null;
  }
  hasKey() { return !!this.key; }

  _getClient() {
    if (!this._client || this._clientKey !== this.key) {
      this._client = new Anthropic({
        apiKey: this.key,
        dangerouslyAllowBrowser: true,
        // explicit, in case the SDK build doesn't add it for us
        defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      this._clientKey = this.key;
    }
    return this._client;
  }

  // Sends the user's text; calls onSentence(text) for each complete sentence
  // as it streams in, so speech can start before the reply finishes.
  async send(userText, onSentence) {
    const client = this._getClient();
    this.history.push({ role: 'user', content: userText });

    let full = '';
    let pending = '';

    try {
      const stream = client.messages.stream({
        model: this.model,
        max_tokens: 1000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },   // voice chat: favor latency
        messages: this.history,
      });

      stream.on('text', (delta) => {
        full += delta;
        pending += delta;
        // flush complete sentences to the speech queue
        const parts = pending.split(/(?<=[.!?…])\s+/);
        pending = parts.pop();
        for (const s of parts) {
          if (s.trim()) onSentence(s.trim());
        }
      });

      await stream.finalMessage();
    } catch (e) {
      // don't leave a dangling user turn in history on failure
      this.history.pop();
      throw e;
    }

    if (pending.trim()) onSentence(pending.trim());

    this.history.push({ role: 'assistant', content: full });
    // keep the conversation from growing unboundedly
    if (this.history.length > 24) {
      this.history.splice(0, this.history.length - 24);
    }
    return full;
  }
}
