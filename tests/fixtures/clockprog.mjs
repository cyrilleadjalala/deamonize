// A terminal program with a live clock, used by the drift tests.
// Usage: node clockprog.mjs <status-file>
// Row 0 shows the content of the status file, row 1 a clock that changes on every run.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const status = readFileSync(process.argv[2], 'utf8').trim();
console.log(`Status: ${status}`);
console.log(`Clock: ${Date.now()}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Press enter: ', () => {
  console.log('Done');
  rl.close();
});
