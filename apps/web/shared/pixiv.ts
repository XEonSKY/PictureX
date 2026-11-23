/**
 * Pixiv `illust_ai_type` 取值：
 * 0 = 未设置/未知，1 = 非 AI，2 = AI 生成。
 * 不能使用 `> 0`，否则普通作品也会被标成 AI。
 */
export function isPixivAiGenerated(illustAiType: number | null | undefined): boolean {
    return illustAiType === 2;
}

export function formatPixivDisplayName(title: string, pageIndex: number, pageCount: number): string {
    return pageCount > 1 ? `${title} · p${pageIndex + 1}` : title;
}

export type PixivAutoFetchSpeed = 'slow' | 'normal' | 'fast';
export type PixivAutoFetchAlbumState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';

export interface PixivAutoFetchAlbumStatusDto {
    albumId: string
    albumName: string
    status: PixivAutoFetchAlbumState
    total: number
    processed: number
    network: number
    backfilled: number
    fresh: number
    failed: number
    deleted: number
    noToken: number
    currentIllustId: string | null
    startedAt: string
    updatedAt: string
    /** 限流/连续失败暂停后的自动续跑时间；空字符串表示不续跑 */
    retryAt: string
    elapsedMs: number
    error: string
}

export interface PixivAutoFetchQueueItemDto {
    albumId: string
    albumName: string
}

export interface PixivAutoFetchStatusDto {
    running: boolean
    /** 用户手动暂停；重启后仍然生效 */
    paused: boolean
    speed: PixivAutoFetchSpeed
    queued: PixivAutoFetchQueueItemDto[]
    albums: PixivAutoFetchAlbumStatusDto[]
}

export interface PixivAutoFetchTriggerResult {
    queued: number
    status: PixivAutoFetchStatusDto
}

export interface PixivTagNameLike {
    name: string
    translatedName?: string | null
}

const KANA = /[\u3040-\u30ff]/u;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const LATIN = /[A-Za-z]/u;

function isLatin(value: string): boolean {
    return LATIN.test(value) && !KANA.test(value) && !HAN.test(value);
}

function isChinese(value: string): boolean {
    return HAN.test(value) && !KANA.test(value);
}

function isJapanese(value: string): boolean {
    return KANA.test(value);
}

/**
 * 同步到相册标签时选择显示名：英文 > 中文 > 日文。
 * 译名优先于原名；都不匹配时回退原名。
 */
export function pickPixivTagName(tag: PixivTagNameLike): string {
    const candidates = [...new Set([
        tag.translatedName?.trim() ?? '',
        tag.name.trim(),
    ].filter(Boolean))];

    const english = candidates.find(isLatin);
    const chinese = candidates.find(isChinese);
    const japanese = candidates.find(isJapanese);

    return english ?? chinese ?? japanese ?? candidates[0] ?? '';
}
