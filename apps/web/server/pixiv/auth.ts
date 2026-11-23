import { ApiError } from '../hono/problem';
import { getSettings, updateSettings } from '../settings/setting-store';
import { pixivApiHeaders, pixivOauthUrl, pixivRequestBuffer } from './http';
import type { PixivStatusDto } from './types';

/**
 * Pixiv OAuth（App API）。
 * 只支持 refresh token 登录：用户在 Pixiv 网页登录后把 token 粘贴到设置页。
 * 仅持久化 refresh token 与账号展示信息，access token 只留内存并按 expires_in 刷新。
 */

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';

interface PixivTokenResponse {
    accessToken: string
    refreshToken: string
    expiresIn: number
    userId: string
    userName: string
    account: string
    premium: boolean
}

interface Session {
    accessToken: string
    refreshToken: string
    expiresAt: number
}

let session: Session | null = null;
let refreshing: Promise<PixivTokenResponse> | null = null;
/** 登出/重新登录时递增，阻止在途刷新把旧令牌重新写回设置 */
let authGeneration = 0;

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseTokenResponse(body: Buffer, status: number): PixivTokenResponse {
    let payload: unknown;

    try {
        payload = JSON.parse(body.toString('utf8'));
    }
    catch {
        payload = null;
    }

    if (status < 200 || status >= 300) {
        const errors = record(record(payload).errors);
        const system = record(errors.system);
        const message = text(system.message) || text(record(payload).error) || 'Pixiv authentication failed.';

        throw new ApiError(401, 'pixiv_auth_failed', message);
    }

    const response = record(record(payload).response ?? payload);
    const user = record(response.user);
    const accessToken = text(response.access_token);
    const refreshToken = text(response.refresh_token);

    if (accessToken === '' || refreshToken === '') {
        throw new ApiError(401, 'pixiv_auth_failed', 'Pixiv returned an incomplete token response.');
    }

    return {
        accessToken,
        refreshToken,
        expiresIn: numberValue(response.expires_in, 3600),
        userId: String(user.id ?? ''),
        userName: text(user.name),
        account: text(user.account),
        premium: user.is_premium === true,
    };
}

async function requestToken(form: URLSearchParams): Promise<PixivTokenResponse> {
    let response: Awaited<ReturnType<typeof pixivRequestBuffer>>;

    try {
        response = await pixivRequestBuffer(pixivOauthUrl('/auth/token'), {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                ...pixivApiHeaders(),
            },
            body: form.toString(),
            timeoutMs: 30_000,
            maxBytes: 2 * 1024 * 1024,
        });
    }
    catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }

        throw new ApiError(
            502,
            'pixiv_network_error',
            error instanceof Error ? error.message : 'Unable to reach Pixiv OAuth.',
        );
    }

    return parseTokenResponse(response.body, response.status);
}

function persistAccount(token: PixivTokenResponse): void {
    updateSettings({
        pixiv: {
            refreshToken: token.refreshToken,
            accountId: token.userId,
            accountName: token.userName,
            account: token.account,
            premium: token.premium,
        },
    });
}

function applyToken(token: PixivTokenResponse): Session {
    const next: Session = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date.now() + Math.max(60, token.expiresIn - 60) * 1000,
    };

    session = next;
    persistAccount(token);

    return next;
}

async function refresh(): Promise<PixivTokenResponse> {
    const stored = getSettings().pixiv;

    if (stored.refreshToken === '') {
        throw new ApiError(401, 'pixiv_auth_required', 'Pixiv login is required.');
    }

    const form = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        include_policy: 'true',
    });

    return requestToken(form);
}

function applyRefreshedToken(
    token: PixivTokenResponse,
    generation: number,
    expectedRefreshToken: string,
): PixivTokenResponse {
    const current = getSettings().pixiv.refreshToken;

    // 登出、重新登录或设置页更换令牌后，在途刷新结果必须丢弃
    if (generation !== authGeneration || current === '' || current !== expectedRefreshToken) {
        throw new ApiError(401, 'pixiv_auth_required', 'Pixiv login is required.');
    }

    applyToken(token);

    return token;
}

function refreshOnce(): Promise<PixivTokenResponse> {
    if (refreshing) {
        return refreshing;
    }

    const generation = authGeneration;
    const expected = getSettings().pixiv.refreshToken;
    const task = refresh().then(token => applyRefreshedToken(token, generation, expected));

    refreshing = task;
    void task
        .finally(() => {
            if (refreshing === task) {
                refreshing = null;
            }
        })
        .catch(() => undefined);

    return task;
}

export async function getPixivAccessToken(): Promise<string> {
    const stored = getSettings().pixiv;

    if (stored.refreshToken === '') {
        session = null;

        throw new ApiError(401, 'pixiv_auth_required', 'Pixiv login is required.');
    }

    // 设置页更换/清空 token 后，旧内存会话立即失效
    if (session && session.refreshToken !== stored.refreshToken) {
        session = null;
    }

    if (session && session.expiresAt > Date.now()) {
        return session.accessToken;
    }

    const token = await refreshOnce();

    return token.accessToken;
}

export async function refreshPixivAccessToken(): Promise<void> {
    await refreshOnce();
}

export async function loginWithRefreshToken(refreshToken: string): Promise<PixivStatusDto> {
    const generation = ++authGeneration;

    session = null;
    refreshing = null;

    const token = await requestToken(new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken.trim(),
        include_policy: 'true',
    }));

    // 登录请求期间用户已登出/再次登录：不要再写回令牌
    if (generation !== authGeneration) {
        throw new ApiError(401, 'pixiv_auth_required', 'Pixiv login is required.');
    }

    applyToken(token);

    return pixivStatus();
}

export function logoutPixiv(): void {
    authGeneration += 1;
    session = null;
    refreshing = null;

    updateSettings({
        pixiv: {
            refreshToken: '',
            accountId: '',
            accountName: '',
            account: '',
            premium: false,
        },
    });
}

export function pixivStatus(): PixivStatusDto {
    const pixiv = getSettings().pixiv;

    return {
        configured: pixiv.refreshToken !== '',
        accountId: pixiv.accountId,
        accountName: pixiv.accountName,
        account: pixiv.account,
        premium: pixiv.premium,
        networkMode: pixiv.networkMode,
    };
}

export function resetPixivSessionForTests(): void {
    authGeneration += 1;
    session = null;
    refreshing = null;
}
