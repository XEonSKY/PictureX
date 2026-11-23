import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { getViewerFile, isViewerRecordCurrent } from './viewer-files';

/**
 * 查看器文件协议 pxfile://media/<ref>
 * - 只服务登记过的不透明 ref（用户经 OS 打开或应用内新窗口显式登记），拒绝任意路径。
 * - 支持单段 Range，让 <video> 可以边下边拖动；图片走整段 200。
 * - 协议以 bypassCSP 注册，Web 端不存在该 scheme，不影响既有 CSP。
 */

interface ByteSlice {
    start: number
    end: number
}

function parseRange(header: string | null, size: number): ByteSlice | 'invalid' | null {
    if (!header) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());

    if (!match) {
        return 'invalid';
    }

    const rawStart = match[1];
    const rawEnd = match[2];
    let start: number;
    let end: number;

    if (rawStart === '' && rawEnd === '') {
        return 'invalid';
    }
    if (rawStart === '') {
        // 后缀范围：取末尾 N 字节
        const suffix = Number(rawEnd);

        if (!Number.isFinite(suffix) || suffix <= 0) {
            return 'invalid';
        }

        start = Math.max(0, size - suffix);
        end = size - 1;
    }
    else {
        start = Number(rawStart);
        end = rawEnd === '' ? size - 1 : Number(rawEnd);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return 'invalid';
    }

    return { start, end: Math.min(end, size - 1) };
}

function sliceHeaders(mime: string, size: number, range: ByteSlice | null): Record<string, string> {
    if (range === null) {
        return {
            'content-type': mime,
            'accept-ranges': 'bytes',
            'content-length': String(size),
            'cache-control': 'private, no-store',
        };
    }

    return {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
        'cache-control': 'private, no-store',
    };
}

export function registerViewerScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: 'pxfile',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                stream: true,
                bypassCSP: true,
            },
        },
    ]);
}

let protocolInstalled = false;

export function installViewerProtocol(): void {
    // second-instance 每次打开文件都会调用；重复注册可能抛错，
    // 且同一个 handler 已足够服务所有已登记 ref。
    if (protocolInstalled) {
        return;
    }

    protocolInstalled = true;

    protocol.handle('pxfile', async (request) => {
        const url = new URL(request.url);
        const ref = decodeURIComponent(url.pathname.replace(/^\//u, ''));
        const record = getViewerFile(ref);

        if (!record) {
            return new Response('forbidden', { status: 403 });
        }

        // 登记后路径可能被换指向别处（软链替换 TOCTOU）：每次请求复核真实路径与 inode
        if (!isViewerRecordCurrent(record)) {
            return new Response('forbidden', { status: 403 });
        }

        let size: number;

        try {
            size = statSync(record.realpath).size;
        }
        catch {
            return new Response('not found', { status: 404 });
        }

        const range = parseRange(request.headers.get('range'), size);

        if (range === 'invalid') {
            return new Response(null, {
                status: 416,
                headers: { 'content-range': `bytes */${size}` },
            });
        }

        const stream = Readable.toWeb(
            createReadStream(record.realpath, range ? { start: range.start, end: range.end } : undefined),
        ) as ReadableStream<Uint8Array>;

        return new Response(stream, {
            status: range ? 206 : 200,
            headers: sliceHeaders(record.mime, size, range),
        });
    });
}
