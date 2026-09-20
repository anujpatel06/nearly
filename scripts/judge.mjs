// A second opinion on a finished record, from TypeSafe's Jev.
//
// Nearly's own judgements are deterministic and stay that way: the policy decides
// what never runs, and every number in a record is counted from the recording.
// This adds the one thing counting cannot do — reading what a stopped command
// actually meant — and it adds it *after* the work, where being wrong costs
// nothing and being slow costs nothing.
//
// What it is asked:
//
//   · for each refusal, what kind of thing was stopped. A branch record that
//     opens with "2 actions never happened" is worth less than it should be when
//     the first one listed is an agent deleting its own scratch file and the
//     second is `rm -rf ~`. Code cannot tell those apart; that is the judgement.
//   · how much of a reviewer's attention this branch deserves, on one scale.
//   · whether each round of work matches the instruction that produced it. Nearly
//     is the only thing holding both halves, and drift between them is exactly
//     what a diff cannot show.
//
// Four rules, all of them consequences of what Nearly is:
//
//   1. Never on the path of a tool call. This runs at push time, once per record.
//   2. Off unless you turn it on. Commands and file paths would leave the machine,
//      and Nearly's whole pitch is a local gate. A key is the opt-in; there is no
//      default endpoint to leak to by accident.
//   3. It cannot change a decision. Everything here happened already. A judgement
//      orders and labels the record; it never allows or refuses anything.
//   4. It fails open and silent. No key, no network, a slow answer, a bad answer:
//      the record is exactly what it was before.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { paths } from '../server/paths.mjs';

const URL_BASE = (process.env.NEARLY_TYPESAFE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
const MODEL = process.env.NEARLY_TYPESAFE_MODEL || 'jev-latest';
// Generous for a push, nowhere near long enough to be noticed as a hang.
const TIMEOUT_MS = Number(process.env.NEARLY_TYPESAFE_TIMEOUT_MS || 8000);
// Caps, so a long branch cannot turn into a surprising bill.
const MAX_REFUSALS = 10;
const MAX_TURNS = 12;

function configKey() {
  try {
    const f = paths.config();
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')).typesafeKey || null;
  } catch { /* no config, or not readable */ }
  return null;
}

export const judgeKey = () => process.env.NEARLY_TYPESAFE_KEY || configKey();
export const judgeEnabled = () => process.env.NEARLY_NO_JUDGE !== '1' && !!judgeKey();

// The record is about someone's own machine. Nothing here needs their username to
// be read, so it does not travel.
export const scrub = (s) => String(s ?? '').split(homedir()).join('~');

// Asked once, answered forever: a branch is recorded again on every push, and the
// commands and instructions in it do not change between them.
function cacheFile() { return join(paths.records(), 'judgements.json'); }
function readCache() {
  try { return JSON.parse(readFileSync(cacheFile(), 'utf8')); } catch { return {}; }
}
function writeCache(c) {
  try { mkdirSync(dirname(cacheFile()), { recursive: true }); writeFileSync(cacheFile(), JSON.stringify(c, null, 2)); }
  catch { /* a cache that cannot be written is still a working feature */ }
}
const keyFor = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);

// One request, every question. They are evaluated in parallel and cannot see one
// another, so asking them together costs one round trip instead of several.
export async function ask(state, questions, { timeoutMs = TIMEOUT_MS } = {}) {
  const key = judgeKey();
  if (!key || !Object.keys(questions).length) return null;
  const body = { state, model: MODEL, questions };
  const cache = readCache();
  const id = keyFor(body);
  if (cache[id]) return cache[id];
  try {
    const res = await fetch(`${URL_BASE}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const out = await res.json();
    if (!out || typeof out !== 'object' || !out.answers) return null;
    cache[id] = { answers: out.answers, model: out.model, usage: out.usage, at: Date.now() };
    writeCache(cache);
    return cache[id];
  } catch { return null; }      // offline, slow, refused, malformed: no judgement
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

// Ordered worst first. The record leads with the row a reviewer would pick out.
export const KINDS = {
  user_data: 'Files a person owns and did not ask to lose: documents, home directory, another project, a database, a deployment',
  repo_source: 'Source files or history in the repository being worked on, including uncommitted work',
  shared_history: 'History other people already have: a force push, a branch deletion, a rewrite of a shared branch',
  secret_exposure: 'Reading, printing or sending credentials, keys or environment secrets',
  build_output: 'Generated output that a build remakes: node_modules, dist, coverage, caches',
  own_scratch: 'A temporary file or folder the agent itself created for this task, in a scratch or temp directory',
  unclear: 'Not enough in the command to tell',
};
export const RANK = ['user_data', 'shared_history', 'secret_exposure', 'repo_source', 'build_output', 'own_scratch', 'unclear'];

const ATTENTION = [
  'Routine. Ordinary edits, nothing stopped that mattered, the work matches what was asked.',
  'Worth a skim. Something was stopped, but only work the agent created for itself, or a small wander from the instruction.',
  'Read the record. An action against real files or history was stopped, or a round of work goes well beyond its instruction.',
  'Stop and talk to whoever ran it. Repeated attempts at destructive or irreversible actions, or work nobody asked for.',
];

const DRIFT = [
  'The changes are what the instruction asked for.',
  'The changes do what was asked and also something else that was not asked for.',
  'The changes have little to do with the instruction.',
];

// State and questions for one storyboard. Kept small on purpose: the commands, the
// instructions, and the file names — not the diffs, not the transcript.
export function questionsFor(sb) {
  const outcome = sb.scenes.find((s) => s.kind === 'outcome');
  const refusals = (outcome?.notDone || []).slice(0, MAX_REFUSALS);
  const intents = sb.scenes.filter((s) => s.kind === 'intent');
  const diffs = sb.scenes.filter((s) => s.kind === 'diff');
  const rounds = intents.slice(0, MAX_TURNS).map((intent, i) => ({
    instruction: scrub(intent.text),
    files: (diffs[i]?.stat || []).slice(0, 12).map((f) => f.file),
  })).filter((r) => r.files.length);

  const state = {
    repo: sb.name,
    branch: sb.branch || null,
    refusals: refusals.map((r) => ({ tool: r.tool, command: scrub(r.what), stopped_by: r.by })),
    rounds,
    counts: { tool_calls: outcome?.turns ?? null, refusals: (outcome?.notDone || []).length },
  };

  const questions = {};
  refusals.forEach((_, i) => {
    questions[`refusal_${i}`] = {
      type: 'choice',
      instructions: `What kind of thing would \`refusals[${i}].command\` have destroyed, changed or exposed if it had been allowed to run? Judge the command itself, not whether stopping it was right.`,
      criteria: KINDS,
    };
  });
  if (refusals.length) {
    questions.attention = {
      type: 'score',
      instructions: 'How much attention does this branch deserve from the person reviewing it, given what was stopped and how the work relates to the instructions?',
      criteria: ATTENTION,
    };
  }
  rounds.forEach((_, i) => {
    questions[`drift_${i}`] = {
      type: 'score',
      instructions: `Compare \`rounds[${i}].instruction\` with the files changed in that round, \`rounds[${i}].files\`. How well do the changes match what was asked for?`,
      criteria: DRIFT,
    };
  });
  return { state, questions, refusals, rounds };
}

// Read the answers back onto the record. Anything missing is simply not there:
// a judgement is an addition to a record that already stands on its own.
export async function judge(sb) {
  if (!judgeEnabled()) return null;
  const { state, questions, refusals, rounds } = questionsFor(sb);
  if (!Object.keys(questions).length) return null;
  const out = await ask(state, questions);
  if (!out) return null;
  const a = out.answers || {};

  const kinds = refusals.map((r, i) => {
    const ans = a[`refusal_${i}`];
    if (!ans || typeof ans.choice !== 'string' || !(ans.choice in KINDS)) return null;
    return { kind: ans.choice, confidence: ans.confidence ?? null };
  });
  const drift = rounds.map((r, i) => {
    const ans = a[`drift_${i}`];
    if (!ans || typeof ans.score !== 'number') return null;
    return { instruction: r.instruction, score: ans.score, confidence: ans.confidence ?? null };
  });
  const att = a.attention && typeof a.attention.score === 'number'
    ? { score: a.attention.score, confidence: a.attention.confidence ?? null, says: ATTENTION[Math.round(a.attention.score)] || null }
    : null;

  return {
    by: out.model || MODEL,
    at: out.at || Date.now(),
    kinds,
    attention: att,
    // Only the rounds that actually wandered are worth a reviewer's time.
    drift: drift.map((d, i) => (d && d.score >= 1 ? { ...d, round: i + 1 } : null)).filter(Boolean),
    usage: out.usage || null,
  };
}
