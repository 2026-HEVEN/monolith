import AppLayout from '@/layout/AppLayout.vue';
import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            component: AppLayout,
            children: [
                {
                    path: '/',
                    name: 'Telemetry',
                    component: () => import('@/views/telemetry.vue')
                },
                {
                    path: '/viewer',
                    name: 'Viewer',
                    component: () => import('@/views/viewer.vue')
                },
                {
                    path: '/ui',
                    name: 'UI Configuration',
                    component: () => import('@/views/ui.vue')
                },
                {
                    path: '/device',
                    name: 'Device Configuration',
                    component: () => import('@/views/device.vue')
                }
            ]
        }
        // {
        //     path: '/landing',
        //     name: 'landing',
        //     component: () => import('@/views/pages/Landing.vue')
        // },
    ]
});

export default router;
