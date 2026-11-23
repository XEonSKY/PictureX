import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Settings } from '../settings/setting-schema';
import { describeDataDirectories } from '../utils/data-dir';
import { resolveFfmpegPath } from './ffmpeg';
import type { AssetKind } from './types';

const execFileAsync = promisify(execFile);

export interface GeneratedThumbnail {
    size: number
    mime: string
    blob: Buffer
    width: number
    height: number
}

/** 一次解码只产出调用方要的尺寸，避免为同一张图反复计算 */
async function renderWithSharp(
    source: string | Buffer,
    settings: Settings,
    sizes: number[],
    density?: number,
): Promise<GeneratedThumbnail[]> {
    const quality = settings.thumbnails.quality;
    const image = sharp(source, { animated: false, density }).rotate();

    return Promise.all(sizes.map(async (size) => {
        const { data, info } = await image
            .clone()
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            // smartSubsample 按内容自适应色度采样，照片缩小后高频细节与色彩更干净
            .webp({ quality, smartSubsample: true })
            .toBuffer({ resolveWithObject: true });

        return {
            size,
            mime: 'image/webp',
            blob: data,
            width: info.width,
            height: info.height,
        };
    }));
}

async function extractVideoFrame(path: string, settings: Settings, sizes: number[]): Promise<string | null> {
    const ffmpeg = resolveFfmpegPath(settings);

    if (!ffmpeg) {
        return null;
    }

    const cacheDir = join(describeDataDirectories().cacheDir, 'frames');

    await mkdir(cacheDir, { recursive: true });

    const dir = await mkdtemp(join(cacheDir, 'thumb-'));
    const target = join(dir, 'frame.png');
    const maxSize = Math.max(...sizes);

    const attempts = ['1', '0'];

    for (const seek of attempts) {
        try {
            await execFileAsync(ffmpeg, [
                '-ss', seek,
                '-i', path,
                '-frames:v', '1',
                '-vf', `scale=${maxSize}:-2`,
                '-y',
                target,
            ], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' });

            return target;
        }
        catch {
            // 短视频可能没有第 1 秒，重试第 0 秒
        }
    }

    await rm(dir, { recursive: true, force: true });

    return null;
}

export async function generateThumbnails(
    source: string | Buffer,
    kind: AssetKind,
    settings: Settings,
    sizes: number[] = settings.thumbnails.sizes,
): Promise<GeneratedThumbnail[]> {
    const uniqueSizes = [...new Set(sizes.filter(size => Number.isInteger(size) && size > 0))];

    if (uniqueSizes.length === 0) {
        return [];
    }

    if (kind === 'video' && typeof source === 'string') {
        const frame = await extractVideoFrame(source, settings, uniqueSizes);

        if (!frame) {
            return [];
        }

        try {
            return await renderWithSharp(frame, settings, uniqueSizes);
        }
        finally {
            await rm(dirname(frame), { recursive: true, force: true });
        }
    }

    try {
        return await renderWithSharp(source, settings, uniqueSizes, kind === 'svg' ? 384 : 96);
    }
    catch {
        return [];
    }
}
