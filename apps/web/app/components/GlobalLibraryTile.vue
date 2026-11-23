<script setup lang="ts">
// 散图库只保存查看器打开过的媒体元数据，不保存文件字节；Web/服务端不读取用户磁盘路径，
// 因此这里按设计只展示文件名占位，不请求缩略图（桌面端由查看器窗口直接加载 pxfile）。
import { PictureOutlined, PlayCircleOutlined } from '@antdv-next/icons';
import type { LibraryMediaDto } from '~~/shared/library';

defineProps<{
    item: LibraryMediaDto
    width: number
    height: number
}>();

const { t } = useI18n();
</script>

<template>
    <div
        class="library-tile"
        :aria-label="t('a11y.thumbnail', { name: item.filename })"
        :title="item.filename"
    >
        <span class="library-tile__fallback">
            <PictureOutlined />
            <span class="library-tile__fallback-name">{{ item.filename }}</span>
        </span>

        <span v-if="item.kind === 'video'" class="library-tile__kind">
            <PlayCircleOutlined />
        </span>
    </div>
</template>

<style scoped>
.library-tile {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
}

.library-tile__fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--px-space-1);
    width: 100%;
    height: 100%;
    padding: var(--px-space-3);
    color: var(--px-color-text-fourth);
    font-size: var(--px-font-size-title-lg);
}

.library-tile__fallback-name {
    max-width: 100%;
    overflow: hidden;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.library-tile__kind {
    position: absolute;
    right: var(--px-space-1);
    bottom: var(--px-space-1);
    display: inline-flex;
    padding: 0 var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: var(--px-color-mask);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
}
</style>
