// A session is not one branch in one folder.
//
// A real session worked in a git worktree, made a branch per task, and pushed
// eight of them. Every push printed "no agent sessions recorded on <branch>": the
// session was filed under the branch it started on and the folder it started in,
// and the push looked for the branch being pushed from the repo's main folder.
// Nothing about that is unusual — it is how Claude Code runs parallel sessions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 45800 + Math.floor(Math.random() * 150);

let box, repo, wt, env, server;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

before(async () => {
  box = realpathSync.native(mkdtempSync(join(tmpdir(), 'nearly-branches-')));
  repo = join(box, 'site');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@x'); git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'seed');
  // A worktree the way Claude Code makes them: inside the repo's folder, on its own branch.
  wt = join(repo, '.claude', 'worktrees', 'task-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/task-1', wt);

  env = {
    ...process.env, NEARLY_PORT: String(PORT),
    NEARLY_RECORDINGS: join(box, 'rec'), NEARLY_STORY: join(box, 'story'), NEARLY_OUT: join(box, 'out'),
    NEARLY_REPOS: join(box, 'repos.json'), NEARLY_OUTSIDE: join(box, 'outside'), NEARLY_CONFIG: join(box, 'config.json'),
    NEARLY_NO_UPDATE: '1', NO_COLOR: '1',
  };
  for (const d of ['rec', 'story', 'out']) mkdirSync(join(box, d), { recursive: true });
  // The server's own output goes to a file, so if it ever stops answering the
  // failure says why instead of just "fetch failed".
  const log = openSync(join(box, 'server.log'), 'a');
  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, stdio: ['ignore', log, log], env });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 3000); });
  rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const hook = (ev, query, body) => fetch(`http://127.0.0.1:${PORT}/hooks/${ev}?${query}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).catch((e) => {
  const said = existsSync(join(box, 'server.log')) ? readFileSync(join(box, 'server.log'), 'utf8').slice(-2000) : '';
  throw new Error(`the server did not answer ${ev} (${e.message}); exited: ${server.exitCode}\n${said}`);
});
const events = (sid) => {
  const f = join(box, 'rec', `${sid}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const build = (branch) => spawnSync(process.execPath, [join(root, 'scripts', 'build-recap.mjs'), '--branch', branch, '--repo', repo, '--no-audio'],
  { encoding: 'utf8', timeout: 120_000, env });
const story = (branch) => JSON.parse(readFileSync(join(box, 'story', `site--${branch.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}.json`), 'utf8'));
const prompts = (sb) => sb.scenes.filter((s) => s.kind === 'intent').map((s) => s.text);

test('a session that switches branch is recorded on the branch it switched to', async () => {
  const sid = 'switch-1';
  await hook('prompt', 'attach=site&auto=1', { session_id: sid, cwd: repo, prompt: 'look around first' });
  await hook('pre-tool', 'attach=site&auto=1', { session_id: sid, cwd: repo, tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: join(repo, 'a.txt') } });
  // The agent makes a branch for the task, the way agents do.
  git(repo, 'checkout', '-q', '-b', 'feat/footer');
  await hook('prompt', 'attach=site&auto=1', { session_id: sid, cwd: repo, prompt: 'now dim the footer flower' });
  await hook('post-tool', 'attach=site&auto=1', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'git checkout -b feat/footer' }, tool_response: '' });
  await hook('pre-tool', 'attach=site&auto=1', { session_id: sid, cwd: repo, tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: join(repo, 'a.txt'), old_string: 'x', new_string: 'y' } });
  git(repo, 'checkout', '-q', 'main');

  assert.ok(events(sid).some((e) => e.type === 'branch' && e.branch === 'feat/footer'), 'the switch was never noticed');
  const r = build('feat/footer');
  assert.equal(r.status, 0, `no record for the branch it switched to: ${r.stderr}`);
  assert.deepEqual(prompts(story('feat/footer')), ['now dim the footer flower'], 'the branch record should hold the work done on it');
  // And the branch it started on keeps only what happened there.
  build('main');
  assert.deepEqual(prompts(story('main')), ['look around first']);
});

test('the instruction that caused a switch travels with it, and earlier work stays behind', () => {
  // "make a branch for the footer" comes before the switch is seen; it belongs to
  // the new branch. The instruction before it, which had work done on the old
  // branch, stays there.
  const sid = 'slice-1';
  const t = 1789000000000;
  const at = (n) => t + n * 1000;
  const lines = [
    { type: 'session', subtype: 'created', name: 'site', branch: 'main', worktree: repo, attached: true, at: at(0) },
    { type: 'prompt', text: 'tidy the readme', at: at(1) },
    { type: 'decision', id: 'a', decision: 'allow', tool: 'Edit', input: { file_path: join(repo, 'a.txt') }, tier: 'log', at: at(2) },
    { type: 'prompt', text: 'make a branch for the footer work', at: at(3) },
    { type: 'branch', branch: 'feat/slice', worktree: repo, at: at(4) },
    { type: 'decision', id: 'b', decision: 'allow', tool: 'Edit', input: { file_path: join(repo, 'a.txt') }, tier: 'log', at: at(5) },
  ].map((e) => JSON.stringify({ ...e, session: sid }));
  writeFileSync(join(box, 'rec', `${sid}.jsonl`), lines.join('\n') + '\n');
  assert.equal(build('feat/slice').status, 0);
  assert.deepEqual(prompts(story('feat/slice')), ['make a branch for the footer work']);
  build('main');
  assert.ok(prompts(story('main')).includes('tidy the readme'));
  assert.ok(!prompts(story('main')).includes('make a branch for the footer work'), 'the instruction that moved the session stayed behind');
});

test('an older recording with no branch changes noted is split by the switches the agent ran', () => {
  // Recordings from before branch changes were noted still show them in the
  // commands. A real one made eight branches with `git checkout -q -b <name>`.
  const sid = 'old-1';
  const t = 1789000000000;
  const at = (n) => t + n * 1000;
  const bash = (id, command, n) => ({ type: 'decision', id, decision: 'allow', tool: 'Bash', input: { command }, tier: 'log', at: at(n) });
  const lines = [
    { type: 'session', subtype: 'created', name: 'site', branch: 'main', worktree: repo, attached: true, at: at(0) },
    { type: 'prompt', text: 'fix the type scale', at: at(100) },
    bash('a', 'git checkout -q -b type-scale && grep -n font styles.css', 101),
    bash('b', 'git commit -qam "type scale"', 130),
    { type: 'prompt', text: 'make the resume open in a new tab', at: at(500) },
    bash('c', `cd ${repo} && git checkout -q main && git checkout -q -b resume-tab`, 501),
    bash('d', 'git commit -qam "new tab"', 560),
    // A checkout in some other repository is not a switch of this session's branch.
    bash('e', `cd ${join(box, 'other')} && git checkout -q -b not-this-repo`, 600),
  ].map((e) => JSON.stringify({ ...e, session: sid }));
  writeFileSync(join(box, 'rec', `${sid}.jsonl`), lines.join('\n') + '\n');

  assert.equal(build('resume-tab').status, 0, 'a branch made with checkout -b was not found in an older recording');
  const sb = story('resume-tab');
  assert.deepEqual(prompts(sb), ['make the resume open in a new tab']);
  // Timed from when work on the branch began, not from when the session did.
  assert.ok(sb.durationS < 120, `the branch record claims ${sb.durationS}s`);
  assert.equal(build('type-scale').status, 0);
  assert.deepEqual(prompts(story('type-scale')), ['fix the type scale']);
  assert.notEqual(build('not-this-repo').status, 0, 'a checkout in another repository was read as this session\'s branch');
});

test('a session in a worktree is found when the push names the main folder', async () => {
  const sid = 'wt-1';
  await hook('prompt', 'attach=site&auto=1', { session_id: sid, cwd: wt, prompt: 'work in the worktree' });
  await hook('pre-tool', 'attach=site&auto=1', { session_id: sid, cwd: wt, tool_name: 'Edit', tool_use_id: 'w1', tool_input: { file_path: join(wt, 'a.txt'), old_string: 'x', new_string: 'z' } });
  const created = events(sid).find((e) => e.type === 'session' && e.subtype === 'created');
  assert.equal(created.branch, 'claude/task-1');
  const r = build('claude/task-1');           // --repo is the main folder, as the pre-push hook passes it
  assert.equal(r.status, 0, `a worktree session was not found from the main folder: ${r.stderr}`);
  assert.deepEqual(prompts(story('claude/task-1')), ['work in the worktree']);
});

test('a session opened elsewhere and working in a worktree is recorded against that worktree', async () => {
  // Matched to the repo by its main folder, but the work — and the branch — are in the worktree.
  const sid = 'wt-outside-1';
  await hook('pre-tool', `attach=site&auto=1&outside=1&repo=${encodeURIComponent(repo)}`,
    { session_id: sid, cwd: wt, tool_name: 'Edit', tool_use_id: 'o1', tool_input: { file_path: join(wt, 'a.txt'), old_string: 'x', new_string: 'q' } });
  const created = events(sid).find((e) => e.type === 'session' && e.subtype === 'created');
  assert.equal(realpathSync.native(created.worktree), realpathSync.native(wt), 'recorded against the main folder instead of the worktree');
  assert.equal(created.branch, 'claude/task-1', 'recorded on the main folder\'s branch');
});

test('a sibling repository is still not this repository', async () => {
  const other = join(box, 'other');
  mkdirSync(other);
  git(other, 'init', '-q', '-b', 'claude/task-1'); git(other, 'config', 'user.email', 't@x'); git(other, 'config', 'user.name', 'T');
  writeFileSync(join(other, 'b.txt'), 'b\n'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 's');
  const sid = 'sibling-1';
  await hook('prompt', 'attach=other&auto=1', { session_id: sid, cwd: other, prompt: 'work somewhere else entirely' });
  await hook('pre-tool', 'attach=other&auto=1', { session_id: sid, cwd: other, tool_name: 'Read', tool_use_id: 's1', tool_input: { file_path: join(other, 'b.txt') } });
  build('claude/task-1');
  assert.ok(!prompts(story('claude/task-1')).includes('work somewhere else entirely'), 'another repo\'s session with the same branch name was mixed in');
});

test('the push records the branch git says is being pushed, not whatever is checked out', () => {
  // HEAD in the main folder is main; the push is of claude/task-1. git hands the
  // pre-push hook that list on stdin, and that is what counts.
  const sha = git(wt, 'rev-parse', 'HEAD');
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'push-record.mjs'), repo], {
    encoding: 'utf8', timeout: 120_000, input: `refs/heads/claude/task-1 ${sha} refs/heads/claude/task-1 0000000000000000000000000000000000000000\n`,
    // gh with nowhere to sign in from, so nothing is posted. Not by emptying PATH:
    // on Windows that hides git too, and then no repository can be recognised.
    env: { ...env, NEARLY_NO_TTY: '1', GH_CONFIG_DIR: join(box, 'no-gh-config'), GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /no agent sessions recorded/, `the pushed branch was not the one looked up:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Session record for claude\/task-1/);
});

test('the pre-push hook leaves git\'s list of pushed branches on stdin', () => {
  const hookFile = join(box, 'hooktest');
  mkdirSync(join(hookFile, '.git', 'hooks'), { recursive: true });
  git(hookFile, 'init', '-q');
  spawnSync(process.execPath, [join(root, 'scripts', 'install-push-hook.mjs'), hookFile, '--cmd', 'nearly'], { encoding: 'utf8' });
  const text = readFileSync(join(hookFile, '.git', 'hooks', 'pre-push'), 'utf8');
  assert.doesNotMatch(text, /<\s*\/dev\/tty/, 'stdin is replaced by the terminal, so the pushed refs never arrive');
});
