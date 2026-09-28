<script setup>
import { computed } from 'vue';

import AppMenuItem from './AppMenuItem.vue';
import { announcement, showAnnouncement } from '@/service/announcement';

const model = computed(() => [
    {
        label: 'Main',
        items: [
            { label: 'Live Telemetry', icon: 'pi pi-fw pi-wifi', to: '/' },
            { label: 'Data Viewer', icon: 'pi pi-fw pi-database', to: '/viewer' },
            { label: 'UI Configuration', icon: 'pi pi-fw pi-desktop', to: '/ui' },
            { label: 'Device Configuration', icon: 'pi pi-fw pi-cog', to: '/device' }
        ]
    },
    {
        label: 'Get Started',
        items: [
            {
                label: 'Announcement',
                icon: 'pi pi-fw pi-megaphone',
                command: () => showAnnouncement(),
                visible: !!announcement.message
            },
            {
                label: 'Documentation',
                icon: 'pi pi-fw pi-book',
                url: '/docs',
                target: '_blank'
            },
            {
                label: 'GitHub',
                icon: 'pi pi-fw pi-github',
                url: 'https://github.com/luftaquila/monolith',
                target: '_blank'
            },
            {
                label: 'DNF Forum',
                icon: 'pi pi-fw pi-link',
                url: 'https://dnf.luftaquila.io',
                target: '_blank'
            }
        ]
    }
]);
</script>

<template>
    <ul class="layout-menu">
        <template v-for="(item, i) in model" :key="item">
            <app-menu-item v-if="!item.separator" :item="item" :index="i"></app-menu-item>
            <li v-if="item.separator" class="menu-separator"></li>
        </template>
    </ul>
</template>

<style lang="scss" scoped></style>
