// A slow command line program used by the screen-pattern tests. The prompt "slow> " appears after a
// random delay of 300 to 1500 ms, and a command prints its output slowly, one line every 120 ms,
// with the prompt after the last line.
//
//   count <n>   prints "item 1" ... "item n", then "done <n>"
//   quit        ends the program
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'slow> ' });
// Options: --delay=<ms> fixes the startup delay, --line-delay=<ms> the time between two output lines (default 120)
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const LINE_DELAY_MS = Number(option('line-delay') ?? 120);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startupDelay = option('delay') !== undefined
  ? Number(option('delay'))
  : 300 + Math.floor(Math.random() * 1200);

let busy = Promise.resolve();

rl.on('line', (line) => {
  busy = busy.then(async () => {
    const [command, argument] = line.trim().split(/\s+/);
    if (command === 'count') {
      const n = Math.min(20, Number(argument) || 3);
      for (let i = 1; i <= n; i++) {
        await sleep(LINE_DELAY_MS);
        console.log(`item ${i}`);
      }
      await sleep(LINE_DELAY_MS);
      console.log(`done ${n}`);
    } else if (command === 'quit') {
      rl.close();
      return;
    } else if (command !== '') {
      console.log(`unknown command: ${command}`);
    }
    rl.prompt();
  });
});

rl.on('close', () => process.exit(0));

await sleep(startupDelay);
console.log('slowcli ready');
rl.prompt();
