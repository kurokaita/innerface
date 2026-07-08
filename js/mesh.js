// Builds a renderable 3D face mesh from MediaPipe's 468 landmarks.
// The landmarks are a real (if coarse) 3D scan of the face in the photo:
// each point has x, y and a depth estimate, and MediaPipe publishes the
// edge list (tesselation) connecting them. We recover the triangles from
// the edges, compute normals, and bake a per-vertex jaw weight so the
// lower face can move as rigid geometry when she speaks.

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---- face-shaped depth prior ------------------------------------------------
// A smooth, plausible z-skeleton in face-local space (+y up, face height
// ~1.15). Forward features (nose, brow, cheeks, forehead dome) return larger
// values; eye sockets return smaller. This is the stable skeleton that
// MediaPipe's noisy learned z gets blended toward — it supplies the broad
// shape so a bad depth estimate can't turn the face into a lumpy mess.
function facePrior(x, y) {
  const g = (ccx, ccy, rx, ry) => {
    const dx = x - ccx, dy = y - ccy;
    return Math.exp(-(dx * dx) / (rx * rx) - (dy * dy) / (ry * ry));
  };
  let z = 0.50 * g(0.0, 0.10, 0.50, 0.65);   // central dome (mid-face forward)
  z += 0.10 * g(0.0, 0.28, 0.36, 0.16);      // forehead lift
  z += 0.14 * g(0.0, 0.08, 0.32, 0.06);      // brow ridge
  z += 0.34 * g(0.0, -0.05, 0.05, 0.20);     // nose bridge
  z += 0.22 * g(0.0, -0.20, 0.08, 0.06);     // nose tip
  z += 0.16 * (g(-0.24, -0.04, 0.12, 0.15) + g(0.24, -0.04, 0.12, 0.15));  // cheekbones
  z -= 0.16 * (g(-0.19, 0.0, 0.10, 0.08) + g(0.19, 0.0, 0.10, 0.08));      // eye sockets
  z -= 0.06 * g(0.0, -0.30, 0.15, 0.09);     // mouth/chin recess
  return z;
}

// Smooth a per-vertex vec3 field (normals) by averaging each vertex with its
// graph neighbours. A few Laplacian passes flatten the faceted noise a coarse
// 468-point mesh produces under diffuse lighting, while keeping the broad
// shape (nose, cheeks, brow).
function smoothField3(field, nbr, passes) {
  const N = nbr.length;
  for (let p = 0; p < passes; p++) {
    const tmp = Float32Array.from(field);
    for (let i = 0; i < N; i++) {
      const ns = nbr[i];
      if (ns.size === 0) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const j of ns) { sx += tmp[j * 3]; sy += tmp[j * 3 + 1]; sz += tmp[j * 3 + 2]; }
      const inv = 1 / ns.size;
      field[i * 3]     = tmp[i * 3]     * 0.5 + sx * inv * 0.5;
      field[i * 3 + 1] = tmp[i * 3 + 1] * 0.5 + sy * inv * 0.5;
      field[i * 3 + 2] = tmp[i * 3 + 2] * 0.5 + sz * inv * 0.5;
    }
  }
}

// landmark indices we rely on (stable across MediaPipe versions)
const LIP_UPPER = 13, LIP_LOWER = 14, MOUTH_R = 61, MOUTH_L = 291;

export function buildFaceMesh(lm, connections, fit, SIZE) {
  const N = lm.length;

  // ---- UVs: same fit transform the anchors use (processed-photo space) ----
  const uvs = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    uvs[i * 2] = (fit.ox + lm[i].x * fit.w) / SIZE;
    uvs[i * 2 + 1] = (fit.oy + lm[i].y * fit.h) / SIZE;
  }

  // ---- positions: face-local space, +y up, +z toward the viewer ----
  // MediaPipe z is a noisy learned estimate. We stabilize it by blending
  // toward the face-shaped prior: the prior supplies a smooth plausible
  // skeleton, the real landmarks add per-face variation on top. x/y stay
  // fully real (they carry the identity); only z is regularized.
  const zs = fit.w / SIZE;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < N; i++) {
    const x = uvs[i * 2], y = uvs[i * 2 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const s = 1.15 / Math.max(1e-6, maxY - minY);   // face height ≈ 1.15 local units

  // local x/y (real) + raw MediaPipe nearness, normalized to 0..1
  const lx = new Float32Array(N), ly = new Float32Array(N), mpNear = new Float32Array(N);
  let zmin = 1e9, zmax = -1e9;
  for (let i = 0; i < N; i++) {
    lx[i] = (uvs[i * 2] - cx) * s;
    ly[i] = -(uvs[i * 2 + 1] - cy) * s;   // +y up
    const z = -lm[i].z * zs;               // larger = nearer
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    mpNear[i] = z;
  }
  const zr = Math.max(1e-6, zmax - zmin);
  for (let i = 0; i < N; i++) mpNear[i] = (mpNear[i] - zmin) / zr;

  // prior nearness, normalized to its own 0..1 so scales match for blending
  const prRaw = new Float32Array(N);
  let pmin = 1e9, pmax = -1e9;
  for (let i = 0; i < N; i++) {
    prRaw[i] = facePrior(lx[i], ly[i]);
    if (prRaw[i] < pmin) pmin = prRaw[i];
    if (prRaw[i] > pmax) pmax = prRaw[i];
  }
  const prr = Math.max(1e-6, pmax - pmin);

  // 0.4 = 60% stable prior + 40% real variation. Enough character to differ
  // per face, not enough noise to read as lumps.
  const DEPTH_BLEND = 0.4;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const prN = (prRaw[i] - pmin) / prr;
    const near = prN * (1 - DEPTH_BLEND) + mpNear[i] * DEPTH_BLEND;
    positions[i * 3] = lx[i];
    positions[i * 3 + 1] = ly[i];
    positions[i * 3 + 2] = (near - 0.5) * 0.5;   // local depth, centered at 0
  }

  // ---- triangles: recover faces from the tesselation edge list ----
  // any 3-cycle in a triangulation's edge graph is a face
  const nbr = Array.from({ length: N }, () => new Set());
  for (const c of connections) {
    nbr[c.start].add(c.end);
    nbr[c.end].add(c.start);
  }
  const seen = new Set();
  const tris = [];
  for (const c of connections) {
    const a = c.start, b = c.end;
    for (const t of nbr[a]) {
      if (t === b || !nbr[b].has(t)) continue;
      const key = [a, b, t].sort((x, y) => x - y).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      tris.push(a, b, t);
    }
  }
  const indices = new Uint16Array(tris);

  // ---- normals: accumulate triangle normals per vertex ----
  const normals = new Float32Array(N * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3;
    const ax = positions[i1] - positions[i0], ay = positions[i1 + 1] - positions[i0 + 1], az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0], by = positions[i2 + 1] - positions[i0 + 1], bz = positions[i2 + 2] - positions[i0 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (const ii of [i0, i1, i2]) {
      normals[ii] += nx; normals[ii + 1] += ny; normals[ii + 2] += nz;
    }
  }
  // edge-list winding is arbitrary — orient the whole surface toward +z.
  // Smooth first (flattens faceted noise), then orient + normalize.
  smoothField3(normals, nbr, 2);
  let zsum = 0;
  for (let i = 0; i < N; i++) zsum += normals[i * 3 + 2];
  const flip = zsum < 0 ? -1 : 1;
  for (let i = 0; i < N; i++) {
    const j = i * 3;
    const len = Math.hypot(normals[j], normals[j + 1], normals[j + 2]) || 1;
    normals[j] = flip * normals[j] / len;
    normals[j + 1] = flip * normals[j + 1] / len;
    normals[j + 2] = flip * normals[j + 2] / len;
  }

  // ---- border flags: 0 on the mesh rim, 1 inside ----
  // (the rim ring fades out in the fragment shader — where the scan data
  // ends, the face dissolves into rain instead of a hard edge)
  const edgeCount = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [a, b] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      const k = a < b ? a * 1000 + b : b * 1000 + a;
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const border = new Float32Array(N).fill(1);
  for (const [k, count] of edgeCount) {
    if (count === 1) {
      border[Math.floor(k / 1000)] = 0;
      border[k % 1000] = 0;
    }
  }

  // ---- jaw weights: rigid lower jaw hinged below the inner-lip line ----
  const lipY = (positions[LIP_UPPER * 3 + 1] + positions[LIP_LOWER * 3 + 1]) / 2;
  const mX = (positions[MOUTH_R * 3] + positions[MOUTH_L * 3]) / 2;
  const mw = Math.hypot(
    positions[MOUTH_R * 3] - positions[MOUTH_L * 3],
    positions[MOUTH_R * 3 + 1] - positions[MOUTH_L * 3 + 1],
  );
  const jaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1];
    let w = smoothstep(0.005, 0.06, lipY - y);   // 0 above lips → 1 just below
    const lat = Math.abs(x - mX) / (mw * 0.5);
    w *= 1 - 0.6 * smoothstep(1.6, 3.2, lat);    // jaw narrows toward the ears
    jaw[i] = w;
  }

  return { positions, uvs, normals, jaw, border, indices };
}
