import { retryDelaySeconds } from './backoff';

describe('retryDelaySeconds', () => {
  it('doubles from 5 seconds, within the jitter range', () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(3); // 5/2 rounded
    expect(retryDelaySeconds(1, () => 1)).toBe(5);
    expect(retryDelaySeconds(2, () => 1)).toBe(10);
    expect(retryDelaySeconds(4, () => 1)).toBe(40);
  });

  it('spends 5 to 11 minutes between the default 8 attempts', () => {
    const total = (r: () => number) =>
      [1, 2, 3, 4, 5, 6, 7].reduce((s, a) => s + retryDelaySeconds(a, r), 0);
    expect(total(() => 0)).toBe(318);
    expect(total(() => 1)).toBe(635);
  });

  it('never waits more than 30 minutes', () => {
    expect(retryDelaySeconds(50, () => 1)).toBe(1800);
    expect(retryDelaySeconds(50, () => 0)).toBe(900);
  });

  it('always waits at least half the base delay', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const min = retryDelaySeconds(attempt, () => 0);
      const max = retryDelaySeconds(attempt, () => 1);
      expect(max).toBeGreaterThanOrEqual(min);
      expect(min).toBeGreaterThanOrEqual(Math.floor(max / 2));
    }
  });
});
