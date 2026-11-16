// A program that reports the size of its terminal and draws a line 100 columns wide:
// it is cut or wrapped on a terminal narrower than 100 columns.
import readline from 'node:readline';

console.log(`size ${process.stdout.columns}x${process.stdout.rows}`);
console.log('<' + '-'.repeat(98) + '>');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Press Enter: ', () => {
  console.log(`done ${process.stdout.columns}x${process.stdout.rows}`);
  rl.close();
});
