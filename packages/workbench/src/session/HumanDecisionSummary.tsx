import type { WorkflowHumanExitStatus } from "@genehub/proto";

const kinds: Record<string, string> = {
  a: "预算调整", b: "目标调整", c: "旧预算方案", d: "执行问题", e: "安装或登录", f: "交付验收",
};
const answers: Record<string, string> = {
  approve: "已批准", reject: "暂不追加", acceptScope: "已接受目标调整", keepScope: "保留当前目标", cancel: "已取消",
  confirmFeedback: "已确认反馈", keepOpen: "保留受阻需求", handled: "已处理",
  abandon: "已放弃", pass: "验收通过", fail: "验收未通过", cancelled: "已取消", interrupted: "已中止",
};

function duration(total: number) {
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (!hours && !minutes) return `${seconds} 秒`;
  if (!hours) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

export function HumanDecisionSummary({ decision }: { decision: WorkflowHumanExitStatus }) {
  return <>
    <p className="font-medium">{kinds[decision.kind] ?? "人工决定"} · {decision.answer ? answers[decision.answer] ?? "已答复" : "待答复"}</p>
    {decision.budget && <p className="mt-1">申请总上限：{decision.budget.maxLlmRounds} 次 LLM 请求，{duration(decision.budget.deadlineSeconds)}有效处理时间。</p>}
    {decision.scope && <p className="mt-1 whitespace-pre-wrap break-words">调整后目标：{decision.scope.goal}{"\n"}具体变更：{decision.scope.changes}</p>}
    <p className="mt-1 whitespace-pre-wrap break-words">{decision.reason}</p>
    {decision.effectError && <p role="alert" className="mt-1 break-words text-danger">方案未生效：{decision.effectError}</p>}
  </>;
}
