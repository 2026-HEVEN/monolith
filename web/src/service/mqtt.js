import ToastEventBus from 'primevue/toasteventbus';

import dayjs from 'dayjs/esm';
import duration from 'dayjs/esm/plugin/duration';
import relativeTime from 'dayjs/esm/plugin/relativeTime';

dayjs.extend(duration);
dayjs.extend(relativeTime);

import mqtt from 'mqtt';

import { term } from '@/service/terminal';
import { update_telemetry, update_can } from '@/service/telemetry';
import { connection, config, times, files, format_size } from '@/service/state';
import { parse_cfg, parse_log, parse_logbuf, to_uint } from '@/service/protocol';
import { update_connection_server, update_connection_device } from '@/service/topbar';

let mqtt_client = null;
let first_auth_fail = true;

/* file download chunks are deliberately kept out of Vue's reactive state:
 * a 100 MB log is ~25,600 chunks and they are never rendered. */
let download_buf = [];
let download_bytes = 0;

const DOWNLOAD_GRACE_MS = 5000;
const DOWNLOAD_GRACE_STEP_MS = 250;

export function begin_download() {
  download_buf = [];
  download_bytes = 0;
}

function end_download() {
  download_buf = [];
  download_bytes = 0;
  files.loading.download = false;
  files.disabled = false;
}

function missing_chunks(cnt) {
  const missing = [];

  for (let i = 0; i < cnt; i++) {
    if (!download_buf[i]) {
      missing.push(i);
    }
  }

  return missing;
}

async function finish_download(cnt) {
  /* chunks are published at QoS 0 while the completion message is QoS 1,
   * so trailing chunks may still be in flight. wait before giving up. */
  let missing = missing_chunks(cnt);
  const deadline = new Date().getTime() + DOWNLOAD_GRACE_MS;

  while (missing.length && new Date().getTime() < deadline) {
    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_GRACE_STEP_MS));
    missing = missing_chunks(cnt);
  }

  if (missing.length) {
    ToastEventBus.emit('add', {
      severity: 'error',
      summary: 'File Download Error',
      detail: `${missing.length} of ${cnt} chunks lost (first: ${missing.slice(0, 5).join(', ')})`,
      group: 'br',
      life: 5000
    });

    end_download();
    return;
  }

  const name = files.download.name;
  const speed = files.download.speed;
  const size = download_bytes;

  /* build the Blob straight from the chunks: no intermediate full copy.
   * the chunk references are dropped immediately after so the browser can
   * spill the Blob to disk instead of holding two copies in memory. */
  const blob = new Blob(download_buf, { type: 'application/octet-stream' });

  end_download();

  ToastEventBus.emit('add', {
    severity: 'success', summary: 'File Downloaded',
    detail: `${name}\n(${format_size(size)}, ${speed})`,
    group: 'br', life: 3000
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function init_mqtt() {
  if (mqtt_client) {
    mqtt_client.end();
    mqtt_client = null;
  }

  if (!localStorage.getItem('server/addr')) {
    localStorage.setItem('server/addr', 'v2.monolith.luftaquila.io');
  }

  mqtt_client = mqtt.connect({
    protocol: 'wss',
    host: localStorage.getItem('server/addr'),
    port: 443,
    username: localStorage.getItem('server/name') || '',
    password: localStorage.getItem('server/key') || '',
    keepalive: 10,
    reschedulePings: false,
  });

  mqtt_client.on('connect', () => {
    update_connection_server(true);
    mqtt_client.subscribe(`${localStorage.getItem('server/name')}/d/#`);
    mqtt_client.subscribe(`${localStorage.getItem('server/name')}/ack/#`);
  });

  mqtt_client.on('error', (e) => {
    update_connection_server(false);

    if (e.message.includes('Not authorized')) {
      if (first_auth_fail) {
        first_auth_fail = false;
        ToastEventBus.emit('add', { severity: 'error', summary: 'Authentication Failed', group: 'br', life: 5000 });
      }
    } else {
      ToastEventBus.emit('add', { severity: 'error', summary: 'Server Error', detail: e, group: 'br', life: 5000 });
    }
  });

  mqtt_client.on('close', () => {
    if (connection.server.value !== 'Offline') {
      ToastEventBus.emit('add', { severity: 'error', summary: 'Server Connection Closed', group: 'br', life: 5000 });
    }
    update_connection_server(false);
  });

  mqtt_client.on('message', (topic, message) => {
    topic = topic.split('/');

    if (topic[0] !== localStorage.getItem('server/name')) {
      return;
    }

    topic = topic.slice(1).join('/');

    switch (topic) {
      case 'd/boot': {
        if (message.toString() === 'OFFLINE') {
          times.boot.raw = null;
          connection.ip = '';
          update_connection_device(false);
          ToastEventBus.emit('add', { severity: 'error', summary: 'Device Offline', group: 'br', life: 5000 });
        } else {
          times.boot.raw = to_uint(32, message, 0);
          times.boot.value = dayjs(times.boot.raw * 1000).format("YYYY-MM-DD HH:mm:ss");
          update_connection_device(true);
        }
        break;
      }

      case 'd/ip': {
        connection.ip = message.toString();
        break;
      }

      case 'd/cfg': {
        if (connection.device.value !== 'Online') {
          return;
        }

        const cfg = parse_cfg(message);
        config.net.ssid.value = cfg.wifi.ssid;
        config.net.passwd.value = cfg.wifi.passwd;
        config.dev.tz.value = cfg.device.tz;
        config.dev.intv.value = cfg.device.intv;
        config.gps.en.value = cfg.en.gps ? true : false;
        config.gps.dev.value = cfg.gps.dev;
        config.can.en.value = cfg.en.can ? true : false;
        config.can.bps.value = cfg.can.bps;
        config.can.filter.value = '0x' + cfg.can.filter.toString(16).padStart(8, '0').toUpperCase();
        config.can.mask.value = '0x' + cfg.can.mask.toString(16).padStart(8, '0').toUpperCase();
        config.anl.en.value = cfg.en.analog ? true : false;
        config.dgt.en.value = cfg.en.digital ? true : false;

        ToastEventBus.emit('add', { severity: 'success', summary: 'Configuration Loaded', group: 'br', life: 3000 });
        config.disabled = false;
        break;
      }

      case 'd/sl': {
        try {
          const log = parse_log(message);
          term.write(`[${dayjs(times.boot.raw * 1000 + log.timestamp).format("HH:mm:ss.SSS")}] ${log.sys.msg}\n`);
        } catch (e) {
          console.error(e, message);
        }
        break;
      }

      case 'd/can': {
        try {
          const log = parse_log(message);
          update_time(log.timestamp);
          update_can(log);
        } catch (e) {
          console.error(`CAN: ${e}`);
          console.error(message);
        }
        break;
      }

      case 'd': {
        const logbuf = parse_logbuf(message);
        update_time(logbuf.timestamp);
        update_telemetry(logbuf);
        break;
      }

      case 'ack/set': {
        if (message.toString() === 'ok') {
          config.disabled = false;

          if (config.current_loading) {
            const [section, field] = config.current_loading.split("/");
            config[section][field].loading = false;
            config.current_loading = "";
          }

          ToastEventBus.emit('add', {
            severity: 'success',
            summary: 'Configuration Saved',
            detail: `Restart the device to apply changes.`,
            group: 'br',
            life: 3000
          });
        }
        break;
      }

      case 'ack/evt': {
        if (message.toString() === 'ok') {
          ToastEventBus.emit('add', { severity: 'success', summary: 'Event Saved', group: 'br', life: 3000 });
        }
        break;
      }

      case 'ack/ls': {
        if (!files.loading.list) {
          return;
        }

        files.loading.list = false;
        files.disabled = false;

        if (message.toString() === 'ok') {
          files.list = JSON.parse(JSON.stringify(files.buf.sort((a, b) => b.name.localeCompare(a.name))));

          ToastEventBus.emit('add', {
            severity: 'success',
            summary: 'File List Loaded',
            detail: `Found ${files.list.length} files.`,
            group: 'br',
            life: 3000
          });
        } else {
          ToastEventBus.emit('add', {
            severity: 'error',
            summary: 'File List Error',
            detail: message.toString(),
            group: 'br',
            life: 5000
          });
        }
        break;
      }

      case 'ack/del': {
        files.loading.del = false;
        files.disabled = false;

        if (message.toString() === 'ok') {
          ToastEventBus.emit('add', { severity: 'success', summary: 'File Deleted', group: 'br', life: 3000 });

          files.buf.length = 0;
          files.list.length = 0;
          setTimeout(() => {
            document.getElementById('list').click();
          }, 100);
        } else {
          ToastEventBus.emit('add', {
            severity: 'error',
            summary: 'File Delete Error',
            detail: message.toString(),
            group: 'br',
            life: 5000
          });
        }
        break;
      }

      case 'ack/get': {
        if (!files.loading.download) {
          return;
        }

        const status = message.toString();

        if (status.startsWith('fail:')) {
          ToastEventBus.emit('add', {
            severity: 'error',
            summary: 'File Download Error',
            detail: status,
            group: 'br',
            life: 5000
          });

          end_download();
          break;
        }

        finish_download(to_uint(32, message, 0));
        break;
      }

      default: {
        if (topic.startsWith('ack/ls/')) {
          const name = topic.replace('ack/ls/', '');

          if (!files.buf.some(file => file.name === name)) {
            files.buf.push({
              name: name,
              size: to_uint(32, message, 0),
            });
          }
        } else if (topic.startsWith('ack/get/')) {
          if (!files.loading.download) {
            break;
          }

          const index = Number(topic.replace('ack/get/', ''));

          if (!download_buf[index]) {
            download_bytes += message.byteLength;
          }

          download_buf[index] = message;

          /* progress and speed are byte-based, so out-of-order chunks
           * cannot skew them the way index * 4096 did. */
          const elapsed = (new Date().getTime() - files.download.time) / 1000;

          files.download.speed = `${format_size(elapsed > 0 ? download_bytes / elapsed : 0)}/s`;
          files.download.progress = Math.min(100, download_bytes / files.download.size * 100).toFixed(1);
          break;
        }
      }
    }
  });
}

export function publish(topic, payload, qos) {
  if (!mqtt_client || !mqtt_client.connected) {
    ToastEventBus.emit('add', { severity: 'error', summary: 'Server Disconnected', group: 'br', life: 5000 });
    return;
  }

  mqtt_client.publish(`${localStorage.getItem('server/name')}/${topic}`, payload, { qos: qos });
}

function update_time(timestamp) {
  times.current.value = dayjs(times.boot.raw * 1000 + timestamp).format("YYYY-MM-DD HH:mm:ss.SSS");

  const d = dayjs.duration(timestamp);
  const hours = Math.floor(d.asHours());
  const minutes = d.minutes();
  const seconds = d.seconds();

  times.uptime.value = '';

  if (hours > 0) times.uptime.value += `${hours} hr `;
  if (minutes > 0) times.uptime.value += `${minutes} min `;
  times.uptime.value += `${seconds} sec`;
}
