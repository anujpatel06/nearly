// Sessions opened in another folder, and the same call arriving through two hooks.
//
// The failure these guard against was silent from every angle: a session opened
// one folder above a repo Nearly was on for edited that repo, nothing was gated,
// nothing was recorded, and `nearly doctor` in the repo said everything was fine.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(root, 'scripts', 'hook.mjs');
const PORT = 46200 + Math.floor(Math.random() * 300);

const scrub = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const gone = (p) => (p && p.exitCode === null && !p.killed
  ? new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); setTimeout(r, 3000); })
  : Promise.resolve());

let server, box, outer, repo, claudeDir, recordings, env, onOutput;

before(async () => {
  box = realpathSync.native(mkdtempSync(join(tmpdir(), 'nearly-outside-')));
  outer = join(box, 'work');                 // the folder the session is opened in
  repo = join(outer, 'alpha');               // the repo Nearly is on for, inside it
  claudeDir = join(box, 'claude');
  recordings = join(box, 'recordings');
  mkdirSync(repo, { recursive: true });
  mkdirSync(claudeDir);
  mkdirSync(recordings);
  const git = (...a) => spawnSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@x'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'seed');

  // Somebody's own user-level settings, which must come through untouched.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    theme: 'dark',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));

  env = {
    ...process.env,
    NEARLY_PORT: String(PORT), NEARLY_REPOS: join(box, 'repos.json'), NEARLY_RECORDINGS: recordings,
    NEARLY_HOME: join(box, 'home'), CLAUDE_CONFIG_DIR: claudeDir, NEARLY_NO_INSTALL: '1',
    NEARLY_CONFIG: join(box, 'config.json'), NEARLY_OUTSIDE: join(box, 'outside'), NEARLY_ASK_TIMEOUT_MS: '2000', NO_COLOR: '1',
  };
  delete env.CLAUDE_PROJECT_DIR;

  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, stdio: 'ignore', env });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const on = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env });
  assert.equal(on.status, 0, on.stderr);
  onOutput = on.stdout;
});

after(async () => {
  await gone(server);
  scrub(box);
});

function fire(args, payload, extraEnv = {}, entry = HOOK) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, ...args], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.stdin.end(JSON.stringify(payload));
  });
}
// What Claude Code's user settings run: the dedicated entry, not the flag.
const fireOut = (args, payload, extraEnv) => fire(args, payload, extraEnv, join(root, 'scripts', 'outside-hook.mjs'));
const decisionOf = (out) => { try { return JSON.parse(out).hookSpecificOutput.permissionDecision; } catch { return null; } };
const events = (sid) => {
  const f = join(recordings, `${sid}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const call = (sid, id, tool, input, cwd = outer) => ({
  session_id: sid, tool_use_id: id, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
});

test('turning it on adds one quiet hook to Claude Code\'s user settings, and keeps everything already there', () => {
  const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.ok(JSON.stringify(s.hooks.PreToolUse).includes('echo mine'), 'the person\'s own hook was lost');
  for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.ok((s.hooks[ev] || []).some((e) => /outside-hook\.mjs/.test(JSON.stringify(e))), `no user-level ${ev} hook`);
  }
});

test('turning it on says to restart open sessions, and that the record comes with the next push', () => {
  // Both were true and neither was said, so the natural reading of an empty pull
  // request was that Nearly did not work.
  assert.match(onOutput, /restart any Claude Code session already open/);
  assert.match(onOutput, /next push|posted to the pull request when it is opened/);
  assert.match(onOutput, /sessions opened in another folder are gated too/);
});

test('a session opened one folder up is gated and recorded when it edits the repo', async () => {
  const out = await fireOut(['pre-tool'],
    call('outer-1', 'w1', 'Write', { file_path: join(repo, 'new-file.txt'), content: 'hi' }),
    { CLAUDE_PROJECT_DIR: outer });
  assert.equal(decisionOf(out), 'allow', `no answer came back: ${out}`);
  const ev = events('outer-1');
  const created = ev.find((e) => e.type === 'session' && e.subtype === 'created');
  assert.ok(created, 'the session was never recorded');
  assert.equal(created.worktree, repo, 'recorded against the folder it was opened in, not the repo');
  assert.equal(created.name, 'alpha');
  assert.ok(ev.some((e) => e.type === 'decision' && e.id === 'w1'));
});

test('once it is gated, a destructive call that never mentions the repo is still refused', async () => {
  const out = await fireOut(['pre-tool'],
    call('outer-1', 'r1', 'Bash', { command: 'rm -rf ~/nearly-outside-canary' }), { CLAUDE_PROJECT_DIR: outer });
  assert.equal(decisionOf(out), 'deny', `rm -rf in the home folder was not refused: ${out}`);
});

test('the repo it is working in is the boundary, not the folder it was opened in', async () => {
  // Straight at the server, with paths that do not exist: a temp folder is
  // deletable by design, so a box under /tmp cannot tell this apart. This is the
  // real shape — a repo inside an ordinary folder that is not itself a repo.
  const elsewhere = join(homedir(), 'projects-for-this-test');
  const inside = join(elsewhere, 'app');
  const decide = async (query, command) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/hooks/pre-tool?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: `boundary-${Math.random()}`, tool_use_id: 't', cwd: elsewhere, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    });
    return (await res.json()).hookSpecificOutput?.permissionDecision;
  };
  const rm = (p) => 'rm' + ' -rf ' + p;
  assert.equal(await decide(`attach=alpha&auto=1&outside=1&repo=${encodeURIComponent(inside)}`, rm(join(inside, 'dist'))), 'allow',
    'build output inside the session\'s own repo was refused');
  assert.equal(await decide(`attach=alpha&auto=1&outside=1&repo=${encodeURIComponent(inside)}`, rm(join(elsewhere, 'another-project'))), 'deny',
    'the boundary did not stop at the repo');
});

test('a relative cd into the repo counts as working in it', async () => {
  const out = await fireOut(['pre-tool'],
    call('outer-cd', 'c1', 'Bash', { command: 'cd alpha && git status' }), { CLAUDE_PROJECT_DIR: outer });
  assert.equal(decisionOf(out), 'allow');
  assert.ok(events('outer-cd').length, 'a cd into the repo was not seen');
});

test('a session that never touches an attached repo gets no answer and leaves no record', async () => {
  const elsewhere = mkdtempSync(join(box, 'elsewhere-'));
  const out = await fireOut(['pre-tool'],
    call('stranger', 's1', 'Bash', { command: 'ls -la' }, elsewhere), { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(out, '', 'an unrelated session was answered');
  assert.equal(events('stranger').length, 0, 'an unrelated session was recorded');
  const prompt = await fireOut(['prompt'], { session_id: 'stranger', cwd: elsewhere, prompt: 'hello' }, { CLAUDE_PROJECT_DIR: elsewhere });
  assert.equal(prompt, '');
  assert.equal(events('stranger').length, 0);
});

test('an unrelated session never reaches a server, so an older one cannot refuse its calls', async () => {
  // A newer hook meeting a server from before this existed got "deny: unknown
  // session" back — for every tool call of every Claude Code session on the
  // machine. Stand in for that server and check nothing arrives.
  const { createServer } = await import('node:http');
  let hits = 0;
  const old = createServer((req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ ok: true, version: '0.1.17' }));
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nearly: unknown session' } }));
  });
  const port = PORT + 400;
  await new Promise((r) => old.listen(port, '127.0.0.1', r));
  try {
    const elsewhere = mkdtempSync(join(box, 'elsewhere-'));
    const out = await fireOut(['pre-tool'], call('stranger-2', 's2', 'Bash', { command: 'ls' }, elsewhere),
      { CLAUDE_PROJECT_DIR: elsewhere, NEARLY_PORT: String(port) });
    assert.equal(out, '', `an unrelated call was answered: ${out}`);
    assert.equal(hits, 0, 'an unrelated call reached a server');
  } finally { await new Promise((r) => old.close(r)); }
});

test('a session started in the repo is left to the repo\'s own hooks', async () => {
  const out = await fireOut(['pre-tool'],
    call('inside-1', 'i1', 'Write', { file_path: join(repo, 'b.txt'), content: 'x' }, repo), { CLAUDE_PROJECT_DIR: repo });
  assert.equal(out, '', 'the user-level hook answered alongside the repo\'s own');
  assert.equal(events('inside-1').length, 0);
});

test('one call heard by two hooks is answered by both and written down once', async () => {
  const sub = join(repo, 'src');
  mkdirSync(sub, { recursive: true });
  const payload = call('both-1', 'dup-1', 'Bash', { command: 'rm -rf ~' }, sub);
  const [a, b] = await Promise.all([
    fire(['pre-tool', 'alpha', '--auto'], payload, { CLAUDE_PROJECT_DIR: sub }),
    fireOut(['pre-tool'], payload, { CLAUDE_PROJECT_DIR: sub }),
  ]);
  assert.equal(decisionOf(a), 'deny');
  assert.equal(decisionOf(b), 'deny');
  const decisions = events('both-1').filter((e) => e.type === 'decision' && e.id === 'dup-1');
  assert.equal(decisions.length, 1, `recorded ${decisions.length} times`);
});

test('what was asked is taken from the transcript, since the prompt went by before the session was known', async () => {
  const transcript = join(box, 'transcript.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'add a footer to the site' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await fireOut(['pre-tool'],
    { ...call('outer-t', 't1', 'Edit', { file_path: join(repo, 'a.txt'), old_string: 'x', new_string: 'y' }), transcript_path: transcript },
    { CLAUDE_PROJECT_DIR: outer });
  const prompts = events('outer-t').filter((e) => e.type === 'prompt');
  assert.deepEqual(prompts.map((p) => p.text), ['add a footer to the site']);
});

test('a path that does not exist yet still belongs to the repo it is in', async () => {
  const { concerns, attachedRepos } = await import(pathToFileURL(join(root, 'scripts', 'outside.mjs')).href);
  process.env.NEARLY_REPOS = env.NEARLY_REPOS;
  const repos = attachedRepos();
  assert.equal(repos.length, 1);
  assert.equal(repos[0].auto, true);
  assert.ok(concerns({ cwd: outer, tool_input: { file_path: join(repo, 'deep', 'not', 'yet.txt') } }, repos));
  assert.equal(concerns({ cwd: outer, tool_input: { command: 'echo alphabet' } }, repos), null);
  assert.equal(concerns({ cwd: homedir(), tool_input: { file_path: join(outer, 'alpha-notes.txt') } }, repos), null,
    'a sibling whose name starts with the repo\'s was taken for the repo');
});

test('doctor says a merged pull request is merged, not open', () => {
  if (process.platform === 'win32') return;
  const bin = join(box, 'fake-gh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.0.0";;
  auth) exit 0;;
  pr) echo '{"number":7,"url":"https://github.com/o/r/pull/7","state":"MERGED"}';;
esac
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'doctor.mjs'), repo],
    { encoding: 'utf8', timeout: 60_000, env: { ...env, PATH: `${bin}:${process.env.PATH}`, NEARLY_NO_UPDATE: '1' } });
  assert.doesNotMatch(r.stdout, /✓ open pull request/, 'a merged pull request was reported as open');
  assert.match(r.stdout, /#7 for main is merged/);
  assert.match(r.stdout, /✓ sessions opened in other folders/);
});

test('turning it off for the last repo removes the user-level hook and nothing else', () => {
  const off = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, '--off'], { encoding: 'utf8', env });
  assert.equal(off.status, 0, off.stderr);
  const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.ok(JSON.stringify(s.hooks).includes('echo mine'), 'off removed the person\'s own hook');
  assert.doesNotMatch(JSON.stringify(s), /outside-hook|--outside/, 'the user-level hook outlived the last repo');
});

test('an unreadable user settings file is left exactly as it was', () => {
  const file = join(claudeDir, 'settings.json');
  const before = '{ "theme": "dark", oops';
  writeFileSync(file, before);
  const on = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(readFileSync(file, 'utf8'), before, 'a file that could not be parsed was overwritten');
  assert.match(on.stdout, /could not be read/);
});
