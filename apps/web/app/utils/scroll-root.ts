import type { InjectionKey, Ref } from 'vue';

/** 虚拟列表的滚动容器；瓦片用它作为 IntersectionObserver 的 root。 */
export const SCROLL_ROOT: InjectionKey<Ref<HTMLElement | null>> = Symbol('px-scroll-root');
