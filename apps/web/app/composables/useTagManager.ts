import type { TagImportItem } from '~~/shared/tags';

/**
 * 相册标签页与全局标签页共用的交互状态：
 * 负责创建/编辑/删除/批量/合并/配色/导入导出后的提示、busy 状态与列表刷新。
 * 具体调用哪套 API 由调用方通过 adapter 注入。
 */
export interface TagManagerAdapter {
    reload: () => Promise<void>
    create: (input: { name: string, color?: string }) => Promise<void>
    update: (id: string, patch: { name?: string, color?: string }) => Promise<void>
    remove: (id: string) => Promise<void>
    batchDelete: (ids: string[]) => Promise<number>
    merge: (sourceIds: string[], targetId: string) => Promise<{ removed: number, moved: number }>
    recolor: (mode: 'auto' | 'random') => Promise<number>
    deleteAll: () => Promise<number>
    importTags: (tags: TagImportItem[]) => Promise<{ added: number, skipped: number }>
}

export function useTagManager(adapter: TagManagerAdapter) {
    const { t } = useI18n();

    const busy = ref<string | null>(null);
    const creating = ref(false);
    const importing = ref(false);
    const newName = ref('');
    const newColor = ref<string | undefined>(undefined);
    const error = ref('');
    const notice = ref('');

    function begin(): void {
        error.value = '';
        notice.value = '';
    }

    async function run<T>(
        key: string,
        action: () => Promise<T>,
        describe: (result: T) => string,
    ): Promise<void> {
        busy.value = key;
        begin();

        try {
            const result = await action();

            notice.value = describe(result);
            await adapter.reload();
        }
        catch (operationError) {
            error.value = errorMessage(operationError);
        }
        finally {
            busy.value = null;
        }
    }

    async function create(): Promise<void> {
        if (creating.value) {
            return;
        }

        const name = newName.value.trim();

        if (name === '') {
            error.value = t('album.tagNameRequired');

            return;
        }

        creating.value = true;
        begin();

        try {
            await adapter.create({ name, color: newColor.value });
            newName.value = '';
            newColor.value = undefined;
            notice.value = t('album.tagCreated');
            await adapter.reload();
        }
        catch (createError) {
            error.value = errorMessage(createError);
        }
        finally {
            creating.value = false;
        }
    }

    function update(input: { id: string, name: string, color?: string }): Promise<void> {
        return run(
            input.id,
            () => adapter.update(input.id, { name: input.name, color: input.color }),
            () => t('album.tagSaved'),
        );
    }

    function remove(tagId: string): Promise<void> {
        return run(tagId, () => adapter.remove(tagId), () => t('album.tagDeleted'));
    }

    function batchDelete(ids: string[]): Promise<void> {
        return run(
            'batch',
            () => adapter.batchDelete(ids),
            removed => t('album.batchDeleteTagsDone', { count: removed }),
        );
    }

    function merge(input: { sourceIds: string[], targetId: string }): Promise<void> {
        return run(
            'merge',
            () => adapter.merge(input.sourceIds, input.targetId),
            result => t('album.mergeDone', { removed: result.removed, moved: result.moved }),
        );
    }

    function recolor(mode: 'auto' | 'random'): Promise<void> {
        return run(
            `${mode}-color`,
            () => adapter.recolor(mode),
            updated => t('album.tagRecolorDone', { count: updated }),
        );
    }

    function deleteAll(): Promise<void> {
        return run(
            'delete-all',
            () => adapter.deleteAll(),
            removed => t('album.tagDeleteAllDone', { count: removed }),
        );
    }

    async function importTags(tags: TagImportItem[]): Promise<void> {
        if (importing.value) {
            return;
        }

        importing.value = true;
        begin();

        try {
            const result = await adapter.importTags(tags);

            notice.value = t('album.tagImportDone', { added: result.added, skipped: result.skipped });
            await adapter.reload();
        }
        catch (importError) {
            error.value = errorMessage(importError);
        }
        finally {
            importing.value = false;
        }
    }

    function importInvalid(): void {
        error.value = t('album.tagImportInvalid');
    }

    return {
        busy,
        creating,
        importing,
        newName,
        newColor,
        error,
        notice,
        create,
        update,
        remove,
        batchDelete,
        merge,
        recolor,
        deleteAll,
        importTags,
        importInvalid,
    };
}
