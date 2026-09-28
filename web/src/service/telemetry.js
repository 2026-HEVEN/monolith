import { ref } from 'vue';
import { convert, signed, can_filter_match } from '@/service/protocol';
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
        telemetry.analog[0].push(times.boot.raw + data.analog.timestamp / 1000);
        telemetry.analog[1].push(convert.adc_to_v(data.analog.analog.ain1) * views.analog.ch.ain1.multiplier * (views.analog.ch.ain1.divider ? 0.5 : 1));
        telemetry.analog[2].push(convert.adc_to_v(data.analog.analog.ain2) * views.analog.ch.ain2.multiplier * (views.analog.ch.ain2.divider ? 0.5 : 1));
        telemetry.analog[3].push(convert.adc_to_v(data.analog.analog.ain3) * views.analog.ch.ain3.multiplier * (views.analog.ch.ain3.divider ? 0.5 : 1));
        telemetry.analog[4].push(convert.adc_to_v(data.analog.analog.ain4) * views.analog.ch.ain4.multiplier * (views.analog.ch.ain4.divider ? 0.5 : 1));
        telemetry.analog[5].push(convert.adc_to_v(data.analog.analog.ain5) * views.analog.ch.ain5.multiplier);
        telemetry.analog[6].push(convert.adc_to_v(data.analog.analog.ain6) * views.analog.ch.ain6.multiplier);
        telemetry.analog[7].push(convert.adc_to_v(data.analog.analog.voltage) * views.analog.ch.volt.multiplier);
        telemetry.analog[8].push(data.analog.analog.temperature * views.analog.ch.temp.multiplier);

        trim(telemetry.analog);
        dirty.analog = true;
    }

    if (data.gyro) {
        telemetry.gyro[0].push(times.boot.raw + data.gyro.timestamp / 1000);
        telemetry.gyro[1].push(convert.accel_to_g(data.gyro.gyro.accel_x));
        telemetry.gyro[2].push(convert.accel_to_g(data.gyro.gyro.accel_y));
        telemetry.gyro[3].push(convert.accel_to_g(data.gyro.gyro.accel_z));
        // telemetry.gyro[4].push(data.gyro.gyro.temperature);
        telemetry.gyro[4].push(convert.gyro_to_dps(data.gyro.gyro.gyro_x));
        telemetry.gyro[5].push(convert.gyro_to_dps(data.gyro.gyro.gyro_y));
        telemetry.gyro[6].push(convert.gyro_to_dps(data.gyro.gyro.gyro_z));

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

            // [lat, lng, speed] — speed stored for hotline z-value
            path.value.push([latlng[0], latlng[1], data.gps.gps.speed]);
            if (path.value.length > MAX_TELEMETRY_POINTS) {
                path.value.splice(0, path.value.length - MAX_TELEMETRY_POINTS);
            }

            scheduleRebuild();
            map.value.panTo(latlng);
        }
    }
}

export function update_can(log) {
    if (can_decoder[log.can.id]) {
        const exist = [];

        for (const decoder of can_decoder[log.can.id]) {
            if (decoder._filter && !can_filter_match(log.can.data, decoder._filter, decoder._mask)) {
                continue;
            }

            if (!telemetry.can[decoder.idx]) {
                telemetry.can[decoder.idx] = [];
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

            telemetry.can[decoder.idx].push(v * decoder.multiplier + decoder.offset);
            exist.push(decoder.idx);
        }

        if (exist.length) {
            telemetry.can[0].push(times.boot.raw + log.timestamp / 1000);

            Object.values(can_decoder).forEach((v, i) => {
                v.forEach((decoder) => {
                    if (!telemetry.can[decoder.idx]) {
                        telemetry.can[decoder.idx] = [];
                    }

                    if (!exist.includes(decoder.idx)) {
                        telemetry.can[decoder.idx].push(null);
                    }
                });
            });
        }
    }

    trim(telemetry.can);
    dirty.can = true;
}
