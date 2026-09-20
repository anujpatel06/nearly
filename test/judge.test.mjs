// The second opinion on a finished record.
//
// The thing being guarded is not the judgement itself — it is everything around
// it. A record must be exactly what it was when there is no key, no network, a
// slow answer or a strange one; nothing about a live session may depend on it;
// and what leaves the machine must be what we say leaves it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = '77777777-2222-4333-8444-555555555555';

let box, repo, api, port, seen, reply, env;

// Stands in for TypeSafe: records what was asked, answers what the test wants.
before(async () => {
  box = realpathSync.native(mkdtempSync(join(tmpdir(), 'nearly-judge-')));
  repo = join(box, 'site');
  for (const d of [repo, join(box, 'rec'), join(box, 'story'), join(box, 'out')]) mkdirSync(d, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'feat/x'); git('config', 'user.email', 't@x'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'seed');

  api = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    const r = await reply(JSON.parse(body || '{}'));
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json ?? {}));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  port = api.address().port;

  // Two refusals, in the order they happened: the agent's own scratch file first,
  // then the home directory. Exactly the pair that made a real record open with
  // the wrong one.
  const t0 = 1789000000000;
  const at = (s) => t0 + s * 1000;
  const lines = [
    { type: 'session', subtype: 'created', name: 'site', branch: 'feat/x', worktree: repo, attached: true, at: at(0) },
    { type: 'prompt', text: 'make the footer flower dimmer', at: at(1) },
    { type: 'decision', id: 'a', decision: 'deny', why: 'deletes scratch', scope: 'policy', tool: 'Bash', input: { command: `rm -rf ${join(homedir(), 'scratch', 'frames')}` }, tier: 'never', at: at(2) },
    { type: 'decision', id: 'b', decision: 'deny', why: 'deletes ~', scope: 'policy', tool: 'Bash', input: { command: 'rm -rf ~' }, tier: 'never', at: at(3) },
    { type: 'turn_diff', turn: 1, msg: 'turn 1', commits: [], files: [], stat: [{ file: 'styles.css', add: 4, del: 2 }], at: at(60) },
    { type: 'session', subtype: 'exited', reason: 'other', at: at(61) },
  ].map((e) => JSON.stringify({ ...e, session: SID }));
  writeFileSync(join(box, 'rec', `${SID}.jsonl`), lines.join('\n') + '\n');

  env = {
    ...process.env,
    NEARLY_RECORDINGS: join(box, 'rec'), NEARLY_STORY: join(box, 'story'), NEARLY_OUT: join(box, 'out'),
    NEARLY_CONFIG: join(box, 'config.json'), NEARLY_NO_UPDATE: '1', NO_COLOR: '1',
    NEARLY_TYPESAFE_URL: `http://127.0.0.1:${port}`,
  };
});

after(async () => {
  if (api) await new Promise((r) => api.close(r));
  rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, json: answers() });
  rmSync(join(box, 'story'), { recursive: true, force: true });
  mkdirSync(join(box, 'story'), { recursive: true });
});

// What Jev would send back: the first refusal is the agent's own scratch, the
// second is someone's home directory, and the work matched its instruction.
const answers = (over = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    refusal_0: { type: 'choice', choice: 'own_scratch', probabilities: { own_scratch: 0.93 }, confidence: 0.9 },
    refusal_1: { type: 'choice', choice: 'user_data', probabilities: { user_data: 0.97 }, confidence: 0.95 },
    attention: { type: 'score', score: 2.4, legend: {}, probabilities: {}, confidence: 0.8 },
    drift_0: { type: 'score', score: 0.1, legend: {}, probabilities: {}, confidence: 0.9 },
    ...over,
  },
  usage: { input_tokens: 300, output_tokens: 40 },
});

// Not spawnSync: the stand-in API lives in this process, and a blocking wait
// would stop it answering — the build would time out against a server that is
// only silent because the test is holding the thread.
const build = (extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(root, 'scripts', 'build-recap.mjs'), '--branch', 'feat/x', '--repo', repo, '--no-audio'],
    { env: { ...env, ...extra } });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stderr.on('data', (d) => (stderr += d));
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const story = () => JSON.parse(readFileSync(join(box, 'story', 'site--feat-x.json'), 'utf8'));
const refusals = () => story().scenes.find((s) => s.kind === 'outcome').notDone;

test('with no key, nothing is asked and the record is what it always was', async () => {
  const r = await build();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.length, 0, 'a record was sent somewhere without a key');
  const rs = refusals();
  assert.equal(rs.length, 2);
  assert.ok(!rs.some((n) => n.kind), 'labels appeared without a judgement');
  assert.equal(story().judgement, undefined);
});

test('with a key, each refusal is labelled and the worst one is listed first', async () => {
  const r = await build({ NEARLY_TYPESAFE_KEY: 'test-key' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.length, 1, `every question must travel in one request\n${r.stdout}${r.stderr}`);
  assert.equal(seen[0].auth, 'Bearer test-key');
  const rs = refusals();
  assert.equal(rs[0].kind, 'user_data', `the home directory should lead, got ${rs[0].kind}`);
  assert.match(rs[0].what, /rm -rf ~/);
  assert.equal(rs[1].kind, 'own_scratch');
  assert.equal(story().judgement.by, 'jev-1.13.0');
  assert.ok(story().judgement.attention.says);
});

test('what is sent is the commands and instructions, with the home path taken out', async () => {
  await build({ NEARLY_TYPESAFE_KEY: 'test-key' });
  const { state, questions, model } = seen[0].body;
  assert.equal(model, 'jev-latest');
  const sent = JSON.stringify(state);
  assert.ok(sent.includes('rm -rf ~'), 'the command being judged has to be in the state');
  assert.ok(!sent.includes(homedir()), `the home path travelled: ${homedir()}`);
  assert.deepEqual(Object.keys(questions).sort(), ['attention', 'drift_0', 'refusal_0', 'refusal_1']);
  assert.equal(questions.refusal_0.type, 'choice');
  assert.equal(questions.attention.type, 'score');
  // The diff itself is not the model's business.
  assert.ok(!sent.includes('+'), 'a patch was sent');
});

test('a second build of the same branch asks nothing again', async () => {
  await build({ NEARLY_TYPESAFE_KEY: 'test-key' });
  assert.equal(seen.length, 1);
  await build({ NEARLY_TYPESAFE_KEY: 'test-key' });
  assert.equal(seen.length, 1, 'the same questions were paid for twice');
  assert.equal(refusals()[0].kind, 'user_data', 'the cached judgement was not applied');
});

test('a refused, broken or slow answer leaves the record exactly as it was', async () => {
  for (const [name, r] of [
    ['500', () => ({ status: 500, json: { error: 'nope' } })],
    ['nonsense', () => ({ status: 200, json: { answers: { refusal_0: { type: 'choice', choice: 'not-an-option' } } } })],
    ['no answers at all', () => ({ status: 200, json: { model: 'jev-1.13.0' } })],
    ['slow', () => new Promise((res) => setTimeout(() => res({ status: 200, json: answers() }), 2500))],
  ]) {
    seen = [];
    reply = r;
    rmSync(join(box, 'story'), { recursive: true, force: true });
    mkdirSync(join(box, 'story'), { recursive: true });
    const out = await build({ NEARLY_TYPESAFE_KEY: `test-key-${name}`, NEARLY_TYPESAFE_TIMEOUT_MS: '600' });
    assert.equal(out.status, 0, `${name}: the record failed to build: ${out.stderr}`);
    const rs = refusals();
    assert.equal(rs.length, 2, `${name}: refusals were lost`);
    assert.ok(!rs.some((n) => n.kind), `${name}: a label came from a bad answer`);
    assert.equal(story().judgement, undefined, `${name}: the record claims it was judged`);
  }
});

test('nothing about a live session can reach it: the hook path never imports this', () => {
  // The whole point is that this runs after the work. A judgement in front of a
  // tool call would be a network call an agent waits on.
  for (const f of ['scripts/hook.mjs', 'scripts/outside-hook.mjs', 'server/index.mjs', 'server/policy.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /judge\.mjs|typesafe/i, `${f} reaches the judgement`);
  }
});

test('the comment says what each refusal would have hit, and says who judged it', async () => {
  await build({ NEARLY_TYPESAFE_KEY: 'test-key' });
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'post-recap.mjs'), 'site--feat-x', '--dry-run'],
    { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(r.status, 0, r.stderr);
  const body = r.stdout;
  const first = body.indexOf("someone's own files");
  const second = body.indexOf("the agent's own scratch files");
  assert.ok(first > 0 && second > first, 'the worst refusal is not the one a reviewer reads first');
  assert.match(body, /Worth a reviewer's time:/);
  assert.match(body, /judgements from jev-1\.13\.0, not counts/);
});

test('nearly judge saves the key, and nearly judge off removes it', () => {
  const nearly = (...a) => spawnSync(process.execPath, [join(root, 'bin', 'nearly.mjs'), 'judge', ...a], { encoding: 'utf8', env });
  const cfg = () => (existsSync(env.NEARLY_CONFIG) ? JSON.parse(readFileSync(env.NEARLY_CONFIG, 'utf8')) : {});
  try {
    assert.match(nearly().stdout, /Off\./);
    nearly('secret-key');
    assert.equal(cfg().typesafeKey, 'secret-key');
    assert.match(nearly().stdout, /judged at push time|labelled/);
    nearly('off');
    assert.equal(cfg().typesafeKey, undefined);
  } finally {
    const c = cfg(); delete c.typesafeKey; writeFileSync(env.NEARLY_CONFIG, JSON.stringify(c, null, 2));
  }
});
