import { basename, isAbsolute } from 'node:path';

/**
 * `ffmpeg.path` 的白名单校验。
 *
 * 该值最终交给 `spawn()` 执行：局域网暴露 + 未鉴权时，任意可执行路径等价 RCE。
 * 因此只允许哨兵值 `auto`（回退 ffmpeg-static）或「绝对路径 + 文件名匹配 ffmpeg/ffprobe」。
 */

const FFMPEG_BASENAME = /^(?:ffmpeg|ffprobe)(?:\.exe)?$/iu;

export function isAllowedFfmpegPath(raw: string | undefined | null): boolean {
    const value = raw?.trim();

    if (!value || value === 'auto') {
        return true;
    }

    return isAbsolute(value) && FFMPEG_BASENAME.test(basename(value));
}
