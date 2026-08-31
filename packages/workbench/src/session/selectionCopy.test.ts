import { describe, expect, it } from "vitest";

import { buildSelectionCopy, COPY_SOFT_LIMIT_CHARS } from "./selectionCopy";

describe("buildSelectionCopy", () => {
  it("按时间序渲染角色与时间，附件只列名", () => {
    // Local-time construction keeps the clock assertions timezone-independent.
    const local = (hour: number, minute = 0) => new Date(2026, 7, 27, hour, minute).getTime();
    const built = buildSelectionCopy(
      {
        sessionId: "s-1",
        agentLabel: "Codex",
        spanMs: { start: local(9), end: local(18) },
      },
      [
        {
          id: "u1",
          role: "user",
          text: "看一下这个报错",
          attachments: [{ name: "shot.png", mime: "image/png" }],
          atMs: local(14, 2),
        },
        {
          id: "a1",
          role: "assistant",
          text: "是配置问题。",
          attachments: [],
          atMs: local(14, 3),
        },
      ],
    );
    expect(built.exceedsSoftLimit).toBe(false);
    expect(built.text).toContain("# 转发自 GeneHub 会话");
    expect(built.text).toContain("源会话：s-1 · Codex");
    expect(built.text).toContain("共 2 条");
    expect(built.text).toContain("## 用户 · 2026-08-27 14:02");
    expect(built.text).toContain("看一下这个报错");
    expect(built.text).toContain("[附件：shot.png（image/png）]");
    expect(built.text).toContain("## 助手 · 2026-08-27 14:03");
    expect(built.text.indexOf("## 用户")).toBeLessThan(built.text.indexOf("## 助手"));
  });

  it("把未写入助手正文的汇总图补成 markdown 图片链接", () => {
    const built = buildSelectionCopy(
      { sessionId: "s-1", agentLabel: "Codex", spanMs: null },
      [
        {
          id: "a1",
          role: "assistant",
          text: "画好了。",
          attachments: [],
          atMs: null,
          gallery: [
            { alt: "山", path: ".genethub/sessions/s1/images/aa.png" },
            { alt: "海", path: ".genethub/sessions/s1/images/bb.png" },
          ],
        },
      ],
    );
    expect(built.text).toContain("画好了。");
    expect(built.text).toContain("![山](.genethub/sessions/s1/images/aa.png)");
    expect(built.text).toContain("![海](.genethub/sessions/s1/images/bb.png)");
  });

  it("prefers an inlined thumb data URL over the workspace path", () => {
    const built = buildSelectionCopy(
      { sessionId: "s-1", agentLabel: "Codex", spanMs: null },
      [
        {
          id: "a1",
          role: "assistant",
          text: "画好了。",
          attachments: [],
          atMs: null,
          gallery: [
            {
              alt: "山",
              path: ".genethub/sessions/s1/images/aa.png",
              dataUrl: "data:image/jpeg;base64,dGh1bWI=",
            },
          ],
        },
      ],
    );
    expect(built.text).toContain("![山](data:image/jpeg;base64,dGh1bWI=)");
    expect(built.text).not.toContain(".genethub/sessions/s1/images/aa.png");
  });

  it("超过软上限时标记，由调用方提示", () => {
    const built = buildSelectionCopy(
      { sessionId: "s-1", agentLabel: null, spanMs: null },
      [
        {
          id: "a1",
          role: "assistant",
          text: "长".repeat(COPY_SOFT_LIMIT_CHARS),
          attachments: [],
          atMs: null,
        },
      ],
    );
    expect(built.exceedsSoftLimit).toBe(true);
    expect(built.text).toContain("未知 Agent");
    expect(built.text).toContain("时间未知");
  });
});
