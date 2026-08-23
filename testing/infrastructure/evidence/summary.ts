import type { GateName, RunManifest, UnitResult } from "../types.ts";

export type SummaryLanguage = "en" | "zh-CN";

const CHINESE_STATUS: Record<RunManifest["status"], string> = {
  passed: "通过",
  failed: "失败",
  blocked: "阻塞",
  unstable: "不稳定",
  interrupted: "已中断",
};

const CHINESE_GATE: Partial<Record<GateName, string>> = {
  change: "变更门禁",
  merge: "合并门禁",
  dev: "开发发布门禁",
  beta: "Beta 发布门禁",
  stable: "Stable 发布门禁",
};

export function parseSummaryLanguage(value: string): SummaryLanguage {
  if (!value || value === "en") return "en";
  if (value === "zh-CN") return value;
  throw new Error(`unsupported summary language: ${value}; expected en or zh-CN`);
}

export function renderRunSummary(input: {
  manifest: RunManifest;
  failed: UnitResult[];
  slowest: UnitResult[];
  runDir: string;
  language?: SummaryLanguage;
}): string {
  const { manifest, failed, slowest, runDir } = input;
  const language = input.language ?? "en";
  const problems = failed.map((item) => `  - ${item.caseId} ${item.status} ${item.message ?? ""}`).join("\n");
  const durations = slowest.map((item) => `${item.caseId} ${item.durationMs}ms`).join(", ");
  if (language === "zh-CN") {
    return [
      `# ${CHINESE_STATUS[manifest.status]} · ${CHINESE_GATE[manifest.gate] ?? manifest.gate}`,
      "",
      `- Open 仓库：${manifest.open.sha}${manifest.open.dirty ? "（有未提交变更）" : ""}`,
      `- Cloud 仓库：${manifest.cloud.sha}${manifest.cloud.dirty ? "（有未提交变更）" : ""}`,
      `- 测试产物：${manifest.artifact.hash ?? "缺失"}`,
      `- 用例统计：${JSON.stringify(manifest.counts)}`,
      `- 资格判定：${manifest.qualification.qualified ? "符合" : "不符合"}`,
      failed.length ? `- 发现问题：\n${problems}` : "- 发现问题：无",
      `- 最慢用例：${durations}`,
      `- 深入查看：testctl inspect --run ${runDir}`,
      "",
    ].join("\n");
  }
  return [
    `# ${manifest.status.toUpperCase()} · ${manifest.gate}`,
    "",
    `- open: ${manifest.open.sha}${manifest.open.dirty ? " dirty" : ""}`,
    `- cloud: ${manifest.cloud.sha}${manifest.cloud.dirty ? " dirty" : ""}`,
    `- artifact: ${manifest.artifact.hash ?? "missing"}`,
    `- counts: ${JSON.stringify(manifest.counts)}`,
    `- qualified: ${manifest.qualification.qualified}`,
    failed.length ? `- problems:\n${problems}` : "- problems: none",
    `- slowest: ${durations}`,
    `- inspect: testctl inspect --run ${runDir}`,
    "",
  ].join("\n");
}
