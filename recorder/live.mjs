/*
 * Pulls the newest live log from the recorder host and prints the heven.js
 * summary and event list. Meant for checking a session while it is running.
 *
 * usage: node live.mjs [file.log | host:latest] [--since <sec>]
 *   default source: omo:latest (newest *.live.log in ~/telemetry on omo)
 *   --since: only events at or after this log time (s)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, build_events } from '../web/src/service/heven.js';

const args = process.argv.slice(2);
const since_i = args.indexOf('--since');
const since = since_i >= 0 ? Number(args.splice(since_i, 2)[1]) : -Infinity;
const src = args[0] ?? 'omo:latest';

let file = src;
if (src.endsWith(':latest')) {
    const host = src.slice(0, -':latest'.length);
    const status = execFileSync('ssh', [host, 'cat ~/telemetry/status.json'], { encoding: 'utf8' });
    const st = JSON.parse(status);
    console.log(`recorder: connected=${st.connected} device_online=${st.device.online} last_rx=${st.last_rx} fw=${st.device.version}`);
    const name = execFileSync('ssh', [host, 'ls -t ~/telemetry/*.live.log | head -1'], { encoding: 'utf8' }).trim();
    if (!name) { console.log('no live logs yet'); process.exit(0); }
    file = path.join(os.tmpdir(), path.basename(name));
    execFileSync('rsync', ['-az', `${host}:${name}`, file]);
}

const buf = fs.readFileSync(file);
const an = analyze(buf);
const ev = build_events(an);
const s = an.summary;
const r = (x, d = 1) => (typeof x === 'number' ? +x.toFixed(d) : x);
const mm = (o) => (o && typeof o === 'object' ? `max ${r(o.max)} mean ${r(o.mean)}` : r(o));

console.log(`file: ${path.basename(file)}  ${(buf.length / 1024).toFixed(0)} KB  ${r(s.duration, 0)} s`);
for (const k of ['speed', 'ibus_sum', 'p_dc', 'em_p', 'em_p_ma', 'bms_v', 'bms_dis', 'soc', 'energy_wh', 'em_energy_wh']) {
    if (s[k] !== undefined) console.log(`  ${k.padEnd(13)} ${mm(s[k])}`);
}

const shown = ev.filter((e) => e.t >= since);
console.log(`events${isFinite(since) ? ` since ${since}s` : ''}: ${shown.length}`);
for (const e of shown) console.log(`  ${e.t.toFixed(1).padStart(7)}s ${e.key ? '*' : ' '} [${e.cat}] ${e.msg}`);
