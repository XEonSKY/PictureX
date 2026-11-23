import { onBeforeUnmount, onMounted, readonly, ref } from 'vue';

/** 响应式媒体查询：用于只在特定断点生效的可访问性/交互逻辑（CSS 负责视觉）。 */
export function useMediaQuery(query: string) {
    const matches = ref(false);
    let list: MediaQueryList | null = null;

    const sync = (): void => {
        matches.value = list?.matches ?? false;
    };

    onMounted(() => {
        if (!import.meta.client) {
            return;
        }

        list = window.matchMedia(query);
        sync();
        list.addEventListener('change', sync);
    });

    onBeforeUnmount(() => {
        list?.removeEventListener('change', sync);
        list = null;
    });

    return readonly(matches);
}
