import { spawn } from 'node:child_process';

// A voice turn cannot wait for a play: measured runtimes span 9s to well over
// 200s. Plays run in the background and the result is fetched on a later turn.

const OUTPUT_CAP = 64 * 1024;
const KILL_GRACE_MS = 5000;

const jobs = new Map();

function killGroup(child, signal) {
  // rote starts its own children. Killing only the direct child leaves them
  // running, so each play gets its own process group and the whole group goes.
  try { process.kill(-child.pid, signal); } catch {}
}

export function runningCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.state === 'running') n++;
  return n;
}

export function getJob(name) {
  return jobs.get(name);
}

export function startJob(name, timeoutMs, { approved = false } = {}) {
  // --yes tells rote a non-interactive harness already obtained approval for
  // this exact play. Only the owner's allowlist may assert that.
  const args = ['play', 'run', name, ...(approved ? ['--yes'] : [])];
  const child = spawn('rote', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const job = { name, state: 'running', startedAt: Date.now(), endedAt: null, output: '', child };
  jobs.set(name, job);

  const append = chunk => {
    job.output = (job.output + chunk).slice(-OUTPUT_CAP);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const timer = setTimeout(() => {
    job.state = 'timed-out';
    killGroup(child, 'SIGTERM');
    setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
  }, timeoutMs);

  child.on('error', err => {
    clearTimeout(timer);
    job.state = 'failed';
    job.endedAt = Date.now();
    append(String(err.message));
  });

  child.on('close', code => {
    clearTimeout(timer);
    if (job.state === 'running') job.state = code === 0 ? 'finished' : 'failed';
    job.endedAt = Date.now();
    job.child = null;
  });

  return job;
}

export function stopAll() {
  for (const j of jobs.values()) if (j.child) killGroup(j.child, 'SIGKILL');
}
