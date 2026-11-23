/**
 * keyset（cursor）分页列表的状态机：首屏/翻页共用，reset 可打断进行中的请求。
 *
 * 页面只提供 `fetchPage(cursor)`，由它返回本页数据、下一页游标与可选的附加字段
 * （例如后台统计的 total）。请求序号在 reset 时递增，慢响应不会覆盖新筛选结果。
 */
export interface CursorPage<T, E = undefined> {
    items: T[]
    nextCursor: string | null
    hasMore: boolean
    /** 与页面额外展示相关的字段（总数等），reset 时清空 */
    extra?: E
}

export interface CursorFeedState<T, E = undefined> {
    items: T[]
    nextCursor: string | null
    hasMore: boolean
    extra?: E
}

export interface CursorFeedOptions<T, E = undefined> {
    fetchPage: (cursor: string | undefined) => Promise<CursorPage<T, E>>
    /** reset 开始时的副作用（例如清空多选） */
    onReset?: () => void
    /** 一页数据已应用（含 reset）后的副作用（例如记录当前页大小） */
    onPage?: (page: CursorPage<T, E>) => void
}

export function useCursorFeed<T, E = undefined>(options: CursorFeedOptions<T, E>) {
    const items = ref<T[]>([]) as Ref<T[]>;
    const extra = ref<E | undefined>(undefined);
    const loading = ref(false);
    const initialLoading = ref(true);
    const hasMore = ref(true);
    const cursor = ref<string | null>(null);
    const error = ref('');
    let token = 0;

    async function load(reset = false): Promise<void> {
        if (!reset && (loading.value || !hasMore.value)) {
            return;
        }

        if (reset) {
            // reset 可以打断进行中的翻页，否则搜索/排序/标签切换会被 loading 静默吞掉
            token += 1;
            cursor.value = null;
            hasMore.value = true;
            extra.value = undefined;
            // 立即卸载旧条目，停止上一组缩略图请求
            items.value = [];
            options.onReset?.();
        }

        const current = token;
        const requestCursor = reset ? undefined : cursor.value ?? undefined;

        loading.value = true;
        error.value = '';

        try {
            const page = await options.fetchPage(requestCursor);

            if (current !== token) {
                return;
            }

            items.value = reset ? page.items : [...items.value, ...page.items];
            cursor.value = page.nextCursor;
            hasMore.value = page.hasMore;
            extra.value = page.extra;
            options.onPage?.(page);
        }
        catch (loadError) {
            if (current !== token) {
                return;
            }

            error.value = loadError instanceof Error ? loadError.message : String(loadError);
            // 自动续拉遇到失败就停下，等用户手动刷新，避免无限重试
            hasMore.value = false;
        }
        finally {
            if (current === token) {
                loading.value = false;
                initialLoading.value = false;
            }
        }
    }

    /** 原地恢复已加载的列表与游标（用于从查看器返回时保留滚动位置） */
    function hydrate(state: CursorFeedState<T, E>): void {
        token += 1;
        items.value = state.items;
        cursor.value = state.nextCursor;
        hasMore.value = state.hasMore;
        extra.value = state.extra;
        loading.value = false;
        initialLoading.value = false;
        error.value = '';
    }

    return {
        items,
        extra,
        loading,
        initialLoading,
        hasMore,
        cursor,
        error,
        load,
        hydrate,
    };
}
