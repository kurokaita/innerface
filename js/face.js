// Face parameter computer.
// No canvas drawing — the face is rendered procedurally in the shader from a
// heightmap. This module just computes the animated scalar params each frame
// (expressions, visemes, blink, idle motion) and exposes them as a flat object
// the renderer uploads as uniforms.

// ---- expression definitions ----------------------------------------------
const EXPRS = {
  neutral: {
    browLift: 0.0, browTilt: 0.0, eyeOpen: 1.0, pupilX: 0.0, pupilY: 0.0,
    mouthOpen: 0.0, mouthCurve: 0.0, cheek: 0.0, tilt: 0.0,
  },
  happy: {
    browLift: 0.25, browTilt: -0.3, eyeOpen: 0.85, pupilX: 0.0, pupilY: 0.1,
    mouthOpen: 0.15, mouthCurve: 0.8, cheek: 0.7, tilt: -0.05,
  },
  thinking: {
    browLift: 0.5, browTilt: 0.4, eyeOpen: 0.7, pupilX: -0.3, pupilY: -0.2,
    mouthOpen: 0.0, mouthCurve: -0.2, cheek: 0.0, tilt: 0.12,
  },
  surprised: {
    browLift: 0.9, browTilt: 0.0, eyeOpen: 1.3, pupilX: 0.0, pupilY: 0.0,
    mouthOpen: 0.8, mouthCurve: 0.0, cheek: 0.0, tilt: 0.0,
  },
  concerned: {
    browLift: -0.2, browTilt: 0.6, eyeOpen: 0.9, pupilX: 0.1, pupilY: 0.15,
    mouthOpen: 0.05, mouthCurve: -0.4, cheek: 0.0, tilt: 0.05,
  },
};

// ---- viseme definitions (mouth shapes) -----------------------------------
// Mouth shapes. Amplitudes are conversational, not theatrical: speech is
// mostly lips and tongue — the jaw only cracks open enough to let them work.
const VISEMES = {
  rest: { mouthOpen: 0.0,  mouthCurve: 0.0 },
  AI:   { mouthOpen: 0.45, mouthCurve: 0.1 },
  E:    { mouthOpen: 0.20, mouthCurve: 0.2 },
  U:    { mouthOpen: 0.30, mouthCurve: -0.1 },
  O:    { mouthOpen: 0.55, mouthCurve: 0.0 },
  LNTD: { mouthOpen: 0.13, mouthCurve: 0.0 },
  FV:   { mouthOpen: 0.08, mouthCurve: -0.1 },
  MBP:  { mouthOpen: 0.02, mouthCurve: 0.0 },
};

export const EXPRESSION_NAMES = Object.keys(EXPRS);

const PHONEME_MAP = {
  A: 'AI', I: 'AI', E: 'E', O: 'O', U: 'U',
  L: 'LNTD', N: 'LNTD', T: 'LNTD', D: 'LNTD',
  F: 'FV', V: 'FV', M: 'MBP', B: 'MBP', P: 'MBP',
  // approximations so consonant-heavy words don't read as a closed mouth
  S: 'E', Z: 'E', C: 'E', X: 'E',
  R: 'U', W: 'U', Q: 'U',
  K: 'LNTD', G: 'LNTD', H: 'LNTD', J: 'LNTD', Y: 'LNTD',
};

export function phonemeToViseme(p) {
  return PHONEME_MAP[p] || 'rest';
}

function lerp(a, b, t) { return a + (b - a) * t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// ---- face state ----------------------------------------------------------
export class Face {
  constructor() {
    // current blended params (the values the shader reads)
    this.params = {
      faceCenter: [0.5, 0.52],
      faceScale: 0.85,
      faceTilt: 0.0,
      mouthOpen: 0.0,
      mouthCurve: 0.0,
      browLift: 0.0,
      browTilt: 0.0,
      eyeOpen: 1.0,
      pupilX: 0.0,
      pupilY: 0.0,
      cheek: 0.0,
      blink: 0.0,
      headYaw: 0.0,
      headPitch: 0.0,
    };
    // head pose targets (drift + gestures)
    this.yawTarget = 0.0;
    this.pitchTarget = 0.0;
    this.poseT = 1.5 + Math.random() * 2.0;
    this.nodT = 0.0;       // >0 while a nod gesture plays
    this.attentive = false; // true while listening/speaking: face the user

    this.currentExpr = 'neutral';
    this.targetExpr = 'neutral';
    this.exprBlend = 1.0;
    this.morphSpeed = 4.0;

    this.viseme = 'rest';
    this.visemeAmt = 0.0;
    this.voiceEnergy = 1.0;    // live audio envelope 0..1 (1 = no audio tap)
    this.exprMouthOpen = 0.0;  // expression's own mouth pose, kept separate
    this.exprMouthCurve = 0.0; // so visemes can't cancel e.g. "surprised"

    this.blinkT = 2.0 + Math.random() * 3.0;
    this.blinking = 0.0;

    this.idleT = 0.0;
  }

  setExpression(name) {
    if (!EXPRS[name]) return;
    if (name !== this.targetExpr) {
      this.targetExpr = name;
      this.exprBlend = 0.0;
    }
  }

  nod() {
    this.nodT = 0.6;
  }

  setViseme(name, amount = 1.0) {
    if (!VISEMES[name]) return;
    this.viseme = name;
    this.visemeAmt = Math.max(0, Math.min(1, amount));
  }

  update(dt) {
    this.idleT += dt;

    // expression interpolation
    const target = EXPRS[this.targetExpr];
    this.exprBlend = Math.min(1, this.exprBlend + dt * this.morphSpeed);
    const e = easeInOut(this.exprBlend);
    for (const k of Object.keys(target)) {
      const from = EXPRS[this.currentExpr][k];
      const to = target[k];
      const v = from + (to - from) * e;
      // map expression keys to params
      if (k === 'tilt') this.params.faceTilt = v;
      else if (k === 'mouthOpen') this.exprMouthOpen = v;
      else if (k === 'mouthCurve') this.exprMouthCurve = v;
      else this.params[k] = v;
    }
    if (this.exprBlend >= 1) this.currentExpr = this.targetExpr;

    // blink
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blinking = 1.0;
      this.blinkT = 2.5 + Math.random() * 4.0;
    }
    this.blinking = Math.max(0, this.blinking - dt * 7.0);
    this.params.blink = this.blinking;

    // visemes: smooth toward the current mouth target instead of snapping.
    // Real mouths are sluggish — ~60–80ms to reach a shape — so consecutive
    // visemes naturally blend through intermediate positions.
    this.visemeAmt = Math.max(0, this.visemeAmt - dt * 2.5);
    const v = VISEMES[this.viseme];
    const va = this.visemeAmt;
    // syllable sync: the viseme gives the mouth its SHAPE, the live audio
    // envelope gives it its MAGNITUDE — vowel nuclei are loud, so the mouth
    // opens exactly on each syllable's energy pulse
    const energy = 0.25 + 0.75 * this.voiceEnergy;
    const targetOpen = Math.max(this.exprMouthOpen, v.mouthOpen * va * energy);
    const targetCurve = this.exprMouthCurve + v.mouthCurve * va;
    const mouthEase = Math.min(1, dt * 14);   // ~70ms time constant
    this.params.mouthOpen = lerp(this.params.mouthOpen, targetOpen, mouthEase);
    this.params.mouthCurve = lerp(this.params.mouthCurve, targetCurve, mouthEase);

    // subtle idle: breathing + pupil drift
    const breathe = Math.sin(this.idleT * 0.8) * 0.5 + 0.5;
    this.params.faceScale = 0.85 + breathe * 0.01;
    this.params.pupilX += (Math.sin(this.idleT * 0.4) * 0.15 - this.params.pupilX) * dt * 1.5;
    this.params.pupilY += (Math.cos(this.idleT * 0.33) * 0.1 - this.params.pupilY) * dt * 1.5;

    // head pose: idle wander, or settle to center when attentive
    this.poseT -= dt;
    if (this.poseT <= 0) {
      if (this.attentive) {
        this.yawTarget = (Math.random() - 0.5) * 0.15;
        this.pitchTarget = (Math.random() - 0.5) * 0.10;
      } else {
        this.yawTarget = (Math.random() - 0.5) * 0.9;
        this.pitchTarget = (Math.random() - 0.5) * 0.5;
      }
      this.poseT = 2.0 + Math.random() * 3.5;
    }
    let pitchExtra = 0;
    if (this.nodT > 0) {
      this.nodT = Math.max(0, this.nodT - dt);
      pitchExtra = Math.sin((0.6 - this.nodT) / 0.6 * Math.PI * 2.0) * 0.45;
    }
    const ease = dt * (this.attentive ? 4.0 : 1.2);
    this.params.headYaw += (this.yawTarget - this.params.headYaw) * Math.min(1, ease);
    this.params.headPitch += (this.pitchTarget + pitchExtra - this.params.headPitch) * Math.min(1, ease * 1.5);
    // the whole head leans slightly with the turn
    this.params.faceTilt += this.params.headYaw * -0.04;
  }
}
