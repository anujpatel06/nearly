// What the pre-push hook runs. Builds the branch's session record, shows what
// it found, and puts it on the branch's open pull request.
//
// It used to ask first, in the terminal. But the push that matters is usually
// made by the agent — "raise a PR" — and an agent's push has no terminal, so the
// question was never asked and nothing was ever posted. The reviewer saw an
// empty pull request on every branch Nearly had recorded. Now it posts, as one
// comment that each push updates; `nearly --no-post` stops it for a repo.
//
//   node scripts/push-record.mjs <repo-path>
//
// Exits 0 no matter what. A recap is never worth failing someone's push over.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { paths } from '../server/paths.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repo = resolve(process.argv[2] || '.');
function configured() {
  for (const f of [paths.config(), join(root, '.nearly.json')]) {
    try {
      if (existsSync(f)) {
        const u = JSON.parse(readFileSync(f, 'utf8')).urlBase;
        if (u) return u;
      }
    } catch { /* try the next one */ }
  }
  return '';
}
const URL_BASE = (process.env.NEARLY_URL_BASE || configured() || '').replace(/\/$/, '');
// Narration takes about a second a scene, which is too long to make someone
// wait at a push. Opt in with NEARLY_AUDIO=1 when you are making the good one.
const WANT_AUDIO = process.env.NEARLY_AUDIO === '1';

// Colour only on a terminal; piped into a file or a CI log it is noise.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : String(s));
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : String(s));
const red = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : String(s));

function bail(msg) { if (msg) console.error(dim(`nearly: ${msg}`)); process.exit(0); }

// Which branch is being pushed. git tells a pre-push hook exactly that, one line
// per ref, on stdin. This used to read HEAD in the repo's main folder instead —
// wrong for a push from a git worktree, which runs this same hook with its own
// branch, and wrong for `git push origin other-branch`. A session that pushed
// eight branches from a worktree was told "no agent sessions recorded" eight
// times, about the main folder's branch.
async function pushedBranches() {
  if (process.env.NEARLY_PUSH_BRANCH) return [process.env.NEARLY_PUSH_BRANCH];
  if (!process.stdin.isTTY) {
    const text = await new Promise((done) => {
      let s = '';
      const t = setTimeout(() => done(s), 1500);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (s += d));
      process.stdin.on('end', () => { clearTimeout(t); done(s); });
      process.stdin.on('error', () => { clearTimeout(t); done(s); });
    });
    const refs = text.split('\n').map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 2 && /^refs\/heads\//.test(f[0]) && !/^0+$/.test(f[1]))   // deletes push nothing
      .map((f) => f[0].slice('refs/heads/'.length));
    if (refs.length) return [...new Set(refs)];
  }
  // Run by hand, or by an old hook that gave stdin to the terminal: the branch
  // checked out where the push is happening — this worktree, when it is one.
  const { toplevelOf, branchOf, repoIdOf } = await import('../server/repo-id.mjs');
  const here = toplevelOf(process.cwd());
  const at = here && repoIdOf(here) === repoIdOf(repo) ? here : repo;
  const b = branchOf(at);
  return b ? [b] : [];
}

const pushed = await pushedBranches();
if (!pushed.length) bail('detached HEAD, nothing to record');
// Several branches in one push: one record each, as separate runs, so one branch
// with nothing recorded does not stop the next from being handed over.
if (pushed.length > 1) {
  for (const b of pushed) {
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), repo],
      { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NEARLY_PUSH_BRANCH: b } });
  }
  process.exit(0);
}
const branch = pushed[0];

const args = ['--branch', branch, '--repo', repo];
if (!WANT_AUDIO) args.push('--no-audio');
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-recap.mjs'), ...args],
  { cwd: root, encoding: 'utf8', timeout: 180_000 });

if (build.status !== 0) {
  // A branch with no agent sessions is the normal case for hand-written work,
  // not an error worth shouting about. Node prints a stack plus its own version
  // footer, so pick the message line rather than the last line.
  const err = build.stderr || '';
  if (/no recordings on branch/.test(err)) bail(`no agent sessions recorded on ${branch}`);
  const line = err.split('\n').map((l) => l.trim())
    .find((l) => /^(Error|TypeError|ReferenceError|SyntaxError)[:\s]/.test(l));
  bail(line || `could not build the record (exit ${build.status})`);
}

const safe = (x) => String(x).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const slug = `${safe(basename(repo))}--${safe(branch)}`;
const storyPath = join(paths.records(), `${slug}.json`);
if (!existsSync(storyPath)) bail('record built but not found on disk');

const sb = JSON.parse(readFileSync(storyPath, 'utf8'));
const cover = sb.scenes.find((s) => s.kind === 'cover');
const outcome = sb.scenes.find((s) => s.kind === 'outcome');
const notDone = outcome?.notDone ?? [];
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

console.log('');
console.log(bold(`  Session record for ${branch}`));
console.log(dim(`  ${sb.runs} session${sb.runs === 1 ? '' : 's'} · ${cover.title} · ${mmss(sb.totalS)} to watch`));
if (notDone.length) {
  console.log('');
  console.log(`  ${red('These never happened, and the diff will not show them:')}`);
  for (const n of notDone) {
    const by = n.by === 'policy' ? 'blocked by policy' : n.by === 'timeout' ? 'nobody answered' : 'you refused it';
    console.log(`    · ${n.tool}  ${n.what}  ${dim(`(${by})`)}`);
  }
}
console.log('');
console.log(dim(`  ${URL_BASE ? `${URL_BASE}/${slug}.html` : `ui/records/${slug}.html (set NEARLY_URL_BASE to publish it)`}`));
console.log('');

// A push is the right moment to update: it happens often for anyone actually
// using this, the person is present and waiting, and it is nowhere near the path
// an agent's tool call travels. Turning it on for a repo happens once, and the
// hooks are excluded on purpose, so without this an active user would never
// hear about a fix.
try {
  const { checkForUpdate, applyUpdate } = await import('./update-check.mjs');
  applyUpdate(await checkForUpdate(), { background: true });
} catch { /* never worth failing a push over */ }

// Finding the pull request needs gh. Not having it and not having a pull
// request are different problems with the same silence, and they were reported
// as the same sentence — which sent people off to raise a pull request they
// were already looking at.
const hasGh = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasGh) {
  console.log(dim('  The record is built, but posting it to a pull request needs the GitHub CLI,'));
  console.log(dim('  and `gh` is not on PATH. Install it from cli.github.com, then `gh auth login`.'));
  console.log(dim('  `nearly doctor` checks the whole chain.'));
  console.log('');
  process.exit(0);
}
const { prForBranch } = await import('./pr-state.mjs');
const pr = prForBranch(repo, branch);
if (pr.state !== 'open') {
  const why = pr.state === 'signed-out'
    ? 'gh is installed but not signed in. Run `gh auth login`, then push again.'
    : pr.state === 'merged' || pr.state === 'closed'
      // Posting onto a finished conversation reaches nobody who is reviewing.
      ? `The pull request for this branch, #${pr.number}, is already ${pr.state}. Open a new one, then push again to attach the record.`
      : 'No open pull request for this branch yet. Raise one, then push again to attach the record.';
  console.log(dim(`  ${why}`));
  console.log('');
  process.exit(0);
}

const { postingOff } = await import('./posting.mjs');
if (postingOff(repo)) {
  console.log(dim(`  Not posted: posting is off for this repo. \`nearly --post\` turns it back on.`));
  console.log('');
  process.exit(0);
}

const postArgs = [join(root, 'scripts', 'post-recap.mjs'), slug];
if (URL_BASE) postArgs.push('--url-base', URL_BASE);
const post = spawnSync(process.execPath, postArgs, { cwd: root, encoding: 'utf8', timeout: 60_000 });
console.log(post.status === 0
  ? `  Record ${(post.stdout || '').trim()} ${dim('(nearly --no-post stops this)')}`
  : red(`  Could not post: ${(post.stderr || post.stdout || '').trim().split('\n').pop()}`));
console.log('');
process.exit(0);
