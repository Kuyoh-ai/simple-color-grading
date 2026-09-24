import { Engine } from './engine.js';
import { NEUTRAL, CONTROL_DEFS, ADJUST_KEYS, CATEGORIES, PRESETS, PRESET_MAP, effectiveParams } from './presets.js';

const $ = (s) => document.querySelector(s);
const els = {
  canvas: $('#glcanvas'), viewer: $('#viewer'), dropzone: $('#dropzone'), dragOverlay: $('#dragOverlay'),
  info: $('#viewerInfo'), splitHandle: $('#splitHandle'),
  fileInput: $('#fileInput'), btnOpen: $('#btnOpen'), btnOpen2: $('#btnOpen2'), btnSample: $('#btnSample'),
  btnCompare: $('#btnCompare'), btnSplit: $('#btnSplit'), btnExport: $('#btnExport'), btnTheme: $('#btnTheme'),
  categories: $('#categories'), grid: $('#presetGrid'), presetName: $('#presetName'), presetDesc: $('#presetDesc'),
  presetControls: $('#presetControls'), btnResetPreset: $('#btnResetPreset'),
  adjustControls: $('#adjustControls'), btnResetAdjust: $('#btnResetAdjust'),
  expFormat: $('#expFormat'), expQuality: $('#expQuality'), expQualityVal: $('#expQualityVal'), qualityField: $('#qualityField'),
  expScale: $('#expScale'), expInfo: $('#expInfo'), btnDownload: $('#btnDownload'),
  toast: $('#toast'), busy: $('#busy'), busyText: $('#busyText'), thumbcanvas: $('#thumbcanvas'),
};

const PREVIEW_MAX = 2048;
const THUMB_W = 192;
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const EXPORT_MAX_PIXELS = IS_MOBILE ? 16e6 : 24e6;

const state = {
  image: null,          // { bitmap, name, w, h }
  previewTex: null,     // { tex, w, h }
  thumbTex: null,
  presetId: 'none',
  overrides: {},        // per-preset slider values keyed by preset id
  intensity: {},        // per-preset intensity
  adjust: Object.fromEntries(ADJUST_KEYS.map(k => [k, 0])),
  category: 'all',
  split: null,          // null | 0..1
  showOrig: false,
  thumbJob: 0,
};

let engine, thumbEngine;
try {
  engine = new Engine(els.canvas);
  thumbEngine = new Engine(els.thumbcanvas);
} catch (e) {
  console.error(e);
  els.dropzone.innerHTML = '<div class="dz-inner"><p>このブラウザは WebGL2 に対応していないため利用できません。</p><p class="sub">' + e.message + '</p></div>';
  throw e;
}

/* ---------------- theme ---------------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('scg-theme', t); } catch {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('scg-theme'); } catch {}
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
els.btnTheme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ---------------- helpers ---------------- */
let toastTimer;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}
function busy(on, text = '処理中…') { els.busyText.textContent = text; els.busy.hidden = !on; }
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const fmt = (v, step) => (step >= 1 ? Math.round(v) : v.toFixed(step < 0.01 ? 3 : 2)).toString();

function currentPreset() { return PRESET_MAP[state.presetId] || PRESET_MAP.none; }
function currentParams() {
  const p = currentPreset();
  return effectiveParams(p, state.overrides[p.id] || {}, state.intensity[p.id] ?? 1, state.adjust);
}

/* ---------------- rendering ---------------- */
let rafId = 0;
function requestRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; renderPreview(); });
}

function fitSize() {
  const img = state.image;
  const rect = els.viewer.getBoundingClientRect();
  const vw = Math.max(1, rect.width), vh = Math.max(1, rect.height);
  const scale = Math.min(vw / img.w, vh / img.h, 1e9);
  const cw = Math.max(1, Math.floor(img.w * scale)), ch = Math.max(1, Math.floor(img.h * scale));
  return { cw, ch };
}

function renderPreview() {
  if (!state.image || !state.previewTex) return;
  const { cw, ch } = fitSize();
  els.canvas.style.width = cw + 'px';
  els.canvas.style.height = ch + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.min(Math.round(cw * dpr), state.previewTex.w, engine.maxTex);
  const H = Math.min(Math.round(ch * dpr), state.previewTex.h, engine.maxTex);
  engine.render(state.previewTex, currentParams(), Math.max(W, 1), Math.max(H, 1), {
    split: state.split ?? 0, showOrig: state.showOrig,
  });
  positionSplitHandle();
}

const ro = new ResizeObserver(() => requestRender());
ro.observe(els.viewer);
window.addEventListener('orientationchange', () => setTimeout(requestRender, 200));

/* ---------------- image loading ---------------- */
function scaledCanvas(bitmap, maxDim) {
  const s = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s));
  c.height = Math.max(1, Math.round(bitmap.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try { return await createImageBitmap(blob); } catch {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function loadImage(blob, name = 'image') {
  busy(true, '画像を読み込み中…');
  await nextFrame();
  try {
    const bmp = await decode(blob);
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    if (state.image && state.image.bitmap.close) state.image.bitmap.close();
    engine.deleteTexture(state.previewTex);
    thumbEngine.deleteTexture(state.thumbTex);
    state.image = { bitmap: bmp, name: name.replace(/\.[^.]+$/, ''), w, h };
    const pmax = Math.min(PREVIEW_MAX, engine.maxTex);
    const previewSrc = Math.max(w, h) > pmax ? scaledCanvas(bmp, pmax) : bmp;
    state.previewTex = engine.createTexture(previewSrc, { mipmap: true });
    state.thumbTex = thumbEngine.createTexture(scaledCanvas(bmp, THUMB_W * 1.5), { mipmap: true });

    els.dropzone.hidden = true;
    els.info.hidden = false;
    els.info.textContent = `${w} × ${h}`;
    for (const b of [els.btnCompare, els.btnSplit, els.btnExport, els.btnDownload]) b.disabled = false;
    updateExportInfo();
    requestRender();
    buildThumbnails();
  } catch (e) {
    console.error(e);
    toast('画像を読み込めませんでした: ' + (name || ''));
  } finally {
    busy(false);
  }
}

function openPicker() { els.fileInput.value = ''; els.fileInput.click(); }
els.btnOpen.addEventListener('click', openPicker);
els.btnOpen2.addEventListener('click', openPicker);
els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files && els.fileInput.files[0];
  if (f) loadImage(f, f.name);
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.dragOverlay.hidden = false; });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; els.dragOverlay.hidden = true; } });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; els.dragOverlay.hidden = true;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadImage(f, f.name);
  else if (f) toast('画像ファイルをドロップしてください');
});
// paste
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) loadImage(f, 'pasted'); break; }
  }
});

// sample image
function makeSample() {
  const w = 1600, h = 1067;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#2b4f8a'); sky.addColorStop(0.55, '#7fa6d8'); sky.addColorStop(1, '#f2c9a0');
  x.fillStyle = sky; x.fillRect(0, 0, w, h);
  const sun = x.createRadialGradient(w * 0.72, h * 0.5, 10, w * 0.72, h * 0.5, 260);
  sun.addColorStop(0, 'rgba(255,250,230,1)'); sun.addColorStop(0.15, 'rgba(255,225,170,0.95)'); sun.addColorStop(1, 'rgba(255,200,140,0)');
  x.fillStyle = sun; x.fillRect(0, 0, w, h);
  x.fillStyle = '#3b6b4a';
  x.beginPath(); x.moveTo(0, h * 0.68);
  for (let i = 0; i <= 20; i++) x.lineTo((w / 20) * i, h * (0.62 + 0.06 * Math.sin(i * 1.3) + 0.03 * Math.cos(i * 2.9)));
  x.lineTo(w, h); x.lineTo(0, h); x.closePath(); x.fill();
  const ground = x.createLinearGradient(0, h * 0.7, 0, h);
  ground.addColorStop(0, '#6e8a4e'); ground.addColorStop(1, '#2f3a24');
  x.fillStyle = ground; x.fillRect(0, h * 0.78, w, h * 0.22);
  x.fillStyle = '#1d2a3a'; x.fillRect(w * 0.08, h * 0.45, w * 0.16, h * 0.4);
  x.fillStyle = '#c9c4b8'; x.fillRect(w * 0.1, h * 0.48, w * 0.12, h * 0.05);
  x.fillStyle = '#e8b892';
  x.beginPath(); x.arc(w * 0.42, h * 0.62, 110, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#3a2a22'; x.beginPath(); x.arc(w * 0.42, h * 0.58, 118, Math.PI, Math.PI * 2); x.fill();
  x.fillStyle = '#c7513d'; x.fillRect(w * 0.34, h * 0.72, w * 0.16, h * 0.25);
  const chips = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#ecf0f1', '#95a5a6', '#2c3e50', '#000000', '#ffffff'];
  chips.forEach((col, i) => { x.fillStyle = col; x.fillRect(w * 0.6 + (i % 6) * 90, h * 0.8 + Math.floor(i / 6) * 90, 82, 82); });
  for (let i = 0; i < 11; i++) { const g = Math.round(i * 25.5); x.fillStyle = `rgb(${g},${g},${g})`; x.fillRect(40 + i * 60, 40, 60, 50); }
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
els.btnSample.addEventListener('click', async () => { const b = await makeSample(); loadImage(b, 'sample'); });

/* ---------------- presets UI ---------------- */
function buildCategories() {
  els.categories.innerHTML = '';
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.className = 'chip' + (c.id === state.category ? ' active' : '');
    b.textContent = c.label; b.dataset.cat = c.id;
    b.addEventListener('click', () => { state.category = c.id; buildCategories(); filterGrid(); });
    els.categories.appendChild(b);
  }
}
const cards = new Map();
function buildGrid() {
  els.grid.innerHTML = ''; cards.clear();
  for (const p of PRESETS) {
    const card = document.createElement('div');
    card.className = 'preset-card' + (p.id === state.presetId ? ' active' : '');
    card.dataset.id = p.id; card.dataset.cat = p.cat; card.tabIndex = 0; card.title = p.desc;
    const ph = document.createElement('div'); ph.className = 'ph';
    const cv = document.createElement('canvas'); cv.width = 4; cv.height = 3; cv.hidden = true;
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = p.name;
    card.append(cv, ph, nm);
    card.addEventListener('click', () => selectPreset(p.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPreset(p.id); } });
    els.grid.appendChild(card);
    cards.set(p.id, { card, cv });
  }
  filterGrid();
}
function filterGrid() {
  for (const [id, { card }] of cards) {
    const p = PRESET_MAP[id];
    card.hidden = !(state.category === 'all' || p.cat === state.category || p.id === 'none');
  }
}
function selectPreset(id) {
  state.presetId = id;
  for (const [pid, { card }] of cards) card.classList.toggle('active', pid === id);
  const c = cards.get(id);
  if (c) c.card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  buildPresetControls();
  requestRender();
}

function sliderRow(key, def, value, onInput, { master = false, label } = {}) {
  const row = document.createElement('div');
  row.className = 'slider-row' + (master ? ' master' : '');
  const lab = document.createElement('label'); lab.textContent = label || def.label;
  const val = document.createElement('span'); val.className = 'val'; val.textContent = fmt(value, def.step);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = def.min; inp.max = def.max; inp.step = def.step; inp.value = value;
  inp.dataset.key = key;
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = fmt(v, def.step); onInput(v); });
  inp.addEventListener('dblclick', () => { inp.value = def.reset ?? 0; inp.dispatchEvent(new Event('input')); });
  row.append(lab, val, inp);
  return row;
}

function buildPresetControls() {
  const p = currentPreset();
  els.presetName.textContent = p.name;
  els.presetDesc.textContent = p.desc;
  els.presetControls.innerHTML = '';
  if (p.id === 'none') {
    const n = document.createElement('div'); n.className = 'empty-note';
    n.textContent = 'プリセットを選ぶと、ここに強度スライダーが表示されます。';
    els.presetControls.appendChild(n);
    return;
  }
  const ov = state.overrides[p.id] || (state.overrides[p.id] = {});
  els.presetControls.appendChild(sliderRow('intensity', { label: '適用強度', min: 0, max: 1.5, step: 0.01, reset: 1 },
    state.intensity[p.id] ?? 1, (v) => { state.intensity[p.id] = v; requestRender(); }, { master: true }));
  for (const key of p.controls) {
    const def = CONTROL_DEFS[key];
    const base = p.params[key] ?? NEUTRAL[key];
    const cur = ov[key] ?? base;
    els.presetControls.appendChild(sliderRow(key, { ...def, reset: base }, cur, (v) => { ov[key] = v; requestRender(); }));
  }
}
els.btnResetPreset.addEventListener('click', () => {
  const p = currentPreset();
  state.overrides[p.id] = {}; state.intensity[p.id] = 1;
  buildPresetControls(); requestRender();
});

function buildAdjustControls() {
  els.adjustControls.innerHTML = '';
  for (const key of ADJUST_KEYS) {
    const def = CONTROL_DEFS[key];
    els.adjustControls.appendChild(sliderRow(key, { ...def, reset: 0 }, state.adjust[key], (v) => { state.adjust[key] = v; requestRender(); }));
  }
}
els.btnResetAdjust.addEventListener('click', () => {
  for (const k of ADJUST_KEYS) state.adjust[k] = 0;
  buildAdjustControls(); requestRender();
});

/* thumbnails: render every preset at its defaults onto its card */
async function buildThumbnails() {
  const job = ++state.thumbJob;
  const src = state.thumbTex;
  if (!src) return;
  const tw = THUMB_W, th = Math.max(1, Math.round(THUMB_W * src.h / src.w));
  const ids = PRESETS.map(p => p.id);
  // render visible category first
  ids.sort((a, b) => (cards.get(a).card.hidden ? 1 : 0) - (cards.get(b).card.hidden ? 1 : 0));
  let i = 0;
  while (i < ids.length) {
    if (job !== state.thumbJob) return;
    const t0 = performance.now();
    while (i < ids.length && performance.now() - t0 < 12) {
      const p = PRESET_MAP[ids[i++]];
      const params = effectiveParams(p, {}, 1, null);
      thumbEngine.render(src, params, tw, th);
      const { cv } = cards.get(p.id);
      if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
      cv.getContext('2d').drawImage(els.thumbcanvas, 0, 0);
      cv.hidden = false;
    }
    await nextFrame();
  }
}

/* ---------------- tabs ---------------- */
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
  });
}

/* ---------------- compare / split ---------------- */
function holdStart(e) { if (els.btnCompare.disabled) return; e.preventDefault(); state.showOrig = true; els.btnCompare.classList.add('active'); requestRender(); }
function holdEnd() { if (!state.showOrig) return; state.showOrig = false; els.btnCompare.classList.remove('active'); requestRender(); }
els.btnCompare.addEventListener('pointerdown', holdStart);
window.addEventListener('pointerup', holdEnd);
window.addEventListener('pointercancel', holdEnd);
els.btnCompare.addEventListener('pointerleave', holdEnd);
els.btnCompare.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space' && !e.repeat && state.image) { e.preventDefault(); holdStart(e); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') holdEnd(); });

els.btnSplit.addEventListener('click', () => {
  state.split = state.split === null ? 0.5 : null;
  els.btnSplit.setAttribute('aria-pressed', state.split !== null);
  els.splitHandle.hidden = state.split === null;
  requestRender();
});
function positionSplitHandle() {
  if (state.split === null) return;
  const cr = els.canvas.getBoundingClientRect(), vr = els.viewer.getBoundingClientRect();
  els.splitHandle.style.left = (cr.left - vr.left + cr.width * state.split) + 'px';
  els.splitHandle.style.top = (cr.top - vr.top) + 'px';
  els.splitHandle.style.height = cr.height + 'px';
}
let splitDrag = false;
function splitMove(e) {
  const cr = els.canvas.getBoundingClientRect();
  state.split = Math.min(1, Math.max(0, (e.clientX - cr.left) / cr.width));
  requestRender();
}
els.splitHandle.addEventListener('pointerdown', (e) => { splitDrag = true; els.splitHandle.setPointerCapture(e.pointerId); e.preventDefault(); });
els.splitHandle.addEventListener('pointermove', (e) => { if (splitDrag) splitMove(e); });
els.splitHandle.addEventListener('pointerup', () => { splitDrag = false; });
els.splitHandle.addEventListener('pointercancel', () => { splitDrag = false; });
els.viewer.addEventListener('pointerdown', (e) => {
  if (state.split === null || e.target === els.splitHandle || els.splitHandle.contains(e.target)) return;
  if (e.target !== els.canvas) return;
  splitMove(e);
});

/* ---------------- export ---------------- */
function exportSize() {
  const img = state.image;
  const scale = parseFloat(els.expScale.value);
  let w = Math.round(img.w * scale), h = Math.round(img.h * scale);
  const cap = Math.min(engine.maxTex, engine.maxRb, 8192);
  let s = Math.min(1, cap / Math.max(w, h));
  if (w * h * s * s > EXPORT_MAX_PIXELS) s = Math.min(s, Math.sqrt(EXPORT_MAX_PIXELS / (w * h)));
  const limited = s < 1;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), limited };
}
function updateExportInfo() {
  if (!state.image) return;
  const { w, h, limited } = exportSize();
  els.expInfo.textContent = `出力サイズ: ${w} × ${h} px` + (limited ? ' (この端末で処理できる上限に合わせて縮小されます)' : '');
  els.qualityField.style.display = els.expFormat.value === 'image/png' ? 'none' : '';
}
els.expFormat.addEventListener('change', updateExportInfo);
els.expScale.addEventListener('change', updateExportInfo);
els.expQuality.addEventListener('input', () => { els.expQualityVal.textContent = els.expQuality.value; });
els.btnExport.addEventListener('click', () => {
  document.querySelector('.tab[data-tab="export"]').click();
});

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function doExport() {
  if (!state.image) return;
  const type = els.expFormat.value;
  const quality = parseInt(els.expQuality.value, 10) / 100;
  const { w, h } = exportSize();
  busy(true, `書き出し中… (${w} × ${h})`);
  await nextFrame();
  let fullTex = null;
  const cssW = els.canvas.style.width, cssH = els.canvas.style.height;
  try {
    const bmp = state.image.bitmap;
    const maxSrc = Math.min(engine.maxTex, Math.max(w, h));
    const src = Math.max(state.image.w, state.image.h) > maxSrc ? scaledCanvas(bmp, maxSrc) : bmp;
    fullTex = engine.createTexture(src, { mipmap: false });
    const params = currentParams();
    engine.render(fullTex, params, w, h, { split: 0, showOrig: false });
    const err = engine.gl.getError();
    if (err !== engine.gl.NO_ERROR) throw new Error('WebGL error ' + err);
    let blob = await canvasToBlob(els.canvas, type, quality);
    let outType = type;
    if (!blob || (blob.type && blob.type !== type)) {
      // browser could not encode requested format (e.g. WebP on old Safari) → fall back to PNG
      outType = 'image/png';
      engine.render(fullTex, params, w, h, { split: 0, showOrig: false });
      blob = await canvasToBlob(els.canvas, outType);
      if (type !== outType) toast('この形式で保存できないため PNG で書き出しました');
    }
    if (!blob) throw new Error('encode failed');
    const ext = outType === 'image/jpeg' ? 'jpg' : outType === 'image/webp' ? 'webp' : 'png';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.image.name}_${state.presetId}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`書き出しました (${w} × ${h}, ${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e) {
    console.error(e);
    toast('書き出しに失敗しました。出力サイズを小さくしてお試しください。', 4000);
  } finally {
    engine.deleteTexture(fullTex);
    engine.releaseFBOs();
    els.canvas.style.width = cssW; els.canvas.style.height = cssH;
    busy(false);
    requestRender();
  }
}
els.btnDownload.addEventListener('click', doExport);

/* ---------------- context loss ---------------- */
els.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('描画コンテキストが失われました。ページを再読み込みしてください。', 6000); });

/* ---------------- init ---------------- */
buildCategories();
buildGrid();
buildPresetControls();
buildAdjustControls();
