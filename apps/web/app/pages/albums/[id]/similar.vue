<script setup lang="ts">
const { t } = useI18n();
const route = useRoute();
const albumId = computed(() => String(route.params.id ?? ''));
const { album, load } = useAlbumContext(albumId);

definePageMeta({
    layout: 'album',
});

const title = computed(() => t('album.similarTitle'));

function changed(): void {
    void load(true);
}

useHead({
    title: () => `${title.value} · ${album.value?.name ?? ''} · PictureX`,
});

onMounted(() => {
    void load();
});
</script>

<template>
    <div class="px-page">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    {{ album?.name ?? '' }}
                </p>
                <h1 class="px-page-title">
                    {{ title }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('album.similarSubtitle') }}
                </p>
            </div>
        </header>

        <SimilarGroups :album-id="albumId" @changed="changed" />
    </div>
</template>
