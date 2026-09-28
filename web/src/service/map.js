import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import hotline from 'leaflet-hotline';

hotline(L);

export const HOTLINE_MODE = { SPEED: 'speed', TIME: 'time' };

const PALETTE_SPEED = { 0.0: '#22c55e', 0.33: '#eab308', 0.66: '#f97316', 1.0: '#ef4444' };
const PALETTE_TIME = { 0.0: '#6366f1', 0.5: '#06b6d4', 1.0: '#22c55e' };

export function init_map(map, line, path, ref, mode) {
    const el = ref.value?.$el || ref.value;
    if (!el) return;

    map.value = L.map(el, {
        center: [35.292012, 126.574415],
        zoom: 19,
        zoomControl: true
    });

    L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2', {
        subdomains: '0123',
        attribution: '&copy; Google',
        maxZoom: 21
    }).addTo(map.value);

    line.value = L.hotline([], {
        palette: mode === HOTLINE_MODE.TIME ? PALETTE_TIME : PALETTE_SPEED,
        min: 0,
        max: 1,
        weight: 4,
        outlineWidth: 1,
        outlineColor: '#000000'
    }).addTo(map.value);

    path.value = [];
}

export function rebuild_hotline(map, line, path, mode) {
    if (!map.value || !line.value) return;

    map.value.removeLayer(line.value);

    const palette = mode === HOTLINE_MODE.TIME ? PALETTE_TIME : PALETTE_SPEED;
    let min = 0, max = 1;

    if (path.value.length > 0) {
        if (mode === HOTLINE_MODE.TIME) {
            min = 0;
            max = path.value.length - 1 || 1;
        } else {
            const speeds = path.value.map((p) => p[2]);
            min = Math.min(...speeds);
            max = Math.max(...speeds);
            if (min === max) max = min + 1;
        }
    }

    const data = path.value.map((p, i) => {
        return mode === HOTLINE_MODE.TIME ? [p[0], p[1], i] : [p[0], p[1], p[2]];
    });

    line.value = L.hotline(data, {
        palette,
        min,
        max,
        weight: 4,
        outlineWidth: 1,
        outlineColor: '#000000'
    }).addTo(map.value);
}
