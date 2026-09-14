/** Display relative recency; retain the exact timestamp in the caller's title. */
export function relativeTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "暂无交互";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} 天前`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)} 个月前`;
  return `${Math.floor(seconds / 31536000)} 年前`;
}
