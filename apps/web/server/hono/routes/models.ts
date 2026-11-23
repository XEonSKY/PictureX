import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { logger } from '../../logger';
import { modelDownloader } from '../../model/model-downloader';
import { modelReferenceGroup, modelRegistry } from '../../model/model-registry';
import type { DownloadTask } from '../../model/types';
import { getSettings } from '../../settings/setting-store';
import type { DownloadJobEvent } from '../../jobs/event-bus';
import type { AppEnv } from '../env';
import { validateJson } from '../validation';

const modelCleanupSchema = z.object({
    confirm: z.literal(true),
    mode: z.enum(['broken', 'unused']).default('unused'),
});

/** 卸载模型后必须释放已加载的 ONNX 会话，否则显存/内存要到进程重启才回收 */
function releasePipelines(modelId: string): void {
    import('../../ai/tagger')
        .then(module => module.disposeModelPipelines(modelId))
        .catch((error: unknown) => logger.warn({ err: error, modelId }, 'failed to release model pipelines'));
}

function downloadSummary(task: DownloadTask | undefined) {
    if (!task) {
        return null;
    }

    return {
        status: task.status,
        bytesDone: task.bytesDone,
        totalBytes: task.totalBytes,
        speedBps: task.speedBps,
        updatedAt: task.updatedAt,
        error: task.error,
    };
}

function toEvent(task: DownloadTask): DownloadJobEvent {
    return {
        type: 'download',
        modelId: task.modelId,
        status: task.status,
        bytesDone: task.bytesDone,
        totalBytes: task.totalBytes,
        speedBps: task.speedBps,
        updatedAt: task.updatedAt,
    };
}

function modelDto(modelId: string) {
    const registry = modelRegistry(getSettings());
    const entry = registry.get(modelId);
    const downloader = modelDownloader();

    return { ...entry, download: downloadSummary(downloader.getTask(modelId)) };
}

export const modelRoutes = new Hono<AppEnv>()
    .get('/', (c) => {
        const settings = getSettings();
        const downloader = modelDownloader();
        const models = modelRegistry(settings).list().map(entry => ({
            ...entry,
            download: downloadSummary(downloader.getTask(entry.id)),
        }));

        return c.json({ data: models });
    })
    .get('/events', (c) => {
        const downloader = modelDownloader();

        return streamSSE(c, async (stream) => {
            let closed = false;
            const lastSent = new Map<string, { at: number, status: string }>();

            await stream.writeSSE({
                event: 'snapshot',
                data: JSON.stringify(downloader.listTasks().map(toEvent)),
            });

            const unsubscribe = downloader.subscribe((tasks) => {
                const now = Date.now();

                for (const task of tasks) {
                    const previous = lastSent.get(task.modelId);

                    if (previous && previous.status === task.status && now - previous.at < 250) {
                        continue;
                    }

                    lastSent.set(task.modelId, { at: now, status: task.status });
                    stream.writeSSE({ event: 'download', data: JSON.stringify(toEvent(task)) }).catch(() => {
                        closed = true;
                    });
                }
            });

            stream.onAbort(() => {
                closed = true;
                unsubscribe();
            });

            while (!closed) {
                await stream.sleep(15_000);

                if (!closed) {
                    try {
                        await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
                    }
                    catch {
                        closed = true;
                    }
                }
            }

            unsubscribe();
        });
    })
    .post('/cleanup', validateJson(modelCleanupSchema), async (c) => {
        const { mode } = c.req.valid('json');
        const settings = getSettings();
        const registry = modelRegistry(settings);
        const downloader = modelDownloader();
        // 当前 AI 设置引用的模型不清理，避免下一次打标直接 404。
        // 基础模型与对应的 <id>-fp16 加速条目共享安装状态，保护一个就保护整组。
        const active = modelReferenceGroup([settings.ai.localModelId, settings.ai.captioningModelId]);
        const removed: string[] = [];
        const skipped: string[] = [];

        for (const entry of registry.list()) {
            // broken 只表示不可下载/不可用，不代表文件存在；
            // 从未安装的 broken 条目不应出现在 removed 里。
            const installed = ['installed', 'corrupted'].includes(entry.status)
              || entry.installedFiles.length > 0;

            if (!installed) {
                continue;
            }
            if (active.has(entry.id)) {
                skipped.push(entry.id);
                continue;
            }
            if (mode === 'broken' && !entry.broken && entry.status !== 'corrupted') {
                continue;
            }

            const task = downloader.getTask(entry.id);

            if (task && (task.status === 'downloading' || task.status === 'paused')) {
                skipped.push(entry.id);
                continue;
            }

            registry.remove(entry.id);
            releasePipelines(entry.id);
            removed.push(entry.id);
        }

        logger.info({ mode, removed, skipped }, 'model cleanup finished');

        return c.json({ data: { removed, skipped } });
    })
    .get('/:modelId', (c) => {
        return c.json({ data: modelDto(c.req.param('modelId')) });
    })
    .post('/:modelId/download', async (c) => {
        const task = await modelDownloader().start(c.req.param('modelId'));

        c.status(202);

        return c.json({ data: task });
    })
    .post('/:modelId/download/pause', async (c) => {
        const task = await modelDownloader().pause(c.req.param('modelId'));

        return c.json({ data: task });
    })
    .post('/:modelId/download/resume', async (c) => {
        const task = await modelDownloader().resume(c.req.param('modelId'));

        return c.json({ data: task });
    })
    .post('/:modelId/download/cancel', async (c) => {
        const task = await modelDownloader().cancel(c.req.param('modelId'));

        return c.json({ data: task });
    })
    .post('/:modelId/verify', async (c) => {
        const model = await modelRegistry(getSettings()).verify(c.req.param('modelId'));

        return c.json({ data: model });
    })
    .delete('/:modelId', async (c) => {
        const downloader = modelDownloader();
        const task = downloader.getTask(c.req.param('modelId'));

        if (task && (task.status === 'downloading' || task.status === 'paused')) {
            await downloader.cancel(c.req.param('modelId'));
        }

        const modelId = c.req.param('modelId');

        modelRegistry(getSettings()).remove(modelId);
        releasePipelines(modelId);

        return c.body(null, 204);
    });
