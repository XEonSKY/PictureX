import { findRegisteredAlbum } from '../../album/album-registry';
import { holdAlbumDatabase } from '../../database/album';
import { getSettings } from '../../settings/setting-store';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

const ALBUM_PATH = /^\/albums\/([^/]+)/u;

/** 响应体读完/取消后再释放，避免文件或 NDJSON 仍在流式读取时关库 */
function releaseWhenDone(
    body: ReadableStream<Uint8Array>,
    release: () => void,
): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let released = false;
    const done = (): void => {
        if (!released) {
            released = true;
            release();
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read();

                if (result.done) {
                    done();
                    controller.close();

                    return;
                }

                controller.enqueue(result.value);
            }
            catch (error) {
                done();
                controller.error(error);
            }
        },
        async cancel(reason) {
            done();

            return reader.cancel(reason);
        },
    });
}

/**
 * 相册路由的请求级短引用：请求在 await 期间（磁盘读取、外部请求）可能还在使用
 * handle，期间删除相册或空闲巡检不得关闭连接。
 *
 * 删除相册本身的请求不持有引用，否则 deleteAlbum 永远看到 album_busy。
 * 登记表异常交给路由给出明确错误，这里只当没有引用。
 */
export function albumRequestScope(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const albumId = ALBUM_PATH.exec(c.req.path)?.[1] ?? '';
        const isDeleteAlbum = albumId !== '' && c.req.method === 'DELETE' && c.req.path === `/albums/${albumId}`;
        let release: (() => void) | null = null;

        if (albumId !== '' && !isDeleteAlbum) {
            try {
                const entry = findRegisteredAlbum(getSettings(), albumId);

                if (entry) {
                    release = holdAlbumDatabase(entry.dir);
                }
            }
            catch {
                // 登记表损坏/读取失败由路由层报错，这里不引入新的失败点
            }
        }

        try {
            await next();

            const response = c.res;
            const contentType = response.headers.get('content-type') ?? '';

            // SSE 是长连接，但建立后不再使用相册连接；其余响应体要等客户端读完
            if (release && response.body && !contentType.startsWith('text/event-stream')) {
                const releaseAfterBody = release;
                release = null;
                c.res = new Response(releaseWhenDone(response.body, releaseAfterBody), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }
        }
        finally {
            release?.();
        }
    };
}
