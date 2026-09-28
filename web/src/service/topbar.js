import { ref } from 'vue';
import ToastEventBus from 'primevue/toasteventbus';
import { connection } from '@/service/state';

/*******************************************************************************
 * Topbar connection status
 *******************************************************************************/
export const update_connection_server = (value) => {
    if (value === false) {
        connection.server.value = 'Offline';
        connection.server.severity = 'danger';
        connection.status = 'text-gray-500';
    } else {
        connection.server.value = 'Online';
        connection.server.severity = 'success';
        connection.status = connection.device.value === 'Online' ? 'text-green-500' : 'text-red-400';
        ToastEventBus.emit('add', { severity: 'success', summary: 'Server Connected', group: 'br', life: 3000 });
    }
};

export const update_connection_device = (value) => {
    if (value === false) {
        connection.device.value = 'Offline';
        connection.device.severity = 'danger';

        if (connection.server.value === 'Online') {
            connection.status = 'text-red-400';
        }
    } else {
        connection.device.value = 'Online';
        connection.device.severity = 'success';

        if (connection.server.value === 'Online') {
            connection.status = 'text-green-500';
            ToastEventBus.emit('add', { severity: 'success', summary: 'Device Online', group: 'br', life: 3000 });
        }
    }
};
