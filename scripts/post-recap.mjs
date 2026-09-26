// Post a session's recap to the pull request for its branch, as a comment.
//
//   node scripts/post-recap.mjs <session-id | latest> [--url-base https://you.github.io/nearly/recaps] [--dry-run]
//
// Uses the GitHub CLI (`gh pr comment`) in the repo the session ran in, so it
// works with whatever account gh is logged in as. Nothing is uploaded: the
// comment carries the computed summary and every narration line as text, plus
// a link to the record page when --url-base (or NEARLY_URL_BASE) says where the
// ui/records folder is hosted. Without a base URL the comment says where the
// file lives locally. --dry-run prints the comment and posts nothing.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { paths } from '../server/paths.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const ubIdx = argv.indexOf('--url-base');
const urlBase = (ubIdx !== -1 ? argv[ubIdx + 1] : process.env.NEARLY_URL_BASE || '').replace(/\/$/, '');
const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--url-base') || 'latest';

const dir = paths.records();
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
if (!files.length) { console.error('no storyboards in records/. Run build-recap first.'); process.exit(1); }
let file;
if (target === 'latest') {
  file = files.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
} else {
  file = files.find((f) => f === `${target}.json`)                                  // exact slug, e.g. repo--branch
      || files.find((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).id.startsWith(target))  // session id
      || files.find((f) => f.includes(target));                                     // loose match, last resort
}
if (!file) { console.error(`no storyboard for ${target}`); process.exit(1); }

const sb = JSON.parse(readFileSync(join(dir, file), 'utf8'));
const slug = file.replace(/\.json$/, '');
const cover = sb.scenes.find((s) => s.kind === 'cover');
const outcome = sb.scenes.find((s) => s.kind === 'outcome');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
// When this was true. The comment is rewritten on every push, so on a branch that
// has moved on — or one whose pull request is already merged — a reader needs to
// know the numbers are from a moment, not from now.
const asOf = (() => {
  const t = sb.lastEventAt || sb.startedAt;
  if (!t) return null;
  const d = new Date(t);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
})();

// Plain words for the labels a judgement puts on a refusal.
const WOULD_HAVE = {
  user_data: "someone's own files",
  repo_source: 'source or uncommitted work in this repo',
  shared_history: 'history other people already have',
  secret_exposure: 'credentials or secrets',
  build_output: 'build output',
  own_scratch: "the agent's own scratch files",
  unclear: 'something the command does not make clear',
};

const lines = [];
lines.push(sb.runs > 1
  ? `### Session record for \`${sb.branch}\`: ${cover.title}`
  : `### Session record: ${cover.title}`);
lines.push('');
lines.push(urlBase
  ? `**[Watch the record (${mmss(sb.totalS)})](${urlBase}/${slug}.html)** · ${sb.runs > 1 ? `${sb.runs} agent sessions` : `agent \`${sb.name}\``} · ${sb.model} · ${sb.date}`
  // No host configured. Everything a reviewer needs to act on is in this
  // comment already — what was refused, and what the diff therefore cannot show
  // them. Only the player is missing, so say where it is honestly rather than
  // naming a path from the developer's own checkout that means nothing to
  // anybody who installed this.
  : `${sb.runs > 1 ? `${sb.runs} agent sessions` : `Agent \`${sb.name}\``} · ${sb.model} · ${sb.date} · ${mmss(sb.totalS)} recording, kept on the author's machine`);
lines.push('');
if (outcome?.notDone?.length) {
  lines.push(`> **${outcome.notDone.length} thing${outcome.notDone.length > 1 ? 's' : ''} the agent wanted to do did not happen.** The diff cannot show you this.`);
  lines.push('>');
  for (const n of outcome.notDone) {
    const by = n.by === 'policy' ? 'blocked by policy' : n.by === 'timeout' ? 'nobody answered, so it was refused' : 'refused by the supervisor';
    // What it would have destroyed, when a judgement was asked for. Worst first,
    // because a scratch file and a home directory are not the same news.
    lines.push(`> - \`${n.tool}\` · \`${n.what}\` — ${by}${n.kind ? ` · would have hit **${WOULD_HAVE[n.kind] || n.kind}**` : ''}`);
  }
  lines.push('');
}
if (sb.judgement?.attention) lines.push(`> **Worth a reviewer's time:** ${sb.judgement.attention.says}`, '');
if (sb.judgement?.drift?.length) {
  lines.push(`> **${sb.judgement.drift.length} round${sb.judgement.drift.length > 1 ? 's' : ''} of work went past what was asked for:**`);
  lines.push('>');
  for (const d of sb.judgement.drift) lines.push(`> - round ${d.round}, asked for: \`${d.instruction.replace(/`/g, "'").slice(0, 120)}\``);
  lines.push('');
}
lines.push('| ' + cover.stats.map(([k]) => k).join(' | ') + ' |');
lines.push('|' + cover.stats.map(() => '---').join('|') + '|');
lines.push('| ' + cover.stats.map(([, v]) => v).join(' | ') + ' |');
lines.push('');
lines.push('<details><summary>Scene by scene</summary>');
lines.push('');
sb.scenes.forEach((s, i) => { lines.push(`${i + 1}. **${s.kind}** — ${s.narration}`); });
lines.push('');
lines.push('</details>');
lines.push('');
lines.push(`<sub>${asOf ? `The session this describes ended ${asOf}; a later push updates this comment. ` : ''}Every number above was computed from the session recording. ${sb.polished ? 'Sentences were rewritten by a model; facts were not.' : 'No model wrote any of it.'}${sb.judgement ? ` What each stopped command would have hit, the ordering, and the two notes above are judgements from ${sb.judgement.by}, not counts.` : ''}${urlBase ? '' : ' The narrated version is not published anywhere; `nearly publish` puts it on GitHub Pages.'}</sub>`);
// A hidden marker so we can find our own comment again on the next push and
// edit it, instead of stacking a new one on every push until nobody reads any.
// Deliberately carries no product name. This string is how a comment is
// recognised as ours on every future push, so renaming the project must not
// orphan every comment already posted. LEGACY covers ones posted before this.
const MARKER = '<!-- x-session-record -->';
const LEGACY = ['<!-- nearly:session-record -->', '<!-- control-room:session-record -->'];
const body = `${MARKER}\n${lines.join('\n')}`;

if (dry) { console.log(body); process.exit(0); }

const cwd = sb.cwd;
if (!cwd) { console.error('storyboard has no repo path; cannot find the pull request'); process.exit(1); }

const gh = (args, opts = {}) => spawnSync('gh', args, { cwd, encoding: 'utf8', ...opts });

// Which pull request, and in which repository.
//
// Ask for the record's own branch rather than whatever happens to be checked
// out. You should be able to hand over a branch's record from anywhere in the
// repo, and days after you moved on from it.
const view = gh(['pr', 'view', ...(sb.branch ? [sb.branch] : []), '--json', 'number,url']);
if (view.status !== 0) {
  console.error(`no open pull request for ${sb.branch ? `"${sb.branch}"` : 'this branch'} in ${cwd}`);
  console.error((view.stderr || view.stdout || '').trim().split('\n')[0]);
  process.exit(1);
}
const { number, url: prUrl } = JSON.parse(view.stdout);
const repoView = gh(['repo', 'view', '--json', 'nameWithOwner']);
const nwo = JSON.parse(repoView.stdout || '{}').nameWithOwner;
if (!nwo) { console.error('could not identify the repository'); process.exit(1); }

const tmp = join(tmpdir(), `recap-comment-${slug}.md`);
writeFileSync(tmp, body);

// Already posted one? Edit it. A branch gets pushed many times, and the reviewer
// should see the current state, not a stack of stale records.
const anyMarker = [MARKER, ...LEGACY].map((m) => `(.body | contains("${m}"))`).join(' or ');
const mine = gh(['api', `repos/${nwo}/issues/${number}/comments`, '--paginate',
                 '--jq', `[.[] | select(${anyMarker}) | .id] | first`]);
const existing = (mine.stdout || '').trim();

let r;
if (existing && existing !== 'null') {
  r = gh(['api', '-X', 'PATCH', `repos/${nwo}/issues/comments/${existing}`,
          '-F', `body=@${tmp}`, '--jq', '.html_url']);
  if (r.status === 0) console.log(`updated ${(r.stdout || '').trim() || prUrl}`);
} else {
  r = gh(['pr', 'comment', String(number), '--body-file', tmp]);
  if (r.status === 0) console.log(`posted ${(r.stdout || '').trim() || prUrl}`);
}
if (r.status !== 0) {
  console.error(`could not ${existing && existing !== 'null' ? 'update' : 'post'} the comment: ${(r.stderr || r.stdout).trim()}`);
  process.exit(1);
}
