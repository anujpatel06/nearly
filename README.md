# Nearly

**A pull request tells you what changed. This tells you what nearly happened.**

When a coding agent writes a branch, the person reviewing it has no idea what the agent tried, what a human refused, or what got rolled back. The diff is the only thing that survives, and the diff is the one artifact that cannot show you any of it.

Nearly holds an agent's risky actions until a human decides, records every one of those decisions, and turns the branch into a short narrated page written for **the reviewer**. That page is a link, and it goes on the pull request.

```
you work normally  →  agent acts  →  risky action held  →  you decide
                                                              ↓
   reviewer opens the PR  ←  comment posted  ←  you push  ←  recorded
```

## Look before you install anything

Nothing to run. This is a real record from two real agent sessions on one branch:

**[A branch where three things never happened →](https://anujpatel06.github.io/nearly/records/priya-app--feat-third-task.html)**

Watch the first thirty seconds. The cover says what the diff cannot: an action the supervisor refused, a push policy blocked, and a file deletion refused. [Here is how it looks on the pull request.](https://github.com/anujpatel06/tempo-demo/pull/2)

## What it needs

Node 18 or newer, git, and one of the seven coding agents below signed in.
Posting the record to a pull request also needs the [GitHub CLI](https://cli.github.com)
signed in (`gh auth login`); everything else works without it. If nothing is
showing up, `nearly doctor` walks the whole chain — gate, recording, record,
pull request, link — and names what is in the way. No dependencies and no API key of its own: agents run on whatever subscription you already have.

### Platforms

The suite runs on every push against macOS, Linux and Windows, on Node 18 and 22.

| | macOS | Linux | Windows |
|---|---|---|---|
| Gate, recording, records | tested in CI | tested in CI | tested in CI |
| Turning it on and off | tested in CI | tested in CI | tested in CI |
| Updating itself | tested in CI | tested in CI | tested in CI |
| Driving a real agent end to end | **run by hand** | not yet | not yet |
| Handing the record over at `git push` | **run by hand** | not yet | not yet |
| Spoken narration | yes | no | no |

Narration uses the built-in `say`, so it is macOS only. Everywhere else the
record is built identically and reads from its captions, or you can record the
lines yourself with `--voice-dir`.

The bottom two rows are the honest gap: CI proves the pieces work on all three,
but a whole session with a real agent, and a real push through the hook, have
only been done on macOS. If you are the first to try either on Windows or Linux,
an issue with what broke would be genuinely useful.

### Agents

The editor is not the question. Claude Code in VS Code, in a JetBrains IDE, in a
plain terminal or over SSH all read the same `.claude/settings.local.json`, so
all four are already covered. Neither is the model — the gate sits between the
agent and your machine, below whichever model is answering.

The harness making the tool calls is the question, because that is what exposes
the hook. Seven are supported:

| | Config it writes | Holds for a human | Record |
|---|---|---|---|
| Claude Code | `.claude/settings.local.json` | yes | full |
| Cursor | `.cursor/hooks.json` | yes | full |
| Antigravity | `.agents/hooks.json` | yes | full |
| GitHub Copilot (CLI **and VS Code agent mode**) | `.github/hooks/nearly.json` | yes | full |
| Gemini CLI | `.gemini/settings.json` | yes | full |
| Codex CLI | `.codex/hooks.json` | yes | no prompts, one turn |
| Windsurf | `.windsurf/hooks.json` | until Cascade gives up | shell and file tools only |

VS Code agent mode loads every `.json` in `.github/hooks/` with no further
setup, so `nearly --agent=copilot` is the whole of it there — and it is the only
route for someone on Windows who does not have Claude Code, since Cline's hooks
are macOS and Linux only and Windsurf's cannot be given a deadline.

`nearly` turns on whichever of these the repo shows signs of, and Claude Code
either way. `nearly --agent=cursor` forces one, `--agent=all` forces all of them,
and `nearly agents` prints what is actually wired here.

**One of these rows is not like the others.** Claude Code has been run end to end
against a live agent. The other six are built from each vendor's published hook
documentation and tested against payloads copied from it — every adapter has to
refuse `rm -rf` and have that refusal land in words its harness acts on, or the
suite fails. That is a good bet. It is not the same as having watched it work,
and `nearly agents` says so in as many words:

```
  Run against a live agent: Claude Code
  Built to the vendor's published hook spec and tested against payloads
  copied from it, but never yet run against the real thing:
    Cursor, Antigravity, GitHub Copilot CLI, Codex CLI, Gemini CLI, Windsurf
```

If you use one of those six, the most useful thing you can do is try it and open
an issue saying what broke.

#### What the adapters actually do

The server speaks one dialect. Everything downstream of a hook — the consent
gradient, the recording, the record page, the PR comment — reads Claude Code's
shape and nothing else. An adapter is a translation at the edge, about thirty
lines: their payload in, ours out; our answer in, theirs out.

Two decisions make that small enough to trust. Nearly never asks the harness to
ask — every one of them can prompt, and we want none of it, because their dialog
is not the record. We hold the hook open and answer once a human has. And tools
are matched by shape as well as by name: `run_command`, `shell`,
`run_terminal_cmd` and `bash` are all Bash, and anything carrying a command
string is treated as Bash even if nobody here has heard of it — because if it
isn't, the never-rules don't apply to it and `rm -rf` walks through a gate that
reports itself as working. Anything still unrecognised falls to `ask`.

The harness's own name for the tool travels with the call, so the record says
`run_command` where Antigravity said `run_command`, while the rule you set
applies to every one of them.

#### Not supported

Zed's built-in agent, Aider, Kilo Code, Warp and the hosted builders (Replit,
Lovable, Bolt, v0) expose no blocking pre-tool hook. There is nothing to attach
to, and no adapter can change that.

**Cline** has one, and it is macOS and Linux only — so on Windows there is
nothing to attach to there either. Cline does keep its own consent trail in
`ui_messages.json` under its task history, which Nearly could read after the
fact; that would be a reader rather than a gate, and it does not exist yet.

## Use it on your own repo

One command, in the repo you want recorded.

```bash
npx nearly-cli
```

> **`npx` not recognised?** It comes with Node.js, so that error means Node is
> not installed. Get it from [nodejs.org](https://nodejs.org) or, on Windows,
> `winget install OpenJS.NodeJS.LTS`. Then **open a new terminal** so it picks up
> the change, and check with `node --version`. You also need Claude Code signed
> in: Nearly gates Claude Code sessions and does nothing without one.

```
✓ Nearly is on for my-app

  · Claude Code sessions here are gated and recorded (run end to end against a live agent)
  · Cursor sessions here are gated and recorded (built to their published hook spec, not yet run against a live agent)
  · Claude Code sessions opened in another folder are gated too, once they work in this repo
  · restart any Claude Code or Cursor session already open — hooks are read when a session starts
  · upgrades reach this repo automatically
  · the record is added to #12 on your next push — sessions from now on

  Now just work. Requests that need you appear at http://127.0.0.1:47653
  Nothing to leave running. Turn it off again with --off.
```

That installs Nearly, turns it on for this repo, and works out where records go.
Nothing to configure, no server to start, and `nearly off` removes all of it.

Run it again in any other repo you want recorded. After the first time the
command is just `nearly`.

Three things that are easy to miss, and that the command now says out loud:

- **Only sessions from now on.** A session already open keeps the hooks it
  started with, which here means none. Restart it.
- **The record reaches a pull request on a push.** Turning Nearly on for a branch
  whose pull request already exists changes nothing on that pull request until
  you push again. If that pull request is already merged, open a new one.
- **Sessions opened somewhere else are covered.** Claude Code only reads a repo's
  hooks for a session started in that repo, so a session opened one folder up —
  a parent folder, a monorepo root, your home directory — used to edit the repo
  with nothing gated and nothing recorded, while `nearly doctor` said all was
  well. `nearly` now also adds one hook to Claude Code's user settings
  (`~/.claude/settings.json`). It stays silent unless a call works in a repo
  Nearly is on for; from then on that session is gated like one started there,
  including calls that never mention the repo. Sessions that have nothing to do
  with it pay a process start per tool call and never reach a server. It is
  removed when you turn Nearly off for the last repo, and `nearly --local-only`
  skips it.

**If anything ever goes wrong, `nearly pause`.** It stops Nearly gating and
recording in every session at once, including ones already open, and `nearly
resume` turns it back on. It exists because 0.1.18–0.1.20 could freeze every
Claude Code session on a machine: turning Nearly on wrote the user-level hook and
pointed it at an older installed copy, which misread it and held every tool call
for two minutes before refusing it. If you ran one of those versions, run
`npx nearly-cli@latest` in your repo again; `nearly doctor` says whether your
user-level hook is the broken form. Four things now stop it happening again:

- Nearly upgrades its installed copy before pointing any hook at it, and never
  points a hook at a copy older than itself.
- The user-level hook runs a file only this version and later have. An older copy
  has no such file, so the hook errors, and Claude Code treats that as no objection.
- A hook given a flag it does not know, or no repo name, answers nothing.
- A call is only held for a person when the hook says `--supervise` outright.
  Anything missing or mismatched runs unattended, with the never-rules still on.

### Where it installs

`npx nearly-cli` installs a copy into `~/.nearly/runtime`, and the hooks call
that copy directly. Not `npm install -g`, which it used to use and which failed
silently in three ordinary situations: on any up-to-date Windows machine, where
Node will not start `npm.cmd` without a shell; on a Mac whose Node came from the
official installer, where the global folder belongs to root; and whenever npx
itself was running it, because npx passes its own settings down to the npm it
starts. Each failure fell back to a pinned `npx -y nearly-cli@<version>` in every
hook — slower on every tool call, and stuck on that release for good. A folder
you always own avoids all three, and if the install still fails, `nearly` now
prints npm's actual reason instead of a pointer to a log file.

### Upgrading

It updates itself. When you run a command and a newer version exists, Nearly
installs it and tells you it did, then every repo you turned it on for is on the
new version with nothing to turn on again.

Four rules keep that from being something you regret installing:

- **Never in the hook path.** Nothing about updating may sit in front of an
  action an agent is waiting on. Only commands you typed can trigger it, and
  there is a test asserting the hook file does not even import the updater.
- **Never across a major version.** Nearly decides whether `rm -rf` runs. Same
  major means same promises; a major bump is announced and left for you to read
  before you trust it.
- **Never silent.** An update that happened without being mentioned is
  indistinguishable from a compromise, so it always says what it did.
- **Never fatal.** No network, a locked folder, a slow registry: you
  keep the version you have, the command you ran still works, and it tells you
  rather than leaving you to assume you are current.

It checks once a day, not on every command. `NEARLY_NO_UPDATE=1` turns it off
for good. Running through `npx` or from a checkout, it tells you instead of
touching anything, because an npx run is ephemeral and a checkout is yours.

**There is no server to start.** The hooks start it the first time they need it, in about a second, and it stays up. If it cannot start, Claude Code falls back to its own permission prompts and your session continues. Nothing to remember and nothing to break.

## Then work normally

Nothing about how you work changes. Open the repo in VS Code or a terminal, start Claude Code, give it a task.

1. **Reads run silently.** Anything that only looks at your code is allowed and logged.
2. **Anything that changes or reaches out is held.** It appears at http://127.0.0.1:47653 with the command, what it can affect, and a countdown. Answer with `A` or `D`, or shift for always and never. Nobody answering means denied after two minutes.
3. **The record builds itself** when the session ends.
4. **At `git push`** the hook merges every session on that branch, prints what was refused, and posts it to the branch's open pull request. When the agent opens the pull request itself, the record is posted right then.
5. **Your reviewer opens the pull request** and the record is there, as one comment that updates on every push rather than a new one each time.

### For a team

`.claude/settings.local.json` is per-person and stays out of git, which is right while you are trying it. To turn it on for everyone, move the same hooks into `.claude/settings.json` and commit that file. The hooks invoke `nearly` by name, so a teammate who clones the repo runs `npx nearly-cli` once and is set up.

## Why the gate is not the point

Gating agent tool calls is a solved problem and several teams do it better:

- **[Prempti](https://prempti.falco.org/)** (Falco, CNCF, Apache 2.0) runs a real rule engine over every tool call, with policies in ordinary Falco YAML and a monitor mode for tuning them. Its homepage promises "a story of the session, not just the diff" — then ships that story as a local log file with no viewer.
- **[Agent Approve](https://www.agentapprove.com/)** puts each approval on your Apple Watch across twelve different agents, and parses chained shell commands so a dangerous one cannot hide behind a safe one. When the session ends it leaves no artifact at all.
- **[Endor Labs](https://www.endorlabs.com/)** streams every action into a searchable audit trail for enterprise security teams, and can rewrite a command before it runs. What it posts on your pull request is security findings about the code, never the story of the session.
- Claude Code, Cursor, Antigravity, Warp, Devin and Goose all ship their own allow/deny/ask lists, and Anthropic's **auto mode** now lets a classifier decide, on the evidence that users approve 93% of the prompts they see.

All of them capture the moment a human refuses something. None of them passes it on. Prempti writes it to a log for a security engineer, Agent Approve shows it to one person on a watch, Endor files it for an auditor.

**The gate here exists to produce the recording.** It is the instrument, not the product. If you already run Prempti, its audit trail is richer than ours and reading it as an input is the obvious next step; see *Roadmap*.

## Unattended by default

Turning Nearly on does not make your agent wait for anyone. Destructive commands
are refused outright — `rm -rf`, `git push`, `sudo`, anything touching `.env`,
`curl … | sh` — and everything else runs and is written down.

It used to hold every edit for a person to approve, which only works if a person
is watching the dashboard, and nothing told a new user it existed. In practice
that meant a Cursor session unable to write a single file, each edit waiting two
minutes and then being refused. Holding for approval is now something you turn
on while you are actually watching:

```bash
nearly --supervise
```

This is not weaker than it sounds. The refusals that matter never needed a
person: they are rules, and they fire with nobody at the keyboard — including
under Claude Code's `bypassPermissions`, which skips its own prompts but not
the hooks Nearly runs in. With no one watching, the record is also the only
account of what the agent did, and it says so on the first line.

## The consent gradient

Every tool call passes through a `PreToolUse` hook to this server, which sorts it into a tier:

| Tier | What happens | Covers |
|---|---|---|
| never | refused, nobody asked, recorded with the reason | anything that cannot be undone — see below |
| ask | only with `--supervise`: held until you decide; refused if nobody answers in 2 minutes | Bash, Edit, Write, WebFetch, Task |
| log | allowed and recorded | everything else — and, unattended, everything that would have been asked |

"Allow always" and "Never" turn a decision into a rule for the rest of the run, keyed by tool and first word of the command, or file extension for edits. In lab mode every turn is committed in the agent's worktree by the `Stop` hook, so **Undo turn** is a `git reset --hard HEAD~1`.

A call nobody answered is refused, but nobody refused it, and the record says so
— "nobody answered" — rather than crediting you with a decision you never made.

### What "never" means

One rule: **refuse what cannot be undone.**

- **Deleting.** Inside the repo, git gives it back, so `rm -rf node_modules` runs. Outside the repo, in your home directory, at the root, `.git` itself, or a path only known at run time (`$SOME_VAR`) is refused. Scratch space under the system temp folder is allowed, except for the temp folder itself, a folder that holds this repo, or another git repository.
- **Pushing.** A feature branch is how work reaches review, so it runs. A force-push, deleting a remote branch, `--mirror`, or pushing straight to `main`, `master` or the remote's default branch is refused — a bare `git push` asks git which branch you are on.
- **Local history git never had.** `git clean -fd`, `git reset --hard` over uncommitted work, `reflog expire`, `gc --prune=now` and `stash clear` are refused. `git clean -fdX`, which only removes ignored build output, is not.
- **Secrets.** Refused when a real secret would be shown to the agent, sent somewhere, or carried out of the repo: `cat .env`, `curl -F file=@.env`, `cp .env /tmp`, the Read tool on `.env`, `~/.aws/credentials`, `~/.ssh`. Not refused: `.env.example`, `--env-file .env`, `source .env`, `test -f .env`, `cp .env .env.bak`, and any file git already tracks, since that is already readable by anyone with the repo.
- **The rest.** `sudo` and its relatives, a download piped into anything that runs it, world-writable `chmod`, disk and filesystem tools, deleting a GitHub repository.

It reads a command the way a shell runs it: `cd ~ && rm -rf Documents` is refused because the `cd` moves where the delete lands; `bash -c`, `eval`, `$(…)`, `xargs`, `find -exec` and `npx rimraf` are unwrapped and checked; `\rm` and `/bin/rm` are `rm`; a path is followed through symlinks; `git -c x=y push --force` is still a force-push; `git checkout main && git push` is still a push to main. Windows `Remove-Item`, `rd /s` and `del /s` are covered. Any tool carrying a command is checked, not only one named `Bash`.

### What it is not

**It is not a sandbox.** It catches what a well-meaning agent actually types, and it was built by collecting every bypass two independent test runs could find — 126 destructive commands, all refused, and 97 ordinary ones, none refused, all kept as tests. But a determined or compromised agent can still get past a rule that reads text: code handed to an interpreter (`python -c`, `node -e`) is only inspected for the obvious, and a script the agent writes to a file and then runs is not inspected at all.

For isolation, run the agent in a container, a VM, or Claude Code's own sandbox, and use Nearly for what it is for — a record of what happened, including what was stopped, that reaches the person reviewing the code.

### Lab mode

Lab mode is off by default. `nearly open` shows your own sessions and what
needs you — the gate, which is what you installed this for. `nearly lab` adds
the panel for starting agents from the dashboard, which is a different job and
no longer the first thing a new user is asked about.

Agents in lab mode are real Claude Code sessions (`claude -p`) on your Claude
subscription, each on its own branch in its own git worktree. You pick which
repo to branch from — the dashboard offers the ones you have turned Nearly on
for — and the branch starts from that repo's HEAD, so it begins where you
actually are rather than on some assumed `main`. Worktrees live under
`~/.nearly/workspace/.worktrees/`, outside the installed package, so upgrading
never deletes one. No API key, no paid infrastructure, anywhere in this project.

## What the record actually contains

**Who it is for.** The reviewer, who was not in the room. So the narration names the supervisor rather than saying "you", and it leads with the actions that never happened. Pass `--audience supervisor` for the second-person version.

Scene by scene: the task verbatim, every held request with the answer given and how long it took, each round of changes as a diff, anything rolled back, and one closing view of what was asked against what the agent claims it did. Every figure is computed from the recording.

The push hook builds this for you. To build one by hand:

```bash
node scripts/build-recap.mjs --branch feat/x --repo ~/code/my-app   # a branch
node scripts/build-recap.mjs latest                                 # one session
node scripts/build-recap.mjs latest --llm                           # Claude rewrites the sentences, never the facts
```

Output is one self-contained HTML file in `ui/records/`, served at `/records/…` while the server runs.

### The voice

macOS ships three tiers of every voice. The **compact** one is installed by default and is the robot everyone recognises. **Enhanced** and **Premium** are free downloads and sound dramatically better:

```
System Settings → Accessibility → Spoken Content → System Voice → Manage Voices
```

The builder picks the best tier it finds and tells you when all it has is compact. See what you have:

```bash
node scripts/build-recap.mjs --voices
node scripts/build-recap.mjs latest --voice "Ava (Premium)"
```

**Better still, read it yourself.** Synthesis is a stand-in for a person reading their own words, and for the one record you put in front of people it is worth ten minutes:

```bash
node scripts/build-recap.mjs latest --script          # writes records/<slug>-script.md
# record each numbered line into a folder as 01.m4a, 02.m4a, …
node scripts/build-recap.mjs latest --voice-dir ~/Desktop/narration
```

Lines you have not recorded fall back to the system voice, so you can do them a few at a time.

Rules the builder follows:

- Every number, diff and decision is computed from `recordings/<session>.jsonl` and the worktree's git history. With `--llm`, Claude only rewrites the narration sentences; it cannot add or change a fact, and the page says which mode produced it.
- Narration is macOS `say` converted to AAC and embedded, so the file needs no server and no API key. About 6 KB per second of speech.
- The storyboard is also written to `records/<agent>-<id>.json` for inspection.

## The branch is the unit, not the session

A reviewer opens a pull request, not a session. One branch collects several agent sessions over days, so the record merges all of them, numbering each instruction in order. A branch record supersedes the per-session records inside it, so the published index never shows the same story twice.

## Hand it over at push time

Pushing is the moment the work stops being yours and becomes someone else's to
review, so that is when the record should change hands.

```bash
node scripts/install-push-hook.mjs ~/code/my-app
```

That installs a `pre-push` hook. On your next push it builds the branch record,
prints what it found including anything refused, and posts it to the branch's
open pull request — one comment, updated on every push after that.

It used to ask first, in the terminal. That never happened in practice: the push
that matters is the agent's own ("raise a PR"), an agent's push has no terminal,
and so nothing was ever posted and every reviewer saw an empty pull request. The
pull request is also usually opened after that push, so Nearly now posts as soon
as it sees the agent run `gh pr create` too.

Three rules it follows:

- **It never blocks a push.** No sessions on the branch, no server, a crash, a
  timeout: it prints one dim line at most and exits 0.
- **Posting is on unless you turn it off.** The record includes every prompt word
  for word. `nearly --no-post` stops posting for a repo and `nearly --post` turns
  it back on; `NEARLY_NO_POST=1` stops it everywhere. A merged or closed pull
  request is never posted to.
- **It stays fast.** Narration is skipped by default, because a minute of `say`
  at every push is not acceptable. Set `NEARLY_AUDIO=1` when you want the good one.

Set `NEARLY_URL_BASE` to the hosted path so the comment can link to the page:

```bash
export NEARLY_URL_BASE=https://<user>.github.io/<repo>/records
```

Today the poster speaks GitHub, through the `gh` CLI. Bitbucket and GitLab each
need their own small poster; the record itself is provider-agnostic, since it is
just a hosted page and a link.

## A second opinion on a finished record (off by default)

Counting cannot tell an agent deleting its own scratch file from an agent deleting
your home directory. Both are "1 action never happened", and on a real branch of
mine the scratch file was the line a reviewer read first. So Nearly can ask
[TypeSafe's Jev](https://typesafe.ai) three things about a record that is already
built, and nothing else:

- for each refusal, what it would have hit — someone's own files, shared history,
  credentials, repo source, build output, the agent's own scratch. The record then
  leads with the worst one.
- how much of a reviewer's attention the branch deserves, in one line.
- whether each round of work matches the instruction that produced it. Nearly is
  the only thing holding both halves, and drift between them is what a diff cannot
  show you.

```bash
nearly judge <typesafe-api-key>     # on, for this machine
nearly judge                        # what it is doing
nearly judge off                    # off again; records still build and post
```

Four rules, each of them a consequence of what Nearly is:

- **Never on the path of a tool call.** It runs once per record, at push time. A
  test asserts the hook path does not so much as import it.
- **Off unless you turn it on.** Commands and instructions would leave your
  machine, and a local gate is the whole pitch. A key is the opt-in; the home
  directory is replaced with `~` before anything is sent, and diffs, file contents
  and transcripts are never sent at all.
- **It cannot change a decision.** Everything it sees has already happened. It
  labels and orders a record; the policy alone decides what never runs.
- **It fails open and silent.** No key, no network, a slow answer, a malformed
  one: the record is exactly what it would have been. Answers are cached per
  branch, so a second push asks nothing again.

The comment says which lines came from a judgement and which were counted, because
a record whose provenance is unclear is worth less than one that admits it.

## Publish the records

Recap pages are self-contained HTML, so GitHub Pages hosts them for free and the links in pull request comments resolve for anyone who can see the repo.

```bash
node scripts/publish-pages.mjs --base https://<user>.github.io/<repo>
```

That copies every built recap into `docs/records/` and writes `docs/index.html`, an index of the sessions on record. Commit `docs/`, then set **Settings → Pages → branch `main`, folder `/docs`**. Preview it locally first at http://127.0.0.1:47653/docs/ while the server is running.

## The server, and why you never start it

The first hook that needs the server starts it, and it stays up for the rest of
the day rather than paying the startup cost on every tool call. Two consequences
had to be designed for, because both were found the hard way on other people's
machines.

A server outlives the run that started it, so one `npx nearly-cli` — or any
upgrade — can leave the previous build holding the port. It keeps answering,
from a directory npm has since replaced, which is why its record pages 404 and
why upgrading appears to do nothing at all. Every server now says which build it
is and where it lives, and a hook from a different install takes the port back
before doing anything else — without being asked, because nobody reads a hook's
output, and a fix only the people who happen to re-read a message ever get is
not a fix.

Builds from 0.1.8 stand down when asked. Older ones have no way to be asked, so
an idle one is ended outright. Two rules make that defensible. It must prove it
is ours twice, on `/health` and on `/state` — the second carries the consent
gradient itself, which nothing else on your machine is going to return by
chance, so a plain web server that happens to sit on 47653 is never touched. And
it is never ended while anybody is using it: dropping a held request would hand
it back to the agent's own prompt, which is the one outcome this project exists
to prevent. If a server cannot be ended, `nearly` says so and gives you the
command for your platform rather than leaving you to work it out.

And a server with no sessions that nobody has asked anything of for thirty
minutes exits on its own. There is nothing to remember to shut down, and nothing
squats on a port for days.

## Why the hook fails open

Claude Code treats a hook that times out, errors, or returns anything other than `200` with JSON as a non-blocking error and lets the tool call proceed. So this server always answers with JSON, holds "ask" calls for at most `ASK_TIMEOUT_MS`, and denies when nobody decides. The hook's own timeout is set longer than that.

## Tests

```bash
npm test
```

83 tests, no dependencies, about 50 seconds. They run on a fresh clone with no
agent, no network and no Claude subscription, because the fixtures are the two
recorded sessions committed in `recordings/demo`.

What they hold the project to:

- **Every adapter.** That `rm -rf` is refused in all seven harnesses' dialects,
  that the refusal comes back in words each one acts on, that a session appears
  from whichever field that harness calls its session id, and that a payload none
  of them would ever send leaves the agent working rather than hanging.
- **The consent gradient.** That destructive commands are denied without asking,
  that a never pattern still fires when the command is buried in a chain, that an
  unclassified tool is held rather than allowed, and that "always" for `git status`
  can never become permission for `git push`.
- **The hook contract.** The exact JSON Claude Code reads, for every tier. That an
  ask really is held until somebody answers, and that **nobody answering means
  denied**, which is the assumption the whole design rests on.
- **The record's central claim.** That every figure on the page matches the
  recording: the refusal count, who refused each one, every instruction verbatim
  and in order. The test reads the recordings itself rather than trusting the
  builder's own summary.
- **The failure paths**, which are the ones that lose you a user silently. That a
  hook whose server cannot start stays quiet and exits 0 rather than wedging a
  session. That two hooks racing for the port do not crash. That turning it on
  twice installs nothing twice, turning it off removes everything, and neither
  touches settings somebody else put there.

## Study

The claim this project makes is testable: a reviewer who sees the session record catches something a reviewer who sees only the diff misses. [`STUDY.md`](STUDY.md) is the protocol — two seeded-error tasks, three participants, and rules for reporting the result honestly including when it is negative.

## Roadmap

- **Read Prempti's audit trail as an input.** Their recording is structured, local, Apache-licensed and covers more than ours. The recap builder reads its own JSONL today; a second reader would let anyone already running Prempti get a session record without changing their gate.
- **Run the six unverified adapters against their real agents.** They are built to spec and tested against the vendors' own documented payloads, but documentation is not a build. Each one that gets run for real either becomes a verified row or becomes a bug report.
- **Port the recap player to React.** It is one self-contained page today.

## Files

- `server/adapters.mjs`, the seven harnesses and the translation at each edge
- `server/index.mjs`, spawn sessions, hooks, policy, recorder, undo
- `ui/index.html`, sessions, triage of pending approvals, rules, log
- `scripts/attach.mjs`, install or remove the hooks in a repo of your own; `scripts/post-recap.mjs`, comment the recap on its PR
- `scripts/outside.mjs`, the hook in Claude Code's user settings that gates sessions opened in another folder
- `scripts/build-recap.mjs` + `ui/recap.template.html`, narrated recap page per session
- `scripts/publish-pages.mjs`, build the `docs/` folder GitHub Pages serves
- `scripts/install-push-hook.mjs` + `scripts/push-record.mjs`, hand the branch record over at `git push`
- `~/.nearly/`, where recordings, records, settings and agent worktrees are kept — outside the package, so an upgrade cannot destroy them
- `recordings/<session>.jsonl`, every event and decision; `recordings/demo/` is committed so the records can be rebuilt from source
- `STUDY.md`, the protocol for testing whether any of this helps a reviewer
