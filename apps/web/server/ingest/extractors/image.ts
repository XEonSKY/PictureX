import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import exifr from 'exifr';
import sharp from 'sharp';
import type { AssetKind, ExtractedMetadata } from '../types';

// EXIF/TIFF 头通常位于文件开头；HEAD 足够覆盖 JPEG APP1、PNG eXIf 与 HEIC meta。
const EXIF_HEAD_BYTES = 4 * 1024 * 1024;

async function readHead(path: string): Promise<Buffer> {
    const handle = await open(path, 'r');

    try {
        const { size } = await handle.stat();
        const length = Math.min(size, EXIF_HEAD_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        let offset = 0;

        while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);

            if (bytesRead === 0) {
                break;
            }
            offset += bytesRead;
        }

        return offset === length ? buffer : buffer.subarray(0, offset);
    }
    finally {
        await handle.close();
    }
}

const EXIF_FIELDS = [
    'Make',
    'Model',
    'LensModel',
    'FNumber',
    'ExposureTime',
    'ISO',
    'FocalLength',
    'DateTimeOriginal',
    'CreateDate',
    'GPSLatitude',
    'GPSLongitude',
    'Orientation',
];

function toIso(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'string') {
        const parsed = new Date(value);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }

    return null;
}

export async function extractImageMetadata(
    path: string,
    mime: string,
    kind: AssetKind,
    source?: Buffer | string,
): Promise<ExtractedMetadata> {
    const meta: Record<string, unknown> = {};
    let width: number | null = null;
    let height: number | null = null;
    let resolvedKind = kind;

    try {
        const info = await sharp(source ?? path, { animated: true, density: 192 }).metadata();

        width = info.width ?? null;
        height = info.height ?? null;

        if (info.pages && info.pages > 1 && (mime === 'image/gif' || mime === 'image/webp' || mime === 'image/apng')) {
            resolvedKind = 'gif';
            meta.pages = info.pages;
        }
        if (info.format) {
            meta.format = info.format;
        }
        if (info.space) {
            meta.colorSpace = info.space;
        }
    }
    catch {
        // 尺寸读取失败不阻塞入库
    }

    if (kind === 'svg') {
        try {
            const head = readFileSync(path, 'utf8').slice(0, 8192);
            const widthMatch = /width="([\d.]+)(?:px)?"/u.exec(head);
            const heightMatch = /height="([\d.]+)(?:px)?"/u.exec(head);
            const viewBox = /viewBox="([\d.\s-]+)"/u.exec(head);

            if (widthMatch?.[1] && heightMatch?.[1]) {
                width = Math.round(Number(widthMatch[1]));
                height = Math.round(Number(heightMatch[1]));
            }
            else if (viewBox?.[1]) {
                const parts = viewBox[1].trim().split(/[\s,]+/u).map(Number);

                if (parts.length === 4 && parts.every(Number.isFinite)) {
                    width = Math.round(parts[2] ?? 0) || null;
                    height = Math.round(parts[3] ?? 0) || null;
                }
            }

            if (viewBox?.[1]) {
                meta.viewBox = viewBox[1];
            }
        }
        catch {
            // 保持 sharp 推断的尺寸
        }
    }

    let takenAt: string | null = null;

    try {
        // exifr 的路径读取在 Node 26 上会因 FileHandle.stat 参数校验失败而泄漏句柄，改为显式读头后走 Buffer 解析。
        const parsed: unknown = await exifr.parse(await readHead(path), {
            pick: EXIF_FIELDS,
            translateValues: true,
            reviveValues: true,
        });

        if (parsed && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>;

            for (const [key, value] of Object.entries(record)) {
                if (value !== undefined && value !== null) {
                    meta[key] = value;
                }
            }

            takenAt = toIso(record.DateTimeOriginal) ?? toIso(record.CreateDate);
        }
    }
    catch {
        // 没有 EXIF 或解析失败是常态
    }

    return {
        mime,
        kind: resolvedKind,
        width,
        height,
        durationMs: null,
        takenAt,
        meta,
    };
}
