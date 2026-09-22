// Build a narrated, shareable recap of one Nearly session.
//
//   node scripts/build-recap.mjs <session-id | latest> [--llm] [--no-audio] [--voice Samantha] [--avatar AP]
//
// Reads recordings/<id>.jsonl plus the per-turn commits in the agent's worktree
// (including commits that were undone, via the reflog), computes a storyboard,
// optionally asks Claude to rewrite the narration (facts stay computed), records
// narration with macOS `say`, and writes one self-contained HTML file to
// ui/records/<name>-<id4>.html. That file is the link you share.
//
// Principle: every number, diff and decision on screen is computed from the
// recording. The language model, when used, only rewrites the sentences.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { paths } from '../server/paths.mjs';
import { judge, judgeEnabled, RANK } from './judge.mjs';
import { repoIdOf } from '../server/repo-id.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recordingsDir = paths.recordings();
const templatePath = join(root, 'ui', 'recap.template.html');
const outDir = paths.pages();

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  if (dflt === false || dflt === true) return true;
  return argv[i + 1];
};
const wantLLM = flag('--llm', false);
const noAudio = flag('--no-audio', false);
const VOICE_ARG = flag('--voice', process.env.NEARLY_VOICE || null);
const RATE = Number(flag('--rate', process.env.NEARLY_RATE || 176));
const LIST_VOICES = flag('--voices', false);
// Read it yourself. Synthesis is a stand-in; a person reading their own words is
// the thing it stands in for, and it costs nothing but ten minutes.
const VOICE_DIR = flag('--voice-dir', process.env.NEARLY_VOICE_DIR || null);
const WRITE_SCRIPT = flag('--script', false);
const AVATAR = flag('--avatar', process.env.NEARLY_AVATAR || 'AP');
const AUTHOR = flag('--author', process.env.NEARLY_AUTHOR || 'Anuj');
// Who is this recap for? A reviewer opening someone else's pull request was not
// in the room, so "you" is the wrong pronoun for them: the supervisor is named
// instead. Pass --audience supervisor for the second-person version.
const AUDIENCE = flag('--audience', process.env.NEARLY_AUDIENCE || 'reviewer');
const forReviewer = AUDIENCE !== 'supervisor';
const SUP = forReviewer ? AUTHOR : 'You';
const sup = forReviewer ? AUTHOR : 'you';
const supPoss = forReviewer ? `${AUTHOR}'s` : 'your';
const V = (third, second) => (forReviewer ? third : second);
const BRANCH = flag('--branch', null);      // build one record for a whole branch
const REPO = flag('--repo', null);         // ...limited to sessions from this repo
const VALUE_FLAGS = new Set(['--voice', '--rate', '--avatar', '--author', '--branch', '--repo', '--audience']);
const target = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1])) || 'latest';

// ---------------------------------------------------------------------------
// load recording
// ---------------------------------------------------------------------------
function loadRecording(idOrLatest) {
  const files = readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl'));
  if (!files.length) throw new Error('no recordings in recordings/');
  let file;
  if (idOrLatest === 'latest') {
    file = files.map((f) => ({ f, m: statSync(join(recordingsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
  } else {
    file = files.find((f) => f.startsWith(idOrLatest));
    if (!file) throw new Error(`no recording starting with ${idOrLatest}`);
  }
  const { events, dropped } = parseRecording(join(recordingsDir, file));
  return { id: file.replace(/\.jsonl$/, ''), events, dropped };
}

// A recording is appended to as a session runs, so a crash, a full disk or a
// kill leaves a half-written last line. Dropping it silently would let the page
// report "1 action never happened" when three more were never written down, and
// a record that overstates its own completeness is worse than no record.
function parseRecording(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const events = [];
  let dropped = 0;
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { dropped += 1; }
  }
  return { events, dropped };
}

// A branch is what gets reviewed, not a session. One branch collects several
// sessions over days; this merges every recording made on it into one record,
// oldest first, so the reviewer opens a single link.
// Two paths can name the same directory and not match as strings. On macOS
// /var is a symlink to /private/var, so a repo under /tmp or /var is recorded
// with one spelling and asked for with the other, and every session silently
// belongs to nobody.
function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    let r;
    try { r = realpathSync.native(resolve(p)); } catch { r = resolve(p); }
    // Windows spells the same directory more than one way and means the same
    // place. Comparing those as strings loses every session on that machine,
    // the same way /var against /private/var did on this one.
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return real(a) === real(b);
}

// The part of one session that was spent on `branch`. A session that started on
// one branch and switched to another belongs to both, and each branch's record
// should show the work done on it — not the whole session twice, and not nothing.
// The instruction that led into a branch usually comes just before the switch, so
// it travels with the part it caused.
function sliceForBranch(events, created, branch) {
  let cur = created.branch;
  let prev = null;                       // the last thing that happened, of any kind
  const out = [];
  for (const e of events) {
    if (e === created) { out.push({ ...e, branch }); continue; }
    if (e.type === 'branch') {
      // An instruction with nothing done after it, immediately before a switch, is
      // the one that moved the session on: it belongs to where the work went.
      const mover = prev && prev.type === 'prompt' ? prev : null;
      if (cur === branch && e.branch !== branch && mover && out[out.length - 1] === mover) out.pop();
      if (e.branch === branch && cur !== branch && mover && !out.includes(mover)) out.push(mover);
      cur = e.branch;
      continue;
    }
    prev = e;
    if (cur === branch) out.push(e);
  }
  if (out.length < 2) return null;
  // Timed from the first thing done on this branch. A session that started five
  // days earlier on another branch made a one-minute branch read "ran for 128 hours".
  if (out[0].branch !== created.branch || out[0].at < out[1].at) out[0] = { ...out[0], at: out[1].at };
  return out;
}

// Recordings made before branch changes were noted still hold them — in the
// commands the agent ran. One real session made eight branches this way, each with
// `git checkout -q -b <name>`, and all its work was filed under the first. For those
// recordings only, read the switches back out of the allowed commands.
const SWITCH = /^(?:checkout|switch)$/;
function switchesIn(command) {
  const found = [];
  for (const part of String(command).split(/&&|\|\||;|\n/)) {
    const w = part.trim().split(/\s+/).filter(Boolean);
    const g = w.indexOf('git');
    if (g === -1 || !SWITCH.test(w[g + 1] || '')) continue;
    const rest = w.slice(g + 2);
    if (rest.includes('--') || rest.includes('--detach') || rest.includes('-d')) continue;   // files, or no branch
    const make = rest.findIndex((x) => /^-[bBcC]$/.test(x));
    const name = make !== -1 ? rest[make + 1] : rest.find((x) => !x.startsWith('-'));
    // A branch name, not a file, a commit, or a variable nobody can see.
    if (name && /^[A-Za-z0-9._\/-]+$/.test(name) && !/^[0-9a-f]{7,40}$/.test(name) && !/\.[a-z0-9]{1,5}$/i.test(name)) found.push(name);
  }
  return found;
}

function inferBranches(events, created) {
  if (events.some((e) => e.type === 'branch')) return events;
  const out = [];
  for (const e of events) {
    const switched = [];
    if (e.type === 'decision' && e.decision === 'allow' && typeof e.input?.command === 'string') {
      // A command that first moves into another repository is about that one.
      const cds = [...e.input.command.matchAll(/\bcd\s+("?)([^\s";&|]+)\1/g)].map((m) => m[2].replace(/^~(?=\/|$)/, process.env.HOME || ''));
      const mine = created.worktree ? (created.repoId || repoIdOf(created.worktree)) : null;
      const elsewhere = cds.length && mine && cds.some((d) => repoIdOf(resolve(created.worktree, d)) !== mine);
      if (!elsewhere) switched.push(...switchesIn(e.input.command));
    }
    // The switch takes effect at the command that made it: that command, and the
    // instruction that asked for it, belong to the branch it moved to.
    for (const b of switched) out.push({ type: 'branch', branch: b, worktree: created.worktree, at: e.at, inferred: true });
    out.push(e);
  }
  return out;
}

// Same repository, not same folder: a worktree and its main checkout share one.
// Recordings from before this carry no repo id, so fall back to asking git about
// the folder they name, and to the path itself when that folder is gone.
function sameRepoAs(created, want, wantId) {
  if (!want) return true;
  const theirs = created.repoId || (created.worktree ? repoIdOf(created.worktree) : null);
  if (wantId && theirs) return theirs === wantId;
  return !created.worktree || samePath(created.worktree, want);
}

function loadBranch(branch, repo) {
  const want = repo || null;
  const wantId = want ? repoIdOf(want) : null;
  const runs = [];
  for (const f of readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl'))) {
    const parsed = parseRecording(join(recordingsDir, f));
    const { dropped } = parsed;
    if (!parsed.events.length) continue;
    const c = parsed.events.find((e) => e.type === 'session' && e.subtype === 'created');
    if (!c) continue;
    const all = inferBranches(parsed.events, c);
    const onBranch = c.branch === branch || all.some((e) => e.type === 'branch' && e.branch === branch);
    if (!onBranch || !sameRepoAs(c, want, wantId)) continue;
    const events = sliceForBranch(all, c, branch);
    if (!events) continue;
    runs.push({ id: f.replace(/\.jsonl$/, ''), at: events[0].at, events, created: events[0], dropped });
  }
  if (!runs.length) throw new Error(`no recordings on branch "${branch}"${repo ? ` in ${repo}` : ''}`);
  runs.sort((a, b) => a.at - b.at);
  const events = [];
  runs.forEach((r, i) => {
    for (const e of r.events) events.push(i === 0 ? e : { ...e, _run: i });
  });
  const dropped = runs.reduce((n, r) => n + (r.dropped || 0), 0);
  return { id: runs[0].id, events, branch, runs: runs.length, repo: runs[0].created.worktree, dropped };
}

// ---------------------------------------------------------------------------
// git helpers (the worktree may have been undone; reflog keeps the commits)
// ---------------------------------------------------------------------------
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
function numstat(cwd, range) {
  const out = git(cwd, ['diff', '--numstat', range]);
  if (out == null) return null;
  return out.split('\n').filter(Boolean).map((l) => {
    const [add, del, file] = l.split('\t');
    return { file, add: add === '-' ? 0 : +add, del: del === '-' ? 0 : +del };
  });
}
function patch(cwd, range, maxLines = 48) {
  const out = git(cwd, ['diff', '--no-color', '--unified=2', range]);
  if (out == null) return null;
  const lines = out.split('\n');
  const kept = lines.slice(0, maxLines);
  return { text: kept.join('\n'), truncated: lines.length > maxLines, total: lines.length };
}

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------
const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const secs = (ms) => (ms / 1000).toFixed(1);
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
// "5221s" is a number nobody reads as an hour and a half.
const clock = (s) => {
  s = Math.round(s);
  if (s < 90) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${Math.round(s / 60)}m`;
};
const spoken = (s) => {
  s = Math.round(s);
  if (s < 90) return plural(s, 'second');
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${plural(h, 'hour')}${m ? ` ${plural(m, 'minute')}` : ''}` : plural(Math.round(s / 60), 'minute');
};
// Tools that only look. Anything else allowed without asking changed something,
// and calling it read-only told a reviewer that edits were only reads.
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite']);

function describeInput(tool, input = {}) {
  if (tool === 'Bash') return input.command || '';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'Read') return input.file_path || '';
  if (tool === 'WebFetch') return input.url || '';
  if (tool === 'Glob' || tool === 'Grep') return input.pattern || '';
  return JSON.stringify(input);
}
function verbFor(tool, input = {}) {
  const base = (p) => basename(String(p || ''));
  if (tool === 'Bash') return `run a command`;
  if (tool === 'Edit' || tool === 'MultiEdit') return `edit ${base(input.file_path)}`;
  if (tool === 'Write') return `write ${base(input.file_path)}`;
  if (tool === 'WebFetch') return `fetch a URL`;
  if (tool === 'Task') return `spawn a subagent`;
  return `use ${tool}`;
}
function blast(tool) {
  if (tool === 'Bash') return 'Runs a shell command inside this agent’s worktree. Reversible unless it touches the network or files outside it.';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'Changes a file in the worktree. Reversible with Undo (git).';
  if (tool === 'WebFetch') return 'Reads an external URL. Content it returns may try to instruct the agent.';
  if (tool === 'Task') return 'Spawns a subagent with its own tool calls, each gated here.';
  return 'Default tier for this tool is “ask”.';
}
function prettyInput(tool, input = {}) {
  if (tool === 'Bash') return input.command + (input.description ? `\n# ${input.description}` : '');
  if (tool === 'Edit') return `${input.file_path}\n--- old\n${input.old_string}\n+++ new\n${input.new_string}`;
  if (tool === 'Write') return `${input.file_path}\n${(input.content || '').slice(0, 600)}`;
  return JSON.stringify(input, null, 2);
}

// Where this page says it came from. Read it rather than hard-code it, so a
// fork's records point at the fork.
function projectUrl() {
  try {
    const u = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).homepage
           || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository?.url;
    return u ? String(u).replace(/\.git$/, '') : null;
  } catch { return null; }
}

function buildStoryboard({ id, events, runs: sbRuns = 1 }) {
  const created = events.find((e) => e.type === 'session' && e.subtype === 'created');
  const init = events.find((e) => e.type === 'init');
  const t0 = events[0].at;
  const tEnd = events.at(-1).at;
  const durS = (tEnd - t0) / 1000;
  const worktree = created?.worktree;
  const canGit = worktree && existsSync(worktree);

  // Launched sessions stream every tool_use; attached sessions only reach us through the gate, so count decisions there.
  const attached = !!created?.attached;
  const toolUses = attached ? events.filter((e) => e.type === 'decision') : events.filter((e) => e.type === 'tool_use');
  const asks = events.filter((e) => e.type === 'ask');
  const decisions = events.filter((e) => e.type === 'decision');
  const results = events.filter((e) => e.type === 'tool_result');
  const checkpoints = events.filter((e) => e.type === 'checkpoint' || e.type === 'turn_diff');
  const undos = events.filter((e) => e.type === 'undo');
  const finals = events.filter((e) => e.type === 'result');
  const texts = events.filter((e) => e.type === 'text');
  // A held call nobody answered is denied, but nobody decided it. Counting it as
  // a decision made the headline claim "7 decisions by Anuj" and the comment say
  // "refused by the supervisor" about calls no person ever looked at — the one
  // kind of claim a reviewer has no way to check. Recordings from before the
  // server marked timeouts are recognised by their reason.
  const timedOut = (d) => d.scope === 'timeout' || /no human answer/.test(d.why || '');
  const humanDecisions = decisions.filter((d) => d.waitedMs != null && !timedOut(d));
  const denied = decisions.filter((d) => d.decision === 'deny');
  const blocked = decisions.filter((d) => d.tier === 'never');
  // The wait still happened, answered or not.
  const humanWaitMs = decisions.filter((d) => d.waitedMs != null).reduce((n, d) => n + d.waitedMs, 0);
  const lastResult = finals.at(-1);

  const name = created?.name ?? id.slice(0, 8);
  const model = init?.model ?? 'claude';
  const date = new Date(t0);
  const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const scenes = [];

  // 1. cover ---------------------------------------------------------------
  // Refusals and undos first: they are the only facts a reviewer cannot get
  // from the diff, and the whole reason this page exists.
  const headlineBits = [];
  if (denied.length) headlineBits.push(`${plural(denied.length, 'action')} never happened`);
  if (undos.length) headlineBits.push(`${plural(undos.length, 'turn')} rolled back`);
  if (humanDecisions.length) headlineBits.push(plural(humanDecisions.length, 'decision') + V(` by ${AUTHOR}`, ' from you'));
  if (!denied.length && !undos.length && checkpoints.length) headlineBits.push(plural(checkpoints.length, 'turn') + (attached ? '' : ' committed'));

  // An unattended run is the one case where the absence of human decisions is
  // itself the fact. Leaving it implied reads as "nothing needed approving"
  // when what happened is that nobody was asked.
  const unattended = decisions.some((d) => d.scope === 'auto');
  // With nobody watching, "waiting on a human: 0.0s" and "asked Anuj: 0" are not
  // facts about the work, just columns about a supervisor who was not there.
  const nobodyThere = unattended && !humanDecisions.length && !humanWaitMs && !asks.length;
  scenes.push({
    kind: 'cover',
    title: headlineBits.length ? headlineBits.join(', ') : 'A session with nothing to flag',
    runs: sbRuns,
    unattended,
    orient: forReviewer
      ? (unattended
        ? `An agent wrote the branch you are about to review${sbRuns > 1 ? `, across ${plural(sbRuns, 'session')}` : ''}, with nobody watching it work. Nothing here was approved by a person — the rules did the stopping. This is the only account of what it did.`
        : `An agent wrote the branch you are about to review${sbRuns > 1 ? `, across ${plural(sbRuns, 'session')}` : ''}. This is what happened while it was writing it — including the things it was stopped from doing, which the diff cannot show you.`)
      : (unattended
        ? `Everything your agent did while you were not watching, including what the rules stopped it from doing.`
        : `Everything your agent did in this session, including what you stopped it from doing.`),
    repo: worktree ? basename(worktree) : null,
    branch: created?.branch || null,
    stats: [
      ['Ran for', clock(durS), ''],
      ...(nobodyThere ? [] : [[V('Waiting on a human', 'Waiting on you'), `${secs(humanWaitMs)}s`, 'ask']]),
      ['Tool calls', String(toolUses.length), ''],
      ...(nobodyThere ? [] : [[V('Asked ' + AUTHOR, 'Asked you'), String(humanDecisions.length), '']]),
      ['Refused', String(denied.length), denied.length ? 'deny' : ''],
      ['Rolled back', String(undos.length), undos.length ? 'undo' : ''],
    ],
    narration: `${sbRuns > 1 ? `${plural(sbRuns, 'agent session')} on this branch, ${spoken(durS)} in total` : `Agent ${name} ran for ${spoken(durS)}`}${nobodyThere ? ', with nobody watching' : ` under ${supPoss} supervision`}. ${plural(toolUses.length, 'tool call')}, ${nobodyThere ? '' : `${humanDecisions.length} held for a decision, `}${denied.length} refused${undos.length ? `, ${plural(undos.length, 'turn')} rolled back` : ''}.`,
  });

  // 2. intent. One scene per thing that was asked for, in order, so a branch
  //    record shows every instruction the branch was built from.
  const prompts = events.filter((e) => e.type === 'prompt');
  const task = created?.prompt ?? prompts[0]?.text ?? '';
  let askNo = 0;

  // 3. walk the run in order ----------------------------------------------
  let quiet = [];
  let turn = 0;
  const flushQuiet = () => {
    if (!quiet.length) return;
    const tools = [...new Set(quiet.map((q) => q.tool))];
    const onlyReads = quiet.every((q) => READS.has(q.tool));
    const byRule = quiet.every((q) => !q.auto);
    scenes.push({
      kind: 'quiet',
      onlyReads,
      items: quiet.map((q) => ({ tool: q.tool, sub: short(describeInput(q.tool, q.input), 80) })),
      narration: `${plural(quiet.length, onlyReads ? 'read-only step' : 'step')} ran without asking: ${tools.join(', ')}. ${onlyReads || byRule ? 'Logged, not gated.' : 'Nobody was watching, so nobody was asked; every one is logged.'}`,
    });
    quiet = [];
  };

  for (const e of events) {
    if (e.type === 'prompt') {
      flushQuiet();
      askNo += 1;
      scenes.push({
        kind: 'intent',
        text: e.text,
        ordinal: prompts.length > 1 ? askNo : null,
        of: prompts.length > 1 ? prompts.length : null,
        narration: prompts.length > 1
          ? `Instruction ${askNo} of ${prompts.length}, word for word: ${short(e.text, 130)}`
          : `The task ${V(`${AUTHOR} gave it`, 'you gave it')}, word for word: ${short(e.text, 150)}`,
      });
      continue;
    }
    if (e.type === 'decision') {
      const ask = asks.find((a) => a.id === e.id);
      const tool = e.tool;
      const input = ask?.input ?? e.input ?? {};
      const res = results.find((r) => r.id === e.id);
      if (e.tier === 'log') { quiet.push({ tool, input, auto: e.scope === 'auto' }); continue; }
      flushQuiet();
      const human = e.waitedMs != null;
      const w = human ? secs(e.waitedMs) : null;
      const fileTool = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit';
      const what = short(tool === 'Bash' ? describeInput(tool, input) : basename(describeInput(tool, input)), 70);
      const asked = fileTool ? `It asked to ${verbFor(tool, input)}` : `It asked to ${verbFor(tool, input)}: ${what}`;
      let narration;
      if (e.tier === 'never') {
        narration = `${asked.replace('It asked', 'It tried')}. A never rule blocked it before ${V('anyone', 'you')} saw it.`;
      } else if (timedOut(e)) {
        narration = `${asked}. Nobody answered in ${w} seconds, so it was refused rather than allowed. The agent carried on without it.`;
      } else if (e.decision === 'allow') {
        narration = `${asked}. ${SUP} allowed it${e.scope === 'always' ? ' as a rule' : ''} after ${w} seconds.`;
      } else {
        narration = `${asked}. ${SUP} said no after ${w} seconds${e.scope === 'always' ? ', now a never rule' : ''}. The agent saw the refusal as an error and carried on without it.`;
      }
      scenes.push({
        kind: 'decision',
        tool, key: e.key ?? ask?.key ?? tool, tier: e.tier ?? ask?.tier ?? 'ask',
        input: prettyInput(tool, input), blast: blast(tool),
        decision: e.decision, scope: e.scope, waitedS: w, why: e.why,
        resultPreview: res ? short(res.content, 140) : null, resultError: !!res?.is_error,
        narration,
      });
      continue;
    }
    if (e.type === 'checkpoint') {
      flushQuiet();
      turn += 1;
      const range = `${e.sha}~1..${e.sha}`;
      const stat = canGit ? numstat(worktree, range) : null;
      const p = canGit ? patch(worktree, range) : null;
      const add = (stat || []).reduce((n, s) => n + s.add, 0);
      const del = (stat || []).reduce((n, s) => n + s.del, 0);
      const files = (stat || []).length;
      scenes.push({
        kind: 'diff',
        turn, sha: e.sha, msg: e.msg, stat, patch: p,
        narration: stat
          ? (files
            ? `That round of work was saved as ${e.sha}: ${plural(files, 'file')}, ${add} ${add === 1 ? 'line' : 'lines'} added, ${del} removed. Each round is saved separately, so any one of them can be undone.`
            : `Turn ${turn} was committed as ${e.sha} with no file changes.`)
          : `Turn ${turn} was committed as ${e.sha}. The worktree is gone, so the diff is not available in this recap.`,
      });
      continue;
    }
    if (e.type === 'turn_diff') {
      flushQuiet();
      turn += 1;
      const stat = (e.stat || []).filter((x) => x.file !== '.claude/settings.local.json');
      const add = stat.reduce((n, x) => n + x.add, 0);
      const del = stat.reduce((n, x) => n + x.del, 0);
      scenes.push({
        kind: 'diff',
        turn, sha: null, msg: e.msg, stat, patch: e.patch,
        narration: stat.length
          ? `That round of work changed ${plural(stat.length, 'file')}: ${add} ${add === 1 ? 'line' : 'lines'} added, ${del} removed.`
          : `That round of work changed no files.`,
      });
      continue;
    }
    if (e.type === 'undo') {
      flushQuiet();
      const range = `${e.to}..${e.from}`;
      const stat = canGit ? numstat(worktree, range) : null;
      const p = canGit ? patch(worktree, range) : null;
      scenes.push({
        kind: 'undo',
        from: e.from, to: e.to, stat, patch: p,
        narration: `${SUP} undid that turn. The tree is back at ${e.to}. The change never reached the branch ${V('you are reviewing', 'you pushed')}, but the recording kept it.`,
      });
      continue;
    }
  }
  flushQuiet();

  // 4. outcome vs intent --------------------------------------------------
  const finalText = lastResult?.text || texts.at(-1)?.text || '';
  // What did not happen: every denied call, whether a person said no or a never rule did.
  const notDone = denied.map((d) => {
    const ask = asks.find((a) => a.id === d.id);
    const input = ask?.input ?? d.input ?? {};
    return { tool: d.tool, what: short(describeInput(d.tool, input), 90), by: d.tier === 'never' ? 'policy' : timedOut(d) ? 'timeout' : 'you' };
  });
  const head = canGit && !created?.attached ? git(worktree, ['rev-parse', '--short', 'HEAD']) : null;
  scenes.push({
    kind: 'outcome',
    task, report: finalText, notDone, head, turns: lastResult?.num_turns, cost: lastResult?.cost_usd,
    narration: (() => {
      let n = `The agent reported: ${short(finalText, 150)}`;
      if (!notDone.length) return n;
      const byHuman = notDone.filter((x) => x.by === 'you').length;
      const byPolicy = notDone.filter((x) => x.by === 'policy').length;
      const byTimeout = notDone.filter((x) => x.by === 'timeout').length;
      const parts = [];
      if (byHuman) parts.push(`${byHuman} ${byHuman === 1 ? 'was' : 'were'} refused by ${sup}`);
      if (byPolicy) parts.push(`${byPolicy} ${byPolicy === 1 ? 'was' : 'were'} blocked by policy before anyone saw ${byPolicy === 1 ? 'it' : 'them'}`);
      if (byTimeout) parts.push(`${byTimeout} ${byTimeout === 1 ? 'was' : 'were'} refused because nobody answered`);
      return `${n} Read that with a caveat: ${plural(notDone.length, 'requested step')} never ran. ${parts.join(', and ')}.`;
    })(),
  });

  // 5. credits ------------------------------------------------------------
  scenes.push({
    kind: 'credits',
    narration: `That is the whole story, including the parts the diff cannot show you. Every number came from the recording, not from a model.`,
    incompleteNote: true,
  });

  return {
    id, name, branch: created?.branch, runs: sbRuns, cwd: worktree || null, attached: !!created?.attached, model, date: dateStr, startedAt: t0, durationS: durS,
    humanWaitS: humanWaitMs / 1000, avatar: AVATAR, author: AUTHOR, audience: AUDIENCE, supervisor: AUTHOR, voice: noAudio ? null : VOICE,
    project: projectUrl(),
    generatedAt: new Date().toISOString(), scenes,
  };
}

// ---------------------------------------------------------------------------
// optional: let Claude rewrite the narration (facts stay fixed)
// ---------------------------------------------------------------------------
function polishWithClaude(sb) {
  const facts = sb.scenes.map((s, i) => ({ i, kind: s.kind, draft: s.narration, facts: factsFor(s) }));
  const schema = {
    type: 'object',
    properties: { narration: { type: 'array', items: { type: 'string' }, minItems: facts.length, maxItems: facts.length } },
    required: ['narration'],
  };
  const prompt = [
    `You are writing the voice-over for a ${facts.length}-scene recap of a coding agent session, for the person who supervised it.`,
    `Rewrite each draft as one or two plain sentences, at most 32 words, second person, present tense, no hype, no adjectives about quality.`,
    `Use only the facts given. Keep every number, file name, command and sha exactly. Do not add claims. Do not mention that you are a model.`,
    `Return the same number of strings in order.`,
    JSON.stringify(facts),
  ].join('\n');
  const r = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--json-schema', JSON.stringify(schema), prompt], { encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${short(r.stderr, 200)}`);
  const out = JSON.parse(r.stdout);
  if (out.is_error) throw new Error(short(out.result, 200));
  const parsed = out.structured_output ?? (typeof out.result === 'string' ? JSON.parse(out.result) : out.result);
  if (!Array.isArray(parsed?.narration) || parsed.narration.length !== facts.length) throw new Error('unexpected shape');
  sb.scenes.forEach((s, i) => { s.narrationDraft = s.narration; s.narration = String(parsed.narration[i]).trim(); });
  sb.polished = true;
}
function factsFor(s) {
  const { narration, patch, input, ...rest } = s;
  return rest;
}

// ---------------------------------------------------------------------------
// audio: macOS say -> aac, embedded as data URIs
//
// macOS ships three tiers of the same voice. The compact one is installed by
// default and is the robot everyone recognises; Enhanced and Premium are free
// downloads and sound dramatically better. Pick the best tier present, and say
// so when only the compact one is, because otherwise the page quietly ships the
// worst voice on the machine and nobody knows a better one was a click away.
// ---------------------------------------------------------------------------
const VOICE_PREFERENCE = ['Ava', 'Zoe', 'Evan', 'Joelle', 'Nathan', 'Samantha', 'Allison', 'Tom', 'Alex', 'Daniel'];

function installedVoices() {
  const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/);
    if (!m) return null;
    const name = m[1].trim();
    const tier = /\(Premium\)/.test(name) ? 'Premium' : /\(Enhanced\)/.test(name) ? 'Enhanced' : 'Compact';
    return { name, locale: m[2], tier, base: name.replace(/\s*\((Premium|Enhanced)\)\s*$/, '').replace(/\s*\(English \(.*\)\)$/, '') };
  }).filter(Boolean);
}

function pickVoice(requested) {
  const all = installedVoices();
  if (requested) {
    const exact = all.find((v) => v.name === requested);
    if (exact) return exact;
    // A bare name given for a voice whose better tier exists: upgrade it.
    const better = all.filter((v) => v.base === requested).sort(byTier)[0];
    if (better) return better;
    return { name: requested, tier: 'Compact', locale: '', base: requested };
  }
  const english = all.filter((v) => /^en_/.test(v.locale));
  const ranked = english
    .filter((v) => VOICE_PREFERENCE.includes(v.base))
    .sort((a, b) => byTier(a, b) || VOICE_PREFERENCE.indexOf(a.base) - VOICE_PREFERENCE.indexOf(b.base));
  return ranked[0] || { name: 'Samantha', tier: 'Compact', locale: 'en_US', base: 'Samantha' };
}
const TIER_RANK = { Premium: 0, Enhanced: 1, Compact: 2 };
const byTier = (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier];

if (LIST_VOICES) {
  if (process.platform !== 'darwin') {
    console.log(`No system voices: ${process.platform} has no say(1).`);
    console.log('Record your own instead: --script writes the lines, --voice-dir uses your recordings.');
    process.exit(0);
  }
  const all = installedVoices().filter((v) => /^en_/.test(v.locale));
  const by = { Premium: [], Enhanced: [], Compact: [] };
  for (const v of all) by[v.tier].push(v.name);
  for (const t of ['Premium', 'Enhanced', 'Compact']) {
    console.log(`${t} (${by[t].length})`);
    console.log(by[t].length ? '  ' + by[t].join(', ') : '  none installed');
  }
  console.log('');
  console.log('Enhanced and Premium are free downloads:');
  console.log('  System Settings → Accessibility → Spoken Content → System Voice → Manage Voices');
  console.log('Then: node scripts/build-recap.mjs latest --voice "Ava (Premium)"');
  process.exit(0);
}

const PICKED = pickVoice(VOICE_ARG);
const VOICE = PICKED.name;

// A line you recorded, if there is one. Numbered from 1 so the folder matches
// the script sheet you read from.
function recordedLine(dir, i) {
  if (!dir) return null;
  const n = String(i + 1).padStart(2, '0');
  for (const ext of ['m4a', 'wav', 'aiff', 'mp3', 'caf', 'aac']) {
    for (const stem of [n, String(i + 1)]) {
      const f = join(resolve(dir), `${stem}.${ext}`);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

// say(1) and afconvert are macOS. Everywhere else the record is still built,
// still correct and still readable; it just has captions instead of a voice.
const CAN_SPEAK = process.platform === 'darwin';

function narrate(sb) {
  if (!CAN_SPEAK) {
    console.log(`narration: skipped, ${process.platform} has no say(1). The record reads fine without it;`);
    console.log('  supply your own with --voice-dir, or use --no-audio to stop this notice.');
    return 0;
  }
  const tmp = join(tmpdir(), `recap-${sb.id.slice(0, 8)}`);
  mkdirSync(tmp, { recursive: true });
  let ok = 0, read = 0;
  sb.scenes.forEach((s, i) => {
    const aiff = join(tmp, `s${i}.aiff`);
    const m4a = join(tmp, `s${i}.m4a`);

    const mine = recordedLine(VOICE_DIR, i);
    if (mine) {
      const c = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '48000', mine, m4a], { encoding: 'utf8' });
      if (c.status === 0) {
        const info = spawnSync('afinfo', [m4a], { encoding: 'utf8' }).stdout || '';
        s.audio = `data:audio/mp4;base64,${readFileSync(m4a).toString('base64')}`;
        s.audioS = Number((info.match(/estimated duration:\s*([\d.]+)/) || [])[1]) || null;
        s.voiced = 'you';
        ok += 1; read += 1;
        return;
      }
      console.warn(`  could not convert ${mine}: ${short(c.stderr, 120)}`);
    }
    // A short pause after the opening sentence keeps it from sounding like a
    // list being read out. `say` takes [[slnc ms]] inline.
    const spoken = s.narration.replace(/\.\s+(?=[A-Z])/, '. [[slnc 260]] ');
    const a = spawnSync('say', ['-v', VOICE, '-r', String(RATE), '-o', aiff, spoken], { encoding: 'utf8' });
    if (a.status !== 0) { console.warn(`  say failed on scene ${i}: ${short(a.stderr, 120)}`); return; }
    const b = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', aiff, m4a], { encoding: 'utf8' });
    if (b.status !== 0) { console.warn(`  afconvert failed on scene ${i}: ${short(b.stderr, 120)}`); return; }
    const info = spawnSync('afinfo', [m4a], { encoding: 'utf8' }).stdout || '';
    const dur = Number((info.match(/estimated duration:\s*([\d.]+)/) || [])[1]) || null;
    s.audio = `data:audio/mp4;base64,${readFileSync(m4a).toString('base64')}`;
    s.audioS = dur;
    ok += 1;
  });
  rmSync(tmp, { recursive: true, force: true });
  sb.readAloud = read;
  return ok;
}

// The sheet you read from. One numbered line per scene, with the target length,
// so the recordings land close to the timings the page already computed.
function writeScript(sb, slug) {
  const lines = [
    `# ${slug} — narration script`,
    '',
    `${sb.scenes.length} lines. Record each one as its own file in a folder, named 01, 02, 03 and so on.`,
    'Any of m4a, wav, aiff, mp3 or caf. Voice Memos or QuickTime is fine; one take per line.',
    '',
    'Then build with:',
    '',
    '```bash',
    `node scripts/build-recap.mjs --branch ${sb.branch ?? '<branch>'} --repo <repo> --voice-dir <folder>`,
    '```',
    '',
    'Any line you have not recorded falls back to the system voice, so you can do them a few at a time.',
    '',
    '---',
    '',
  ];
  sb.scenes.forEach((s, i) => {
    const words = s.narration.split(/\s+/).length;
    lines.push(`### ${String(i + 1).padStart(2, '0')} · ${s.kind} · about ${Math.round(words / 2.6)}s`);
    lines.push('');
    lines.push(s.narration);
    lines.push('');
  });
  const p = join(root, 'records', `${slug}-script.md`);
  writeFileSync(p, lines.join('\n'));
  return p;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const rec = BRANCH ? loadBranch(BRANCH, REPO) : loadRecording(target);
const sb = buildStoryboard(rec);
sb.dropped = rec.dropped || 0;
if (sb.dropped) {
  console.warn(`WARNING: ${sb.dropped} unreadable line(s) in the recording.`);
  console.warn('  The record says so on the page: it cannot claim to be complete.');
}
// Named for the repository, not for whichever folder the first session ran in: a
// worktree's folder is called something like `task-1`, and the push looks for the
// record under the repo's name.
if (BRANCH) { sb.kind = 'branch'; sb.branch = BRANCH; sb.name = basename(REPO || rec.repo || '') || sb.name; }
else sb.kind = 'session';

if (wantLLM) {
  try { polishWithClaude(sb); console.log('narration rewritten by claude'); }
  catch (e) { console.warn(`claude polish skipped (${e.message}); using computed narration`); }
}

// scene duration: audio length + a beat, or a reading-speed estimate
for (const s of sb.scenes) {
  const words = s.narration.split(/\s+/).length;
  s.durS = Math.max(3.5, words / 2.6 + 1.2);
}
if (!noAudio) {
  const n = narrate(sb);
  const spoken = sb.scenes.length - (sb.readAloud || 0);
  console.log(sb.readAloud
    ? `narration: ${sb.readAloud} read by you, ${spoken} by ${VOICE} (${PICKED.tier})`
    : `narration: ${n}/${sb.scenes.length} scenes voiced by ${VOICE} (${PICKED.tier})`);
  if (PICKED.tier === 'Compact' && spoken > 0) {
    console.log('  This is the compact voice, the lowest quality macOS ships.');
    console.log('  Free upgrade: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices');
    console.log('  Then re-run. See every option with: node scripts/build-recap.mjs --voices');
  }
  for (const s of sb.scenes) if (s.audioS) s.durS = s.audioS + 0.8;
}
sb.totalS = sb.scenes.reduce((n, s) => n + s.durS, 0);

// A second opinion, if one was asked for: what each stopped command would have
// destroyed, and whether the work matches what was asked. Ordering and labels
// only — every number above is still counted from the recording.
if (judgeEnabled()) {
  try {
    const j = await judge(sb);
    // An answer that carried nothing usable is not a judgement. Saying the record
    // was judged when nothing came back would put a model's name on a page that
    // shows none of its work.
    if (j && (j.kinds.some(Boolean) || j.attention || j.drift.length)) {
      sb.judgement = { by: j.by, attention: j.attention, drift: j.drift, usage: j.usage };
      const outcome = sb.scenes.find((x) => x.kind === 'outcome');
      if (outcome) {
        outcome.notDone.forEach((n, i) => { if (j.kinds[i]) { n.kind = j.kinds[i].kind; n.kindConfidence = j.kinds[i].confidence; } });
        // Worst first. An agent deleting its own scratch file should never be the
        // line a reviewer reads before `rm -rf ~`.
        outcome.notDone.sort((x, y) => RANK.indexOf(x.kind ?? 'unclear') - RANK.indexOf(y.kind ?? 'unclear'));
      }
      console.log(`judged by ${j.by}${j.attention ? `: ${j.attention.says}` : ''}`);
    }
  } catch (e) { console.warn(`judgement skipped (${e.message})`); }
}

mkdirSync(outDir, { recursive: true });
const storyDirOut = paths.records();
mkdirSync(storyDirOut, { recursive: true });
const safe = (x) => String(x).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const slug = BRANCH ? `${safe(sb.name)}--${safe(BRANCH)}` : `${sb.name}-${sb.id.slice(0, 4)}`;
const jsonPath = join(storyDirOut, `${slug}.json`);
writeFileSync(jsonPath, JSON.stringify({ ...sb, scenes: sb.scenes.map(({ audio, ...s }) => s) }, null, 2));

// Everything in a record came from an agent, so everything is hostile until
// proven otherwise.
//
// This used to be `.replace('__RECAP__', json)`. With a string as the
// replacement, JavaScript reads `$&`, `$\``, `$'` in it as instructions — so a
// command containing `$\`` pasted the page's whole <head> into the record's
// data, broke out of the script block, and ran text from the agent's command as
// code in the reviewer's browser. Reproduced: the tab retitled itself. A
// function as the replacement is taken literally.
//
// And inside a <script>, escaping `</script>` is not enough: `<!--` and
// `<script` change how the HTML parser reads the block. Encoding every `<`, `>`
// and `&` as \u escapes leaves nothing for it to act on, and JSON.parse reads
// them back unchanged. U+2028/2029 are line terminators to older JavaScript.
const scriptSafe = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const htmlSafe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = readFileSync(templatePath, 'utf8')
  .replace('__RECAP__', () => scriptSafe(sb))
  .replaceAll('__TITLE__', () => htmlSafe(`${sb.name} · ${sb.scenes[0].title}`))
  .replaceAll('__DESC__', () => htmlSafe(`Recap of a Nearly session: ${sb.scenes[0].narration}`));
const outPath = join(outDir, `${slug}.html`);
writeFileSync(outPath, html);

if (WRITE_SCRIPT) console.log(`Script sheet: ${writeScript(sb, slug).replace(root + '/', '')}`);

console.log(`Built ui/records/${slug}.html — ${BRANCH ? `branch "${BRANCH}", ${sb.runs} session(s), ` : ''}${sb.scenes.length} scenes, ${sb.totalS.toFixed(0)}s, ${Math.round(html.length / 1024)} KB`);
for (const s of sb.scenes) console.log(`  ${s.kind.padEnd(9)} ${s.durS.toFixed(1)}s  ${short(s.narration, 90)}`);
