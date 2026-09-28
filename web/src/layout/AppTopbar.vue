<script setup>
import { ref } from 'vue';
import { useLayout } from '@/layout/composables/layout';
import AppConfigurator from './AppConfigurator.vue';
import { connection } from '@/service/state';

const { toggleMenu, toggleDarkMode, isDarkTheme } = useLayout();

const popup_connections = ref();

const toggle_connections = (event) => {
    popup_connections.value.toggle(event);
};
</script>

<template>
    <div class="layout-topbar">
        <div class="layout-topbar-logo-container">
            <button class="layout-menu-button layout-topbar-action" @click="toggleMenu">
                <i class="pi pi-bars"></i>
            </button>
            <router-link to="/" class="layout-topbar-logo">
                <img src="/icon_small.png" alt="logo" class="layout-topbar-logo-image" />
                <span>monolith</span>
            </router-link>
        </div>

        <div class="layout-topbar-actions">
            <div class="layout-config-menu">
                <button type="button" class="layout-topbar-action" @click="toggleDarkMode">
                    <i :class="['pi', { 'pi-moon': isDarkTheme, 'pi-sun': !isDarkTheme }]"></i>
                </button>

                <AppConfigurator />

                <button type="button" class="layout-topbar-action" @click="toggle_connections">
                    <i class="pi pi-sitemap" :class="connection.status"></i>
                    <span>Connections</span>
                </button>

                <Popover ref="popup_connections">
                    <div class="flex flex-col gap-4">
                        <div>Server <Tag :value="connection.server.value" :severity="connection.server.severity" class="ml-2"></Tag></div>
                        <div>Device <Tag :value="connection.device.value" :severity="connection.device.severity" class="ml-2"></Tag></div>
                    </div>
                </Popover>
            </div>
        </div>
    </div>
</template>
