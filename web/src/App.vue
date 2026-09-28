<script setup>
import { onMounted } from 'vue';
import { init_mqtt } from '@/service/mqtt';
import { useToast } from 'primevue/usetoast';

const toast = useToast();

onMounted(() => {
    init_mqtt();
});
</script>

<template>
    <router-view />
    <Toast position="bottom-right" group="br" />
</template>

<style scoped></style>
