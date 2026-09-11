import { describe, expect, it } from "vitest";

import {
  applySelectionAddMany,
  applySelectionClick,
  emptySelection,
  estimateSelectionTokens,
  MAX_FORWARD_SELECTION,
  type SelectableMessage,
} from "./selection";

const order = ["a", "b", "c", "d", "e"];

describe("applySelectionClick（锚点-区间-反选）", () => {
  it("第一次点击选中并设锚点", () => {
    const step = applySelectionClick(emptySelection(), "b", order);
    expect([...step.next.selected]).toEqual(["b"]);
    expect(step.next.anchor).toBe("b");
    expect(step.notice).toBeNull();
  });

  it("有锚点时点击另一条选中整个区间并清除锚点", () => {
    const first = applySelectionClick(emptySelection(), "b", order);
    const second = applySelectionClick(first.next, "e", order);
    expect([...second.next.selected].sort()).toEqual(["b", "c", "d", "e"]);
    expect(second.next.anchor).toBeNull();
  });

  it("反向区间同样成立", () => {
    const first = applySelectionClick(emptySelection(), "d", order);
    const second = applySelectionClick(first.next, "b", order);
    expect([...second.next.selected].sort()).toEqual(["b", "c", "d"]);
  });

  it("点击已选消息反选，锚点不动", () => {
    let state = applySelectionClick(emptySelection(), "b", order).next;
    state = applySelectionClick(state, "d", order).next; // 区间 b..d
    const step = applySelectionClick(state, "c", order);
    expect([...step.next.selected].sort()).toEqual(["b", "d"]);
    // 区间形成后锚点已清除；再点未选消息重新开始
    const again = applySelectionClick(step.next, "a", order);
    expect(again.next.anchor).toBe("a");
    expect([...again.next.selected].sort()).toEqual(["a", "b", "d"]);
  });

  it("区间与反选交替自然工作", () => {
    let state = applySelectionClick(emptySelection(), "a", order).next;
    state = applySelectionClick(state, "c", order).next; // a..c
    state = applySelectionClick(state, "e", order).next; // 无锚点，选中 e + 锚点
    expect([...state.selected].sort()).toEqual(["a", "b", "c", "e"]);
    expect(state.anchor).toBe("e");
  });

  it("区间选择超上限时选到上限为止并提示", () => {
    const many = Array.from({ length: 40 }, (_, index) => `m${index}`);
    const first = applySelectionClick(emptySelection(), "m0", many);
    const second = applySelectionClick(first.next, "m39", many);
    expect(second.next.selected.size).toBe(MAX_FORWARD_SELECTION);
    expect(second.notice).toContain("已达上限");
  });

  it("单选超上限时不生效并提示", () => {
    const selected = new Set(order.slice(0, 3));
    const step = applySelectionClick({ selected, anchor: null }, "e", order, 3);
    expect(step.next.selected.has("e")).toBe(false);
    expect(step.notice).toContain("已达上限");
  });

  it("锚点不可见时退化为单选", () => {
    const state = { selected: new Set<string>(["x"]), anchor: "x" };
    const step = applySelectionClick(state, "b", order);
    expect([...step.next.selected].sort()).toEqual(["b", "x"]);
    expect(step.next.anchor).toBe("b");
  });
});

describe("applySelectionAddMany（选择整个 Turn）", () => {
  it("并入已有选择并受上限约束", () => {
    const state = { selected: new Set(["a"]), anchor: null };
    const step = applySelectionAddMany(state, ["b", "c"], 10);
    expect([...step.next.selected].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("estimateSelectionTokens", () => {
  it("按 chars/4 加结构开销估算", () => {
    const messages: SelectableMessage[] = [
      { id: "a", role: "user", text: "x".repeat(400), attachments: [] },
      { id: "b", role: "assistant", text: "y".repeat(400), attachments: [] },
    ];
    expect(estimateSelectionTokens(messages)).toBe(Math.ceil((400 + 40 + 400 + 40) / 4));
  });
});
