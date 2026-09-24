// zoom-ladder 单测（R31）：缩放档位的单调性与边界。
// 运行：node --experimental-strip-types --test tests/unit/
import { test } from "node:test";
import assert from "node:assert/strict";
import { ppcOf, stepZoom, wheelDirection, ladderIndexForPpc, MIN_ZOOM, MAX_ZOOM } from "../../src/renderer/zoom-ladder.ts";

// 实图尺寸（baseCell = clamp(480/max(w,h), 4, 16)）
const BASES = [4, 5, 6, 7, 8, 10, 12, 16];

test("ppcOf 与旧实现同口径（钳 3..96）", () => {
  assert.equal(ppcOf(10, 1), 10);
  assert.equal(ppcOf(10, 2), 20);
  assert.equal(ppcOf(10, 100), 96); // 上限
  assert.equal(ppcOf(10, 0.01), 3); // 下限
  assert.equal(ppcOf(10, Number.NaN), 10); // 非法 zoom 回落到 1×
});

test("放大方向 ppc 单调不减（旧实现缺陷回归）", () => {
  // 旧实现：baseCell=16 时 zoom 0.35→0.5 会让 ppc 5.6→8（缩小时反而变大）。
  // 新实现以 ppc 阶梯为真相，任何 baseCell 上放大都不得让 ppc 变小。
  for (const base of BASES) {
    let zoom = 1;
    let prevPpc = ppcOf(base, zoom);
    for (let i = 0; i < 20; i += 1) {
      zoom = stepZoom(base, zoom, -1); // dir<0 = 放大
      const next = ppcOf(base, zoom);
      assert.ok(next >= prevPpc, `base=${base} 放大后 ppc 变小：${prevPpc} → ${next}`);
      prevPpc = next;
    }
  }
});

test("缩小方向 ppc 单调不增", () => {
  for (const base of BASES) {
    let zoom = 1;
    let prevPpc = ppcOf(base, zoom);
    for (let i = 0; i < 20; i += 1) {
      zoom = stepZoom(base, zoom, 1); // dir>0 = 缩小
      const next = ppcOf(base, zoom);
      assert.ok(next <= prevPpc, `base=${base} 缩小后 ppc 变大：${prevPpc} → ${next}`);
      prevPpc = next;
    }
  }
});

test("连续同向步进最终到达端部并停住（不越界、不死循环）", () => {
  for (const base of BASES) {
    let zoom = 1;
    for (let i = 0; i < 50; i += 1) zoom = stepZoom(base, zoom, -1);
    const top = zoom;
    assert.ok(top / 1 >= MIN_ZOOM * 0.9, `base=${base} 放大端部 zoom=${top} 越下界`);
    assert.equal(stepZoom(base, top, -1), top, "端部再放大应原样返回");

    let down = 1;
    for (let i = 0; i < 50; i += 1) down = stepZoom(base, down, 1);
    assert.ok(down <= MAX_ZOOM * 1.1, `base=${base} 缩小端部 zoom=${down} 越上界`);
    assert.equal(stepZoom(base, down, 1), down, "端部再缩小应原样返回");
  }
});

test("1× 恒等于 baseCell 像素/格（smoke 断言的 ppc=10/7 口径）", () => {
  for (const base of BASES) assert.equal(ppcOf(base, 1), base);
});

test("smoke 的 <10px → 单次滚轮必 >1.05×（真实图 baseCell>6）", () => {
  // smoke 断言的 map（p0_corridor 16×16 → baseCell 16；new_map 48×32 → 10）都满足 baseCell>6
  for (const base of [7, 10, 12, 16]) {
    const next = stepZoom(base, 1, -1);
    assert.ok(next > 1.05, `base=${base} 单次放大得 zoom=${next}，不满足 smoke 的 >1.05`);
  }
});

test("wheelDirection 兼容三种 deltaMode 并吸收触控板惯性", () => {
  assert.equal(wheelDirection({ deltaY: -240, deltaMode: 0 }), -1, "像素模式负值=放大");
  assert.equal(wheelDirection({ deltaY: 240, deltaMode: 0 }), 1, "像素模式正值=缩小");
  assert.equal(wheelDirection({ deltaY: -3, deltaMode: 1 }), -1, "行模式 -3 行 = 放大");
  assert.equal(wheelDirection({ deltaY: -1, deltaMode: 2 }), -1, "页模式 -1 页 = 放大");
  assert.equal(wheelDirection({ deltaY: -5, deltaMode: 0 }), 0, "细碎惯性不切档");
  assert.equal(wheelDirection({ deltaY: 0 }), 0, "零位移不切档");
});

test("ladderIndexForPpc 定位最近档位", () => {
  assert.equal(ladderIndexForPpc(7), 4); // 阶梯 [3,4,5,6,7,...]
  assert.equal(ladderIndexForPpc(1000), 16); // 钳到最大档（96）
  assert.equal(ladderIndexForPpc(Number.NaN), 0);
});
