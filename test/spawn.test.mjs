/**
 * Regression tests for the setup wizard's command invocation.
 *
 * THE BUG THESE EXIST TO PREVENT
 * ------------------------------
 * run() used to pass an args array together with shell:true on Windows. That
 * concatenates the arguments into a single command line WITHOUT escaping, so
 * the shell re-splits any value containing a space. The multi-word
 * --description turned into nine separate arguments and `gh repo create`
 * refused with "accepts at most 1 arg(s), received 9". It was also the cause
 * of Node's DEP0190 deprecation warning.
 *
 * The first test below asserts the argv shape. The second actually spawns a
 * process and inspects the argv it really received, which is what would have
 * caught the original defect on Windows - the shape was always correct, it
 * was the transport that mangled it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, repoCreateArgs } from '../setup/lib.mjs';

const DESCRIPTION = 'Tracks every Asbury package to delivery. Data is encrypted.';

test('gh repo create passes the multi-word description as ONE argv entry', () => {
  const args = repoCreateArgs('asbury-package-tracker', DESCRIPTION);

  const flag = args.indexOf('--description');
  assert.notEqual(flag, -1, '--description must be present');
  assert.equal(args[flag + 1], DESCRIPTION,
    'the whole description must sit in a single argv entry');
  assert.equal(args.length, 6,
    `gh must receive exactly 6 args, not ${args.length} - the original bug sent 9`);
  assert.ok(args[flag + 1].includes(' '), 'this test is meaningless if it has no spaces');
});

test('a spawned process really receives multi-word arguments intact', async () => {
  // Echo argv back as JSON. If any layer re-splits on spaces, this fails.
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const passed = ['--description', DESCRIPTION, '--public', 'a&b|c', 'trailing arg'];

  // "--" stops node parsing the leading-dash entries as its own options.
  const r = await run(process.execPath, ['-e', script, '--', ...passed]);
  assert.equal(r.code, 0, `spawn failed: ${r.err}`);

  const received = JSON.parse(r.out);
  assert.deepEqual(received, passed,
    'every argument must arrive exactly as sent, spaces and shell metacharacters included');
  assert.equal(received.length, passed.length,
    `expected ${passed.length} arguments, got ${received.length}`);
});

test('shell metacharacters in an argument are never interpreted', async () => {
  const script = 'process.stdout.write(process.argv[1])';
  // Under a shell these would redirect, chain and substitute. As argv they
  // are just text. OAuth URLs contain & and are passed this way.
  const hostile = 'https://example.com/?a=1&b=2 && echo pwned > out.txt';

  const r = await run(process.execPath, ['-e', script, hostile]);
  assert.equal(r.code, 0);
  assert.equal(r.out, hostile);
});

test('a missing executable reports a clear reason instead of throwing', async () => {
  const r = await run('definitely-not-a-real-command-xyz', ['--version']);
  assert.equal(r.code, -1);
  assert.match(r.err, /not found on PATH/);
});

test('stdin input still reaches the process (used for gh secret set)', async () => {
  const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d))';
  const r = await run(process.execPath, ['-e', script], { input: 'a secret with spaces' });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'a secret with spaces');
});
