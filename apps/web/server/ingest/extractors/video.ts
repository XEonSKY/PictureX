import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Settings } from '../../settings/setting-schema';
import { resolveFfprobePath } from '../ffmpeg';
import type { ExtractedMetadata } from '../types';

const execFileAsync = promisify(execFile);

interface ProbeStream {
    codec_name?: string
    codec_type?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    duration?: string
    tags?: Record<string, string>
    side_data_list?: { rotation?: number }[]
}

interface ProbeResult {
    streams?: ProbeStream[]
    format?: {
        duration?: string
        bit_rate?: string
        format_name?: string
        tags?: Record<string, string>
    }
}

function parseRate(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parts = value.split('/');
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);

    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
    }

    return Math.round((numerator / denominator) * 100) / 100;
}

export async function extractVideoMetadata(
    path: string,
    mime: string,
    settings: Settings,
): Promise<ExtractedMetadata> {
    const probePath = resolveFfprobePath(settings);
    const meta: Record<string, unknown> = {};
    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;

    if (!probePath) {
        return { mime, kind: 'video', width, height, durationMs, takenAt: null, meta };
    }

    try {
        const { stdout } = await execFileAsync(probePath, [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            path,
        ], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' });

        const parsed = JSON.parse(stdout) as ProbeResult;
        const videoStream = parsed.streams?.find(stream => stream.codec_type === 'video');
        const rotation = videoStream?.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? 0;

        width = videoStream?.width ?? null;
        height = videoStream?.height ?? null;

        if (rotation === 90 || rotation === 270) {
            const swap = width;

            width = height;
            height = swap;
        }

        const duration = Number(parsed.format?.duration ?? videoStream?.duration ?? 0);

        durationMs = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;

        meta.codec = videoStream?.codec_name ?? '';
        meta.fps = parseRate(videoStream?.avg_frame_rate) ?? parseRate(videoStream?.r_frame_rate);
        meta.bitRate = Number(parsed.format?.bit_rate ?? 0) || null;
        meta.container = parsed.format?.format_name ?? '';
        meta.rotation = rotation;

        const createdAt = parsed.format?.tags?.creation_time ?? videoStream?.tags?.creation_time;

        if (createdAt && !Number.isNaN(Date.parse(createdAt))) {
            meta.creationTime = createdAt;
        }
    }
    catch {
        // ffprobe 失败时仍按视频入库，只是缺少尺寸/时长
    }

    const takenAt = typeof meta.creationTime === 'string' && !Number.isNaN(Date.parse(meta.creationTime))
        ? new Date(meta.creationTime).toISOString()
        : null;

    return { mime, kind: 'video', width, height, durationMs, takenAt, meta };
}
