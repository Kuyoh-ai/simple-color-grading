import { VS, FS_GRADE, FS_COPY, FS_BLUR, FS_FINAL } from './shaders.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}

function createProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  }
  return { prog: p, loc: new Map() };
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.pGrade = createProgram(gl, VS, FS_GRADE);
    this.pCopy = createProgram(gl, VS, FS_COPY);
    this.pBlur = createProgram(gl, VS, FS_BLUR);
    this.pFinal = createProgram(gl, VS, FS_FINAL);
    this.vao = gl.createVertexArray();
    this.fbos = new Map();
    this.seed = Math.random() * 100;
  }

  uniform(p, name) {
    if (!p.loc.has(name)) p.loc.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.loc.get(name);
  }

  setUniforms(p, obj) {
    const gl = this.gl;
    for (const [k, v] of Object.entries(obj)) {
      const loc = this.uniform(p, 'u_' + k);
      if (loc === null) continue;
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        if (v.length === 2) gl.uniform2fv(loc, v);
        else if (v.length === 3) gl.uniform3fv(loc, v);
        else if (v.length === 4) gl.uniform4fv(loc, v);
      }
    }
  }

  /** Upload an image source (ImageBitmap / canvas / img) as a texture. */
  createTexture(source, { mipmap = true } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    const w = source.width || source.naturalWidth, h = source.height || source.naturalHeight;
    return { tex, w, h };
  }

  deleteTexture(t) { if (t && t.tex) this.gl.deleteTexture(t.tex); }

  getFBO(name, w, h) {
    const gl = this.gl;
    let f = this.fbos.get(name);
    if (f && f.w === w && f.h === h) return f;
    if (f) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    f = { fb, tex, w, h };
    this.fbos.set(name, f);
    return f;
  }

  /** Free intermediate buffers (after a large export). */
  releaseFBOs() {
    const gl = this.gl;
    for (const f of this.fbos.values()) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos.clear();
  }

  bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  draw(p, target, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Render `src` ({tex,w,h}) with `params` at W x H.
   * opts.target: an FBO (from getFBO) to draw into instead of the canvas.
   * opts.orig:   texture used as the "original" for split / hold-compare (defaults to src.tex).
   * opts.split (0..1) shows original left of the split; opts.showOrig shows original entirely.
   */
  render(src, params, W, H, opts = {}) {
    const gl = this.gl;
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    if (!opts.target && (this.canvas.width !== W || this.canvas.height !== H)) {
      this.canvas.width = W; this.canvas.height = H;
    }
    gl.disable(gl.BLEND);

    // --- pass 1: grade
    const G = this.getFBO('g', W, H);
    gl.useProgram(this.pGrade.prog);
    this.bindTex(0, src.tex);
    gl.uniform1i(this.uniform(this.pGrade, 'u_src'), 0);
    this.setUniforms(this.pGrade, {
      exposure: params.exposure, contrast: params.contrast, saturation: params.saturation,
      vibrance: params.vibrance, temperature: params.temperature, tint: params.tint,
      highlights: params.highlights, shadows: params.shadows, fade: params.fade,
      hueShift: params.hueShift, bleach: params.bleach, mono: params.mono, filmic: params.filmic,
      splitAmt: params.splitAmt, splitBalance: params.splitBalance, gmAmt: params.gmAmt,
      lift: params.lift, gamma: params.gamma, gain: params.gain,
      shadowTint: params.shadowTint, highTint: params.highTint, monoMix: params.monoMix,
      gmDark: params.gmDark, gmMid: params.gmMid, gmLight: params.gmLight,
    });
    this.draw(this.pGrade, G, W, H);

    // --- pass 2: blur chain (only when needed)
    const needBlur = params.glow > 0 || params.clarity !== 0 || params.halation > 0 || params.focusBlur > 0;
    let blurTex = G.tex;
    if (needBlur) {
      let sigma = params.blurRadius * Math.min(W, H);
      let w = W, h = H, cur = G, lvl = 0;
      while (sigma > 6 && Math.min(w, h) > 64) {
        w = Math.ceil(w / 2); h = Math.ceil(h / 2); sigma /= 2;
        const nf = this.getFBO('d' + lvl, w, h);
        gl.useProgram(this.pCopy.prog);
        this.bindTex(0, cur.tex);
        gl.uniform1i(this.uniform(this.pCopy, 'u_src'), 0);
        this.draw(this.pCopy, nf, w, h);
        cur = nf; lvl++;
      }
      sigma = Math.max(sigma, 0.4);
      const taps = Math.min(Math.ceil(sigma * 3), 20);
      const b1 = this.getFBO('b1', w, h);
      const b2 = this.getFBO('b2', w, h);
      gl.useProgram(this.pBlur.prog);
      gl.uniform1i(this.uniform(this.pBlur, 'u_src'), 0);
      gl.uniform1f(this.uniform(this.pBlur, 'u_sigma'), sigma);
      gl.uniform1i(this.uniform(this.pBlur, 'u_taps'), taps);
      this.bindTex(0, cur.tex);
      gl.uniform2f(this.uniform(this.pBlur, 'u_dir'), 1 / w, 0);
      this.draw(this.pBlur, b1, w, h);
      this.bindTex(0, b1.tex);
      gl.uniform2f(this.uniform(this.pBlur, 'u_dir'), 0, 1 / h);
      this.draw(this.pBlur, b2, w, h);
      blurTex = b2.tex;
    }

    // --- pass 3: final composite
    gl.useProgram(this.pFinal.prog);
    this.bindTex(0, G.tex);
    this.bindTex(1, blurTex);
    this.bindTex(2, opts.orig || src.tex);
    gl.uniform1i(this.uniform(this.pFinal, 'u_graded'), 0);
    gl.uniform1i(this.uniform(this.pFinal, 'u_blur'), 1);
    gl.uniform1i(this.uniform(this.pFinal, 'u_orig'), 2);
    this.setUniforms(this.pFinal, {
      res: [W, H],
      glow: params.glow, glowThreshold: params.glowThreshold, glowMode: params.glowMode,
      glowTint: params.glowTint, halation: params.halation, clarity: params.clarity,
      sharpen: params.sharpen, chromAb: params.chromAb, grain: params.grain,
      grainSize: params.grainSize, grainType: params.grainType,
      vignette: params.vignette, vignetteFeather: params.vignetteFeather,
      posterize: params.posterize, posterSoft: params.posterSoft,
      outline: params.outline, outlineWidth: params.outlineWidth, outlineColor: params.outlineColor,
      halftone: params.halftone, halftoneSize: params.halftoneSize,
      focusBlur: params.focusBlur, focusRadius: params.focusRadius,
      split: opts.split ?? 0, seed: this.seed, showOrig: opts.showOrig ? 1 : 0,
    });
    this.draw(this.pFinal, opts.target || null, W, H);
    gl.bindVertexArray(null);
  }

  /**
   * Apply a list of parameter sets in sequence (layer stacking). Each stage's
   * output feeds the next; the last stage draws to the canvas.
   */
  renderStack(src, paramsList, W, H, opts = {}) {
    if (paramsList.length === 0) paramsList = [null];
    let cur = src;
    for (let i = 0; i < paramsList.length; i++) {
      const last = i === paramsList.length - 1;
      const p = paramsList[i];
      if (last) {
        this.render(cur, p, W, H, { ...opts, orig: src.tex, target: null });
      } else {
        const t = this.getFBO('stack' + (i % 2), Math.round(W), Math.round(H));
        this.render(cur, p, W, H, { target: t, orig: src.tex, split: 0, showOrig: false });
        cur = { tex: t.tex, w: t.w, h: t.h };
      }
    }
  }
}
