import { closeSync, openSync, readSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileTypeFromFile } from 'file-type';
import type { Settings } from '../../settings/setting-schema';
import type { ExtractedMetadata } from '../types';
import { extractImageMetadata } from './image';
import { extractVideoMetadata } from './video';

const SVG_EXTENSIONS = new Set(['svg']);
const DYNAMIC_EXTENSIONS = new Set(['heic', 'heif', 'jpg', 'jpeg']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const RAW_EXTENSIONS = new Set([
    'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'pef', 'srw', 'raw',
]);

const RAW_MIME: Record<string, string> = {
    dng: 'image/x-adobe-dng',
    cr2: 'image/x-canon-cr2',
    cr3: 'image/x-canon-cr3',
    nef: 'image/x-nikon-nef',
    arw: 'image/x-sony-arw',
    raf: 'image/x-fujifilm-raf',
    rw2: 'image/x-panasonic-rw2',
    orf: 'image/x-olympus-orf',
    pef: 'image/x-pentax-pef',
    srw: 'image/x-samsung-srw',
    raw: 'image/x-raw',
};

/** HEIC/RAW 解码成 JPEG 预览；失败返回 null，由调用方计入 skipped */
async function decodePreview(path: string, ext: string): Promise<Buffer | null> {
    try {
        if (HEIC_EXTENSIONS.has(ext)) {
            const { default: convert } = await import('heic-convert');
            const output = await convert({
                buffer: await readFile(path),
                format: 'JPEG',
                quality: 0.9,
            });

            const buffer = output instanceof Uint8Array ? output : new Uint8Array(output);

            return Buffer.from(buffer);
        }

        if (RAW_EXTENSIONS.has(ext)) {
            const { RawDecoder } = await import('dcraw-wasm');
            const result = await new RawDecoder().extractThumbnailSafe(await readFile(path));

            return result.ok && result.data && result.data.byteLength > 0
                ? Buffer.from(result.data)
                : null;
        }
    }
    catch {
        return null;
    }

    return null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    ...RAW_MIME,
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
};

function readHead(path: string, length = 1024): string {
    try {
        const fd = openSync(path, 'r');
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, 0);

        closeSync(fd);

        return buffer.subarray(0, read).toString('utf8');
    }
    catch {
        return '';
    }
}

/** Live Photo 的配对视频：返回真实存在的 sidecar 路径，没有则 null */
export function livePhotoSidecarPath(path: string): string | null {
    const ext = extname(path).slice(1).toLowerCase();

    if (!DYNAMIC_EXTENSIONS.has(ext)) {
        return null;
    }

    const stem = join(dirname(path), basename(path, extname(path)));
    const candidates = [`${stem}.mov`, `${stem}.MOV`, `${stem}.mp4`, `${stem}.MP4`];

    return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** 元数据提取总入口：未知格式返回 null，由入库流程计入 skipped */
export async function extractMetadata(path: string, settings: Settings): Promise<ExtractedMetadata | null> {
    const ext = extname(path).slice(1).toLowerCase();
    let mime: string;
    let kind: ExtractedMetadata['kind'] = 'image';

    if (SVG_EXTENSIONS.has(ext)) {
        const head = readHead(path);

        if (!head.includes('<svg') && !head.includes('<?xml')) {
            return null;
        }

        mime = 'image/svg+xml';
        kind = 'svg';

        return extractImageMetadata(path, mime, kind);
    }

    let detected: { mime: string, ext: string } | undefined;

    try {
        detected = await fileTypeFromFile(path);
    }
    catch {
        detected = undefined;
    }

    mime = detected?.mime ?? MIME_BY_EXTENSION[ext] ?? '';

    if (mime === '') {
        return null;
    }

    if (mime.startsWith('video/')) {
        return extractVideoMetadata(path, mime, settings);
    }

    if (!mime.startsWith('image/')) {
        return null;
    }

    if (livePhotoSidecarPath(path) !== null) {
        kind = 'dynamic';
    }

    if (HEIC_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext)) {
        const preview = await decodePreview(path, ext);

        if (!preview) {
            return null;
        }

        const metadata = await extractImageMetadata(path, mime, kind, preview);

        return { ...metadata, preview };
    }

    return extractImageMetadata(path, mime, kind);
}
