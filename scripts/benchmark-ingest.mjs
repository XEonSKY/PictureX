#!/usr/bin/env node
/**
 * 入库基准：生成 N 张唯一 PNG（同一图像 + 唯一 tEXt 块），通过 HTTP API 建相册并扫描，
 * 记录吞吐、峰值 RSS、分区分布、数据根目录缩略图库大小与相似分组耗时。
 *
 *   pnpm dev                                  # 另开终端
 *   node scripts/benchmark-ingest.mjs --count 2000
 *   node scripts/benchmark-ingest.mjs --count 100000
 *
 * 参数：--base-url http://localhost:3000  --count N  --dir <媒体目录>  --keep
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
function arg(name, fallback) {
    const index = args.indexOf(name);

    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const BASE_URL = arg('--base-url', 'http://localhost:3000');
const COUNT = Number.parseInt(arg('--count', '2000'), 10);
const MEDIA_DIR = resolve(ROOT, arg('--dir', '.dev/benchmark-media'));
const KEEP = args.includes('--keep');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

    return Buffer.concat([length, typeBuffer, data, crc]);
}

async function buildBasePng() {
    return sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: 32, g: 96, b: 200 } },
    }).png().toBuffer();
}

function uniquePng(base, index) {
    const iend = base.subarray(base.length - 12);
    const body = base.subarray(0, base.length - 12);
    const text = pngChunk('tEXt', Buffer.from(`Comment\0bench-${index}`, 'latin1'));

    return Buffer.concat([body, text, iend]);
}

async function api(path, init) {
    const response = await fetch(`${BASE_URL}/api/v1${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
        throw new Error(`${path} -> HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

function sleep(ms) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
}

async function main() {
    if (!Number.isFinite(COUNT) || COUNT < 1) {
        throw new Error('--count 必须是正整数');
    }

    process.stdout.write(`[bench] 生成 ${COUNT} 个 PNG 到 ${MEDIA_DIR}\n`);
    rmSync(MEDIA_DIR, { recursive: true, force: true });
    mkdirSync(MEDIA_DIR, { recursive: true });

    const base = await buildBasePng();
    const startedGenerate = Date.now();

    for (let index = 0; index < COUNT; index += 1) {
        writeFileSync(join(MEDIA_DIR, `bench-${String(index).padStart(6, '0')}.png`), uniquePng(base, index));
    }

    process.stdout.write(`[bench] 生成完成 ${Date.now() - startedGenerate}ms\n`);

    const albumBody = await api('/albums', {
        method: 'POST',
        body: JSON.stringify({ name: `Benchmark ${new Date().toISOString()}` }),
    });
    const album = albumBody.data;
    const started = Date.now();
    let peakRss = 0;
    let peakHeap = 0;

    const importBody = await api(`/albums/${album.id}/imports`, {
        method: 'POST',
        body: JSON.stringify({ rootPath: MEDIA_DIR }),
    });
    const jobId = importBody.data.id;

    let finished = null;

    while (!finished) {
        const [health, jobState] = await Promise.all([
            api('/health'),
            api(`/albums/${album.id}/imports/${jobId}`),
        ]);

        peakRss = Math.max(peakRss, health.memory?.rssBytes ?? 0);
        peakHeap = Math.max(peakHeap, health.memory?.heapUsedBytes ?? 0);

        if (jobState.data.status === 'completed' || jobState.data.status === 'failed') {
            finished = jobState.data;
        }
        else {
            await sleep(250);
        }
    }

    const elapsedMs = Date.now() - started;
    const settings = await api('/settings');
    const albumsRoot = settings.data.albumsRoot;
    const dataDir = settings.meta?.dataDir ?? '';
    const albumDir = join(albumsRoot, album.id);
    const storageDir = join(albumDir, 'storage');
    const partitions = [];

    if (statSync(storageDir, { throwIfNoEntry: false })) {
        for (const entry of readdirSync(storageDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                partitions.push({
                    name: entry.name,
                    files: readdirSync(join(storageDir, entry.name)).length,
                });
            }
        }
    }

    // 缩略图库统一放在数据根目录，旧版相册内文件会在首次打开时迁移
    const thumbPath = join(dataDir, 'data', 'thumbnails.db');

    const picturePath = join(albumDir, 'data', 'picture.db');
    const dbSize = path => (statSync(path, { throwIfNoEntry: false })?.size ?? 0)
        + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0);
    const thumbsSize = dbSize(thumbPath);
    const pictureSize = dbSize(picturePath);
    const storageBytes = partitions.reduce((sum, partition) => sum + partition.files, 0) > 0
        ? readdirSync(storageDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .reduce((sum, entry) => {
                const dir = join(storageDir, entry.name);

                return sum + readdirSync(dir).reduce((inner, file) => inner + statSync(join(dir, file)).size, 0);
            }, 0)
        : 0;

    const similarStarted = Date.now();
    const similar = await api(`/albums/${album.id}/groups/similar?threshold=8&limit=50`);
    const similarMs = Date.now() - similarStarted;

    const report = {
        generatedAt: new Date().toISOString(),
        count: COUNT,
        elapsedMs,
        filesPerSecond: Number(((finished.processed / elapsedMs) * 1000).toFixed(1)),
        import: {
            status: finished.status,
            total: finished.total,
            processed: finished.processed,
            added: finished.added,
            duplicates: finished.duplicates,
            skipped: finished.skipped,
            errors: finished.errors,
        },
        peakRssBytes: peakRss,
        peakHeapBytes: peakHeap,
        partitions: partitions.sort((a, b) => a.name.localeCompare(b.name)),
        storageBytes,
        pictureDbBytes: pictureSize,
        thumbnailsDbBytes: thumbsSize,
        similarGroups: similar.data.length,
        similarMs,
        sampleGroups: similar.data.slice(0, 3).map(group => group.assets.length),
        dataDir,
    };

    const markdown = [
        '| 指标 | 数值 |',
        '|---|---|',
        `| 文件数 | ${report.count} |`,
        `| 扫描耗时 | ${(elapsedMs / 1000).toFixed(1)} s |`,
        `| 吞吐 | ${report.filesPerSecond} files/s |`,
        `| 新增 / 重复 / 跳过 / 错误 | ${finished.added} / ${finished.duplicates} / ${finished.skipped} / ${finished.errors} |`,
        `| 峰值 RSS | ${formatBytes(peakRss)} |`,
        `| 峰值堆 | ${formatBytes(peakHeap)} |`,
        `| 分区数 | ${partitions.length} |`,
        `| storage 大小 | ${formatBytes(storageBytes)} |`,
        `| picture.db | ${formatBytes(pictureSize)} |`,
        `| thumbnails.db | ${formatBytes(thumbsSize)} |`,
        `| 相似分组耗时 | ${similarMs} ms（${similar.data.length} 组） |`,
    ].join('\n');

    process.stdout.write(`\n${markdown}\n\n`);
    writeFileSync(join(ROOT, '.dev', 'benchmark-report.json'), `${JSON.stringify(report, null, 4)}\n`);
    process.stdout.write('[bench] 报告已写入 .dev/benchmark-report.json\n');

    if (!KEEP) {
        await api(`/albums/${album.id}`, { method: 'DELETE' }).catch(() => undefined);
        rmSync(MEDIA_DIR, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`[bench] 失败: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
});
