import { onBeforeUnmount, onMounted, readonly, ref } from 'vue';

const ratio = ref(1);
// 引用计数：所有使用方都卸载后再摘掉全局监听，避免热更新/多实例场景残留
let consumers = 0;

function sync(): void {
    ratio.value = Math.max(1, window.devicePixelRatio || 1);
}

function attach(): void {
    if (consumers === 0) {
        window.addEventListener('resize', sync, { passive: true });
        window.addEventListener('orientationchange', sync, { passive: true });
    }

    consumers += 1;
}

function detach(): void {
    consumers -= 1;

    if (consumers <= 0) {
        consumers = 0;
        window.removeEventListener('resize', sync);
        window.removeEventListener('orientationchange', sync);
    }
}

/**
 * 全局共享的 devicePixelRatio：4K/Retina 屏幕按物理像素选择缩略图档位。
 * 首次挂载后同步，避免 SSR 与 hydration 的图片 URL 不一致。
 */
export function usePixelRatio() {
    onMounted(() => {
        if (!import.meta.client) {
            return;
        }

        attach();
        sync();
    });

    onBeforeUnmount(() => {
        if (import.meta.client) {
            detach();
        }
    });

    return readonly(ratio);
}
