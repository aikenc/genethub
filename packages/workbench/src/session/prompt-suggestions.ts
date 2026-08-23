/**
 * Openings for a conversation that has not started yet.
 *
 * An empty composer under the words "描述任务…" is the hardest moment in the
 * product: everything the Agent can do is available and none of it is visible.
 * These are examples of the shape of a good first message — a place in the
 * repository plus what to do about it — not a menu of supported features.
 *
 * They are a fixed list today. The Agent is the one that will eventually write
 * them, from the workspace actually selected, which is why the panel asks for
 * them through {@link pickPromptSuggestions} instead of reading an array: when
 * the source becomes a request to the daemon, the caller does not change.
 */
const POOL = [
  "介绍一下这个工作区的整体结构，从入口开始讲",
  "这个仓库最近一次改动做了什么？",
  "找出最近改动最频繁的几个文件，说说它们为什么不稳定",
  "有哪些测试是常年跳过或者被注释掉的？",
  "跑一遍测试，把失败的那几个说清楚",
  "找找看有没有没被任何地方引用的死代码",
  "这个工作区的依赖有哪些已经很久没更新了？",
  "把 README 按现在的代码实际情况校一遍",
  "看看错误处理有没有把异常吞掉的地方",
  "帮我理一遍这个工作区的构建和发布流程",
  "有没有重复实现了两遍的逻辑？",
  "从性能角度看，哪一段最值得先优化？",
  "检查一下有没有硬编码的密钥、令牌或者内网地址",
  "新人接手这个仓库，最容易踩的坑是什么？",
];

/** How many openings the panel offers at a time. */
export const PROMPT_SUGGESTION_COUNT = 4;

/**
 * A few openings, never the same one twice in one batch.
 *
 * `random` is a parameter so a test can ask for a known draw; production passes
 * nothing and gets `Math.random`.
 */
export function pickPromptSuggestions(
  count = PROMPT_SUGGESTION_COUNT,
  random: () => number = Math.random,
  pool: readonly string[] = POOL,
): string[] {
  const remaining = [...pool];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const index = Math.min(remaining.length - 1, Math.floor(random() * remaining.length));
    picked.push(remaining.splice(index, 1)[0]!);
  }
  return picked;
}
