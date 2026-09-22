// Agent Nearly — spike server.
// Zero dependencies. Spawns `claude -p` sessions (your Claude subscription, no API key),
// gates every tool call through an HTTP PreToolUse hook, and streams everything to the UI.
//
//   node server/index.mjs        then open http://127.0.0.1:47653
//
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIER, ruleKey, classify as classifyWith } from './policy.mjs';
import { paths } from './paths.mjs';
import { rememberOutside } from './marks.mjs';
import { repoIdOf, toplevelOf, branchOf } from './repo-id.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.NEARLY_PORT || 47653);
const HOST = '127.0.0.1';
const WORKTREES = path.join(paths.workspace(), '.worktrees');
const RECORDINGS = paths.recordings();
const UI = path.join(ROOT, 'ui', 'index.html');
const MAX_SESSIONS = 3;                 // 8 GB machine
// Which build is actually answering on this port. A server started by a hook
// outlives the run that started it, so after an upgrade the old one keeps the
// port and keeps serving its own code — and every fix stays invisible. Say who
// we are so the launcher can tell.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();
// Idle since the last request. A server nobody is using should not hold a port
// for the rest of the week, least of all one running from a cache directory
// that npm may already have deleted.
const IDLE_EXIT_MS = Number(process.env.NEARLY_IDLE_EXIT_MS || 30 * 60_000);
let lastSeen = Date.now();
const ASK_TIMEOUT_MS = Number(process.env.NEARLY_ASK_TIMEOUT_MS || 120_000);         // UI must answer before this; then we fail CLOSED (deny)
const HOOK_TIMEOUT_S = 180;             // Claude Code's own hook timeout; must be > ASK_TIMEOUT
const MODEL = 'sonnet';
// Overridable so the tests can exercise everything around starting an agent
// without starting one, and so anyone whose binary is not called `claude` can
// say so.
const AGENT_CMD = process.env.NEARLY_AGENT_CMD || 'claude';
const MAX_TURNS = '12';

fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(WORKTREES, { recursive: true });

// ---------------------------------------------------------------------------
// Consent gradient. The rules learned during this run: "allow always" and
// "never" write here, keyed by ruleKey().
// ---------------------------------------------------------------------------
const rules = new Map();

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> session
const clients = new Set();  // SSE responses

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

function record(sid, ev) {
  const s = sessions.get(sid);
  const full = { ...ev, session: sid, at: ev.at || Date.now() };
  if (s) {
    s.events.push(full);
    fs.appendFileSync(path.join(RECORDINGS, `${s.id}.jsonl`), JSON.stringify(full) + '\n');
  }
  broadcast(full);
}

function summary(s) {
  return {
    id: s.id, name: s.name, state: s.state, worktree: s.worktree, branch: s.branch, attached: !!s.attached,
    turns: s.turns, lastText: s.lastText, currentTool: s.currentTool, usage: s.usage,
    rateLimit: s.rateLimit, pending: [...s.pending.values()].map(pendingView), startedAt: s.startedAt,
  };
}
function pendingView(p) {
  return { id: p.id, session: p.sid, tool: p.tool, input: p.input, tier: p.tier, reason: p.reason, key: p.key, at: p.at, holdMs: p.holdMs };
}

function hooksSettings(sid) {
  const url = (ev) => `http://${HOST}:${PORT}/hooks/${ev}?s=${sid}`;
  const h = (ev, timeout) => [{ hooks: [{ type: 'http', url: url(ev), timeout }] }];
  return {
    hooks: {
      PreToolUse: h('pre-tool', HOOK_TIMEOUT_S),
      PostToolUse: h('post-tool', 10),
      Stop: h('stop', 20),
      Notification: h('notification', 10),
      SubagentStart: h('subagent-start', 10),
      SubagentStop: h('subagent-stop', 10),
      PreCompact: h('pre-compact', 10),
    },
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The repo an agent started from the dashboard should branch from. There is no
// such thing as a default one: this used to assume a `workspace` folder beside
// the code, which exists in a checkout and never exists when the tool is
// installed from npm, so the button could only fail.
function knownRepos() {
  let listed = [];
  try { listed = JSON.parse(fs.readFileSync(paths.repos(), 'utf8')); } catch { /* none yet */ }
  const live = [...sessions.values()].filter((s) => s.attached && s.worktree).map((s) => s.worktree);
  // A repo can be moved or deleted after it was turned on; offering one that is
  // no longer there would just move the failure later.
  return [...new Set([...live, ...listed])].filter((r) => fs.existsSync(path.join(r, '.git')));
}

function resolveRepo(given) {
  // Nothing given: the repos you have turned Nearly on for are the ones you work
  // in, so they are the only sensible guess. One is a default; several are a
  // question, and guessing between them would branch the wrong project.
  const candidates = given ? [path.resolve(given)] : knownRepos();

  if (!candidates.length) {
    throw new Error('No repo to start from. Run `nearly` in the repo you want, then try again — or give a path.');
  }
  if (!given && candidates.length > 1) {
    throw new Error(`Several repos are attached. Say which one: ${candidates.join(', ')}`);
  }
  const repo = candidates[0];
  if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git repository.`);
  try {
    // An unborn HEAD is the other way this failed: git cannot branch from a repo
    // with no commits, and "invalid reference: main" explained none of that.
    git(repo, ['rev-parse', 'HEAD']);
  } catch {
    throw new Error(`${repo} has no commits yet. Make one, then start an agent from it.`);
  }
  return repo;
}

function createSession({ name, prompt, repo: repoArg }) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`max ${MAX_SESSIONS} sessions on this machine`);
  const repo = resolveRepo(repoArg);
  const id = randomUUID();
  const safe = String(name || 'agent').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'agent';
  const branch = `nearly/${safe}-${id.slice(0, 4)}`;
  const worktree = path.join(WORKTREES, `${safe}-${id.slice(0, 4)}`);
  // HEAD, not `main`: branch from where the person actually is. Hardcoding the
  // branch name broke every repo on master, every repo mid-feature, and every
  // repo that had simply never been called main.
  git(repo, ['worktree', 'add', '-B', branch, worktree, 'HEAD']);

  const settingsPath = path.join(worktree, '.nearly-hooks.json');
  fs.writeFileSync(settingsPath, JSON.stringify(hooksSettings(id)));

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--settings', settingsPath,
    '--permission-mode', 'default',
    '--permission-prompts', 'none',
    '--model', MODEL,
    '--max-turns', MAX_TURNS,
    '--name', safe,
  ];
  const proc = spawn(AGENT_CMD, args, { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'] });
  // An unhandled spawn error would take the whole server down and every other
  // session with it. The usual cause is Claude Code not being on PATH.
  proc.on('error', (e) => {
    const why = e.code === 'ENOENT'
      ? `${AGENT_CMD} is not on PATH. Install Claude Code, or check \`which ${AGENT_CMD}\`.`
      : e.message;
    record(id, { type: 'stderr', text: `could not start the agent: ${why}` });
    s.state = 'exited';
    broadcast({ type: 'session-state', session: id, state: s.state });
  });

  const s = {
    id, name: safe, branch, worktree, proc, state: 'starting', turns: 0, lastText: '', currentTool: null,
    usage: null, rateLimit: null, pending: new Map(), events: [], startedAt: Date.now(), buf: '',
  };
  s.repo = repo;
  sessions.set(id, s);
  record(id, { type: 'session', subtype: 'created', name: safe, branch, worktree, repo, prompt });

  // Writing the prompt to an agent that never started fails on stdin, not on the
  // process. On Windows that error arrives after the spawn error and, unhandled,
  // took the server down with every session in it. The spawn error already says why.
  proc.stdin.on('error', () => { /* reported by proc.on('error') or 'exit' */ });
  proc.stderr.on('data', (d) => record(id, { type: 'stderr', text: String(d).slice(0, 2000) }));
  proc.stdout.on('data', (d) => {
    s.buf += d;
    const lines = s.buf.split('\n');
    s.buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      onStream(s, j);
    }
  });
  proc.on('exit', (code) => {
    s.state = 'exited';
    record(id, { type: 'session', subtype: 'exited', code });
    broadcast({ type: 'session-state', session: id, state: s.state });
  });

  send(s, prompt);
  return s;
}

// A session started by Claude Code itself (terminal or VS Code) in a repo where
// scripts/attach.mjs installed our hooks. We do not own the process, so there is
// no stdin, no auto-commit and no undo; every turn's diff is recorded instead.
function attachSession({ id, name, cwd }) {
  let branch = null, base = null;
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    base = git(cwd, ['rev-parse', 'HEAD']);   // everything after this is the agent's work
  } catch { /* not a repo */ }
  const s = {
    id, name, branch, base, worktree: cwd, proc: null, attached: true, state: 'working', turns: 0, lastText: '',
    currentTool: null, usage: null, rateLimit: null, pending: new Map(), events: [], startedAt: Date.now(), buf: '',
  };
  s.repoId = repoIdOf(cwd);
  s.lastCwd = cwd;
  sessions.set(id, s);
  record(id, { type: 'session', subtype: 'created', name, branch, worktree: cwd, attached: true, repoId: s.repoId });
  return s;
}

// A session is not on one branch. Agents make a branch per task and switch to it,
// and a session in a git worktree works on that worktree's branch, not the main
// checkout's. Filing every call under the branch the session started on left a
// record for branches nothing was pushed from, and none for the eight that were.
// So note each change, and let a branch's record take the part spent on it.
function trackBranch(s, hook, force = false) {
  if (!s || !s.attached) return;
  const cwd = hook.cwd || s.worktree;
  // Asking git costs a few milliseconds. Only when something could have moved:
  // a shell command ran, the working folder changed, or a turn ended.
  if (!force && hook.tool_name !== 'Bash' && cwd === s.lastCwd) return;
  s.lastCwd = cwd;
  const here = toplevelOf(cwd) || s.worktree;
  // Working in some other repository for a moment is not a change of branch.
  if (s.repoId && repoIdOf(here) !== s.repoId) return;
  const b = branchOf(here);
  if (!b || (b === s.branch && here === s.worktree)) return;
  // Diffs are measured from where this branch started. Measured from where the
  // session started, a new branch's first turn showed every change the session
  // had made on every branch before it.
  try { s.base = git(here, ['rev-parse', 'HEAD']); } catch { /* keep the old base */ }
  s.branch = b;
  s.worktree = here;
  record(s.id, { type: 'branch', branch: b, worktree: here });
}

// `claude -p` does not fire SessionStart, so an attached headless session never
// tells us its model. Every hook payload carries transcript_path; read it there.
function modelFromTranscript(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      const m = j.message?.model || j.model;
      if (m) return m;
    }
  } catch { /* transcript unreadable; the recap just says "claude" */ }
  return null;
}

// "Raise a PR" pushes the branch first and opens the pull request second. The
// push found no pull request to post to, and nothing happens after the pull
// request exists — so on the agent's own branch, the one thing a reviewer opens
// never had a record on it. When an agent opens one, post straight away, from a
// process of its own so the agent is not kept waiting.
const OPENED = /\bgh\s+pr\s+create\b/;
function postWhenOpened(s, hook) {
  const cmd = hook.tool_input?.command;
  if (typeof cmd !== 'string' || !OPENED.test(cmd)) return;
  const said = typeof hook.tool_response === 'string' ? hook.tool_response : JSON.stringify(hook.tool_response ?? '');
  if (!/\/pull\/\d+/.test(said)) return;              // it did not open one
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'push-record.mjs'), s.worktree], {
      cwd: s.worktree, detached: true, stdio: 'ignore',
      env: { ...process.env, NEARLY_NO_UPDATE: '1', NEARLY_NO_TTY: '1' },
    });
    child.on('error', () => { /* the next push posts it */ });
    child.unref();
    record(s.id, { type: 'hook', event: 'record-posting', detail: 'pull request opened' });
  } catch { /* the next push posts it */ }
}

// The most recent thing the person typed, from a Claude Code transcript.
function promptFromTranscript(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    let last = null;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!l) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type !== 'user' || j.isMeta) continue;
      const c = j.message?.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) && !c.some((x) => x?.type === 'tool_result') ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
      if (text && !/^<(?:command-|local-command|system-reminder)/.test(text.trim())) last = text;
    }
    return last;
  } catch { return null; }
}

function turnDiff(cwd, base, maxLines = 200) {
  const from = base || 'HEAD';
  const numstat = git(cwd, ['diff', '--numstat', from]);
  const stat = numstat.split('\n').filter(Boolean).map((l) => {
    const [add, del, file] = l.split('\t');
    return { file, add: add === '-' ? 0 : +add, del: del === '-' ? 0 : +del };
  });
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter((f) => f && f !== '.claude/settings.local.json');
  for (const f of untracked) stat.push({ file: f, add: 0, del: 0, untracked: true });
  const full = git(cwd, ['diff', '--no-color', '--unified=2', from]);
  const lines = full.split('\n');
  return { stat, patch: { text: lines.slice(0, maxLines).join('\n'), truncated: lines.length > maxLines, total: lines.length } };
}

function buildRecap(s, extraArgs = [], cb) {
  const args = [path.join(ROOT, 'scripts', 'build-recap.mjs'), s.id, ...extraArgs];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('exit', (code) => {
    if (code !== 0) return cb(new Error(err.trim().split('\n').at(-1) || `exit ${code}`));
    // The builder prints its own path. Parse the current name, and keep the old
    // one working, because a scraped string is exactly what a rename breaks.
    const built = out.match(/Built ui(\/(?:records|recaps)\/[^\s]+\.html)/);
    const href = built ? built[1] : null;
    record(s.id, { type: 'recap', href, log: out.trim().split('\n')[0] });
    cb(null, href);
  });
}

function send(s, text) {
  const m = { type: 'user', message: { role: 'user', content: text } };
  if (s.proc.stdin.writable) s.proc.stdin.write(JSON.stringify(m) + '\n');
  s.state = 'working';
  record(s.id, { type: 'prompt', text });
  broadcast({ type: 'session-state', session: s.id, state: s.state });
}

function onStream(s, j) {
  // Keep the recording compact: store what the UI needs, not raw payloads.
  switch (j.type) {
    case 'system':
      if (j.subtype === 'init') {
        s.state = 'working';
        record(s.id, { type: 'init', model: j.model, claudeSession: j.session_id, apiKeySource: j.apiKeySource });
      } else if (j.subtype === 'hook_started' || j.subtype === 'hook_response') {
        // hook traffic is already recorded by our endpoints; skip to reduce noise
      } else if (j.subtype === 'api_error') {
        record(s.id, { type: 'api_error', attempt: j.retryAttempt, max: j.maxRetries, in: j.retryInMs });
      } else {
        record(s.id, { type: 'system', subtype: j.subtype, detail: trim(j) });
      }
      break;
    case 'assistant': {
      const content = j.message?.content || [];
      for (const b of content) {
        if (b.type === 'text' && b.text) { s.lastText = b.text.slice(0, 400); record(s.id, { type: 'text', text: b.text }); }
        if (b.type === 'tool_use') { s.currentTool = b.name; record(s.id, { type: 'tool_use', id: b.id, tool: b.name, input: b.input }); }
      }
      if (j.message?.usage) s.usage = pickUsage(j.message.usage);
      break;
    }
    case 'user': {
      const content = j.message?.content || [];
      for (const b of content) {
        if (b.type === 'tool_result') {
          s.currentTool = null;
          record(s.id, { type: 'tool_result', id: b.tool_use_id, is_error: !!b.is_error, content: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 1500) });
        }
      }
      break;
    }
    case 'rate_limit_event':
      s.rateLimit = j.rate_limit_info?.unifiedWindows || null;
      record(s.id, { type: 'rate_limit', windows: s.rateLimit });
      break;
    case 'result':
      s.turns += 1;
      s.state = 'idle';
      s.currentTool = null;
      record(s.id, {
        type: 'result', subtype: j.subtype, num_turns: j.num_turns, duration_ms: j.duration_ms,
        cost_usd: j.total_cost_usd, denials: (j.permission_denials || []).map((p) => ({ tool: p.tool_name, input: p.tool_input })),
        text: String(j.result || '').slice(0, 2000),
      });
      break;
    default:
      break;
  }
  broadcast({ type: 'session-state', session: s.id, state: s.state, currentTool: s.currentTool, turns: s.turns, usage: s.usage, rateLimit: s.rateLimit, lastText: s.lastText });
}

function pickUsage(u) {
  return { in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens };
}
function trim(o) { const s = JSON.stringify(o); return s.length > 600 ? s.slice(0, 600) + '…' : s; }

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
function decide(sid, id, decision, why, scope = 'once') {
  const s = sessions.get(sid);
  if (!s) return false;
  const p = s.pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  s.pending.delete(id);
  if (scope === 'always') rules.set(p.key, decision === 'allow' ? 'log' : 'never');
  // One call can arrive down more than one hook — VS Code reads both
  // .claude/settings.local.json and .github/hooks/*.json, so a repo wired for
  // Claude Code and Copilot fires twice for the same tool_use_id. Everyone who
  // asked gets the same answer; answering only the last one left the first hook
  // hanging until the agent's own timeout, which looks like the agent freezing.
  for (const r of p.responders) r(decision, why);
  s.answered ||= new Map();
  s.answered.set(id, [decision, why]);
  record(sid, { type: 'decision', id, decision, why, scope, tool: p.tool, key: p.key, waitedMs: Date.now() - p.at });
  if (s.pending.size === 0 && s.state === 'waiting') s.state = 'working';
  broadcast({ type: 'session-state', session: sid, state: s.state });
  broadcast({ type: 'rules', rules: Object.fromEntries(rules) });
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function hookOk(res, extra = {}) { json(res, 200, extra); }
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
}

const realRoot = (() => { try { return fs.realpathSync(ROOT); } catch { return ROOT; } })();

const server = http.createServer(async (req, res) => {
  lastSeen = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const sidParam = url.searchParams.get('s');

  // ---- hooks from Claude Code (always answer 200 + JSON; anything else fails open) ----
  if (url.pathname.startsWith('/hooks/')) {
    let hook = {};
    try { hook = JSON.parse(await readBody(req) || '{}'); } catch { /* keep {} */ }
    const ev = url.pathname.slice('/hooks/'.length);
    const attach = url.searchParams.get('attach');
    // From the hook in Claude Code's user settings: a session started outside the
    // repo. With a repo it touched that repo; without one, it is ours only if an
    // earlier call already made it so, and otherwise gets no answer at all.
    const outside = url.searchParams.get('outside') === '1';
    const outsideRepo = outside ? url.searchParams.get('repo') : null;
    if (outside && !attach && !(hook.session_id && sessions.has(hook.session_id))) return hookOk(res);
    let sidResolved = sidParam;
    if (!sidResolved && (attach || outside) && hook.session_id) {
      sidResolved = hook.session_id;
      if (!sessions.has(sidResolved) && attach) {
        // Where the work is: the worktree it is sitting in, when that belongs to
        // the same repository, rather than the main checkout it was matched to.
        let where = outsideRepo || hook.cwd || process.cwd();
        if (outsideRepo && hook.cwd) {
          const top = toplevelOf(hook.cwd);
          if (top && repoIdOf(top) === repoIdOf(outsideRepo)) where = top;
        }
        const made = attachSession({ id: sidResolved, name: attach.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'repo', cwd: where });
        // Its prompt went by before anything said the session was ours. The
        // transcript still has it, and a record that starts mid-task without
        // saying what was asked is missing the part a reviewer reads first.
        if (outsideRepo) {
          made.outside = true;
          try { rememberOutside(sidResolved, outsideRepo); } catch { /* it is re-found by path next time */ }
          // Later calls from this session may not mention the repo, and arrive
          // without its settings; they keep the ones it was gated with.
          made.auto = url.searchParams.get('supervise') !== '1';
          const asked = promptFromTranscript(hook.transcript_path);
          if (asked) { made.lastPrompt = { text: asked, at: Date.now() }; record(sidResolved, { type: 'prompt', text: asked.slice(0, 4000) }); }
        }
      }
    }
    const s = sessions.get(sidResolved);
    const sid = sidResolved;

    if (ev === 'session-start') {
      if (s) {
        s.state = 'working';
        s.model = hook.model || modelFromTranscript(hook.transcript_path) || null;
        // Only claim a model once we actually know one. The transcript does not
        // exist yet on the very first event, and a placeholder here would be the
        // name the record ends up showing.
        if (s.model) record(sid, { type: 'init', model: s.model, claudeSession: hook.session_id, apiKeySource: 'attached' });
        broadcast({ type: 'session-state', session: sid, state: s.state });
      }
      return hookOk(res);
    }
    if (ev === 'prompt') {
      // The same prompt twice within a few seconds is one prompt heard by two hooks.
      const text = String(hook.prompt || '');
      const echo = s && s.lastPrompt && s.lastPrompt.text === text && Date.now() - s.lastPrompt.at < 5000;
      if (s && !echo) {
        trackBranch(s, hook, true);
        s.lastPrompt = { text, at: Date.now() }; s.state = 'working';
        record(sid, { type: 'prompt', text: text.slice(0, 4000) });
        broadcast({ type: 'session-state', session: sid, state: s.state });
      }
      return hookOk(res);
    }
    if (ev === 'session-end') {
      if (s && !s.ended) {
        s.ended = true;                       // SessionEnd can fire more than once
        s.state = 'exited';
        if (!s.model) s.model = modelFromTranscript(hook.transcript_path);
        record(sid, { type: 'session', subtype: 'exited', reason: hook.reason });
        if (s.model) record(sid, { type: 'init', model: s.model, claudeSession: hook.session_id, apiKeySource: 'attached' });
        broadcast({ type: 'session-state', session: sid, state: s.state });
        buildRecap(s, [], (e, href) => { if (e) record(sid, { type: 'recap_error', error: e.message }); else broadcast({ type: 'recap', session: sid, href }); });
      }
      return hookOk(res);
    }

    if (ev === 'pre-tool') {
      // Unattended: nobody is going to answer, so holding a call for two
      // minutes and then failing closed does not protect anything — it just
      // stalls the run and teaches people to turn the gate off. The never-rules
      // still bite, because those never needed a person. Everything that would
      // have been asked is done and written down instead.
      // Held for a person only when asked for outright. Sessions this server started
      // from the dashboard are supervised unless told otherwise; attached ones are
      // unattended unless their hook says supervise. A hook that says neither —
      // from a mismatched version, or none at all — runs unattended with the
      // never-rules intact, instead of freezing its session two minutes at a time.
      const supervise = url.searchParams.get('supervise') === '1';
      const unattended = sidParam
        ? url.searchParams.get('auto') === '1'
        : url.searchParams.get('auto') === '1' || !(supervise || (outside && s && s.auto === false));
      // A session working in a repo it was not started in is judged against that
      // repo, not against whatever folder it happens to be sitting in. Otherwise
      // deleting build output inside the repo reads as deleting someone else's files.
      if (s && s.outside && s.worktree) hook.repo_root = s.worktree;
      let { tier, reason } = classifyWith(hook, rules);
      if (unattended && tier === 'ask') { tier = 'log'; reason = 'allowed unattended — nobody was asked'; }
      const id = hook.tool_use_id || randomUUID();
      // Policy keys on the canonical name so a rule means the same thing in every
      // harness; the record shows the harness's own name so it stays truthful
      // about what actually ran.
      const shown = hook.tool_label || hook.tool_name;
      const respond = (decision, why) => hookOk(res, {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `nearly: ${why}` },
      });
      if (!s) return respond('deny', 'unknown session');
      // Already answered: the same call through a second hook — a repo's own and
      // the user-level one, or VS Code reading two config files. Same answer,
      // written down once.
      if (hook.tool_use_id && s.answered?.has(id)) return respond(...s.answered.get(id));
      const answer = (decision, why) => {
        if (hook.tool_use_id) {
          s.answered ||= new Map();
          s.answered.set(id, [decision, why]);
          if (s.answered.size > 500) s.answered.delete(s.answered.keys().next().value);
        }
        return respond(decision, why);
      };
      if (tier === 'never') { record(sid, { type: 'decision', id, decision: 'deny', why: reason, scope: 'policy', tool: shown, input: hook.tool_input, tier, unattended }); return answer('deny', `never (${reason})`); }
      if (tier === 'log') {
        record(sid, { type: 'decision', id, decision: 'allow', why: reason, scope: unattended ? 'auto' : 'policy', tool: shown, input: hook.tool_input, tier });
        return answer('allow', unattended ? reason : `do and log (${reason})`);
      }
      // ask: hold the response until the UI decides, or fail closed
      // A harness may say it will not wait as long as we would. It can shorten
      // the deadline, never lengthen it: the point of the cap is that nobody
      // else gets to decide by not answering.
      const asked = Number(url.searchParams.get('hold')) || 0;
      const holdMs = asked > 0 ? Math.min(asked, ASK_TIMEOUT_MS) : ASK_TIMEOUT_MS;
      // Same call, second hook: join the question already being asked rather
      // than replacing it, so the person is not asked twice about one thing.
      const already = s.pending.get(id);
      if (already) { already.responders.push(respond); return; }
      const item = { id, sid, tool: shown, input: hook.tool_input, tier, reason, key: ruleKey(hook), at: Date.now(), holdMs, responders: [respond] };
      item.timer = setTimeout(() => decide(sid, id, 'deny',
        `no human answer in ${Math.round(holdMs / 1000)}s; nearly fails closed`, 'timeout'), holdMs);
      s.pending.set(id, item);
      s.state = 'waiting';
      record(sid, { type: 'ask', ...pendingView(item) });
      broadcast({ type: 'session-state', session: sid, state: s.state });
      return; // response is sent by decide()
    }

    if (ev === 'post-tool') {
      const seen = s && hook.tool_use_id && s.posted?.has(hook.tool_use_id);
      if (s && hook.tool_use_id) { s.posted ||= new Set(); s.posted.add(hook.tool_use_id); if (s.posted.size > 500) s.posted.delete(s.posted.values().next().value); }
      if (s && !seen) record(sid, { type: 'post_tool', id: hook.tool_use_id, tool: hook.tool_label || hook.tool_name, duration_ms: hook.duration_ms, response: trim(hook.tool_response ?? '') });
      if (s && !seen) trackBranch(s, hook);
      if (s && !seen && s.attached && s.worktree) postWhenOpened(s, hook);
      return hookOk(res);
    }
    if (ev === 'stop') {
      // One turn ending, heard by two hooks, is still one turn.
      if (s && s.attached && s.lastStopAt && Date.now() - s.lastStopAt < 3000) return hookOk(res);
      if (s && s.attached) { s.lastStopAt = Date.now(); trackBranch(s, hook, true); }
      if (s && s.attached) {
        s.turns += 1;
        s.state = 'idle';
        s.lastText = String(hook.last_assistant_message || '').slice(0, 400);
        if (hook.last_assistant_message) record(sid, { type: 'text', text: String(hook.last_assistant_message).slice(0, 4000) });
        try {
          const d = turnDiff(s.worktree, s.base);
          const commits = s.base ? (git(s.worktree, ['log', '--oneline', `${s.base}..HEAD`]) || '').split('\n').filter(Boolean) : [];
          record(sid, { type: 'turn_diff', turn: s.turns, msg: `turn ${s.turns}: ${s.lastText.replace(/\s+/g, ' ').slice(0, 60)}`, commits, ...d });
        } catch (e) { record(sid, { type: 'checkpoint_error', error: String(e.message).slice(0, 300) }); }
        broadcast({ type: 'session-state', session: sid, state: s.state, turns: s.turns, lastText: s.lastText });
        return hookOk(res);
      }
      if (s) {
        // commit per turn so "undo" is a git revert
        try {
          git(s.worktree, ['add', '-A']);
          const msg = `turn ${s.turns + 1}: ${(hook.last_assistant_message || '').replace(/\s+/g, ' ').slice(0, 60)}`;
          git(s.worktree, ['-c', 'user.name=Nearly', '-c', 'user.email=nearly-cli@local', 'commit', '-qm', msg, '--allow-empty']);
          const sha = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
          record(sid, { type: 'checkpoint', sha, msg });
        } catch (e) { record(sid, { type: 'checkpoint_error', error: String(e.message).slice(0, 300) }); }
      }
      return hookOk(res);
    }
    if (s) record(sid, { type: 'hook', event: ev, detail: trim(hook) });
    return hookOk(res);
  }

  // ---- UI API ----
  // Cheap liveness check: the hook launcher calls this before every tool call.
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, sessions: sessions.size, version: VERSION, root: realRoot });
  }
  // Stand down so a newer build can take the port. Refused while anybody is
  // waiting on a decision: dropping a held request would hand it back to the
  // agent's own prompt, which is the one outcome this whole project exists to
  // avoid.
  if (req.method === 'POST' && url.pathname === '/exit') {
    const waiting = [...sessions.values()].reduce((n, s) => n + s.pending.size, 0);
    if (waiting) return json(res, 409, { ok: false, waiting });
    json(res, 200, { ok: true, version: VERSION });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(UI));
  }
  // Static: built records, the replay page, and a local preview of the docs/
  // folder GitHub Pages serves, so you can check it before pushing.
  //
  // Each of these has to be asked for by name rather than resolved against the
  // package. Records used to live in ui/records/ and moved to the user's own
  // directory when it turned out an upgrade was deleting them — but this route
  // kept serving out of the package, so from an npm install every record 404'd
  // while sitting perfectly well on disk. It only ever worked from a checkout,
  // which is the one place nobody would notice.
  if (req.method === 'GET' && (url.pathname.startsWith('/records/') || url.pathname === '/replay.html' || url.pathname === '/docs' || url.pathname.startsWith('/docs/'))) {
    const isDocs = url.pathname === '/docs' || url.pathname.startsWith('/docs/');
    const isRecord = url.pathname.startsWith('/records/');
    const base = isRecord ? paths.pages() : isDocs ? paths.docs() : path.join(ROOT, 'ui');
    const strip = isRecord ? '/records/' : isDocs ? '/docs' : '/';
    let rel = url.pathname.slice(strip.length).split('/').filter((p) => p && p !== '..').join('/');
    if (isDocs) rel = rel || 'index.html';
    const file = path.join(base, rel);
    if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [...sessions.values()].map(summary), repos: knownRepos(), rules: Object.fromEntries(rules), defaults: DEFAULT_TIER, askTimeoutMs: ASK_TIMEOUT_MS })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    return json(res, 200, { sessions: [...sessions.values()].map(summary), repos: knownRepos(), rules: Object.fromEntries(rules), defaults: DEFAULT_TIER, askTimeoutMs: ASK_TIMEOUT_MS });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/recordings/')) {
    const id = url.pathname.split('/')[2];
    const s = sessions.get(id);
    return json(res, 200, s ? s.events : []);
  }
  if (req.method === 'POST' && url.pathname === '/sessions') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.prompt) return json(res, 400, { error: 'prompt required' });
      const s = createSession({ name: b.name, prompt: b.prompt, repo: b.repo });
      return json(res, 200, summary(s));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/decide') {
    const b = JSON.parse(await readBody(req) || '{}');
    const ok = decide(b.session, b.id, b.decision === 'allow' ? 'allow' : 'deny', b.why || `human ${b.decision} (${b.scope || 'once'})`, b.scope || 'once');
    return json(res, ok ? 200 : 404, { ok });
  }
  if (req.method === 'POST' && url.pathname === '/message') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s || s.state === 'exited' || !s.proc) return json(res, 404, { error: 'no such live session (attached sessions take input in their own terminal)' });
    send(s, b.text);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s) return json(res, 404, { error: 'no such session' });
    for (const id of [...s.pending.keys()]) decide(s.id, id, 'deny', 'session stopped');
    if (!s.proc) { s.state = 'exited'; record(s.id, { type: 'session', subtype: 'detached' }); broadcast({ type: 'session-state', session: s.id, state: s.state }); return json(res, 200, { ok: true }); }
    if (b.hard) s.proc.kill('SIGTERM'); else s.proc.stdin.end();
    record(s.id, { type: 'session', subtype: b.hard ? 'killed' : 'stopping' });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/recap') {
    // Build a narrated recap page from this session's recording. Runs the
    // build script as a child so a slow `say` never blocks a hook response.
    const b = JSON.parse(await readBody(req) || '{}');
    const sid = String(b.session || '').replace(/[^0-9a-f-]/gi, '');
    const s = sessions.get(sid);
    if (!s && !(sid && fs.existsSync(path.join(RECORDINGS, `${sid}.jsonl`)))) return json(res, 404, { error: 'no such session or recording' });
    const extra = [];
    if (b.llm) extra.push('--llm');
    if (b.noAudio) extra.push('--no-audio');
    buildRecap(s || { id: sid }, extra, (e, href) => (e ? json(res, 500, { error: e.message }) : json(res, 200, { ok: true, href })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/post-recap') {
    // Deliberate, user-initiated: comments on the PR for the session's branch via `gh`.
    const b = JSON.parse(await readBody(req) || '{}');
    const sid = String(b.session || '').replace(/[^0-9a-f-]/gi, '');
    const args = [path.join(ROOT, 'scripts', 'post-recap.mjs'), sid];
    if (b.urlBase) args.push('--url-base', String(b.urlBase));
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? json(res, 200, { ok: true, url: out.trim() }) : json(res, 500, { error: err.trim() || `exit ${code}` })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/undo') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s) return json(res, 404, { error: 'no such session' });
    if (s.attached) return json(res, 400, { error: 'undo is not offered for attached sessions: it is your branch, use git' });
    try {
      const before = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
      git(s.worktree, ['reset', '--hard', 'HEAD~1']);
      const after = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
      record(s.id, { type: 'undo', from: before, to: after });
      return json(res, 200, { ok: true, from: before, to: after });
    } catch (e) { return json(res, 400, { error: String(e.message).slice(0, 300) }); }
  }
  json(res, 404, { error: 'not found' });
});

// Hooks start this on demand, so two tool calls arriving together can both try.
// The loser is not an error: the winner is already serving.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);
  console.error(`nearly: ${e.message}`);
  process.exit(1);
});

// Nothing to remember to shut down. A server with no sessions that nobody has
// asked anything of for half an hour has no reason to still be holding a port.
if (IDLE_EXIT_MS > 0) {
  const idle = setInterval(() => {
    if (sessions.size === 0 && Date.now() - lastSeen > IDLE_EXIT_MS) process.exit(0);
  }, 60_000);
  idle.unref();
}

server.listen(PORT, HOST, () => {
  console.log(`nearly  http://${HOST}:${PORT}`);
  console.log(`worktrees     ${WORKTREES}`);
  console.log(`recordings    ${RECORDINGS}`);
});

process.on('SIGINT', () => {
  for (const s of sessions.values()) { try { s.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  process.exit(0);
});
