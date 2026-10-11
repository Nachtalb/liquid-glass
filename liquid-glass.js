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

// RGBA map for a rounded rect: R = x and G = y displacement (128 = none), B = rim light, A = 255.
// Plus a magnifier map if zoom ≠ 1. scale/zscale are the matching feDisplacementMap scales.
// res < 1 renders the maps smaller; feImage stretches them back (the fields are smooth).
export function computeMaps(w, h, { radius: r, bezel, thickness, profile, ior, light, zoom }, res = 1) {
  const W = Math.ceil(w * res),
    H = Math.ceil(h * res),
    n = 128;
  const disp = bezelDisplacement(profiles[profile] ?? profiles.squircle, bezel, thickness, ior, n);
  // Physics says 0 right at the rim, then a near-vertical climb to the peak: hold the peak out to the rim
  // instead, or that cliff aliases into a sawtooth edge.
  const peak = disp.reduce((p, v, i) => (Math.abs(v) > Math.abs(disp[p]) ? i : p), 0);
  disp.fill(disp[peak], 0, peak);
  const max = Math.abs(disp[peak]) || 1;
  const lx = Math.cos((light * Math.PI) / 180),
    ly = Math.sin((light * Math.PI) / 180);
  const dmap = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) * w) / W - w / 2,
        py = ((y + 0.5) * h) / H - h / 2; // feImage stretches W×H onto w×h
      const qx = Math.abs(px) - w / 2 + r,
        qy = Math.abs(py) - h / 2 + r;
      let e,
        nx = 0,
        ny = 0; // e: distance inside the edge, (nx, ny): outward edge normal
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
      const i = (y * W + x) * 4;
      dmap[i] = 128 + (dx / max) * 127;
      dmap[i + 1] = 128 + (dy / max) * 127;
      dmap[i + 2] = s * 255;
      dmap[i + 3] = 255;
    }
  // Magnifier: sample towards the centre. The field is linear and feImage upscaling interpolates it
  // exactly, so ≤32px is plenty. Per-axis range (not the diagonal) keeps the 8-bit steps finer.
  const z = 1 - 1 / zoom,
    zmax = (Math.max(w, h) / 2) * Math.abs(z) || 1;
  const ZW = z ? Math.min(32, W) : 0,
    ZH = z ? Math.min(32, H) : 0,
    zmap = z ? new Uint8ClampedArray(ZW * ZH * 4) : null;
  for (let y = 0; y < ZH; y++)
    for (let x = 0; x < ZW; x++) {
      const i = (y * ZW + x) * 4;
      zmap[i] = 128 - (((((x + 0.5) * w) / ZW - w / 2) * z) / zmax) * 127;
      zmap[i + 1] = 128 - (((((y + 0.5) * h) / ZH - h / 2) * z) / zmax) * 127;
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
const FILTER = zoom => `${
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
<feBlend in="highlight" in2="rimmed"/>`;

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

function toURL(data, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0);
  return c.toDataURL();
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
    const [o, cs] = readOpts(el, opts),
      b = parseFloat(cs.borderLeftWidth),
      br = cs.borderTopLeftRadius;
    const w = el.offsetWidth - b - parseFloat(cs.borderRightWidth),
      h = el.offsetHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    if (w <= 0 || h <= 0) return;
    const half = Math.min(w, h) / 2; // ::before covers the padding box, so radius and size are inner ones
    o.radius = Math.max(
      0,
      Math.min(
        half,
        (br.endsWith('%') ? (parseFloat(br) / 100) * Math.min(el.offsetWidth, el.offsetHeight) : parseFloat(br) || 0) -
          b,
      ),
    );
    if (o.bezel === 'auto') o.bezel = Math.max(10, o.radius * 0.8);
    o.bezel = Math.min(half, o.bezel);
    if (o.thickness === 'auto') o.thickness = o.bezel * 1.2;
    const z = o.zoom !== 1;
    if (z !== zoomed) {
      zoomed = z;
      filter.innerHTML = FILTER(zoomed);
      for (const n of filter.querySelectorAll('[result]')) fe[n.getAttribute('result')] = n;
      fe.slope = filter.querySelector('feFuncA');
      key = null;
    }
    const res = Math.min(1, Math.max(0.5, 16 / o.bezel)); // ~16 samples across the bezel is plenty
    const k = [w, h, res, o.radius, o.bezel, o.thickness, o.profile, o.ior, o.light, o.zoom].join();
    const m = mapsFor(k, () => {
      const r = computeMaps(w, h, o, res);
      return { d: toURL(r.dmap, r.W, r.H), z: r.zmap && toURL(r.zmap, r.ZW, r.ZH), scale: r.scale, zscale: r.zscale };
    });
    if (k !== key) {
      key = k;
      for (const [img, url] of [
        [fe.map, m.d],
        [fe.zmap, m.z],
      ]) {
        if (!img) continue;
        for (const [a, v] of [
          ['x', 0],
          ['y', 0],
          ['width', w],
          ['height', h],
          ['href', url],
        ])
          img.setAttribute(a, v);
      }
    }
    fe.zoomed?.setAttribute('scale', m.zscale);
    // feDisplacementMap picks the nearest source pixel, so magnified content steps; a blur sized to the
    // magnification (in device px) smooths it like bilinear sampling would. Folded into the frost blur.
    // a zoom-wide pixel step needs σ ≈ 0.45 × zoom; Skia's CPU blur ignores σ under ~0.8 device px
    const aa = o.zoom > 1 ? (Math.max(0.8, 0.45 * o.zoom) * o.antialias) / (devicePixelRatio || 1) : 0;
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

// Horizontal drag: move(e) once past 4px, end(e, dragged) on release or cancel. A touch drag fires no
// click afterwards and a mouse drag does, so callers act in end() and swallowClick() the leftover.
function onDrag(host, move, end) {
  host.addEventListener('pointerdown', e => {
    if (e.button || host.querySelector(':disabled')) return;
    const t = e.target,
      x0 = e.clientX;
    let dragged = false;
    t.setPointerCapture(e.pointerId); // on the pressed element, so a plain tap still clicks it
    const mv = ev => {
      if ((dragged ||= Math.abs(ev.clientX - x0) > 4)) move(ev);
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

// Squash & stretch from horizontal speed, relaxing once movement stops. Feed it pointer x.
function jelly(el) {
  let s = 0,
    x0,
    t0,
    raf = 0;
  const tick = () => {
    s *= 0.82;
    el.style.transform = s > 0.004 ? `scale(${1 + s}, ${1 - s / 2})` : '';
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
    let f = 0;
    onDrag(
      this,
      e => {
        const r = this.getBoundingClientRect();
        f = Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width - 1 / 3) * 3)); // thumb centre runs from 1/3 to 2/3
        this.style.setProperty('--lg-f', f);
        this.toggleAttribute('data-dragging', true);
        squish(e.clientX);
      },
      (e, dragged) => {
        this.removeAttribute('data-dragging');
        this.style.removeProperty('--lg-f');
        if (!dragged || e.type !== 'pointerup') return;
        if (f > 0.5 !== this.input.checked) this.input.click(); // native toggle, fires input + change
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
    this.addEventListener('keydown', e => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d || this.role !== 'tablist') return;
      e.preventDefault();
      this.select(this.index + d, true);
      this.items[this.index].focus();
    });
    // the lens sinks back under the labels once it has arrived
    this.ind.addEventListener('transitionend', e => e.propertyName === 'translate' && this.settle());
    const squish = jelly(this.ind);
    let f = 0;
    onDrag(
      this,
      e => {
        const r = this.getBoundingClientRect(),
          pad = parseFloat(getComputedStyle(this).paddingLeft),
          n = this.items.length;
        f = Math.max(0, Math.min(n - 1, ((e.clientX - r.left - pad) / (r.width - 2 * pad)) * n - 0.5));
        this.style.setProperty('--i', f);
        this.toggleAttribute('data-dragging', true);
        this.toggleAttribute('data-moving', true);
        squish(e.clientX);
      },
      (e, dragged) => {
        if (!dragged) return;
        this.removeAttribute('data-dragging');
        if (e.type !== 'pointerup') return this.select(this.index); // cancelled: glide back
        this.items[Math.round(f)].click(); // same path as a tap: selects, follows links, runs your handlers
        swallowClick(this);
      },
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
    if (this.index != null && i !== this.index) {
      this.toggleAttribute('data-moving', true); // indicator swells into a lens while it travels
      if (fromUser) this.dispatchEvent(new Event('change', { bubbles: true }));
    }
    clearTimeout(this.t);
    this.t = setTimeout(() => this.settle(), 700); // in case no translate transition runs
    this.index = i;
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
// The rows scroll-snap and tilt on a drum (scroll-driven animation); the glass band magnifies the middle one.
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
    this.append(list, band);
    this.index = select.selectedIndex;
    list.addEventListener('scrollend', () => {
      const i = Math.round(list.scrollTop / list.firstChild.offsetHeight);
      this.index = i;
      if (i === select.selectedIndex) return;
      select.selectedIndex = i;
      for (const type of ['input', 'change']) select.dispatchEvent(new Event(type, { bubbles: true }));
    });
    select.addEventListener('change', () => this.go(select.selectedIndex)); // typeahead on the focused select
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
          done = () => this.removeAttribute('data-dragging');
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

// Dock: a magnifying lens follows the pointer, or keyboard focus, along a row of icons.
class LgDock extends Base {
  connectedCallback() {
    if (this.lens) return;
    const lens = (this.lens = Object.assign(document.createElement('div'), { className: 'lg-lens' })),
      wobble = jelly(lens);
    lens.dataset.glass = '';
    this.append(lens);
    const at = x => {
      const r = this.getBoundingClientRect();
      x = Math.max(0, Math.min(r.width, x - r.left));
      lens.style.translate = `${x - lens.offsetWidth / 2}px -50%`;
      wobble(x);
      this.toggleAttribute('data-lens', true);
    };
    const hide = () => this.removeAttribute('data-lens');
    this.addEventListener('pointermove', e => at(e.clientX));
    this.addEventListener('pointerleave', hide);
    this.addEventListener('focusin', e => {
      const r = e.target.getBoundingClientRect();
      at(r.left + r.width / 2);
    });
    this.addEventListener('focusout', hide);
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
  background: color-mix(in srgb, var(--lg-green) calc(clamp(0, var(--lg-f), 1) * 100%), light-dark(rgb(120 120 128 / .22), rgb(120 120 128 / .4)));
  transition: --lg-f .5s var(--lg-spring);
  &:has(:checked) { --lg-f: 1; }
  &[data-dragging] { transition: none; }
  &:has(:focus-visible) { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  &:has(:disabled) { filter: grayscale(1) opacity(.5); }
  & input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
  & .lg-thumb {
    --lg-profile: lip; --lg-specular: .6;
    position: absolute; top: 50%; left: calc(1.34em + (100% - 2.68em) * var(--lg-f)); width: 3.9em; height: 2.4em; border-radius: 1.2em;
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
  &:has(select:focus-visible) { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  & select { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
  /* spacers instead of padding, so the rows centre whatever box-sizing the page uses */
  & .lg-rows { height: 100%; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; scroll-snap-type: y mandatory; }
  & .lg-rows::before, & .lg-rows::after { content: ''; display: block; height: 4em; }
  &[data-dragging] .lg-rows { scroll-snap-type: none; }
  & .lg-rows > div {
    height: 2em; line-height: 2em; padding-inline: 1em; text-align: center; white-space: nowrap; cursor: default; scroll-snap-align: center;
    animation: lg-drum linear both; animation-timeline: view();
  }
  & .lg-band {
    --lg-zoom: 1.25; --lg-blur: 0; --lg-specular: .4; --lg-antialias: 0; /* at 1.25× the text reads sharper unsmoothed */
    position: absolute; inset: calc(50% - 1em) .3em auto; height: 2em; border-radius: .6em; pointer-events: none;
    background: rgb(127 127 127 / .14); box-shadow: none;
  }
}
lg-dock {
  position: relative; display: inline-flex; align-items: center; gap: .4em; padding: .45em; border-radius: 1.5em; vertical-align: middle; touch-action: pan-y;
  & > :is(a, button) {
    all: unset; display: grid; place-items: center; width: 2.6em; height: 2.6em; border-radius: .8em; cursor: pointer;
    &:focus-visible { outline: 2px solid var(--lg-accent); outline-offset: 2px; }
  }
  & :is(svg, img) { width: 1.5em; height: 1.5em; }
  & .lg-lens {
    --lg-zoom: 1.35; --lg-bezel: 12; --lg-blur: 0; /* narrow bezel: a flat magnifier, so icons stay undistorted */
    position: absolute; top: 50%; left: 0; height: 150%; aspect-ratio: 1; border-radius: 50%; z-index: 1; pointer-events: none;
    background: rgb(255 255 255 / .04); scale: 0; transition: scale .2s ease-in;
  }
  &[data-lens] .lg-lens { scale: 1; transition: scale .5s var(--lg-spring); }
}
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
  translate: 0 calc(100% + 1em);
  transition: translate .3s cubic-bezier(.4, 0, 1, 1), display .3s allow-discrete, overlay .3s allow-discrete;
  /* --lg-detent: offset from fully open, set by the drag */
  &[open] { display: flex; flex-direction: column; translate: 0 var(--lg-detent, max(0px, 100% - 50dvh)); transition: translate .5s var(--lg-glide), display .5s allow-discrete, overlay .5s allow-discrete; }
  @starting-style { &[open] { translate: 0 calc(100% + 1em); } }
  &[data-dragging] { transition: none; }
  &::after { content: ''; position: absolute; top: .6em; left: 50%; width: 2.5em; height: .3em; translate: -50%; border-radius: 1em; background: currentColor; opacity: .25; }
}
@media (prefers-reduced-motion: reduce) {
  .lg-btn, .lg-menu, .lg-tip, .lg-toast, .lg-alert, .lg-sheet, .lg-toolbar > *, lg-switch, lg-switch *, lg-slider *, lg-segmented *, lg-stepper *, lg-dots *, lg-dock * { transition-duration: 0s !important; }
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
  customElements.define('lg-dock', LgDock);

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
