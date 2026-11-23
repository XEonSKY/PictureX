import { ApiError } from '../hono/problem';
import { getPixivAccessToken, refreshPixivAccessToken } from './auth';
import { pixivApiHeaders, pixivApiUrl, pixivRequestBuffer } from './http';
import { notePixivRateLimit, notePixivRequestSuccess, waitForPixivRequestSlot } from './rate-limit';
import type { PixivIllust, PixivPage, PixivPageUrls, PixivTag, PixivUgoira } from './types';

const RETRY_DELAYS_MS = [400, 1200];

/** 429 限流：带上 Retry-After，供后台任务暂停后自动续跑 */
export class PixivRateLimitError extends ApiError {
    constructor(
        message: string,
        public readonly retryAfterMs: number,
    ) {
        super(429, 'pixiv_rate_limited', message);
    }
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stripCaption(raw: string): string {
    return raw
        .replace(/<br\s*\/?>/giu, '\n')
        .replace(/<[^>]+>/gu, '')
        .replace(/&amp;/gu, '&')
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"')
        .replace(/&#0*39;/gu, '\'')
        .replace(/&#x0*27;/giu, '\'')
        .trim()
        .slice(0, 20_000);
}

function parseError(body: Buffer): string {
    try {
        const payload = record(JSON.parse(body.toString('utf8')) as unknown);
        const errors = record(payload.errors);
        const system = record(errors.system);

        return text(system.message) || text(payload.error) || text(payload.message);
    }
    catch {
        return '';
    }
}

async function requestApi(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const params = new URLSearchParams(query);
    const url = `${pixivApiUrl(path)}${params.size > 0 ? `?${params.toString()}` : ''}`;
    let token = await getPixivAccessToken();
    let refreshed = false;
    let attempt = 0;

    while (true) {
        try {
            await waitForPixivRequestSlot();
            const response = await pixivRequestBuffer(url, {
                headers: {
                    ...pixivApiHeaders(),
                    authorization: `Bearer ${token}`,
                },
                maxBytes: 4 * 1024 * 1024,
            });
            const message = parseError(response.body);

            if (response.status >= 200 && response.status < 300) {
                notePixivRequestSuccess();

                try {
                    return JSON.parse(response.body.toString('utf8')) as unknown;
                }
                catch {
                    throw new ApiError(502, 'pixiv_api_error', 'Pixiv returned invalid JSON.');
                }
            }

            if ((response.status === 401 || response.status === 400) && /oauth/iu.test(message)) {
                if (refreshed) {
                    throw new ApiError(401, 'pixiv_auth_failed', message || 'Pixiv session expired.');
                }

                await refreshPixivAccessToken();
                token = await getPixivAccessToken();
                refreshed = true;
                continue;
            }

            if (response.status === 401 || response.status === 403) {
                throw new ApiError(
                    401,
                    'pixiv_auth_required',
                    message || 'Pixiv login is required for this content.',
                );
            }

            if (response.status === 404) {
                throw new ApiError(404, 'pixiv_illust_not_found', 'The Pixiv illustration does not exist.');
            }

            if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
                await wait(RETRY_DELAYS_MS[attempt] ?? 1200);
                attempt += 1;
                continue;
            }

            if (response.status === 429) {
                const retryAfter = Number(response.headers['retry-after'] ?? 0);
                const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : 5 * 60_000;

                notePixivRateLimit(retryAfterMs);

                throw new PixivRateLimitError(
                    message || 'Pixiv API rate limit reached.',
                    retryAfterMs,
                );
            }

            throw new ApiError(
                502,
                'pixiv_api_error',
                message || `Pixiv API returned ${response.status}.`,
            );
        }
        catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }

            if (attempt < RETRY_DELAYS_MS.length) {
                await wait(RETRY_DELAYS_MS[attempt] ?? 1200);
                attempt += 1;
                continue;
            }

            throw new ApiError(
                502,
                'pixiv_network_error',
                error instanceof Error ? error.message : 'Unable to reach Pixiv.',
            );
        }
    }
}

function parseUrls(value: unknown): PixivPageUrls {
    const urls = record(value);

    return {
        squareMedium: text(urls.square_medium),
        medium: text(urls.medium),
        large: text(urls.large),
        original: text(urls.original),
    };
}

function parsePage(raw: unknown, index: number): PixivPage {
    return {
        index,
        urls: parseUrls(record(raw).image_urls),
    };
}

function parseTags(value: unknown): PixivTag[] {
    return array(value).map((item) => {
        const tag = record(item);

        return {
            name: text(tag.name),
            translatedName: text(tag.translated_name) || null,
        };
    }).filter(tag => tag.name !== '');
}

export async function fetchPixivIllust(illustId: string): Promise<PixivIllust> {
    const payload = record(await requestApi('/v1/illust/detail', {
        illust_id: illustId,
        filter: 'for_android',
    }));
    const raw = record(payload.illust);
    const user = record(raw.user);
    const metaPages = array(raw.meta_pages);
    const pages = metaPages.map((page, index) => parsePage(page, index));

    if (pages.length === 0) {
        const single = record(raw.meta_single_page);
        const base = parseUrls(raw.image_urls);

        pages.push({
            index: 0,
            urls: {
                ...base,
                original: text(single.original_image_url) || base.large || base.medium,
            },
        });
    }

    const type = text(raw.type) || 'illust';
    let ugoira: PixivUgoira | null = null;

    if (type === 'ugoira') {
        try {
            ugoira = await fetchPixivUgoira(illustId);
        }
        catch {
            // 动图元数据失败不阻断静态信息展示
            ugoira = null;
        }
    }

    return {
        illustId: String(raw.id ?? illustId),
        title: text(raw.title) || illustId,
        type,
        caption: stripCaption(text(raw.caption)),
        userId: String(user.id ?? ''),
        userName: text(user.name),
        userAccount: text(user.account),
        pageCount: numberValue(raw.page_count, pages.length) || pages.length,
        width: nullableNumber(raw.width),
        height: nullableNumber(raw.height),
        xRestrict: numberValue(raw.x_restrict),
        sanityLevel: numberValue(raw.sanity_level),
        illustAiType: numberValue(raw.illust_ai_type),
        createDate: text(raw.create_date) || null,
        totalView: numberValue(raw.total_view),
        totalBookmarks: numberValue(raw.total_bookmarks),
        tags: parseTags(raw.tags),
        pages,
        ugoira,
    };
}

export async function fetchPixivUgoira(illustId: string): Promise<PixivUgoira> {
    const payload = record(await requestApi('/v1/ugoira/metadata', { illust_id: illustId }));
    const metadata = record(payload.ugoira_metadata);
    const zipUrls = record(metadata.zip_urls);
    const zipUrl = text(zipUrls.medium) || text(zipUrls.large);
    const frames = array(metadata.frames).map((item) => {
        const frame = record(item);

        return {
            file: text(frame.file),
            delay: numberValue(frame.delay, 100),
        };
    }).filter(frame => frame.file !== '');

    if (zipUrl === '') {
        throw new ApiError(404, 'pixiv_ugoira_unavailable', 'Pixiv did not return an ugoira archive.');
    }

    return { zipUrl, frames };
}

export async function testPixivConnection(): Promise<void> {
    await requestApi('/v1/trending-tags/illust', { filter: 'for_android' });
}
