/*
 * Fetches a live recording and prints the heven.js summary and event list,
 * or exports resampled channels as CSV for further analysis.
 * No npm install needed: only Node 18+ and this repository.
 *
 * usage: node recorder/live.mjs [source] [options]
 *   source (default: newest recording on the server)
 *     <name>.live.log           a recording on the server, by name
 *     https://.../x.live.log    any URL
 *     ./path/to/x.log           a local file (live or SD log)
 *     omo:latest                newest file over ssh (recorder host admins)
 *   --list                      list recordings on the server and exit
 *   --since <s>                 only events at or after this log time (s)
 *   --csv <out.csv>             write all channels resampled to --dt (default 0.1 s)
 *   --dt <s>                    CSV time step
 *   --save <out.log>            keep the downloaded raw log
 *   env LIVE_URL                server listing (default below)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// heven.js lives in the web app, whose package.json has no "type": "module";
// Node warns about reparsing it. Harmless, so keep the output clean.
process.removeAllListeners('warning');
const { analyze, build_events, to_csv, CHANNELS } = await import('../web/src/service/heven.js');

const LIVE_URL = (process.env.LIVE_URL || 'https://omo.tail0d4a7c.ts.net:10000/live/').replace(/\/?$/, '/');

const args = process.argv.slice(2);
function opt(name, fallback) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
}
function flag(name) {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
}

const list_only = flag('--list');
const since = Number(opt('--since', -Infinity));
const csv_out = opt('--csv');
const dt = Number(opt('--dt', 0.1));
const save = opt('--save');
const src = args[0];

async function server_list() {
    const res = await fetch(LIVE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${LIVE_URL}: ${res.status}`);
    return (await res.json())
        .filter((f) => f.type === 'file' && f.name.endsWith('.live.log'))
        .map((f) => ({ name: f.name, size: f.size, mtime: new Date(f.mtime) }))
        .sort((a, b) => b.mtime - a.mtime);
}

async function server_status() {
    try {
        const res = await fetch(LIVE_URL + 'status.json', { cache: 'no-store' });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

async function download(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

let buf;
let name;

if (list_only) {
    const st = await server_status();
    if (st) console.log(`recorder: connected=${st.connected} device_online=${st.device.online} recording=${st.file ?? '-'} last_rx=${st.last_rx ?? '-'}`);
    for (const f of await server_list()) {
        const live = Date.now() - f.mtime < 60000 ? '  <- recording' : '';
        console.log(`${f.name}  ${(f.size / 1024 / 1024).toFixed(2)} MB  ${f.mtime.toISOString()}${live}`);
    }
    process.exit(0);
}

if (src === undefined) {
    const st = await server_status();
    if (st) console.log(`recorder: connected=${st.connected} device_online=${st.device.online} last_rx=${st.last_rx ?? '-'}`);
    const latest = (await server_list())[0];
    if (!latest) { console.log('no recordings on the server'); process.exit(0); }
    name = latest.name;
    buf = await download(LIVE_URL + encodeURIComponent(name));
} else if (src.endsWith(':latest')) {
    const host = src.slice(0, -':latest'.length);
    const remote = execFileSync('ssh', [host, 'ls -t ~/telemetry/*.live.log | head -1'], { encoding: 'utf8' }).trim();
    if (!remote) { console.log('no live logs yet'); process.exit(0); }
    name = path.basename(remote);
    const tmp = path.join(os.tmpdir(), name);
    execFileSync('rsync', ['-az', `${host}:${remote}`, tmp]);
    buf = fs.readFileSync(tmp);
} else if (/^https?:\/\//.test(src)) {
    name = decodeURIComponent(path.basename(new URL(src).pathname));
    buf = await download(src);
} else if (fs.existsSync(src)) {
    name = path.basename(src);
    buf = fs.readFileSync(src);
} else {
    name = src;
    buf = await download(LIVE_URL + encodeURIComponent(src));
}

if (save) fs.writeFileSync(save, buf);

const boot_time = Number(buf.readBigUInt64LE(16)); // BOOT header
const an = analyze(buf);
const ev = build_events(an);
const s = an.summary;
const r = (x, d = 1) => (typeof x === 'number' ? +x.toFixed(d) : x);
const mm = (o) => (o && typeof o === 'object' ? `max ${r(o.max)} mean ${r(o.mean)}` : r(o));

console.log(`file: ${name}  ${(buf.length / 1024).toFixed(0)} KB  ${r(s.duration, 0)} s  boot ${new Date(boot_time * 1000).toISOString()}`);

if (csv_out) {
    fs.writeFileSync(csv_out, to_csv(an, -Infinity, Infinity, dt, boot_time) + '\n');
    console.log(`csv: ${csv_out} (dt ${dt} s)`);
    console.log('columns: t_s (log time), wall_ms (epoch ms), ' + CHANNELS.map((c) => `${c.key}[${c.unit ?? ''}]=${c.label}`).join(', '));
    process.exit(0);
}

for (const k of ['speed', 'ibus_sum', 'p_dc', 'em_p', 'em_p_ma', 'bms_v', 'bms_dis', 'soc', 'energy_wh', 'em_energy_wh']) {
    if (s[k] !== undefined) console.log(`  ${k.padEnd(13)} ${mm(s[k])}`);
}

const shown = ev.filter((e) => e.t >= since);
console.log(`events${isFinite(since) ? ` since ${since}s` : ''}: ${shown.length}`);
for (const e of shown) console.log(`  ${e.t.toFixed(1).padStart(7)}s ${e.key ? '*' : ' '} [${e.cat}] ${e.msg}`);
