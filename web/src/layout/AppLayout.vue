<script setup>
import { useLayout } from '@/layout/composables/layout';
import { computed, onMounted, ref, watch } from 'vue';
import AppFooter from './AppFooter.vue';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';
import { announcement, fetchAnnouncement, dismissAnnouncement } from '@/service/announcement';

const { layoutConfig, layoutState, isSidebarActive } = useLayout();

onMounted(() => {
    fetchAnnouncement();
});

const outsideClickListener = ref(null);

watch(isSidebarActive, (newVal) => {
    if (newVal) {
        bindOutsideClickListener();
    } else {
        unbindOutsideClickListener();
    }
});

const containerClass = computed(() => {
    return {
        'layout-overlay': layoutConfig.menuMode === 'overlay',
        'layout-static': layoutConfig.menuMode === 'static',
        'layout-static-inactive': layoutState.staticMenuDesktopInactive && layoutConfig.menuMode === 'static',
        'layout-overlay-active': layoutState.overlayMenuActive,
        'layout-mobile-active': layoutState.staticMenuMobileActive
    };
});

function bindOutsideClickListener() {
    if (!outsideClickListener.value) {
        outsideClickListener.value = (event) => {
            if (isOutsideClicked(event)) {
                layoutState.overlayMenuActive = false;
                layoutState.staticMenuMobileActive = false;
                layoutState.menuHoverActive = false;
            }
        };
        document.addEventListener('click', outsideClickListener.value);
    }
}

function unbindOutsideClickListener() {
    if (outsideClickListener.value) {
        document.removeEventListener('click', outsideClickListener.value);
        outsideClickListener.value = null;
    }
}

function isOutsideClicked(event) {
    const sidebarEl = document.querySelector('.layout-sidebar');
    const topbarEl = document.querySelector('.layout-menu-button');

    return !(sidebarEl?.isSameNode(event.target) || sidebarEl?.contains(event.target) || topbarEl?.isSameNode(event.target) || topbarEl?.contains(event.target));
}
</script>

<template>
    <div class="layout-wrapper" :class="containerClass">
        <app-topbar></app-topbar>
        <app-sidebar></app-sidebar>
        <div class="layout-main-container">
            <div class="layout-main">
                <router-view v-slot="{ Component }">
                    <keep-alive>
                        <component :is="Component" />
                    </keep-alive>
                </router-view>
            </div>
            <app-footer></app-footer>
        </div>
        <div class="layout-mask animate-fadein"></div>
    </div>
    <Toast />
    <Dialog v-model:visible="announcement.visible" modal header="공지사항" :style="{ width: '30rem', maxWidth: '90vw' }">
        <p class="announcement-body" style="white-space: pre-wrap;" v-html="announcement.message"></p>
        <div class="flex items-center mt-4">
            <Checkbox v-model="announcement.dontShowAgain" :binary="true" inputId="dontShowAgain" />
            <label for="dontShowAgain" class="ml-2 cursor-pointer select-none">다시 보지 않기</label>
        </div>
        <template #footer>
            <Button label="확인" @click="dismissAnnouncement" :autofocus="false" />
        </template>
    </Dialog>
</template>

<style scoped>
.announcement-body :deep(a) {
    color: var(--p-primary-color);
    text-decoration: underline;
}
</style>
