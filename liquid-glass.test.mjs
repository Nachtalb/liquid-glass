// node liquid-glass.test.mjs
import assert from 'node:assert/strict';
import { profiles, bezelDisplacement, computeMaps } from './liquid-glass.js';

const sq = bezelDisplacement(profiles.squircle, 20, 24, 1.5);
assert(sq.every(v => v >= 0) && Math.max(...sq) > 1, 'convex bends rays inward');
assert(
  bezelDisplacement(profiles.concave, 20, 24, 1.5).every(v => v <= 0),
  'concave bends rays outward',
);
assert(
  bezelDisplacement(profiles.squircle, 20, 24, 1).every(v => Math.abs(v) < 1e-9),
  'ior 1 = no refraction',
);

const o = { radius: 20, bezel: 16, thickness: 20, profile: 'squircle', ior: 1.5, light: 225, zoom: 1 };
const { W, H, dmap, scale } = computeMaps(100, 60, o);
const px = (x, y) => Array.from(dmap.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
assert.equal(W * H, 6000);
assert.deepEqual(px(50, 30).slice(0, 2), [128, 128], 'flat centre is neutral');
assert(px(2, 30)[0] > 140 && px(97, 30)[0] < 116, 'edges sample towards the centre (x)');
assert(px(50, 2)[1] > 140 && px(50, 57)[1] < 116, 'edges sample towards the centre (y)');
assert(dmap[(30 * W + 0) * 4 + 2] > 50 && dmap[(30 * W + 50) * 4 + 2] === 0, 'rim light (blue) only on the rim');
assert.equal(computeMaps(100, 60, o, 0.5).W, 50, 'res scales the map');

const z = computeMaps(100, 100, { ...o, zoom: 2 });
const zx = (x, y) => z.zmap[(y * z.ZW + x) * 4];
assert(
  z.ZW === 32 && zx(8, 16) > 128 && zx(24, 16) < 128 && z.zscale > 0 && !computeMaps(10, 10, o).zmap,
  'zoom samples towards the centre',
);
const r = computeMaps(101, 60, o, 0.5); // odd size: map centres must still span the element exactly
assert.deepEqual([r.W, r.dmap[((30 >> 1) * r.W + 25) * 4]], [51, 128], 'low-res map stays centred');

console.log('ok, max displacement', scale.toFixed(1), 'px');
