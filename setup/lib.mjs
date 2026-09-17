/**
 * Shared helpers for the setup wizard.
 *
 * Credential handling rule, enforced here: a secret entered by the operator
 * is held in memory only long enough to pipe it into `gh secret set` on
 * stdin. It is never written to a file, never passed as a command-line
 * argument (where it would land in the shell history and process list), and
 * never echoed to the terminal.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

export const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export function heading(text) {
  console.log(`\n${c.b(text)}\n${'-'.repeat(text.length)}`);
}

export function say(text = '') { console.log(text); }
export function ok(text) { console.log(`  ${c.green('OK')}  ${text}`); }
export function warn(text) { console.log(`  ${c.yellow('!!')}  ${text}`); }
export function bad(text) { console.log(`  ${c.red('XX')}  ${text}`); }
export function step(text) { console.log(`  ${c.dim('..')}  ${text}`); }

/**
 * Run a command, capture output. Never throws on non-zero; returns the code.
 *
 * SHELL IS DELIBERATELY OFF. Passing an args array together with shell:true
 * concatenates the arguments into one command line without escaping them, so
 * any value containing a space is re-split by the shell. That turned a single
 * --description "Tracks every Asbury package to delivery." into nine separate
 * arguments and broke `gh repo create`. It is also what Node's DEP0190
 * deprecation warns about, and it is an injection hazard for any value that
 * ever comes from outside this file.
 *
 * With shell off, each array entry is passed to the process verbatim, spaces
 * and all. Every executable this wizard invokes (git, gh, node, rundll32) is
 * a real .exe, so Windows resolves them without a shell. Do not add a .cmd or
 * .bat target here - Node refuses those without a shell by design.
 */
export function run(cmd, args, { input, cwd, quiet = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: [input === undefined ? 'inherit' : 'pipe', quiet ? 'pipe' : 'inherit', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on('error', (e) => {
      const message = e.code === 'ENOENT'
        ? `${cmd} was not found on PATH`
        : e.message;
      resolve({ code: -1, out, err: message });
    });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

export async function has(cmd, versionArg = '--version') {
  const r = await run(cmd, [versionArg]);
  return r.code === 0;
}

let rl;
function readline() {
  if (!rl) rl = createInterface({ input: stdin, output: stdout });
  return rl;
}
export function closePrompts() { rl?.close(); rl = undefined; }

export function ask(question, fallback = '') {
  return new Promise((resolve) => {
    readline().question(`  ${question}${fallback ? ` [${fallback}]` : ''}: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
  });
}

export async function confirm(question, def = true) {
  const answer = await ask(`${question} ${def ? '(Y/n)' : '(y/N)'}`, def ? 'y' : 'n');
  return /^y/i.test(answer);
}

/** Read a secret without echoing it to the terminal. */
export function askSecret(question) {
  return new Promise((resolve) => {
    const r = readline();
    const onData = (char) => {
      if (['\n', '\r', ''].includes(String(char))) {
        stdin.removeListener('data', onData);
        stdout.write('\n');
      } else {
        // Redraw the prompt with no characters revealed.
        stdout.clearLine?.(0);
        stdout.cursorTo?.(0);
        stdout.write(`  ${question}: `);
      }
    };
    stdout.write(`  ${question}: `);
    stdin.on('data', onData);
    r.question('', (value) => {
      stdin.removeListener('data', onData);
      resolve(value.trim());
    });
  });
}

/**
 * Open a URL in the operator's browser so they never have to copy-paste one.
 *
 * On Windows this uses rundll32 rather than `cmd /c start`. cmd re-parses its
 * own argument string even when Node passes it as a single argv entry, so an
 * OAuth URL containing & would be truncated at the first parameter. rundll32
 * takes the URL verbatim.
 */
export async function openUrl(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  await run(cmd, args);
}

// ------------------------------------------------------------ GitHub ----

/**
 * The exact argv for `gh repo create`, as a pure function so it can be
 * asserted in tests without touching the network. The description is one
 * argv entry containing spaces; if anything ever re-splits it, gh reports
 * "accepts at most 1 arg(s)" and repository creation fails.
 */
export function repoCreateArgs(name, description) {
  return ['repo', 'create', name, '--public', '--description', description];
}

/**
 * The exact argv for `gh secret set`. Pure, so the contract is testable.
 *
 * Two properties matter and are asserted in test/spawn.test.mjs:
 *   - the value is NOT in argv (it goes on stdin), so it cannot leak into the
 *     process list;
 *   - no --body-file flag, which gh secret set does not have. Passing it is
 *     what produced "Could not store STATE_KEY".
 */
export function secretSetArgs(slug, name) {
  return ['secret', 'set', name, '--repo', slug];
}

/**
 * Turn a failed command into something an operator can act on.
 *
 * A bare "Could not store STATE_KEY" tells nobody anything. Every failure
 * branch in this wizard routes through here so the exit code and the tool's
 * own stderr always reach the screen.
 */
export function describeFailure(r) {
  const parts = [];
  if (r.err) parts.push(r.err.split('\n').slice(0, 4).join(' / '));
  if (!r.err && r.out) parts.push(r.out.split('\n').slice(0, 4).join(' / '));
  parts.push(`exit code ${r.code}`);
  return parts.join(' — ');
}

/** Scopes the wizard genuinely needs, and what each one is for. */
export const REQUIRED_SCOPES = [
  ['repo', 'create the repository and store Actions secrets'],
  ['workflow', 'install the scheduled workflow files'],
];

export const gh = {
  async ready() {
    if (!(await has('gh'))) return { ok: false, reason: 'not-installed' };
    const r = await run('gh', ['auth', 'status']);
    return r.code === 0
      ? { ok: true }
      : { ok: false, reason: 'not-logged-in', detail: describeFailure(r) };
  },

  /**
   * The scopes the current token actually carries.
   * Checked up front so a missing scope is reported in step 1 rather than
   * surfacing as an opaque failure four steps later.
   */
  async scopes() {
    const r = await run('gh', ['auth', 'status']);
    const text = `${r.out}\n${r.err}`;
    const m = /Token scopes:\s*(.+)/i.exec(text);
    if (!m) return null; // unknown, not empty - do not block on a parse failure
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  },

  async missingScopes() {
    const have = await gh.scopes();
    if (have === null) return [];
    return REQUIRED_SCOPES.filter(([name]) => !have.includes(name));
  },

  async login() {
    say('\n  A browser window will open so you can sign in to GitHub.');
    say(`  ${c.dim('Nothing you type here is stored by this script.')}\n`);
    const r = await run('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], { quiet: false });
    return r.code === 0;
  },

  async currentUser() {
    const r = await run('gh', ['api', 'user', '--jq', '.login']);
    return r.code === 0 ? r.out : null;
  },

  async repoExists(slug) {
    const r = await run('gh', ['repo', 'view', slug, '--json', 'name']);
    return r.code === 0;
  },

  /**
   * Create the repository, idempotently.
   *
   * Public, because GitHub Pages and unmetered Actions minutes are only free
   * on public repositories. All data in it is encrypted.
   *
   * Returns { ok, created, reason }. A repository that already exists is a
   * success with created:false - a previous run may have got this far before
   * failing, and re-running must reuse it rather than fail or duplicate.
   */
  async createRepo(slug, name, description) {
    if (await gh.repoExists(slug)) return { ok: true, created: false };

    const r = await run('gh', repoCreateArgs(name, description));
    if (r.code === 0) return { ok: true, created: true };

    // Creation reported failure. It may still have succeeded, or lost a race
    // with another run, so the authoritative check is whether it exists now.
    if (await gh.repoExists(slug)) return { ok: true, created: false };

    return { ok: false, created: false, reason: r.err || r.out || `gh exited ${r.code}` };
  },

  /**
   * Store an Actions secret.
   *
   * The value goes on STDIN, never in argv, so it cannot appear in the
   * process list or a shell history.
   *
   * NOTE: `gh secret set` has no --body-file flag. It has --body (argv, which
   * we must not use for secrets) and --env-file (a dotenv file, a different
   * thing). When neither is given it reads the value from stdin, which is the
   * only safe option and the one used here. Passing --body-file made gh exit
   * with "unknown flag" and was the original cause of "Could not store
   * STATE_KEY".
   *
   * Returns { ok, detail } - detail carries gh's own stderr for the operator.
   */
  async setSecret(slug, name, value) {
    const r = await run('gh', ['secret', 'set', name, '--repo', slug], { input: value });
    return r.code === 0
      ? { ok: true }
      : { ok: false, detail: describeFailure(r) };
  },

  async setVariable(slug, name, value) {
    // Variables are not secret by definition, but stdin keeps the handling
    // uniform and avoids any quoting question.
    const r = await run('gh', ['variable', 'set', name, '--repo', slug], { input: value });
    return r.code === 0
      ? { ok: true }
      : { ok: false, detail: describeFailure(r) };
  },

  async listSecrets(slug) {
    const r = await run('gh', ['secret', 'list', '--repo', slug, '--json', 'name', '--jq', '.[].name']);
    return r.code === 0 ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  },

  async listVariables(slug) {
    const r = await run('gh', ['variable', 'list', '--repo', slug, '--json', 'name', '--jq', '.[].name']);
    return r.code === 0 ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  },

  async enablePages(slug) {
    // Create the Pages site from the gh-pages branch; if it already exists,
    // update it instead. 409 from POST means "already configured".
    const body = JSON.stringify({ source: { branch: 'gh-pages', path: '/' } });
    const post = await run('gh', ['api', '-X', 'POST', `repos/${slug}/pages`, '--input', '-'], { input: body });
    if (post.code === 0) return { ok: true, detail: 'created' };

    const put = await run('gh', ['api', '-X', 'PUT', `repos/${slug}/pages`, '--input', '-'], { input: body });
    if (put.code === 0) return { ok: true, detail: 'updated' };

    return { ok: false, detail: describeFailure(put) };
  },

  async pagesUrl(slug) {
    const r = await run('gh', ['api', `repos/${slug}/pages`, '--jq', '.html_url']);
    return r.code === 0 && r.out ? r.out : null;
  },

  async dispatch(slug, workflow) {
    const r = await run('gh', ['workflow', 'run', workflow, '--repo', slug]);
    return r.code === 0
      ? { ok: true }
      : { ok: false, detail: describeFailure(r) };
  },
};
