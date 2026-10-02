import { ref } from 'vue';
import { convert, signed, can_filter_match, parse } from '@/service/protocol';
import { times, state, telemetry } from '@/service/state';
import { can_decoder, views } from '@/service/ui';
import { rebuild_hotline, HOTLINE_MODE } from '@/service/map';
import L from 'leaflet';

export const map = ref(null);
export const line = ref(null);
export const path = ref([]);

export const speed = ref('0.0 km/h');
export const course = ref('0.0°');
export const fix = ref(false);
export const hotlineMode = ref(HOTLINE_MODE.SPEED);

let current_pos = null;
let rebuildTimer = null;

export const dirty = { analog: false, gyro: false, can: false };

const MAX_TELEMETRY_POINTS = 36000;
const HOTLINE_REBUILD_INTERVAL = 1000;

function trim(arr) {
    if (arr[0].length > MAX_TELEMETRY_POINTS) {
        const excess = arr[0].length - MAX_TELEMETRY_POINTS;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i]) arr[i].splice(0, excess);
        }
    }
}

function scheduleRebuild() {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
        rebuild_hotline(map, line, path, hotlineMode.value);
        rebuildTimer = null;
    }, HOTLINE_REBUILD_INTERVAL);
}

export function switchHotlineMode(mode) {
    hotlineMode.value = mode;
    rebuild_hotline(map, line, path, mode);
}

export function update_telemetry(data) {
    if (data.state) {
        Object.entries(data.state).forEach(([key, value]) => {
            const target = state.find((item) => item.name === key.toUpperCase());

            if (target) {
                target.text = value;
                switch (value) {
                    case 'OK':
                        target.status = 'success';
                        break;
                    case 'ERROR':
                        target.status = 'warn';
                        break;
                    case 'FATAL':
                        target.status = 'danger';
                        break;
                    default:
                        target.status = 'secondary';
                }
            }
        });
    }

    if (data.digital) {
        telemetry.digital.din1 = data.digital.digital.din1;
        telemetry.digital.din2 = data.digital.digital.din2;
        telemetry.digital.din3 = data.digital.digital.din3;
        telemetry.digital.din4 = data.digital.digital.din4;
    }

    if (data.analog) {
        push_analog(telemetry.analog, times.boot.raw, data.analog);
        trim(telemetry.analog);
        dirty.analog = true;
    }

    if (data.gyro) {
        push_gyro(telemetry.gyro, times.boot.raw, data.gyro);
        trim(telemetry.gyro);
        dirty.gyro = true;
    }

    fix.value = !!data.gps && data.state?.gps === 'OK';

    if (data.gps) {
        speed.value = `${data.gps.gps.speed.toFixed(1)} km/h`;
        course.value = `${data.gps.gps.course.toFixed(1)}°`;

        if (map.value) {
            const latlng = [data.gps.gps.latitude, data.gps.gps.longitude];

            if (!current_pos) {
                current_pos = L.circleMarker(latlng, {
                    color: '#00FF00',
                    fillColor: '#00FF00',
                    fillOpacity: 1,
                    radius: 5
                }).addTo(map.value);
            } else {
                current_pos.setLatLng(latlng);
            }

            // [lat, lng, speed, timestamp] — speed stored for hotline z-value
            path.value.push([latlng[0], latlng[1], data.gps.gps.speed, data.gps.timestamp]);
            if (path.value.length > MAX_TELEMETRY_POINTS) {
                path.value.splice(0, path.value.length - MAX_TELEMETRY_POINTS);
            }

            scheduleRebuild();
            map.value.panTo(latlng);
        }
    }
}

export function update_can(log) {
    push_can(telemetry.can, times.boot.raw, log);
    trim(telemetry.can);
    dirty.can = true;
}

function push_analog(arr, boot, a) {
    const ch = views.analog.ch;
    arr[0].push(boot + a.timestamp / 1000);
    arr[1].push(convert.adc_to_v(a.analog.ain1) * ch.ain1.multiplier * (ch.ain1.divider ? 0.5 : 1));
    arr[2].push(convert.adc_to_v(a.analog.ain2) * ch.ain2.multiplier * (ch.ain2.divider ? 0.5 : 1));
    arr[3].push(convert.adc_to_v(a.analog.ain3) * ch.ain3.multiplier * (ch.ain3.divider ? 0.5 : 1));
    arr[4].push(convert.adc_to_v(a.analog.ain4) * ch.ain4.multiplier * (ch.ain4.divider ? 0.5 : 1));
    arr[5].push(convert.adc_to_v(a.analog.ain5) * ch.ain5.multiplier);
    arr[6].push(convert.adc_to_v(a.analog.ain6) * ch.ain6.multiplier);
    arr[7].push(convert.adc_to_v(a.analog.voltage) * ch.volt.multiplier);
    arr[8].push(a.analog.temperature * ch.temp.multiplier);
}

function push_gyro(arr, boot, g) {
    arr[0].push(boot + g.timestamp / 1000);
    arr[1].push(convert.accel_to_g(g.gyro.accel_x));
    arr[2].push(convert.accel_to_g(g.gyro.accel_y));
    arr[3].push(convert.accel_to_g(g.gyro.accel_z));
    arr[4].push(convert.gyro_to_dps(g.gyro.gyro_x));
    arr[5].push(convert.gyro_to_dps(g.gyro.gyro_y));
    arr[6].push(convert.gyro_to_dps(g.gyro.gyro_z));
}

function push_can(arr, boot, log) {
    if (!can_decoder[log.can.id]) return;

    const exist = [];

    for (const decoder of can_decoder[log.can.id]) {
        if (decoder._filter && !can_filter_match(log.can.data, decoder._filter, decoder._mask)) {
            continue;
        }

        if (!arr[decoder.idx]) {
            arr[decoder.idx] = [];
        }

        let v;

        if (decoder.mode === 'byte') {
            v = convert.can_byte(log.can.data, decoder.start, decoder.end, decoder.endian);
        } else {
            v = convert.can_bit(log.can.data, decoder.start, decoder.end);
        }

        if (decoder.sign) {
            v = signed(v, (decoder.end - decoder.start + 1) * (decoder.mode === 'byte' ? 8 : 1));
        }

        arr[decoder.idx].push(v * decoder.multiplier + decoder.offset);
        exist.push(decoder.idx);
    }

    if (exist.length) {
        arr[0].push(boot + log.timestamp / 1000);

        Object.values(can_decoder).forEach((v) => {
            v.forEach((decoder) => {
                if (!arr[decoder.idx]) {
                    arr[decoder.idx] = [];
                }

                if (!exist.includes(decoder.idx)) {
                    arr[decoder.idx].push(null);
                }
            });
        });
    }
}

/* ---- backfill from the server recording ----
 * The page only sees what arrives while it is open. The recorder on the web
 * host (monolith/recorder) keeps the whole boot session as a .live.log named
 * after the boot time, so on open the part before the first live sample is
 * read from there and put in front of the live data. */
let backfilled = null;

function live_name(boot) {
    const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(boot * 1000)).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}.live.log`;
}

/* put hist columns in front of the live columns, in place (charts hold the
 * column arrays by reference) */
function prepend(cols, hist, width) {
    const n = cols[0]?.length ?? 0;
    for (let i = 0; i < Math.max(cols.length, hist.length); i++) {
        if (!hist[i] && !cols[i]) continue;
        if (!cols[i]) cols[i] = Array(n).fill(null);
        const h = hist[i] ?? Array(width).fill(null);
        const live = cols[i].slice();
        cols[i].length = 0;
        for (const v of h) cols[i].push(v);
        for (const v of live) cols[i].push(v);
    }
}

export async function backfill(force = false) {
    const boot = times.boot.raw;
    if (!boot || (!force && backfilled === boot)) return;
    backfilled = boot;

    let buf;
    try {
        const res = await fetch(`/live/${live_name(boot)}`, { cache: 'no-store' });
        if (!res.ok) return;
        buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
        console.error(`backfill: ${e}`);
        return;
    }

    const logs = parse(buf);
    if (!logs.header || logs.header.boot.boot_time !== boot || times.boot.raw !== boot) return;

    // live data that arrived while fetching sets the cut: older samples come from the file
    const cut = (cols) => (cols[0]?.length ? Math.round((cols[0][0] - boot) * 1000) : Infinity);
    const cut_an = cut(telemetry.analog);
    const cut_gy = cut(telemetry.gyro);
    const cut_can = cut(telemetry.can);
    const cut_gps = path.value.length ? path.value[0][3] ?? -Infinity : Infinity;

    const an = telemetry.analog.map(() => []);
    const gy = telemetry.gyro.map(() => []);
    const can = [[]];
    const gps = [];

    for (const log of logs.data) {
        const ts = log.timestamp;
        if (log.type === 'CAN' && ts < cut_can) push_can(can, boot, log);
        else if (log.type === 'ANALOG' && ts < cut_an) push_analog(an, boot, log);
        else if (log.type === 'GYROSCOPE' && ts < cut_gy) push_gyro(gy, boot, log);
        else if (log.type === 'GPS' && ts < cut_gps) gps.push([log.gps.latitude, log.gps.longitude, log.gps.speed, ts]);
    }

    prepend(telemetry.analog, an, an[0].length);
    prepend(telemetry.gyro, gy, gy[0].length);
    prepend(telemetry.can, can, can[0].length);
    trim(telemetry.analog);
    trim(telemetry.gyro);
    trim(telemetry.can);
    dirty.analog = dirty.gyro = dirty.can = true;

    if (gps.length) {
        path.value.unshift(...gps.slice(-MAX_TELEMETRY_POINTS));
        if (path.value.length > MAX_TELEMETRY_POINTS) {
            path.value.splice(0, path.value.length - MAX_TELEMETRY_POINTS);
        }
        rebuild_hotline(map, line, path, hotlineMode.value);
        if (map.value && line.value) map.value.fitBounds(line.value.getBounds(), { maxZoom: 18 });
    }

    console.log(`backfill: ${logs.data.length} records from ${live_name(boot)} (gps ${gps.length}, can ${can[0].length})`);
}

export function reset_backfill() {
    backfilled = null;
}
