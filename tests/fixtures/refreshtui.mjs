// A full-screen program that never stops redrawing, used by the screen-pattern tests: every 100 ms it clears
// the screen and draws a clock line that changes each time. The stable menu line appears 600 ms after the
// start. Press 1 to show "Started", 2 to quit.
const STABLE_AFTER_MS = 600;
const startedAt = Date.now();
let message = '';
let ticks = 0;

function draw() {
  ticks += 1;
  let screen = '\x1b[2J\x1b[H';
  screen += `Clock: ${String(ticks).padStart(5, '0')}\r\n`;
  if (Date.now() - startedAt >= STABLE_AFTER_MS) {
    screen += 'Menu: [1] Start  [2] Quit\r\n';
  }
  if (message !== '') screen += `${message}\r\n`;
  process.stdout.write(screen);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  const key = String(chunk);
  if (key === '1') message = 'Started';
  if (key === '2' || key === '\x03') {
    process.stdout.write('\x1b[2J\x1b[HBye\r\n');
    process.exit(0);
  }
});

draw();
setInterval(draw, 100);
