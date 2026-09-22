// Install a git pre-push hook that builds the branch's session record and
// offers to post it to the pull request.
//
//   node scripts/install-push-hook.mjs <repo-path> [--cmd "<how to run nearly>"] [--remove]
//
// Pushing is the moment your work stops being yours and becomes someone else's
// to review, so it is the right moment to hand over the record. The hook:
//
//   1. builds one record for the branch being pushed, merging every session
//   2. prints what it found, including anything that was refused
//   3. asks whether to post it, reading your answer from the terminal
//   4. gets out of the way
//
// It never blocks a push. If the record cannot be built, or you say no, or
// anything at all goes wrong, the push proceeds and the hook exits 0. Posting
// is always your explicit "y" — a record of what you refused is more revealing
// than a diff, and software should not publish that on your behalf.

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const argv = process.argv.slice(2);
const cmdAt = argv.indexOf('--cmd');
// How the hook runs Nearly. attach passes the same command it wrote into the
// agent hooks, so both survive the same things. The default — this file's own
// folder — is only right for a checkout: run through npx it was the npx cache,
// and once npm cleared that every push printed a stack trace while doctor went
// on reporting the hook as installed.
const RUN = cmdAt !== -1 && argv[cmdAt + 1] ? argv[cmdAt + 1] : `node ${JSON.stringify(join(root, 'bin', 'nearly.mjs'))}`;
const repo = resolve(argv.find((a, i) => !a.startsWith('--') && i !== cmdAt + 1) || '.');
const remove = argv.includes('--remove');

if (!existsSync(join(repo, '.git'))) {
  console.error(`${repo} is not a git repository`);
  process.exit(1);
}
// Stable across renames on purpose: this string is how a hook is identified as
// ours years from now, so it must never carry the product name.
const MARKER = 'x-session-record-hook';
const hooksDir = join(repo, '.git', 'hooks');
const hookPath = join(hooksDir, 'pre-push');

// Ours by the marker, or by the exact comment older versions wrote. Matching the
// word "nearly" anywhere claimed any hook that happened to mention it.
const ours = (text) => text.includes(MARKER) || /^# (control-room|nearly): hand the session record/m.test(text);

if (remove) {
  if (!existsSync(hookPath)) { console.log('No pre-push hook to remove.'); process.exit(0); }
  // Installing refused to overwrite someone else's hook; removing used to delete
  // it anyway, and said "removed" while doing so.
  if (!ours(readFileSync(hookPath, 'utf8'))) {
    console.error(`${hookPath} was not written by Nearly, so it was left alone.`);
    process.exit(1);
  }
  rmSync(hookPath);
  console.log(`Removed ${hookPath}`);
  process.exit(0);
}

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, 'utf8');
  const mine = ours(existing);
  if (!mine) {
    console.error(`${hookPath} already exists and was not written by Nearly.`);
    console.error('Refusing to overwrite it. Move it aside, or add this line to it yourself:');
    console.error(`  ${RUN} push-record "${repo}" || true`);
    process.exit(1);
  }
}

// Safe inside the double quotes of a sh script.
const shq = (s) => String(s).replace(/[\\"$`]/g, '\\$&');

mkdirSync(hooksDir, { recursive: true });
writeFileSync(hookPath, `#!/bin/sh
# ${MARKER}
# nearly: hand the session record over at push time.
# Never blocks the push; "exit 0" at the end is the whole safety story.
#
# git gives a hook no terminal of its own, so borrow the user's when there is
# one. Scripted and CI pushes have no controlling terminal: run anyway, print
# nothing to ask, and post nothing.
#
# The test has to be an actual open. /dev/tty always exists and is always
# readable and writable by its permission bits; opening it is what fails, with
# ENXIO, when no terminal is attached. The open has to happen inside a subshell
# too: a failed redirection is reported by the shell itself, so redirecting the
# command's stderr does not silence it, but redirecting the subshell's does.
# stdin is left alone: git writes the refs being pushed there, and that is how
# a push from a worktree, or of a branch that is not checked out, is recorded as
# the branch it actually is.
if (: >/dev/tty) 2>/dev/null; then
  ${RUN} push-record "${shq(repo)}" >/dev/tty 2>&1 || true
else
  NEARLY_NO_TTY=1 ${RUN} push-record "${shq(repo)}" || true
fi
exit 0
`);
chmodSync(hookPath, 0o755);

console.log(`Installed ${hookPath}`);
console.log('');
console.log('Next push on this repo will build the branch record and post it to the open pull request.');
console.log('Set NEARLY_URL_BASE so the comment can link to the hosted page, e.g.');
console.log('  export NEARLY_URL_BASE=https://<user>.github.io/<repo>/recaps');
console.log('Remove it again with: node scripts/install-push-hook.mjs "' + repo + '" --remove');
