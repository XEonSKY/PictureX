import { extractZip } from '~/utils/ugoira-zip';

export interface UgoiraFrameInfo {
    file: string
    delay: number
}

type Drawable = ImageBitmap | HTMLImageElement;

function frameMime(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();

    if (ext === 'png') {
        return 'image/png';
    }
    if (ext === 'webp') {
        return 'image/webp';
    }
    if (ext === 'gif') {
        return 'image/gif';
    }

    return 'image/jpeg';
}

async function decodeFrame(data: Uint8Array, mime: string): Promise<Drawable> {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: mime });

    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
    }

    const url = URL.createObjectURL(blob);

    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();

            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Failed to decode an ugoira frame.'));
            image.src = url;
        });
    }
    finally {
        URL.revokeObjectURL(url);
    }
}

function release(frame: Drawable): void {
    if (frame instanceof ImageBitmap) {
        frame.close();
    }
}

/**
 * 客户端逐帧播放 ugoira：拉取 zip → 解压帧 → 按 metadata 顺序与 delay 绘制到 canvas。
 * 失败只影响动图，静态封面仍可正常显示。
 */
export function useUgoiraPlayer(canvas: Ref<HTMLCanvasElement | null>) {
    const loading = ref(false);
    const playing = ref(false);
    const failed = ref(false);

    let frames: Drawable[] = [];
    let delays: number[] = [];
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loadedUrl = '';
    let generation = 0;
    let controller: AbortController | null = null;

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function draw(): void {
        const element = canvas.value;
        const frame = frames[index];

        if (!element || !frame) {
            return;
        }

        const width = frame instanceof ImageBitmap ? frame.width : frame.naturalWidth;
        const height = frame instanceof ImageBitmap ? frame.height : frame.naturalHeight;

        if (element.width !== width || element.height !== height) {
            element.width = width;
            element.height = height;
        }

        const context = element.getContext('2d');

        context?.clearRect(0, 0, element.width, element.height);

        if (frame instanceof ImageBitmap) {
            context?.drawImage(frame, 0, 0);
        }
        else {
            context?.drawImage(frame, 0, 0, width, height);
        }
    }

    function schedule(): void {
        clearTimer();

        if (!playing.value || frames.length === 0) {
            return;
        }

        const delay = Math.max(20, delays[index] ?? 100);

        index = (index + 1) % frames.length;
        timer = setTimeout(() => {
            if (!playing.value) {
                return;
            }

            draw();
            schedule();
        }, delay);
    }

    function resetFrames(): void {
        frames.forEach(release);
        frames = [];
        delays = [];
        index = 0;
        loadedUrl = '';
    }

    function stop(): void {
        generation += 1;
        controller?.abort();
        controller = null;
        playing.value = false;
        loading.value = false;
        failed.value = false;
        clearTimer();
        resetFrames();
    }

    async function play(): Promise<void> {
        playing.value = true;
        await nextTick();
        draw();
        schedule();
    }

    async function load(url: string, info: UgoiraFrameInfo[]): Promise<void> {
        const token = ++generation;

        controller?.abort();
        controller = new AbortController();
        loading.value = true;
        failed.value = false;

        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`ugoira archive returned ${response.status}`);
            }

            const archive = await extractZip(await response.arrayBuffer());

            if (token !== generation) {
                return;
            }

            resetFrames();

            for (const frame of info) {
                const data = archive.get(frame.file);

                if (!data) {
                    continue;
                }

                frames.push(await decodeFrame(data, frameMime(frame.file)));
                delays.push(frame.delay);
            }

            if (frames.length === 0 || token !== generation) {
                throw new Error('ugoira archive contains no frames');
            }

            loadedUrl = url;
            await play();
        }
        catch {
            if (token === generation) {
                resetFrames();
                failed.value = true;
                playing.value = false;
            }
        }
        finally {
            if (token === generation) {
                loading.value = false;
            }
        }
    }

    async function toggle(url: string, info: UgoiraFrameInfo[]): Promise<void> {
        if (playing.value) {
            playing.value = false;
            clearTimer();

            return;
        }

        if (frames.length > 0 && loadedUrl === url) {
            await play();

            return;
        }

        await load(url, info);
    }

    onBeforeUnmount(stop);

    return { loading, playing, failed, toggle, stop };
}
