<script setup>
import { ref, reactive, computed } from 'vue';
import { views, units, defaults } from '@/service/ui';

import { useConfirm } from 'primevue/useconfirm';
import ToastEventBus from 'primevue/toasteventbus';

const confirm = useConfirm();

const new_unit = ref({ name: '', unit: '' });

const analogs = Object.keys(views.analog.ch)
    .filter((key) => key.includes('ain'))
    .reduce((o, k) => {
        o[k] = views.analog.ch[k];
        return o;
    }, {});

const unit_options = computed(() => {
    return Object.entries(units).map(([name, { unit, display }]) => ({ name, unit, display }));
});

const can_views = computed(() => {
    return Object.entries(views.can.view).map(([name, v]) => ({
        name,
        id: v.id,
        unit: v.unit,
        mode: v.mode,
        start: v.start,
        end: v.end,
        endian: v.mode === 'byte' ? v.endian : null
    }));
});

const file = ref('');

const display_import = ref(false);
const display_can_view = ref(false);

const can_cfg = reactive({
    name: '',
    id: '',
    multiplier: 1,
    offset: 0,
    unit: null,
    mode: 'byte',
    sign: false,
    start: 0,
    end: 0,
    endian: 'little',
    filter: '',
    mask: ''
});

const sign_options = [
    { label: 'Unsigned', value: false },
    { label: 'Signed', value: true }
];
const bitwise_options = [
    { label: 'Byte', value: 'byte' },
    { label: 'Bit', value: 'bit' }
];
const endian_options = [
    { label: 'Little Endian', value: 'little' },
    { label: 'Big Endian', value: 'big' }
];
const errors = reactive({ name: '', id: '', multiplier: '', offset: '', unit: '', range: '', filter: '' });

const can_formula = computed(() => {
    const a = can_cfg.multiplier;
    const b = can_cfg.offset;
    let s = 'y = ';

    if (!Number.isFinite(a)) {
        s += '?x';
    } else if (a === 1) {
        s += 'x';
    } else {
        s += a + 'x';
    }

    if (!Number.isFinite(b)) {
        s += ' + ?';
    } else if (b !== 0) {
        s += b > 0 ? ` + ${b}` : ` − ${Math.abs(b)}`;
    }

    return s;
});

function save_cfg() {
    can_cfg.name = can_cfg.name.trim();
    errors.name = can_cfg.name ? '' : 'Please fill in the name.';

    const id = parseInt(can_cfg.id.trim(), 16);

    errors.id = id ? '' : 'Please fill in the ID (HEX).';
    errors.id = !(id < 0 || id > (1 << 29) - 1) ? errors.id : 'ID must be within 29 bits.';
    errors.multiplier = can_cfg.multiplier ? '' : 'Invalid multiplier.';
    errors.offset = Number.isFinite(can_cfg.offset) ? '' : 'Invalid offset.';
    errors.unit = can_cfg.unit ? '' : 'Please select a unit.';

    const max = can_cfg.mode === 'byte' ? 7 : 63;

    errors.range = can_cfg.start === '' || can_cfg.end === '' || can_cfg.start < 0 || can_cfg.end < 0 || can_cfg.start > max || can_cfg.end > max || can_cfg.start > can_cfg.end ? `Range must be within 0 ~ ${max}.` : '';

    const filter_str = can_cfg.filter.trim().replace(/^0x/i, '');
    const mask_str = can_cfg.mask.trim().replace(/^0x/i, '');
    const has_filter = filter_str || mask_str;
    const hex_re = /^[0-9a-fA-F]{1,16}$/;

    if (has_filter) {
        if (!filter_str || !mask_str) {
            errors.filter = 'Both filter and mask are required.';
        } else if (!hex_re.test(filter_str) || !hex_re.test(mask_str)) {
            errors.filter = 'Invalid hex value.';
        } else {
            errors.filter = '';
        }
    } else {
        errors.filter = '';
    }

    if (!errors.name && !errors.id && !errors.multiplier && !errors.offset && !errors.unit && !errors.range && !errors.filter) {
        const cfg = {
            id: id,
            multiplier: can_cfg.multiplier,
            offset: can_cfg.offset,
            unit: can_cfg.unit,
            mode: can_cfg.mode,
            sign: can_cfg.sign,
            start: can_cfg.start,
            end: can_cfg.end,
            endian: can_cfg.mode === 'byte' ? can_cfg.endian : null
        };

        if (has_filter) {
            cfg.filter = filter_str.toLowerCase();
            cfg.mask = mask_str.toLowerCase();
        }

        views.can.view[can_cfg.name] = cfg;

        display_can_view.value = false;
    }
}

function import_cfg(f) {
    f = f.files[0];

    if (!f) {
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            Object.assign(views, data.views);
            Object.assign(units, data.units);
            ToastEventBus.emit('add', { severity: 'success', summary: 'Configuration Imported', group: 'br', life: 5000 });
            display_import.value = false;
            window.location.reload();
        } catch (error) {
            ToastEventBus.emit('add', { severity: 'error', summary: 'Invalid Configuration File', group: 'br', life: 5000 });
        }
    };
    reader.readAsText(f);
    file.value = f.name;
}

function reset_cfg() {
    confirm.require({
        header: 'UI Reset Confirmation',
        message: 'Reset the UI configuration to default?',
        icon: 'pi pi-exclamation-triangle',
        rejectProps: {
            label: 'Cancel',
            severity: 'secondary',
            outlined: true
        },
        acceptProps: {
            label: 'Reset',
            severity: 'danger'
        },
        accept: () => {
            Object.keys(views).forEach((key) => delete views[key]);
            Object.keys(units).forEach((key) => delete units[key]);
            Object.assign(views, defaults.views);
            Object.assign(units, defaults.units);
            ToastEventBus.emit('add', { severity: 'success', summary: 'UI Reset Done', group: 'br', life: 5000 });
            window.location.reload();
        }
    });
}

function can_add() {
    clear_errors();
    can_cfg.name = '';
    can_cfg.id = '';
    can_cfg.multiplier = 1;
    can_cfg.offset = 0;
    can_cfg.unit = null;
    can_cfg.mode = 'byte';
    can_cfg.sign = false;
    can_cfg.start = 0;
    can_cfg.end = 0;
    can_cfg.endian = 'little';
    can_cfg.filter = '';
    can_cfg.mask = '';
    display_can_view.value = true;
}

function can_edit(name) {
    clear_errors();
    const view = views.can.view[name];
    can_cfg.name = name;
    can_cfg.id = '0x' + view.id.toString(16).toUpperCase();
    can_cfg.multiplier = view.multiplier;
    can_cfg.offset = view.offset ?? 0;
    can_cfg.unit = view.unit;
    can_cfg.mode = view.mode;
    can_cfg.sign = view.sign;
    can_cfg.start = view.start;
    can_cfg.end = view.end;
    can_cfg.endian = view.endian || 'little';
    can_cfg.filter = view.filter ? '0x' + view.filter.toUpperCase() : '';
    can_cfg.mask = view.mask ? '0x' + view.mask.toUpperCase() : '';
    display_can_view.value = true;
}

function can_delete(name) {
    delete views.can.view[name];
}

function clear_errors() {
    errors.name = '';
    errors.id = '';
    errors.multiplier = '';
    errors.offset = '';
    errors.unit = '';
    errors.range = '';
    errors.filter = '';
}

function add_unit() {
    const name = new_unit.value.name.trim();
    const unit = new_unit.value.unit.trim();

    if (!name || !unit) {
        return;
    }

    if (units[name]) {
        ToastEventBus.emit('add', { severity: 'error', summary: 'Unit Already Exists', group: 'br', life: 5000 });
        return;
    }

    units[name] = { unit: unit, display: `${name} (${unit})` };
    new_unit.value.name = '';
    new_unit.value.unit = '';
}

function remove_unit(key) {
    if (units[key].default) {
        return ToastEventBus.emit('add', { severity: 'error', summary: 'Cannot Remove Default Unit', group: 'br', life: 5000 });
    }

    if (Object.values(views.analog.ch).some((ch) => ch.unit === key)) {
        return ToastEventBus.emit('add', { severity: 'error', summary: 'Unit In Use (Analog)', group: 'br', life: 5000 });
    }

    let flag = false;

    Object.entries(views.can.view).forEach(([k, v]) => {
        if (v.unit === key) {
            flag = true;
        }
    });

    if (flag) {
        return ToastEventBus.emit('add', { severity: 'error', summary: 'Unit In Use (CAN)', group: 'br', life: 5000 });
    }

    delete units[key];
}

function export_cfg() {
    const data = JSON.stringify({ views: views, units: units }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
</script>

<template>
    <Fluid>
        <div class="flex flex-col md:flex-row gap-8">
            <div class="md:w-1/2">
                <div class="card flex flex-col gap-6">
                    <div class="font-semibold text-xl">Import / Export Configurations</div>
                    <span><span class="pi pi-info-circle mr-2"></span> Refresh the page to apply changes.</span>
                    <div class="flex gap-6">
                        <Button class="flex-1" label="Import" icon="pi pi-file-import" severity="success" @click="display_import = true" />
                        <Button class="flex-1" label="Export" icon="pi pi-file-export" severity="info" @click="export_cfg" />
                        <Button class="flex-1" label="Reset" icon="pi pi-sparkles" severity="danger" @click="reset_cfg" />
                    </div>
                </div>

                <div class="card flex flex-col gap-4">
                    <div class="font-semibold text-xl mb-2">Display</div>
                    <div>
                        <div class="text-lg font-semibold">Telemetry</div>
                        <ul class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <template v-for="(view, key) in views" :key="key">
                                <li class="flex items-center justify-between cardview">
                                    <label :for="key" class="font-medium pr-3">{{ view.name }}</label>
                                    <ToggleSwitch :inputId="key" v-model="view.display.telemetry" />
                                </li>
                            </template>
                        </ul>
                    </div>
                    <div>
                        <div class="text-lg font-semibold">Viewer</div>
                        <ul class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <li class="flex items-center justify-between cardview">
                                <label for="viewer-gps" class="font-medium pr-3">GPS</label>
                                <ToggleSwitch inputId="viewer-gps" v-model="views.gps.display.viewer" />
                            </li>
                            <li class="flex items-center justify-between cardview">
                                <label for="viewer-can" class="font-medium pr-3">CAN</label>
                                <ToggleSwitch inputId="viewer-can" v-model="views.can.display.viewer" />
                            </li>
                        </ul>
                    </div>
                </div>

                <div class="card flex flex-col gap-4">
                    <div class="font-semibold text-xl">Units</div>
                    <InputGroup class="mt-2">
                        <InputText id="new_name" v-model="new_unit.name" placeholder="Name" />
                        <InputText id="new_unit" v-model="new_unit.unit" placeholder="Unit" />
                        <Button icon="pi pi-plus" @click="add_unit" />
                    </InputGroup>
                    <div class="mt-2 flex flex-wrap gap-4">
                        <Tag v-for="(u, key) in units" :key="key" :value="u.display" :severity="u.default ? 'success' : 'primary'" class="text-lg cursor-pointer [user-select:none]" @click="remove_unit(key)" />
                    </div>
                </div>

                <div class="card flex flex-col gap-4">
                    <div class="font-semibold text-xl mb-2">Digital</div>
                    <DataView :value="Object.entries(views.digital.ch)" layout="grid">
                        <template #grid="{ items }">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div v-for="[key, channel] in items" :key="key" class="cardview">
                                    <div class="flex items-center justify-between mb-3">
                                        <div class="flex items-center gap-2">
                                            <span class="px-2 py-1 text-base font-semibold uppercase">{{ key }}</span>
                                        </div>
                                    </div>
                                    <label :for="`${key}-name`" class="text-xs opacity-70 block">Name</label>
                                    <InputText :id="`${key}-name`" v-model="channel.name" placeholder="Channel name" class="w-full text-base font-medium mt-1" :fluid="true" />
                                </div>
                            </div>
                        </template>
                    </DataView>
                </div>
            </div>

            <div class="md:w-1/2">
                <div class="card flex flex-col gap-4">
                    <div class="font-semibold text-xl mb-2">Analog</div>
                    <DataView :value="Object.entries(analogs)" layout="grid">
                        <template #grid="{ items }">
                            <div class="grid grid-cols-1 gap-6">
                                <div v-for="[key, channel] in items" :key="key" class="cardview">
                                    <div class="flex items-center justify-between mb-3">
                                        <div class="flex items-center gap-2">
                                            <span class="px-2 py-1 text-base font-semibold uppercase">{{ key }}</span>
                                        </div>

                                        <div v-if="['ain1', 'ain2', 'ain3', 'ain4'].includes(key)" class="flex items-center gap-2">
                                            <label class="text-xs opacity-70">Voltage Divider</label>
                                            <ToggleSwitch v-model="channel.divider" />
                                        </div>
                                    </div>
                                    <label :for="`${key}-name`" class="text-xs opacity-70">Name</label>
                                    <InputText :id="`${key}-name`" v-model="channel.name" placeholder="Channel name" class="w-full text-base font-medium mt-1" :fluid="true" />
                                    <div class="mt-3 grid grid-cols-12 gap-2 items-end">
                                        <div class="col-span-6">
                                            <label :for="`${key}-mul`" class="text-xs opacity-70">Multiplier</label>
                                            <div class="flex items-end mt-1">
                                                <input :id="`${key}-mul`" v-model.number="channel.multiplier" type="number" step="0.001" class="w-20 p-inputtext p-component" />
                                                <span class="ml-1 mb-1 text-sm opacity-70">x</span>
                                            </div>
                                        </div>
                                        <div class="col-span-6">
                                            <label class="text-xs opacity-70">Unit</label>
                                            <Select v-model="channel.unit" :options="unit_options" optionLabel="display" optionValue="name" placeholder="Select unit" class="w-full mt-1" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </DataView>
                </div>

                <div class="card flex flex-col gap-4">
                    <div class="font-semibold text-xl mb-2">CAN</div>
                    <Button label="Add Message Decoder" icon="pi pi-plus" @click="can_add" />
                    <DataView v-if="can_views.length" :value="can_views">
                        <template #list="{ items }">
                            <div class="flex flex-col gap-4 mt-2">
                                <div v-for="item in items" :key="item.name" class="flex items-center justify-between cardview">
                                    <div class="flex flex-col">
                                        <div class="text-lg font-semibold leading-tight">{{ item.name }}</div>
                                        <div class="text-xs opacity-70 leading-tight">0x{{ item.id.toString(16).toUpperCase() }}</div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <Button icon="pi pi-pencil" size="small" severity="warn" text @click="can_edit(item.name)" />
                                        <Button icon="pi pi-trash" size="small" severity="danger" text @click="can_delete(item.name)" />
                                    </div>
                                </div>
                            </div>
                        </template>
                    </DataView>
                </div>
            </div>

            <ConfirmDialog style="maxwidth: 400px" />

            <Dialog v-model:visible="display_import" modal header="Import UI Configurations" :style="{ width: '25rem' }">
                <div class="flex justify-start mt-4 w-full" style="align-items: center">
                    <FileUpload mode="basic" accept=".json" @uploader="import_cfg" :auto="true" customUpload chooseIcon="pi pi-file" chooseLabel="Select" />
                    <span class="ml-4"> {{ file.value ? file.value : 'Select a file to import' }}</span>
                </div>
            </Dialog>

            <Dialog v-model:visible="display_can_view" modal header="CAN Message Decoder" :style="{ width: '25rem' }">
                <div class="flex flex-col gap-4">
                    <div class="grid grid-cols-12 gap-4 items-center">
                        <div class="col-span-6">
                            <label for="can_name" class="text-xs opacity-70">Name</label>
                            <InputText id="can_name" v-model="can_cfg.name" class="mt-1 mb-1" :invalid="!!errors.name" />
                            <small v-if="errors.name" class="text-red-500">{{ errors.name }}</small>
                        </div>
                        <div class="col-span-6">
                            <label for="can_id" class="text-xs opacity-70">CAN Message ID (HEX)</label>
                            <InputText id="can_id" v-model="can_cfg.id" class="mt-1 mb-1" :invalid="!!errors.id" />
                            <small v-if="errors.id" class="text-red-500">{{ errors.id }}</small>
                        </div>
                    </div>
                    <div class="grid grid-cols-12 gap-4 items-center">
                        <div class="col-span-12">
                            <label class="text-xs opacity-70">Unit</label>
                            <Select v-model="can_cfg.unit" :options="unit_options" optionLabel="display" optionValue="name" :invalid="!!errors.unit" placeholder="Select unit" class="w-full mt-1" />
                            <small v-if="errors.unit" class="text-red-500">{{ errors.unit }}</small>
                        </div>
                    </div>
                    <div class="grid grid-cols-12 gap-4 items-end">
                        <div class="col-span-3">
                            <label for="can_multiplier" class="text-xs opacity-70">Multiplier</label>
                            <div class="flex items-end mt-1 mb-1">
                                <input id="can_multiplier" v-model.number="can_cfg.multiplier" type="number" step="0.001" class="flex-1 min-w-0 p-inputtext p-component" />
                                <span class="ml-1 mb-1 text-sm opacity-70">x</span>
                            </div>
                        </div>
                        <div class="col-span-3">
                            <label for="can_offset" class="text-xs opacity-70">Offset</label>
                            <div class="flex items-end mt-1 mb-1">
                                <input id="can_offset" v-model.number="can_cfg.offset" type="number" step="0.001" class="flex-1 min-w-0 p-inputtext p-component" />
                                <span class="ml-1 mb-1 text-sm opacity-70">+</span>
                            </div>
                        </div>
                        <div class="col-span-6 text-right truncate font-serif italic text-lg opacity-80 mb-2">{{ can_formula }}</div>
                        <small v-if="errors.multiplier" class="text-red-500 col-span-3">{{ errors.multiplier }}</small>
                        <small v-if="errors.offset" class="text-red-500 col-span-3 col-start-4">{{ errors.offset }}</small>
                    </div>

                    <div class="grid grid-cols-12 gap-4 items-end">
                        <div class="col-span-5">
                            <label class="text-xs opacity-70">Data Range</label>
                            <SelectButton v-model="can_cfg.mode" :options="bitwise_options" optionLabel="label" optionValue="value" :allowEmpty="false" class="mt-2" />
                        </div>
                        <div class="col-start-6 col-span-7">
                            <div class="flex items-center gap-2 mt-2">
                                #
                                <input id="can_range_start" v-model.number="can_cfg.start" type="number" class="w-12 p-inputtext p-component p-filled" :invalid="!!errors.range" />
                                <span class="ml-2 mr-2">~</span>
                                #
                                <input id="can_range_end" v-model.number="can_cfg.end" type="number" class="w-12 p-inputtext p-component p-filled" :invalid="!!errors.range" />
                            </div>
                        </div>
                        <small v-if="errors.range" class="text-red-500 -mt-2 col-start-6 col-span-7">{{ errors.range }}</small>
                        <div class="col-span-9">
                            <label class="text-xs opacity-70">Data Signedness</label>
                            <SelectButton v-model="can_cfg.sign" :options="sign_options" optionLabel="label" optionValue="value" :allowEmpty="false" class="mt-2" />
                        </div>
                    </div>
                    <template v-if="can_cfg.mode === 'byte'">
                        <div class="grid grid-cols-12 gap-4 items-center">
                            <div class="col-span-9">
                                <label class="text-xs opacity-70">Data Endianness</label>
                                <SelectButton v-model="can_cfg.endian" :allowEmpty="false" :options="endian_options" optionLabel="label" optionValue="value" class="mt-2" />
                            </div>
                        </div>
                    </template>

                    <div class="grid grid-cols-12 gap-4 items-center">
                        <div class="col-span-6">
                            <label for="can_filter" class="text-xs opacity-70">Data Filter (HEX)</label>
                            <InputText id="can_filter" v-model="can_cfg.filter" class="mt-1 mb-1" :invalid="!!errors.filter" />
                        </div>
                        <div class="col-span-6">
                            <label for="can_mask" class="text-xs opacity-70">Data Mask (HEX)</label>
                            <InputText id="can_mask" v-model="can_cfg.mask" class="mt-1 mb-1" :invalid="!!errors.filter" />
                        </div>
                        <small v-if="errors.filter" class="text-red-500 -mt-2 col-span-12">{{ errors.filter }}</small>
                    </div>

                    <div class="flex justify-end gap-2 mt-2">
                        <Button label="Cancel" severity="secondary" @click="display_can_view = false" />
                        <Button label="Save" icon="pi pi-check" @click="save_cfg" />
                    </div>
                </div>
            </Dialog>
        </div>
    </Fluid>
</template>

<style>
input[type='number'] {
    -moz-appearance: textfield !important;
    appearance: textfield !important;
}

input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
    -webkit-appearance: none !important;
    display: none !important;
    margin: 0;
}
</style>
