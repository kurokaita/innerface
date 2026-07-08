// WebGL renderer: compiles shaders, manages textures, draws a full-screen
// quad each frame. The face is now fully procedural in the shader, so there
// is no face texture — face params are passed as uniforms each frame.
import { VERT, FRAG, MESH_VERT, MESH_FRAG } from './shaders.js';

const MESH_FB_SIZE = 512;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL not supported by this browser.');
    this.gl = gl;

    this._buildProgram();
    this._buildQuad();

    // uniforms cache
    this.u = {};
    this._cacheUniforms();

    // 3D face-mesh pass (built lazily when a mesh is supplied)
    this._buildMeshProgram();
    this._buildMeshTarget();
    this.mesh = null;   // { buffers…, count } once a photo mesh is set

    this.texGlyphs = null;
    this.time = 0;

    // placeholder photo texture so the sampler is always valid
    const gl2 = this.gl;
    this.texPhoto = gl2.createTexture();
    gl2.bindTexture(gl2.TEXTURE_2D, this.texPhoto);
    gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 1, 1, 0, gl2.RGBA,
      gl2.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
  }

  _buildProgram() {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, VERT);
    const fs = this._compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _buildQuad() {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    this.quadBuf = buf;
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
  }

  _cacheUniforms() {
    const gl = this.gl;
    const names = [
      'uResolution', 'uTime', 'uGlyphs', 'uAtlasGrid', 'uNumGlyphs',
      'uFaceReveal', 'uAudio', 'uTint',
      'uFaceCenter', 'uFaceScale', 'uFaceTilt',
      'uMouthOpen', 'uMouthCurve', 'uBrowLift', 'uBrowTilt',
      'uEyeOpen', 'uPupilX', 'uPupilY', 'uCheek', 'uBlink',
      'uPhoto', 'uPhotoOn', 'uPhotoHasLm', 'uPhotoEyeL', 'uPhotoEyeR', 'uPhotoMouth',
      'uPhotoHasDepth', 'uPhotoChinY', 'uHeadYaw', 'uHeadPitch',
      'uMesh', 'uMeshOn',
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.program, n);
  }

  _buildMeshProgram() {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, MESH_VERT);
    const fs = this._compile(gl.FRAGMENT_SHADER, MESH_FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Mesh program link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.meshProgram = prog;
    this.ma = {
      pos: gl.getAttribLocation(prog, 'aMPos'),
      uv: gl.getAttribLocation(prog, 'aMUv'),
      nrm: gl.getAttribLocation(prog, 'aMNormal'),
      jaw: gl.getAttribLocation(prog, 'aMJaw'),
      border: gl.getAttribLocation(prog, 'aMBorder'),
    };
    this.mu = {};
    for (const n of ['uMouthOpen', 'uHeadYaw', 'uHeadPitch', 'uFaceTilt', 'uPhoto']) {
      this.mu[n] = gl.getUniformLocation(prog, n);
    }
  }

  _buildMeshTarget() {
    const gl = this.gl;
    this.meshTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.meshTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MESH_FB_SIZE, MESH_FB_SIZE, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.meshFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meshFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this.meshTex, 0);

    // depth buffer so the mesh occludes itself correctly
    this.meshDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.meshDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, MESH_FB_SIZE, MESH_FB_SIZE);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER, this.meshDepth);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Upload a face mesh from mesh.js. Pass null to disable mesh mode.
  setFaceMesh(m) {
    const gl = this.gl;
    if (!m) { this.mesh = null; return; }
    const mk = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    };
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    this.mesh = {
      pos: mk(m.positions), uv: mk(m.uvs), nrm: mk(m.normals),
      jaw: mk(m.jaw), border: mk(m.border), idx,
      count: m.indices.length,
    };
  }

  _renderMeshPass(p) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meshFB);
    gl.viewport(0, 0, MESH_FB_SIZE, MESH_FB_SIZE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    gl.useProgram(this.meshProgram);
    const mesh = this.mesh, ma = this.ma;
    const bind = (buf, loc, size) => {
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(mesh.pos, ma.pos, 3);
    bind(mesh.uv, ma.uv, 2);
    bind(mesh.nrm, ma.nrm, 3);
    bind(mesh.jaw, ma.jaw, 1);
    bind(mesh.border, ma.border, 1);

    gl.uniform1f(this.mu.uMouthOpen, p.mouthOpen);
    gl.uniform1f(this.mu.uHeadYaw, p.headYaw || 0);
    gl.uniform1f(this.mu.uHeadPitch, p.headPitch || 0);
    gl.uniform1f(this.mu.uFaceTilt, p.faceTilt || 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texPhoto);
    gl.uniform1i(this.mu.uPhoto, 1);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setGlyphTexture(canvas, grid, count) {
    const gl = this.gl;
    if (!this.texGlyphs) this.texGlyphs = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texGlyphs);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasGrid = grid;
    this.numGlyphs = count;
  }

  setPhotoTexture(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texPhoto);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  resize(w, h) {
    this.gl.canvas.width = w;
    this.gl.canvas.height = h;
  }

  render(dt, p) {
    const gl = this.gl;
    this.time += dt;

    // mesh mode: render the 3D face into its offscreen target first
    const meshActive = !!(this.mesh && p.meshOn);
    if (meshActive) this._renderMeshPass(p);

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.u.uResolution, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(this.u.uTime, this.time);
    gl.uniform2f(this.u.uAtlasGrid, this.atlasGrid[0], this.atlasGrid[1]);
    gl.uniform1f(this.u.uNumGlyphs, this.numGlyphs);
    gl.uniform1f(this.u.uFaceReveal, p.faceReveal);
    gl.uniform1f(this.u.uAudio, p.audio);
    gl.uniform3f(this.u.uTint, p.tint[0], p.tint[1], p.tint[2]);

    // face params
    gl.uniform2f(this.u.uFaceCenter, p.faceCenter[0], p.faceCenter[1]);
    gl.uniform1f(this.u.uFaceScale, p.faceScale);
    gl.uniform1f(this.u.uFaceTilt, p.faceTilt);
    gl.uniform1f(this.u.uMouthOpen, p.mouthOpen);
    gl.uniform1f(this.u.uMouthCurve, p.mouthCurve);
    gl.uniform1f(this.u.uBrowLift, p.browLift);
    gl.uniform1f(this.u.uBrowTilt, p.browTilt);
    gl.uniform1f(this.u.uEyeOpen, p.eyeOpen);
    gl.uniform1f(this.u.uPupilX, p.pupilX);
    gl.uniform1f(this.u.uPupilY, p.pupilY);
    gl.uniform1f(this.u.uCheek, p.cheek);
    gl.uniform1f(this.u.uBlink, p.blink);

    // photo mode
    gl.uniform1f(this.u.uPhotoOn, p.photoOn || 0);
    gl.uniform1f(this.u.uPhotoHasLm, p.photoHasLm || 0);
    const eL = p.photoEyeL || [0, 0], eR = p.photoEyeR || [0, 0];
    const m = p.photoMouth || [0, 0, 0];
    gl.uniform2f(this.u.uPhotoEyeL, eL[0], eL[1]);
    gl.uniform2f(this.u.uPhotoEyeR, eR[0], eR[1]);
    gl.uniform3f(this.u.uPhotoMouth, m[0], m[1], m[2]);
    gl.uniform1f(this.u.uPhotoHasDepth, p.photoHasDepth || 0);
    gl.uniform1f(this.u.uPhotoChinY, p.photoChinY || 0.85);
    gl.uniform1f(this.u.uHeadYaw, p.headYaw || 0);
    gl.uniform1f(this.u.uHeadPitch, p.headPitch || 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texGlyphs);
    gl.uniform1i(this.u.uGlyphs, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texPhoto);
    gl.uniform1i(this.u.uPhoto, 1);

    gl.uniform1f(this.u.uMeshOn, meshActive ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.meshTex);
    gl.uniform1i(this.u.uMesh, 2);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
