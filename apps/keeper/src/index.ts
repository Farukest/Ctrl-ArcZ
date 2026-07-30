import { run, tick, keeperAddress } from './keeper.js';

/**
 * Entry point. `--once` runs a single tick and exits, which is what the tests and
 * a cron-style deployment use; the default is the long-running loop.
 */
const once = process.argv.includes('--once');

if (once) {
  const report = await tick();
  console.log(
    JSON.stringify(
      report,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
  process.exit(0);
} else {
  console.log(`starting Ctrl+ArcZ keeper as ${keeperAddress}`);
  await run();
}
