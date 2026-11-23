<script setup lang="ts">
import { ArrowLeftOutlined, CloseOutlined, MenuOutlined, MoonOutlined, SunOutlined } from '@antdv-next/icons';

const props = defineProps<{
    navLabel: string
    title?: string
    exitTo?: string
    exitLabel?: string
}>();

const { t } = useI18n();
const route = useRoute();
const { isDark, togglePreset } = useTheme();

const open = ref(false);
const narrow = useMediaQuery('(max-width: 599px)');
const sidebar = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let lastFocused: HTMLElement | null = null;

watch(() => route.fullPath, () => {
    open.value = false;
});

// 从手机抽屉切到平板/桌面后，抽屉状态与 body 滚动锁都必须复位
watch(narrow, (isNarrow) => {
    if (!isNarrow) {
        open.value = false;
    }
});

watch(open, async (value) => {
    if (!import.meta.client) {
        return;
    }

    document.body.style.overflow = value ? 'hidden' : '';

    if (value) {
        lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        await nextTick();
        closeButton.value?.focus();

        return;
    }

    lastFocused?.focus();
    lastFocused = null;
});

function onWindowKeydown(event: KeyboardEvent): void {
    if (!open.value) {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        open.value = false;

        return;
    }
    if (event.key !== 'Tab' || !sidebar.value) {
        return;
    }

    // 抽屉打开时把焦点限制在侧栏内，避免 Tab 跑到被遮罩的主内容
    const focusables = [...sidebar.value.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.offsetParent !== null);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (!first || !last) {
        return;
    }

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    }
    else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

onMounted(() => {
    window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onWindowKeydown);

    if (import.meta.client) {
        document.body.style.overflow = '';
    }
});
</script>

<template>
    <div class="px-shell">
        <a class="px-skip-link" href="#px-main-content">{{ t('a11y.skipToContent') }}</a>

        <header class="px-bar">
            <button
                type="button"
                class="px-bar__icon"
                :aria-label="t('a11y.openNav')"
                @click="open = true"
            >
                <MenuOutlined aria-hidden="true" />
            </button>

            <NuxtLink to="/" class="px-brand px-brand--bar">
                <img src="/logo/picturex-mark.svg" alt="" class="px-brand__mark">
                <span class="px-brand__name">PictureX</span>
            </NuxtLink>

            <span class="px-bar__title">{{ props.title ?? '' }}</span>

            <button
                type="button"
                class="px-bar__icon"
                :aria-label="t('a11y.toggleTheme')"
                @click="togglePreset"
            >
                <MoonOutlined v-if="!isDark" aria-hidden="true" />
                <SunOutlined v-else aria-hidden="true" />
            </button>
        </header>

        <div class="px-scrim" :class="{ 'px-scrim--open': open }" @click="open = false" />

        <aside
            ref="sidebar"
            class="px-sidebar"
            :class="{ 'px-sidebar--open': open }"
            :aria-label="props.navLabel"
            :aria-hidden="narrow && !open ? 'true' : undefined"
            :inert="narrow && !open ? true : undefined"
        >
            <div class="px-sidebar__head">
                <NuxtLink to="/" class="px-brand">
                    <img src="/logo/picturex-mark.svg" alt="" class="px-brand__mark">
                    <span class="px-brand__name">PictureX</span>
                </NuxtLink>

                <button
                    ref="closeButton"
                    type="button"
                    class="px-side__close"
                    :aria-label="t('a11y.closeNav')"
                    @click="open = false"
                >
                    <CloseOutlined aria-hidden="true" />
                </button>
            </div>

            <NuxtLink v-if="props.exitTo" :to="props.exitTo" class="px-side__exit" :title="props.exitLabel">
                <ArrowLeftOutlined class="px-side__icon" aria-hidden="true" />
                <span class="px-side__label">{{ props.exitLabel }}</span>
            </NuxtLink>

            <div v-if="$slots.context" class="px-sidebar__context">
                <slot name="context" />
            </div>

            <nav class="px-side" :aria-label="props.navLabel">
                <slot name="nav" />
            </nav>

            <div class="px-sidebar__foot">
                <button
                    type="button"
                    class="px-side__button"
                    :aria-label="t('a11y.toggleTheme')"
                    :title="isDark ? t('nav.light') : t('nav.dark')"
                    @click="togglePreset"
                >
                    <MoonOutlined v-if="!isDark" class="px-side__icon" aria-hidden="true" />
                    <SunOutlined v-else class="px-side__icon" aria-hidden="true" />
                    <span class="px-side__label">{{ isDark ? t('nav.light') : t('nav.dark') }}</span>
                </button>
            </div>
        </aside>

        <main id="px-main-content" class="px-main" tabindex="-1" :inert="narrow && open ? true : undefined">
            <slot />
        </main>
    </div>
</template>
