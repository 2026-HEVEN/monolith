<script setup>
  defineOptions({name: 'DeviceConfiguration'});

  import {ref, onMounted} from 'vue';
  import {init_mqtt, publish, begin_download} from '@/service/mqtt';
  import {connection, config, files, format_size} from '@/service/state';

  import {useConfirm} from "primevue/useconfirm";
  import ToastEventBus from 'primevue/toasteventbus';

  const confirm = useConfirm();

  onMounted(() => {
    config.server.addr.value = localStorage.getItem('server/addr');
    config.server.name.value = localStorage.getItem('server/name');
    config.server.key.value = localStorage.getItem('server/key');

    if (connection.device.value === 'Online') {
      publish('cmd/cfg', '!', 1)
    }
  });

  function save(event) {
    const target = event.currentTarget.id;
    const [section, field] = target.split("/");

    config[section][field].loading = true;
    config.disabled = true;

    localStorage.setItem(target, config[section][field].value.trim());
    init_mqtt();

    config[section][field].loading = false;
    config.disabled = false;

    ToastEventBus.emit('add', {severity: 'success', summary: 'Configuration Saved', group: 'br', life: 3000});
  }

  function set_cfg(event) {
    if (connection.device.value !== 'Online') {
      ToastEventBus.emit('add', {
        severity: 'error',
        summary: 'Configuration Failure',
        detail: 'Device is offline.',
        group: 'br',
        life: 5000
      });
      return;
    }

    const target = event.currentTarget.id;
    const [section, field] = target.split("/");

    let buf = null;
    let view = null;
    let payload = null;

    switch (target) {
      case 'net/ssid':
      case 'net/passwd':
      case 'dev/tz':
        payload = config[section][field].value.trim();
        break;

      case 'dev/intv':
        buf = new ArrayBuffer(4);
        view = new DataView(buf);
        view.setUint32(0, config[section][field].value, true);
        payload = new Uint8Array(buf);
        break;

      case 'can/filter':
      case 'can/mask':
        buf = new ArrayBuffer(4);
        view = new DataView(buf);
        view.setUint32(0, parseInt(config[section][field].value.trim(), 16), true);
        payload = new Uint8Array(buf);
        break;

      case 'anl/en':
      case 'dgt/en':
      case 'can/en':
      case 'gps/en':
        config[section][field].value = !config[section][field].value; // toggle value
        payload = new Uint8Array([config[section][field].value ? 1 : 0]);
        break;

      default:
        payload = new Uint8Array([config[section][field].value]);
        break;
    }

    config[section][field].loading = true;
    config.current_loading = target;
    config.disabled = true;

    publish(`set/${target}`, payload, 1);
  }

  function load_confirm() {
    confirm.require({
      header: 'Load Confirmation',
      message: 'Load configurations from the device?',
      icon: 'pi pi-info-circle',
      rejectProps: {
        label: 'Cancel',
        severity: 'secondary',
        outlined: true,
      },
      acceptProps: {
        label: 'Load',
        severity: 'success',
      },
      accept: () => {
        publish('cmd/cfg', '!', 1)
      }
    });
  }

  function restart_confirm() {
    confirm.require({
      header: 'Restart Confirmation',
      message: 'The device will be rebooted.',
      icon: 'pi pi-exclamation-triangle',
      rejectProps: {
        label: 'Cancel',
        severity: 'secondary',
        outlined: true,
      },
      acceptProps: {
        label: 'Restart',
        severity: 'warn',
      },
      accept: () => {
        publish('cmd/rbt', '!', 1);
      },
    });
  }

  function reset_confirm() {
    confirm.require({
      header: 'Reset Confirmation',
      message: 'This has the same effect as pressing the RST button on the device. All configurations will be erased and it needs to be configured from the beginning.',
      icon: 'pi pi-exclamation-triangle',
      rejectProps: {
        label: 'Cancel',
        severity: 'secondary',
        outlined: true,
      },
      acceptProps: {
        label: 'Reset',
        severity: 'danger',
      },
      accept: () => {
        publish('cmd/rst', '!', 1);
      },
    });
  }

  const interval = [
    {name: '100 ms', value: 100},
    {name: '200 ms', value: 200},
    {name: '500 ms', value: 500},
    {name: '1 s', value: 1000},
    {name: '2 s', value: 2000},
    {name: '5 s', value: 5000},
  ];

  const canbps = [
    {name: '1 kbit/s', value: 0},
    {name: '5 kbit/s', value: 1},
    {name: '10 kbit/s', value: 2},
    {name: '12.5 kbit/s', value: 3},
    {name: '16 kbit/s', value: 4},
    {name: '20 kbit/s', value: 5},
    {name: '25 kbit/s', value: 6},
    {name: '50 kbit/s', value: 7},
    {name: '100 kbit/s', value: 8},
    {name: '125 kbit/s', value: 9},
    {name: '250 kbit/s', value: 10},
    {name: '500 kbit/s', value: 11},
    {name: '800 kbit/s', value: 12},
    {name: '1 Mbit/s', value: 13}
  ];

  const gpsdev = [
    {name: 'UBLOX', value: 0},
  ];

  function list_files() {
    if (connection.device.value !== 'Online') {
      ToastEventBus.emit('add', {
        severity: 'error',
        summary: 'List Failure',
        detail: 'Device is offline.',
        group: 'br',
        life: 5000
      });
      return;
    }

    files.loading.list = true;
    files.disabled = true;
    files.buf.length = 0;
    files.list.length = 0;
    publish('cmd/ls', '!', 1);
  }

  function delete_file(name, index) {
    if (connection.device.value !== 'Online') {
      ToastEventBus.emit('add', {
        severity: 'error',
        summary: 'Delete Failure',
        detail: 'Device offline.',
        group: 'br',
        life: 5000
      });
      return;
    }

    confirm.require({
      header: 'Delete Confirmation',
      message: `Are you sure you want to delete ${name}?`,
      icon: 'pi pi-exclamation-triangle',
      rejectProps: {
        label: 'Cancel',
        severity: 'secondary',
        outlined: true,
      },
      acceptProps: {
        label: 'Delete',
        severity: 'danger',
      },
      accept: () => {
        files.loading.del = index;
        files.disabled = true;
        publish(`cmd/del/${name}`, '!', 1);
      },
    });
  }

  /* Direct LAN download. A top-level navigation to http:// from an https://
   * page is not mixed content, so no fetch/CORS is involved: the browser
   * streams the file to disk itself and nothing passes through the tab's
   * memory or the MQTT broker. Only reachable on the device's own network. */
  function download_file_http(name) {
    const a = document.createElement('a');
    a.href = `http://${connection.ip}/sd/${encodeURIComponent(name)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function download_file(name, size, index) {
    if (connection.device.value !== 'Online') {
      ToastEventBus.emit('add', {
        severity: 'error',
        summary: 'Download Failure',
        detail: 'Device offline.',
        group: 'br',
        life: 5000
      });
      return;
    }

    begin_download();

    files.loading.download = index;
    files.download.name = name;
    files.download.size = size;
    files.download.progress = 0;
    files.download.time = new Date().getTime();
    files.disabled = true;
    publish(`cmd/get/${name}`, '!', 1);
  }
</script>

<template>
  <Fluid>
    <div class="flex flex-col md:flex-row gap-8">
      <div class="md:w-1/2">
        <div class="card flex flex-col gap-6">
          <div class="font-semibold text-xl">Server</div>
          <div class="grid grid-cols-12 gap-2">
            <label for="server-addr" class="flex items-center col-span-3">Address</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="server-addr" v-model="config.server.addr.value" placeholder="MQTT Server Address" />
                <Button id="server/addr" class="mr-2 mb-2" icon="pi pi-save" :disabled="config.disabled"
                  :loading="config.server.addr.loading" @click="save($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="server-name" class="flex items-center col-span-3">Name</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="server-name" v-model="config.server.name.value" placeholder="Device Name" />
                <Button id="server/name" class="mr-2 mb-2" icon="pi pi-save" :disabled="config.disabled"
                  :loading="config.server.name.loading" @click="save($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="server-key" class="flex items-center col-span-3">Key</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="server-key" v-model="config.server.key.value" placeholder="Device Key" />
                <Button id="server/key" class="mr-2 mb-2" icon="pi pi-save" :disabled="config.disabled"
                  :loading="config.server.key.loading" @click="save($event)" />
              </InputGroup>
            </div>
          </div>
        </div>

        <div class="card flex flex-col gap-6">
          <div class="font-semibold text-xl">Device</div>
          <div class="grid grid-cols-12 gap-2">
            <label for="net-ssid" class="flex items-center col-span-3">SSID</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="net-ssid" v-model="config.net.ssid.value" placeholder="Wi-Fi SSID" />
                <Button id="net/ssid" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.net.ssid.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="net-passwd" class="flex items-center col-span-3">Password</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="net-passwd" v-model="config.net.passwd.value" placeholder="Wi-Fi Password" />
                <Button id="net/passwd" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.net.passwd.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="dev-tz" class="flex items-center col-span-3">Timezone</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="dev-tz" v-model="config.dev.tz.value" placeholder="POSIX timezone string" />
                <Button id="dev/tz" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.dev.tz.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="dev-intv" class="flex items-center col-span-3">T. Interval</label>
            <div class="col-span-9">
              <InputGroup>
                <Select id="dev-intv" v-model="config.dev.intv.value" :options="interval" optionLabel="name" optionValue="value"
                  placeholder="Telemetry Interval" />
                <Button id="dev/intv" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.dev.intv.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
        </div>

        <div class="card flex flex-col gap-2">
          <div class="font-semibold text-xl">Inputs</div>
          <ul class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <li class="flex items-center justify-between cardview">
              <label for="dgt-en" class="font-medium pr-3">Digital</label>
              <ToggleSwitch id="dgt/en" v-model="config.dgt.en.value" :disabled="config.disabled"
                @click="set_cfg($event)" />
            </li>
            <li class="flex items-center justify-between cardview">
              <label for="anl-en" class="font-medium pr-3">Analog</label>
              <ToggleSwitch id="anl/en" v-model="config.anl.en.value" :disabled="config.disabled"
                @click="set_cfg($event)" />
            </li>
          </ul>
        </div>
      </div>

      <div class="md:w-1/2">
        <div class="card flex flex-col gap-6">
          <div class="font-semibold text-xl">CAN</div>
          <div class="grid grid-cols-12 gap-2">
            <label for="can-en" class="flex items-center col-span-3">Enabled</label>
            <div class="col-span-9">
              <ToggleSwitch id="can/en" v-model="config.can.en.value" :disabled="config.disabled"
                @click="set_cfg($event)" />
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="can-bps" class="flex items-center col-span-3">Bit rate</label>
            <div class="col-span-9">
              <InputGroup>
                <Select id="can-bps" v-model="config.can.bps.value" :options="canbps" optionLabel="name" optionValue="value"
                  placeholder="CAN bps" />
                <Button id="can/bps" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.can.bps.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="can-filter" class="flex items-center col-span-3">Filter</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="can-filter" v-model="config.can.filter.value" placeholder="CAN filter ID" />
                <Button id="can/filter" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.can.filter.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="can-mask" class="flex items-center col-span-3">Mask</label>
            <div class="col-span-9">
              <InputGroup>
                <InputText id="can-mask" v-model="config.can.mask.value" placeholder="CAN filter mask" />
                <Button id="can/mask" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.can.mask.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
        </div>

        <div class="card flex flex-col gap-6">
          <div class="font-semibold text-xl">GPS</div>
          <div class="grid grid-cols-12 gap-2">
            <label for="gps-en" class="flex items-center col-span-3">Enabled</label>
            <div class="col-span-9">
              <ToggleSwitch id="gps/en" v-model="config.gps.en.value" :disabled="config.disabled"
                @click="set_cfg($event)" />
            </div>
          </div>
          <div class="grid grid-cols-12 gap-2">
            <label for="gps-dev" class="flex items-center col-span-3">Device</label>
            <div class="col-span-9">
              <InputGroup>
                <Select id="gps-dev" v-model="config.gps.dev.value" :options="gpsdev" optionLabel="name" optionValue="value"
                  placeholder="GPS device" />
                <Button id="gps/dev" class="mr-2 mb-2" icon="pi pi-upload" :disabled="config.disabled"
                  :loading="config.gps.dev.loading" @click="set_cfg($event)" />
              </InputGroup>
            </div>
          </div>
        </div>

        <div class="card flex flex-col gap-6">
          <div class="font-semibold text-xl">Danger Zone</div>
          <span><span class="pi pi-info-circle mr-2"></span> Restart the device to apply changes.</span>
          <div class="flex gap-6">
            <Button class="flex-1" label="Refresh" icon="pi pi-sync" @click="load_confirm" />
            <Button class="flex-1" label="Restart" icon="pi pi-refresh" severity="warn" @click="restart_confirm" />
            <Button class="flex-1" label="Reset" icon="pi pi-sparkles" severity="danger" @click="reset_confirm" />
          </div>
        </div>
        <ConfirmDialog group="confirm" style="maxWidth: 400px" />
      </div>
    </div>

    <div class="w-full mt-8">
      <div class="card flex flex-col gap-4">
        <div class="font-semibold text-xl">Data Downloader</div>
        <div class="flex gap-4 mt-2">
          <Button id="list" label="Load List" icon="pi pi-list" :fluid="false" class="flex-1 md:flex-none"
            :loading="files.loading.list" :disabled="files.disabled" @click="list_files" />
          <Button label="Delete All" icon="pi pi-eraser" severity="danger" :fluid="false" class="flex-1 md:flex-none"
            :loading="files.loading.del === -1" :disabled="files.disabled" @click="delete_file('all', -1)" />
        </div>
        <DataView :value="files.list" class="mt-2">
          <template #empty>
            <div class="p-4 text-center text-gray-400">
              Load the file list to see available files.<br>The current session won't be listed or deleted.
            </div>
          </template>
          <template #list="slot">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div v-for="(item, index) in slot.items" :key="index" class="flex items-center justify-between cardview">
                <div class="ml-2 mr-5 text-center">{{ index + 1 }}</div>
                <div class="flex-1">
                  <div class="text-sm truncate">{{ item.name }}</div>
                  <div class="text-xs text-gray-500 mt-1">{{ format_size(item.size) }}</div>
                </div>
                <Button v-if="connection.ip" icon="pi pi-bolt" class="mx-1" text severity="success"
                  :title="`Direct download over LAN (http://${connection.ip})`"
                  @click="download_file_http(item.name)" :disabled="files.disabled" />
                <Button icon="pi pi-download" class="mx-1" text title="Download through the server"
                  @click="download_file(item.name, item.size, index + 1)"
                  :loading="files.loading.download === index + 1" :disabled="files.disabled" />
                <Button icon="pi pi-trash" class="mx-1" text severity="danger" @click="delete_file(item.name, index)"
                  :loading="files.loading.del === index" :disabled="files.disabled" />
              </div>
            </div>
          </template>
        </DataView>
      </div>

      <Dialog v-model:visible="files.loading.download" modal header="Downloading..." :closable="false"
        :style="{ width: '25rem' }">
        <div class="flex flex-col items-center">
          <div class="mb-4">{{ files.download.name }}</div>
          <div class="mb-4">{{ files.download.speed }}</div>
          <ProgressBar :value="files.download.progress" style="width: 100%" />
        </div>
      </Dialog>
    </div>
  </Fluid>
</template>

<style>
  .p-confirmdialog-message,
  .p-dataview-empty-message {
    line-height: 1.5;
  }

  .p-progressbar-value {
    transition: width 0.1s ease-in-out !important;
  }
</style>
