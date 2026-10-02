/*
 * Replays an SD log as the MQTT messages the logger would stream at a given
 * intv, feeds them to the recorder, and checks the result.
 *
 * usage: node test/replay.mjs <sd.log> [intv_ms=100]
 *
 * checks: output parses with the web parser without errors, timestamps are
 * monotonic, CAN record count equals what the firmware would have sent,
 * restarting the recorder mid-session appends to the same file, and heven.js
 * analyze() runs on the output.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create_recorder } from '../recorder.mjs';
import { parse } from '../../web/src/service/protocol.js';
import { analyze } from '../../web/src/service/heven.js';

const [, , src, intv_arg] = process.argv;
const INTV = Number(intv_arg ?? 100);
const buf = fs.readFileSync(src);
const out_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));

const TYPE = { BOOT: 1, CAN: 2, GPS: 3, ANALOG: 4, DIGITAL: 5, GYRO: 6, SYSTEM: 7 };
const SLOT = { [TYPE.GPS]: 8, [TYPE.GYRO]: 32, [TYPE.ANALOG]: 56, [TYPE.DIGITAL]: 80 };

const boot_time = Number(buf.readBigUInt64LE(16));
const name = 'HEVEN';

/* build the message stream the firmware would publish */
const msgs = [{ topic: `${name}/d/boot`, msg: (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(boot_time)); return b; })() }];
const logbuf = Buffer.alloc(104);
const last_sent = new Map();
let can_q = [];
let sl_q = [];
let next_cycle = null;
let expected_can = 0;

function cycle(ts) {
    logbuf.writeUInt32LE(ts, 0);
    msgs.push({ topic: `${name}/d`, msg: Buffer.from(logbuf) });
    if (sl_q.length) msgs.push({ topic: `${name}/d/sl`, msg: Buffer.concat(sl_q.splice(0, 32)) });
    while (can_q.length) msgs.push({ topic: `${name}/d/can`, msg: Buffer.concat(can_q.splice(0, 128)) });
}

for (let off = LOG_START(); off + 24 <= buf.length; off += 24) {
    const rec = buf.subarray(off, off + 24);
    if (rec[0] !== 0xae) continue;
    const ts = rec.readUInt32LE(4);

    if (next_cycle === null) next_cycle = ts + INTV;
    while (ts >= next_cycle) { cycle(next_cycle); next_cycle += INTV; }

    const type = rec[1];
    if (type === TYPE.CAN) {
        const key = rec.readUInt32LE(8) | (rec[12] << 31);
        const last = last_sent.get(key);
        if (last === undefined || ts - last >= INTV) {
            last_sent.set(key, ts);
            can_q.push(rec);
            expected_can++;
        }
    } else if (type === TYPE.SYSTEM) {
        sl_q.push(rec);
    } else if (SLOT[type] !== undefined) {
        rec.copy(logbuf, SLOT[type]);
    }
}
cycle(next_cycle);

function LOG_START() { return 24; } // skip BOOT header

/* feed: first half, "restart" the recorder, second half */
const half = Math.floor(msgs.length / 2);
let r = create_recorder(out_dir);
for (const m of msgs.slice(0, half)) { r.on_message(m.topic, m.msg); }
r.close();
r = create_recorder(out_dir);
r.on_message(msgs[0].topic, msgs[0].msg); // retained d/boot again on reconnect
for (const m of msgs.slice(half)) { r.on_message(m.topic, m.msg); r.flush(); }
r.on_message(`${name}/d/boot`, Buffer.from('OFFLINE'));

/* check */
const files = fs.readdirSync(out_dir).filter((f) => f.endsWith('.log'));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };

ok(files.length === 1, `one file per boot (${files.join(', ')})`);
const outbuf = fs.readFileSync(path.join(out_dir, files[0]));
const p = parse(Buffer.from(outbuf));
ok(p.error.length === 0, `parse errors: ${p.error.length} ${p.error.slice(0, 3).join(' | ')}`);
ok(p.header?.boot.boot_time === boot_time, 'BOOT header boot_time');

let back = 0;
let worst = 0;
for (let i = 1; i < p.data.length; i++) {
    const d = p.data[i - 1].timestamp - p.data[i].timestamp;
    if (d > 0) { back++; worst = Math.max(worst, d); }
}
// a recorder restart may leave one cycle of out-of-order records at the seam
ok(worst <= INTV, `timestamps monotonic within one cycle (${back} steps back, worst ${worst} ms)`);

const n_can = p.data.filter((d) => d.type === 'CAN').length;
ok(n_can === expected_can, `CAN records ${n_can} / expected ${expected_can}`);

const counts = {};
for (const d of p.data) counts[d.type] = (counts[d.type] || 0) + 1;
const dur = (p.data.at(-1).timestamp - p.data[0].timestamp) / 1000;
console.log(`records by type: ${JSON.stringify(counts)}, ${dur.toFixed(0)} s, ${(outbuf.length / 1024).toFixed(0)} KB (${(outbuf.length / dur / 1024).toFixed(1)} KB/s)`);

const an = analyze(outbuf);
ok(an && typeof an === 'object', 'heven.js analyze() runs');
const full = analyze(buf);
const keys = Object.keys(full.summary ?? {}).slice(0, 12);
console.log('summary  live  vs  SD:');
for (const k of keys) console.log(`  ${k.padEnd(18)} ${fmt(an.summary?.[k])}  ${fmt(full.summary[k])}`);

function fmt(v) { return typeof v === 'number' ? v.toFixed(2).padStart(10) : JSON.stringify(v, (k, x) => (typeof x === 'number' ? +x.toFixed(2) : x)); }

if (process.env.KEEP) fs.copyFileSync(path.join(out_dir, files[0]), process.env.KEEP);
fs.rmSync(out_dir, { recursive: true });
