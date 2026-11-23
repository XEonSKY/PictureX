/**
 * 查看器支持注册为「打开方式」的图片/视频扩展名与 MIME 判定。
 * 只收录 Chromium 能直接渲染的容器，避免注册后打开是坏图。
 */

const IMAGE_EXTENSIONS: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
};

const VIDEO_EXTENSIONS: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
};

export type ViewerKind = 'image' | 'video';

export interface ViewerType {
    kind: ViewerKind
    mime: string
}

export function classifyViewerFile(filePath: string): ViewerType | null {
    const dot = filePath.lastIndexOf('.');

    if (dot < 0) {
        return null;
    }

    const ext = filePath.slice(dot + 1).toLowerCase();
    const imageMime = IMAGE_EXTENSIONS[ext];

    if (imageMime) {
        return { kind: 'image', mime: imageMime };
    }

    const videoMime = VIDEO_EXTENSIONS[ext];

    if (videoMime) {
        return { kind: 'video', mime: videoMime };
    }

    return null;
}
