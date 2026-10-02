/*
 * Waits until the logger is online, writes the telemetry interval to its NVS
 * ({name}/set/dev/intv, uint32 LE) and exits on ack. The firmware reads intv
 * at boot, so the new value takes effect on the next power cycle; no restart
 * is sent here so a running session is never interrupted.
 *
 * usage: node --env-file=.env set-intv.mjs [ms=100]
 */

import mqtt from 'mqtt';

const INTV = Number(process.argv[2] ?? 100);
const USER = process.env.MQTT_USER;

const client = mqtt.connect({
    protocol: 'wss',
    host: process.env.MQTT_HOST || 'v2.monolith.luftaquila.io',
    port: 443,
    username: USER,
    password: process.env.MQTT_PASS,
    reconnectPeriod: 5000
});

let sent = false;

client.on('connect', () => {
    console.log(`connected; waiting for ${USER} to come online`);
    client.subscribe([`${USER}/d/boot`, `${USER}/ack/set`]);
});

client.on('message', (topic, msg) => {
    if (topic.endsWith('/d/boot')) {
        if (msg.toString() === 'OFFLINE' || sent) return;
        const payload = Buffer.alloc(4);
        payload.writeUInt32LE(INTV);
        client.publish(`${USER}/set/dev/intv`, payload, { qos: 2 });
        sent = true;
        console.log(`${new Date().toISOString()} device online; sent intv=${INTV}`);
    } else if (topic.endsWith('/ack/set') && sent) {
        console.log(`${new Date().toISOString()} ack: ${msg.toString()} (applies on next boot)`);
        client.end(false, () => process.exit(msg.toString() === 'ok' ? 0 : 1));
    }
});

client.on('error', (e) => console.error(`mqtt error: ${e.message}`));
