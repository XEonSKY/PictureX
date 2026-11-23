<script setup lang="ts">
definePageMeta({
    layout: 'album',
});

const { t } = useI18n();
const route = useRoute();
const albumId = computed(() => String(route.params.id ?? ''));
const { album } = useAlbumContext(albumId);
const title = computed(() => t('album.moduleJobs'));

useHead({
    title: () => `${title.value} · ${album.value?.name ?? ''} · PictureX`,
});
</script>

<template>
    <JobsPanel :album-id="albumId" embedded />
</template>
