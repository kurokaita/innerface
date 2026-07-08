// Photo → glyph-field pipeline.
// Turns a dropped image into a luminance+mask texture that the shader renders
// through glyphs, and (best-effort) detects facial landmarks so the mouth and
// eyes can be animated. All processing stays in the browser; the landmark
// model is fetched from a CDN only when a photo is actually used.

const SIZE = 512;

// ---- persistence (IndexedDB) — she remembers the last face dropped --------
const DB_NAME = 'innerface';
const STORE = 'photo';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhoto(canvas, landmarks) {
  try {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, landmarks: landmarks || null }, 'last');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('photo save failed:', e);
  }
}

export async function loadSavedPhoto() {
  try {
    const db = await openDB();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('last');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!rec || !rec.blob) return null;
    const bitmap = await createImageBitmap(rec.blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return { canvas, landmarks: rec.landmarks || null };
  } catch (e) {
    console.warn('photo load failed:', e);
    return null;
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// average colour of the four corner patches — treated as "background"
function cornerColor(d) {
  const P = 12;
  let r = 0, g = 0, b = 0, n = 0;
  const corners = [[0, 0], [SIZE - P, 0], [0, SIZE - P], [SIZE - P, SIZE - P]];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + P; y++) {
      for (let x = cx; x < cx + P; x++) {
        const i = (y * SIZE + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
  }
  return [r / n, g / n, b / n];
}

// Rasterize the 468 landmark z-values into a per-pixel depth field (0 = far,
// 1 = nearest/nose). Splat onto a coarse grid, then bilinear-upsample — the
// gaussian tails also give a soft falloff outside the landmark hull.
function buildDepthField(raw, fit) {
  const G = 64;
  const acc = new Float32Array(G * G);
  const wsum = new Float32Array(G * G);
  let zmin = Infinity, zmax = -Infinity;
  for (const p of raw) {
    if (p.z < zmin) zmin = p.z;
    if (p.z > zmax) zmax = p.z;
  }
  const range = Math.max(1e-6, zmax - zmin);
  const sigma = 2.6, R = 7;
  for (const p of raw) {
    const gx = ((fit.ox + p.x * fit.w) / SIZE) * G;
    const gy = ((fit.oy + p.y * fit.h) / SIZE) * G;
    const d = 1 - (p.z - zmin) / range;   // MediaPipe z: smaller = nearer
    for (let yy = Math.max(0, Math.floor(gy - R)); yy < Math.min(G, gy + R); yy++) {
      for (let xx = Math.max(0, Math.floor(gx - R)); xx < Math.min(G, gx + R); xx++) {
        const w = Math.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * sigma * sigma));
        acc[yy * G + xx] += w * d;
        wsum[yy * G + xx] += w;
      }
    }
  }
  // sampler: bilinear over the grid, weighted toward 0 where coverage is thin
  return (u, v) => {
    const x = Math.min(G - 1.001, Math.max(0, u * G - 0.5));
    const y = Math.min(G - 1.001, Math.max(0, v * G - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let val = 0;
    for (const [dx, dy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const j = (y0 + dy) * G + (x0 + dx);
      const cover = Math.min(1, wsum[j]);
      val += wgt * (wsum[j] > 1e-4 ? (acc[j] / wsum[j]) * cover : 0);
    }
    return val;
  };
}

export async function processImage(fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob);

  // contain-fit into a square field
  const scale = Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const ox = Math.floor((SIZE - w) / 2), oy = Math.floor((SIZE - h) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, ox, oy, w, h);

  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  const bg = cornerColor(d);

  // first pass: luma + mask, and a histogram of subject pixels
  const luma = new Float32Array(SIZE * SIZE);
  const mask = new Float32Array(SIZE * SIZE);
  const hist = new Uint32Array(256);
  let histN = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const j = y * SIZE + x;
      const i = j * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3] / 255;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

      // key out pixels close to the background colour
      const dist = Math.hypot(r - bg[0], g - bg[1], b - bg[2]) / 255;
      let m = smoothstep(0.08, 0.25, dist) * a;
      // soft vignette so stray background never reaches the frame edge
      const vx = (x / SIZE) * 2 - 1, vy = (y / SIZE) * 2 - 1;
      m *= 1 - smoothstep(0.78, 0.99, Math.hypot(vx, vy));

      luma[j] = l;
      mask[j] = m;
      if (m > 0.5) { hist[Math.min(255, Math.floor(l * 256))]++; histN++; }
    }
  }

  // percentile stretch (p5..p95 of subject pixels) so any photo fills the
  // brightness range the glyphs can show
  let lo = 0, hi = 1;
  if (histN > 0) {
    let acc = 0;
    for (let k = 0; k < 256; k++) {
      acc += hist[k];
      if (acc >= histN * 0.05) { lo = k / 255; break; }
    }
    acc = 0;
    for (let k = 255; k >= 0; k--) {
      acc += hist[k];
      if (acc >= histN * 0.05) { hi = k / 255; break; }
    }
    if (hi - lo < 0.1) { lo = 0; hi = 1; }
  }

  const fit = { ox, oy, w, h, SIZE };
  const det = await detectLandmarks(bitmap, fit);
  const depthAt = det && det.raw ? buildDepthField(det.raw, fit) : null;

  // output: R = luma, G = depth (0 where unknown), A = subject mask
  const out = ctx.createImageData(SIZE, SIZE);
  const o = out.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const j = y * SIZE + x;
      const i = j * 4;
      const l = Math.min(1, Math.max(0, (luma[j] - lo) / (hi - lo)));
      const v = Math.round(Math.pow(l, 0.85) * 255);
      o[i] = v;
      o[i + 1] = depthAt ? Math.round(depthAt(x / SIZE, y / SIZE) * 255) : v;
      o[i + 2] = v;
      o[i + 3] = Math.round(mask[j] * 255);
    }
  }
  ctx.putImageData(out, 0, 0);

  return {
    canvas,
    landmarks: det ? det.anchors : null,
    raw: det ? det.raw : null,        // 468 landmarks for the 3D mesh
    connections: det ? det.connections : null,
    fit,
  };
}

// Best-effort MediaPipe Face Landmarker. Returns feature anchors in the
// processed field's UV space, or null (stylized/anime faces often fail).
async function detectLandmarks(bitmap, fit) {
  try {
    const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
    const vision = await import(`${CDN}/vision_bundle.mjs`);
    const { FaceLandmarker, FilesetResolver } = vision;
    const files = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const fl = await FaceLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    const res = fl.detect(bitmap);
    fl.close();
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) return null;

    const toUV = (p) => [(fit.ox + p.x * fit.w) / SIZE, (fit.oy + p.y * fit.h) / SIZE];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const eyeR = mid(toUV(lm[33]), toUV(lm[133]));   // viewer-left eye
    const eyeL = mid(toUV(lm[362]), toUV(lm[263]));  // viewer-right eye
    const mC = mid(toUV(lm[13]), toUV(lm[14]));      // inner lips
    const cR = toUV(lm[61]), cL = toUV(lm[291]);     // mouth corners
    const mouthW = Math.hypot(cL[0] - cR[0], cL[1] - cR[1]);

    return {
      anchors: {
        eyeL, eyeR,
        mouth: [mC[0], mC[1], mouthW],
        chinY: toUV(lm[152])[1],   // jawline bottom — bounds the jaw warp
        hasDepth: true,            // green channel carries real depth
      },
      raw: lm,
      connections: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    };
  } catch (e) {
    console.warn('landmark detection unavailable:', e);
    return null;
  }
}
