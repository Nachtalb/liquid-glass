// liquid-glass.js — Apple-style Liquid Glass for Chromium (SVG filter as backdrop-filter).
// Technique: https://kube.io/blog/liquid-glass-css-svg/
//
//   <script type="module" src="liquid-glass.js"></script>
//   <div data-glass style="border-radius:24px">…</div>          any element
//   <lg-switch> <lg-slider> <lg-segmented>                      components
//   .lg-btn .lg-field .lg-panel .lg-menu .lg-tabbar             classes (+ data-glass)
//
// Tune per element with CSS custom properties (non-inherited) or glass(el, opts):
//   --lg-profile squircle|circle|concave|lip   --lg-bezel px   --lg-thickness px   --lg-ior
//   --lg-refraction 0..n   --lg-blur px   --lg-saturation   --lg-specular 0..1   --lg-light deg
//   --lg-zoom (>1 magnifies)   --lg-antialias (smoothing of zoomed pixels, 1 = auto, 0 = off)
//   --lg-merge px (<lg-merge>: how close its children's glass starts to melt together)
// Values are read when the element is first glassed and on every resize. Call el.glass.update() after changing them.
//
// The backdrop-filter lives on the element's ::before (inset: 0, z-index: -1), not on the element itself:
// Chromium offsets feImage by the element's ink overflow (shadows, outlines, overflowing children),
// and a bare ::before has none. Side effects: glass elements get position: relative + isolation: isolate,
// their own ::before is taken, and opacity < 1 on the element hides what is behind the glass.

const DEFAULTS = {
  profile: 'squircle',
  bezel: 'auto',
  thickness: 'auto',
  ior: 1.5,
  refraction: 1,
  blur: 1,
  saturation: 5,
  specular: 0.7,
  light: 225,
  zoom: 1,
  antialias: 1,
  merge: 20,
};

const smootherstep = t => t * t * t * (t * (t * 6 - 15) + 10);
// Glass height across the bezel: u = 0 at the outer edge, 1 where the flat top starts.
export const profiles = {
  circle: u => Math.sqrt(1 - (1 - u) ** 2),
  squircle: u => (1 - (1 - u) ** 4) ** 0.25,
  concave: u => 1 - profiles.squircle(u),
  lip: u => profiles.squircle(u) + (profiles.concave(u) - profiles.squircle(u)) * smootherstep(u),
};

// Horizontal displacement (px, + = towards the centre) of a vertical ray hitting the bezel at n
// points. One refraction (Snell), air → glass, glass sits directly on the background.
export function bezelDisplacement(f, bezel, thickness, ior, n = 128) {
  const out = new Float32Array(n),
    eta = 1 / ior,
    d = 1e-3;
  for (let i = 0; i < n; i++) {
    const u = i / n,
      a = Math.max(0, u - d),
      b = Math.min(1, u + d);
    const slope = (((f(b) - f(a)) / (b - a)) * thickness) / bezel;
    const len = Math.hypot(slope, 1),
      nx = -slope / len,
      nz = 1 / len; // surface normal, x points inward
    const c = eta * nz - Math.sqrt(1 - eta * eta * (1 - nz * nz));
    const tx = c * nx,
      tz = c * nz - eta; // refracted direction (incident = (0, -1))
    out[i] = (tx * f(u) * thickness) / -tz;
  }
  return out;
}

// Signed distance (px, < 0 inside) to a rounded rect { x, y, w, h, r } given in element px.
const sdRect = (px, py, s) => {
  const qx = Math.abs(px - s.x - s.w / 2) - s.w / 2 + s.r,
    qy = Math.abs(py - s.y - s.h / 2) - s.h / 2 + s.r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r;
};

// RGBA map for a rounded rect: R = x and G = y displacement (128 = none), B = rim light, A = 255.
// With shapes (rounded rects) it maps their smooth union instead, blended over `merge` px so close shapes
// melt into one; A then holds the shape's coverage, which the filter uses to cut the glass out.
// Plus a magnifier map if zoom ≠ 1, around each shape's own centre when there are shapes.
// scale/zscale are the matching feDisplacementMap scales.
// res < 1 renders the maps smaller; feImage stretches them back (the fields are smooth).
let lens; // the last profile: moving shapes re-render with the same one every frame
function lensProfile({ bezel, thickness, profile, ior }) {
  const k = [bezel, thickness, profile, ior].join();
  if (lens?.k === k) return lens;
  const disp = bezelDisplacement(profiles[profile] ?? profiles.squircle, bezel, thickness, ior, 128);
  // Physics says 0 right at the rim, then a near-vertical climb to the peak: hold the peak out to the rim
  // instead, or that cliff aliases into a sawtooth edge.
  const peak = disp.reduce((p, v, i) => (Math.abs(v) > Math.abs(disp[p]) ? i : p), 0);
  disp.fill(disp[peak], 0, peak);
  return (lens = { k, disp, max: Math.abs(disp[peak]) || 1 });
}

export function computeMaps(w, h, o, res = 1, shapes) {
  const { radius: r, bezel, light, zoom, merge = 0 } = o,
    W = Math.ceil(w * res),
    H = Math.ceil(h * res),
    n = 128,
    { disp, max } = lensProfile(o);
  const lx = Math.cos((light * Math.PI) / 180),
    ly = Math.sin((light * Math.PI) / 180);
  const k = merge || 1e-6,
    pad = k / 4 + 2, // the union reaches at most k/4 past a shape; 2px more for the antialiased edge
    reach = k * 1.25 + 2, // past this a shape can't move the union's edge (needs d < k/4 + 1 within k of it)
    S = shapes?.map(s => ({ cx: s.x + s.w / 2, cy: s.y + s.h / 2, hw: s.w / 2, hh: s.h / 2, r: s.r }));
  const dmap = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) * w) / W - w / 2,
        py = ((y + 0.5) * h) / H - h / 2; // feImage stretches W×H onto w×h
      const i = (y * W + x) * 4;
      let e,
        nx = 0,
        ny = 0, // e: distance inside the edge, (nx, ny): outward edge normal
        a = 255;
      if (shapes) {
        // Hot loop (runs every frame while shapes move): one distance per nearby shape with its exact
        // gradient, folded with a polynomial smooth min whose gradient is the same blend. No allocations.
        let d = Infinity,
          gx = 0,
          gy = 0;
        for (const s of S) {
          const ox = px + w / 2 - s.cx,
            oy = py + h / 2 - s.cy,
            ax = Math.abs(ox),
            ay = Math.abs(oy);
          if (ax > s.hw + reach || ay > s.hh + reach) continue;
          const qx = ax - s.hw + s.r,
            qy = ay - s.hh + s.r;
          let b,
            bx = 0,
            by = 0;
          if (qx > 0 && qy > 0) {
            const l = Math.hypot(qx, qy);
            b = l - s.r;
            bx = qx / l;
            by = qy / l;
          } else if (qx > qy) {
            b = qx - s.r;
            bx = 1;
          } else {
            b = qy - s.r;
            by = 1;
          }
          if (ox < 0) bx = -bx;
          if (oy < 0) by = -by;
          if (d === Infinity) {
            d = b;
            gx = bx;
            gy = by;
            continue;
          }
          const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - d)) / k)); // 1 keeps d, 0 takes b
          d = b + (d - b) * t - k * t * (1 - t);
          gx = bx + (gx - bx) * t;
          gy = by + (gy - by) * t;
        }
        if (d > pad) {
          dmap[i] = dmap[i + 1] = 128; // outside the union: neutral and transparent
          dmap[i + 2] = dmap[i + 3] = 0;
          continue;
        }
        const gl = Math.hypot(gx, gy) || 1;
        e = -d;
        nx = gx / gl;
        ny = gy / gl;
        a = Math.min(1, Math.max(0, 0.5 - (d * W) / w)) * 255; // edge antialiased over one map pixel
      } else {
        const qx = Math.abs(px) - w / 2 + r,
          qy = Math.abs(py) - h / 2 + r;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy);
          e = r - l;
          nx = qx / l;
          ny = qy / l;
        } else if (qx > qy) {
          e = r - qx;
          nx = 1;
        } else {
          e = r - qy;
          ny = 1;
        }
        nx *= Math.sign(px) || 1;
        ny *= Math.sign(py) || 1;
      }
      let dx = 0,
        dy = 0,
        s = 0;
      if (e < bezel) {
        // outside the shape too (e < 0): keeps low-res maps from stair-stepping, the clip draws the edge
        const ee = Math.max(e, 0),
          m = disp[Math.min(n - 1, ((ee / bezel) * n) | 0)];
        dx = -nx * m;
        dy = -ny * m;
        s = (nx * lx + ny * ly) ** 2 * Math.exp(-ee / Math.max(2, 1 / res)); // rim light, strongest facing the light axis
      }
      dmap[i] = 128 + (dx / max) * 127;
      dmap[i + 1] = 128 + (dy / max) * 127;
      dmap[i + 2] = s * 255;
      dmap[i + 3] = a;
    }
  // Magnifier: sample towards the centre. The field is linear and feImage upscaling interpolates it
  // exactly, so ≤32px is plenty. Per-axis range (not the diagonal) keeps the 8-bit steps finer.
  // Shapes each magnify around their own centre, blended where they merge: linear inside each shape,
  // so a quarter of the map's resolution still does.
  const z = 1 - 1 / zoom,
    zmax =
      (shapes ? (o.side ?? Math.max(...shapes.flatMap(s => [s.w, s.h]))) / 2 + pad : Math.max(w, h) / 2) *
        Math.abs(z) || 1;
  const ZW = z ? (shapes ? Math.max(2, Math.ceil(W / 4)) : Math.min(32, W)) : 0,
    ZH = z ? (shapes ? Math.max(2, Math.ceil(H / 4)) : Math.min(32, H)) : 0,
    zmap = z ? new Uint8ClampedArray(ZW * ZH * 4) : null;
  for (let y = 0; y < ZH; y++)
    for (let x = 0; x < ZW; x++) {
      const i = (y * ZW + x) * 4,
        X = ((x + 0.5) * w) / ZW,
        Y = ((y + 0.5) * h) / ZH;
      let cx = w / 2,
        cy = h / 2;
      if (shapes) {
        let sum = 0;
        cx = cy = 0;
        for (const s of shapes) {
          // 1 inside, easing to exactly 0 two pads out: a neighbour that isn't merging can't pull the centre
          const q = Math.max(0, 1 - Math.max(0, sdRect(X, Y, s)) / (2 * pad)) ** 2;
          sum += q;
          cx += q * (s.x + s.w / 2);
          cy += q * (s.y + s.h / 2);
        }
        [cx, cy] = sum ? [cx / sum, cy / sum] : [X, Y]; // out of every shape's reach: no zoom, it's cut away
      }
      zmap[i] = 128 - (((X - cx) * z) / zmax) * 127;
      zmap[i + 1] = 128 - (((Y - cy) * z) / zmax) * 127;
      zmap[i + 2] = 128;
      zmap[i + 3] = 255;
    }
  // feDisplacementMap moves by scale × (C − 0.5), so a full ±127 step is only half the scale
  return { W, H, dmap, ZW, ZH, zmap, scale: 2 * max, zscale: z ? 2 * zmax : 0 };
}

// ---------------------------------------------------------------- DOM (browser only)

const NS = 'http://www.w3.org/2000/svg';
// Chromium re-sends a reference filter, feImage pixels included, with every compositor frame,
// so the chain carries one small map and skips the zoom stage unless it is used.
// shaped: the map's alpha holds the shape, and the last step cuts the glass to it.
const FILTER = (zoom, shaped) => `${
  zoom
    ? `
<feImage preserveAspectRatio="none" result="zmap"/>
<feDisplacementMap in="SourceGraphic" in2="zmap" xChannelSelector="R" yChannelSelector="G" result="zoomed"/>`
    : ''
}
<feGaussianBlur in="${zoom ? 'zoomed' : 'SourceGraphic'}" edgeMode="duplicate" result="blur"/>
<feImage preserveAspectRatio="none" result="map"/>
<feDisplacementMap in="blur" in2="map" xChannelSelector="R" yChannelSelector="G" result="refracted"/>
<feColorMatrix in="refracted" type="saturate" result="saturated"/>
<feColorMatrix in="map" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0" result="rimlight"/>
<feComposite in="saturated" in2="rimlight" operator="in" result="rim"/>
<feComponentTransfer in="rimlight" result="highlight"><feFuncA type="linear"/></feComponentTransfer>
<feBlend in="rim" in2="refracted" result="rimmed"/>
<feBlend in="highlight" in2="rimmed"${shaped ? ' result="lit"/>\n<feComposite in="lit" in2="map" operator="in"/>' : '/>'}`;

let uid = 0,
  svg;
const cache = new Map(); // geometry key → map URLs + scales, small LRU

function mapsFor(key, make) {
  let v = cache.get(key);
  if (v) cache.delete(key);
  else v = make();
  cache.set(key, v);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return v;
}

let canvas; // one for every map: shapes re-encode each frame while they move
function toURL(data, W, H) {
  canvas ??= document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  // a CPU canvas: a GPU one would read the pixels back from the GPU for every toDataURL
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(data, W, H), 0, 0);
  return canvas.toDataURL();
}

// fixed resolution levels for shaped glass: steps that never drift between frames
const LEVELS = [2, 1, 1 / 2];

// WebGL2 renders shaped maps (smooth union, refraction, rim light, per-shape zoom) in a shader: the same maths as
// computeMaps, which stays for tests and as the fallback. Only the PNG hand-over is left on the CPU.
const FRAG = `#version 300 es
precision highp float;
uniform vec2 size, grid, at, light; // at: this map's corner in the canvas
uniform int n, mode;
uniform vec4 box[8], lut[32]; // shapes as centre + half size; the bezel profile, 128 steps
uniform float rad[8], k, pad, reach, bezel, peak, falloff, z, zmax;
out vec4 o;
float sd(int i, vec2 p, out vec2 g) { // rounded-rect distance and its gradient
  vec2 off = p - box[i].xy, q = abs(off) - box[i].zw + rad[i];
  float d;
  if (q.x > 0. && q.y > 0.) { float l = length(q); d = l - rad[i]; g = q / l; }
  else if (q.x > q.y) { d = q.x - rad[i]; g = vec2(1, 0); }
  else { d = q.y - rad[i]; g = vec2(0, 1); }
  g *= vec2(off.x < 0. ? -1. : 1., off.y < 0. ? -1. : 1.);
  return d;
}
void main() {
  vec2 p = (gl_FragCoord.xy - at) * size / grid, g; // readPixels rows run bottom-up, so map row 0 is GL row 0
  if (mode == 1) { // zoom: towards each shape's own centre, blended where they merge
    vec2 c = vec2(0);
    float sum = 0.;
    for (int i = 0; i < n; i++) { float q = max(0., 1. - max(0., sd(i, p, g)) / (2. * pad)); sum += q * q; c += q * q * box[i].xy; }
    c = sum > 0. ? c / sum : p;
    o = vec4((128. - (p - c) * z / zmax * 127.) / 255., 128. / 255., 1);
    return;
  }
  float d = 0.;
  vec2 gd = vec2(0);
  bool any = false;
  for (int i = 0; i < n; i++) {
    vec2 a = abs(p - box[i].xy);
    if (a.x > box[i].z + reach || a.y > box[i].w + reach) continue;
    float b = sd(i, p, g);
    if (!any) { d = b; gd = g; any = true; continue; }
    float t = clamp(.5 + .5 * (b - d) / k, 0., 1.); // polynomial smooth min, gradient blended alike
    d = b + (d - b) * t - k * t * (1. - t);
    gd = g + (gd - g) * t;
  }
  if (!any || d > pad) { o = vec4(0); return; }
  float l = length(gd), e = -d, s = 0.;
  vec2 nrm = l > 0. ? gd / l : gd, dv = vec2(0);
  if (e < bezel) {
    float ee = max(e, 0.);
    int i = min(127, int(ee / bezel * 128.));
    dv = -nrm * lut[i >> 2][i & 3];
    s = pow(dot(nrm, light), 2.) * exp(-ee / falloff);
  }
  o = vec4((128. + dv / peak * 127.) / 255., s, clamp(.5 - d * grid.x / size.x, 0., 1.));
}`;
let gl, prog, U;
function glMaps(w, h, o, res, shapes) {
  if (gl === undefined) {
    const c = document.createElement('canvas');
    gl = c.getContext('webgl2', { antialias: false });
    if (gl) {
      prog = gl.createProgram();
      for (const [type, src] of [
        [
          gl.VERTEX_SHADER,
          '#version 300 es\nvoid main(){gl_Position=vec4(vec2(gl_VertexID&1,gl_VertexID>>1)*4.-1.,0,1);}',
        ],
        [gl.FRAGMENT_SHADER, FRAG],
      ]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        gl.attachShader(prog, s);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) gl = null;
      else {
        gl.useProgram(prog);
        gl.disable(gl.DITHER); // exact values, they're data
        U = new Proxy({}, { get: (m, k) => (m[k] ??= gl.getUniformLocation(prog, k)) });
      }
    }
  }
  if (!gl || gl.isContextLost() || shapes.length > 8) return null;
  const { disp, max } = lensProfile(o),
    k = o.merge || 1e-6,
    pad = k / 4 + 2,
    z = 1 - 1 / o.zoom,
    zmax = (o.side / 2 + pad) * Math.abs(z) || 1,
    box = new Float32Array(32);
  shapes.forEach((s, i) => box.set([s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2], i * 4));
  gl.uniform2f(U.size, w, h);
  gl.uniform2f(U.light, Math.cos((o.light * Math.PI) / 180), Math.sin((o.light * Math.PI) / 180));
  gl.uniform1i(U.n, shapes.length);
  gl.uniform4fv(U.box, box);
  gl.uniform1fv(
    U.rad,
    Float32Array.from({ length: 8 }, (_, i) => shapes[i]?.r ?? 0),
  );
  gl.uniform4fv(U.lut, Float32Array.from(disp));
  gl.uniform1f(U.k, k);
  gl.uniform1f(U.pad, pad);
  gl.uniform1f(U.reach, k * 1.25 + 2);
  gl.uniform1f(U.bezel, o.bezel);
  gl.uniform1f(U.peak, max);
  gl.uniform1f(U.falloff, Math.max(2, 1 / res));
  gl.uniform1f(U.z, z);
  gl.uniform1f(U.zmax, zmax);
  // Both maps in one canvas (grown, never shrunk) and one readback: each readPixels waits for the GPU.
  // The PNGs come from the CPU canvas, like computeMaps' do.
  const W = Math.ceil(w * res),
    H = Math.ceil(h * res),
    ZW = z ? Math.max(2, Math.ceil(W / 4)) : 0,
    ZH = z ? Math.max(2, Math.ceil(H / 4)) : 0,
    c = gl.canvas,
    px = new Uint8ClampedArray(W * (H + ZH) * 4);
  if (c.width < W || c.height < H + ZH)
    Object.assign(c, { width: Math.max(c.width, W), height: Math.max(c.height, H + ZH) });
  for (const [mode, y, mw, mh] of [
    [0, 0, W, H],
    [1, H, ZW, ZH],
  ]) {
    if (!mw) continue;
    gl.viewport(0, y, mw, mh);
    gl.uniform2f(U.grid, mw, mh);
    gl.uniform2f(U.at, 0, y);
    gl.uniform1i(U.mode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.readPixels(0, 0, W, H + ZH, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const zmap = z && new Uint8ClampedArray(ZW * ZH * 4);
  for (let y = 0; y < ZH; y++) zmap.set(px.subarray((H + y) * W * 4, ((H + y) * W + ZW) * 4), y * ZW * 4);
  return {
    d: toURL(px.subarray(0, W * H * 4), W, H),
    z: z ? toURL(zmap, ZW, ZH) : undefined,
    scale: 2 * max,
    zscale: z ? 2 * zmax : 0,
  };
}

function readOpts(el, opts) {
  const cs = getComputedStyle(el),
    o = {};
  for (const k in DEFAULTS) {
    const v = String(opts[k] ?? cs.getPropertyValue('--lg-' + k)).trim(),
      n = parseFloat(v);
    o[k] = v === '' ? DEFAULTS[k] : isNaN(n) ? v : n;
  }
  return [o, cs];
}

// Glass outside the viewport (plus a margin) drops its filter, so it costs nothing per frame.
const onScreen =
  globalThis.IntersectionObserver &&
  new IntersectionObserver(entries => entries.forEach(e => e.target.glass?.show(e.isIntersecting)), {
    rootMargin: '25%',
  });

export function glass(el, opts = {}) {
  if (el.glass) return el.glass;
  if (!el.hasAttribute('data-glass')) el.setAttribute('data-glass', ''); // the ::before rule keys off it
  if (!svg) {
    svg = document.body.appendChild(document.createElementNS(NS, 'svg'));
    svg.setAttribute('style', 'position:absolute;width:0;height:0;pointer-events:none');
    svg.setAttribute('aria-hidden', 'true');
  }
  const filter = svg.appendChild(document.createElementNS(NS, 'filter'));
  filter.id = 'lg-' + ++uid;
  filter.setAttribute('color-interpolation-filters', 'sRGB'); // linearRGB would skew the map values
  for (const [a, v] of [
    ['x', 0],
    ['y', 0],
    ['width', 1],
    ['height', 1],
  ])
    filter.setAttribute(a, v); // default region is 144% of the area
  const fe = {}; // primitives by result name
  let key,
    zoomed,
    shown = true;
  const show = () => el.style.setProperty('--lg-filter', shown ? `url(#${filter.id})` : 'none');

  const render = () => {
    const [o, cs] = readOpts(opts.source ?? el, opts),
      b = parseFloat(cs.borderLeftWidth),
      br = cs.borderTopLeftRadius;
    const w = el.offsetWidth - b - parseFloat(cs.borderRightWidth),
      h = el.offsetHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    const shapes = opts.shapes?.(); // [{ x, y, w, h, r }] in element px: glass cut to their smooth union
    if (w <= 0 || h <= 0 || shapes?.length === 0) return;
    const half = shapes ? Math.min(...shapes.map(s => Math.min(s.w, s.h) / 2)) : Math.min(w, h) / 2; // ::before covers the padding box, so radius and size are inner ones
    o.radius = shapes
      ? Math.min(...shapes.map(s => s.r))
      : Math.max(
          0,
          Math.min(
            half,
            (br.endsWith('%')
              ? (parseFloat(br) / 100) * Math.min(el.offsetWidth, el.offsetHeight)
              : parseFloat(br) || 0) - b,
          ),
        );
    if (o.bezel === 'auto') o.bezel = Math.max(10, o.radius * 0.8);
    o.bezel = Math.min(half, o.bezel);
    if (o.thickness === 'auto') o.thickness = o.bezel * 1.2;
    const z = o.zoom !== 1;
    if (z !== zoomed) {
      zoomed = z;
      filter.innerHTML = FILTER(zoomed, !!shapes);
      for (const n of filter.querySelectorAll('[result]')) fe[n.getAttribute('result')] = n;
      fe.slope = filter.querySelector('feFuncA');
      key = null;
    }
    let m;
    if (shapes) {
      // Shapes carry the outline in the map, so they render per device pixel to stay crisp, moving or not, within
      // ~40k pixels for the largest shape (feImage pixels are re-sent every frame), on fixed levels so it never
      // drifts. Level and zoom scale come from the largest side and area of the whole group (opts.size: every pane
      // of an lg-merge), so a shape renders the same alone as next to another.
      const [side, area] = opts.size?.() ?? [
          Math.max(...shapes.flatMap(s => [s.w, s.h])),
          Math.max(...shapes.map(s => s.w * s.h)),
        ],
        res = LEVELS.find(l => l <= (devicePixelRatio || 1) && l * l * area <= 4e4) ?? 1 / 2,
        k = [w, h, res, o.bezel, o.thickness, o.profile, o.ior, o.light, o.zoom, o.merge, (o.side = side)]
          .concat(shapes.flatMap(s => [s.x, s.y, s.w, s.h, s.r].map(v => Math.round(v * 4))))
          .join();
      m = {
        key: k,
        ...mapsFor(k, () => {
          const g = glMaps(w, h, o, res, shapes);
          if (g) return g;
          const r = computeMaps(w, h, o, res, shapes);
          return {
            d: toURL(r.dmap, r.W, r.H),
            z: r.zmap && toURL(r.zmap, r.ZW, r.ZH),
            scale: r.scale,
            zscale: r.zscale,
          };
        }),
      };
    } else {
      // ~16 samples across the bezel is plenty, and big panes stay within ~30k pixels (re-sent every frame): the
      // interior is flat and the bezel smooth, so half resolution upscales cleanly
      const res = Math.min(1, Math.max(0.5, Math.min(16 / o.bezel, Math.sqrt(3e4 / (w * h))))),
        k = [w, h, res, o.radius, o.bezel, o.thickness, o.profile, o.ior, o.light, o.zoom].join();
      m = {
        key: k,
        ...mapsFor(k, () => {
          const r = computeMaps(w, h, o, res);
          return {
            d: toURL(r.dmap, r.W, r.H),
            z: r.zmap && toURL(r.zmap, r.ZW, r.ZH),
            scale: r.scale,
            zscale: r.zscale,
          };
        }),
      };
    }
    const fresh = m.key !== key;
    key = m.key;
    for (const [img, u] of [
      [fe.map, 'd'],
      [fe.zmap, 'z'],
    ]) {
      if (!img) continue;
      for (const [a, v] of [
        ['x', 0],
        ['y', 0],
        ['width', w],
        ['height', h],
      ])
        img.setAttribute(a, v);
      if (fresh) img.setAttribute('href', m[u]);
    }
    fe.zoomed?.setAttribute('scale', m.zscale);
    // feDisplacementMap picks the nearest source pixel, so zoomed content (in or out) steps; a blur sized to the
    // magnification (in device px) smooths it like bilinear sampling would. Folded into the frost blur.
    // a zoom-wide pixel step needs σ ≈ 0.45 × zoom; Skia's CPU blur ignores σ under ~0.8 device px
    const aa = o.zoom !== 1 ? (Math.max(0.8, 0.45 * o.zoom) * o.antialias) / (devicePixelRatio || 1) : 0;
    fe.blur.setAttribute('stdDeviation', Math.hypot(o.blur, aa));
    fe.refracted.setAttribute('scale', m.scale * o.refraction);
    fe.saturated.setAttribute('values', o.saturation);
    fe.slope.setAttribute('slope', o.specular);
    show();
  };

  const ro = new ResizeObserver(render);
  ro.observe(el, { box: 'border-box' });
  onScreen?.observe(el);
  return (el.glass = {
    filter, // the <filter> element, for inspection or extra primitives
    update(o) {
      Object.assign(opts, o);
      render();
    },
    show(v) {
      shown = v;
      show();
    },
    destroy() {
      ro.disconnect();
      onScreen?.unobserve(el);
      filter.remove();
      el.style.removeProperty('--lg-filter');
      delete el.glass;
    },
  });
}

// ---------------------------------------------------------------- components

const Base = globalThis.HTMLElement ?? class {}; // lets Node import the math for tests

// Native inputs do the work (forms, keyboard, labels, a11y); host attributes are copied onto them.
function build(host, html) {
  host.innerHTML = html;
  const input = host.querySelector('input');
  for (const a of host.getAttributeNames())
    if (!['class', 'style', 'id'].includes(a)) input.setAttribute(a, host.getAttribute(a));
  return input;
}

// Drag along axis ('clientX' or 'clientY'): move(e) once past 4px, end(e, dragged) on release or cancel. A touch
// drag fires no click afterwards and a mouse drag does, so callers act in end() and swallowClick() the leftover.
function onDrag(host, move, end, axis = 'clientX') {
  host.addEventListener('pointerdown', e => {
    if (e.button || host.querySelector(':disabled')) return;
    const t = e.target,
      x0 = e[axis];
    let dragged = false;
    t.setPointerCapture(e.pointerId); // on the pressed element, so a plain tap still clicks it
    const mv = ev => {
      if ((dragged ||= Math.abs(ev[axis] - x0) > 4)) move(ev);
    };
    const up = ev => {
      for (const [type, fn] of [
        ['pointermove', mv],
        ['pointerup', up],
        ['pointercancel', up],
      ])
        t.removeEventListener(type, fn);
      end(ev, dragged);
    };
    for (const [type, fn] of [
      ['pointermove', mv],
      ['pointerup', up],
      ['pointercancel', up],
    ])
      t.addEventListener(type, fn);
  });
}

// Mouse click follows pointerup in the same task; the timeout disarms before any later click.
function swallowClick(el) {
  const eat = e => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  el.addEventListener('click', eat, true);
  setTimeout(() => el.removeEventListener('click', eat, true));
}

// Squash & stretch from speed along one axis, relaxing once movement stops. Feed it the pointer coordinate.
function jelly(el, vertical) {
  let s = 0,
    x0,
    t0,
    raf = 0;
  const tick = () => {
    s *= 0.82;
    el.style.transform =
      s > 0.004 ? (vertical ? `scale(${1 - s / 2}, ${1 + s})` : `scale(${1 + s}, ${1 - s / 2})`) : '';
    raf = s > 0.004 ? requestAnimationFrame(tick) : 0;
  };
  return x => {
    const t = performance.now();
    if (t > t0) s = Math.min(0.22, Math.max(s, (Math.abs(x - x0) / (t - t0)) * 0.05));
    x0 = x;
    t0 = t;
    raf ||= requestAnimationFrame(tick);
  };
}

class LgSwitch extends Base {
  connectedCallback() {
    if (this.input) return;
    this.input = build(this, '<input type="checkbox" role="switch"><span class="lg-thumb" data-glass></span>');
    const squish = jelly(this.querySelector('.lg-thumb'));
    let on;
    onDrag(
      this,
      e => {
        const r = this.getBoundingClientRect(),
          f = Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width - 1 / 3) * 3)); // thumb centre runs from 1/3 to 2/3
        // like iOS: flips on near the end of the travel, back off only near the start; release keeps the colour
        if (!this.hasAttribute('data-dragging')) on = this.input.checked;
        if (f > 0.85) on = true;
        else if (f < 0.15) on = false;
        this.toggleAttribute('data-on', on);
        this.style.setProperty('--lg-f', f);
        this.toggleAttribute('data-dragging', true);
        squish(e.clientX);
      },
      (e, dragged) => {
        this.removeAttribute('data-dragging');
        this.removeAttribute('data-on');
        this.style.removeProperty('--lg-f');
        if (!dragged || e.type !== 'pointerup') return;
        if (on !== this.input.checked) this.input.click(); // native toggle, fires input + change
        swallowClick(this);
      },
    );
  }
  get checked() {
    return this.input.checked;
  }
  set checked(v) {
    this.input.checked = v;
  }
}

class LgSlider extends Base {
  connectedCallback() {
    if (this.input) return;
    this.input = build(
      this,
      '<input type="range"><span class="lg-track"><span class="lg-fill"></span></span><span class="lg-thumb" data-glass></span>',
    );
    const squish = jelly(this.querySelector('.lg-thumb'));
    this.input.addEventListener('input', () => squish(this.sync() * this.offsetWidth));
    this.sync();
  }
  sync() {
    const i = this.input,
      min = +i.min || 0,
      max = i.max === '' ? 100 : +i.max,
      p = (i.value - min) / (max - min);
    this.style.setProperty('--p', p);
    return p;
  }
  get value() {
    return this.input.value;
  }
  set value(v) {
    this.input.value = v;
    this.sync();
  }
}

// Children (buttons or links) become equal-width segments with a glass indicator you can tap or drag.
class LgSegmented extends Base {
  get items() {
    return [...this.children].filter(c => c !== this.ind);
  }
  connectedCallback() {
    if (this.ind) return;
    this.ind = this.appendChild(document.createElement('span'));
    this.ind.className = 'lg-indicator';
    this.ind.dataset.glass = '';
    if (this.items[0]?.tagName !== 'A') this.role = 'tablist';
    this.addEventListener('click', e => {
      const i = this.items.findIndex(c => c.contains(e.target));
      if (i >= 0) this.select(i, true);
    });
    const v = this.ariaOrientation === 'vertical',
      [axis, start, size, pad] = v
        ? ['clientY', 'top', 'height', 'paddingTop']
        : ['clientX', 'left', 'width', 'paddingLeft'];
    this.addEventListener('keydown', e => {
      const d = (v ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 })[e.key];
      if (!d || this.role !== 'tablist') return;
      e.preventDefault();
      this.select(this.index + d, true);
      this.items[this.index].focus();
    });
    // the lens sinks back under the labels once it has arrived
    this.ind.addEventListener('transitionend', e => e.propertyName === 'translate' && this.settle());
    const squish = jelly(this.ind, v);
    let f = 0;
    onDrag(
      this,
      e => {
        const r = this.getBoundingClientRect(),
          p = parseFloat(getComputedStyle(this)[pad]),
          n = this.items.length;
        f = Math.max(0, Math.min(n - 1, ((e[axis] - r[start] - p) / (r[size] - 2 * p)) * n - 0.5));
        this.style.setProperty('--i', f);
        this.toggleAttribute('data-dragging', true);
        this.toggleAttribute('data-moving', true);
        squish(e[axis]);
      },
      (e, dragged) => {
        if (!dragged) return;
        this.removeAttribute('data-dragging');
        if (e.type !== 'pointerup') return this.select(this.index); // cancelled: glide back
        this.items[Math.round(f)].click(); // same path as a tap: selects, follows links, runs your handlers
        swallowClick(this);
      },
      axis,
    );
    this.select(
      Math.max(
        0,
        this.items.findIndex(c => c.matches('[aria-current=page],[aria-selected=true]')),
      ),
    );
  }
  settle() {
    if (!this.hasAttribute('data-dragging')) this.removeAttribute('data-moving');
  }
  select(i, fromUser) {
    const items = this.items;
    i = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((c, j) => {
      if (c.tagName === 'A') {
        if (j === i) c.setAttribute('aria-current', 'page');
        else c.removeAttribute('aria-current');
        return;
      }
      c.role = 'tab';
      c.ariaSelected = j === i;
      c.tabIndex = j === i ? 0 : -1;
    });
    this.style.setProperty('--n', items.length);
    this.style.setProperty('--i', i);
    const moved = this.index != null && i !== this.index;
    this.index = i; // before change fires, so listeners read the new value
    if (moved) {
      this.toggleAttribute('data-moving', true); // indicator swells into a lens while it travels
      if (fromUser) this.dispatchEvent(new Event('change', { bubbles: true }));
    }
    clearTimeout(this.t);
    this.t = setTimeout(() => this.settle(), 700); // in case no translate transition runs
  }
  get value() {
    return this.index;
  }
  set value(i) {
    this.select(i);
  }
}

// Banner that slides down from the top. Content is a string or a node; duration in ms, 0 keeps it up.
// Swipe it up to dismiss. One persistent role="status" element, so screen readers announce each toast.
let toaster;
export function toast(content, { duration = 4000 } = {}) {
  const first = !toaster;
  if (first) {
    toaster = Object.assign(document.createElement('div'), {
      className: 'lg-toast',
      popover: 'manual',
      role: 'status',
    });
    toaster.dataset.glass = '';
    document.body.append(toaster);
    toaster.addEventListener('pointerdown', e => {
      const y0 = e.clientY,
        move = ev => (toaster.style.translate = `0 ${Math.min(0, ev.clientY - y0)}px`);
      toaster.setPointerCapture(e.pointerId);
      toaster.toggleAttribute('data-dragging', true);
      toaster.addEventListener('pointermove', move);
      toaster.addEventListener(
        'pointerup',
        ev => {
          toaster.removeEventListener('pointermove', move);
          toaster.removeAttribute('data-dragging');
          toaster.style.translate = '';
          if (ev.clientY - y0 < -24) toaster.hidePopover();
        },
        { once: true },
      );
    });
  }
  const fill = () => toaster.replaceChildren(content);
  if (first) requestAnimationFrame(fill); // a live region only announces changes made after it exists
  else fill();
  if (!toaster.matches(':popover-open')) toaster.showPopover();
  clearTimeout(toaster.timer);
  if (duration) toaster.timer = setTimeout(() => toaster.hidePopover(), duration);
}

const ICON = d =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="${d}"/></svg>`;

// − / + capsule over a hidden <input type="number">: it keeps forms, arrow keys and screen readers working.
// Holding a half repeats the step.
class LgStepper extends Base {
  connectedCallback() {
    if (this.input) return;
    this.input = build(
      this,
      `<button type="button" tabindex="-1" aria-hidden="true" data-d="-1">${ICON('M5 12h14')}</button>` +
        `<input type="number"><button type="button" tabindex="-1" aria-hidden="true" data-d="1">${ICON('M12 5v14M5 12h14')}</button>`,
    );
    this.input.addEventListener('input', () => this.sync());
    this.addEventListener('pointerdown', e => {
      const b = e.target.closest('button');
      if (e.button || !b || b.disabled) return;
      let t;
      const repeat = first => {
        if (this.step(+b.dataset.d)) t = setTimeout(repeat, first ? 400 : 80);
      };
      repeat(true);
      addEventListener('pointerup', () => clearTimeout(t), { once: true });
      addEventListener('pointercancel', () => clearTimeout(t), { once: true });
    });
    this.sync();
  }
  // returns whether the value changed (false at a limit, which also ends a hold)
  step(d) {
    const v = this.input.value;
    if (d > 0) this.input.stepUp();
    else this.input.stepDown();
    if (this.input.value === v) return false;
    for (const type of ['input', 'change']) this.input.dispatchEvent(new Event(type, { bubbles: true }));
    return true;
  }
  sync() {
    const { min, max, value } = this.input,
      [down, up] = this.querySelectorAll('button');
    down.disabled = min !== '' && +value <= +min;
    up.disabled = max !== '' && +value >= +max;
  }
  get value() {
    return this.input.value;
  }
  set value(v) {
    this.input.value = v;
    this.sync();
  }
}

// Page dots. With for="id" they follow that scroll-snap container's children, otherwise count="n".
// Tap a dot, drag across them to scrub, or use the arrow keys.
class LgDots extends Base {
  connectedCallback() {
    if (this.role) return;
    this.target = document.getElementById(this.getAttribute('for'));
    const n = this.target ? this.target.children.length : +this.getAttribute('count') || 0;
    this.role = 'tablist';
    this.innerHTML = Array.from(
      { length: n },
      (_, i) => `<button type="button" role="tab" aria-label="Page ${i + 1}"></button>`,
    ).join('');
    this.addEventListener('click', e => this.go([...this.children].indexOf(e.target.closest('button'))));
    this.addEventListener('keydown', e => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      this.go(this.index + d);
      this.children[this.index].focus();
    });
    onDrag(
      this,
      e => {
        const r = this.getBoundingClientRect();
        this.go(Math.floor(((e.clientX - r.left) / r.width) * this.children.length));
      },
      (e, dragged) => dragged && swallowClick(this),
    );
    this.target?.addEventListener('scrollsnapchanging', e =>
      this.select([...this.target.children].indexOf(e.snapTargetInline)),
    );
    this.select(+this.getAttribute('value') || 0);
  }
  // user navigation: select, fire change, bring the page into view
  go(i) {
    if (i < 0 || i >= this.children.length || i === this.index) return;
    this.select(i);
    this.dispatchEvent(new Event('change', { bubbles: true }));
    this.target?.children[i].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }
  select(i) {
    if (i < 0) return;
    [...this.children].forEach((b, j) => {
      b.ariaSelected = j === i;
      b.tabIndex = j === i ? 0 : -1;
    });
    this.index = i;
  }
  get value() {
    return this.index;
  }
  set value(i) {
    this.go(i);
  }
}

// Wheel picker over a native <select> child, which keeps forms, keyboard and screen readers working.
// The rows scroll-snap and tilt on a drum (scroll-driven animation); the glass band shows the middle one enlarged.
class LgPicker extends Base {
  connectedCallback() {
    if (this.list) return;
    const select = (this.select = this.querySelector('select')),
      list = (this.list = Object.assign(document.createElement('div'), { className: 'lg-rows', ariaHidden: 'true' })),
      band = Object.assign(document.createElement('div'), { className: 'lg-band' });
    list.append(
      ...Array.from(select.options, o => Object.assign(document.createElement('div'), { textContent: o.text })),
    );
    list.children[select.selectedIndex]?.style.setProperty('scroll-initial-target', 'nearest'); // also right after display: none
    band.dataset.glass = '';
    band.append(Object.assign(list.cloneNode(true), { className: 'lg-big' }));
    this.style.setProperty('--lg-n', select.options.length);
    this.append(list, band);
    this.index = select.selectedIndex;
    // each scrollTop set while dragging ends a scroll too, so the value waits for the throw to land
    list.addEventListener('scrollend', () => this.hasAttribute('data-dragging') || this.sync());
    select.addEventListener('change', e => e.isTrusted && this.go(select.selectedIndex)); // typeahead, not our own
    list.addEventListener('click', e => this.go([...list.children].indexOf(e.target)));
    this.addEventListener('keydown', e => {
      const d = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      this.go(this.index + d);
    });
    // Mouse drag spins the wheel (touch and wheel scroll natively). Snapping is off until the throw lands.
    list.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button) return;
      const top0 = list.scrollTop;
      let dragged = false,
        v = 0,
        last = e;
      const move = ev => {
        if (!(dragged ||= Math.abs(ev.clientY - e.clientY) > 4)) return;
        this.toggleAttribute('data-dragging', true);
        list.scrollTop = top0 - (ev.clientY - e.clientY);
        v = (ev.clientY - last.clientY) / Math.max(1, ev.timeStamp - last.timeStamp);
        last = ev;
      };
      const up = ev => {
        for (const [type, fn] of [
          ['pointermove', move],
          ['pointerup', up],
          ['pointercancel', up],
        ])
          list.removeEventListener(type, fn);
        if (!dragged) return;
        swallowClick(list);
        if (ev.timeStamp - last.timeStamp > 100) v = 0;
        const h = list.firstChild.offsetHeight,
          i = Math.max(0, Math.min(list.children.length - 1, Math.round((list.scrollTop - v * 250) / h))),
          done = () => {
            this.removeAttribute('data-dragging');
            this.sync();
          };
        if (Math.abs(list.scrollTop - i * h) < 1) done();
        else list.addEventListener('scrollend', done, { once: true });
        this.go(i);
      };
      e.target.setPointerCapture(e.pointerId); // on the row, so a plain click still lands on it
      for (const [type, fn] of [
        ['pointermove', move],
        ['pointerup', up],
        ['pointercancel', up],
      ])
        list.addEventListener(type, fn);
    });
  }
  // the row in the middle becomes the select's value
  sync() {
    const i = Math.round(this.list.scrollTop / this.list.firstChild.offsetHeight);
    this.index = i;
    if (i === this.select.selectedIndex) return;
    this.select.selectedIndex = i;
    for (const type of ['input', 'change']) this.select.dispatchEvent(new Event(type, { bubbles: true }));
  }
  go(i) {
    if (i < 0 || i >= this.list.children.length) return;
    this.index = i;
    this.list.scrollTo({ top: i * this.list.firstChild.offsetHeight, behavior: 'smooth' });
  }
  get value() {
    return this.select.value;
  }
  set value(v) {
    this.select.value = v;
    this.go(this.select.selectedIndex);
  }
}

// Magnifier: a zoom lens follows the pointer, or keyboard focus, over whatever it wraps.
class LgMagnifier extends Base {
  connectedCallback() {
    if (this.lens) return;
    const lens = (this.lens = Object.assign(document.createElement('div'), { className: 'lg-lens' })),
      wobble = jelly(lens);
    lens.dataset.glass = '';
    this.append(lens);
    const at = (x, y) => {
      const r = this.getBoundingClientRect();
      lens.style.translate = `${x - r.left - lens.offsetWidth / 2}px ${y - r.top - lens.offsetHeight / 2}px`;
      wobble(x);
      this.toggleAttribute('data-lens', true);
    };
    const hide = () => this.removeAttribute('data-lens');
    this.addEventListener('pointermove', e => at(e.clientX, e.clientY));
    this.addEventListener('pointerleave', hide);
    this.addEventListener('focusin', e => {
      const r = e.target.getBoundingClientRect();
      at(r.left + r.width / 2, r.top + r.height / 2);
    });
    this.addEventListener('focusout', hide);
  }
}

// Merging glass: children closer than --lg-merge px melt together like liquid. Shapes that can melt (a cheap box
// distance check) share a pane: an element of its own, glass cut to the smooth union of their boxes (border-radius
// kept). A pane is only re-rendered when its own shapes change relative to each other, so moving a lone child just
// moves its pane, and the others aren't touched at all. Follows the children's size and transitions.
// With the drag attribute the children are moved by dragging, kept inside the element.
class LgMerge extends Base {
  connectedCallback() {
    if (this.panes) return;
    this.panes = new Map(); // members → pane
    const opts = {};
    this.glass = {
      update: o => {
        Object.assign(opts, o);
        for (const pane of this.panes.values()) pane.glass.update(o);
        this.layout();
      },
    };
    this.layout = () => {
      const o = this.getBoundingClientRect(),
        kids = [...this.children].filter(c => !c.classList.contains('lg-pane')),
        k = opts.merge ?? (parseFloat(getComputedStyle(this).getPropertyValue('--lg-merge')) || 20),
        p = k / 4 + 2, // the union reaches k/4 past a shape, plus its antialiased edge
        near = k * 1.25 + 2 + p, // closer than this, the union between two shapes can change
        q = v => Math.round(v * 100) / 100, // else float noise (175.99997 wide) reads as a change on every move
        // whole device pixels too, or each grid step lands on another subpixel (8px at 110% is 8.8)
        D = devicePixelRatio || 1,
        G = Array.from({ length: 10 }, (_, i) => 8 * i + 8).find(g => Math.abs(g * D - Math.round(g * D)) < 0.01) ?? 8,
        rects = kids.map(c => {
          const b = c.getBoundingClientRect(),
            br = getComputedStyle(c).borderTopLeftRadius,
            r = br.endsWith('%') ? (parseFloat(br) / 100) * Math.min(b.width, b.height) : parseFloat(br) || 0;
          return {
            x: b.left - o.left,
            y: b.top - o.top,
            w: b.width,
            h: b.height,
            r: Math.min(r, b.width / 2, b.height / 2),
          };
        }),
        up = rects.map((_, i) => i),
        top = i => (up[i] === i ? i : (up[i] = top(up[i])));
      // the real gap between two rounded rects: between their inner rects, less both radii (not the boxes, which
      // put diagonal neighbours in one pane long before their union can change)
      const gap = (a, b) =>
        Math.hypot(
          Math.max(0, Math.abs(a.x + a.w / 2 - b.x - b.w / 2) - (a.w + b.w) / 2 + a.r + b.r),
          Math.max(0, Math.abs(a.y + a.h / 2 - b.y - b.h / 2) - (a.h + b.h) / 2 + a.r + b.r),
        ) -
        a.r -
        b.r;
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) if (gap(rects[i], rects[j]) < near) up[top(i)] = top(j);
      // the largest side and area of all children: every pane renders at one level and zoom scale
      this.size = [Math.max(...rects.flatMap(r => [q(r.w), q(r.h)])), Math.max(...rects.map(r => q(r.w * r.h)))];
      const live = new Set(),
        prev = this.rects;
      this.rects = rects;
      for (const members of Object.values(Object.groupBy(rects.keys(), i => top(i)))) {
        const id = members.join(),
          g = members.map(i => rects[i]);
        let pane = this.panes.get(id);
        if (!pane) {
          pane = Object.assign(document.createElement('div'), { className: 'lg-pane' });
          glass(pane, { ...opts, source: this, shapes: () => pane.shapes, size: () => this.size });
          this.append(pane); // last, so authors' :first-child / :nth-child still count their own children
          this.panes.set(id, pane);
          // A cluster re-renders whenever one member moves, so it sits on a grid of G px (whole map and device
          // pixels) running through the box a member that held still had alone: that member renders exactly as it
          // did alone, as long as it holds still. A lone child keeps its exact box, so moving it just moves its pane.
          const i = members.find(i => prev?.[i]?.x === rects[i].x && prev[i].y === rects[i].y) ?? members[0];
          pane.at = [rects[i].x - p, rects[i].y - p];
        }
        const snap = (v, axis, round) => (g.length > 1 ? pane.at[axis] + round((v - pane.at[axis]) / G) * G : v),
          x = snap(Math.min(...g.map(s => s.x)) - p, 0, Math.floor),
          y = snap(Math.min(...g.map(s => s.y)) - p, 1, Math.floor),
          shapes = g.map(s => ({ x: q(s.x - x), y: q(s.y - y), w: q(s.w), h: q(s.h), r: q(s.r) })),
          w = q(snap(Math.max(...g.map(s => s.x + s.w)) + p, 0, Math.ceil) - x),
          h = q(snap(Math.max(...g.map(s => s.y + s.h)) + p, 1, Math.ceil) - y),
          shape = JSON.stringify([w, h, shapes, this.size]);
        live.add(id);
        pane.style.translate = `${x}px ${y}px`; // a lone child moving only moves its pane
        if (shape === pane.shape) continue;
        pane.shape = shape;
        pane.shapes = shapes;
        Object.assign(pane.style, { width: `${w}px`, height: `${h}px` });
        pane.glass.update();
      }
      for (const [id, pane] of this.panes)
        if (!live.has(id)) {
          this.panes.delete(id);
          pane.remove();
        }
    };
    let moving = 0;
    const tick = () => {
      this.layout();
      if (moving) requestAnimationFrame(tick);
    };
    this.addEventListener('transitionrun', () => moving++ || requestAnimationFrame(tick));
    for (const type of ['transitionend', 'transitioncancel'])
      this.addEventListener(type, () => (moving = Math.max(0, moving - 1)));
    const ro = new ResizeObserver(() => this.layout());
    ro.observe(this);
    for (const c of this.children) ro.observe(c);
    if (!this.hasAttribute('drag')) return;
    this.addEventListener('pointerdown', e => {
      const c = e.target.closest('lg-merge > :not(.lg-pane)');
      if (e.button || c?.parentElement !== this) return;
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect(),
        h = this.getBoundingClientRect(),
        [x0, y0 = 0] = (c.style.translate || '0px').split(' ').map(parseFloat);
      let raf = 0;
      const move = ev => {
        const dx = Math.max(h.left - r.left, Math.min(h.right - r.right, ev.clientX - e.clientX)),
          dy = Math.max(h.top - r.top, Math.min(h.bottom - r.bottom, ev.clientY - e.clientY));
        c.style.translate = `${x0 + dx}px ${y0 + dy}px`;
        raf ||= requestAnimationFrame(() => {
          raf = 0;
          this.layout();
        });
      };
      c.addEventListener('pointermove', move);
      c.addEventListener('lostpointercapture', () => c.removeEventListener('pointermove', move), { once: true });
    });
  }
}

const CSS = `
${Object.keys(DEFAULTS)
  .map(k => `@property --lg-${k} { syntax: '*'; inherits: false; }`)
  .join('\n')}
@property --lg-f { syntax: '<number>'; inherits: true; initial-value: 0; }
@layer liquid-glass {
:root {
  --lg-accent: #0a84ff;
  --lg-green: #34c759;
  --lg-tint: light-dark(rgb(255 255 255 / .16), rgb(255 255 255 / .05));
  --lg-shadow: 0 6px 24px rgb(0 0 0 / .16);
  /* damped springs: --lg-spring (ζ .55, ~.5s) for presses, --lg-glide (ζ .72, ~.4s) for travel */
  --lg-spring: linear(0, .094, .307, .553, .776, .947, 1.057, 1.113, 1.126, 1.112, 1.085, 1.054, 1.026, 1.005, .992, .985, .984, .986, .99, .994, 1);
  --lg-glide: linear(0, .042, .143, .275, .415, .55, .672, .775, .858, .922, .969, 1.001, 1.022, 1.033, 1.038, 1.038, 1.035, 1.03, 1.025, 1.02, 1.015, 1.01, 1.007, 1.004, 1);
}
@media (prefers-reduced-motion: no-preference) {
  :root:has(lg-segmented a[href^="#"]) { scroll-behavior: smooth; } /* in-page nav glides instead of jumping */
}
:where([data-glass]) { position: relative; isolation: isolate; background-color: var(--lg-tint); box-shadow: var(--lg-shadow); }
/* the glass and its press states are the tap feedback: no blue tap box on mobile (inherited, so inner buttons too) */
:where([data-glass], .lg-btn, lg-switch, lg-slider, lg-segmented, lg-stepper, lg-dots, lg-picker, lg-magnifier, lg-merge) {
  -webkit-tap-highlight-color: transparent;
}
[data-glass]::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  backdrop-filter: var(--lg-filter);
}

.lg-btn {
  font: inherit; color: inherit; border: 0; cursor: pointer; text-decoration: none;
  display: inline-flex; align-items: center; justify-content: center; gap: .5em;
  min-height: 2.75em; padding: 0 1.25em; border-radius: 999px;
  transition: scale .5s var(--lg-spring), background-color .2s;
  &:hover { background-color: light-dark(rgb(255 255 255 / .3), rgb(255 255 255 / .12)); }
  &:active { scale: 1.08; }
  &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  &.lg-round { width: 2.75em; padding: 0; }
  &.lg-tinted { background-color: color-mix(in srgb, var(--lg-accent) 75%, transparent); color: #fff; }
  & svg { width: 1.25em; height: 1.25em; }
}

.lg-field {
  display: flex; align-items: center; gap: .6em; height: 2.75em; padding: 0 1.1em; border-radius: 999px; cursor: text;
  transition: background-color .25s, outline-color .25s; outline: 1px solid transparent;
  &:focus-within { --lg-tint: light-dark(rgb(255 255 255 / .4), rgb(255 255 255 / .12)); outline-color: light-dark(rgb(0 0 0 / .12), rgb(255 255 255 / .3)); }
  & input { all: unset; flex: 1; min-width: 0; outline: none !important; } /* the field shows focus; beats any page-wide :focus outline */
  & svg { width: 1.1em; height: 1.1em; opacity: .6; flex: none; }
}

.lg-panel { border-radius: 1.5em; padding: 1.25em; }

.lg-menu {
  position: fixed; inset: auto; margin: .5em 0 0; position-area: block-end span-inline-end; position-try-fallbacks: flip-block, flip-inline;
  border: 0; padding: .35em; border-radius: 1.25em; min-width: 12em;
  --lg-blur: 5; --lg-tint: light-dark(rgb(250 250 252 / .62), rgb(30 31 35 / .62)); color: light-dark(#111, #f4f4f5);
  /* no opacity fade (opacity < 1 blanks the glass), so it closes by shrinking fast into its corner */
  transform-origin: top left; scale: .05;
  transition: scale .2s cubic-bezier(.4, 0, 1, 1), display .2s allow-discrete, overlay .2s allow-discrete;
  &:popover-open { display: grid; scale: 1; transition: scale .5s var(--lg-spring), display .5s allow-discrete, overlay .5s allow-discrete; }
  @starting-style { &:popover-open { scale: .3; } }
  & > button, & > a { all: unset; padding: .55em .85em; border-radius: .9em; cursor: default; }
  & > :is(button, a):is(:hover, :focus-visible) { background: rgb(127 127 127 / .2); }
  & > hr { border: 0; border-top: 1px solid rgb(127 127 127 / .25); margin: .3em .6em; }
}

lg-switch {
  --lg-f: 0; /* 0 = off, 1 = on; follows the finger while dragging */
  position: relative; display: inline-block; vertical-align: middle; flex: none; touch-action: pan-y; user-select: none;
  width: 4em; height: 1.75em; border-radius: 1em;
  background-color: light-dark(rgb(120 120 128 / .22), rgb(120 120 128 / .4));
  transition: --lg-f .5s var(--lg-spring), background-color .2s;
  &:has(:checked) { --lg-f: 1; }
  /* the colour flips, it doesn't blend: checked, or while dragging the on/off the drag has reached */
  &:is(:has(:checked):not([data-dragging]), [data-on]) { background-color: var(--lg-green); }
  &[data-dragging] { transition: background-color .2s; }
  &:has(:focus-visible) { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  &:has(:disabled) { filter: grayscale(1) opacity(.5); }
  & input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
  & .lg-thumb {
    /* pressed it's a clear lens like iOS (proportions measured off it): the middle shrinks the track a little,
       a wide convex rim bends it back out to the edge, so the green flows in from the track as one shape */
    --lg-bezel: 11; --lg-zoom: .9; --lg-blur: 0; --lg-specular: .9;
    position: absolute; top: 50%; left: calc(1.34em + (100% - 2.68em) * var(--lg-f)); width: 3.8em; height: 2.45em; border-radius: 1.225em;
    translate: -50% -50%; scale: .62; background: #fff; box-shadow: 0 .1em .5em rgb(0 0 0 / .2); pointer-events: none;
    transition: scale .5s var(--lg-spring), background-color .2s;
  }
  &:has(input:active) .lg-thumb { scale: 1; background: rgb(255 255 255 / .06); }
  & .lg-thumb::before { opacity: 0; transition: opacity .2s; } /* solid white at rest, glass while pressed */
  &:has(input:active) .lg-thumb::before { opacity: 1; }
}

lg-slider {
  --p: .5; position: relative; display: block; height: 2.6em; min-width: 8em; user-select: none;
  &:has(:disabled) { filter: grayscale(1) opacity(.5); }
  & input {
    position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; appearance: none;
    &::-webkit-slider-thumb { appearance: none; width: 2.4em; height: 2.6em; }
  }
  &:has(:focus-visible) .lg-thumb { outline: 2px solid var(--lg-accent); outline-offset: 3px; }
  & .lg-track {
    position: absolute; inset: 50% 0 auto; height: .45em; translate: 0 -50%; border-radius: 1em; overflow: hidden;
    background: light-dark(rgb(120 120 128 / .22), rgb(120 120 128 / .4)); pointer-events: none;
  }
  & .lg-fill { height: 100%; width: calc(var(--p) * (100% - 2.4em) + 1.2em); background: var(--lg-accent); }
  & .lg-thumb {
    --lg-specular: .6;
    position: absolute; top: 50%; left: calc(var(--p) * (100% - 2.4em) + 1.2em); width: 4em; height: 2.6em; border-radius: 1.3em;
    translate: -50% -50%; scale: .6; background: #fff; box-shadow: 0 .1em .5em rgb(0 0 0 / .2); pointer-events: none;
    transition: scale .5s var(--lg-spring), background-color .2s;
  }
  &:has(input:active) .lg-thumb { scale: 1; background: rgb(255 255 255 / .06); }
  & .lg-thumb::before { opacity: 0; transition: opacity .2s; }
  &:has(input:active) .lg-thumb::before { opacity: 1; }
}

lg-segmented {
  /* minmax(0, 1fr): truly equal columns, or long labels widen theirs and the indicator drifts off-centre */
  --n: 1; --i: 0; position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  padding: .25em; border-radius: 999px; touch-action: pan-y; user-select: none;
  & > :not(.lg-indicator) {
    all: unset; -webkit-user-drag: none; display: flex; align-items: center; justify-content: center; gap: .35em;
    position: relative; z-index: 1; padding: .55em 1.1em; border-radius: 999px; cursor: pointer; white-space: nowrap; transition: color .2s;
    &:is([aria-selected=true], [aria-current]) { color: var(--lg-accent); }
    &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: -2px; }
  }
  & .lg-indicator {
    --lg-refraction: 1.4; --lg-blur: 0; /* labels stay sharp under the lens */
    position: absolute; inset: .25em auto .25em .25em; width: calc((100% - .5em) / var(--n)); border-radius: 999px;
    translate: calc(var(--i) * 100%) 0; pointer-events: none; z-index: 0;
    background: light-dark(rgb(0 0 0 / .07), rgb(255 255 255 / .12)); box-shadow: none;
    /* leaving the lens state: shrink first, sink under the labels once mostly shrunk */
    transition: translate .4s var(--lg-glide), scale .5s var(--lg-spring), background-color .25s, z-index 0s .22s;
  }
  &[data-moving] .lg-indicator { /* lens over the labels only while travelling or dragged */
    z-index: 2; scale: 1.12 1.3; background: rgb(255 255 255 / .04);
    transition: translate .4s var(--lg-glide), scale .35s var(--lg-spring), background-color .15s, z-index 0s;
  }
  &[data-dragging] .lg-indicator { transition: scale .35s var(--lg-spring), background-color .15s, z-index 0s; }
  &.lg-tabbar > :not(.lg-indicator) { flex-direction: column; gap: .15em; padding: .45em 1.2em; font-size: .72em; font-weight: 500; }
  &.lg-tabbar svg { width: 2em; height: 2em; }
  /* a sidebar: rows instead of columns, the lens travels down */
  &[aria-orientation=vertical] {
    display: grid; grid-auto-flow: row; grid-auto-rows: minmax(0, 1fr); border-radius: 1.25em; touch-action: pan-x;
    & > :not(.lg-indicator) { justify-content: flex-start; gap: .6em; }
    & svg { width: 1.25em; height: 1.25em; flex: none; }
    & .lg-indicator { inset: .25em .25em auto; width: auto; height: calc((100% - .5em) / var(--n)); translate: 0 calc(var(--i) * 100%); border-radius: 1em; }
  }
}
lg-stepper {
  position: relative; display: inline-flex; vertical-align: middle; height: 2.3em; border-radius: 999px; user-select: none;
  &:has(input:focus-visible) { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  & input { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
  & button {
    all: unset; position: relative; display: grid; place-items: center; width: 2.9em; border-radius: 999px; cursor: pointer;
    transition: scale .5s var(--lg-spring), background-color .2s, opacity .2s;
    &:active:not(:disabled) { scale: 1.15; background: rgb(127 127 127 / .2); }
    &:disabled { opacity: .3; cursor: default; }
    & svg { width: 1.15em; height: 1.15em; }
  }
  & button:last-of-type::before { content: ''; position: absolute; left: 0; top: 28%; bottom: 28%; width: 1px; background: currentColor; opacity: .2; }
}
lg-dots {
  display: inline-flex; vertical-align: middle; padding: .2em .4em; border-radius: 999px; touch-action: pan-y; user-select: none;
  /* no padding on the dots, so a page-wide box-sizing reset can't shrink them; the button is the hit area, ::after the dot */
  & button {
    all: unset; display: grid; place-items: center; width: 1.1em; height: 1.1em; border-radius: 999px; cursor: pointer;
    transition: width .4s var(--lg-glide); /* one dot grows as another shrinks: the capsule keeps its size */
    &::after { content: ''; width: .5em; height: .5em; border-radius: 999px; background: currentColor; opacity: .4; transition: width .4s var(--lg-glide), opacity .2s; }
    &[aria-selected=true] { width: 2em; &::after { width: 1.4em; opacity: 1; } }
    &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: -2px; }
  }
}
lg-picker {
  position: relative; display: inline-block; vertical-align: middle; height: 10em; min-width: 5em; border-radius: 1.25em; user-select: none;
  timeline-scope: --lg-wheel; /* lets the band's copy follow the rows' scroll */
  &:has(select:focus-visible) { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  & select { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
  /* rows under the band are masked out; the band shows a copy at 1.2× in real text, which stays crisp where zooming the
     backdrop would sample pixels. Spacers instead of padding, so rows centre whatever box-sizing the page uses */
  & .lg-rows {
    height: 100%; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; scroll-snap-type: y mandatory;
    scroll-timeline: --lg-wheel y; mask: linear-gradient(#000 calc(50% - 1em), #0000 0 calc(50% + 1em), #000 0);
  }
  & .lg-rows::before, & .lg-rows::after { content: ''; display: block; height: calc(50% - 1em); }
  &[data-dragging] .lg-rows { scroll-snap-type: none; }
  & :is(.lg-rows, .lg-big) > div { height: 2em; line-height: 2em; text-align: center; white-space: nowrap; }
  & .lg-rows > div { padding-inline: 1em; cursor: default; scroll-snap-align: center; animation: lg-drum linear both; animation-timeline: view(); }
  & .lg-band {
    --lg-blur: 0; --lg-specular: .4;
    position: absolute; inset: calc(50% - 1em) .3em auto; height: 2em; border-radius: .6em; overflow: hidden; pointer-events: none;
    background: rgb(127 127 127 / .14); box-shadow: none;
  }
  /* moves in step with the rows: scroll progress 0 → 1 lifts it by --lg-n − 1 rows; only the font is bigger */
  & .lg-big { position: absolute; inset: 0 -.3em auto; animation: lg-wheel linear both; animation-timeline: --lg-wheel; }
  & .lg-big > div { font-size: 1.2em; height: calc(2em / 1.2); line-height: calc(2em / 1.2); }
}
@keyframes lg-wheel { to { translate: 0 calc((1 - var(--lg-n)) * 2em); } }
lg-magnifier {
  position: relative; display: inline-block; vertical-align: middle;
  touch-action: pan-y;
  & .lg-lens {
    --lg-zoom: 1.4; --lg-bezel: 12; --lg-blur: 0; /* narrow bezel: a flat magnifier, so the content stays undistorted */
    position: absolute; top: 0; left: 0; width: 5em; height: 5em; border-radius: 50%; z-index: 1; pointer-events: none;
    background: rgb(255 255 255 / .04); scale: 0; transition: scale .2s ease-in;
  }
  &[data-lens] .lg-lens { scale: 1; transition: scale .5s var(--lg-spring); }
}
lg-merge {
  position: relative; isolation: isolate; display: inline-flex; align-items: center; gap: .75em; vertical-align: middle;
  /* !important: a page's lg-merge > * rules mustn't move, round or fill the panes */
  & > .lg-pane { position: absolute !important; inset: 0 auto auto 0 !important; z-index: -1; pointer-events: none !important; background: none !important; box-shadow: none !important; }
  & > .lg-pane::before { border-radius: 0 !important; }
}
:where(lg-merge > *) { background-color: transparent; } /* plain buttons would bring the browser's grey */
lg-merge[drag] { pointer-events: none; } /* an overlay: only the children catch the pointer */
lg-merge[drag] > :not(.lg-pane) { pointer-events: auto; cursor: grab; touch-action: none; user-select: none; }
lg-merge[drag] > :not(.lg-pane):active { cursor: grabbing; }
.lg-navbar {
  /* slots: leading, title, trailing. Clear at the top of its scroller; as the large title scrolls under it, the glass,
     the small title and a blur behind and just below it fade in (scroll-driven, no script) */
  position: sticky; top: .5em; z-index: 1; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: .5em;
  min-height: 2.75em; margin: .5em .5em 0; padding: 0 .4em; border-radius: 1.375em;
  animation: lg-bar linear both; animation-timeline: scroll(); animation-range: 0 2.5em;
  &::before, &::after, & > :nth-child(2) { animation: lg-appear linear both; animation-timeline: scroll(); animation-range: 0 2.5em; }
  &::after {
    content: ''; position: absolute; inset: -.5em -.5em auto; height: calc(100% + 1.75em); z-index: -2; pointer-events: none;
    backdrop-filter: blur(4px); mask: linear-gradient(#000 calc(100% - 1.5em), #0000);
  }
  & > :nth-child(2) { margin: 0; font-size: 1em; font-weight: 600; white-space: nowrap; }
  & > :last-child { justify-self: end; }
  & > :is(a, button) {
    all: unset; padding: .4em .6em; border-radius: 999px; color: var(--lg-accent); cursor: pointer; white-space: nowrap;
    &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: -2px; }
  }
}
.lg-large-title {
  margin: .15em .25em .3em; font-size: 2em; transform-origin: 0 100%;
  animation: lg-recede linear both; animation-timeline: scroll(); animation-range: 0 1.25em; /* 1.25em here = 2.5em in the bar */
}
@keyframes lg-bar { from { background-color: transparent; box-shadow: none; } }
@keyframes lg-appear { from { opacity: 0; } }
@keyframes lg-recede { to { opacity: 0; scale: .75; } }
@keyframes lg-drum { /* view() runs 0 → 1 as a row crosses from the bottom edge to the top one */
  from { transform: perspective(20em) rotateX(-75deg); opacity: .2; }
  50% { transform: perspective(20em) rotateX(0deg); opacity: 1; }
  to { transform: perspective(20em) rotateX(75deg); opacity: .2; }
}
.lg-toolbar {
  display: inline-flex; align-items: center; gap: .15em; padding: .3em; border-radius: 999px; vertical-align: middle;
  & > :is(button, a) {
    all: unset; display: grid; place-items: center; width: 2.4em; height: 2.4em; border-radius: 999px; cursor: pointer;
    transition: scale .5s var(--lg-spring), background-color .2s, color .2s;
    &:hover { background: rgb(127 127 127 / .15); }
    &:active { scale: 1.15; background: rgb(127 127 127 / .25); }
    &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: -2px; }
    &[aria-pressed=true] { color: var(--lg-accent); }
  }
  & svg { width: 1.25em; height: 1.25em; }
  & > hr { all: unset; align-self: stretch; width: 1px; margin: .45em .2em; background: currentColor; opacity: .2; }
}
.lg-tip {
  position: fixed; inset: auto; margin: .5em 0; position-area: block-start; position-try-fallbacks: flip-block;
  border: 0; padding: .4em .75em; border-radius: .9em; max-width: 18em; font-size: .85em;
  --lg-blur: 4; --lg-tint: light-dark(rgb(250 250 252 / .6), rgb(30 31 35 / .6)); color: light-dark(#111, #f4f4f5);
  transform-origin: bottom center; scale: .5;
  transition: scale .15s ease-in, display .15s allow-discrete, overlay .15s allow-discrete;
  &:popover-open { scale: 1; transition: scale .4s var(--lg-spring), display .4s allow-discrete, overlay .4s allow-discrete; }
  @starting-style { &:popover-open { scale: .5; } }
}
.lg-toast {
  position: fixed; inset: max(.75em, env(safe-area-inset-top)) 0 auto; margin: 0 auto; border: 0; padding: .8em 1.25em; border-radius: 1.4em;
  min-height: 1.2em; max-width: min(26em, calc(100vw - 1.5em)); touch-action: none; user-select: none; cursor: grab;
  --lg-blur: 4; --lg-tint: light-dark(rgb(250 250 252 / .6), rgb(30 31 35 / .6)); color: light-dark(#111, #f4f4f5);
  translate: 0 calc(-100% - 1.5em);
  transition: translate .3s cubic-bezier(.4, 0, 1, 1), display .3s allow-discrete, overlay .3s allow-discrete;
  &:popover-open { translate: 0; transition: translate .55s var(--lg-spring), display .55s allow-discrete, overlay .55s allow-discrete; }
  @starting-style { &:popover-open { translate: 0 calc(-100% - 1.5em); } }
  &[data-dragging] { transition: none; cursor: grabbing; }
}
.lg-alert {
  position: fixed; /* [data-glass] sets relative, which would pin a modal to the top of the page */
  border: 0; padding: 1.3em 1.2em 1.1em; border-radius: 1.75em; width: min(19em, calc(100vw - 2em)); text-align: center;
  scale: .92; transition: scale .15s ease-in, display .15s allow-discrete, overlay .15s allow-discrete;
  &[open] { scale: 1; transition: scale .5s var(--lg-spring), display .5s allow-discrete, overlay .5s allow-discrete; }
  @starting-style { &[open] { scale: 1.12; } }
  & h2 { margin: 0 0 .35em; font-size: 1.05em; }
  & p { margin: 0 0 1.1em; font-size: .9em; opacity: .8; }
  & form { display: flex; gap: .5em; }
  & form > * { flex: 1; }
}
:is(.lg-alert, .lg-sheet) {
  --lg-blur: 6; --lg-tint: light-dark(rgb(250 250 252 / .7), rgb(36 37 41 / .7)); color: light-dark(#111, #f4f4f5);
  &::backdrop { background: transparent; transition: background-color .25s, display .25s allow-discrete, overlay .25s allow-discrete; }
  &[open]::backdrop { background: rgb(0 0 0 / .3); }
  @starting-style { &[open]::backdrop { background: transparent; } }
  & .lg-btn:not(.lg-tinted) { background-color: rgb(127 127 127 / .2); }
}
.lg-sheet {
  /* as tall as the large detent and opens at the medium one (top half of the screen); height: auto sizes it to the content */
  position: fixed; inset: auto .5em .5em; margin: 0 auto; width: auto; max-width: 36em; height: calc(100dvh - 3em); max-height: none;
  border: 0; padding: 1.75em 1.25em 1.25em; border-radius: 2em; overflow: hidden; touch-action: none; user-select: none;
  flex-direction: column; /* not under [open]: display stays flex through the closing transition, this must too */
  translate: 0 calc(100% + 1em);
  transition: translate .3s cubic-bezier(.4, 0, 1, 1), display .3s allow-discrete, overlay .3s allow-discrete;
  /* --lg-detent: offset from fully open, set by the drag */
  &[open] { display: flex; translate: 0 var(--lg-detent, max(0px, 100% - 50dvh)); transition: translate .5s var(--lg-glide), display .5s allow-discrete, overlay .5s allow-discrete; }
  @starting-style { &[open] { translate: 0 calc(100% + 1em); } }
  &[data-dragging] { transition: none; }
  &::after { content: ''; position: absolute; top: .6em; left: 50%; width: 2.5em; height: .3em; translate: -50%; border-radius: 1em; background: currentColor; opacity: .25; }
}
@media (prefers-reduced-motion: reduce) {
  .lg-btn, .lg-menu, .lg-tip, .lg-toast, .lg-alert, .lg-sheet, .lg-toolbar > *, lg-switch, lg-switch *, lg-slider *, lg-segmented *, lg-stepper *, lg-dots *, lg-magnifier * { transition-duration: 0s !important; }
}
}`;

if (globalThis.document) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  document.adoptedStyleSheets.push(sheet);
  customElements.define('lg-switch', LgSwitch);
  customElements.define('lg-slider', LgSlider);
  customElements.define('lg-segmented', LgSegmented);
  customElements.define('lg-stepper', LgStepper);
  customElements.define('lg-dots', LgDots);
  customElements.define('lg-picker', LgPicker);
  customElements.define('lg-magnifier', LgMagnifier);
  customElements.define('lg-merge', LgMerge);

  const scan = (node, fn) => {
    if (node.nodeType !== 1) return;
    if (node.matches('[data-glass]')) fn(node);
    node.querySelectorAll('[data-glass]').forEach(fn);
  };
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.hasAttribute('data-glass')) glass(r.target);
        else r.target.glass?.destroy();
      }
      r.removedNodes.forEach(n => scan(n, el => el.glass?.destroy()));
      r.addedNodes.forEach(n => n.isConnected && scan(n, el => glass(el)));
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-glass'],
  });
  scan(document.documentElement, el => glass(el));
  document.addEventListener('click', e => {
    e.target.closest?.('.lg-menu > :is(button, a)')?.parentElement.hidePopover();
    const toggle = e.target.closest?.('.lg-toolbar > [aria-pressed]');
    if (toggle) toggle.ariaPressed = toggle.ariaPressed !== 'true';
  });

  // Context menus: right-click, long-press or the menu key inside [data-contextmenu="id"] opens that .lg-menu there.
  document.addEventListener('contextmenu', e => {
    const zone = e.target.closest?.('[data-contextmenu]'),
      menu = zone && document.getElementById(zone.dataset.contextmenu);
    if (!menu) return;
    e.preventDefault();
    const open = () => {
      if (menu.matches(':popover-open')) menu.hidePopover();
      Object.assign(menu.style, { positionArea: 'none', margin: '0' });
      menu.showPopover();
      // offset sizes ignore the opening scale; keep the menu on screen
      menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - menu.offsetHeight - 8))}px`;
      if (e.button < 0) menu.querySelector('button, a')?.focus(); // button -1: opened from the keyboard
    };
    // Linux and touch fire contextmenu with the button still down; the release would light-dismiss the menu
    if (e.buttons) addEventListener('pointerup', () => setTimeout(open), { once: true });
    else open();
  });

  // Sheets: drag between the large detent and the medium one (half the screen); pull or flick down to dismiss.
  // Only translate changes, so the glass map isn't re-rendered while dragging.
  document.addEventListener('pointerdown', e => {
    const sheet = e.target.closest?.('.lg-sheet[open]');
    if (!sheet || e.button || e.target.closest('a, button, input, select, textarea, label, [contenteditable]')) return;
    const r = sheet.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return; // ::backdrop
    for (let n = e.target; n !== sheet; n = n.parentElement)
      if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) return; // let it scroll
    const h = sheet.offsetHeight,
      y0 = r.top - sheet.offsetTop; // current offset: the box moved by translate, offsetTop ignores it
    let y = y0,
      v = 0,
      last = e;
    const move = ev => {
      const d = y0 + ev.clientY - e.clientY;
      y = d < 0 ? -Math.sqrt(-d) * 2 : d; // rubber band past fully open
      v = (ev.clientY - last.clientY) / Math.max(1, ev.timeStamp - last.timeStamp);
      last = ev;
      sheet.style.setProperty('--lg-detent', `${y}px`);
    };
    const up = ev => {
      for (const [type, fn] of [
        ['pointermove', move],
        ['pointerup', up],
        ['pointercancel', up],
      ])
        sheet.removeEventListener(type, fn);
      sheet.removeAttribute('data-dragging');
      if (ev.timeStamp - last.timeStamp > 100) v = 0; // held still before letting go
      const aim = y + v * 250; // where the flick would carry it
      const stop = [0, Math.max(0, h - innerHeight / 2), h].reduce((a, b) =>
        Math.abs(b - aim) < Math.abs(a - aim) ? b : a,
      );
      if (stop === h) sheet.close();
      else sheet.style.setProperty('--lg-detent', `${stop}px`);
    };
    sheet.setPointerCapture(e.pointerId);
    sheet.toggleAttribute('data-dragging', true);
    for (const [type, fn] of [
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', up],
    ])
      sheet.addEventListener(type, fn);
  });
  // the next open starts at the medium detent again; close doesn't bubble, so listen in the capture phase
  document.addEventListener(
    'close',
    e => e.target.matches?.('.lg-sheet') && e.target.style.removeProperty('--lg-detent'),
    true,
  );

  // Tooltips: interestfor opens a popover="hint" on hover and focus natively; this mirrors it where unsupported.
  if (!('interestForElement' in HTMLButtonElement.prototype)) {
    let timer;
    const watch = (types, delay, act) =>
      types.forEach(type =>
        document.addEventListener(type, e => {
          const invoker = e.target.closest?.('[interestfor]'),
            tip = invoker && document.getElementById(invoker.getAttribute('interestfor'));
          if (!tip || invoker.contains(e.relatedTarget)) return; // moving within the invoker
          clearTimeout(timer);
          timer = setTimeout(() => act(tip, invoker), delay);
        }),
      );
    watch(['pointerover', 'focusin'], 500, (tip, source) => {
      if (!tip.matches(':popover-open')) tip.showPopover({ source });
    });
    watch(['pointerout', 'focusout'], 250, tip => {
      if (tip.matches(':popover-open')) tip.hidePopover();
    });
  }
}
