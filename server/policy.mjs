// The consent gradient: which tier a tool call lands in, and what "always" and
// "never" attach to.
//
// Kept apart from the server because this is the one piece where a mistake is
// silent and expensive. A rule key that is too broad turns one "always" into
// blanket permission for a whole class of commands; a never rule that does not
// match means a destructive command runs. Both are testable, so they are tested.

import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';

// ===========================================================================
// Never: refused outright, with nobody asked.
// ===========================================================================
//
// One principle: refuse what cannot be undone. A file deleted inside the repo
// comes back from git; a home directory does not. A feature branch pushed is how
// work reaches review; a force-push rewrites what other people already have.
// A secret read into an agent's context cannot be un-read.
//
// The first version matched keywords, which refused `rm -rf node_modules` and
// every push. The second parsed commands naively, and two independent test runs
// walked straight past it — `cd ~ && rm -rf Documents`, `/bin/rm -rf ~`,
// `bash -c "rm -rf ~"`, `git -c x=y push --force`, a symlink out of the repo —
// and in a live session three folders were actually deleted. Under unattended
// mode anything these rules miss simply runs.
//
// So this reads a command the way a shell runs it: a `cd` moves where later
// paths land, `bash -c`, `eval`, `$(…)` and `xargs` carry commands inside other
// commands, a symlink points somewhere else, `git -c` pushes `push` further
// along, and `git checkout main &&` changes which branch a later push leaves.
//
// It is still not a sandbox. It catches what a well-meaning agent actually
// types, and is honest about that in the README. Code handed to an interpreter
// is only inspected for the obvious; real isolation needs a container.

const TEMPLATE_SUFFIX = new Set(['example', 'sample', 'template', 'dist', 'defaults', 'schema', 'vault']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox', 'powershell', 'pwsh', 'cmd']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript']);
const RUNNERS = new Set([...SHELLS, ...INTERPRETERS, 'iex', 'invoke-expression', 'source', '.']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'aria2c']);
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'caffeinate', 'chronic', 'unbuffer', 'noglob', 'watch']);
const ESCALATE = new Set(['sudo', 'doas', 'pkexec', 'su', 'run0', 'runas', 'gsudo']);
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'gawk', 'sed',
  'strings', 'xxd', 'od', 'hexdump', 'base64', 'nl', 'tac', 'jq', 'yq', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'openssl', 'gpg',
  'type', 'get-content', 'gc', 'select-string', 'sls', 'pbcopy', 'xclip', 'wl-copy', 'clip']);
const SENDERS = new Set(['curl', 'wget', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'ssh', 'ftp', 'http', 'https', 'mail', 'sendmail', 'mutt',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const COPIERS = new Set(['cp', 'mv', 'install', 'ln', 'tar', 'zip', '7z', 'gzip', 'bzip2', 'xz', 'copy-item', 'move-item', 'copy', 'move', 'xcopy', 'robocopy']);
const DISK = new Set(['mkfs', 'mke2fs', 'newfs', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'parted', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk']);
const DELETERS = ['rm', 'unlink', 'shred', 'rimraf', 'del-cli', 'del', 'erase', 'remove-item', 'ri', 'rd', 'rmdir', 'truncate'];
const PROTECTED = ['main', 'master'];
const GIT_BUILTINS = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep',
  'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'maintenance', 'merge', 'mv', 'notes', 'pull', 'push', 'range-diff',
  'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-ref', 'version', 'worktree', 'lfs', 'credential', 'var']);

const base = (s) => String(s ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
const isWinAbs = (s) => /^[A-Za-z]:[\\/]?/.test(s) || /^\\\\/.test(s);

// ---------------------------------------------------------------------------
// Git, quietly and briefly. Only asked when a command makes the answer matter.
// ---------------------------------------------------------------------------
function git(dir, args, gitDir) {
  if (!dir && !gitDir) return null;
  try {
    const pre = gitDir ? ['--git-dir', gitDir] : [];
    return execFileSync('git', [...pre, ...args], {
      cwd: dir || undefined, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch { return null; }
}

// The native realpath: on Windows it expands 8.3 short names (RUNNER~1) to the
// long ones git reports. Without it the same folder had two spellings, nothing
// was ever "inside the repo" there, and ordinary deletes were refused while
// `rm -rf .git` was let through.
const real = (p) => {
  try { return realpathSync.native(p); } catch { try { return realpathSync(p); } catch { return null; } }
};
const lstatSafe = (p) => { try { return lstatSync(p); } catch { return null; } };

// The deepest part of a path that exists, resolved through symlinks, with the
// rest appended. `link/data` where link points outside the repo resolves outside.
function realish(abs) {
  let head = abs;
  const tail = [];
  while (head && !existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  const r = real(head) || head;
  return tail.length ? path.join(r, ...tail) : r;
}

const insideDir = (dir, target) => {
  if (!dir || !target) return false;
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const TEMP_ROOTS = [...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', process.env.TMPDIR]
  .filter(Boolean).map((d) => real(d) || d))];
// Somewhere meant to be thrown away — but not the whole of it, not a folder that
// holds this repo, and not another git repository that happens to live there.
// Without those, a repo checked out under /tmp could delete its own parent.
const inTemp = (p, st) => TEMP_ROOTS.some((t) => insideDir(t, p) && path.relative(t, p) !== '')
  && !(st && st.root && insideDir(p, st.root))
  && !existsSync(path.join(p, '.git'));

// ---------------------------------------------------------------------------
// Reading a command the way a shell does
// ---------------------------------------------------------------------------

// Find the closing paren of a `$(` or `<(` whose `(` is at `open`.
function balanced(src, open) {
  let depth = 0, q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return [src.slice(open + 1, i), i + 1]; }
  }
  return [src.slice(open + 1), src.length];
}

// Words and operators, with quotes removed, backslash escapes applied, and every
// command substitution noted so it can be checked in its own right.
function lex(src) {
  const out = [];
  let w = null, i = 0;
  const flush = () => { if (w) { out.push(w); w = null; } };
  const word = () => (w ||= { t: 'word', v: '', subs: [] });
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') { flush(); out.push({ t: 'op', v: ';' }); i++; continue; }
    if (c === '#' && !w) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '&' && n === '&') { flush(); out.push({ t: 'op', v: '&&' }); i += 2; continue; }
    if (c === '|' && n === '|') { flush(); out.push({ t: 'op', v: '||' }); i += 2; continue; }
    if (c === '|') { flush(); out.push({ t: 'op', v: '|' }); i += n === '&' ? 2 : 1; continue; }
    if (c === ';') { flush(); out.push({ t: 'op', v: ';' }); i++; continue; }
    if ((c === '<' || c === '>') && n === '(') {
      const [body, end] = balanced(src, i + 1); word().subs.push(body); w.v += '<(…)'; i = end; continue;
    }
    if (c === '&' && n === '>') { flush(); out.push({ t: 'op', v: '>' }); i += src[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '&') { flush(); out.push({ t: 'op', v: ';' }); i++; continue; }
    if (c === '>' || c === '<') {
      if (w && /^\d+$/.test(w.v) && !w.subs.length) w = null;   // `2>` names a descriptor, not a word
      flush();
      let op = c; i++;
      if (src[i] === '>' || (c === '<' && src[i] === '<')) { op += src[i]; i++; }
      if (src[i] === '&') { op += '&'; i++; }
      // A here-document is text handed to a program, not more shell. Everything
      // from the delimiter to the line that closes it is skipped: a Python script
      // written with `cat > f.py <<'PY'` used to be lexed as commands, and a `>`
      // comparison inside it read as a redirect that overwrites a file.
      if (op === '<<') {
        let j = i;
        if (src[j] === '-') j++;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
        const m = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(src.slice(j));
        if (m) {
          const body = src.indexOf('\n', j + m[0].length);
          const close = body === -1 ? -1 : src.indexOf(`\n${m[2]}`, body);
          out.push({ t: 'op', v: op });
          out.push({ t: 'word', v: m[2], subs: [] });          // the delimiter, as its target
          i = close === -1 ? src.length : close + 1 + m[2].length;
          continue;
        }
      }
      out.push({ t: 'op', v: op });
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1), end = j === -1 ? src.length : j;
      word().v += src.slice(i + 1, end); i = end + 1; continue;
    }
    if (c === '"') {
      word(); i++;
      while (i < src.length && src[i] !== '"') {
        // Inside double quotes a backslash escapes only $ ` " \\ and newline.
        if (src[i] === '\\' && i + 1 < src.length && /[$`"\\\n]/.test(src[i + 1])) { w.v += src[i + 1]; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '(') { const [body, end] = balanced(src, i + 1); w.subs.push(body); w.v += `$(${body})`; i = end; continue; }
        if (src[i] === '`') { const j = src.indexOf('`', i + 1), end = j === -1 ? src.length : j; w.subs.push(src.slice(i + 1, end)); w.v += `\`${src.slice(i + 1, end)}\``; i = end + 1; continue; }
        w.v += src[i]; i++;
      }
      i++; continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      // A backslash either escapes, as in `\\rm` or `my\\ folder`, or is a
      // Windows path separator, as in `C:\\Users`. Treating every one as an
      // escape turned `C:\\Users` into `C:Users`, and let `rmdir /s C:\\Users`
      // through on the one platform where it runs.
      const mid = !!(w && w.v.length);
      if (mid && !/[\s;&|<>()$`"'\\]/.test(n)) { word().v += c; i++; continue; }
      if (!mid && n === '\\' && /[A-Za-z0-9._-]/.test(src[i + 2] || '')) { word().v += '\\\\'; i += 2; continue; }
      word().v += n; i += 2; continue;
    }
    if (c === '$' && n === '(') { const [body, end] = balanced(src, i + 1); word().subs.push(body); w.v += `$(${body})`; i = end; continue; }
    if (c === '`') { const j = src.indexOf('`', i + 1), end = j === -1 ? src.length : j; word().subs.push(src.slice(i + 1, end)); w.v += `\`${src.slice(i + 1, end)}\``; i = end + 1; continue; }
    word().v += c; i++;
  }
  flush();
  return out;
}

// Pipelines, in the order they run, each a list of stages.
function pipelines(src) {
  const toks = lex(src);
  const all = [];
  let pipe = [[]];
  for (const tk of toks) {
    if (tk.t === 'op' && (tk.v === ';' || tk.v === '&&' || tk.v === '||')) { all.push(pipe); pipe = [[]]; continue; }
    if (tk.t === 'op' && tk.v === '|') { pipe.push([]); continue; }
    pipe[pipe.length - 1].push(tk);
  }
  all.push(pipe);
  return all
    .map((p) => p.map((stageToks) => {
      const words = [], redirects = [], subs = [];
      for (let k = 0; k < stageToks.length; k++) {
        const tk = stageToks[k];
        if (tk.t === 'op') {
          const target = stageToks[k + 1];
          if (target && target.t === 'word') {
            if (!tk.v.includes('&')) redirects.push({ op: tk.v, target: target.v });
            subs.push(...target.subs);
            k++;
          }
          continue;
        }
        words.push(tk.v);
        subs.push(...tk.subs);
      }
      return { words, redirects, subs };
    }).filter((s) => s.words.length || s.redirects.length || s.subs.length))
    .filter((p) => p.length);
}

// Peel off wrappers and `VAR=value` so the rule sees what actually runs.
function unwrap(words) {
  const argv = [...words];
  const assigns = {};
  for (let guard = 0; guard < 20; guard++) {
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      const [k, ...v] = argv.shift().split('=');
      assigns[k] = v.join('=');
    }
    if (!argv.length) break;
    const p = base(argv[0]);
    if (WRAPPERS.has(p)) {
      argv.shift();
      while (argv.length && argv[0].startsWith('-')) {
        const f = argv.shift();
        if ((p === 'nice' && f === '-n') || (p === 'env' && (f === '-u' || f === '-C')) || (p === 'watch' && (f === '-n' || f === '-d'))) argv.shift();
      }
      continue;
    }
    if (p === 'timeout' || p === 'gtimeout') {
      argv.shift();
      while (argv.length && argv[0].startsWith('-')) { const f = argv.shift(); if (['-s', '-k', '--signal', '--kill-after'].includes(f)) argv.shift(); }
      if (argv.length) argv.shift();
      continue;
    }
    break;
  }
  return { argv, assigns, prog: argv.length ? base(argv[0]) : '' };
}

const quote = (s) => (/^[A-Za-z0-9_./:=@%+,{}~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const fork = (st) => ({ ...st, aliases: { ...st.aliases } });

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Expand what can be known now. Anything else is decided at run time, and a
// path decided at run time might be `dist` or might be `/`.
function expand(raw, st) {
  let s = String(raw);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  else if (/^~[^/\\]/.test(s)) return { unknown: `another user's home directory (${raw})` };
  // Variables set earlier on the same line count: `S=/tmp/scratch; rm -f $S/x`
  // is a scratch file, and refusing it as "decided at run time" stopped real work.
  // One set to something unknowable stays unknowable (null).
  const vars = { HOME: os.homedir(), USERPROFILE: os.homedir(), TMPDIR: process.env.TMPDIR || os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(), PWD: st.cwd, ...(st.vars || {}) };
  s = s.replace(/\$\(\s*pwd\s*\)/g, () => st.cwd ?? '\0');
  s = s.replace(/\$\{?env:([A-Za-z_]+)\}?/gi, (_, k) => vars[k.toUpperCase()] ?? '\0');
  s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k) => vars[k] ?? '\0');
  if (s.includes('\0') || /`|\$\(/.test(s)) return { unknown: `a path decided at run time (${raw})` };
  return { path: s };
}

// One level of `{a,b}`, which is all anyone types into a delete.
function braces(s) {
  const m = s.match(/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/);
  return m ? m[2].split(',').flatMap((part) => braces(m[1] + part + m[3])) : [s];
}

// A glob as a regular expression, built piece by piece. No placeholder
// characters: an earlier version used one and wrote a NUL byte into this file,
// which made every tool that reads source treat it as binary.
function globRe(g) {
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '.'; continue; }
    if (c === '[') {
      const j = g.indexOf(']', i + 1);
      if (j === -1) { re += '\\['; continue; }
      let body = g.slice(i + 1, j);
      if (body[0] === '!') body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = j;
      continue;
    }
    re += c.replace(/[.+^$()|{}\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

function deleteReason(raw, st, recursive) {
  for (const one of braces(String(raw))) {
    const why = deleteOne(one, st, recursive);
    if (why) return why;
  }
  return null;
}

function deleteOne(raw, st, recursive) {
  const x = expand(raw, st);
  if (x.unknown) return `deletes ${x.unknown}`;
  const p = x.path;
  if (/^\/dev\/(null|stdout|stderr|tty)$/.test(p)) return null;
  const root = st.root;
  const outside = `deletes ${raw}, outside this repo, where git cannot give it back`;
  if (isWinAbs(p) && process.platform !== 'win32') return outside;
  if (!st.cwd && !path.isAbsolute(p)) return `deletes ${raw} from a directory that could not be identified`;

  const abs = path.resolve(st.cwd || '/', p);

  if (/[*?[]/.test(p)) {
    // The fixed part says where it lands; the pattern says how much it takes.
    const parts = abs.split(path.sep);
    const firstGlob = parts.findIndex((part) => /[*?[]/.test(part));
    const dir = parts.slice(0, firstGlob).join(path.sep) || path.sep;
    const first = parts[firstGlob];
    const dirReal = realish(dir);
    if (!insideDir(root, dirReal) && !inTemp(dirReal, st)) return outside;
    const re = globRe(first);
    // A shell only lets a pattern match a dot-name when the pattern itself
    // starts with a dot, so `dist/*` never reaches `..` and `.?*` does.
    const dotted = first.startsWith('.');
    if (dotted && re.test('..')) return `deletes ${raw}, which can match the parent directory`;
    if (root && path.relative(root, dirReal) === '') {
      if (dotted && re.test('.git')) return `deletes ${raw}, which matches .git — the history nothing can restore`;
      if (/^\*+$/.test(first) && recursive) return `deletes everything in the repo (${raw})`;
    }
    return null;
  }

  // A trailing slash follows a symlink; without one, rm removes the link itself.
  const target = !/[\\/]$/.test(p) && lstatSafe(abs)?.isSymbolicLink()
    ? path.join(realish(path.dirname(abs)), path.basename(abs))
    : realish(abs);

  if (root && insideDir(root, target)) {
    const rel = path.relative(root, target);
    if (rel === '') return 'deletes the repo itself';
    const segs = rel.split(path.sep);
    if (segs[0] === '.git' && (segs.length === 1 || ['objects', 'refs', 'logs', 'packed-refs', 'HEAD'].includes(segs[1]))) {
      return 'deletes git history, which nothing can restore';
    }
    return null;
  }
  if (inTemp(target, st)) return null;
  return outside;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
const HOME_SECRETS = ['.ssh', '.aws/credentials', '.aws/config', '.netrc', '.git-credentials', '.docker/config.json', '.kube/config',
  '.npmrc', '.pypirc', '.gnupg', '.config/gh/hosts.yml', '.azure', '.config/gcloud'];
const SECRET_NAME = /^(\.env(\..+)?|\.envrc|\.netrc|\.git-credentials|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(_sk)?)$/i;

// `.env.example` and `.env.local.example` are templates; `.env.example.real`
// and `.env.dist.local` are not — the last part is what the file is.
function envTemplate(name) {
  const m = name.match(/^\.env\.(.+)$/i);
  return !!m && TEMPLATE_SUFFIX.has(m[1].split('.').pop().toLowerCase());
}

// Is this a place secrets live? Returns the name to show, or null. A file git
// already tracks is in the repo for anyone to read, so reading it exposes
// nothing new; an untracked one is exactly where secrets are kept.
function secretPath(raw, st) {
  let s = String(raw).replace(/^[@<>]+/, '').replace(/^[A-Za-z0-9_-]+=@?/, '');
  const x = expand(s, st);
  if (x.unknown) return null;
  s = x.path;
  if (!s) return null;
  const name = path.basename(s);
  const abs = path.resolve(st.cwd || '/', s);
  const home = os.homedir();
  const underHomeSecret = HOME_SECRETS.some((h) => insideDir(path.join(home, h), abs));
  if (/[*?[]/.test(name)) {
    // Shell globs do not match a leading dot unless you write one. Without that,
    // `scripts/*` was read as possibly naming `.env`, and grepping a folder of
    // scripts was refused as reading secrets.
    const reachable = (c) => !c.startsWith('.') || name.startsWith('.');
    return ['.env', '.env.local', '.env.production'].some((c) => reachable(c) && globRe(name).test(c)) ? s : null;
  }
  if (!underHomeSecret && !(SECRET_NAME.test(name) && !envTemplate(name))) return null;
  if (st.root && insideDir(st.root, abs) && existsSync(abs)) {
    if (git(st.root, ['ls-files', '--error-unmatch', path.relative(st.root, abs)]) !== null) return null;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------
function gitCtx(argv, assigns, st) {
  let i = 1, dir = st.cwd, gitDir = (assigns && assigns.GIT_DIR) || st.gitDir || null;
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-C') { dir = dir ? path.resolve(dir, argv[i + 1] ?? '') : argv[i + 1]; i += 2; continue; }
    if (['-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(a)) {
      if (a === '--git-dir') gitDir = argv[i + 1];
      i += 2; continue;
    }
    if (a.startsWith('--git-dir=')) gitDir = a.slice('--git-dir='.length);
    i++;
  }
  if (gitDir && dir && !path.isAbsolute(gitDir)) gitDir = path.resolve(dir, gitDir);
  return { i, dir, gitDir };
}

function protectedBranch(name, ctx) {
  const n = String(name || '').replace(/^refs\/heads\//, '').toLowerCase();
  if (PROTECTED.includes(n)) return n;
  const def = git(ctx.dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], ctx.gitDir);
  return def && def.replace(/^[^/]+\//, '').toLowerCase() === n ? n : null;
}

function pushReason(args, ctx, st) {
  const valued = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
  const flags = [], positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith('-')) { flags.push(a); if (valued.has(a)) k++; continue; }
    positional.push(a);
  }
  if (flags.some((f) => f === '--dry-run' || f === '-n')) return null;
  if (flags.includes('--mirror')) return 'mirrors the repo to the remote, overwriting and deleting its branches';
  const force = flags.some((f) => /^--force/.test(f) || (/^-[a-zA-Z]+$/.test(f) && f.includes('f')));
  if (force || positional.some((r) => r.startsWith('+'))) return 'force-pushes, rewriting history other people already have';
  if (flags.includes('--delete') || flags.includes('-d') || positional.slice(1).some((r) => r.startsWith(':'))) return 'deletes a branch on the remote';
  if (flags.includes('--prune')) return 'deletes remote branches that do not exist locally';

  if (flags.includes('--all') || flags.includes('--branches')) {
    const locals = git(ctx.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], ctx.gitDir) || '';
    const hit = locals.split('\n').filter(Boolean).find((b) => protectedBranch(b, ctx));
    return hit ? `pushes every branch, including ${hit}, skipping review` : null;
  }

  const refspecs = positional.slice(1);
  if (!refspecs.length && flags.includes('--tags')) return null;   // tags only; no branch moves
  const dests = refspecs.length ? refspecs.map((r) => (r.includes(':') ? r.split(':').pop() : r)) : ['HEAD'];
  for (const d of dests) {
    const name = d === 'HEAD' || d === '@' ? (st.branch || git(ctx.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.gitDir)) : d;
    if (!name || name === 'HEAD') return 'pushes a branch that could not be identified';
    const hit = protectedBranch(name, ctx);
    if (hit) return `pushes straight to ${hit}, skipping review`;
  }
  return null;
}

function dirty(ctx) {
  const out = git(ctx.dir, ['status', '--porcelain', '--untracked-files=no'], ctx.gitDir);
  return out === null ? true : out !== '';
}

function gitReason(argv, assigns, st, depth) {
  const ctx = gitCtx(argv, assigns, st);
  const sub = argv[ctx.i];
  const rest = argv.slice(ctx.i + 1);
  if (!sub) return null;

  if (!GIT_BUILTINS.has(sub)) {
    const alias = st.aliases[sub] ?? git(ctx.dir, ['config', '--get', `alias.${sub}`], ctx.gitDir);
    if (alias && depth < 6) {
      if (alias.startsWith('!')) return analyze(`${alias.slice(1)} ${rest.map(quote).join(' ')}`, fork(st), depth + 1);
      const words = pipelines(alias)[0]?.[0]?.words ?? [];
      return gitReason(['git', ...words, ...rest], assigns, st, depth + 1);
    }
    return null;
  }

  if (sub === 'push') return pushReason(rest, ctx, st);
  if (sub === 'clean') {
    const short = rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
    const forced = /f/.test(short) || rest.includes('--force');
    const dry = /n/.test(short) || rest.includes('--dry-run');
    // -X removes only ignored files: build output, by definition regenerable.
    if (forced && !dry && !/X/.test(short)) return 'deletes untracked files, which git never had a copy of';
    return null;
  }
  if (sub === 'reset' && rest.includes('--hard') && dirty(ctx)) return 'throws away uncommitted changes, which git never had a copy of';
  const discards = (sub === 'checkout' && (rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force')))
    || (sub === 'restore' && !rest.includes('--staged') && !rest.includes('-S') && rest.some((a) => !a.startsWith('-')));
  if (discards && dirty(ctx)) return 'throws away uncommitted changes, which git never had a copy of';
  if (sub === 'stash' && rest[0] === 'clear') return 'deletes every stash, which cannot be recovered';
  if (sub === 'reflog' && rest[0] === 'expire') return 'destroys the reflog, the record that lets lost commits be recovered';
  if (sub === 'gc' && rest.some((a) => /^--prune=(now|all)$/.test(a))) return 'permanently deletes unreachable commits';
  return null;
}

// ---------------------------------------------------------------------------
// Interpreters: inspected for the obvious, and no more
// ---------------------------------------------------------------------------
function interpreterCode(prog, argv) {
  const flags = { python: ['-c'], python2: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p'],
    deno: ['eval'], bun: ['-e', '--eval'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], osascript: ['-e'] }[prog] || [];
  for (let k = 1; k < argv.length; k++) {
    if (flags.includes(argv[k])) return argv[k + 1] ?? '';
    const glued = flags.find((f) => /^-.$/.test(f) && argv[k].startsWith(f) && argv[k].length > 2);
    if (glued) return argv[k].slice(2);
  }
  return null;
}

function interpreterReason(code, st, depth) {
  const literals = [...code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).concat(
    [...code.matchAll(/\bq[qwx]?\s*[({[<|/](.*?)[)}\]>|/]/g)].map((m) => m[1]));
  if (/\b(system|exec|execSync|execFileSync|spawn|spawnSync|popen|subprocess|shell_exec|passthru|Popen|check_output|check_call|os\.system)\b/.test(code)
    || /`[^`]+`/.test(code) || /\bqx\s*[({[<|/]/.test(code)) {
    for (const lit of literals) { const why = analyze(lit, fork(st), depth + 1); if (why) return why; }
  }
  if (/\b(rmtree|remove|unlink|unlinkSync|rmSync|rmdirSync|rmdir|rimraf|rm_rf|rm_r|delete)\b|\bfs\.(promises\.)?rm\b|Remove-Item/.test(code)) {
    const paths = literals.filter((l) => l && !/\s/.test(l) && l.length < 400 && /[/~.$]|^[\w-]+$/.test(l));
    if (!paths.length) return 'deletes a path computed inside the code, which cannot be checked';
    for (const lit of paths) { const why = deleteReason(lit, st, true); if (why) return why; }
  }
  if (/\b(open|readFile|readFileSync|read_text|read_bytes|read|file_get_contents|readlines|fopen|slurp)\b|Get-Content/.test(code)) {
    for (const lit of literals) { const s = secretPath(lit, st); if (s) return `reads secrets from ${s}`; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One stage of a pipeline
// ---------------------------------------------------------------------------
function findRoots(argv) {
  const roots = [];
  for (let k = 1; k < argv.length && !/^[-(!]/.test(argv[k]); k++) roots.push(argv[k]);
  return roots.length ? roots : ['.'];
}

// `find` deletes what it matches under a folder, not the folder. So a start
// inside the repo is fine when something narrows the match, and only
// "everything" when nothing does.
const FIND_FILTERS = /^-(i?name|i?path|i?regex|type|size|mtime|mmin|atime|amin|ctime|cmin|newer\w*|perm|user|group|empty|links|inum|samefile|wholename|iwholename|lname|ilname)$/;
function findRootReason(root, expr, st) {
  const x = expand(root, st);
  if (x.unknown) return `deletes under ${x.unknown}`;
  const abs = realish(path.resolve(st.cwd || '/', x.path));
  const filtered = expr.some((a) => FIND_FILTERS.test(a));
  if (st.root && insideDir(st.root, abs)) {
    if (!filtered && path.relative(st.root, abs) === '') return 'deletes everything in the repo';
    return null;
  }
  if (inTemp(abs, st)) return null;
  return `deletes under ${root}, outside this repo, where git cannot give it back`;
}

function stageReason(stage, pipe, idx, st, depth) {
  for (const s of stage.subs) { const why = analyze(s, fork(st), depth + 1); if (why) return why; }

  const { argv, assigns, prog } = unwrap(stage.words);

  for (const r of stage.redirects) {
    // `>` destroys what was there; `>>` only adds to it.
    if (r.op === '>' || r.op === '>|') {
      // Creating a file destroys nothing, so writing one that is not there yet is
      // allowed — but only where the work is: inside the repo, inside the folder
      // the command runs in, or in scratch space. A config file somebody has not
      // written yet is still theirs, and `> ~/.zshrc` is refused on a machine that
      // happens not to have one, the same as on a machine that does.
      const abs = (() => { const x = expand(r.target, st); return x.path ? path.resolve(st.cwd || '/', x.path) : null; })();
      const dotfileAtHome = abs && path.dirname(abs) === os.homedir() && path.basename(abs).startsWith('.');
      const somewhereItWorks = abs && !dotfileAtHome
        && ((st.root && insideDir(st.root, abs)) || (st.cwd && insideDir(st.cwd, abs)) || inTemp(abs, st));
      if (!abs || existsSync(abs) || !somewhereItWorks) {
        const why = deleteReason(r.target, st, false);
        if (why) return why.replace(/^deletes/, 'overwrites');
      }
    }
    if ((r.op === '<' || r.op === '<<') && (READERS.has(prog) || RUNNERS.has(prog) || SENDERS.has(prog))) {
      const s = secretPath(r.target, st);
      if (s) return `reads secrets from ${s}`;
    }
  }
  if (!prog) return null;

  if (ESCALATE.has(prog)) return 'runs as root';

  // Something that runs code, fed by something that fetched it.
  const fedPipe = pipe.slice(0, idx).some((s) => DOWNLOADERS.has(unwrap(s.words).prog));
  // A download inside the command itself — a substitution — becomes the text or the
  // file the program is told to run. That is running the download, whatever the
  // program is.
  const fedSub = stage.subs.some((body) => pipelines(body).some((p) => p.some((q) => DOWNLOADERS.has(unwrap(q.words).prog))));
  // Down a pipe it is different. A program given its own script — inline with a
  // flag, or as a file to run — treats the download as data arriving on stdin, and
  // the code that actually runs is right there in the command where these rules can
  // read it. Refusing that refused reading a JSON endpoint, which is ordinary work.
  // With no script of its own, the program runs what arrives, and that is the one
  // this rule is for.
  const runsStdin = !interpreterCode(prog, argv) && !argv.slice(1).some((a) => !a.startsWith('-') && a !== '-');
  if (RUNNERS.has(prog) && (fedSub || (fedPipe && runsStdin))) return 'runs a download without anyone reading it first';

  if (SHELLS.has(prog)) {
    const k = argv.findIndex((a, n) => n > 0 && (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) || /^\/[ck]$/i.test(a) || /^-command$/i.test(a)));
    return k !== -1 && argv[k + 1] !== undefined ? analyze(argv.slice(k + 1).join(' '), fork(st), depth + 1) : null;
  }
  if (prog === 'eval' || prog === 'invoke-expression' || prog === 'iex') {
    return argv.length > 1 ? analyze(argv.slice(1).join(' '), fork(st), depth + 1) : null;
  }
  if (INTERPRETERS.has(prog)) {
    const code = interpreterCode(prog, argv);
    return code === null ? null : interpreterReason(code, st, depth);
  }
  if (prog === 'git') return gitReason(argv, assigns, st, depth);
  if (prog === 'gh' && argv[1] === 'repo' && argv[2] === 'delete') return 'deletes a GitHub repository';

  // rm, and everything that behaves like it
  const npxLike = ['npx', 'bunx', 'pnpx'].includes(prog) || (prog === 'pnpm' && argv[1] === 'dlx');
  const toolAt = npxLike ? argv.findIndex((a, n) => n > (prog === 'pnpm' ? 1 : 0) && !a.startsWith('-')) : 0;
  const tool = npxLike ? base(argv[toolAt] || '') : prog;
  if (DELETERS.includes(tool)) {
    let recursive = tool === 'rimraf' || tool === 'del-cli', end = false;
    const targets = [];
    for (let k = toolAt + 1; k < argv.length; k++) {
      const a = argv[k];
      if (!end && a === '--') { end = true; continue; }
      if (!end && /^\/[a-zA-Z]$/.test(a) && ['del', 'erase', 'rd', 'rmdir'].includes(tool)) { if (/s/i.test(a)) recursive = true; continue; }
      if (!end && a.startsWith('-')) {
        const low = a.toLowerCase();
        if (low === '--recursive' || low === '-recurse' || (/^-[a-z]+$/i.test(a) && /r/i.test(a) && !['-force'].includes(low))) recursive = true;
        if (tool === 'truncate' && (a === '-s' || a === '--size')) k++;
        if ((low === '-path' || low === '-literalpath') && argv[k + 1]) { targets.push(argv[k + 1]); k++; }
        continue;
      }
      targets.push(a);
    }
    // Unix rmdir only ever removes empty directories.
    if (tool === 'rmdir' && !recursive && process.platform !== 'win32' && !targets.some(isWinAbs)) return null;
    if (tool === 'truncate' || tool === 'shred') recursive = false;
    for (const t of targets) { const why = deleteReason(t, st, recursive); if (why) return why; }
    return null;
  }

  if (prog === 'find') {
    const roots = findRoots(argv);
    const expr = argv.slice(1 + (argv.length > 1 && !/^[-(!]/.test(argv[1]) ? roots.length : 0));
    const execAt = expr.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a));
    if (expr.includes('-delete') || execAt !== -1) {
      for (const r of roots) { const why = findRootReason(r, expr, st); if (why && expr.includes('-delete')) return why; }
    }
    if (execAt !== -1) {
      const stop = expr.findIndex((a, n) => n > execAt && (a === ';' || a === '+' || a === '\\;'));
      const cmd = expr.slice(execAt + 1, stop === -1 ? undefined : stop);
      const filtered = expr.slice(0, execAt).some((a) => FIND_FILTERS.test(a));
      for (const r of roots) {
        // What {} stands for: a match somewhere under the start, or the start
        // itself when nothing narrows it.
        const stand = filtered ? path.join(r, '__match__') : r;
        const why = analyze(cmd.map((c) => (c === '{}' ? stand : c)).map(quote).join(' '), fork(st), depth + 1);
        if (why) return why;
      }
    }
    return null;
  }

  if (prog === 'xargs') {
    const valued = new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a']);
    let k = 1;
    for (; k < argv.length && argv[k].startsWith('-'); k++) if (valued.has(argv[k])) k++;
    const inner = argv.slice(k);
    if (!inner.length) return null;
    const why = analyze(inner.map(quote).join(' '), fork(st), depth + 1);
    if (why) return why;
    if (['rm', 'unlink', 'shred', 'rimraf', 'truncate'].includes(unwrap(inner).prog)) {
      // Its paths arrive on stdin. Trust them only when they come from something
      // that can only name paths inside the repo.
      const up = idx > 0 ? unwrap(pipe[idx - 1].words) : null;
      const fromRepo = up && ((up.prog === 'find' && findRoots(up.argv).every((r) => !findRootReason(r, ['-name'], st)))
        || (up.prog === 'git' && ['ls-files', 'diff'].includes(up.argv[gitCtx(up.argv, up.assigns, st).i])));
      if (!fromRepo) return 'deletes paths it reads from its input, which cannot be checked';
    }
    return null;
  }

  if (prog === 'dd') {
    const of = argv.find((a) => a.startsWith('of='));
    if (!of) return null;
    const t = of.slice(3);
    if (/^\/dev\//.test(t) && !/^\/dev\/(null|stdout|stderr)$/.test(t)) return `overwrites the device ${t}`;
    const why = deleteReason(t, st, false);
    return why ? why.replace(/^deletes/, 'overwrites') : null;
  }
  if (DISK.has(prog) || /^mkfs(\.|$)/.test(prog) || /^newfs/.test(prog)) return 'erases a disk or filesystem';
  if (prog === 'diskutil' && /erase|partition|zero|random|reformat|secure/i.test(argv.slice(1).join(' '))) return 'erases a disk or filesystem';
  if (prog === 'format' && argv.slice(1).some((a) => /^[A-Za-z]:$/.test(a))) return 'erases a disk or filesystem';

  if (prog === 'chmod') {
    const mode = argv.slice(1).find((a) => !a.startsWith('-')) || '';
    const worldWritable = (/^[0-7]{3,4}$/.test(mode) && ['2', '3', '6', '7'].includes(mode.slice(-1)))
      || mode.split(',').some((clause) => { const m = clause.match(/^([ugoa]*)[+=]([rwxXst]*)$/); return !!m && /[ao]/.test(m[1]) && m[2].includes('w'); });
    return worldWritable ? 'makes files writable by everyone' : null;
  }

  if (prog === 'rsync' && argv.some((a) => /^--delete/.test(a))) {
    const dest = argv.slice(1).filter((a) => !a.startsWith('-')).pop();
    if (dest && !/^[^/]*:/.test(dest)) { const why = deleteReason(dest.replace(/\/+$/, '') || '/', st, true); if (why) return why; }
    return null;
  }

  if (prog === 'mv') {
    const paths = argv.slice(1).filter((a) => !a.startsWith('-'));
    for (const src of paths.slice(0, -1)) {
      const x = expand(src, st);
      const abs = x.path ? path.resolve(st.cwd || '/', x.path) : null;
      if (abs && (abs === os.homedir() || abs === path.parse(abs).root)) return `moves ${src} away`;
    }
    const dest = paths[paths.length - 1];
    const x = dest ? expand(dest, st) : {};
    if (x.path && paths.length > 1) {
      const abs = realish(path.resolve(st.cwd || '/', x.path));
      if (existsSync(abs) && !lstatSafe(abs)?.isDirectory() && !(st.root && insideDir(st.root, abs)) && !inTemp(abs, st)) {
        return `overwrites ${dest}, outside this repo`;
      }
    }
  }

  // Secrets: shown to the agent, sent somewhere, or carried out of the repo.
  if (READERS.has(prog) || SENDERS.has(prog)) {
    let files = argv.slice(1);
    if (['grep', 'egrep', 'fgrep', 'rg', 'ag', 'select-string', 'sls'].includes(prog)) {
      const explicit = files.some((a) => a === '-e' || a === '-f' || a.startsWith('--regexp') || /^-pattern$/i.test(a));
      const nonFlag = files.filter((a) => !a.startsWith('-'));
      files = explicit ? nonFlag : nonFlag.slice(1);
    }
    if (prog === 'sed' && argv.some((a) => /^-i/.test(a) || a === '--in-place')) files = [];
    for (const f of files) { const s = secretPath(f, st); if (s) return SENDERS.has(prog) ? `sends secrets from ${s}` : `reads secrets from ${s}`; }
  }
  if (['tar', 'zip', '7z', 'gzip', 'bzip2', 'xz', 'base64', 'gpg', 'openssl'].includes(prog)) {
    const leak = argv.slice(1).map((a) => secretPath(a, st)).find(Boolean);
    if (leak) return `packs secrets from ${leak}`;
  }
  if (COPIERS.has(prog)) {
    const args = argv.slice(1);
    const tIdx = args.findIndex((a) => a === '-t' || a === '--target-directory');
    const positional = args.filter((a, n) => !a.startsWith('-') && !(tIdx !== -1 && n === tIdx + 1));
    const dest = tIdx !== -1 ? args[tIdx + 1] : positional[positional.length - 1];
    const sources = tIdx !== -1 ? positional : positional.slice(0, -1);
    const leak = sources.map((s) => secretPath(s, st)).find(Boolean);
    if (leak) {
      const x = dest ? expand(dest, st) : {};
      const destAbs = x.path ? realish(path.resolve(st.cwd || '/', x.path)) : null;
      if (!destAbs || !(st.root && insideDir(st.root, destAbs))) return `copies secrets out of ${leak}`;
    }
  }
  return null;
}

// What a command changes for the commands after it on the same line.
function applyState(stage, st) {
  const { argv, prog, assigns } = unwrap(stage.words);
  // `NAME=value` on its own sets a shell variable for the rest of the line. With
  // a command after it, it only sets that command's environment, and the shell
  // has already expanded the line by then — so it changes nothing here.
  const remember = (k, v) => { const x = expand(v, st); (st.vars ||= {})[k] = x.path ?? null; };
  if (!prog) { for (const [k, v] of Object.entries(assigns)) remember(k, v); return; }
  if (prog === 'unset') { for (const a of argv.slice(1)) if (st.vars) delete st.vars[a]; return; }
  if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(prog)) {
    const target = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!target) { st.cwd = os.homedir(); return; }
    if (target === '-') { st.cwd = null; return; }
    const x = expand(target, st);
    st.cwd = x.path ? path.resolve(st.cwd || '/', x.path) : null;
    return;
  }
  if (prog === 'popd') { st.cwd = null; return; }
  if (prog === 'export') {
    for (const a of argv.slice(1)) {
      const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'GIT_DIR') st.gitDir = m[2];
      remember(m[1], m[2]);
    }
    return;
  }
  if (prog !== 'git') return;
  const ctx = gitCtx(argv, {}, st);
  const sub = argv[ctx.i], rest = argv.slice(ctx.i + 1);
  if (sub === 'checkout' || sub === 'switch') {
    const b = rest.findIndex((a) => ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(a));
    if (b !== -1 && rest[b + 1]) { st.branch = rest[b + 1]; return; }
    if (rest.includes('--')) return;
    const name = rest.find((a) => !a.startsWith('-'));
    if (!name) return;
    const known = git(ctx.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], ctx.gitDir) !== null
      || git(ctx.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], ctx.gitDir) !== null;
    if (known) st.branch = name;
    return;
  }
  if (sub === 'config') {
    const args = rest.filter((a) => !a.startsWith('--'));
    const m = args[0] && args[0].match(/^alias\.(.+)$/);
    if (m && args[1] !== undefined) st.aliases[m[1]] = args.slice(1).join(' ');
  }
}

function analyze(src, st, depth = 0) {
  if (depth > 8) return 'nests commands too deeply to check';
  for (const pipe of pipelines(String(src ?? ''))) {
    for (let idx = 0; idx < pipe.length; idx++) {
      const why = stageReason(pipe[idx], pipe, idx, st, depth);
      if (why) return why;
    }
    if (pipe.length === 1) applyState(pipe[0], st);
  }
  return null;
}

// The repo is the boundary, and it is the git root — not wherever the command
// happens to run. Treating the working directory as the repo refused
// `rm -rf ../dist` from a subfolder and allowed `rm -rf Library` from $HOME.
// `repo` is the repository this session belongs to, which is not always the one
// the command runs in: a session opened a folder above a repo works inside it with
// a working directory that is not a repository at all. Without this, every delete
// inside that repo was refused for being outside it.
function stateFor(cwd, repo) {
  const dir = cwd ? (real(cwd) || cwd) : null;
  const top = (dir ? git(dir, ['rev-parse', '--show-toplevel']) : null) || repo || null;
  return { cwd: dir, root: top ? (real(top) || top) : null, branch: null, gitDir: null, aliases: {}, vars: {} };
}

// The reason a command must never run, or null. Exported for the tests, which
// hold both halves of the promise: the destructive refused, the ordinary not.
export function neverReason(command, cwd, repo) {
  return analyze(command, stateFor(cwd, repo));
}

// A file tool pointed at a secret. Refusing `cat .env` while the Read tool
// handed back the same file protected nothing — a live session did exactly that.
export function fileReason(tool, input, cwd, repo) {
  const fp = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (typeof fp !== 'string' || !fp) return null;
  const st = stateFor(cwd, repo);
  const s = secretPath(fp, st);
  if (!s) return null;
  const x = expand(fp, st);
  const abs = path.resolve(st.cwd || '/', x.path || fp);
  if (tool === 'Write' && !existsSync(abs)) return null;           // creating one is setup
  return tool === 'Read' || tool === 'Grep' ? `reads secrets from ${s}` : `overwrites secrets in ${s}`;
}

// Everything not listed falls through to "ask", so a tool nobody has thought
// about yet is held rather than allowed.
export const DEFAULT_TIER = {
  Read: 'log', Glob: 'log', Grep: 'log', LS: 'log', WebSearch: 'log', TodoWrite: 'log',
  WebFetch: 'ask', Bash: 'ask', Edit: 'ask', Write: 'ask', MultiEdit: 'ask',
  NotebookEdit: 'ask', Task: 'ask',
};

// What a decision generalises to when you pick "always" or "never".
//
// For a shell command that is the first word, so allowing `git status` does not
// also allow `git push`. For a file write it is the extension, so allowing an
// edit to one .js file does not also allow edits to .env. Anything else is the
// tool itself.
export function ruleKey(hook) {
  const t = hook.tool_name;
  if (t === 'Bash') {
    const first = String(hook.tool_input?.command || '').trim().split(/\s+/)[0] || '?';
    return `Bash:${first}`;
  }
  if (t === 'Edit' || t === 'Write' || t === 'MultiEdit') {
    const p = hook.tool_input?.file_path || '';
    return `${t}:${path.extname(p) || '(no ext)'}`;
  }
  return t;
}

// never > learned rule > default for the tool > ask.
export function classify(hook, rules = new Map()) {
  const t = hook.tool_name;
  const input = hook.tool_input;
  // Which repository this session belongs to. For a session started in the repo
  // it is the working directory's own; for one started elsewhere the server knows
  // it and says so, and without that the repo's own files count as somebody else's.
  const repo = hook.repo_root || null;
  // Any tool carrying a command runs it, whatever it is called. Only checking
  // `Bash` let a shell-running MCP tool skip every rule here.
  if (input && typeof input.command === 'string') {
    const why = neverReason(input.command, hook.cwd, repo);
    if (why) return { tier: 'never', reason: why };
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep'].includes(t)) {
    const why = fileReason(t, input, hook.cwd, repo);
    if (why) return { tier: 'never', reason: why };
  }
  const key = ruleKey(hook);
  if (rules.has(key)) return { tier: rules.get(key), reason: `rule ${key}` };
  return { tier: DEFAULT_TIER[t] ?? 'ask', reason: `default for ${t}` };
}
