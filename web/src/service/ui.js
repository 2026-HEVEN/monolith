import { reactive, watch } from 'vue';
import { parse_hex_bytes } from './protocol.js';

export const views = reactive({
    digital: {
        name: 'Digital',
        display: { telemetry: true },
        ch: {
            din1: { name: 'DIN1' },
            din2: { name: 'DIN2' },
            din3: { name: 'DIN3' },
            din4: { name: 'DIN4' }
        }
    },
    analog: {
        name: 'Analog',
        display: { telemetry: true },
        ch: {
            ain1: { name: 'AIN1', divider: false, multiplier: 1, unit: 'Volt' },
            ain2: { name: 'AIN2', divider: false, multiplier: 1, unit: 'Volt' },
            ain3: { name: 'AIN3', divider: false, multiplier: 1, unit: 'Volt' },
            ain4: { name: 'AIN4', divider: false, multiplier: 1, unit: 'Volt' },
            ain5: { name: 'AIN5', multiplier: 1, unit: 'Volt' },
            ain6: { name: 'AIN6', multiplier: 1, unit: 'Volt' },
            volt: { name: 'PWR', multiplier: 15430 / 430 },
            temp: { name: 'TEMP', multiplier: 0.01 }
        }
    },
    gyro: {
        name: 'Gyro',
        display: { telemetry: true }
    },
    can: {
        name: 'CAN',
        display: { telemetry: true, viewer: true },
        view: {}
    },
    gps: {
        name: 'GPS',
        display: { telemetry: true, viewer: true }
    }
});

export const units = reactive({
    Volt: { unit: 'V', display: 'Volt (V)', default: true },
    Temperature: { unit: '°C', display: 'Temperature (°C)', default: true },
    Acceleration: { unit: 'g', display: 'Acceleration (g)', default: true },
    'Angular Velocity': { unit: '°/s', display: 'Angular Velocity (°/s)', default: true },
    Speed: { unit: 'km/h', display: 'Speed (km/h)', default: true },

    /* not marked default: removable from the UI, but restored by "reset". */
    Current: { unit: 'A', display: 'Current (A)' },
    Torque: { unit: 'N·m', display: 'Torque (N·m)' },
    Force: { unit: 'N', display: 'Force (N)' },
    'Rotational Speed': { unit: 'rpm', display: 'Rotational Speed (rpm)' },
    Ratio: { unit: '%', display: 'Ratio (%)' },
    Power: { unit: 'kW', display: 'Power (kW)' },
    Energy: { unit: 'Wh', display: 'Energy (Wh)' },
    Pressure: { unit: 'bar', display: 'Pressure (bar)' },
    Distance: { unit: 'm', display: 'Distance (m)' }
});

export const defaults = {
    views: JSON.parse(JSON.stringify(views)),
    units: JSON.parse(JSON.stringify(units))
};

export const can_decoder = reactive({});

function load_decoder() {
    // First pass: group decoders by CAN ID
    Object.entries(views.can.view).forEach(([k, v]) => {
        if (!can_decoder[v.id]) {
            can_decoder[v.id] = [];
        }

        const entry = { name: k, ...v };
        entry.offset = v.offset ?? 0;

        if (v.filter && v.mask) {
            entry._filter = parse_hex_bytes(v.filter);
            entry._mask = parse_hex_bytes(v.mask);
        }

        can_decoder[v.id].push(entry);
    });

    // Second pass: assign idx in can_decoder iteration order
    // Object.entries() sorts integer keys numerically, which is the same
    // order used when building chart series in telemetry.vue and viewer.vue
    let idx = 1;
    for (const decoders of Object.values(can_decoder)) {
        for (const decoder of decoders) {
            decoder.idx = idx++;
        }
    }
}

/* CAN channels grouped by unit. one chart per group keeps each plot down to a
 * handful of series that share a scale, instead of every decoded channel of
 * every frame piled onto one axis. */
export function can_unit_groups() {
    const groups = {};

    Object.values(can_decoder).forEach((decoders) => {
        decoders.forEach((decoder) => {
            const unit = decoder.unit || 'Volt';

            if (!groups[unit]) {
                groups[unit] = [];
            }

            groups[unit].push(decoder);
        });
    });

    return groups;
}

let save_timer = null;

function debounced_save() {
    clearTimeout(save_timer);
    save_timer = setTimeout(save_view, 500);
}

watch(views, debounced_save, { deep: true });
watch(units, debounced_save, { deep: true });

load_view();
load_decoder();

export function save_view() {
    localStorage.setItem('views', JSON.stringify(views));
    localStorage.setItem('units', JSON.stringify(units));
}

export function load_view() {
    const v = localStorage.getItem('views');
    const u = localStorage.getItem('units');

    if (v) {
        const parsed = JSON.parse(v);

        for (const key in parsed) {
            if (views[key]) {
                Object.assign(views[key], parsed[key]);
            } else {
                views[key] = parsed[key];
            }
        }
    }

    if (u) {
        const parsed = JSON.parse(u);

        for (const key in parsed) {
            if (units[key]) {
                Object.assign(units[key], parsed[key]);
            } else {
                units[key] = parsed[key];
            }
        }
    }
}

const color_cnt = 50;

export const colors = Array.from({ length: color_cnt }, (_, i) => {
    const hue = (i * 137.508) % 360;
    const saturation = 70;
    const lightness = 50;
    const [r, g, b] = hsl_to_rgb(hue, saturation, lightness);
    return rgb_to_hex(r, g, b);
});

function hsl_to_rgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function rgb_to_hex(r, g, b) {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
