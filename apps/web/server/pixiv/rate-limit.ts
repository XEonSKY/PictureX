/**
 * Pixiv API 全局限流规避：
 * - 所有 API 请求经过同一个最小间隔闸门，避免自动补全与详情页请求叠加成突发；
 * - 收到 429 后记录惩罚窗口，后续请求整体降速，并在连续成功后逐步恢复。
 */

const BASE_INTERVAL_MS = 150;
const JITTER_MS = 100;
const MAX_PENALTY_FACTOR = 4;
const SUCCESSES_TO_DECAY = 30;

let nextAllowedAt = 0;
let penaltyUntil = 0;
let penaltyFactor = 1;
let successesSincePenalty = 0;

/** 仅测试用：清空闸门与惩罚窗口，避免一个 429 用例拖慢后续请求 */
export function resetPixivRateLimitForTests(): void {
    nextAllowedAt = 0;
    penaltyUntil = 0;
    penaltyFactor = 1;
    successesSincePenalty = 0;
}

export function notePixivRateLimit(retryAfterMs: number): void {
    penaltyFactor = Math.min(MAX_PENALTY_FACTOR, Math.max(2, penaltyFactor * 2));
    penaltyUntil = Math.max(
        penaltyUntil,
        Date.now() + Math.max(30_000, Math.min(retryAfterMs, 30 * 60_000)),
    );
    successesSincePenalty = 0;
}

export function notePixivRequestSuccess(): void {
    successesSincePenalty += 1;

    if (successesSincePenalty >= SUCCESSES_TO_DECAY && penaltyFactor > 1) {
        penaltyFactor = Math.max(1, penaltyFactor / 2);
        successesSincePenalty = 0;
    }
}

/** 当前降速倍数：自动补全把它乘到每个作品的间隔上 */
export function pixivRatePenaltyFactor(): number {
    return penaltyFactor;
}

/** 请求闸门：距离上次请求不足最小间隔（或处于 429 惩罚窗口）时等待 */
export async function waitForPixivRequestSlot(): Promise<void> {
    const now = Date.now();
    const target = Math.max(nextAllowedAt, penaltyUntil);
    const waitMs = Math.max(0, target - now);
    const interval = BASE_INTERVAL_MS * penaltyFactor + Math.floor(Math.random() * JITTER_MS);

    nextAllowedAt = Math.max(now, target) + interval;

    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
}
