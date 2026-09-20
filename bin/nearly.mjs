#!/usr/bin/env node
// The one command. Everything else is a subcommand of this.
//
//   nearly              turn it on for the repo you are in
//   nearly off          turn it off again
//   nearly open         open the dashboard
//   nearly lab          open it with the panel for starting agents
//   nearly record       build the record for the current branch
//   nearly post         put that record on the pull request
//   nearly agents       which agents this repo is gated for
//   nearly doctor       why nothing is showing up
//   nearly pause        stop gating every session, now; nearly resume undoes it
//   nearly judge <key>  have TypeSafe's Jev label what each refusal would have hit
//   nearly voices       list the narration voices you have
//   nearly server       run the server in the foreground (it self-starts otherwise)
//   nearly hook <ev>    internal: what the Claude Code hooks call
//
// Run it with no arguments inside a git repo and it does the useful thing,
// because the useful thing is what people type first.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const s = (n) => join(root, 'scripts', n);
// Commands a person typed and is waiting on may mention an update. The hook
// never does: nothing goes in front of an agent's tool call.
const NOTIFY = new Set(['attach', 'on', 'init', 'record', 'recap', 'post', 'publish']);

const run = async (file, args = []) => {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (NOTIFY.has(cmd) && (r.status ?? 0) === 0) {
    try {
      const { checkForUpdate, applyUpdate } = await import('../scripts/update-check.mjs');
      applyUpdate(await checkForUpdate());
    } catch { /* an update notice is never worth an error */ }
  }
  process.exit(r.status ?? 0);
};

// A leading flag is not a command. `nearly --agent=cursor` and `nearly --off`
// are how the docs say to do those things, and both used to land on "Unknown
// command" because the first argument was read as a subcommand name.
const argv = process.argv.slice(2);
const leadingFlag = argv[0]?.startsWith('-') && !['--help', '-h', '--which'].includes(argv[0]);
const [cmd = 'attach', ...rest] = leadingFlag ? ['attach', ...argv] : argv;

async function main() {
switch (cmd) {
  case 'attach': case 'on': case 'init':
    return run(s('attach.mjs'), rest);

  case 'off': case 'detach':
    return run(s('attach.mjs'), [...rest, '--off']);

  // Used by attach to confirm a `nearly` on PATH really is this tool before
  // pointing hooks at a bare command name.
  case '--which':
    console.log(root);
    return process.exit(0);

  case 'hook':
    return run(s('hook.mjs'), rest);

  // internal: what the git pre-push hook runs. It goes through this command
  // rather than a path to the script, so it survives the same upgrades and
  // cache clears the agent hooks do.
  case 'push-record':
    return run(s('push-record.mjs'), rest);

  case 'record': case 'recap': {
    // Default to the branch you are on, since that is what gets reviewed.
    if (rest.length) return run(s('build-recap.mjs'), rest);
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      return run(s('build-recap.mjs'), ['--branch', branch, '--repo', process.cwd()]);
    } catch { return run(s('build-recap.mjs'), ['latest']); }
  }

  case 'post':
    return run(s('post-recap.mjs'), rest.length ? rest : ['latest']);

  case 'publish':
    return run(s('publish-pages.mjs'), rest);

  case 'agents':
    return run(s('agents.mjs'), rest);

  case 'doctor': case 'why':
    return run(s('doctor.mjs'), rest);

  // Every hook checks for this file before anything else, so it reaches sessions
  // that are already running, which no setting or environment variable can.
  // Off by default, and a key is the whole opt-in: with one, a finished record is
  // sent to TypeSafe at push time to be labelled and ordered. Nothing is sent
  // during a session, and no decision is ever the model's. `nearly judge off` stops it.
  case 'judge': {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const { paths } = await import('../server/paths.mjs');
    const f = paths.config();
    let cfg = {};
    try { if (existsSync(f)) cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { /* start fresh */ }
    const arg = rest[0];
    if (!arg) {
      console.log(cfg.typesafeKey || process.env.NEARLY_TYPESAFE_KEY
        ? 'Records are judged at push time: each refusal is labelled with what it would have hit, worst first.'
        : 'Off. `nearly judge <typesafe-api-key>` turns it on; the record itself works without it.');
      return process.exit(0);
    }
    if (arg === 'off') { delete cfg.typesafeKey; writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n'); console.log('Judgement off. Records are still built and posted.'); return process.exit(0); }
    cfg.typesafeKey = arg;
    writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`Saved in ${f}. From the next push, each refusal is labelled with what it would have hit.`);
    console.log('Only finished records leave this machine, never a tool call, and never a decision.');
    return process.exit(0);
  }

  case 'pause': case 'resume': {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const dir = process.env.NEARLY_HOME || join(homedir(), '.nearly');
    const file = join(dir, 'paused');
    if (cmd === 'pause') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${new Date().toISOString()}\n`);
      console.log('Nearly is paused. Every session, including ones already open, runs ungated and unrecorded.');
      console.log('Turn it back on with: nearly resume');
    } else {
      rmSync(file, { force: true });
      console.log('Nearly is gating and recording again.');
    }
    return process.exit(0);
  }

  case 'voices':
    return run(s('build-recap.mjs'), ['--voices']);

  case 'server': {
    console.log(`Nearly on http://127.0.0.1:${process.env.NEARLY_PORT || 47653}`);
    console.log('You do not normally need this: the hooks start it when they need it.');
    return run(join(root, 'server', 'index.mjs'), rest);
  }

  case 'lab': case 'open': {
    // `open` is the gate: your sessions and what needs you. `lab` adds the
    // panel for starting agents from here, which is a different job.
    const url = `http://127.0.0.1:${process.env.NEARLY_PORT || 47653}` + (cmd === 'lab' ? '/?lab=1' : '');
    spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open',
      [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    console.log(url);
    return process.exit(0);
  }

  case 'help': case '--help': case '-h': {
    console.log(`
  nearly              turn it on for the repo you are in
  nearly off          turn it off again
  nearly open         open the dashboard
  nearly lab          open it with the panel for starting agents
  nearly record       build the record for the current branch
  nearly post         put that record on the pull request
  nearly agents       which agents this repo is gated for
  nearly doctor       why nothing is showing up
  nearly pause        stop gating every session right now (nearly resume)
  nearly judge <key>  label refusals with what they would have hit (TypeSafe)
  nearly voices       list the narration voices you have
  nearly server       run the server in the foreground
`);
    return process.exit(0);
  }

  default:
    // `nearly ~/code/app` — a path, not a command. The "not a git repository"
    // message told people to pass one, and then this said "Unknown command".
    if (existsSync(cmd) && statSync(cmd).isDirectory()) return run(s('attach.mjs'), [cmd, ...rest]);
    console.error(`Unknown command: ${cmd}`);
    console.error('Try: nearly help');
    process.exit(1);
}
}

await main();
