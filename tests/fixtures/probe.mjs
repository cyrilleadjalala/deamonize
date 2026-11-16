// A terminal program that reports what it can see of its surroundings, used to check
// that a sandbox really isolates it. It prints one `name=value` line per probe, then
// waits for Enter.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import readline from 'node:readline';

function read(path) {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return 'unreadable';
  }
}

function canWrite(path) {
  try {
    writeFileSync(path, 'x');
    return 'allowed';
  } catch {
    return 'denied';
  }
}

function canReachNetwork() {
  return new Promise((resolve) => {
    // A public address: it can only be reached through a network
    const socket = connect({ host: '1.1.1.1', port: 53, timeout: 1500 });
    socket.on('connect', () => (socket.destroy(), resolve('reachable')));
    socket.on('timeout', () => (socket.destroy(), resolve('unreachable')));
    socket.on('error', () => resolve('unreachable'));
  });
}

console.log(`platform=${process.platform}`);
console.log(`uid=${process.getuid?.() ?? 'n/a'}`);
console.log(`memory_max=${read('/sys/fs/cgroup/memory.max')}`);
console.log(`cpu_max=${read('/sys/fs/cgroup/cpu.max')}`);
console.log(`write_root=${canWrite('/probe-test')}`);
console.log(`write_tmp=${canWrite('/tmp/probe-test')}`);
console.log(`host_files=${existsSync('/mnt/c') || existsSync('/host_mnt') ? 'visible' : 'absent'}`);
console.log(`network=${await canReachNetwork()}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Press Enter to finish: ', () => rl.close());
