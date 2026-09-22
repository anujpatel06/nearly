// Which repository a folder belongs to, and which branch it is on.
//
// A session used to be filed under the branch it started on and the exact folder
// it started in. Agents do neither thing reliably: they create a branch per task
// and switch to it, and Claude Code runs many sessions in git worktrees — a second
// folder, with its own branch, sharing one repository. A real session pushed eight
// branches from a worktree and every push said "no agent sessions recorded",
// because the record was looking for the branch and the folder it started with.
//
// A repository's identity is its shared git directory. The main checkout and every
// worktree of it report the same one, so matching on it treats them as what they
// are: one repo.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const git = (dir, args) => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch { return null; }
};

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const real = (p) => { try { return fold(realpathSync.native(p)); } catch { return fold(resolve(p)); } };

// The shared .git directory, resolved. Relative when git is old enough not to
// know --path-format, so resolve it against the folder it was asked from.
export function repoIdOf(dir) {
  if (!dir) return null;
  const d = git(dir, ['rev-parse', '--git-common-dir']);
  return d ? real(resolve(dir, d)) : null;
}

export const toplevelOf = (dir) => (dir ? git(dir, ['rev-parse', '--show-toplevel']) : null);

export function branchOf(dir) {
  const b = dir ? git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  return b && b !== 'HEAD' ? b : null;
}

export const sameRepo = (a, b) => {
  const x = repoIdOf(a), y = repoIdOf(b);
  return !!x && x === y;
};
