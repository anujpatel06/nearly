// The record reaching the pull request, and saying true things when it gets there.
//
// Nearly recorded four sessions and 190 tool calls on a real branch, and the
// reviewer saw nothing: every push was made by the agent, which has no terminal,
// and posting waited for a "y" in a terminal. The pull request itself was opened
// after the push, so no push ever found it. The record that did get built said
// "under Anuj's supervision" about a run nobody watched, "5221s" for an hour and
// a half, and called file writes read-only steps.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform === 'win32';   // the stand-in gh is a shell script

let box, repo, bin, ghLog, env;

// Stands in for the GitHub CLI: an open pull request, no comment yet, and a log
// of every call so the test can see what was posted.
function fakeGh(state = 'OPEN') {
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$@" >> "${ghLog}"
case "$1 $2" in
  "--version "*) echo "gh version 2.0.0";;
  "auth status") exit 0;;
  "pr view") echo '{"number":12,"url":"https://github.com/o/r/pull/12","state":"${state}"}';;
  "repo view") echo '{"nameWithOwner":"o/r"}';;
  "api repos/o/r/issues/12/comments") echo 'null';;
  "pr comment") echo "https://github.com/o/r/pull/12#issuecomment-1";;
  "pr create") echo "https://github.com/o/r/pull/12";;
esac
exit 0
`, { mode: 0o755 });
}
const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '');

// An unattended session on the branch: a few steps, then a long silence, then the
// turn's diff — 87 minutes end to end, of which only the start is work.
function recording(sid) {
  const t0 = 1789000000000;
  const at = (s) => t0 + s * 1000;
  const lines = [
    { type: 'session', subtype: 'created', name: 'site', branch: 'feat/x', worktree: repo, attached: true, at: at(0) },
    { type: 'prompt', text: 'raise a pr', at: at(1) },
    { type: 'decision', id: 'a', decision: 'allow', why: 'default for Read', scope: 'policy', tool: 'Read', input: { file_path: join(repo, 'a.txt') }, tier: 'log', at: at(2) },
    { type: 'decision', id: 'b', decision: 'allow', why: 'allowed unattended — nobody was asked', scope: 'auto', tool: 'Write', input: { file_path: join(repo, 'b.txt') }, tier: 'log', at: at(3) },
    { type: 'decision', id: 'c', decision: 'deny', why: 'deletes ~', scope: 'policy', tool: 'Bash', input: { command: 'rm -rf ~' }, tier: 'never', unattended: true, at: at(4) },
    { type: 'turn_diff', turn: 1, msg: 'turn 1', commits: [], files: [], at: at(5221) },
    { type: 'session', subtype: 'exited', reason: 'other', at: at(5221) },
  ].map((e) => JSON.stringify({ ...e, session: sid }));
  writeFileSync(join(env.NEARLY_RECORDINGS, `${sid}.jsonl`), lines.join('\n') + '\n');
}

before(() => {
  if (skip) return;
  box = realpathSync.native(mkdtempSync(join(tmpdir(), 'nearly-posting-')));
  repo = join(box, 'site');
  bin = join(box, 'bin');
  ghLog = join(box, 'gh.log');
  for (const d of [repo, bin, join(box, 'rec'), join(box, 'story'), join(box, 'out')]) mkdirSync(d, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'feat/x'); git('config', 'user.email', 't@x'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'seed');
  env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    NEARLY_RECORDINGS: join(box, 'rec'), NEARLY_STORY: join(box, 'story'), NEARLY_OUT: join(box, 'out'),
    NEARLY_CONFIG: join(box, 'config.json'), NEARLY_NO_UPDATE: '1', NEARLY_URL_BASE: '', NO_COLOR: '1',
  };
  fakeGh();
  recording('11111111-2222-4333-8444-555555555555');
});

after(() => { if (box) rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const pushRecord = (extra = {}) => spawnSync(process.execPath, [join(root, 'scripts', 'push-record.mjs'), repo],
  { encoding: 'utf8', timeout: 120_000, input: '', env: { ...env, NEARLY_NO_TTY: '1', ...extra } });
const cover = () => JSON.parse(readFileSync(join(env.NEARLY_STORY, 'site--feat-x.json'), 'utf8')).scenes.find((s) => s.kind === 'cover');

test('a push with no terminal posts the record to the open pull request', { skip }, () => {
  writeFileSync(ghLog, '');
  const r = pushRecord();
  assert.equal(r.status, 0, r.stderr);
  assert.match(ghCalls(), /pr comment 12/, `nothing was posted:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /No terminal to ask on/);
});

test('an unattended record does not claim a supervisor', { skip }, () => {
  const c = cover();
  const labels = c.stats.map(([k]) => k);
  assert.ok(!labels.some((k) => /^Asked|Waiting on/.test(k)), `columns about a supervisor who was not there: ${labels}`);
  assert.doesNotMatch(c.narration, /supervision/);
  assert.match(c.narration, /nobody watching/);
});

test('a night of silence is not time the agent worked', { skip }, () => {
  // A branch touched on two days read "ran for 14 hours 57 minutes" on a real
  // pull request. It worked for about two.
  const stats = Object.fromEntries(cover().stats);
  assert.equal(stats['Ran for'], '5m', `wall clock counted as work: ${stats['Ran for']}`);
  assert.equal(stats['Spread over'], '1h 27m');
  assert.match(cover().narration, /worked for 5 minutes, spread across 1 hour 27 minutes/);
});

test('a session that ran straight through says nothing about being spread out', { skip }, () => {
  const sid = '22222222-2222-4333-8444-555555555555';
  const t0 = 1789100000000;
  const lines = [
    { type: 'session', subtype: 'created', name: 'site', branch: 'feat/steady', worktree: repo, attached: true, at: t0 },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'decision', id: `d${i}`, decision: 'allow', why: 'allowed unattended — nobody was asked', scope: 'auto', tool: 'Read', input: { file_path: join(repo, 'a.txt') }, tier: 'log', at: t0 + (i + 1) * 60_000 })),
    { type: 'session', subtype: 'exited', reason: 'other', at: t0 + 21 * 60_000 },
  ].map((e) => JSON.stringify({ ...e, session: sid }));
  writeFileSync(join(env.NEARLY_RECORDINGS, `${sid}.jsonl`), lines.join('\n') + '\n');
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-recap.mjs'), '--branch', 'feat/steady', '--repo', repo, '--no-audio'],
    { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(readFileSync(join(env.NEARLY_STORY, 'site--feat-steady.json'), 'utf8')).scenes.find((s) => s.kind === 'cover');
  const stats = Object.fromEntries(c.stats);
  assert.equal(stats['Ran for'], '20m');   // the twenty minutes between its steps
  assert.equal(stats['Spread over'], undefined, 'a session with no breaks was described as spread out');
  assert.doesNotMatch(c.narration, /spread across/);
});

test('the comment says when the record was true', { skip }, () => {
  // A record is rewritten on a push. On a merged pull request it is a snapshot,
  // and a reviewer reading "0 refused" deserves to know as of when.
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'post-recap.mjs'), 'site--feat-x', '--dry-run'],
    { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /The session this describes ended \d+ \w+, \d\d:\d\d; a later push updates this comment/);
});

test('a file write allowed without asking is not called read-only', { skip }, () => {
  const sb = JSON.parse(readFileSync(join(env.NEARLY_STORY, 'site--feat-x.json'), 'utf8'));
  const withWrite = sb.scenes.filter((s) => s.kind === 'quiet' && s.items.some((i) => i.tool === 'Write'));
  assert.ok(withWrite.length, 'the fixture has no write allowed without asking, so this test proves nothing');
  for (const q of sb.scenes.filter((s) => s.kind === 'quiet')) {
    if (q.items.some((i) => i.tool === 'Write')) assert.doesNotMatch(q.narration, /read-only/, q.narration);
  }
});

test('posting can be turned off for a repo, and then nothing is posted', { skip }, () => {
  const attach = (...a) => spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, ...a], {
    encoding: 'utf8', env: { ...env, NEARLY_NO_INSTALL: '1', NEARLY_REPOS: join(box, 'repos.json'), CLAUDE_CONFIG_DIR: join(box, 'claude'), NEARLY_HOME: join(box, 'home') },
  });
  try {
    assert.equal(attach('--no-post').status, 0);
    writeFileSync(ghLog, '');
    const r = pushRecord();
    assert.equal(r.status, 0);
    assert.doesNotMatch(ghCalls(), /pr comment/, 'posted with posting turned off');
    assert.match(r.stdout, /nearly --post/);
  } finally {
    attach('--post');
    attach('--off');
  }
});

test('a merged pull request is not posted to on push', { skip }, () => {
  fakeGh('MERGED');
  try {
    writeFileSync(ghLog, '');
    const r = pushRecord();
    assert.equal(r.status, 0);
    assert.doesNotMatch(ghCalls(), /pr comment/);
    assert.match(r.stdout, /#12, is already merged/);
  } finally { fakeGh(); }
});

test('when an agent opens the pull request, the record is posted without waiting for another push', { skip }, async () => {
  const PORT = 46800 + Math.floor(Math.random() * 150);
  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore', env: { ...env, NEARLY_PORT: String(PORT), NEARLY_REPOS: join(box, 'repos.json'), NEARLY_OUTSIDE: join(box, 'outside') },
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    writeFileSync(ghLog, '');
    const hook = (ev, body) => fetch(`http://127.0.0.1:${PORT}/hooks/${ev}?attach=site&auto=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const sid = '99999999-2222-4333-8444-555555555555';
    await hook('pre-tool', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_use_id: 'p1', tool_input: { command: 'gh pr create --fill' } });
    await hook('post-tool', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_use_id: 'p1', tool_input: { command: 'gh pr create --fill' },
      tool_response: { stdout: 'https://github.com/o/r/pull/12', stderr: '' } });
    let posted = false;
    for (let i = 0; i < 150 && !posted; i++) {
      await new Promise((r) => setTimeout(r, 200));
      posted = /pr comment 12/.test(ghCalls());
    }
    assert.ok(posted, 'opening a pull request did not post the record');
  } finally {
    await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 3000); });
  }
});
