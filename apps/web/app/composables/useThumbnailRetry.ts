/**
 * 缩略图加载重试。
 *
 * 缓存优先模式下，浏览请求不会同步解码原图：缺失的缩略图只会进入后台队列并立即 404。
 * 这里用指数退避重试同一张图，后台生成完成后无需用户刷新即可自动出现；
 * 同时也能兜住磁盘/网络抖动导致的偶发失败。
 *
 * 失败期间先卸载 <img>（显示占位），到点换一个新的 retry token 重新挂载，
 * 避免浏览器把失败的 <img> 一直停在同一状态。
 */

const DEFAULT_DELAYS_MS = [800, 2200, 5000];

export function useThumbnailRetry(delays: number[] = DEFAULT_DELAYS_MS) {
    const failed = ref(false);
    /** 追加到 URL 的重试序号：变化时 <img> 会重新发起请求 */
    const token = ref(0);
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function clearTimer(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function onError(): void {
        if (disposed || attempt >= delays.length) {
            failed.value = true;

            return;
        }

        const delay = delays[attempt] ?? delays[delays.length - 1] ?? 0;

        attempt += 1;
        failed.value = true;
        clearTimer();
        timer = setTimeout(() => {
            timer = null;

            if (disposed) {
                return;
            }

            failed.value = false;
            token.value += 1;
        }, delay);
    }

    function onLoad(): void {
        attempt = 0;
        clearTimer();
    }

    function reset(): void {
        clearTimer();
        attempt = 0;
        token.value = 0;
        failed.value = false;
    }

    onScopeDispose(() => {
        disposed = true;
        clearTimer();
    });

    return { failed, token, onError, onLoad, reset };
}
