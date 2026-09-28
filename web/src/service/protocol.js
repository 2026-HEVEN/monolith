const PROTOCOL_VERSION = 1;
const LOG_MAGIC = 0xae;
const LOG_SIZE = 24;

const LOG_TYPE = ['INVALID', 'BOOT', 'CAN', 'GPS', 'ANALOG', 'DIGITAL', 'GYROSCOPE', 'SYSTEM', 'USER_EVENT'];

const LOG_POS = {
    MAGIC: 0,
    TYPE: 1,
    CHECKSUM: 2,
    TIMESTAMP: 4,
    BOOT: {
        PROTOCOL_VERSION: 8,
        _RESERVED: 9,
        MAC: 10,
        BOOT_TIME: 16
    },
    CAN: {
        ID: 8,
        EXTENDED: 12,
        REMOTE: 13,
        LEN: 14,
        _RESERVED: 15,
        DATA: 16
    },
    GPS: {
        LATITUDE: 8,
        LONGITUDE: 12,
        LAT_DIR: 16,
        LON_DIR: 17,
        _RESERVED: 18,
        SPEED: 20,
        COURSE: 22
    },
    ANALOG: {
        AIN1: 8,
        AIN2: 10,
        AIN3: 12,
        AIN4: 14,
        AIN5: 16,
        AIN6: 18,
        VOLTAGE: 20,
        TEMPERATURE: 22
    },
    DIGITAL: {
        DIN1: 8,
        DIN2: 12,
        DIN3: 16,
        DIN4: 20
    },
    GYRO: {
        ACCEL_X: 8,
        ACCEL_Y: 10,
        ACCEL_Z: 12,
        TEMPERATURE: 14,
        GYRO_X: 16,
        GYRO_Y: 18,
        GYRO_Z: 20,
        _RESERVED: 22
    },
    SYS: {
        MSG: 8
    },
    USER: {
        MSG: 8
    }
};

const NVS_POS = {
    WIFI: {
        MAC: 0,
        MACADDR: 6,
        SSID: 24,
        PASSWD: 56
    },
    DEVICE: {
        SERVER: 88,
        NAME: 152,
        KEY: 184,
        TZ: 216,
        INTV: 256
    },
    EN: {
        CAN: 260,
        GPS: 261,
        ANALOG: 262,
        DIGITAL: 263
    },
    CAN: {
        BPS: 264,
        FILTER: 268,
        MASK: 272
    },
    GPS: {
        DEV: 276
    }
};

const LOGBUF_POS = {
    TIMESTAMP: 0,
    STATE: 4,
    GPS: 8,
    GYRO: 32,
    ANALOG: 56,
    DIGITAL: 80
};

const STATE = ['CORE', 'NVS', 'RTC', 'SD', 'WIFI', 'MQTT', 'CAN', 'GPS', 'ANALOG', 'DIGITAL', 'GYRO'];
const STATE_COMPONENT_MAX = 12;

export function parse(buf) {
    const logs = {
        ok: 0,
        error: [],
        data: [],
        header: null,
        latest: null
    };

    let i = 0;
    let header = false;

    while (i < buf.length) {
        let ret;
        try {
            ret = parse_log(buf.slice(i, i + LOG_SIZE));
        } catch (e) {
            logs.error.push(`#${i}: ${e.message}`);

            do {
                i++;
            } while (i < buf.length && buf[i] !== LOG_MAGIC);

            continue;
        }

        if (!header && i === 0 && ret.type !== 'BOOT') {
            logs.error.push(`#${i}: No valid header found`);
            i += LOG_SIZE;
            continue;
        }

        if (ret.type === 'BOOT') {
            if (header) {
                logs.error.push(`#${i}: Multiple headers found`);
                i += LOG_SIZE;
                continue;
            } else if (ret.boot.protocol_version !== PROTOCOL_VERSION) {
                logs.error.push(`#${i}: Unsupported protocol version ${ret.boot.protocol_version}`);
                i += LOG_SIZE;
                continue;
            } else {
                header = true;
                logs.header = ret;
            }
        } else {
            logs.data.push(ret);
            logs.latest = ret;
            logs.ok++;
        }

        i += LOG_SIZE;
    }

    return logs;
}

export function parse_cfg(buf) {
    return {
        wifi: {
            mac: to_string(buf, NVS_POS.WIFI.MACADDR, NVS_POS.WIFI.SSID),
            ssid: to_string(buf, NVS_POS.WIFI.SSID, NVS_POS.WIFI.PASSWD),
            passwd: to_string(buf, NVS_POS.WIFI.PASSWD, NVS_POS.DEVICE.SERVER)
        },
        device: {
            server: to_string(buf, NVS_POS.DEVICE.SERVER, NVS_POS.DEVICE.NAME),
            name: to_string(buf, NVS_POS.DEVICE.NAME, NVS_POS.DEVICE.KEY),
            key: to_string(buf, NVS_POS.DEVICE.KEY, NVS_POS.DEVICE.TZ),
            tz: to_string(buf, NVS_POS.DEVICE.TZ, NVS_POS.EN.CAN),
            intv: to_uint(32, buf, NVS_POS.DEVICE.INTV)
        },
        en: {
            can: to_uint(8, buf, NVS_POS.EN.CAN),
            gps: to_uint(8, buf, NVS_POS.EN.GPS),
            analog: to_uint(8, buf, NVS_POS.EN.ANALOG),
            digital: to_uint(8, buf, NVS_POS.EN.DIGITAL)
        },
        can: {
            bps: to_uint(8, buf, NVS_POS.CAN.BPS),
            filter: to_uint(32, buf, NVS_POS.CAN.FILTER),
            mask: to_uint(32, buf, NVS_POS.CAN.MASK)
        },
        gps: {
            dev: to_uint(8, buf, NVS_POS.GPS.DEV)
        }
    };
}

export function parse_log(buf) {
    const log = {
        magic: to_uint(8, buf, LOG_POS.MAGIC),
        type: LOG_TYPE[buf[LOG_POS.TYPE]],
        checksum: to_uint(16, buf, LOG_POS.CHECKSUM),
        timestamp: to_uint(32, buf, LOG_POS.TIMESTAMP)
    };

    if (log.magic !== LOG_MAGIC) {
        throw new Error('log magic failure');
    }

    if (!validate_checksum(buf)) {
        throw new Error('log checksum failure');
    }

    switch (log.type) {
        case 'BOOT':
            log.boot = {
                protocol_version: to_uint(8, buf, LOG_POS.BOOT.PROTOCOL_VERSION),
                mac: Array.from(buf.slice(LOG_POS.BOOT.MAC, LOG_POS.BOOT.MAC + 6))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(':')
                    .toUpperCase(),
                boot_time: to_uint(64, buf, LOG_POS.BOOT.BOOT_TIME)
            };
            break;

        case 'CAN':
            log.can = {
                id: to_uint(32, buf, LOG_POS.CAN.ID),
                extended: to_uint(8, buf, LOG_POS.CAN.EXTENDED),
                remote: to_uint(8, buf, LOG_POS.CAN.REMOTE),
                len: to_uint(8, buf, LOG_POS.CAN.LEN)
            };
            log.can.data = buf.slice(LOG_POS.CAN.DATA, LOG_POS.CAN.DATA + log.can.len);
            break;

        case 'GPS':
            const lat = to_uint(32, buf, LOG_POS.GPS.LATITUDE) / 10000000;
            const lon = to_uint(32, buf, LOG_POS.GPS.LONGITUDE) / 10000000;
            log.gps = {
                latitude: Math.floor(lat) + ((lat % 1) * 100) / 60,
                longitude: Math.floor(lon) + ((lon % 1) * 100) / 60,
                lat_dir: to_string(buf, LOG_POS.GPS.LAT_DIR, LOG_POS.GPS.LAT_DIR + 1),
                lon_dir: to_string(buf, LOG_POS.GPS.LON_DIR, LOG_POS.GPS.LON_DIR + 1),
                speed: to_uint(16, buf, LOG_POS.GPS.SPEED) / 100,
                course: to_uint(16, buf, LOG_POS.GPS.COURSE) / 100
            };
            break;

        case 'ANALOG':
            log.analog = {
                ain1: to_int(16, buf, LOG_POS.ANALOG.AIN1),
                ain2: to_int(16, buf, LOG_POS.ANALOG.AIN2),
                ain3: to_int(16, buf, LOG_POS.ANALOG.AIN3),
                ain4: to_int(16, buf, LOG_POS.ANALOG.AIN4),
                ain5: to_int(16, buf, LOG_POS.ANALOG.AIN5),
                ain6: to_int(16, buf, LOG_POS.ANALOG.AIN6),
                voltage: to_int(16, buf, LOG_POS.ANALOG.VOLTAGE),
                temperature: to_int(16, buf, LOG_POS.ANALOG.TEMPERATURE)
            };
            break;

        case 'DIGITAL':
            log.digital = {
                din1: to_uint(32, buf, LOG_POS.DIGITAL.DIN1),
                din2: to_uint(32, buf, LOG_POS.DIGITAL.DIN2),
                din3: to_uint(32, buf, LOG_POS.DIGITAL.DIN3),
                din4: to_uint(32, buf, LOG_POS.DIGITAL.DIN4)
            };
            break;

        case 'GYROSCOPE':
            log.gyro = {
                accel_x: to_int(16, buf, LOG_POS.GYRO.ACCEL_X),
                accel_y: to_int(16, buf, LOG_POS.GYRO.ACCEL_Y),
                accel_z: to_int(16, buf, LOG_POS.GYRO.ACCEL_Z),
                temperature: to_int(16, buf, LOG_POS.GYRO.TEMPERATURE),
                gyro_x: to_int(16, buf, LOG_POS.GYRO.GYRO_X),
                gyro_y: to_int(16, buf, LOG_POS.GYRO.GYRO_Y),
                gyro_z: to_int(16, buf, LOG_POS.GYRO.GYRO_Z)
            };
            break;

        case 'SYSTEM':
            log.sys = { msg: to_string(buf, LOG_POS.SYS.MSG, LOG_POS.SYS.MSG + 16) };
            break;

        case 'USER_EVENT':
            log.user = { msg: to_string(buf, LOG_POS.USER.MSG, LOG_POS.USER.MSG + 16) };
            break;

        case 'INVALID':
        default:
            throw new Error('log type failure');
    }

    return log;
}

function parse_state_bit(value, component) {
    component = STATE.indexOf(component);

    if (value & (1 << (component + STATE_COMPONENT_MAX))) {
        return 'FATAL';
    } else if (value & (1 << component)) {
        return 'ERROR';
    } else {
        return 'OK';
    }
}

export function parse_logbuf(buf) {
    const state = to_uint(32, buf, LOGBUF_POS.STATE);

    const logbuf = {
        timestamp: to_uint(32, buf, LOGBUF_POS.TIMESTAMP),
        state: {
            core: parse_state_bit(state, 'CORE'),
            nvs: parse_state_bit(state, 'NVS'),
            rtc: parse_state_bit(state, 'RTC'),
            sd: parse_state_bit(state, 'SD'),
            wifi: parse_state_bit(state, 'WIFI'),
            mqtt: parse_state_bit(state, 'MQTT'),
            can: parse_state_bit(state, 'CAN'),
            gps: parse_state_bit(state, 'GPS'),
            analog: parse_state_bit(state, 'ANALOG'),
            digital: parse_state_bit(state, 'DIGITAL'),
            gyro: parse_state_bit(state, 'GYRO')
        }
    };

    try {
        logbuf.gps = parse_log(buf.slice(LOGBUF_POS.GPS, LOGBUF_POS.GPS + LOG_SIZE));
    } catch (e) {
        if (buf[LOGBUF_POS.GPS] !== 0) {
            console.error(`GPS: ${e}`);
            console.error(buf.slice(LOGBUF_POS.GPS, LOGBUF_POS.GPS + LOG_SIZE));
        }
    }

    try {
        logbuf.gyro = parse_log(buf.slice(LOGBUF_POS.GYRO, LOGBUF_POS.GYRO + LOG_SIZE));
    } catch (e) {
        if (buf[LOGBUF_POS.GYRO] !== 0) {
            console.error(`GYRO: ${e}`);
            console.error(buf.slice(LOGBUF_POS.GYRO, LOGBUF_POS.GYRO + LOG_SIZE));
        }
    }

    try {
        logbuf.analog = parse_log(buf.slice(LOGBUF_POS.ANALOG, LOGBUF_POS.ANALOG + LOG_SIZE));
    } catch (e) {
        if (buf[LOGBUF_POS.ANALOG] !== 0) {
            console.error(`ANALOG: ${e}`);
            console.error(buf.slice(LOGBUF_POS.ANALOG, LOGBUF_POS.ANALOG + LOG_SIZE));
        }
    }

    try {
        logbuf.digital = parse_log(buf.slice(LOGBUF_POS.DIGITAL, LOGBUF_POS.DIGITAL + LOG_SIZE));
    } catch (e) {
        if (buf[LOGBUF_POS.DIGITAL] !== 0) {
            console.error(`DIGITAL: ${e}`);
            console.error(buf.slice(LOGBUF_POS.DIGITAL, LOGBUF_POS.DIGITAL + LOG_SIZE));
        }
    }

    return logbuf;
}

export function validate_checksum(buf) {
    const original = to_uint(16, buf, LOG_POS.CHECKSUM);
    buf[LOG_POS.CHECKSUM] = 0;
    buf[LOG_POS.CHECKSUM + 1] = 0;

    let checksum = 0;

    for (let i = 0; i < LOG_SIZE; i += 4) {
        checksum ^= to_uint(32, buf, i);
    }

    checksum = ((checksum & 0xffff) + (checksum >>> 16)) & 0xffff;

    if (checksum === original) {
        return true;
    } else {
        console.warn(`Checksum mismatch: expected ${original}, got ${checksum}`);
        return false;
    }
}

export const convert = {
    adc_to_v: (v) => (v / (1 << 15)) * 4.096, // +-4.096V FSR
    accel_to_g: (v) => (v / (1 << 15)) * 8, // +-8g FSR
    gyro_to_dps: (v) => (v / (1 << 15)) * 500,
    can_byte: (v, start, end, endian) => to_uint((end - start + 1) * 8, v, start, endian === 'big'),
    can_bit: (v, start, end) => Number((new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true) >> BigInt(start)) & ((1n << BigInt(end - start + 1)) - 1n))
};

export function can_filter_match(data, filter, mask) {
    for (let i = 0; i < mask.length; i++) {
        if ((data[i] & mask[i]) !== (filter[i] & mask[i])) return false;
    }
    return true;
}

export function parse_hex_bytes(hex) {
    const padded = hex.length % 2 ? '0' + hex : hex;
    return Uint8Array.from({ length: padded.length / 2 }, (_, i) => parseInt(padded.slice(i * 2, i * 2 + 2), 16));
}

export function to_string(buffer, start, end) {
    const str = String.fromCharCode(...buffer.slice(start, end));
    const nl = str.indexOf('\u0000');
    return nl === -1 ? str : str.slice(0, nl);
}

export function to_uint(bit, buffer, start, be = false) {
    if (bit <= 0 || bit & (bit - 1 !== 0)) {
        throw new Error('Invalid bit count: bit must be a power of two');
    }

    let ret = 0;

    for (let i = 0; i < bit / 8; i++) {
        const idx = be ? start + bit / 8 - 1 - i : start + i;
        ret += buffer[idx] * Math.pow(2, i * 8);
    }

    return ret >>> 0;
}

export function to_int(bit, buffer, start) {
    return signed(to_uint(bit, buffer, start), bit);
}

export function signed(value, bit) {
    return value > Math.pow(2, bit - 1) - 1 ? value - Math.pow(2, bit) : value;
}

export function to_float(buffer, start) {
    return new DataView(buffer.buffer, buffer.byteOffset + start, 4).getFloat32(0, true); // little endian
}
