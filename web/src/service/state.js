import { reactive } from "vue";
import dayjs from 'dayjs/esm';

export const connection = reactive({
  server: { value: 'Uninitialized', severity: 'danger' },
  device: { value: 'Offline', severity: 'danger' },
  status: 'text-gray-500',
  ip: '',  // device LAN address, retained on <name>/d/ip; '' when unknown
});

export const config = reactive({
  server: {
    addr: { value: "", loading: false },
    name: { value: "", loading: false },
    key: { value: "", loading: false },
  },
  net: {
    ssid: { value: "", loading: false },
    passwd: { value: "", loading: false },
  },
  dev: {
    tz: { value: "", loading: false },
    intv: { value: 0, loading: false },
  },
  can: {
    en: { value: false, loading: false },
    bps: { value: 0, loading: false },
    filter: { value: "", loading: false },
    mask: { value: "", loading: false },
  },
  gps: {
    en: { value: false, loading: false },
    dev: { value: 0, loading: false },
  },
  anl: {
    en: { value: false, loading: false },
  },
  dgt: {
    en: { value: false, loading: false },
  },
  current_loading: "",
  disabled: false,
});

export const files = reactive({
  buf: [],
  list: [],
  loading: {
    list: false,
    del: false,
    download: false,
  },
  disabled: false,
  download: {
    name: "",
    progress: 0,
    size: 0,
    time: null,
    speed: "",
  }
});

export const state = reactive([
  { name: '', text: 'UNKNOWN', status: "secondary" }, // hide core state
  { name: 'NVS', text: 'UNKNOWN', status: "secondary" },
  { name: 'RTC', text: 'UNKNOWN', status: "secondary" },
  { name: 'SD', text: 'UNKNOWN', status: "secondary" },
  { name: 'WIFI', text: 'UNKNOWN', status: "secondary" },
  { name: 'MQTT', text: 'UNKNOWN', status: "secondary" },
  { name: 'CAN', text: 'UNKNOWN', status: "secondary" },
  { name: 'GPS', text: 'UNKNOWN', status: "secondary" },
  { name: 'ANALOG', text: 'UNKNOWN', status: "secondary" },
  { name: 'DIGITAL', text: 'UNKNOWN', status: "secondary" },
  { name: 'GYRO', text: 'UNKNOWN', status: "secondary" },
]);

export const times = reactive({
  boot: { label: "Boot", value: "-", raw: null },
  current: { label: "Current", value: "-" },
  uptime: { label: "Uptime", value: "-" },
});

export const cons = reactive({
  usrevt: "",
  can: { id: "", data: Array.from({ length: 8 }, () => "") },
});

export const telemetry = reactive({
  chart: {},
  digital: { din1: false, din2: false, din3: false, din4: false },
  analog: [[], [], [], [], [], [], [], [], []],
  gyro: [[], [], [], [], [], [], []],
  can: [[]],
  can_index: {},  // unit -> telemetry.can column indices, in series order
});

/* uPlot data for one unit's CAN chart. the returned array holds references to
 * the same column arrays telemetry.can already owns, so this copies nothing
 * but the outer array. */
export function can_slice(unit) {
  const idx = telemetry.can_index[unit];

  if (!idx) {
    return [telemetry.can[0]];
  }

  return [telemetry.can[0], ...idx.map(i => telemetry.can[i] || [])];
}

export function format_size(size) {
  if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + " MB"
  if (size >= 1024) return (size / 1024).toFixed(2) + " KB"
  return size + " B"
}

export const digit = num => num.toFixed(Math.max(0, 3 - Math.trunc(Math.abs(num)).toString().length));

export const fmt = {
  time: (u, v, sidx, didx) => {
    const d = u.data[sidx];

    if (didx == null && d) {
      v = d[d.length - 1];
    }

    return dayjs(v * 1000).format('HH:mm:ss.SSS');
  },
  digital: (u, v, sidx, didx) => {
    const d = u.data[sidx];

    if (didx == null && d) {
      v = d[d.length - 1];
    }

    switch (v) {
      case 0: return 'LOW';
      case 1: return 'HIGH';
      default: return '-';
    }
  },
}
