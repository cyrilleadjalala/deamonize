// A tiny interactive program used by the terminal tests: it asks for a name,
// greets, then offers a one-key menu.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Your name: ', (name) => {
  console.log(`Hello ${name}!`);
  rl.question('Choose [1] Greet again, [2] Quit: ', (choice) => {
    console.log(choice === '1' ? `Hello again ${name}!` : 'Bye');
    rl.close();
  });
});
