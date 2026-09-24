// terrain-grid 单测（R31）：增量重建与旧实现（全量重建）逐格等价。
// 这是增量化的正确性底线——任何 diff 策略的 bug 都会表现为"刷过的地方地形不对"。
// 运行：node --experimental-strip-types --test tests/unit/
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGrid, normalizePatches } from "../../src/renderer/terrain-grid.ts";

/** 参考实现：完全照搬旧版 MapCanvas 的全量重建（作为等价性判据） */
function reference(w, h, defaultTerrain, raw) {
  const grid = new Int8Array(Math.max(0, w * h));
  grid.fill(defaultTerrain);
  const patches = Array.isArray(raw) ? raw : [];
  for (const patch of patches) {
    if (patch === null || typeof patch !== "object") continue;
    const x = Number(patch.x);
    const y = Number(patch.y);
    const pw = Number(patch.w);
    const ph = Number(patch.h);
    const t = Number(patch.terrain ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pw) || !Number.isFinite(ph)) continue;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(w, Math.ceil(x + pw));
    const y1 = Math.min(h, Math.ceil(y + ph));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) grid[yy * w + xx] = t;
    }
  }
  return grid;
}

const eq = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);

test("首次构建 = 参考实现（含 default_terrain 铺底与补丁覆盖）", () => {
  const patches = [
    { x: 1, y: 1, w: 3, h: 3, terrain: 2 },
    { x: 2, y: 2, w: 2, h: 2, terrain: 3 },
  ];
  const cache = nextGrid(null, 8, 8, 0, patches);
  assert.ok(eq(cache.grid, reference(8, 8, 0, patches)));
});

test("补丁未变 → 返回同一 cache 对象（零工作）", () => {
  const patches = [{ x: 1, y: 1, w: 3, h: 3, terrain: 2 }];
  const first = nextGrid(null, 8, 8, 0, patches);
  const gridRef = first.grid;
  const second = nextGrid(first, 8, 8, 0, patches);
  assert.equal(second, first, "应原样返回同一 cache");
  assert.equal(gridRef, second.grid, "栅格未被重建");
});

test("追加一条补丁：增量结果与全量重建等价", () => {
  const a = [{ x: 1, y: 1, w: 3, h: 3, terrain: 2 }];
  const cache = nextGrid(null, 10, 10, 0, a);
  const b = [...a, { x: 5, y: 5, w: 2, h: 2, terrain: 4 }];
  const after = nextGrid(cache, 10, 10, 0, b);
  assert.ok(eq(after.grid, reference(10, 10, 0, b)));
});

test("改动中间一条补丁：后续补丁需重新叠加（覆盖顺序）", () => {
  const a = [
    { x: 0, y: 0, w: 4, h: 4, terrain: 1 },
    { x: 2, y: 2, w: 4, h: 4, terrain: 3 }, // 覆盖前一条的右下角
    { x: 3, y: 3, w: 2, h: 2, terrain: 4 }, // 再覆盖
  ];
  const cache = nextGrid(null, 12, 12, 0, a);
  // 改中间那条（3 → 2）：其后的第 3 条必须重放，否则 (3,3) 会退回 3 而不是 4
  const b = [a[0], { ...a[1], terrain: 2 }, a[2]];
  const after = nextGrid(cache, 12, 12, 0, b);
  assert.ok(eq(after.grid, reference(12, 12, 0, b)), "中间补丁改动后与全量重建不一致");
});

test("缩小/挪走补丁：旧矩形必须回落到 default_terrain", () => {
  const a = [{ x: 1, y: 1, w: 6, h: 6, terrain: 3 }];
  const cache = nextGrid(null, 12, 12, 0, a);
  // 缩成 2×2：原 6×6 中多出来的格应回到 0
  const b = [{ x: 1, y: 1, w: 2, h: 2, terrain: 3 }];
  const after = nextGrid(cache, 12, 12, 0, b);
  assert.ok(eq(after.grid, reference(12, 12, 0, b)), "缩小补丁后残留旧格");
  assert.equal(after.grid[1 * 12 + 5], 0, "(5,1) 应回落到 default_terrain");
});

test("删除补丁：原覆盖格全部回落", () => {
  const a = [{ x: 2, y: 2, w: 3, h: 3, terrain: 1 }];
  const cache = nextGrid(null, 9, 9, 0, a);
  const after = nextGrid(cache, 9, 9, 0, []);
  assert.ok(eq(after.grid, reference(9, 9, 0, [])));
});

test("尺寸变化 → 全量重建（不沿用旧栅格）", () => {
  const a = [{ x: 1, y: 1, w: 3, h: 3, terrain: 2 }];
  const small = nextGrid(null, 8, 8, 0, a);
  const big = nextGrid(small, 16, 16, 0, a);
  assert.equal(big.grid.length, 256);
  assert.ok(eq(big.grid, reference(16, 16, 0, a)));
});

test("default_terrain 变化 → 全量重建", () => {
  const a = [{ x: 1, y: 1, w: 2, h: 2, terrain: 4 }];
  const c0 = nextGrid(null, 8, 8, 0, a);
  const c1 = nextGrid(c0, 8, 8, 2, a);
  assert.ok(eq(c1.grid, reference(8, 8, 2, a)));
});

test("随机序列差分（100 步）：每步都与全量重建等价", () => {
  let w = 20;
  let h = 20;
  let def = 0;
  let patches = [];
  let cache = null;
  // 固定种子的伪随机（可复现）
  let seed = 20260924;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let step = 0; step < 100; step += 1) {
    const op = rnd(4);
    if (op === 0 || patches.length === 0) {
      patches = [...patches, { x: rnd(w), y: rnd(h), w: 1 + rnd(5), h: 1 + rnd(5), terrain: rnd(5) }].slice(0, 30);
    } else if (op === 1) {
      const i = rnd(patches.length);
      patches = patches.map((p, k) => (k === i ? { ...p, terrain: rnd(5) } : p));
    } else if (op === 2) {
      const i = rnd(patches.length);
      patches = patches.filter((_, k) => k !== i);
    } else {
      const i = rnd(patches.length);
      patches = patches.map((p, k) => (k === i ? { ...p, x: rnd(w), y: rnd(h) } : p));
    }
    cache = nextGrid(cache, w, h, def, patches);
    assert.ok(eq(cache.grid, reference(w, h, def, patches)), `第 ${step} 步与全量重建不一致（op=${op}）`);
  }
});

test("normalizePatches：非有限值跳过、越界钳制（字段树误输入巨值不死循环）", () => {
  const raw = [
    { x: 0, y: 0, w: 1e9, h: 1e9, terrain: 1 }, // 巨值：钳到图界而非爆炸
    { x: Number.NaN, y: 0, w: 1, h: 1, terrain: 2 }, // 非有限：跳过
    { x: -5, y: -5, w: 3, h: 3, terrain: 3 }, // 整体在图外：钳后为空矩形 → 跳过
    { x: -2, y: -2, w: 5, h: 5, terrain: 4 }, // 部分重叠：钳到 0 并保留
    null,
    "bad",
    { x: 2, y: 2, w: 0, h: 0, terrain: 5 }, // 零尺寸：跳过
  ];
  const out = normalizePatches(raw, 10, 10);
  assert.equal(out.length, 2, `应只保留 2 条有效补丁，实得 ${out.length}`);
  assert.deepEqual(out[0], { x: 0, y: 0, w: 10, h: 10, terrain: 1 }, "巨值补丁应钳到整图");
  assert.deepEqual(out[1], { x: 0, y: 0, w: 3, h: 3, terrain: 4 }, "部分重叠补丁应钳到图界内");
});

test("图外补丁被跳过与「参考实现写不到格」等价", () => {
  // 参考实现对该补丁的循环 x0=0..x1=(-2) 一次都不执行 → 等同跳过，不产生差异
  const raw = [{ x: -5, y: -5, w: 3, h: 3, terrain: 3 }];
  const viaNext = nextGrid(null, 10, 10, 0, raw);
  assert.ok(eq(viaNext.grid, reference(10, 10, 0, raw)), "全图外补丁不应与参考实现产生差异");
  assert.ok(viaNext.grid.every((v) => v === 0), "全图外补丁不应改动任何格");
});

