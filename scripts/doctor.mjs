// Why is nothing showing up?
//
//   nearly doctor
//
// Everything this project does is a chain: gate the session, record it, build
// the record, find the pull request, post the link. A break anywhere means
// nothing appears, and every step is quiet by design — hooks must never
// interrupt an agent, and a push must never fail over a recap. Quiet is right
// and it is also how somebody ends up staring at an empty pull request with no
// idea which link came apart.
//
// So this walks the chain in order and stops being polite about it.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { paths, dataRoot } from '../server/paths.mjs';
import { ADAPTERS, OURS_RE } from '../server/adapters.mjs';
import { outsideInstalled, outsideProblem } from './outside.mjs';
import { runtimeVersion, hasRuntime, compareVersions } from './runtime.mjs';
import { homedir } from 'node:os';
import { prForBranch } from './pr-state.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repo = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd());
const PORT = Number(process.env.NEARLY_PORT || 47653);

// Colour only on a terminal; piped into a file or a CI log it is noise.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : String(s));
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : String(s));
const green = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : String(s));
const red = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : String(s));
const yellow = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : String(s));

const blockers = [];
function say(ok, label, detail, fix) {
  const mark = ok === true ? green('✓') : ok === false ? red('✗') : yellow('!');
  console.log(`  ${mark} ${label}${detail ? dim(`  ${detail}`) : ''}`);
  if (ok === false && fix) blockers.push(fix);
}

const git = (args) => {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

console.log('');
console.log(`  ${bold('Nearly')} ${dim(repo)}`);
console.log('');

// 1 — a repo at all
// A repo with no commits has no HEAD to name, but it does have a branch.
const branch = git(['symbolic-ref', '--short', 'HEAD']) || git(['rev-parse', '--abbrev-ref', 'HEAD']) || '(no branch)';
if (!existsSync(join(repo, '.git'))) {
  say(false, 'a git repository', 'this is not one', `cd into the repo you work in, then run nearly`);
} else {
  say(true, 'a git repository', `on ${branch}`);
}

// 2 — which agents are gated here. An agent Nearly cannot see records nothing,
// and that is the single most common reason for an empty pull request.
const gated = ADAPTERS.filter((a) => {
  const f = join(repo, a.config);
  try { return existsSync(f) && OURS_RE.test(readFileSync(f, 'utf8')); } catch { return false; }
});
if (gated.length) say(true, 'agents gated here', gated.map((a) => a.name).join(', '));
else say(false, 'agents gated here', 'none', 'run `nearly` in this repo to turn it on');

// Configured is not the same as working, and the difference is invisible.
// Hooks fail open on purpose — a broken one must never wedge an agent — so a
// command that cannot be found produces silence, and silence looks exactly like
// a session nobody ran. Everything above can be green while nothing is gated.
//
// So run the hook this repo actually has, the way the agent runs it, and see
// whether an answer comes back.
if (gated.length) {
  const cc = gated.find((a) => a.id === 'claude-code') || gated[0];
  let cmd = null;
  try {
    const cfg = JSON.parse(readFileSync(join(repo, cc.config), 'utf8'));
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.command === 'string' && OURS_RE.test(o.command) && /pre-tool/.test(o.command)) cmd = o.command;
      for (const v of Object.values(o)) walk(v);
    };
    walk(cfg);
  } catch { /* unreadable config */ }

  if (!cmd) {
    say(null, 'hooks actually fire', 'could not find the pre-tool hook to try');
  } else {
    const probe = JSON.stringify({
      session_id: `nearly-doctor-${Date.now()}`, cwd: repo,
      hook_event_name: 'PreToolUse', tool_name: 'Read',
      tool_input: { file_path: join(repo, 'nearly-doctor-probe') }, tool_use_id: 'doctor',
    });
    // shell: true because the agent runs these through a shell, and on Windows
    // the installed command is a .cmd that will not spawn any other way.
    // Run it with the PATH the agent will have, not this process's. Launched
    // through npx, this process has npx's temporary bin first on PATH, holding a
    // `nearly` that vanishes when npx exits — so a hook calling `nearly` passed
    // here and could never run for the agent. npm scripts add node_modules/.bin
    // the same way.
    const sep = process.platform === 'win32' ? ';' : ':';
    const agentPath = String(process.env.PATH || process.env.Path || '').split(sep)
      .filter((d) => d && !/[\\/]_npx[\\/]/.test(d) && !/[\\/]node_modules[\\/]\.bin$/.test(d)).join(sep);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
    env.PATH = agentPath;
    if (process.platform === 'win32') env.Path = agentPath;
    const r = spawnSync(cmd, { input: probe, shell: true, encoding: 'utf8', timeout: 30_000, env });
    const decided = /permissionDecision|"decision"|"permission"/.test(r.stdout || '');
    if (decided) {
      say(true, 'hooks actually fire', 'the gate answered a test call');
    } else {
      const lines = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .filter((l) => !/^(at |node:internal|npm (warn|notice)|\^+$|Node\.js v)/.test(l));
      const pick = lines.find((l) => /not found|no such file|cannot find|ENOENT|EACCES|permission denied|is not recognized|Error:/i.test(l))
        || lines[lines.length - 1];
      const why = (r.error && r.error.message) || pick
        || (r.status !== 0 ? `the hook command exited ${r.status}` : 'the hook ran but answered nothing');
      say(false, 'hooks actually fire', why,
        `the hook command in ${cc.config} does not work here, so nothing is gated and nothing is recorded — check that \`nearly\` runs in a plain shell, then re-run \`nearly\` to rewrite the hooks`);
    }
  }
}

// A repo's own hooks only run for sessions started in it. Everything above can
// be green while every session is opened one folder up and none of it is seen.
if (gated.some((a) => a.id === 'claude-code')) {
  const broken = outsideProblem();
  if (broken) say(false, 'sessions opened in other folders', `the hook in Claude Code's user settings is ${broken}`, 'run `nearly` here to rewrite it, or `nearly pause` to stop every session being gated right now');
  else if (outsideInstalled()) say(true, 'sessions opened in other folders', 'gated once they work in this repo');
  else say(null, 'sessions opened in other folders', 'not gated — only Claude Code sessions started in this folder are. Run `nearly` here to cover them');
}

// Paused everywhere, or an installed copy older than the one running this.
if (existsSync(join(process.env.NEARLY_HOME || join(homedir(), '.nearly'), 'paused'))) {
  say(false, 'paused', 'nothing is gated or recorded in any session', 'run `nearly resume` to turn it back on');
}
{
  let mine = null;
  try { mine = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
  if (hasRuntime() && mine && (compareVersions(runtimeVersion(), mine) ?? 0) < 0) {
    say(null, 'installed copy', `${runtimeVersion()}, older than this nearly (${mine}) — run \`nearly\` here to update it`);
  }
}

// Judgement is off unless a key was saved, and that is worth saying once here
// rather than leaving someone to wonder why refusals are unlabelled.
{
  const { judgeEnabled } = await import('./judge.mjs');
  if (judgeEnabled()) say(true, 'refusals labelled', 'judged at push time by TypeSafe');
}

// 3 — the server, and whether it is this build
let health = null;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(900) });
  if (r.ok) health = await r.json();
} catch { /* not running is normal: hooks start it */ }
if (!health) {
  say(null, 'server', 'not running — a hook starts it when one fires');
} else {
  let mine = root;
  try { mine = realpathSync(root); } catch { /* compare literally */ }
  const same = health.root === mine;
  let ours = null;
  try { ours = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
  if (same) {
    say(true, 'server', `v${health.version}`);
  } else if (health.version && health.version === ours) {
    // Running this through npx gives a throwaway directory every time, so the
    // paths differ even when the build is identical. Saying "a different
    // install" there is true and useless; the version is what anyone cares
    // about, and a matching one is holding nothing back.
    say(null, 'server', `v${health.version} from another copy of the same version — nothing stale about it`);
  } else {
    say(false, 'server', `an older build is answering${health.version ? ` (v${health.version})` : ''}: ${health.root || 'it does not say where it lives'}`,
      'run `nearly` here — it closes the older server holding the port');
  }
}

// 4 — recordings for this branch, matched the way the record builder matches
// them, so this cannot disagree with it.
const recDir = paths.recordings();
let runs = 0, otherBranches = new Set();
const real = (p) => {
  let r;
  try { r = realpathSync.native(resolve(p)); } catch { r = resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;   // same place, spelled differently
};
try {
  for (const f of readdirSync(recDir).filter((f) => f.endsWith('.jsonl'))) {
    let created = null;
    for (const line of readFileSync(join(recDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'session' && e.subtype === 'created') { created = e; break; }
      } catch { /* a torn line */ }
    }
    if (!created) continue;
    if (created.worktree && real(created.worktree) !== real(repo)) continue;
    if (created.branch === branch) runs += 1;
    else if (created.branch) otherBranches.add(created.branch);
  }
} catch { /* no recordings directory yet */ }

if (runs) {
  say(true, `sessions recorded on ${branch}`, `${runs}`);
} else {
  say(false, `sessions recorded on ${branch}`, 'none',
    otherBranches.size
      ? `this branch has no recorded sessions. Others do: ${[...otherBranches].join(', ')}. A record only exists for work an agent Nearly gates actually did.`
      : `nothing here has been recorded yet. Nearly only sees the agents it gates — run \`nearly agents\` to see which those are.`);
}

// 5 — the hook that offers the record at push time
const pushHook = join(repo, '.git', 'hooks', 'pre-push');
const pushText = (() => { try { return readFileSync(pushHook, 'utf8'); } catch { return null; } })();
// A pre-push hook of the person's own (husky, lefthook, a script) makes install
// refuse to overwrite it, so "run nearly" would send them round in a circle.
const hasPush = !!pushText && /x-session-record-hook|push-record/.test(pushText);
if (hasPush) say(true, 'pre-push hook', 'installed');
else if (pushText != null) say(false, 'pre-push hook', 'yours is there, without Nearly in it',
  'your own pre-push hook was left alone — add `nearly push-record "$(git rev-parse --show-toplevel)" || true` to it');
else say(false, 'pre-push hook', 'missing', 'run `nearly` here to install it');

// 6 — gh, which is how a pull request is found and commented on. Its absence
// used to be reported as "no pull request yet", which sent people off to raise
// one they already had.
const ghOk = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
if (!ghOk) {
  say(false, 'GitHub CLI (gh)', 'not on PATH',
    'install it from cli.github.com and run `gh auth login` — without it the record cannot be posted to a pull request');
} else {
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;
  say(auth, 'GitHub CLI (gh)', auth ? 'installed and signed in' : 'installed but not signed in', 'run `gh auth login`');
  if (auth) {
    const pr = prForBranch(repo);
    if (pr.state === 'open') say(true, 'open pull request', pr.url);
    else if (pr.state === 'merged' || pr.state === 'closed') {
      say(null, 'open pull request', `none — #${pr.number} for ${branch} is ${pr.state}. Open a new one, then push again`);
    } else say(null, 'open pull request', `none for ${branch} — raise one, then push again`);
  }
}

// 7 — where a posted record would point
const urlBase = (() => {
  if (process.env.NEARLY_URL_BASE) return process.env.NEARLY_URL_BASE;
  for (const f of [paths.config(), join(root, '.nearly.json')]) {
    try { if (existsSync(f)) { const u = JSON.parse(readFileSync(f, 'utf8')).urlBase; if (u) return u; } }
    catch { /* try the next */ }
  }
  return null;
})();
say(urlBase ? true : null, 'somewhere to publish records',
  urlBase || `kept in ${dataRoot.replace(process.env.HOME || '~', '~')}, so a comment would have no link to give`);

// 8 — whether a record for this branch exists right now
const slug = `${String(basename(repo)).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}--${String(branch).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`;
const built = join(paths.records(), `${slug}.json`);
say(existsSync(built) ? true : null, 'record built for this branch',
  existsSync(built) ? built : 'not yet — it is built at push time, or by `nearly record`');

console.log('');
if (!blockers.length) {
  console.log(`  ${green('Nothing is in the way.')} ${dim('Work, push, and the record is offered.')}`);
} else {
  console.log(`  ${bold(blockers.length === 1 ? 'One thing is in the way:' : `${blockers.length} things are in the way:`)}`);
  for (const b of blockers) console.log(`    · ${b}`);
}
console.log('');
