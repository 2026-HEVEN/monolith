/* HEVEN 2026 EV log analysis.
 *
 * Decodes the HEVEN CAN contract (EZkontrol controllers, VCU, Cluster/BMS)
 * straight from a raw Monolith .log buffer, detects events and computes
 * statistics. Pure functions, no Vue/DOM, so it also runs under plain node.
 *
 * Time base: log-relative seconds (record timestamp / 1000), the same numbers
 * the firmware tools (quick_monolith.py) print.
 */

const LOG_MAGIC = 0xAE;
const LOG_SIZE = 24;
const TYPE = { BOOT: 1, CAN: 2, SYSTEM: 7, USER_EVENT: 8 };

export const ID = {
  FB1_L: 0x1801D0EF, FB1_R: 0x1801D0F0,
  FB2_L: 0x1802D0EF, FB2_R: 0x1802D0F0,
  CMD_L: 0x0C01EFD0, CMD_R: 0x0C01F0D0,
  STATUS: 0x1801C0D0, SPEED: 0x1803C0D0,
  STEER: 0x1804C0D0, IMU: 0x1805C0D0, WHEELS: 0x1806C0D0, CONTROL: 0x1807C0D0,
  DRIVE: 0x1C01C0D0, MOTOR: 0x1C02C0D0, TV_YAW: 0x1C03C0D0, TV_LOAD: 0x1C04C0D0,
  CLAMP: 0x1C05C0D0, THROTTLE: 0x1C06C0D0, BLOCK: 0x1C07C0D0, FAULT: 0x1C08C0D0,
  CLUSTER_CMD: 0x1801D0C0, BMS: 0x18F3FFC0, BMS_DETAIL: 0x18F4FFC0,
  EM1: 0x1CF5FFC1, EM2: 0x1CF6FFC1,
};

/* wheel radius 0.2387 m, final drive 3.72 */
// 영광 제10조: 출력 10 kW, 500 ms 이동평균으로 판정
export const POWER_LIMIT_KW = 10;
export const POWER_AVG_WINDOW_S = 0.5;
export const RPM_TO_KPH = 0.2387 * 2 * Math.PI / 3.72 * 60 / 1000;

export const BLOCK_NAMES = [
  'throttle_invalid', 'safety_fsm', 'direction_gear', 'feedback_stale', 'fault_latch',
  'speed_mode', 'snapshot_stale', 'scheduler_heartbeat', 'reconnect_inhibit',
  'component_test', 'nonfinite_command', 'thermal_zero', 'paddock_sensor_invalid',
];

/* ESP-IDF TWAI alert bits, as reported by the logger's CANALT:<hex> messages */
const TWAI_ALERTS = [
  [0x2000, 'BUS_OFF'], [0x1000, 'ERR_PASS'], [0x4000, 'RX_FIFO_OVERRUN'],
  [0x800, 'RX_QUEUE_FULL'], [0x400, 'TX_FAILED'], [0x200, 'BUS_ERROR'],
  [0x100, 'ABOVE_ERR_WARN'], [0x80, 'ARB_LOST'], [0x40, 'BUS_RECOVERED'],
  [0x20, 'RECOVERY_IN_PROGRESS'], [0x10, 'ERR_ACTIVE'], [0x8, 'BELOW_ERR_WARN'],
];

export function twai_alert_names(code) {
  return TWAI_ALERTS.filter(([bit]) => code & bit).map(([, name]) => name);
}

/* EZkontrol FB2 error bitmaps (VCU docs/CAN_PROTOCOL.md §5.4), bit 0 first */
const EZ_ERRORS = [
  ['과전류', '과부하', '과전압', '저전압', '컨트롤러 과열', '모터 과열', '모터 스톨', '모터 결상'],
  ['모터 센서', '모터 보조센서', '엔코더 정렬불량', '폭주방지 작동', '메인 가속', '보조 가속', '프리차지', 'DC 컨택터'],
  ['전력밸브', '전류센서', '오토튠', 'RS485', 'CAN', '소프트웨어', '예약(bit6)', '예약(bit7)'],
];

/* bytes: [error1, error2, error3] of one controller */
export function ez_error_names(bytes) {
  const out = [];
  bytes.forEach((b, i) => {
    for (let bit = 0; bit < 8; bit++) {
      if (b & (1 << bit)) out.push(`${EZ_ERRORS[i][bit]} (ERROR${i + 1} bit${bit})`);
    }
  });
  return out;
}

const err_bytes = e => [e >> 16 & 0xFF, e >> 8 & 0xFF, e & 0xFF];

export function block_names(mask) {
  return BLOCK_NAMES.filter((_, bit) => mask & (1 << bit));
}

/* ---- channels ---------------------------------------------------------- */

export const PANELS = [
  { key: 'speed', name: '속도', unit: 'km/h' },
  { key: 'current', name: '버스 전류', unit: 'A' },
  { key: 'command', name: '명령·상전류', unit: 'A' },
  { key: 'voltage', name: '전압', unit: 'V' },
  { key: 'power', name: 'DC 전력', unit: 'kW' },
  { key: 'rpm', name: '모터 회전수', unit: 'rpm' },
  { key: 'driver', name: '스로틀', unit: '%' },
  { key: 'flags', name: '상태 비트', unit: '', lanes: true },
  { key: 'temp', name: '온도', unit: '°C' },
  { key: 'yaw', name: '요 레이트', unit: '°/s' },
  { key: 'motion', name: '가속도·조향', unit: '' },
];

/* hold: how long (s) a sample stays valid on the resampled grid before the
 * line breaks. Keeps real CAN gaps visible instead of bridging them. */
export const CHANNELS = [
  { key: 'spd', label: 'VCU 차속(유효만)', panel: 'speed', unit: 'km/h' },
  { key: 'spd_motor', label: '모터 환산 차속', panel: 'speed', unit: 'km/h' },
  { key: 'wss_fl', label: 'WSS FL', panel: 'speed', unit: 'km/h', show: false },
  { key: 'wss_fr', label: 'WSS FR', panel: 'speed', unit: 'km/h', show: false },
  { key: 'wss_rl', label: 'WSS RL', panel: 'speed', unit: 'km/h', show: false },
  { key: 'wss_rr', label: 'WSS RR', panel: 'speed', unit: 'km/h', show: false },

  { key: 'ibus_L', label: 'Ibus L', panel: 'current', unit: 'A' },
  { key: 'ibus_R', label: 'Ibus R', panel: 'current', unit: 'A' },
  { key: 'ibus_sum', label: 'Ibus 합계', panel: 'current', unit: 'A' },
  { key: 'bms_dis', label: 'BMS 방전전류', panel: 'current', unit: 'A', hold: 1.5 },
  { key: 'em_i', label: 'EM 전류', panel: 'current', unit: 'A' },

  { key: 'cmd_L', label: '명령 L', panel: 'command', unit: 'A' },
  { key: 'cmd_R', label: '명령 R', panel: 'command', unit: 'A' },
  { key: 'iph_L', label: '상전류 L', panel: 'command', unit: 'A', show: false },
  { key: 'iph_R', label: '상전류 R', panel: 'command', unit: 'A', show: false },
  { key: 'req_L', label: 'TV 요청 L', panel: 'command', unit: 'A', show: false },
  { key: 'req_R', label: 'TV 요청 R', panel: 'command', unit: 'A', show: false },

  { key: 'v_L', label: 'V L', panel: 'voltage', unit: 'V' },
  { key: 'v_R', label: 'V R', panel: 'voltage', unit: 'V' },
  { key: 'bms_v', label: 'BMS 팩전압', panel: 'voltage', unit: 'V', hold: 1.5 },
  { key: 'em_v', label: 'EM HV', panel: 'voltage', unit: 'V' },
  { key: 'em_lv', label: 'EM LV', panel: 'voltage', unit: 'V', show: false },

  { key: 'p_dc', label: 'DC 전력 합계', panel: 'power', unit: 'kW' },
  { key: 'em_p', label: 'EM 전력', panel: 'power', unit: 'kW' },
  { key: 'p_dc_ma', label: 'DC 전력 500ms 평균', panel: 'power', unit: 'kW', show: false },
  { key: 'em_p_ma', label: 'EM 전력 500ms 평균', panel: 'power', unit: 'kW' },

  { key: 'rpm_L', label: 'rpm L', panel: 'rpm', unit: 'rpm' },
  { key: 'rpm_R', label: 'rpm R', panel: 'rpm', unit: 'rpm' },

  { key: 'throttle', label: '스로틀', panel: 'driver', unit: '%' },
  { key: 'soc', label: 'SOC', panel: 'driver', unit: '%', hold: 1.5, show: false },

  { key: 'f_brake', label: '브레이크', panel: 'flags', lane: 0 },
  { key: 'f_thr_valid', label: '스로틀 유효', panel: 'flags', lane: 1 },
  { key: 'f_spd_valid', label: '차속 유효', panel: 'flags', lane: 2 },
  { key: 'f_out', label: '출력 허용', panel: 'flags', lane: 3 },
  { key: 'f_tv', label: 'TV 적용', panel: 'flags', lane: 4 },
  { key: 'f_regen', label: '회생 적용', panel: 'flags', lane: 5 },
  { key: 'f_block', label: 'VCU 차단중', panel: 'flags', lane: 6 },
  { key: 'f_fault', label: 'Fault 래치', panel: 'flags', lane: 7 },
  { key: 'f_err_L', label: 'MCU 에러 L', panel: 'flags', lane: 8 },
  { key: 'f_err_R', label: 'MCU 에러 R', panel: 'flags', lane: 9 },
  { key: 'f_bms', label: 'BMS 유효', panel: 'flags', lane: 10, hold: 1.5 },

  { key: 'tc_L', label: '컨트롤러 L', panel: 'temp', unit: '°C', hold: 1 },
  { key: 'tc_R', label: '컨트롤러 R', panel: 'temp', unit: '°C', hold: 1 },
  { key: 'tm_L', label: '모터 L', panel: 'temp', unit: '°C', hold: 1 },
  { key: 'tm_R', label: '모터 R', panel: 'temp', unit: '°C', hold: 1 },
  { key: 'bms_t', label: 'BMS', panel: 'temp', unit: '°C', hold: 1.5 },
  { key: 'em_t', label: '에너지미터', panel: 'temp', unit: '°C', show: false },

  { key: 'yaw', label: '요 레이트', panel: 'yaw', unit: '°/s' },
  { key: 'yaw_des', label: 'TV 목표 요', panel: 'yaw', unit: '°/s' },

  { key: 'ax', label: 'ax', panel: 'motion', unit: 'g' },
  { key: 'ay', label: 'ay', panel: 'motion', unit: 'g' },
  { key: 'steer', label: '조향(−1~1)', panel: 'motion', unit: '' },
];

export const FLAG_LANES = CHANNELS.filter(c => c.panel === 'flags').length;

/* ---- events ------------------------------------------------------------ */

export const EVENT_CATS = {
  HV: { name: 'HV', severity: 'danger' },
  VCU: { name: 'VCU', severity: 'danger' },
  MCU: { name: 'MCU', severity: 'warn' },
  CAN: { name: 'CAN', severity: 'warn' },
  BMS: { name: 'BMS 문턱', severity: 'help' },
  WSS: { name: 'WSS', severity: 'info' },
  STATE: { name: '상태', severity: 'secondary' },
  SYS: { name: 'SYS', severity: 'secondary' },
  RST: { name: '리셋', severity: 'danger' },
};

/* node reset report 0x1CFDFF00 | SA, 1 s: b0 esp_reset_reason, b1 ROM reason,
 * b2-5 uptime ms, b6 resets since power-on, b7 life. The logger writes the
 * same cause as a SYSTEM event "RST:<name>/<rom>". */
const RESET_ID_MASK = 0xFFFFFF00, RESET_ID_BASE = 0x1CFDFF00;
const RESET_NODES = { 0xD0: 'VCU', 0xC0: '클러스터', 0xC1: 'EM 게이트웨이' };
export const RESET_REASONS = [
  'UNKNOWN', 'POWERON', 'EXT', 'SW', 'PANIC', 'INT_WDT', 'TASK_WDT', 'WDT',
  'DEEPSLEEP', 'BROWNOUT', 'SDIO', 'USB', 'JTAG', 'EFUSE', 'PWR_GLITCH', 'CPU_LOCKUP',
];

/* ---- decoding ---------------------------------------------------------- */

function new_series() {
  return { t: [], v: [] };
}

export function analyze(buf, opts = {}) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const s = {};
  for (const c of CHANNELS) s[c.key] = new_series();
  const push = (key, t, v) => { s[key].t.push(t); s[key].v.push(v); };

  const raw_events = [];
  const counts = {};                       // frames per CAN id
  const last_seen = {};                    // CAN id -> last t
  const reset_up = {};                     // reset report SA -> last uptime s
  const gaps = {};                         // CAN id -> [{from, to}]
  const GAP_IDS = { [ID.FB1_L]: 0.25, [ID.FB1_R]: 0.25, [ID.STATUS]: 0.3, [ID.CLUSTER_CMD]: 1.0 };
  const probes = { L: [], R: [] };
  const replies = { L: [], R: [] };
  const alerts = [];
  let sta_lost = 0;

  const fb = { L: null, R: null };         // latest FB1 {t, v, i, rpm}
  const prev_err = { L: 0, R: 0 };
  let prev_block = null, prev_fault = 0;
  let bad = 0, records = 0, t_first = null, t_last = 0;

  let i = 0;
  while (i + LOG_SIZE <= u8.length) {
    if (u8[i] !== LOG_MAGIC) { i++; bad++; continue; }

    const type = u8[i + 1];
    const t = dv.getUint32(i + 4, true) / 1000;
    records++;

    if (type !== TYPE.BOOT) {
      if (t_first === null) t_first = t;
      if (t > t_last) t_last = t;
    }

    if (type === TYPE.SYSTEM || type === TYPE.USER_EVENT) {
      let msg = '';
      for (let k = 8; k < 24 && u8[i + k]; k++) msg += String.fromCharCode(u8[i + k]);

      if (msg.startsWith('STA_LOST')) sta_lost++;
      else if (msg.startsWith('CANALT:')) alerts.push({ t, code: parseInt(msg.slice(7), 16) });
      else if (msg.startsWith('RST:')) {
        const [name, rom] = msg.slice(4).split('/');
        raw_events.push({ t, kind: 'node_reset', node: '로거', name, rom, count: null, up: null });
      }
      else raw_events.push({ t, cat: 'SYS', msg: (type === TYPE.USER_EVENT ? 'USR ' : '') + msg });
    } else if (type === TYPE.CAN) {
      const id = dv.getUint32(i + 8, true);
      const d = i + 16;
      const b = k => u8[d + k];
      const u16 = k => dv.getUint16(d + k, true);
      const i16 = k => dv.getInt16(d + k, true);

      counts[id] = (counts[id] || 0) + 1;

      if (id in GAP_IDS) {
        const p = last_seen[id];
        if (p !== undefined && t - p > GAP_IDS[id]) (gaps[id] ||= []).push({ from: p, to: t });
      }
      last_seen[id] = t;

      const all = v => { for (let k = 0; k < 8; k++) if (b(k) !== v) return false; return true; };

      /* one event per boot: first report of a node, or its uptime went back */
      if ((id & RESET_ID_MASK) === RESET_ID_BASE) {
        const sa = id & 0xFF, up = dv.getUint32(d + 2, true) / 1000;
        const prev = reset_up[sa];
        if (prev === undefined || up < prev) {
          raw_events.push({
            t, kind: 'node_reset', node: RESET_NODES[sa] || `SA 0x${sa.toString(16)}`,
            name: RESET_REASONS[b(0)] || String(b(0)), rom: b(1), count: b(6), up,
          });
        }
        reset_up[sa] = up;
      }

      switch (id) {
        case ID.FB1_L:
        case ID.FB1_R: {
          const side = id === ID.FB1_L ? 'L' : 'R';
          if (all(0x55)) { probes[side].push(t); break; }

          const v = u16(0) / 10, cur = u16(2) / 10 - 3200, rpm = u16(6) - 32000;
          push('v_' + side, t, v);
          push('ibus_' + side, t, cur);
          push('rpm_' + side, t, rpm);

          const prev = fb[side];
          if (prev && t - prev.t <= 0.5 && prev.v - v >= 8 && v < 40) {
            raw_events.push({ t, kind: 'vdrop', side, from: prev.v, to: v, prior_i: prev.i });
          }
          if (prev && prev.v < 30 && v > 45) {
            raw_events.push({ t, kind: 'vrise', side, from: prev.v, to: v });
          }
          fb[side] = { t, v, i: cur, rpm };

          const o = fb[side === 'L' ? 'R' : 'L'];
          if (o && t - o.t <= 0.15) {
            push('ibus_sum', t, cur + o.i);
            push('p_dc', t, (v * cur + o.v * o.i) / 1000);
            push('spd_motor', t, (Math.abs(rpm) + Math.abs(o.rpm)) / 2 * RPM_TO_KPH);
          }
          break;
        }

        case ID.FB2_L:
        case ID.FB2_R: {
          const side = id === ID.FB2_L ? 'L' : 'R';
          if (all(0x55)) break;
          push('tc_' + side, t, b(0) - 40);
          push('tm_' + side, t, b(1) - 40);
          const err = b(3) << 16 | b(4) << 8 | b(5);
          push('f_err_' + side, t, err ? 1 : 0);
          if (err !== prev_err[side]) {
            raw_events.push({ t, kind: 'mcu_err', side, err, prev: prev_err[side] });
            prev_err[side] = err;
          }
          break;
        }

        case ID.CMD_L:
        case ID.CMD_R:
          if (all(0xAA)) replies[id === ID.CMD_L ? 'L' : 'R'].push(t);
          break;

        case ID.STATUS:
          push('throttle', t, b(3));
          push('f_brake', t, b(1) & 1);
          push('f_thr_valid', t, b(1) >> 3 & 1);
          break;

        case ID.SPEED: {
          const valid = b(2) === 1;
          push('spd', t, valid ? u16(0) / 10 : NaN);
          push('f_spd_valid', t, valid ? 1 : 0);
          break;
        }

        case ID.STEER:
          push('steer', t, b(6) & 1 ? i16(0) / 1000 : NaN);
          break;

        case ID.IMU:
          push('yaw', t, b(6) & 1 ? i16(0) / 100 : NaN);
          push('ax', t, b(6) & 2 ? i16(2) / 100 : NaN);
          push('ay', t, b(6) & 2 ? i16(4) / 100 : NaN);
          break;

        case ID.WHEELS:
          ['fl', 'fr', 'rl', 'rr'].forEach((w, k) => {
            const r = u16(k * 2);
            push('wss_' + w, t, r === 0xFFFF ? NaN : r / 10);
          });
          break;

        case ID.CONTROL:
          push('f_tv', t, b(2) & 1);
          push('f_regen', t, b(2) >> 2 & 1);
          push('f_out', t, b(2) >> 4 & 1);
          break;

        case ID.DRIVE:
          push('cmd_L', t, i16(0) / 10);
          push('cmd_R', t, i16(2) / 10);
          push('iph_L', t, i16(4) / 10);
          push('iph_R', t, i16(6) / 10);
          break;

        case ID.TV_YAW:
          push('yaw_des', t, i16(0) / 100);
          push('req_L', t, i16(4) / 10);
          push('req_R', t, i16(6) / 10);
          break;

        case ID.BLOCK: {
          const current = u16(0);
          push('f_block', t, current ? 1 : 0);
          if (current !== prev_block) {
            if (prev_block !== null) raw_events.push({ t, kind: 'block', current, prev: prev_block });
            prev_block = current;
          }
          break;
        }

        case ID.FAULT: {
          const latched = b(7) & 1;
          push('f_fault', t, latched);
          if (latched && !prev_fault) {
            let hex = '';
            const bytes = [];
            for (let k = 0; k < 6; k++) { hex += b(k).toString(16).padStart(2, '0'); bytes.push(b(k)); }
            raw_events.push({ t, kind: 'fault', hex, origin: b(6), bytes });
          }
          prev_fault = latched;
          break;
        }

        case ID.BMS: {
          const valid = (b(0) & 3) === 3;
          push('f_bms', t, valid ? 1 : 0);
          if (valid) {
            push('soc', t, Math.min(b(1), 100));
            push('bms_v', t, u16(2) / 10);
            push('bms_dis', t, -(u16(4) / 10 - 3200));
            push('bms_t', t, b(6) - 40);
          }
          break;
        }
        /* em-gateway forwards the meter's log_record_t as is, except HV,
         * which it corrects with the boot zero offset since 2026-09-30 */
        case ID.EM1: {
          const v = i16(0) / 10, cur = i16(2) / 10;
          push('em_v', t, v);
          push('em_i', t, cur);
          push('em_p', t, v * cur / 1000);
          push('em_lv', t, i16(4) / 100);
          push('em_t', t, i16(6) / 100);
          break;
        }
      }
    }

    i += LOG_SIZE;
  }

  if (t_first === null) throw new Error('No records');

  s.p_dc_ma = moving_average(s.p_dc, POWER_AVG_WINDOW_S);
  s.em_p_ma = moving_average(s.em_p, POWER_AVG_WINDOW_S);

  const an = {
    t0: t_first, t1: t_last, records, bad, counts, series: s,
    probes, replies, alerts, sta_lost, gaps, raw_events,
    threshold: opts.threshold ?? 320,
  };
  an.events = build_events(an);
  an.summary = summarize(an);
  return an;
}

/* ---- events ------------------------------------------------------------ */

function bursts(times, join = 2) {
  const out = [];
  for (const t of times) {
    const last = out[out.length - 1];
    if (last && t - last.end <= join) { last.end = t; last.n++; }
    else out.push({ t, end: t, n: 1 });
  }
  return out;
}

const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
const f0 = x => Math.round(x).toString();

/* runs where pred(value) holds, walking one channel's raw samples */
function runs(series, pred, join = 0.3, t0 = -Infinity, t1 = Infinity) {
  const out = [];
  let cur = null;
  for (let k = 0; k < series.t.length; k++) {
    const t = series.t[k], v = series.v[k];
    if (t < t0 || t > t1) continue;
    if (pred(v, t)) {
      if (cur && t - cur.end <= join) { cur.end = t; cur.peak = Math.max(cur.peak, v); cur.n++; }
      else { cur = { t, end: t, peak: v, n: 1 }; out.push(cur); }
    }
  }
  return out;
}

/* Trailing time-weighted mean over win seconds, evaluated at each sample.
 * Sample-and-hold like integrate(); a gap counts for at most cap seconds, so
 * a CAN dropout reads as zero power rather than holding the last value. */
function moving_average(series, win, cap = 0.2) {
  const n = series.t.length;
  const acc = new Float64Array(n);          // integral from t[0] to t[k]
  for (let k = 1; k < n; k++) {
    const v = series.v[k - 1];
    acc[k] = acc[k - 1] + (Number.isNaN(v) ? 0 : v * Math.min(series.t[k] - series.t[k - 1], cap));
  }
  const integral_to = x => {
    const k = lower_bound(series.t, x + 1e-9) - 1;
    if (k < 0) return 0;
    const v = series.v[k];
    return acc[k] + (Number.isNaN(v) ? 0 : v * Math.min(x - series.t[k], cap));
  };
  const out = new_series();
  for (let k = 0; k < n; k++) {
    const t = series.t[k];
    if (t - series.t[0] < win) continue;     // window not yet full
    out.t.push(t);
    out.v.push((acc[k] - integral_to(t - win)) / win);
  }
  return out;
}

/* dt-weighted time the channel spends above thr inside [a, b] */
export function time_above(series, thr, a = -Infinity, b = Infinity, cap = 0.2) {
  let total = 0;
  for (let k = 1; k < series.t.length; k++) {
    const t = series.t[k];
    if (t < a || t > b) continue;
    if (series.v[k] > thr) total += Math.min(t - series.t[k - 1], cap);
  }
  return total;
}

export function build_events(an) {
  const ev = [];
  const s = an.series;
  const thr = an.threshold;

  /* HV: both sides drop within 1 s -> one cut event */
  const drops = an.raw_events.filter(e => e.kind === 'vdrop');
  const rises = an.raw_events.filter(e => e.kind === 'vrise');
  const cuts = [];
  for (const d of drops) {
    const c = cuts.find(c => Math.abs(c.t - d.t) <= 1);
    if (c) { c.sides.push(d); c.t = Math.min(c.t, d.t); }
    else cuts.push({ t: d.t, sides: [d] });
  }
  for (const c of cuts) {
    const pre_peak = Math.max(-Infinity, ...runs(s.ibus_sum, () => true, 1e9, c.t - 3, c.t).map(r => r.peak));
    const over = time_above(s.ibus_sum, thr, c.t - 5, c.t);
    const back = rises.find(r => r.t > c.t);
    const sides = c.sides.map(d => `${d.side} ${f1(d.from)}→${f1(d.to)}V`).join(', ');
    ev.push({
      t: c.t, end: back ? back.t : null, cat: 'HV', key: true,
      msg: `HV 차단 추정 (${sides}). 직전 3초 합계 최대 ${isFinite(pre_peak) ? f0(pre_peak) : '-'}A, `
        + `직전 5초 ${thr}A 초과 ${over.toFixed(2)}초`
        + (back ? `. ${(back.t - c.t).toFixed(1)}초 뒤 복귀` : '. 파일 끝까지 미복귀'),
    });
  }
  for (const r of rises) {
    if (!cuts.some(c => r.t > c.t && r.t - c.t < 600)) {
      ev.push({ t: r.t, cat: 'HV', msg: `HV 투입 (${r.side} ${f1(r.from)}→${f1(r.to)}V)` });
    }
  }

  /* controller feedback gaps */
  for (const [id, side] of [[ID.FB1_L, 'L'], [ID.FB1_R, 'R']]) {
    for (const g of an.gaps[id] || []) {
      const v = value_at(s['v_' + side], g.from);
      const hv = v !== null && v > 40;
      ev.push({
        t: g.from, end: g.to, cat: 'CAN', key: hv,
        msg: `컨트롤러 ${side} 피드백 ${(g.to - g.from).toFixed(2)}초 두절 (직전 ${v === null ? '-' : f1(v)}V${hv ? '' : ', HV 꺼짐 상태'})`,
      });
    }
  }

  /* handshakes */
  for (const side of ['L', 'R']) {
    for (const bu of bursts(an.probes[side])) {
      const reply = an.replies[side].find(t => t >= bu.t && t <= bu.end + 0.5);
      ev.push({
        t: bu.t, end: bu.end > bu.t ? bu.end : null, cat: 'CAN', key: !reply,
        msg: `컨트롤러 ${side} 핸드셰이크 요청 ${bu.n}회` + (reply ? ` → VCU 응답 ${(reply - bu.t).toFixed(2)}초` : ' → VCU 응답 없음'),
      });
    }
  }

  /* VCU / cluster silence */
  for (const g of an.gaps[ID.STATUS] || []) {
    ev.push({ t: g.from, end: g.to, cat: 'VCU', key: g.to - g.from > 1, msg: `VCU 상태 프레임 ${(g.to - g.from).toFixed(2)}초 두절` });
  }
  const vcu_last = last_time(s.throttle);
  if (vcu_last !== null && an.t1 - vcu_last > 1) {
    ev.push({ t: vcu_last, end: an.t1, cat: 'VCU', key: true, msg: `VCU 송신 중단 — 파일 끝까지 ${(an.t1 - vcu_last).toFixed(1)}초 무응답` });
  }
  for (const g of an.gaps[ID.CLUSTER_CMD] || []) {
    ev.push({ t: g.from, end: g.to, cat: 'CAN', msg: `클러스터 명령 프레임 ${(g.to - g.from).toFixed(2)}초 두절` });
  }

  /* logger TWAI alerts */
  for (const bu of bursts(an.alerts.map(a => a.t), 1)) {
    const codes = an.alerts.filter(a => a.t >= bu.t && a.t <= bu.end);
    const names = [...new Set(codes.flatMap(a => twai_alert_names(a.code)))];
    const severe = names.some(n => n === 'ERR_PASS' || n === 'BUS_OFF' || n === 'BUS_ERROR');
    ev.push({
      t: bu.t, end: bu.end > bu.t ? bu.end : null, cat: 'CAN', key: severe,
      msg: `로거 CAN 경보 ${codes.length}건: ${names.join(', ')}`,
    });
  }

  for (const e of an.raw_events) {
    if (e.kind === 'mcu_err') {
      ev.push({
        t: e.t, cat: 'MCU', key: !!e.err,
        msg: e.err
          ? `컨트롤러 ${e.side} 에러: ${ez_error_names(err_bytes(e.err)).join(', ')} [0x${e.err.toString(16).padStart(6, '0')}]`
          : `컨트롤러 ${e.side} 에러 해제 (이전: ${ez_error_names(err_bytes(e.prev)).join(', ')})`,
      });
    } else if (e.kind === 'block') {
      ev.push({
        t: e.t, cat: 'STATE',
        msg: e.current ? `VCU 출력 차단: ${block_names(e.current).join(', ')}` : `VCU 출력 차단 해제 (이전 ${block_names(e.prev).join(', ')})`,
      });
    } else if (e.kind === 'fault') {
      const sides = [['L', e.bytes.slice(0, 3)], ['R', e.bytes.slice(3, 6)]]
        .filter(([, b]) => b.some(x => x))
        .map(([s, b]) => `${s}: ${ez_error_names(b).join(', ')}`);
      ev.push({
        t: e.t, cat: 'MCU', key: true,
        msg: `VCU fault 래치 — 최초 에러 ${sides.join(' / ') || '없음'} (origin ${e.origin}, raw ${e.hex})`,
      });
    } else if (e.kind === 'node_reset') {
      const detail = [`ROM ${e.rom}`];
      if (e.up !== null) detail.push(`부팅 ${e.up.toFixed(1)}초 전`);
      if (e.count) detail.push(`전원 유지 중 리셋 ${e.count}회째`);
      ev.push({
        t: e.t, cat: 'RST', key: e.name !== 'POWERON',
        msg: `${e.node} 리셋 원인 ${e.name} (${detail.join(', ')})`,
      });
    } else if (e.cat === 'SYS') {
      ev.push(e);
    }
  }

  /* BMS current threshold episodes */
  for (const r of runs(s.ibus_sum, v => v > thr, 0.3)) {
    const dur = time_above(s.ibus_sum, thr, r.t - 0.2, r.end);
    if (dur < 0.1) continue;
    ev.push({ t: r.t, end: r.end, cat: 'BMS', key: dur >= 0.5, msg: `합계 ${thr}A 초과 ${dur.toFixed(2)}초 (최대 ${f0(r.peak)}A)` });
  }

  /* WSS invalid while moving */
  const moving = t => (value_at(s.spd_motor, t, 0.3) ?? 0) > 3;
  for (const r of runs(s.f_spd_valid, (v, t) => v === 0 && moving(t), 0.15)) {
    const d = r.end - r.t + 0.05;
    ev.push({ t: r.t, end: r.end > r.t ? r.end : null, cat: 'WSS', msg: `차속 유효 플래그 0 — ${d.toFixed(2)}초 (클러스터 '--')` });
  }

  ev.sort((a, b) => a.t - b.t);
  return ev;
}

/* ---- lookups ----------------------------------------------------------- */

function lower_bound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = lo + hi >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/* sample-and-hold value at t, null if older than hold */
export function value_at(series, t, hold = 0.5) {
  const k = lower_bound(series.t, t + 1e-9) - 1;
  if (k < 0 || t - series.t[k] > hold) return null;
  const v = series.v[k];
  return Number.isNaN(v) ? null : v;
}

function last_time(series) {
  return series.t.length ? series.t[series.t.length - 1] : null;
}

/* ---- statistics -------------------------------------------------------- */

function integrate(series, a, b, cap = 0.2) {
  let total = 0;
  const k0 = Math.max(1, lower_bound(series.t, a));
  for (let k = k0; k < series.t.length && series.t[k] <= b; k++) {
    const v = series.v[k - 1];
    if (!Number.isNaN(v)) total += v * Math.min(series.t[k] - series.t[k - 1], cap);
  }
  return total;
}

export function channel_stats(series, a, b) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0, t_min = null, t_max = null;
  const k0 = lower_bound(series.t, a);
  for (let k = k0; k < series.t.length && series.t[k] <= b; k++) {
    const v = series.v[k];
    if (Number.isNaN(v)) continue;
    if (v < min) { min = v; t_min = series.t[k]; }
    if (v > max) { max = v; t_max = series.t[k]; }
    sum += v; n++;
  }
  return n ? { min, max, mean: sum / n, n, t_min, t_max } : null;
}

export function range_stats(an, a, b) {
  const s = an.series;
  return {
    a, b,
    duration: b - a,
    over: time_above(s.ibus_sum, an.threshold, a, b),
    energy_wh: integrate(s.p_dc, a, b) * 1000 / 3600,
    em_energy_wh: integrate(s.em_p, a, b) * 1000 / 3600,
    distance_km: integrate(s.spd_motor, a, b) / 3600,
    channels: Object.fromEntries(CHANNELS.map(c => [c.key, channel_stats(s[c.key], a, b)])),
  };
}

function summarize(an) {
  const s = an.series;
  const st = k => channel_stats(s[k], an.t0, an.t1);
  const loaded_v = { t: [], v: [] };
  for (const side of ['L', 'R']) {
    const vs = s['v_' + side], is = s['ibus_' + side];
    for (let k = 0; k < vs.t.length; k++) {
      if (is.v[k] > 20 && vs.v[k] > 30) { loaded_v.t.push(vs.t[k]); loaded_v.v.push(vs.v[k]); }
    }
  }
  const moving = s.f_spd_valid.t.filter(t => (value_at(s.spd_motor, t, 0.3) ?? 0) > 3);
  const invalid = s.f_spd_valid.t.filter((t, k) => s.f_spd_valid.v[k] === 0 && (value_at(s.spd_motor, t, 0.3) ?? 0) > 3);
  const cnt = cat => an.events.filter(e => e.cat === cat && e.key).length;

  return {
    duration: an.t1 - an.t0,
    speed: st('spd'),
    speed_motor: st('spd_motor'),
    ibus_sum: st('ibus_sum'),
    p_dc: st('p_dc'),
    loaded_v: channel_stats(loaded_v, an.t0, an.t1),
    bms_dis: st('bms_dis'),
    bms_v: st('bms_v'),
    soc: st('soc'),
    energy_wh: integrate(s.p_dc, an.t0, an.t1) * 1000 / 3600,
    em_p: st('em_p'),
    em_p_ma: st('em_p_ma'),
    p_dc_ma: st('p_dc_ma'),
    em_ma_over: time_above(s.em_p_ma, POWER_LIMIT_KW, an.t0, an.t1),
    dc_ma_over: time_above(s.p_dc_ma, POWER_LIMIT_KW, an.t0, an.t1),
    em_i: st('em_i'),
    em_energy_wh: integrate(s.em_p, an.t0, an.t1) * 1000 / 3600,
    distance_km: integrate(s.spd_motor, an.t0, an.t1) / 3600,
    over: time_above(s.ibus_sum, an.threshold, an.t0, an.t1),
    hv_cuts: an.events.filter(e => e.cat === 'HV' && e.key).length,
    vcu_events: cnt('VCU'),
    mcu_errors: cnt('MCU'),
    can_events: cnt('CAN'),
    probes: an.probes.L.length + an.probes.R.length,
    alerts: an.alerts.length,
    wss_invalid_pct: moving.length ? invalid.length / moving.length * 100 : null,
    em_frames: (an.counts[ID.EM1] || 0) + (an.counts[ID.EM2] || 0),
  };
}

export function set_threshold(an, thr) {
  an.threshold = thr;
  an.events = build_events(an);
  an.summary = summarize(an);
}

/* ---- resampling / export ----------------------------------------------- */

/* Sample-and-hold every channel onto one uniform grid for plotting.
 * Values older than the channel's hold (default 0.3 s) become null, so real
 * gaps stay visible. */
export function resample(an, keys, dt) {
  const n = Math.floor((an.t1 - an.t0) / dt) + 1;
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[k] = an.t0 + k * dt;

  const cols = keys.map(key => {
    const c = CHANNELS.find(c => c.key === key);
    const hold = c?.hold ?? 0.3;
    const src = an.series[key];
    const y = new Array(n).fill(null);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const t = x[k];
      while (j < src.t.length && src.t[j] <= t) j++;
      if (j === 0) continue;
      const v = src.v[j - 1];
      if (t - src.t[j - 1] <= hold && !Number.isNaN(v)) y[k] = v;
    }
    return y;
  });

  return { x, cols };
}

export function to_csv(an, a, b, dt = 0.01, boot_time = 0) {
  const keys = CHANNELS.map(c => c.key);
  const { x, cols } = resample(an, keys, dt);
  const lines = ['t_s,wall_ms,' + keys.join(',')];
  for (let k = 0; k < x.length; k++) {
    if (x[k] < a || x[k] > b) continue;
    const row = [x[k].toFixed(3), boot_time ? Math.round(boot_time * 1000 + x[k] * 1000) : ''];
    for (const y of cols) row.push(y[k] === null ? '' : +y[k].toFixed(3));
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
