<script setup>
defineOptions({ name: 'Telemetry' });

import { ref, onMounted, watch, nextTick } from 'vue';
import { dark } from '@/layout/composables/layout';
import { publish } from '@/service/mqtt';
import { term } from '@/service/terminal';
import { state, times, cons, telemetry, fmt, digit, can_slice } from '@/service/state';
import { views, units, can_decoder, can_unit_groups, colors } from '@/service/ui';
import { map, line, path, speed, course, fix, dirty, hotlineMode, switchHotlineMode } from '@/service/telemetry';
import { init_map, HOTLINE_MODE } from '@/service/map';

import ToastEventBus from 'primevue/toasteventbus';

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import dayjs from 'dayjs/esm';

const terminal = ref(null);
const container = {
    state: ref(null),
    analog: ref(null),
    gyro: ref(null),
    gps: ref(null)
};

/* the CAN plot is split one-chart-per-unit: computed here, at setup time,
 * so the containers exist in the DOM by the time init_chart() runs. */
const can_groups = can_unit_groups();
const can_containers = {};

/* every telemetry chart shares one cursor, so splitting by unit does not
 * cost the ability to line channels up against each other across charts. */
const cursor_sync = {
    sync: { key: uPlot.sync('telemetry').key, setSeries: false }
};

/* CAN charts sit in a grid so related units can be read side by side instead
 * of scrolling between stacked charts. The column count is a per-browser
 * preference. */
const CAN_COL_OPTIONS = [1, 2, 3].map((n) => ({ label: `${n}열`, value: n }));

function load_can_cols() {
    try {
        const n = Number(localStorage.getItem('telemetry/can_cols'));
        return [1, 2, 3].includes(n) ? n : 2;
    } catch {
        return 2;
    }
}

const can_cols = ref(load_can_cols());
const can_grid = ref(null);

watch(can_cols, (n) => {
    try {
        localStorage.setItem('telemetry/can_cols', String(n));
    } catch {
        /* storage unavailable: keep the choice for this page only */
    }
    nextTick(resize_charts);
});

/* each chart takes the width of its own container: full card width for
 * analog/gyro, one grid cell for CAN. */
function chart_host(key) {
    const [group, unit] = key.split(':');
    return unit ? can_containers[unit] : container[group]?.value;
}

function resize_charts() {
    Object.entries(telemetry.chart).forEach(([key, chart]) => {
        const width = chart_host(key)?.clientWidth;

        if (width && width !== chart.width) {
            chart.setSize({ width, height: width * 0.6 });
        }
    });
}

onMounted(() => {
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminal.value);
    fit.fit();
    window.addEventListener('resize', () => fit.fit());

    init_map(map, line, path, container.gps, hotlineMode.value);

    init_chart();
});

const axis = {
    temp: { splits: [], min: 0, max: 0 },
    accel: { splits: [], min: 0, max: 0 },
    gyro: { splits: [], min: 0, max: 0 }
};

function init_chart() {
    Object.keys(telemetry.chart).forEach((key) => {
        telemetry.chart[key]?.destroy();
        delete telemetry.chart[key];
    });

    const scales = {};
    const axes = [
        {
            size: 35,
            values: (u, v) => v.map((x) => dayjs(x * 1000).format('HH:mm:ss')),
            stroke: () => (dark.value ? '#fff' : '#000'),
            ticks: { stroke: () => (dark.value ? '#24282b' : '#ededed') },
            grid: { stroke: () => (dark.value ? '#24282b' : '#ededed') }
        }
    ];

    for (const [i, [k, o]] of Object.entries(units).entries()) {
        axis[k] = { splits: [], min: 0, max: 0 };

        scales[k] = {
            range: (u, d_min, d_max) => {
                if (d_min === null && d_max === null) {
                    return [null, null];
                } else {
                    axis[k] = split_range(d_min, d_max);
                    return [axis[k].min, axis[k].max];
                }
            }
        };

        axes.push({
            scale: k,
            side: i % 2 ? 1 : 3,
            size: 50 + (o.unit.length - 1) * 5,
            values: (u, v) => v.map((x) => `${digit(x)}${o.unit}`),
            splits: () => axis[k].splits,
            stroke: () => (dark.value ? '#fff' : '#000'),
            ticks: { stroke: () => (dark.value ? '#24282b' : '#ededed') },
            grid: { stroke: () => (dark.value ? '#24282b' : '#ededed') }
        });

        fmt[k] = (u, v, sidx, didx) => {
            const d = u.data[sidx];

            if (didx == null && d) {
                const i = d.findLastIndex((x) => x !== null);

                if (i !== -1) {
                    v = d[i];
                } else {
                    v = d[d.length - 1];
                }
            }

            if (isNaN(v) || v === null || v === undefined) {
                return '-';
            } else {
                return `${digit(v)} ${o.unit}`;
            }
        };
    }

    const initWidth = container.state.value?.clientWidth || 600;

    telemetry.chart.analog = new uPlot(
        {
            width: initWidth,
            height: initWidth * 0.6,
            pxAlign: 0,
            pxSnap: false,
            cursor: cursor_sync,
            scales: scales,
            series: [
                { value: fmt.time },
                { label: views.analog.ch.ain1.name, stroke: colors[0], value: fmt[views.analog.ch.ain1.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain1.unit || 'Volt' },
                { label: views.analog.ch.ain2.name, stroke: colors[1], value: fmt[views.analog.ch.ain2.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain2.unit || 'Volt' },
                { label: views.analog.ch.ain3.name, stroke: colors[2], value: fmt[views.analog.ch.ain3.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain3.unit || 'Volt' },
                { label: views.analog.ch.ain4.name, stroke: colors[3], value: fmt[views.analog.ch.ain4.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain4.unit || 'Volt' },
                { label: views.analog.ch.ain5.name, stroke: colors[4], value: fmt[views.analog.ch.ain5.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain5.unit || 'Volt' },
                { label: views.analog.ch.ain6.name, stroke: colors[5], value: fmt[views.analog.ch.ain6.unit], points: { show: false }, pxAlign: 0, scale: views.analog.ch.ain6.unit || 'Volt' },
                { label: views.analog.ch.volt.name, stroke: colors[6], value: fmt.Volt, points: { show: false }, pxAlign: 0, scale: 'Volt' },
                { label: views.analog.ch.temp.name, stroke: colors[7], value: fmt.Temperature, points: { show: false }, pxAlign: 0, scale: 'Temperature', show: false }
            ],
            axes: axes
        },
        telemetry.analog,
        container.analog.value
    );

    telemetry.chart.gyro = new uPlot(
        {
            width: initWidth,
            height: initWidth * 0.6,
            pxAlign: 0,
            pxSnap: false,
            cursor: cursor_sync,
            scales: scales,
            series: [
                { value: fmt.time },
                { label: 'Ax', stroke: colors[0], value: fmt.Acceleration, points: { show: false }, pxAlign: 0, scale: 'Acceleration' },
                { label: 'Ay', stroke: colors[1], value: fmt.Acceleration, points: { show: false }, pxAlign: 0, scale: 'Acceleration' },
                { label: 'Az', stroke: colors[2], value: fmt.Acceleration, points: { show: false }, pxAlign: 0, scale: 'Acceleration' },
                { label: 'Gx', stroke: colors[3], value: fmt['Angular Velocity'], points: { show: false }, pxAlign: 0, scale: 'Angular Velocity' },
                { label: 'Gy', stroke: colors[4], value: fmt['Angular Velocity'], points: { show: false }, pxAlign: 0, scale: 'Angular Velocity' },
                { label: 'Gz', stroke: colors[5], value: fmt['Angular Velocity'], points: { show: false }, pxAlign: 0, scale: 'Angular Velocity' }
            ],
            axes: axes
        },
        telemetry.gyro,
        container.gyro.value
    );

    /* one chart per unit. every series on a chart shares a scale, so channels
     * of the same unit are directly comparable, and no chart carries more
     * than its own unit's handful of channels. */
    telemetry.can_index = {};

    for (const [unit, decoders] of Object.entries(can_groups)) {
        const el = can_containers[unit];

        if (!el) {
            continue;
        }

        const series = [{ value: fmt.time }];

        decoders.forEach((decoder, i) => {
            series.push({
                label: decoder.name,
                stroke: colors[i],
                value: fmt[unit],
                points: { show: false },
                pxAlign: 0,
                scale: unit,
                spanGaps: true
            });
        });

        // column indices into telemetry.can, in this chart's series order
        telemetry.can_index[unit] = decoders.map((decoder) => decoder.idx);

        const cellWidth = el.clientWidth || initWidth;

        telemetry.chart[`can:${unit}`] = new uPlot(
            {
                width: cellWidth,
                height: cellWidth * 0.6,
                pxAlign: 0,
                pxSnap: false,
                cursor: cursor_sync,
                scales: scales,
                series: series,
                axes: axes,
                hooks: {
                    // full channel name on hover for labels cut by the legend width
                    init: [(u) => u.root.querySelectorAll('.u-legend .u-label').forEach((l) => (l.title = l.textContent))]
                }
            },
            can_slice(unit),
            el
        );
    }

    function tick() {
        const now = Date.now() / 1000;
        const scale = { min: now - 60, max: now };

        for (const [key, chart] of Object.entries(telemetry.chart)) {
            // per-unit CAN charts are keyed `can:<unit>` and share the can dirty flag
            const [group, unit] = key.split(':');

            if (dirty[group]) {
                chart.batch(() => {
                    chart.setData(unit ? can_slice(unit) : telemetry[key]);
                    chart.setScale('x', scale);
                });
            } else {
                chart.setScale('x', scale);
            }
        }

        Object.keys(dirty).forEach((key) => (dirty[key] = false));

        requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);

    // the card width and the CAN grid cells do not always settle together
    const observer = new ResizeObserver(resize_charts);
    observer.observe(container.state.value);
    if (can_grid.value) observer.observe(can_grid.value);
    nextTick(resize_charts);
}

function split_range(d_min, d_max) {
    if (d_min === d_max) {
        d_min *= 0.85;
        d_max *= 1.15;
    }

    const tick = 5;
    const step = (d_max - d_min) / (tick - 1);
    const min = Math.floor(d_min / step) * step;
    const max = min + step * tick;
    const splits = Array.from({ length: tick + 1 }, (_, i) => min + i * step);
    return { min, max, splits };
}

function send_usrevt() {
    cons.usrevt = cons.usrevt
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
        .slice(0, 16);

    if (cons.usrevt.length === 0) {
        cons.usrevt = 'USREVT';
    }

    publish('cmd/evt', cons.usrevt, 1);
}

function send_can() {
    const id = parseInt(cons.can.id.trim(), 16);

    if (isNaN(id)) {
        return ToastEventBus.emit('add', { severity: 'error', summary: 'Invalid CAN ID', group: 'br', life: 3000 });
    }

    if (id < 0 || id > (1 << 29) - 1) {
        return ToastEventBus.emit('add', {
            severity: 'error',
            summary: 'CAN ID out of range',
            detail: 'ID must be within 29 bits.',
            group: 'br',
            life: 3000
        });
    }

    const payload = new Uint8Array(8);

    for (let i = 0; i < cons.can.data.length; i++) {
        if (cons.can.data[i].trim() === '') {
            cons.can.data[i] = '00';
        }

        const v = parseInt(cons.can.data[i].trim(), 16);

        if (isNaN(v) || v < 0 || v > 255) {
            return ToastEventBus.emit('add', {
                severity: 'error',
                summary: `Invalid CAN Data Byte D${i}`,
                group: 'br',
                life: 3000
            });
        }

        payload[i] = v;
    }

    publish(`cmd/can/${id}`, payload, 1);
}

function ascii_only(event) {
    if (!/^[\x20-\x7E]*$/.test(event.target.value)) {
        event.target.value = event.target.value.replace(/[^\x20-\x7E]/g, '');
    }
}

function hex_only(event) {
    if (!/^[0-9A-Fa-fx]*$/.test(event.target.value)) {
        event.target.value = event.target.value.replace(/[^0-9A-Fa-fx]/g, '');
    }
}
</script>

<template>
    <div class="grid grid-cols-12 gap-8">
        <div class="col-span-full lg:col-span-12">
            <div class="card" :ref="container.state">
                <div class="font-semibold text-xl mb-6">System State</div>
                <div v-for="(tag, key) in times" :key="key" class="flex items-center mb-6">
                    <span class="w-24 font-medium">{{ tag.label }}</span>
                    <Tag :value="tag.value" :severity="tag.severity || 'info'" class="timetag" />
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4 text-sm">
                    <template v-for="item in state" :key="item.name">
                        <div v-if="item.name" class="flex items-center cardview">
                            <span class="w-full">{{ item.name }}</span>
                            <Tag :value="item.text" :severity="item.status" class="ml-2 state" />
                        </div>
                    </template>
                </div>
            </div>

            <div v-if="views.digital.display.telemetry" class="card">
                <div class="font-semibold text-xl mb-6">Digital</div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    <template v-for="(tag, key) in telemetry.digital" :key="key">
                        <div class="flex items-center cardview">
                            <span class="w-full">{{ views.digital.ch[key].name }}</span>
                            <Tag :value="tag ? 'HIGH' : 'LOW'" :severity="tag ? 'info' : 'danger'" />
                        </div>
                    </template>
                </div>
            </div>

            <div v-if="views.analog.display.telemetry" class="card">
                <div class="font-semibold text-xl mb-4">Analog</div>
                <div class="chart" :ref="container.analog"></div>
            </div>

            <div v-if="views.gyro.display.telemetry" class="card">
                <div class="font-semibold text-xl mb-4">Gyroscope</div>
                <div class="chart" :ref="container.gyro"></div>
            </div>

            <div v-if="views.can.display.telemetry && Object.keys(can_decoder).length" class="card">
                <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
                    <div class="font-semibold text-xl">CAN</div>
                    <SelectButton v-model="can_cols" :options="CAN_COL_OPTIONS" optionLabel="label" optionValue="value" :allowEmpty="false" size="small" />
                </div>
                <div ref="can_grid" class="grid gap-x-6 gap-y-8" :style="{ gridTemplateColumns: `repeat(${can_cols}, minmax(0, 1fr))` }">
                    <div v-for="(decoders, unit) in can_groups" :key="unit" class="min-w-0">
                        <div class="text-sm text-gray-500 mb-2">{{ units[unit] ? units[unit].display : unit }}</div>
                        <div class="chart overflow-hidden" :ref="(el) => (can_containers[unit] = el)"></div>
                    </div>
                </div>
            </div>

            <div v-if="views.gps.display.telemetry" class="card" style="position: relative">
                <div class="font-semibold text-xl mb-6">GPS</div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mb-6">
                    <div class="flex items-center">
                        <span class="w-20 font-medium">Fix</span>
                        <Tag :value="fix ? 'Fix' : 'No Fix'" :severity="fix ? 'success' : 'warn'" class="ml-2 state" />
                    </div>
                    <div class="flex items-center">
                        <span class="w-20 font-medium">Speed</span>
                        <Tag :value="speed" severity="info" class="ml-2 state timetag" />
                    </div>
                    <div class="flex items-center">
                        <span class="w-20 font-medium">Course</span>
                        <Tag :value="course" severity="info" class="ml-2 state timetag" />
                    </div>
                    <div class="flex items-center">
                        <span class="w-20 font-medium">Trail</span>
                        <SelectButton
                            :modelValue="hotlineMode"
                            @update:modelValue="switchHotlineMode"
                            :options="[{ label: 'Speed', value: HOTLINE_MODE.SPEED }, { label: 'Time', value: HOTLINE_MODE.TIME }]"
                            optionLabel="label"
                            optionValue="value"
                            :allowEmpty="false"
                            class="ml-2"
                        />
                    </div>
                </div>
                <div>
                    <div :ref="container.gps" style="width: 100%; aspect-ratio: 1 / 0.7"></div>
                </div>
            </div>

            <div class="card">
                <div class="font-semibold text-xl mb-6">Console</div>
                <div class="mb-6">
                    <label>Transmit User Event</label>
                    <InputGroup class="mt-4 mb-3">
                        <InputText v-model="cons.usrevt" placeholder="(default: USREVT)" maxlength="16" @keyup="ascii_only" />
                        <Button icon="pi pi-send" @click="send_usrevt" />
                    </InputGroup>
                    <Message size="small" severity="secondary" variant="simple">Only ASCII characters up to 16 bytes.</Message>
                </div>
                <div>
                    <label>Transmit CAN Message</label>
                    <InputGroup class="mt-4 mb-2">
                        <InputText v-model="cons.can.id" placeholder="CAN Message ID" maxlength="10" @keyup="hex_only" />
                        <Button icon="pi pi-send" @click="send_can" />
                    </InputGroup>
                    <InputGroup class="mt-4 mb-3">
                        <InputText v-model="cons.can.data[n - 1]" v-for="n in 8" :key="n" :placeholder="`D${n - 1}`" maxlength="4" @keyup="hex_only" class="can_data" />
                    </InputGroup>
                    <Message size="small" severity="secondary" variant="simple">CAN msg ID and data bytes in HEX format.</Message>
                </div>
            </div>

            <div class="card">
                <div class="font-semibold text-xl mb-6">System Events</div>
                <div ref="terminal" class="text-sm"></div>
            </div>
        </div>
    </div>
</template>

<style>
.xterm {
    padding: 0.5rem 0.7rem;
    border-radius: 1rem;
    height: 20rem;
}

.xterm-viewport {
    border-radius: 0.5rem;
    height: 100%;
}

.state .p-tag-label {
    font-size: 0.75rem;
}

.timetag .p-tag-label {
    font-size: 0.95rem;
}

.can_data {
    font-size: 0.9rem !important;
    height: 2.25rem;
}
</style>
