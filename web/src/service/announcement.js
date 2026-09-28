import { reactive } from 'vue';

export const announcement = reactive({
    message: '',
    visible: false,
    dontShowAgain: false
});

export async function fetchAnnouncement() {
    try {
        const res = await fetch('/api/announcement');
        if (!res.ok) return;
        const text = (await res.text()).trim();
        if (!text) return;

        announcement.message = text;

        const dismissed = localStorage.getItem('announcement/dismissed');
        if (dismissed !== text) {
            announcement.visible = true;
        }
    } catch (e) {
        // silently ignore
    }
}

export function dismissAnnouncement() {
    if (announcement.dontShowAgain) {
        localStorage.setItem('announcement/dismissed', announcement.message);
    }
    announcement.visible = false;
    announcement.dontShowAgain = false;
}

export function showAnnouncement() {
    announcement.dontShowAgain = false;
    announcement.visible = true;
}
