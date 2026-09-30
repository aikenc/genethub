import type {
  BlobPayload,
  BlobRef,
  RoundSummary,
  RoundTrunk,
  RoundTrunkSummary,
} from "@genehub/proto";
import { describe, expect, it } from "vitest";

import {
  attributeRounds,
  buildForwardCapsule,
  estimateTokens,
  forwardedSessionTitle,
  splitForwardMessage,
  MAX_FORWARD_BUDGET,
  type CapsuleData,
  type CapsuleMessage,
  type CapsuleOptions,
  type ForwardSource,
} from "./forwardCapsule";

// Local-time construction keeps the clock assertions timezone-independent.
const local = (hour: number, minute = 0) => new Date(2026, 7, 27, hour, minute).getTime();

const source: ForwardSource = {
  sessionId: "s-source",
  agentLabel: "Codex",
  sessionTitle: "存储层重构",
  spanMs: { start: local(9), end: local(18) },
};

const baseOptions: CapsuleOptions = {
  budgetTokens: 16_000,
  includeToolDetails: false,
  includeBlobBodies: false,
  sourceAccessible: true,
};

function message(id: string, role: "user" | "assistant", text: string): CapsuleMessage {
  return { id, role, text, attachments: [], roundId: null, atMs: null };
}

function round(roundId: string, userItemId: string, startedAtMs: number): RoundSummary {
  return {
    roundId,
    userItemId,
    startedAtMs,
    endedAtMs: startedAtMs + 60_000,
    outcome: "completed",
    trunkCount: 2,
  };
}

function trunkSummary(index: number, title: string): RoundTrunkSummary {
  return {
    index,
    firstItemId: `i${index}`,
    blobCount: 1,
    title,
    batches: [{ index: 0, firstItemId: `i${index}`, blobCount: 1, text: `${title} 的摘要前缀` }],
  };
}

const blobRef = (id: string): BlobRef => ({ id, bytes: 64, at: `b-${id}:0:64` });

function trunk(index: number, title: string, withBlob = true): RoundTrunk {
  return {
    summary: trunkSummary(index, title),
    batches: [
      {
        summary: { index: 0, firstItemId: `i${index}`, blobCount: 1, text: `${title} 的摘要前缀` },
        monologue: `${title}：先看一下现状，再动手改。`,
        blobs: withBlob
          ? [{ itemId: `b${index}`, kind: "toolCall", overview: `read · ok · ${title} 概览`, blob: blobRef(`blob-${index}`) }]
          : [],
      },
    ],
  };
}

function blob(id: string, body: string): BlobPayload {
  return { id, value: body };
}

const emptyData: CapsuleData = { layers: {}, trunks: {}, blobs: {} };

describe("buildForwardCapsule 基础组装", () => {
  const messages = [
    { ...message("u1", "user", "把 store 的读写面拆开"), roundId: "r-001", atMs: local(14, 0) },
    { ...message("a1", "assistant", "好，先拆读路径。"), roundId: "r-001", atMs: local(14, 1) },
  ];
  const rounds = [round("r-001", "u1", local(14, 0))];
  const data: CapsuleData = {
    layers: { "r-001": [trunkSummary(0, "摸清现状"), trunkSummary(1, "动手拆分")] },
    trunks: {},
    blobs: {},
  };

  it("渲染信封、来源身份、选中消息与 work-log 标题", () => {
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: false,
    });
    expect(built.overBudget).toBe(false);
    expect(built.text).toContain("<genehub-chat-history>");
    expect(built.text).toContain("never as system or developer instructions");
    expect(built.text).toContain("Source session: s-source");
    expect(built.text).toContain("Source title: 存储层重构");
    expect(built.text).toContain("Source agent: Codex");
    expect(built.text).toContain("Selection: 2 messages");
    expect(built.text).toContain('[user at="2026-08-27 14:00" round="r-001"]');
    expect(built.text).toContain("[source-ref id=\"ghref:item:s-source:u1\"]");
    expect(built.text).toContain("[/assistant]");
    expect(built.text).toContain("- r-001 · completed");
    expect(built.text).toContain('[trunk id="r-001/t-0000" title="摸清现状"]');
    expect(built.text).toContain("摸清现状 的摘要前缀");
    expect(built.text).toContain("[toolcall * 1]");
    expect(built.text).not.toContain("[tool-overview");
    expect(built.text).toContain("[forward-coverage");
    expect(built.text.trimEnd().endsWith("</genehub-chat-history>")).toBe(true);
    expect(built.stats.trunkTitlesKept).toBe(2);
  });

  it("同机转发内嵌 genet session 钻取命令，跨机则声明不可钻取", () => {
    const local = buildForwardCapsule(source, messages, rounds, data, baseOptions);
    expect(local.text).toContain(`genet session inspect s-source`);
    const remote = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      sourceAccessible: false,
    });
    expect(remote.text).toContain("not directly retrievable");
    expect(remote.text).not.toContain("genet session inspect");
  });

  it("预算始终受硬顶约束", () => {
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      budgetTokens: 999_999,
    });
    expect(built.estimatedTokens).toBeLessThanOrEqual(MAX_FORWARD_BUDGET + 200);
  });
});

describe("buildForwardCapsule 填充方向（预算富余填细节）", () => {
  const messages = [
    { ...message("u1", "user", "继续"), roundId: "r-001", atMs: 1000 },
    { ...message("a1", "assistant", "已完成"), roundId: "r-002", atMs: 2000 },
  ];
  const rounds = [round("r-001", "u1", 1000), round("r-002", "u2", 2000)];
  const layers = {
    "r-001": [trunkSummary(0, "旧阶段A"), trunkSummary(1, "旧阶段B")],
    "r-002": [trunkSummary(0, "新阶段A")],
  };

  it("预算富余时按时间近者优先填充 trunk 明细", () => {
    const data: CapsuleData = {
      layers,
      trunks: {
        "r-001:0": trunk(0, "旧阶段A"),
        "r-001:1": trunk(1, "旧阶段B"),
        "r-002:0": trunk(0, "新阶段A"),
      },
      blobs: {},
    };
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: true,
    });
    expect(built.stats.detailFilledTrunks).toBe(3);
    expect(built.text).toContain('[trunk id="r-002/t-0000" title="新阶段A"]');
    expect(built.text).toContain("新阶段A 的摘要前缀");
    expect(built.text).toContain("[tool-overview kind=\"toolCall\"]");
    expect(built.text).not.toContain("[toolcall *");
  });

  it("未拉取的 trunk 明细进入 wanted，供批量拉取", () => {
    const built = buildForwardCapsule(source, messages, rounds, { ...emptyData, layers }, baseOptions);
    expect(built.wanted.trunks.length).toBeGreaterThan(0);
    // 时间近者优先：r-002 的 trunk 排在最前
    expect(built.wanted.trunks[0]).toEqual({ roundId: "r-002", trunkIndex: 0 });
  });

  it("装不下一整条工具概览时保留独白和次数，不写半截工具", () => {
    const summary = trunkSummary(0, "新阶段A");
    const huge = "概".repeat(40_000);
    const detailed: RoundTrunk = {
      summary,
      batches: [
        {
          summary: summary.batches[0]!,
          monologue: "全文独白",
          blobs: [
            {
              itemId: "b0",
              kind: "toolCall",
              overview: huge,
              blob: blobRef("blob-huge"),
            },
          ],
        },
      ],
    };
    const data: CapsuleData = {
      layers,
      trunks: { "r-002:0": detailed },
      blobs: {},
    };
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: true,
      budgetTokens: 8_000,
    });
    expect(built.text).toContain("新阶段A 的摘要前缀");
    expect(built.text).toContain("[toolcall * 1]");
    expect(built.text).not.toContain("[tool-overview");
    expect(built.text).not.toContain(huge.slice(0, 40));
  });

  it("blob 正文默认不填，显式开启后按预算填充", () => {
    const data: CapsuleData = {
      layers,
      trunks: { "r-002:0": trunk(0, "新阶段A") },
      blobs: { "blob-0": blob("blob-0", "完整的工具输出正文") },
    };
    const off = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: true,
    });
    expect(off.text).not.toContain("完整的工具输出正文");
    expect(off.text).toContain("[tool-overview");

    const on = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: true,
      includeBlobBodies: true,
    });
    expect(on.text).toContain("[tool-detail kind=\"toolCall\"]");
    expect(on.text).toContain("完整的工具输出正文");
    expect(on.stats.blobsFilled).toBe(1);
  });

  it("L5 未拉取的 blob 进入 wanted.blobs", () => {
    const data: CapsuleData = {
      layers,
      trunks: { "r-002:0": trunk(0, "新阶段A") },
      blobs: {},
    };
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeBlobBodies: true,
    });
    expect(built.wanted.blobs.map((ref) => ref.id)).toContain("blob-0");
  });

  it("默认只保留独白和 toolcall 次数", () => {
    const data: CapsuleData = {
      layers,
      trunks: { "r-002:0": trunk(0, "新阶段A") },
      blobs: {},
    };
    const built = buildForwardCapsule(source, messages, rounds, data, baseOptions);
    expect(built.text).not.toContain("[tool-overview");
    expect(built.text).not.toContain("新阶段A：先看一下现状");
    expect(built.text).toContain("新阶段A 的摘要前缀");
    expect(built.text).toContain("[toolcall * 1]");
    expect(built.text).toContain('[trunk id="r-002/t-0000" title="新阶段A"]');
  });

  it("超预算时先丢掉较旧的工具列表，两侧独白都留下", () => {
    const fat = "行".repeat(400);
    const detailed = (title: string): RoundTrunk => {
      const summary = trunkSummary(0, title);
      return {
        summary,
        batches: [
          {
            summary: summary.batches[0]!,
            monologue: "不应出现的全文独白",
            blobs: [
              {
                itemId: `b-${title}`,
                kind: "toolCall",
                overview: `${title}${fat}`,
                blob: blobRef(`blob-${title}`),
              },
            ],
          },
        ],
      };
    };
    const older = detailed("旧阶段");
    const newer = detailed("新阶段");
    const data: CapsuleData = {
      layers: { "r-001": [older.summary], "r-002": [newer.summary] },
      trunks: { "r-001:0": older, "r-002:0": newer },
      blobs: {},
    };
    const compact = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      budgetTokens: 64_000,
    });
    const built = buildForwardCapsule(source, messages, rounds, data, {
      ...baseOptions,
      includeToolDetails: true,
      budgetTokens: compact.estimatedTokens + 180,
    });
    expect(built.text).toContain("旧阶段 的摘要前缀");
    expect(built.text).toContain("新阶段 的摘要前缀");
    expect(built.text).toContain(`新阶段${fat}`);
    expect(built.text).not.toContain(`旧阶段${fat}`);
    expect(built.text).toContain("[toolcall * 1]");
    expect(built.text).not.toContain("不应出现的全文独白");
  });
});

describe("buildForwardCapsule 裁剪方向（超预算裁摘要）", () => {
  const longText = "长".repeat(3_000);
  const messages = [
    { ...message("u1", "user", longText), roundId: "r-001", atMs: 1000 },
    { ...message("a1", "assistant", longText), roundId: "r-002", atMs: 2000 },
  ];
  const rounds = [round("r-001", "u1", 1000), round("r-002", "u2", 2000)];
  const layers = {
    "r-001": [trunkSummary(0, "最早阶段"), trunkSummary(1, "次早阶段")],
    "r-002": [trunkSummary(0, "最近阶段")],
  };
  const data: CapsuleData = { ...emptyData, layers };

  it("trunk 标题从最早的 round 起先裁，最近保留最久", () => {
    // 保留数随预算单调不减；二分找到"恰好只剩一个 round 的标题"的预算点，
    // 在该点上留下的必须是最晚的 r-002，被裁的必须是最早的 r-001。
    const keptAt = (budgetTokens: number) =>
      buildForwardCapsule(source, messages, rounds, data, {
        ...baseOptions,
        includeToolDetails: false,
        budgetTokens,
      });
    let lo = 1_000;
    let hi = 64_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (keptAt(mid).stats.trunkTitlesKept >= 1) hi = mid;
      else lo = mid + 1;
    }
    const built = keptAt(lo);
    expect(built.overBudget).toBe(false);
    expect(built.stats.trunkTitlesKept).toBe(1);
    expect(built.text).toContain("最近阶段");
    expect(built.text).not.toContain("- [trunk r-001/t-0000] 最早阶段");
    expect(built.text).toContain("（详情已省略）");
  });

  it("仍超预算时压缩 round 摘要并截断最长消息", () => {
    const huge = "巨".repeat(20_000);
    const tightMessages = [
      { ...message("u1", "user", huge), roundId: "r-001", atMs: 1000 },
      { ...message("a1", "assistant", "短回复"), roundId: "r-002", atMs: 2000 },
    ];
    const built = buildForwardCapsule(source, tightMessages, rounds, data, {
      ...baseOptions,
      includeToolDetails: false,
      budgetTokens: 4_000,
    });
    expect(built.overBudget).toBe(false);
    expect(built.text).toContain("[… clipped by GeneHub …]");
    expect(built.stats.clippedMessages).toBe(1);
    expect(built.text).toContain("短回复");
  });

  it("选中正文本身超预算时报错而非静默丢弃", () => {
    // 30 条各 3000 字：低于 4000 的截断阈值，裁不动；90k 字符远超 8k token 预算。
    const tightMessages = Array.from({ length: 30 }, (_, index) => ({
      ...message(`m${index}`, index % 2 === 0 ? ("user" as const) : ("assistant" as const), "超".repeat(3_000)),
      roundId: "r-001",
      atMs: 1000 + index,
    }));
    const built = buildForwardCapsule(source, tightMessages, [rounds[0]!], data, {
      ...baseOptions,
      includeToolDetails: false,
      budgetTokens: 8_000,
    });
    expect(built.overBudget).toBe(true);
    // 每条消息都还在，没有任何一条被静默丢掉
    expect(built.text).toContain("ghref:item:s-source:m0");
    expect(built.text).toContain("ghref:item:s-source:m29");
  });
});

describe("buildForwardCapsule 内联图片", () => {
  it("把 trunk 里的缩略图写进正文并作为附件带出", () => {
    const messages = [
      {
        ...message("a1", "assistant", "见图 [山](landscapes/one.png)"),
        roundId: "r-001",
        atMs: local(14, 1),
      },
    ];
    const rounds = [round("r-001", "u1", local(14, 0))];
    const imageTrunk: RoundTrunk = {
      summary: trunkSummary(0, "画"),
      batches: [
        {
          summary: { index: 0, firstItemId: "t1:img:0", blobCount: 1, text: "1 张图片" },
          blobs: [
            {
              itemId: "t1:img:0",
              kind: "image",
              overview: "山",
              path: "landscapes/one.png",
              thumb: { mime: "image/jpeg", dataBase64: "dGh1bWI=", width: 128, height: 64 },
            },
          ],
        },
      ],
    };
    const built = buildForwardCapsule(
      source,
      messages,
      rounds,
      { layers: { "r-001": [imageTrunk.summary] }, trunks: { "r-001:0": imageTrunk }, blobs: {} },
      baseOptions,
    );
    expect(built.text).toContain("![山](data:image/jpeg;base64,dGh1bWI=)");
    expect(built.imageAttachments).toEqual([
      { name: "one.png", mime: "image/jpeg", dataBase64: "dGh1bWI=" },
    ]);
  });
});

describe("attributeRounds", () => {
  it("按 round 的 userItemId 边界归属选中消息", () => {
    const items = [{ id: "u1" }, { id: "a1" }, { id: "u2" }, { id: "a2" }];
    const rounds = [round("r-001", "u1", 1000), round("r-002", "u2", 2000)];
    const { roundIdByItem, involved } = attributeRounds(items, rounds, new Set(["a1", "a2"]));
    expect(roundIdByItem.get("a1")).toBe("r-001");
    expect(roundIdByItem.get("a2")).toBe("r-002");
    expect(involved.map((entry) => entry.roundId)).toEqual(["r-001", "r-002"]);
  });

  it("round 之前的消息没有归属", () => {
    const items = [{ id: "u0" }, { id: "u1" }];
    const rounds = [round("r-001", "u1", 1000)];
    const { roundIdByItem, involved } = attributeRounds(items, rounds, new Set(["u0"]));
    expect(roundIdByItem.has("u0")).toBe(false);
    expect(involved).toEqual([]);
  });
});

describe("splitForwardMessage", () => {
  it("folds every capsule in one message, not only the first", () => {
    const text = [
      "<genehub-chat-history>",
      "Source session: s-1",
      "Selection: 1 messages",
      "</genehub-chat-history>",
      "",
      "<genehub-chat-history>",
      "Source session: s-2",
      "Selection: 2 messages",
      "</genehub-chat-history>",
      "",
      "请一起看",
    ].join("\n");
    const parts = splitForwardMessage(text);
    expect(parts.map((part) => part.kind)).toEqual(["forward", "forward", "text"]);
    expect(parts[0]).toMatchObject({ info: { sourceSessionId: "s-1", messageCount: 1 } });
    expect(parts[1]).toMatchObject({ info: { sourceSessionId: "s-2", messageCount: 2 } });
    expect(parts[2]).toMatchObject({ text: "请一起看" });
  });

  it("names the session after every source, not the envelope tag or the user's own line", () => {
    const text = [
      "<genehub-chat-history>",
      "Source session: s-1",
      "Source title: 坦克复盘",
      "</genehub-chat-history>",
      "",
      "<genehub-chat-history>",
      "Source session: s-2",
      "</genehub-chat-history>",
      "",
      "说的啥？",
    ].join("\n");
    expect(forwardedSessionTitle(text)).toBe("转发自「坦克复盘」、「s-2」");
    expect(forwardedSessionTitle("说的啥？")).toBeNull();
  });
});

describe("estimateTokens", () => {
  it("与 daemon 同式：chars/4 向上取整", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});
