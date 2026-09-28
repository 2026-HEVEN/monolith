import { Terminal } from '@xterm/xterm';

export const term = new Terminal({
    fontFamily: 'Source Code Pro, monospace',
    convertEol: true,
    scrollback: 5000
});
