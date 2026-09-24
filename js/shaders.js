// GLSL ES 3.00 shaders for the grading pipeline.
// Pipeline: grade -> (downsample chain -> gaussian H/V) -> final composite

// u_flip = 1 when drawing to the canvas: textures keep the image's top row at v = 0
// (no UNPACK_FLIP_Y, which browsers ignore for ImageBitmap sources), so the final
// on-screen draw flips vertically while intermediate FBO passes keep texel order.
export const VS = `#version 300 es
out vec2 v_uv;
uniform float u_flip;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  if (u_flip > 0.5) v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
vec3 overlay(vec3 b, vec3 s){
  return mix(2.0*b*s, 1.0 - 2.0*(1.0-b)*(1.0-s), step(0.5, b));
}
`;

// Pass 1: per-pixel color grading
export const FS_GRADE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform float u_exposure, u_contrast, u_saturation, u_vibrance, u_temperature, u_tint;
uniform float u_highlights, u_shadows, u_fade, u_hueShift, u_bleach, u_mono, u_filmic;
uniform float u_splitAmt, u_splitBalance, u_gmAmt;
uniform vec3 u_lift, u_gamma, u_gain, u_shadowTint, u_highTint, u_monoMix, u_gmDark, u_gmMid, u_gmLight;
${COMMON}
vec3 s2l(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
vec3 l2s(vec3 c){ c = max(c, 0.0); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
vec3 hueRot(vec3 c, float deg){
  float a = radians(deg); float cs = cos(a), sn = sin(a);
  vec3 k = vec3(0.57735);
  return c*cs + cross(k, c)*sn + k*dot(k, c)*(1.0 - cs);
}
vec3 tonal(vec3 c, float v, float m, float k){
  // v>0: push toward white weighted by mask, v<0: scale down
  return mix(c*(1.0 + v*k*m), c + v*k*m*(1.0 - c), step(0.0, v));
}
void main(){
  vec3 c = texture(u_src, v_uv).rgb;
  // exposure / white balance in linear light
  vec3 lin = s2l(c) * exp2(u_exposure);
  lin *= vec3(1.0 + 0.22*u_temperature + 0.05*u_tint, 1.0 - 0.16*u_tint, 1.0 - 0.22*u_temperature + 0.05*u_tint);
  c = l2s(lin);

  // shadows / highlights
  float lum = dot(c, LW);
  float sm = 1.0 - smoothstep(0.0, 0.55, lum);
  float hm = smoothstep(0.45, 1.0, lum);
  c = tonal(c, u_shadows, sm, 0.45);
  c = tonal(c, u_highlights, hm, 0.35);

  // fade (lift blacks, slightly lower whites)
  c = mix(vec3(u_fade*0.2), vec3(1.0 - u_fade*0.05), c);

  // contrast (S-curve)
  if (u_contrast > 0.0) c = mix(c, c*c*(3.0 - 2.0*c), u_contrast);
  else c = mix(c, vec3(0.5), -u_contrast*0.5);

  // filmic roll-off
  if (u_filmic > 0.0) {
    vec3 x = c * 1.15;
    vec3 f = (x*(2.51*x + 0.03)) / (x*(2.43*x + 0.59) + 0.14);
    c = mix(c, f, u_filmic);
  }

  // lift / gamma / gain
  c = c*(1.0 + u_gain) + u_lift*(1.0 - c);
  c = pow(max(c, 0.0), 1.0/(1.0 + u_gamma));

  c = hueRot(c, u_hueShift);

  // saturation / vibrance
  lum = dot(c, LW);
  c = mix(vec3(lum), c, 1.0 + u_saturation);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = clamp(mx - mn, 0.0, 1.0);
  c = mix(vec3(lum), c, 1.0 + u_vibrance*(1.0 - sat)*1.3);

  // bleach bypass
  if (u_bleach > 0.0) { vec3 d = vec3(dot(c, LW)); c = mix(c, overlay(c, d), u_bleach); }
  // monochrome
  if (u_mono > 0.0) {
    vec3 w = u_monoMix / max(dot(u_monoMix, vec3(1.0)), 1e-4);
    c = mix(c, vec3(dot(c, w)), u_mono);
  }
  // split toning
  lum = dot(clamp(c, 0.0, 1.0), LW);
  float sw = 1.0 - smoothstep(0.0, 0.7 + u_splitBalance*0.3, lum);
  float hw = smoothstep(0.3 + u_splitBalance*0.3, 1.0, lum);
  c += (u_shadowTint*sw + u_highTint*hw) * u_splitAmt;
  // gradient map
  if (u_gmAmt > 0.0) {
    float l = dot(clamp(c, 0.0, 1.0), LW);
    vec3 g = l < 0.5 ? mix(u_gmDark, u_gmMid, l*2.0) : mix(u_gmMid, u_gmLight, (l - 0.5)*2.0);
    c = mix(c, g, u_gmAmt);
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const FS_COPY = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
void main(){ o = texture(u_src, v_uv); }`;

export const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_taps;
void main(){
  vec3 sum = texture(u_src, v_uv).rgb;
  float wsum = 1.0;
  for (int i = 1; i <= u_taps; i++) {
    float fi = float(i);
    float w = exp(-fi*fi / (2.0*u_sigma*u_sigma));
    vec2 off = u_dir * fi;
    sum += (texture(u_src, v_uv + off).rgb + texture(u_src, v_uv - off).rgb) * w;
    wsum += 2.0*w;
  }
  o = vec4(sum / wsum, 1.0);
}`;

// Pass 3: composite (glow/diffusion, halation, clarity, sharpen, chromatic aberration, grain, vignette)
export const FS_FINAL = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_graded, u_blur, u_orig;
uniform vec2 u_res;
uniform float u_glow, u_glowThreshold, u_glowMode, u_halation, u_clarity, u_sharpen, u_chromAb;
uniform float u_grain, u_grainSize, u_grainType, u_vignette, u_vignetteFeather;
uniform float u_posterize, u_posterSoft, u_outline, u_outlineWidth, u_halftone, u_halftoneSize, u_focusBlur, u_focusRadius;
uniform float u_split, u_seed, u_showOrig;
uniform vec3 u_glowTint, u_outlineColor;
${COMMON}
float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main(){
  float s = min(u_res.x, u_res.y) / 1080.0;
  vec2 px = 1.0 / u_res;
  vec2 d = v_uv - 0.5;
  vec3 c;
  if (u_chromAb > 0.0) {
    vec2 off = d * u_chromAb * 0.006;
    c.r = texture(u_graded, v_uv + off).r;
    c.g = texture(u_graded, v_uv).g;
    c.b = texture(u_graded, v_uv - off).b;
  } else {
    c = texture(u_graded, v_uv).rgb;
  }
  vec3 bl = texture(u_blur, v_uv).rgb;
  // selective (radial) blur: keeps the centre sharp, blurs toward the edges
  if (u_focusBlur > 0.0) {
    float r = length(d * 2.0) / 1.41421;
    c = mix(c, bl, u_focusBlur * smoothstep(u_focusRadius, min(u_focusRadius + 0.5, 1.2), r));
  }
  if (u_clarity != 0.0) c = clamp(c + (c - bl) * u_clarity * 0.9, 0.0, 1.0);
  // cel-look: quantise brightness into bands while keeping hue
  if (u_posterize > 0.5) {
    float l = dot(c, LW);
    float n = u_posterize;
    float x = l * n;
    float f = fract(x);
    float soft = max(u_posterSoft, 0.001);
    float q = (floor(x) + smoothstep(0.5 - soft, 0.5 + soft, f)) / n;
    q = mix(q, l, 0.15); // keep a hint of the original gradient so it does not look flat
    c = clamp(c * (max(q, 0.0) + 0.02) / (l + 0.02), 0.0, 1.0);
  }
  // cel-look: ink outlines from a Sobel edge detector on the graded image
  if (u_outline > 0.0) {
    vec2 st = px * max(s, 1.0) * u_outlineWidth;
    float tl = dot(texture(u_graded, v_uv + vec2(-st.x,  st.y)).rgb, LW);
    float t0 = dot(texture(u_graded, v_uv + vec2( 0.0,   st.y)).rgb, LW);
    float tr = dot(texture(u_graded, v_uv + vec2( st.x,  st.y)).rgb, LW);
    float l0 = dot(texture(u_graded, v_uv + vec2(-st.x,  0.0)).rgb, LW);
    float r0 = dot(texture(u_graded, v_uv + vec2( st.x,  0.0)).rgb, LW);
    float bL = dot(texture(u_graded, v_uv + vec2(-st.x, -st.y)).rgb, LW);
    float b0 = dot(texture(u_graded, v_uv + vec2( 0.0,  -st.y)).rgb, LW);
    float br = dot(texture(u_graded, v_uv + vec2( st.x, -st.y)).rgb, LW);
    float gx = (tr + 2.0*r0 + br) - (tl + 2.0*l0 + bL);
    float gy = (tl + 2.0*t0 + tr) - (bL + 2.0*b0 + br);
    float e = length(vec2(gx, gy));
    float line = smoothstep(0.12, 0.45, e) * u_outline;
    c = mix(c, u_outlineColor, clamp(line, 0.0, 1.0));
  }
  // comic halftone dots in the shadows
  if (u_halftone > 0.0) {
    float cell = max(u_halftoneSize * s, 2.0);
    vec2 p = gl_FragCoord.xy;
    mat2 rot = mat2(0.7071, -0.7071, 0.7071, 0.7071);
    vec2 g = rot * p / cell;
    vec2 cp = fract(g) - 0.5;
    float lum = dot(c, LW);
    float shade = 1.0 - smoothstep(0.15, 0.65, lum);      // how much shadow here
    float radius = 0.5 * shade;                            // bigger dots in darker areas
    float dot_ = 1.0 - smoothstep(radius - 0.12, radius + 0.05, length(cp));
    c = mix(c, c * 0.55, dot_ * u_halftone * step(0.05, shade));
  }
  if (u_sharpen > 0.0) {
    vec2 st = px * max(s, 1.0);
    vec3 n = texture(u_graded, v_uv + vec2(st.x, 0.0)).rgb + texture(u_graded, v_uv - vec2(st.x, 0.0)).rgb
           + texture(u_graded, v_uv + vec2(0.0, st.y)).rgb + texture(u_graded, v_uv - vec2(0.0, st.y)).rgb;
    c = clamp(c + (c - n*0.25) * u_sharpen, 0.0, 1.0);
  }
  if (u_glow > 0.0) {
    vec3 g = clamp((bl - u_glowThreshold) / max(1.0 - u_glowThreshold, 1e-3), 0.0, 1.0) * u_glowTint;
    int mode = int(u_glowMode + 0.5);
    vec3 r;
    if (mode == 0) r = 1.0 - (1.0 - c) * (1.0 - g);   // screen
    else if (mode == 1) r = c + g;                    // add (加算発光)
    else if (mode == 2) r = overlay(c, g);            // overlay
    else r = bl;                                      // normal (soft focus)
    c = mix(c, clamp(r, 0.0, 1.0), u_glow);
  }
  if (u_halation > 0.0) {
    vec3 h = clamp((bl - 0.55) / 0.45, 0.0, 1.0);
    float hl = dot(h, LW);
    c = 1.0 - (1.0 - c) * (1.0 - hl * vec3(1.0, 0.35, 0.12) * u_halation);
  }
  if (u_grain > 0.0) {
    float n;
    if (u_grainType < 0.5) {
      vec2 cell = floor(gl_FragCoord.xy / max(u_grainSize * s, 1.0));
      n = (hash(cell + u_seed) + hash(cell * 1.71 + u_seed + 3.1)) * 0.5;
    } else {
      vec2 p = gl_FragCoord.xy / max(u_grainSize * s, 1.0);
      n = vnoise(p + u_seed) * 0.55 + vnoise(p * 2.0 + u_seed + 7.0) * 0.3 + vnoise(p * 4.0 + u_seed + 13.0) * 0.15;
    }
    c = mix(c, overlay(c, vec3(n)), u_grain);
  }
  if (u_vignette > 0.0) {
    float r = length(d * 2.0) / 1.41421;
    float start = 0.85 - u_vignetteFeather * 0.6;
    c *= 1.0 - u_vignette * smoothstep(start, 1.15, r);
  }
  vec3 orig = texture(u_orig, v_uv).rgb;
  if (u_showOrig > 0.5 || v_uv.x < u_split) c = orig;
  o = vec4(c, 1.0);
}`;
