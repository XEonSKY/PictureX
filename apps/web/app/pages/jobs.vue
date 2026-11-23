<script setup lang="ts">
const { t } = useI18n();
const route = useRoute();
const albumScope = computed(() => (typeof route.query.album === 'string' ? route.query.album : ''));

useHead({
    title: () => `${t('jobs.title')} · PictureX`,
});
</script>

<template>
    <JobsPanel :album-id="albumScope" />
</template>
