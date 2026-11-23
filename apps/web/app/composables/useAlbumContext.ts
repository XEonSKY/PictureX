import type { AlbumIndex, TagRecord } from '~~/server/album/album-store';

export interface AlbumTagEntry extends TagRecord {
    count: number
}

interface AlbumContext {
    id: string
    pendingId: string
    album: AlbumIndex | null
    tags: AlbumTagEntry[]
}

/**
 * 相册侧边栏与相册各模块子页共享的上下文：一次拉取 index.json + tag.db，
 * 切换子页（照片/标签/重复/相似）时不重复请求。
 */
export function useAlbumContext(albumId: Ref<string>) {
    const api = useApi();
    const state = useState<AlbumContext>('album-context', () => ({
        id: '',
        pendingId: '',
        album: null,
        tags: [],
    }));
    // 跨组件实例共享请求序号，避免上一个相册的慢响应覆盖新相册
    const revision = useState<number>('album-context-revision', () => 0);
    const error = ref('');

    async function load(force = false): Promise<void> {
        const id = albumId.value;

        if (!force && (state.value.id === id || state.value.pendingId === id)) {
            return;
        }

        const ticket = ++revision.value;

        state.value.pendingId = id;

        try {
            const [albumResult, tagsResult] = await Promise.allSettled([
                api.albums[':albumId'].$get({ param: { albumId: id } }),
                api.albums[':albumId'].tags.$get({ param: { albumId: id } }),
            ]);

            if (albumResult.status === 'rejected') {
                throw albumResult.reason;
            }

            const albumBody = await albumResult.value.json();
            // tag.json 损坏或标签接口失败不应拖垮侧栏/相册上下文
            const tagsBody = tagsResult.status === 'fulfilled'
                ? await tagsResult.value.json().catch(() => ({ data: [] }))
                : { data: [] };

            if (ticket !== revision.value) {
                return;
            }

            state.value = { id, pendingId: '', album: albumBody.data, tags: tagsBody.data };
            error.value = '';
        }
        catch (loadError) {
            if (ticket !== revision.value) {
                return;
            }

            state.value.pendingId = '';
            error.value = loadError instanceof Error ? loadError.message : String(loadError);
        }
    }

    watch(albumId, () => {
        void load();
    });

    return {
        album: computed(() => (state.value.id === albumId.value ? state.value.album : null)),
        tags: computed(() => (state.value.id === albumId.value ? state.value.tags : [])),
        error,
        load,
    };
}
