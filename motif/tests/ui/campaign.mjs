// Run the stress test over a spread of seeds and report which, if any, failed.
//
// One passing seed proves very little. A campaign is what turns "it did not
// break this time" into "it did not break across a few hundred different
// sequences of interactions" - and any seed that does break is printed with
// the flag needed to replay it exactly.
//
//   node campaign.mjs                 8 seeds
//   node campaign.mjs 20 200          20 seeds, 200 steps each
import { spawn } from 'node:child_process';

const runs = Number(process.argv[2] ?? 8);
const steps = Number(process.argv[3] ?? 130);

const run = (seed) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['stress.mjs', '--seed', String(seed),
                                         '--steps', String(steps)],
                      { cwd: import.meta.dirname });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ seed, code, out }));
});

console.log(`\nStress campaign: ${runs} seeds x ${steps} steps\n`);

const failed = [];
for (let i = 0; i < runs; i++) {
  // Spread rather than sequential, so the seeds are not near-neighbours.
  const seed = 1 + i * 7919;
  const { code, out } = await run(seed);
  const summary = out.split('\n').find((l) => /^(PASS|FAIL)/.test(l)) ?? 'no result';
  console.log(`  seed ${String(seed).padStart(6)}  ${summary.trim()}`);
  if (code !== 0) {
    failed.push(seed);
    // The distinct problems, indented under the seed that found them.
    for (const line of out.split('\n')) {
      if (/^ {2}[a-z]/.test(line) || /^ {6}\S/.test(line)) console.log(`    ${line.trim()}`);
    }
  }
}

console.log('');
if (failed.length) {
  console.log(`${failed.length} of ${runs} seeds failed. Replay one with:`);
  console.log(`  node stress.mjs --seed ${failed[0]} --steps ${steps}\n`);
  process.exit(1);
}
console.log(`All ${runs} seeds clean.\n`);
