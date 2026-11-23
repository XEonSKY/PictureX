const HOLD_MS = 900;
const INSET = 2;
const MIN_THUMB = 24;

interface Geometry {
    left: number
    top: number
    height: number
    trackHeight: number
    scrollRange: number
}

/**
 * 覆盖式滚动条：原生滚动条被完全隐藏（不占布局空间），
 * 这里只放一个悬浮滑块，滚动/悬停/拖动时可见，静止 900ms 后淡出。
 * 样式在 assets/css/theme.css 的 `.px-scrollbar`。
 */
export default defineNuxtPlugin(() => {
    const thumb = document.createElement('div');

    thumb.className = 'px-scrollbar';
    thumb.setAttribute('aria-hidden', 'true');
    document.body.appendChild(thumb);

    let host: HTMLElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    let dragging = false;
    let dragStartY = 0;
    let dragStartScroll = 0;
    let dragScrollRange = 0;
    let dragFreeTrack = 0;
    let thumbWidth = 8;
    let lastRenderKey = '';
    let borderCache: { element: HTMLElement, right: number, bottom: number } | null = null;

    function measureThumb(): void {
        const width = thumb.offsetWidth;

        if (width > 0) {
            thumbWidth = width;
        }
    }

    function isRoot(element: HTMLElement): boolean {
        return element === document.documentElement || element === document.body;
    }

    function geometry(): Geometry | null {
        const element = host;

        if (!element || !element.isConnected) {
            return null;
        }

        const root = isRoot(element);
        const clientHeight = root ? window.innerHeight : element.clientHeight;
        const scrollHeight = root ? document.documentElement.scrollHeight : element.scrollHeight;
        const scrollTop = root ? window.scrollY : element.scrollTop;
        const scrollRange = scrollHeight - clientHeight;

        if (scrollRange <= 0 || clientHeight <= 0) {
            return null;
        }

        let left = root ? window.innerWidth : element.getBoundingClientRect().right;
        let top = root ? 0 : element.getBoundingClientRect().top;
        let trackHeight = clientHeight;

        if (!root) {
            // 边框宽度只在宿主切换时读一次，避免每个滚动帧都 getComputedStyle
            if (borderCache?.element !== element) {
                const styles = getComputedStyle(element);

                borderCache = {
                    element,
                    right: Number.parseFloat(styles.borderRightWidth) || 0,
                    bottom: Number.parseFloat(styles.borderTopWidth) || 0,
                };
            }

            top += borderCache.bottom;
            left -= borderCache.right;
            trackHeight = element.clientHeight;
        }

        const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * trackHeight);

        left -= thumbWidth + INSET;
        top += (scrollTop / scrollRange) * (trackHeight - height);

        return { left, top, height, trackHeight, scrollRange };
    }

    function scheduleHide(): void {
        if (hideTimer) {
            clearTimeout(hideTimer);
        }

        hideTimer = setTimeout(() => {
            hideTimer = null;

            if (!dragging) {
                thumb.classList.remove('px-scrollbar--visible');
            }
        }, HOLD_MS);
    }

    function render(): void {
        const box = geometry();

        if (!box) {
            thumb.classList.remove('px-scrollbar--visible');

            return;
        }

        const key = `${box.left}|${box.top}|${box.height}`;

        if (key !== lastRenderKey) {
            lastRenderKey = key;
            thumb.style.height = `${box.height}px`;
            thumb.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
        }

        thumb.classList.add('px-scrollbar--visible');
        scheduleHide();
    }

    function scheduleRender(): void {
        if (pending) {
            return;
        }

        pending = true;

        const run = () => {
            pending = false;
            render();
        };

        // 后台标签页会冻结 rAF，用计时器兜底，切回前台不会停在旧位置
        if (document.hidden) {
            setTimeout(run, 16);
        }
        else {
            requestAnimationFrame(run);
        }
    }

    function onScroll(event: Event): void {
        const target = event.target;
        const element = target === document || target === window
            ? document.documentElement
            : target as Node;

        if (!(element instanceof HTMLElement)) {
            return;
        }

        host = element;
        scheduleRender();
    }

    measureThumb();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', () => {
        measureThumb();
        lastRenderKey = '';
        scheduleRender();
    });
    window.addEventListener('blur', () => {
        thumb.classList.remove('px-scrollbar--visible');
    });

    thumb.addEventListener('pointerdown', (event) => {
        const box = geometry();

        if (!box || !(host instanceof HTMLElement)) {
            return;
        }

        dragging = true;
        dragStartY = event.clientY;
        dragStartScroll = isRoot(host) ? window.scrollY : host.scrollTop;
        dragScrollRange = box.scrollRange;
        dragFreeTrack = Math.max(1, box.trackHeight - box.height);
        thumb.classList.add('px-scrollbar--dragging', 'px-scrollbar--visible');
        thumb.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    thumb.addEventListener('pointermove', (event) => {
        if (!dragging || !host) {
            return;
        }

        const element = host;
        const ratio = ((event.clientY - dragStartY) / dragFreeTrack) * dragScrollRange;
        const next = Math.min(dragScrollRange, Math.max(0, dragStartScroll + ratio));

        if (isRoot(element)) {
            window.scrollTo(0, next);
        }
        else {
            element.scrollTop = next;
        }
    });

    const endDrag = (event: PointerEvent): void => {
        if (!dragging) {
            return;
        }

        dragging = false;
        thumb.classList.remove('px-scrollbar--dragging');

        if (thumb.hasPointerCapture(event.pointerId)) {
            thumb.releasePointerCapture(event.pointerId);
        }

        scheduleHide();
    };

    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
    thumb.addEventListener('pointerenter', () => {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    });
    thumb.addEventListener('pointerleave', () => {
        if (!dragging) {
            scheduleHide();
        }
    });

    // 路由切换后宿主元素可能被卸载，切页时直接收起
    const router = useRouter();

    router.afterEach(() => {
        host = null;
        borderCache = null;
        lastRenderKey = '';
        thumb.classList.remove('px-scrollbar--visible');
    });
});
