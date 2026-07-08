// GLSL shaders for innerFace.
// The face is an invisible 3D surface in the rain: it only becomes visible
// through glyphs — code characters "cling" to the surface and glow with the
// surface lighting, and falling rain brightens as it passes over the face.
// There is no smooth glow layer; everything the face shows is made of glyphs.

export const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// ---- 3D face-mesh pass ----------------------------------------------------
// Renders the photo-derived triangle mesh into an offscreen target. Output:
//   rgb = lit luminance of the photo skin,  a = coverage (with rim fade).
// The main glyph shader then samples this as the "skin" field, so the mesh
// is never seen directly — only through the code that clings to it.
export const MESH_VERT = `
attribute vec3 aMPos;
attribute vec2 aMUv;
attribute vec3 aMNormal;
attribute float aMJaw;
attribute float aMBorder;

uniform float uMouthOpen;
uniform float uHeadYaw;
uniform float uHeadPitch;
uniform float uFaceTilt;

varying vec2 vMUv;
varying vec3 vMNormal;
varying float vMBorder;

mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,s, 0.,1.,0., -s,0.,c); }
mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
mat3 rotZ(float a){ float c=cos(a),s=sin(a); return mat3(c,-s,0., s,c,0., 0.,0.,1.); }

void main() {
  vec3 pos = aMPos;

  // rigid jaw: rotate lower-face vertices about a hinge just under the ears
  float ang = uMouthOpen * 0.32 * aMJaw;
  vec3 hinge = vec3(0.0, 0.28, -0.15);
  pos = rotX(ang) * (pos - hinge) + hinge;

  // head pose: yaw + pitch + roll
  mat3 R = rotZ(uFaceTilt) * rotX(uHeadPitch * 0.6) * rotY(uHeadYaw * 0.9);
  pos = R * pos;
  vec3 nrm = R * aMNormal;

  vMUv = aMUv;
  vMNormal = nrm;
  vMBorder = aMBorder;

  // orthographic; z only feeds depth test. face spans ~[-0.6,0.6] locally.
  gl_Position = vec4(pos.x, pos.y, -pos.z * 0.5, 1.0);
}
`;

export const MESH_FRAG = `
precision highp float;

uniform sampler2D uPhoto;   // r = luma, g = depth, b = de-lit albedo, a = mask
uniform float uHeadYaw;
uniform vec2  uLightDir;    // x = azimuth (-1..1), y = elevation (-1..1)

varying vec2 vMUv;
varying vec3 vMNormal;
varying float vMBorder;

void main() {
  vec4 ph = texture2D(uPhoto, vMUv);
  vec3 n = normalize(vMNormal);

  // light direction from the slider (+ a little head-turn coupling so the key
  // light still shifts as she looks around). uLightDir defaults to up-left.
  vec3 L = normalize(vec3(uLightDir.x + uHeadYaw * 0.3, uLightDir.y, 0.75));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 2.5);

  // ---- albedo: use the de-lit B channel (photo.js homomorphic pass) ----
  // The blue channel is the photo with its baked lighting divided out, so it's
  // a near-uniform "unlit skin" we can apply our OWN 3D light to without the
  // double-lighting washout. Fall back toward luma if albedo is unavailable
  // (older cached photos with B == luma still read reasonably).
  float albedo = mix(0.5, ph.b, 0.72);

  // 3D lighting shapes the surface: ambient + diffuse from the real normals,
  // plus rim on silhouette edges. Kept on the lower side so highlights still
  // have headroom under the rolloff below.
  float lightTerm = 0.32 + diff * 0.85 + rim * 0.30;
  float lit = albedo * lightTerm;

  // ONLY the very darkest pixels (iris, pupil, lash line — not the mid-tone
  // feature shadows) get a small steady glow, added on top. Head-independent
  // so the iris doesn't flicker as the socket normals swing with head turns.
  float eyeDark = smoothstep(0.28, 0.08, ph.r);   // narrow: near-black only
  lit += eyeDark * 0.35 * ph.a;

  // ---- highlight rolloff: compress instead of clip ----
  // The framebuffer is 8-bit, so any lit > 1.0 clips to flat white — the
  // washout. Reinhard-style tonemap rolls highlights off smoothly so bright
  // regions (forehead, cheeks on a flat photo) keep faint shape instead of
  // becoming a uniform white blob. Knee at ~0.85 keeps midtones honest.
  lit = lit / (lit + 0.85) * 1.85;

  lit *= ph.a;

  // coverage fades to 0 at the mesh rim so the face dissolves into rain
  // where the scan data ends (no hard silhouette edge)
  float cover = ph.a * smoothstep(0.0, 0.4, vMBorder);

  gl_FragColor = vec4(vec3(lit), cover);
}
`;

export const FRAG = `
precision highp float;
varying vec2 vUv;

uniform vec2  uResolution;
uniform float uTime;
uniform sampler2D uGlyphs;
uniform vec2  uAtlasGrid;
uniform float uNumGlyphs;
uniform float uFaceReveal;   // 0..1
uniform float uAudio;        // 0..1
uniform vec3  uTint;

// face params (animated in JS, passed as uniforms)
uniform vec2  uFaceCenter;   // 0..1 screen UV
uniform float uFaceScale;    // relative to min(res)
uniform float uFaceTilt;     // radians
uniform float uMouthOpen;    // 0..1
uniform float uMouthCurve;   // -1..1
uniform float uBrowLift;     // 0..1
uniform float uBrowTilt;     // -1..1
uniform float uEyeOpen;      // 0..1.3
uniform float uPupilX;       // -1..1
uniform float uPupilY;       // -1..1
uniform float uCheek;        // 0..1
uniform float uBlink;        // 0..1 (1 = closed)

// photo mode: portrait field (r = luma, g = landmark depth, a = subject mask)
uniform sampler2D uPhoto;
uniform float uPhotoOn;      // 0 = procedural face, 1 = photo face
uniform float uPhotoHasLm;   // 1 = landmark anchors below are valid
uniform float uPhotoHasDepth;// 1 = green channel is a real depth field
uniform vec2  uPhotoEyeL;    // field UV
uniform vec2  uPhotoEyeR;    // field UV
uniform vec3  uPhotoMouth;   // cx, cy, width (field UV)
uniform float uPhotoChinY;   // jawline bottom (field UV y)
uniform float uHeadYaw;      // -1..1, + = her left
uniform float uHeadPitch;    // -1..1, + = nod down
uniform vec2  uLightDir;     // key-light azimuth/elevation (LIGHT slider)

// pre-lit 3D mesh field (rgb = lit skin, a = coverage). When uMeshOn is set,
// photo mode reads its skin from here instead of the flat heightmap trick.
uniform sampler2D uMesh;
uniform float uMeshOn;

// ---- hashes --------------------------------------------------------------
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash21(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

// anisotropic gaussian bump
float g2(vec2 p, vec2 c, vec2 r){
  vec2 d = (p - c) / r;
  return exp(-dot(d, d));
}

// ---- head shape ------------------------------------------------------------
// Face-local space: origin at face center, +y UP, roughly [-1,1].
// Wider cranium (slightly flattened top), tapered cheeks, narrower chin —
// closer to real skull proportions than the old egg.
float headSDF(vec2 p){
  // cranium: wide ellipse, flattened on top
  vec2 ps = (p - vec2(0.0, 0.16)) / vec2(0.72, 0.60);
  ps.y *= 1.0 + 0.18 * smoothstep(0.0, 1.0, ps.y);   // flatten the crown
  float skull = (length(ps) - 1.0) * 0.55;
  // mid-face: cheeks taper inward
  vec2 pc = (p - vec2(0.0, -0.10)) / vec2(0.60, 0.46);
  float cheeks = (length(pc) - 1.0) * 0.50;
  // jaw: narrower, chin slightly pointed
  vec2 pj = (p - vec2(0.0, -0.34)) / vec2(0.42, 0.52);
  float jaw = (length(pj) - 1.0) * 0.48;
  return smin(smin(skull, cheeks, 0.10), jaw, 0.10);
}

// ---- hair --------------------------------------------------------------
// Hair mask around the head: a fringe over the forehead, volume around the
// crown, and long strands falling past the jaw. Returns 0..1 coverage.
float hairMask(vec2 p){
  float sdf = headSDF(p);
  // shell just outside/at the skull boundary
  float shell = 1.0 - smoothstep(0.0, 0.16, abs(sdf + 0.02));
  // only above the ears / around the crown for the shell part
  float crown = smoothstep(-0.05, 0.35, p.y + abs(p.x) * 0.55);
  float hair = shell * crown;
  // fringe: dips onto the upper forehead only, wavy edge
  float fringeEdge = 0.46 - 0.07 * sin(p.x * 9.0 + 1.3) - p.x * p.x * 0.30;
  float inHead = 1.0 - smoothstep(-0.02, 0.02, sdf);
  hair = max(hair, inHead * smoothstep(fringeEdge, fringeEdge + 0.08, p.y));
  // side curtains: long strands framing the face, falling past the jaw
  float sideX = 0.62 + 0.05 * sin(p.y * 6.0 + p.x * 3.0);
  float curtain = smoothstep(sideX - 0.16, sideX, abs(p.x))
                * (1.0 - smoothstep(0.80, 0.95, abs(p.x)))
                * smoothstep(-1.05, -0.55, p.y) * (1.0 - smoothstep(0.30, 0.55, p.y));
  hair = max(hair, curtain);
  // strand texture: vertical streaks so it reads as falling hair
  float strands = 0.6 + 0.4 * hash11(floor(p.x * 46.0) * 3.7);
  return clamp(hair * strands, 0.0, 1.0);
}

// ---- procedural face heightmap ---------------------------------------------
float faceHeight(vec2 p){
  float sdf = headSDF(p);
  // base dome with a rounded (sqrt) profile so edges catch rim light
  float h = sqrt(clamp(-sdf * 2.6, 0.0, 1.0)) * 0.85;

  // forehead
  h += g2(p, vec2(0.0, 0.45), vec2(0.48, 0.28)) * 0.10;
  // brow ridge (lifts with expression)
  float by = 0.20 + uBrowLift * 0.05;
  h += g2(p, vec2(0.0, by), vec2(0.40, 0.08)) * 0.14;
  // eye sockets (depressions)
  h -= g2(p, vec2( 0.26, 0.10), vec2(0.15, 0.09)) * 0.17;
  h -= g2(p, vec2(-0.26, 0.10), vec2(0.15, 0.09)) * 0.17;
  // nose bridge + tip
  h += g2(p, vec2(0.0, 0.02), vec2(0.055, 0.20)) * 0.22;
  h += g2(p, vec2(0.0, -0.16), vec2(0.09, 0.055)) * 0.18;
  // cheekbones (raise with smile)
  float ch = 0.13 * (1.0 + uCheek * 0.7);
  h += g2(p, vec2( 0.34, -0.06), vec2(0.15, 0.13)) * ch;
  h += g2(p, vec2(-0.34, -0.06), vec2(0.15, 0.13)) * ch;
  // lips + mouth gap
  h += g2(p, vec2(0.0, -0.33), vec2(0.16, 0.035)) * 0.08;
  h += g2(p, vec2(0.0, -0.45), vec2(0.13, 0.045)) * 0.10;
  h -= g2(p, vec2(0.0, -0.39), vec2(0.17, 0.025 + uMouthOpen * 0.05)) * 0.12;
  // chin
  h += g2(p, vec2(0.0, -0.62), vec2(0.15, 0.10)) * 0.12;
  return h;
}

vec3 faceNormal(vec2 p) {
  float e = 0.02;
  float hL = faceHeight(p - vec2(e, 0.0));
  float hR = faceHeight(p + vec2(e, 0.0));
  float hD = faceHeight(p - vec2(0.0, e));
  float hU = faceHeight(p + vec2(0.0, e));
  return normalize(vec3(hL - hR, hD - hU, 2.0 * e));
}

// ---- facial features (masks in face-local space, +y up) --------------------
void features(vec2 p,
              out float eyes, out float pupils, out float glint,
              out float brows, out float lipLine, out float mouthIn) {
  eyes = 0.0; pupils = 0.0; glint = 0.0; brows = 0.0;

  float eyeH = max(0.062 * clamp(uEyeOpen, 0.0, 1.3) * (1.0 - uBlink), 0.004);
  for (int i = 0; i < 2; i++) {
    float s = (i == 0) ? 1.0 : -1.0;

    // almond eye
    vec2 ec = vec2(0.26 * s, 0.11);
    float em = 1.0 - smoothstep(0.75, 1.05, length((p - ec) / vec2(0.15, eyeH)));
    eyes += em;

    // pupil (dark) + glint (bright dot)
    vec2 pc = ec + vec2(uPupilX * 0.045, uPupilY * 0.03);
    float pd = length((p - pc) / vec2(0.045, min(0.045, eyeH)));
    pupils += (1.0 - smoothstep(0.7, 1.0, pd)) * em;
    glint += (1.0 - smoothstep(0.0, 0.014, length(p - pc - vec2(0.012, 0.012)))) * em;

    // brow: elongated bump above the eye, rotated by browTilt (mirrored)
    float ba = uBrowTilt * 0.4 * s;
    vec2 bc = vec2(0.26 * s, 0.245 + uBrowLift * 0.07);
    vec2 bp = p - bc;
    bp = vec2(cos(ba)*bp.x - sin(ba)*bp.y, sin(ba)*bp.x + cos(ba)*bp.y);
    vec2 bd = bp / vec2(0.13, 0.022);
    brows += exp(-dot(bd, bd));
  }

  // mouth: a lip line that curves with expression, opening grows with visemes
  float mw = 0.21;
  float xn = clamp(p.x / mw, -1.4, 1.4);
  float yline = -0.385 + uMouthCurve * 0.055 * xn * xn - uMouthCurve * 0.02;
  float halfH = 0.012 + uMouthOpen * 0.085;
  float dy = p.y - yline;
  float inX = 1.0 - smoothstep(0.85, 1.1, abs(p.x) / mw);
  mouthIn = (1.0 - smoothstep(0.6, 1.0, abs(dy) / halfH)) * inX;
  float lb = abs(abs(dy) - halfH);
  lipLine = exp(-(lb * lb) / (0.012 * 0.012)) * inX;
}

void main() {
  vec2 res = uResolution;

  // ---- dense rain: smaller cells, multiple streams per column ----
  float CW = 11.0;
  float CH = 18.0;
  vec2 cell = vec2(CW, CH);

  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec2 grid = floor(px / cell);
  vec2 sub  = fract(px / cell);

  float dens = 0.0;
  float leadSum = 0.0;

  for (int s = 0; s < 3; s++) {
    float fi = float(s);
    float colSeed = hash11(grid.x * 1.7 + fi * 91.3 + 7.0);
    float speed = mix(7.0, 20.0, hash11(grid.x * 0.91 + fi * 13.1));
    float trailLen = mix(6.0, 16.0, hash11(grid.x * 2.3 + fi * 5.7));

    float numRows = res.y / CH;
    float cycle = numRows + trailLen + 6.0;
    float head = mod(uTime * speed + colSeed * cycle, cycle);
    float d = head - grid.y;

    float trail = 0.0;
    if (d >= 0.0) {
      trail = exp(-d / max(trailLen * 0.22, 0.0001));
      trail *= smoothstep(trailLen, trailLen - 3.0, d);
    }
    float lead = smoothstep(1.0, 0.0, d) * step(0.0, d);

    float gt = floor(uTime * 3.5 + colSeed * 5.0);
    float gi = floor(hash21(vec2(grid.x + fi*37.0, grid.y * 1.7 + gt)) * uNumGlyphs);
    vec2 aCell = vec2(mod(gi, uAtlasGrid.x), floor(gi / uAtlasGrid.x));
    vec2 aUV = (aCell + sub) / uAtlasGrid;
    float glyph = texture2D(uGlyphs, aUV).a;

    dens += glyph * clamp(trail + lead * 1.6, 0.0, 2.0);
    leadSum += lead;
  }
  dens = clamp(dens, 0.0, 2.0);

  // ---- face space: +y UP (px space is y-down for the rain) ----
  float minR = min(res.x, res.y);
  vec2 fc = uFaceCenter * res;
  float sc = uFaceScale * minR * 0.5;
  vec2 q = (px - fc) / sc;
  q.y = -q.y;
  float cs = cos(uFaceTilt), sn = sin(uFaceTilt);
  vec2 fp = vec2(cs*q.x - sn*q.y, sn*q.x + cs*q.y);

  // ---- surface visibility field ("skin") ----
  // Mesh mode: sample the pre-lit 3D face-mesh field (real geometry).
  // Photo mode: portrait luminance shows through the glyphs (flat trick).
  // Procedural mode: lighting on the invisible 3D head.
  float skin = 0.0;
  float glintM = 0.0;
  float mouthIn = 0.0;

  if (uMeshOn > 0.5) {
    // the mesh pass rendered the face at ~[-0.57,0.57] NDC (face height 1.15
    // local units, centered). Map the main face-space fp (~[-1,1]) onto that
    // extent so the mesh face fills the frame like the procedural one did.
    vec2 muv = fp * 0.34 + 0.5;
    vec4 mf = texture2D(uMesh, clamp(muv, 0.0, 1.0));

    // No static backdrop: the MediaPipe mesh only covers face + forehead, so
    // a static photo behind it would ghost as the mesh rotates (the photo's
    // features slide against the rotating mesh features). Instead the mesh
    // face stands alone and dissolves to rain where its coverage ends — one
    // moving layer, no double image. Hair/ears/neck simply aren't shown.
    skin = mf.r * mf.a * uFaceReveal;
    // fall through to the shared glyph combine below with this skin value
  } else {

  // photo-space UV (v grows downward, like image rows)
  vec2 puv = clamp(vec2(fp.x, -fp.y) * 0.5 + 0.5, 0.0, 1.0);

  // screen-anchored UV: the eye-lift mask is evaluated here so it doesn't
  // slide against the parallax-shifted shadow as the head turns.
  vec2 puv0 = puv;

  // depth parallax: near points (nose) shift more than far ones as the
  // invisible head turns; where data runs out the mask dissolves the edge
  float pdepth = texture2D(uPhoto, puv).g;
  vec2 look = vec2(uHeadYaw, -uHeadPitch) * 0.055;
  if (uPhotoOn > 0.5 && uPhotoHasDepth > 0.5) {
    puv += look * (pdepth - 0.35);
  }

  // jaw warp: below the lip line the image itself stretches downward, so the
  // chin and lower lip move instead of painting a hole over them
  float jaw = 0.0;
  if (uPhotoOn > 0.5 && uPhotoHasLm > 0.5) {
    float mw = max(uPhotoMouth.z, 1.0e-4);
    // conversational jaw: a modest crack, not a hinge swing
    float drop = uMouthOpen * mw * 0.26;
    float xFall = 1.0 - smoothstep(0.7, 1.8, abs(puv.x - uPhotoMouth.x) / mw);
    float below = smoothstep(uPhotoMouth.y - 0.005, uPhotoMouth.y + 0.02, puv.y);
    // taper past the chin so the neck compresses instead of tearing
    float taper = 1.0 - smoothstep(uPhotoChinY + 0.03, uPhotoChinY + 0.14, puv.y);
    jaw = drop * xFall * below * taper;
  }
  vec2 puvW = vec2(puv.x, puv.y - jaw);

  // photo sample is unconditional so texture derivatives stay well-defined
  vec4 ph = texture2D(uPhoto, puvW);

  if (uPhotoOn > 0.5) {
    float inBox = step(abs(fp.x), 1.0) * step(abs(fp.y), 1.0);
    skin = ph.r * ph.a * inBox * (0.35 + ph.r * 1.05);

    // 3D shading from the landmark depth field: the photo face gets the same
    // diffuse + rim treatment as the procedural head
    if (uPhotoHasDepth > 0.5) {
      float e = 0.014;
      float dL2 = texture2D(uPhoto, puvW - vec2(e, 0.0)).g;
      float dR2 = texture2D(uPhoto, puvW + vec2(e, 0.0)).g;
      float dU2 = texture2D(uPhoto, puvW - vec2(0.0, e)).g;
      float dD2 = texture2D(uPhoto, puvW + vec2(0.0, e)).g;
      vec3 pn = normalize(vec3(dL2 - dR2, dU2 - dD2, 2.0 * e * 6.0));

      // eye mask in screen-anchored space: the brows sit above the eyes, so
      // the mask is elliptical (taller than wide) to cover the brow-overhang
      // shadow too. It rides the static landmarks, not the drifting sample.
      float nearEye = 0.0;
      if (uPhotoHasLm > 0.5) {
        float er = uPhotoMouth.z * 0.62;     // wider radius, esp. vertically
        float eL = 1.0 - smoothstep(0.45, 1.0, length((puv0 - uPhotoEyeL) / vec2(er * 0.85, er)));
        float eR = 1.0 - smoothstep(0.45, 1.0, length((puv0 - uPhotoEyeR) / vec2(er * 0.85, er)));
        nearEye = clamp(eL + eR, 0.0, 1.0);
      }

      // diffuse light: direction comes from the LIGHT slider (uLightDir), with
      // a little head-turn coupling on cheeks/nose. Near the eyes the direction
      // is frozen to the slider value only, so the socket shadow stops
      // breathing with yaw (the eye-flicker fix).
      vec3 Lturn = normalize(vec3(uLightDir.x - uHeadYaw * 0.5, uLightDir.y, 0.72));
      vec3 Lfix  = normalize(vec3(uLightDir.x, uLightDir.y, 0.72));
      vec3 L = mix(Lturn, Lfix, nearEye);

      float pdiff = clamp(dot(pn, L), 0.0, 1.0);
      // mute the diffuse swing inside the eye mask: the socket floor is
      // recessed, so raw diffuse manufactures flicker there. Blend toward a
      // gentle ambient so blinks read clearly without a pulsing shadow.
      pdiff = mix(pdiff, 0.9, nearEye);

      float prim = pow(1.0 - max(pn.z, 0.0), 2.0);
      // rim shimmers where the surface tilts — which is the socket walls —
      // so it must be damped near the eyes along with the diffuse
      prim = mix(prim, 0.25, nearEye);
      float shade = 0.55 + pdiff * 0.55 + prim * 0.45;
      // PIN (not floor) the eye region to a steady brightness: a floor still
      // lets rim spikes flicker above it; a pin holds the eyes rock-steady
      // through head motion, so only the blink changes their appearance
      shade = mix(shade, 1.25, nearEye);
      skin *= shade;
      // additive fill light: eyes are often dark in the SOURCE photo, and no
      // multiplier can brighten near-black pixels. Adds most where the source
      // is darkest (soft-light style), fading with the eye mask and blink.
      float fill = nearEye * (1.0 - ph.r) * 0.30 * ph.a * (1.0 - uBlink * 0.85);
      skin += fill * uFaceReveal;
    }

    if (uPhotoHasLm > 0.5) {
      // mouth cavity: screen pixels whose warped sample crossed back above
      // the lip line are the opening between the lips
      float mw2 = max(uPhotoMouth.z, 1.0e-4);
      float xF = 1.0 - smoothstep(0.55, 1.0, abs(puv.x - uPhotoMouth.x) / (mw2 * 0.62));
      float opened = smoothstep(0.0, 0.012, uPhotoMouth.y - puvW.y)
                   * step(uPhotoMouth.y - 0.004, puv.y);
      mouthIn = opened * xF;
      skin *= 1.0 - mouthIn * 0.85;

      // blink: darken the detected eye regions when lids close
      float br = uPhotoMouth.z * 0.45;
      float eL = 1.0 - smoothstep(0.5, 1.0, length((puv - uPhotoEyeL) / vec2(br, br * 0.6)));
      float eR = 1.0 - smoothstep(0.5, 1.0, length((puv - uPhotoEyeR) / vec2(br, br * 0.6)));
      skin *= 1.0 - clamp(eL + eR, 0.0, 1.0) * uBlink * 0.7;
    }
    skin *= uFaceReveal;
  } else {
    // true parallax head turn: fp is where the view ray meets the picture
    // plane, but the face surface rises above it. Shift the sample point by
    // (view offset × local height) and iterate — tall features (nose) sweep
    // farther than low ones (cheeks) as the head turns, like a real head.
    vec2 hoff = vec2(uHeadYaw, uHeadPitch * 0.7) * 0.38;
    vec2 fph = fp;
    for (int it = 0; it < 3; it++) {
      fph = fp + hoff * faceHeight(fph);
    }
    // the silhouette shifts a little too (whole head translates slightly)
    fph -= hoff * 0.18;

    float sdf = headSDF(fph);
    float sil = 1.0 - smoothstep(-0.01, 0.05, sdf);
    if (sil > 0.001 && uFaceReveal > 0.001) {
    vec3 n = faceNormal(fph);
    // light fixed in world: turning the head changes which side catches it
    vec3 L = normalize(vec3(-0.42 + uHeadYaw * 0.35, 0.55, 0.72));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float rim = pow(1.0 - max(n.z, 0.0), 2.0);
    float surf = 0.30 + diff * 1.05 + rim * 0.55;

    float eyes, pupils, brows, lipLine;
    features(fph, eyes, pupils, glintM, brows, lipLine, mouthIn);

    skin = surf;
    skin += eyes * 1.2;
    skin += brows * 0.7;
    skin += lipLine * 1.2;
      skin *= 1.0 - mouthIn * 0.8;   // mouth cavity is dark
      skin *= 1.0 - pupils * 0.8;    // pupils are dark
      skin *= sil * uFaceReveal;
    }

    // hair: her hair IS the code — strands shimmer downward like slow rain,
    // framing the face and covering the forehead fringe
    float hm = hairMask(fph);
    if (hm > 0.001 && uFaceReveal > 0.001) {
      float strandSeed = hash11(floor(fph.x * 46.0) * 7.1);
      float flow = 0.60 + 0.40 * sin(fph.y * 12.0 - uTime * (1.6 + strandSeed) + strandSeed * 6.28);
      float hairShade = (0.16 + 0.16 * flow) * hm;
      // where hair overlaps the face it DARKENS (hair occludes skin);
      // outside the skin it adds the framing silhouette
      skin = mix(skin, hairShade, hm * 0.75 * step(0.01, skin));
      skin = max(skin, hairShade * uFaceReveal);
    }
  }
  } // end uMeshOn else

  // per-cell materialization: cells of the face light up in random order
  float mat = smoothstep(0.0, 0.25, uFaceReveal - hash21(grid * 0.73 + 11.7) * 0.9);

  // ---- clung glyphs: code stuck to the surface, lit by it ----
  // (sampled unconditionally to keep texture derivatives well-defined)
  float ct = floor(uTime * (1.2 + hash21(grid) * 1.6) + hash21(grid * 1.3) * 17.0);
  float cgi = floor(hash21(vec2(grid.x * 3.1 + 9.7, grid.y * 1.9 + ct * 0.37)) * uNumGlyphs);
  vec2 cCell = vec2(mod(cgi, uAtlasGrid.x), floor(cgi / uAtlasGrid.x));
  float clungGlyph = texture2D(uGlyphs, (cCell + sub) / uAtlasGrid).a;
  float flick = 0.65 + 0.35 * hash21(grid + floor(uTime * 2.0));
  float clung = clungGlyph * flick * skin * mat;

  // ---- combine ----
  // falling rain brightens where it passes over the visible surface
  vec3 rainCol = uTint * dens * (1.0 + skin * mat * 1.1);
  rainCol = mix(rainCol, vec3(1.0), clamp(leadSum, 0.0, 1.0) * 0.7);

  // face made purely of glyphs; audio makes the whole face pulse
  vec3 skinTint = mix(uTint, vec3(0.62, 1.0, 0.88), 0.35);
  vec3 faceCol = skinTint * clung * (1.7 + uAudio * 0.8);
  // the only smooth elements: tiny eye glints, and a voice glow in the mouth
  faceCol += vec3(0.85, 1.0, 0.95) * glintM * uFaceReveal * 0.8;
  faceCol += uTint * mouthIn * uAudio * 0.35 * uFaceReveal;

  gl_FragColor = vec4(rainCol + faceCol, 1.0);
}
`;
