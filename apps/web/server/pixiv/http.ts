import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../hono/problem';
import { getSettings } from '../settings/setting-store';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

/**
 * Pixiv HTTP 客户端。
 * - direct：走系统网络；
 * - proxy：经 HTTP CONNECT 或 SOCKS5 代理，再按目标协议建立 TLS。
 *
 * API / OAuth 基础地址可用 PX_PIXIV_API_BASE / PX_PIXIV_OAUTH_BASE 覆盖（测试与自建镜像）。
 */

const HASH_SALT = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
const API_HOST = 'app-api.pixiv.net';
const OAUTH_HOST = 'oauth.secure.pixiv.net';
const IMAGE_HOSTS = new Set(['i.pximg.net', 's.pximg.net']);

/**
 * 直连复用连接：代理模式每个请求都要单独建隧道，无法复用；
 * 直连时 keep-alive 能省掉每次 API 请求的 TCP + TLS 握手（批量补全时耗时占比很高）。
 * Agent 的空闲 socket 由 Node 内部 unref，不会阻止进程退出。
 */
const keepAliveAgents = {
    'https:': new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: 8,
        timeout: 30_000,
        scheduling: 'lifo',
    }),
    'http:': new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: 8,
        timeout: 30_000,
        scheduling: 'lifo',
    }),
};

function trimBase(value: string): string {
    return value.trim().replace(/\/+$/u, '');
}

export function pixivApiBase(): string {
    return trimBase(process.env.PX_PIXIV_API_BASE ?? `https://${API_HOST}`);
}

export function pixivOauthBase(): string {
    return trimBase(process.env.PX_PIXIV_OAUTH_BASE ?? `https://${OAUTH_HOST}`);
}

export function pixivApiUrl(path: string): string {
    return `${pixivApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function pixivOauthUrl(path: string): string {
    return `${pixivOauthBase()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function pixivTime(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/u, '+00:00');
}

function clientHash(time: string): string {
    return createHash('md5').update(time + HASH_SALT, 'utf8').digest('hex');
}

export function pixivApiHeaders(): Record<string, string> {
    const time = pixivTime();

    return {
        'x-client-time': time,
        'x-client-hash': clientHash(time),
        'user-agent': 'PixivAndroidApp/5.0.166 (Android 10.0; Pixel C)',
        'accept-language': 'zh-CN',
        'app-os': 'Android',
        'app-os-version': 'Android 10.0',
        'app-version': '5.0.166',
    };
}

export function pixivImageHeaders(): Record<string, string> {
    return {
        // i.pximg.net 必须带 Pixiv 来源，否则 403
        'referer': 'https://app-api.pixiv.net/',
        'user-agent': 'PixivAndroidApp/5.0.166 (Android 10.0; Pixel C)',
    };
}

export function isAllowedPixivImageUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        const extra = new Set(
            (process.env.PX_PIXIV_IMAGE_HOSTS ?? '')
                .split(',')
                .map(value => value.trim().toLowerCase())
                .filter(Boolean),
        );
        const host = url.hostname.toLowerCase();
        const allowedHost = IMAGE_HOSTS.has(host) || extra.has(host);
        // http 只允许显式白名单主机（测试/自建镜像）；生产 Pixiv 图片必须 https
        const allowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && extra.has(host));

        return allowedHost && allowedProtocol;
    }
    catch {
        return false;
    }
}

export function assertPixivImageUrl(raw: string): URL {
    if (!isAllowedPixivImageUrl(raw)) {
        throw new ApiError(502, 'pixiv_api_error', 'Pixiv returned an image URL outside the allowed hosts.');
    }

    return new URL(raw);
}

interface ProxyTunnelOptions {
    servername: string
    rejectUnauthorized: boolean
}

function createSocketReader(socket: net.Socket): {
    read: (size: number) => Promise<Buffer>
    release: () => void
} {
    let buffer = Buffer.alloc(0);
    let pending: { size: number, resolve: (value: Buffer) => void, reject: (error: Error) => void } | null = null;

    const settle = (): void => {
        if (!pending || buffer.byteLength < pending.size) {
            return;
        }

        const value = buffer.subarray(0, pending.size);

        buffer = buffer.subarray(pending.size);
        const current = pending;

        pending = null;
        current.resolve(value);
        setTimeout(settle, 0);
    };

    const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        settle();
    };
    const onError = (error: Error): void => {
        pending?.reject(error);
        pending = null;
    };

    socket.on('data', onData);
    socket.on('error', onError);

    return {
        read: (size: number) => new Promise<Buffer>((resolve, reject) => {
            pending = { size, resolve, reject };
            settle();
        }),
        release: () => {
            socket.off('data', onData);
            socket.off('error', onError);

            if (buffer.byteLength > 0) {
                socket.unshift(buffer);
            }
            buffer = Buffer.alloc(0);
        },
    };
}

async function connectViaSocks5(
    proxyUrl: string,
    host: string,
    port: number,
    secure: boolean,
    tlsOptions: ProxyTunnelOptions,
): Promise<net.Socket> {
    const proxy = new URL(proxyUrl);
    const proxyPort = proxy.port ? Number(proxy.port) : 1080;
    const socket = net.connect({ host: proxy.hostname, port: proxyPort });

    await new Promise<void>((resolve, reject) => {
        socket.setTimeout(30_000, () => socket.destroy(new Error('Pixiv SOCKS5 connection timed out.')));
        socket.once('connect', () => resolve());
        socket.once('error', reject);
    });

    const reader = createSocketReader(socket);

    try {
        const hasAuth = proxy.username !== '';
        const greeting = hasAuth
            ? Buffer.from([0x05, 0x02, 0x00, 0x02])
            : Buffer.from([0x05, 0x01, 0x00]);

        socket.write(greeting);

        const method = await reader.read(2);

        if (method[0] !== 0x05 || method[1] === 0xff) {
            throw new Error('Pixiv SOCKS5 proxy rejected the authentication methods.');
        }

        if (method[1] === 0x02) {
            const username = Buffer.from(decodeURIComponent(proxy.username), 'utf8');
            const password = Buffer.from(decodeURIComponent(proxy.password), 'utf8');

            socket.write(Buffer.concat([
                Buffer.from([0x01, username.byteLength]),
                username,
                Buffer.from([password.byteLength]),
                password,
            ]));

            const auth = await reader.read(2);

            if (auth[1] !== 0x00) {
                throw new Error('Pixiv SOCKS5 proxy authentication failed.');
            }
        }
        else if (method[1] !== 0x00) {
            throw new Error('Pixiv SOCKS5 proxy requested an unsupported authentication method.');
        }

        const hostBytes = Buffer.from(host, 'utf8');
        const request = Buffer.alloc(7 + hostBytes.byteLength);

        request[0] = 0x05;
        request[1] = 0x01;
        request[2] = 0x00;
        request[3] = 0x03;
        request[4] = hostBytes.byteLength;
        hostBytes.copy(request, 5);
        request.writeUInt16BE(port, 5 + hostBytes.byteLength);
        socket.write(request);

        const head = await reader.read(4);

        if (head[1] !== 0x00) {
            throw new Error(`Pixiv SOCKS5 CONNECT failed with code ${head[1] ?? 0}.`);
        }

        const addressType = head[3];

        if (addressType === 0x01) {
            await reader.read(4 + 2);
        }
        else if (addressType === 0x03) {
            const length = await reader.read(1);

            await reader.read((length[0] ?? 0) + 2);
        }
        else if (addressType === 0x04) {
            await reader.read(16 + 2);
        }
        else {
            throw new Error('Pixiv SOCKS5 proxy returned an unsupported address type.');
        }

        reader.release();
    }
    catch (error) {
        reader.release();
        socket.destroy();

        throw error;
    }

    // SOCKS 握手阶段的 30s 超时不要带到后续的请求/下载
    socket.setTimeout(0);

    if (!secure) {
        return socket;
    }

    return tlsHandshake(socket, tlsOptions);
}

/** 代理隧道建立后的 TLS 握手也必须有时限，否则代理半死不活会永久卡住队列 */
function tlsHandshake(socket: net.Socket, tlsOptions: ProxyTunnelOptions): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            servername: tlsOptions.servername || undefined,
            rejectUnauthorized: tlsOptions.rejectUnauthorized,
        });
        const timer = setTimeout(() => {
            const error = new Error('Pixiv TLS handshake timed out.');

            tlsSocket.destroy(error);
            reject(error);
        }, 30_000);

        timer.unref?.();
        tlsSocket.once('secureConnect', () => {
            clearTimeout(timer);
            resolve(tlsSocket);
        });
        tlsSocket.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function connectViaHttpProxy(
    proxyUrl: string,
    host: string,
    port: number,
    secure: boolean,
    tlsOptions: ProxyTunnelOptions,
): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const proxy = new URL(proxyUrl);

        if (proxy.protocol !== 'http:') {
            reject(new Error('Only http:// proxies are supported for Pixiv.'));
            return;
        }

        const headers: Record<string, string> = {
            'host': `${host}:${port}`,
            'proxy-connection': 'keep-alive',
        };

        if (proxy.username) {
            headers['proxy-authorization'] = `Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString('base64')}`;
        }

        const request = http.request({
            host: proxy.hostname,
            port: proxy.port ? Number(proxy.port) : 80,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            agent: false,
        });

        request.setTimeout(30_000, () => request.destroy(new Error('Pixiv proxy connection timed out.')));
        request.on('connect', (response, socket, head) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Pixiv proxy CONNECT failed with ${response.statusCode ?? 0}.`));

                return;
            }

            if (head.length > 0) {
                socket.unshift(head);
            }

            socket.setTimeout(0);

            if (!secure) {
                resolve(socket);

                return;
            }

            tlsHandshake(socket, tlsOptions).then(resolve).catch(reject);
        });
        request.on('error', reject);
        request.end();
    });
}

interface RequestInput {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    timeoutMs?: number
}

export interface PixivHttpResponse {
    status: number
    headers: IncomingHttpHeaders
    stream: Readable
}

export async function pixivStream(rawUrl: string, input: RequestInput = {}): Promise<PixivHttpResponse> {
    const url = new URL(rawUrl);
    const secure = url.protocol === 'https:';
    const settings = getSettings();
    const mode = settings.pixiv.networkMode;
    const proxyUrl = settings.pixiv.proxyUrl.trim();
    const proxyMode = mode === 'proxy' && proxyUrl !== '';
    const headers: Record<string, string> = {
        host: url.host,
        ...(input.headers ?? {}),
    };
    const body = input.body === undefined
        ? undefined
        : Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');

    if (body) {
        headers['content-length'] = String(body.byteLength);
    }
    if (proxyMode) {
        // 代理隧道只能用一次，读到响应末尾就关闭，避免句柄堆积
        headers.connection = 'close';
    }

    return new Promise((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? 30_000;
        let settled = false;
        let activeRequest: http.ClientRequest | null = null;
        let activeSocket: net.Socket | null = null;
        // request.setTimeout 只覆盖 socket 空闲；DNS/代理/TLS 握手阶段还需要一个硬上限
        const hardTimer = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            const error = new Error('Pixiv request timed out.');

            activeRequest?.destroy(error);
            activeSocket?.destroy(error);
            reject(error);
        }, timeoutMs + 5000);

        hardTimer.unref?.();

        const settle = (action: () => void): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(hardTimer);
            action();
        };
        const handleError = (error: Error): void => settle(() => reject(error));
        const handleResponse = (response: http.IncomingMessage): void => {
            const socket = response.socket ?? activeSocket;
            const closeSocket = (): void => {
                socket?.destroy();
                activeSocket?.destroy();
            };

            // 只有代理隧道需要读到末尾就销毁；直连 socket 要还给 keep-alive 池复用
            if (proxyMode) {
                response.once('end', closeSocket);
                response.once('close', closeSocket);
            }
            settle(() => resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response }));
        };

        if (proxyMode && secure) {
            const tlsOptions = {
                servername: url.hostname,
                rejectUnauthorized: true,
            };
            const connect = /^socks5h?:\/\//iu.test(proxyUrl) ? connectViaSocks5 : connectViaHttpProxy;

            connect(proxyUrl, url.hostname, Number(url.port || 443), true, tlsOptions)
                .then((socket) => {
                    if (settled) {
                        socket.destroy();

                        return;
                    }

                    activeSocket = socket;
                    const request = http.request({
                        host: url.hostname,
                        port: Number(url.port || 443),
                        path: `${url.pathname}${url.search}`,
                        method: input.method ?? 'GET',
                        headers,
                        // 不能同时给 agent:false：Node 会忽略 createConnection 并重新直连
                        createConnection: () => socket,
                    });

                    activeRequest = request;
                    request.setTimeout(timeoutMs, () => request.destroy(new Error('Pixiv request timed out.')));
                    request.on('response', handleResponse);
                    request.on('error', handleError);
                    request.end(body);
                })
                .catch(handleError);

            return;
        }

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: input.method ?? 'GET',
            headers,
            agent: secure ? keepAliveAgents['https:'] : keepAliveAgents['http:'],
        };

        const request = secure
            ? https.request(options)
            : http.request(options as http.RequestOptions);

        activeRequest = request;
        activeSocket = request.socket ?? null;
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Pixiv request timed out.')));
        request.on('response', handleResponse);
        request.on('error', handleError);
        request.end(body);
    });
}

/**
 * 取 Pixiv 图片/zip 字节必须走这里：先校验 pximg 主机白名单，再合并 Referer。
 * pixivStream 本身不校验 URL（API/OAuth 也走它），新增图片调用点禁止直接用它。
 */
export async function pixivImageStream(
    rawUrl: string,
    input: RequestInput = {},
): Promise<PixivHttpResponse> {
    assertPixivImageUrl(rawUrl);

    return pixivStream(rawUrl, {
        ...input,
        headers: { ...pixivImageHeaders(), ...input.headers },
    });
}

export async function pixivRequestBuffer(
    url: string,
    input: RequestInput & { maxBytes?: number } = {},
): Promise<{ status: number, headers: IncomingHttpHeaders, body: Buffer }> {
    const response = await pixivStream(url, input);
    const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
    const declared = Number(response.headers['content-length'] ?? 0);

    if (Number.isFinite(declared) && declared > maxBytes) {
        response.stream.destroy();

        throw new ApiError(502, 'pixiv_api_error', 'Pixiv response is too large.');
    }

    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of response.stream as AsyncIterable<Buffer>) {
        total += chunk.byteLength;

        if (total > maxBytes) {
            response.stream.destroy();

            throw new ApiError(502, 'pixiv_api_error', 'Pixiv response is too large.');
        }

        chunks.push(chunk);
    }

    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

export async function pixivDownloadToFile(
    rawUrl: string,
    targetPath: string,
    input: RequestInput = {},
): Promise<number> {
    const response = await pixivImageStream(rawUrl, {
        ...input,
        timeoutMs: input.timeoutMs ?? 120_000,
    });

    if (response.status < 200 || response.status >= 300) {
        response.stream.destroy();

        throw new ApiError(502, 'pixiv_download_failed', `Pixiv image download failed with ${response.status}.`);
    }

    const declared = Number(response.headers['content-length'] ?? 0);

    if (Number.isFinite(declared) && declared > DOWNLOAD_MAX_BYTES) {
        response.stream.destroy();

        throw new ApiError(502, 'pixiv_download_failed', 'Pixiv image is too large.');
    }

    const tempPath = `${targetPath}.part`;
    let total = 0;
    const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            total += chunk.byteLength;

            if (total > DOWNLOAD_MAX_BYTES) {
                callback(new ApiError(502, 'pixiv_download_failed', 'Pixiv image is too large.'));

                return;
            }

            callback(null, chunk);
        },
    });

    try {
        await pipeline(response.stream, limiter, createWriteStream(tempPath));
        await rename(tempPath, targetPath);

        return total;
    }
    catch (error) {
        await unlink(tempPath).catch(() => undefined);

        throw error instanceof ApiError
            ? error
            : new ApiError(502, 'pixiv_download_failed', 'Failed to download a Pixiv image.');
    }
}
