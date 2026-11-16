// A tiny program used by the result zone tests: after Enter it prints a report
// (a table, then a status line) and waits, like a real terminal application.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('INVENTORY TERMINAL v1');
rl.question('Press Enter to run the report: ', () => {
  console.log('ID  NAME     QTY');
  console.log('1   Widget   5');
  console.log('2   Gadget   12');
  console.log('3   Gizmo    0');
  console.log('Status: OK (3 items)');
  // Stay alive so the screen is still there when it is read
  setInterval(() => { }, 1000);
});
