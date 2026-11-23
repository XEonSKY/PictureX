/**
 * 可视区门控：瓦片挂载不等于要立刻取图。
 *
 * 瀑布流/矩阵会在视口外预渲染一屏（overscan），快速滚动时还会不断挂载又卸载瓦片；
 * 这些瓦片一旦就发起缩略图请求，服务端就得解码原图并写缓存，属于纯粹的磁盘开销。
 * 这里用共享的 IntersectionObserver 把请求推迟到瓦片真正接近视口，元素卸载后请求根本不会发出。
 *
 * 观察 root 优先使用虚拟列表提供的滚动容器（SCROLL_ROOT），而不是窗口视口；
 * 另加滚动停止后的兜底检查，避免快速甩动时浏览器合并 scroll 事件导致个别瓦片一直停在未加载状态。
 */

interface VisibleEntry {
    notify: () => void
    root: HTMLElement | null
    rootMargin: string
    marginPx: number
}

const VIEWPORT_OBSERVERS = new Map<string, IntersectionObserver>();
const ROOT_OBSERVERS = new WeakMap<Element, Map<string, IntersectionObserver>>();
const ENTRIES = new WeakMap<Element, VisibleEntry>();
const PENDING = new Set<Element>();
const SCROLL_SETTLE_MS = 120;

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function marginPixels(rootMargin: string): number {
    const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(rootMargin.trim());

    return match?.[1] ? Number(match[1]) : 0;
}

function createObserver(root: HTMLElement | null, rootMargin: string): IntersectionObserver | null {
    if (!import.meta.client || typeof IntersectionObserver === 'undefined') {
        return null;
    }

    return new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                reveal(entry.target);
            }
        }
    }, { root, rootMargin });
}

function observerFor(root: HTMLElement | null, rootMargin: string): IntersectionObserver | null {
    if (!root) {
        const existing = VIEWPORT_OBSERVERS.get(rootMargin);

        if (existing) {
            return existing;
        }

        const created = createObserver(null, rootMargin);

        if (created) {
            VIEWPORT_OBSERVERS.set(rootMargin, created);
        }

        return created;
    }

    let byMargin = ROOT_OBSERVERS.get(root);

    if (!byMargin) {
        byMargin = new Map();
        ROOT_OBSERVERS.set(root, byMargin);
    }

    const existing = byMargin.get(rootMargin);

    if (existing) {
        return existing;
    }

    const created = createObserver(root, rootMargin);

    if (created) {
        byMargin.set(rootMargin, created);
    }

    return created;
}

function existingObserver(root: HTMLElement | null, rootMargin: string): IntersectionObserver | null {
    return root
        ? ROOT_OBSERVERS.get(root)?.get(rootMargin) ?? null
        : VIEWPORT_OBSERVERS.get(rootMargin) ?? null;
}

function reveal(element: Element): void {
    const entry = ENTRIES.get(element);

    if (!entry) {
        return;
    }

    ENTRIES.delete(element);
    PENDING.delete(element);
    existingObserver(entry.root, entry.rootMargin)?.unobserve(element);
    entry.notify();
}

function intersects(element: Element, entry: VisibleEntry): boolean {
    if (!element.isConnected) {
        return false;
    }

    const rect = element.getBoundingClientRect();

    if (rect.width <= 0 && rect.height <= 0) {
        return false;
    }

    const rootRect = entry.root
        ? entry.root.getBoundingClientRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

    if (rootRect.right - rootRect.left <= 0 || rootRect.bottom - rootRect.top <= 0) {
        return false;
    }

    const margin = entry.marginPx;

    return rect.bottom >= rootRect.top - margin
      && rect.top <= rootRect.bottom + margin
      && rect.right >= rootRect.left - margin
      && rect.left <= rootRect.right + margin;
}

function checkPending(): void {
    if (PENDING.size === 0) {
        return;
    }

    // 先收集再 reveal：reveal 会修改 PENDING
    for (const element of [...PENDING]) {
        const entry = ENTRIES.get(element);

        if (!entry) {
            PENDING.delete(element);
        }
        else if (intersects(element, entry)) {
            reveal(element);
        }
    }
}

function scheduleSettleCheck(): void {
    if (PENDING.size === 0) {
        return;
    }

    if (settleTimer) {
        clearTimeout(settleTimer);
    }

    // 滚动停止后再逐块检查，避免每个 scroll 事件都做数百次 getBoundingClientRect
    settleTimer = setTimeout(() => {
        settleTimer = null;
        checkPending();
    }, SCROLL_SETTLE_MS);
}

function ensureListeners(): void {
    if (listening || !import.meta.client) {
        return;
    }

    listening = true;
    document.addEventListener('scroll', scheduleSettleCheck, { capture: true, passive: true });
    window.addEventListener('resize', scheduleSettleCheck, { passive: true });
}

function detach(element: Element | null | undefined): void {
    if (!element) {
        return;
    }

    const entry = ENTRIES.get(element);

    if (entry) {
        existingObserver(entry.root, entry.rootMargin)?.unobserve(element);
        ENTRIES.delete(element);
    }

    PENDING.delete(element);
}

export function useVisibleImage(options: { rootMargin?: string } = {}) {
    const rootMargin = options.rootMargin ?? '200px';
    const scrollRoot = inject(SCROLL_ROOT, null);
    const root = computed<HTMLElement | null>(() => scrollRoot?.value ?? null);
    const host = shallowRef<HTMLElement | null>(null);
    const visible = ref(false);

    function attach(element: HTMLElement): void {
        if (visible.value) {
            return;
        }

        detach(element);

        const observer = observerFor(root.value, rootMargin);

        if (!observer) {
            // 没有 IntersectionObserver 的运行时退回立即加载，宁可多请求也不能不显示
            visible.value = true;

            return;
        }

        const entry: VisibleEntry = {
            notify: () => {
                visible.value = true;
            },
            root: root.value,
            rootMargin,
            marginPx: marginPixels(rootMargin),
        };

        ENTRIES.set(element, entry);
        PENDING.add(element);
        observer.observe(element);
        ensureListeners();

        // 挂载时已经在视口内的瓦片立即显示；不依赖 observer 的第一帧回调
        requestAnimationFrame(() => {
            const current = ENTRIES.get(element);

            if (current && intersects(element, current)) {
                reveal(element);
            }
        });
    }

    watch([host, root], ([element, currentRoot], [previousElement, previousRoot]) => {
        if (previousElement && (previousElement !== element || previousRoot !== currentRoot)) {
            detach(previousElement);
        }

        if (element) {
            attach(element);
        }
    });

    onScopeDispose(() => {
        detach(host.value);
    });

    return { host, visible };
}
