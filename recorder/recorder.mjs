/*
 * monolith live telemetry recorder
 *
 * Subscribes to {name}/d/# on the broker and writes everything the logger
 * streams into SD-format .log files (BOOT header + 24-byte records), so the
 * web viewer and heven.js analyze() read them as they are.
 *
 * - one file per logger boot: OUT_DIR/YYYY-MM-DD-HH-MM-SS.live.log (boot time, TZ)
 * - d/can and d/sl records are written as received (already full log_t)
 * - d (logbuf) carries the latest GPS/GYRO/ANALOG/DIGITAL record every cycle;
 *   only records that changed since the last cycle are written
 * - records are held ~1 s and written in timestamp order
 * - restarting the recorder appends to the existing file of the same boot
 * - OUT_DIR/status.json is rewritten every few seconds
 *
 * env: MQTT_HOST, MQTT_USER, MQTT_PASS, OUT_DIR (default ./data), TZ
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';

const LOG_MAGIC = 0xae;
const LOG_SIZE = 24;
const PROTOCOL_VERSION = 1;
const TYPE_BOOT = 1;
const LOGBUF_SLOTS = { gps: 8, gyro: 32, analog: 56, digital: 80 };
const HOLD_MS = 1000;

function checksum(rec) {
    let x = 0;
    for (let i = 0; i < LOG_SIZE; i += 4) {
        let w = rec.readUInt32LE(i);
        if (i === 0) w &= 0x0000ffff; // checksum field counts as zero
        x ^= w;
    }
    x >>>= 0;
    return ((x & 0xffff) + (x >>> 16)) & 0xffff;
}

function valid(rec) {
    return rec.length === LOG_SIZE && rec[0] === LOG_MAGIC && rec.readUInt16LE(2) === checksum(rec);
}

function boot_record(boot_time) {
    const rec = Buffer.alloc(LOG_SIZE);
    rec[0] = LOG_MAGIC;
    rec[1] = TYPE_BOOT;
    rec[8] = PROTOCOL_VERSION;
    rec.writeBigUInt64LE(BigInt(boot_time), 16);
    rec.writeUInt16LE(checksum(rec), 2);
    return rec;
}

function file_name(boot_time) {
    const d = new Date(boot_time * 1000);
    const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.TZ || 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(d).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}.live.log`;
}

/***** session (one logger boot) *****/
export function create_recorder(out_dir) {
    fs.mkdirSync(out_dir, { recursive: true });

    let boot_time = null;   // from retained d/boot
    let session = null;     // { boot_time, file, fd, pending, last_slot, max_ts, written }
    let version = null;
    const stats = { started: new Date().toISOString(), rx: { can: 0, sl: 0, d: 0 }, bad: 0, last_rx: null };

    function open_session() {
        const bt = boot_time ?? Math.floor(Date.now() / 1000);
        const file = path.join(out_dir, file_name(bt));
        const exists = fs.existsSync(file) && fs.statSync(file).size >= LOG_SIZE;
        const fd = fs.openSync(file, 'a');

        // timestamp of the last record already in the file (0 for a new file)
        let flushed_ts = 0;
        if (exists) {
            const size = fs.statSync(file).size;
            const last = Buffer.alloc(LOG_SIZE);
            const rfd = fs.openSync(file, 'r');
            fs.readSync(rfd, last, 0, LOG_SIZE, size - LOG_SIZE - (size % LOG_SIZE));
            fs.closeSync(rfd);
            if (last[1] !== TYPE_BOOT) flushed_ts = last.readUInt32LE(4);
        } else {
            fs.writeSync(fd, boot_record(bt));
        }

        session = { boot_time: bt, file, fd, pending: [], last_slot: {}, max_ts: flushed_ts, flushed_ts, written: 0 };
        console.log(`${exists ? 'append' : 'open'} ${file}`);
    }

    function close_session() {
        if (!session) return;
        flush(true);
        fs.closeSync(session.fd);
        console.log(`close ${session.file} (${session.written} records)`);
        session = null;
    }

    function push(rec) {
        if (!session) open_session();

        const ts = rec.readUInt32LE(4);

        // timestamp jumped back by more than a minute: logger rebooted without a new d/boot yet
        if (session.max_ts - ts > 60000) {
            close_session();
            open_session();
        }

        session.pending.push({ ts, rec: Buffer.from(rec) });
        if (ts > session.max_ts) session.max_ts = ts;
    }

    function flush(all = false) {
        if (!session || session.pending.length === 0) return;

        const limit = all ? Infinity : session.max_ts - HOLD_MS;
        const out = [];
        const keep = [];

        for (const p of session.pending) (p.ts <= limit ? out : keep).push(p);
        if (out.length === 0) return;

        out.sort((a, b) => a.ts - b.ts); // stable
        fs.writeSync(session.fd, Buffer.concat(out.map((p) => p.rec)));
        session.written += out.length;
        session.flushed_ts = Math.max(session.flushed_ts, out.at(-1).ts);
        session.pending = keep;
    }

    function each_record(buf, fn) {
        for (let off = 0; off + LOG_SIZE <= buf.length; off += LOG_SIZE) {
            const rec = buf.subarray(off, off + LOG_SIZE);
            if (valid(rec)) fn(rec);
            else stats.bad++;
        }
    }

    function on_message(topic, msg) {
        const t = topic.split('/').slice(1).join('/');

        switch (t) {
            case 'd/boot': {
                if (msg.toString() === 'OFFLINE') {
                    console.log('device offline');
                    close_session();
                    break;
                }
                const bt = msg.readUInt32LE(0);
                if (bt !== boot_time) {
                    console.log(`device boot ${new Date(bt * 1000).toISOString()}`);
                    if (session && session.boot_time !== bt) close_session();
                    boot_time = bt;
                }
                break;
            }

            case 'd/ver':
                version = msg.toString();
                break;

            case 'd/can':
            case 'd/sl':
                stats.rx[t.slice(2)]++;
                stats.last_rx = new Date().toISOString();
                each_record(msg, push);
                break;

            case 'd': {
                stats.rx.d++;
                stats.last_rx = new Date().toISOString();
                for (const [slot, off] of Object.entries(LOGBUF_SLOTS)) {
                    const rec = msg.subarray(off, off + LOG_SIZE);
                    if (!valid(rec)) continue; // peripheral disabled / not sampled yet
                    if (!session) open_session();
                    if (session.last_slot[slot]?.equals(rec)) continue;
                    session.last_slot[slot] = Buffer.from(rec);
                    // a slot keeps its last sample until the next one; after a reconnect or a
                    // recorder restart that stale sample is already in the file
                    if (rec.readUInt32LE(4) <= session.flushed_ts) continue;
                    push(rec);
                }
                break;
            }
        }
    }

    function status() {
        return {
            ...stats,
            now: new Date().toISOString(),
            device: { boot_time, version, online: session !== null },
            file: session ? path.basename(session.file) : null,
            written: session?.written ?? 0
        };
    }

    return { on_message, flush, close: close_session, status };
}

/***** mqtt (when run directly; tests import create_recorder) *****/
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const HOST = process.env.MQTT_HOST || 'v2.monolith.luftaquila.io';
    const USER = process.env.MQTT_USER;
    const PASS = process.env.MQTT_PASS;
    const OUT_DIR = process.env.OUT_DIR || './data';

    if (!USER || !PASS) {
        console.error('MQTT_USER / MQTT_PASS required');
        process.exit(1);
    }

    const rec = create_recorder(OUT_DIR);

    const client = mqtt.connect({
        protocol: 'wss',
        host: HOST,
        port: 443,
        username: USER,
        password: PASS,
        keepalive: 30,
        reconnectPeriod: 5000
    });

    client.on('connect', () => {
        console.log(`connected to ${HOST}`);
        client.subscribe(`${USER}/d/#`);
    });

    client.on('error', (e) => console.error(`mqtt error: ${e.message}`));
    client.on('close', () => console.log('mqtt closed'));

    client.on('message', rec.on_message);

    setInterval(() => rec.flush(), 500);

    setInterval(() => {
        const status = { ...rec.status(), connected: client.connected };
        fs.writeFileSync(path.join(OUT_DIR, 'status.json'), JSON.stringify(status, null, 2));
    }, 5000);

    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            rec.close();
            client.end(true, () => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
        });
    }
}
