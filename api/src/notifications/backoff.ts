// Delay before retry number `attempt` (1-based): 5s, 10s, 20s, ... capped at
// 30 minutes, with "equal jitter" (half fixed, half random) so that after an
// Expo outage thousands of retries don't all fire in the same second. At the
// default 8 attempts a transport failure's last wait is 320 s; only
// provider-side errors, which don't use up attempts, reach the cap.
export function retryDelaySeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(5 * 2 ** Math.max(0, attempt - 1), 1800);
  return Math.round(base / 2 + random() * (base / 2));
}
