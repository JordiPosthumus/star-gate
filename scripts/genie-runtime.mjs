// Genie's runtime is installed inside this checkout and pinned to one upstream
// revision. Nothing global is touched: no system Python, no personal Hermes, no
// shell startup files. The install is recorded and verified before reuse.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export const HERMES_UPSTREAM = 'https://github.com/NousResearch/hermes-agent.git';
export const HERMES_REVISION = '8c9fe964009096e46f44292d036c1e0ac33c3026';
export const UV_VERSION = '0.11.8';

const UV_ARCHIVES = {
  'darwin-arm64': ['aarch64-apple-darwin', 'c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8'],
  'darwin-x64': ['x86_64-apple-darwin', 'c59d73bf34b58bc8e33a11629f7a255c11789fd00f03cd3e68ab2d1603645de9'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb'],
};

export function runtimeTarget(platform = process.platform, arch = process.arch) {
  return UV_ARCHIVES[`${platform}-${arch}`] ?? null;
}

export function runtimePaths(root, {revision = HERMES_REVISION} = {}) {
  const base = path.join(root, 'runtime', 'genie-runtime');
  const source = path.join(base, `hermes-${revision}`);
  return {
    base,
    source,
    python: path.join(source, '.venv', 'bin', 'python'),
    receipt: path.join(source, 'star-gate-install.json'),
    lock: path.join(base, '.install-lock'),
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', x => { output = (output + x).slice(-16000); });
    child.on('error', () => reject(new Error(`Could not start ${path.basename(command)}. Check that Git and tar are installed.`)));
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${path.basename(command)} failed (${code}). ${output}`)));
  });
}

export function installerEnvironment(base) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(base, 'installer-home'),
    UV_CACHE_DIR: path.join(base, 'cache'),
    UV_PYTHON_INSTALL_DIR: path.join(base, 'python'),
    UV_PYTHON_BIN_DIR: path.join(base, 'bin'),
    UV_NO_CONFIG: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'en_US.UTF-8',
  };
}

// Read the recorded install without trusting it: the revision must match, the
// checkout must be a clean worktree at that exact commit, and the pinned source
// must still import. Anything else refuses instead of repairing silently.
export async function verifyRuntime(paths, {revision = HERMES_REVISION, exec = run} = {}) {
  if (!fs.existsSync(paths.receipt)) return {state: 'absent'};
  let saved;
  try { saved = JSON.parse(fs.readFileSync(paths.receipt, 'utf8')); }
  catch { return {state: 'invalid', reason: 'The installation record is unreadable.'}; }
  if (saved.revision !== revision) return {state: 'mismatch', reason: `Recorded revision ${saved.revision} is not ${revision}.`};
  if (!fs.existsSync(path.join(paths.source, '.git'))) return {state: 'invalid', reason: 'The pinned source is not a Git checkout.'};
  const head = await exec('git', ['rev-parse', 'HEAD'], {cwd: paths.source});
  if (head !== revision) return {state: 'mismatch', reason: `The checkout is at ${head.slice(0, 12)}, not the pinned revision.`};
  const dirty = await exec('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: paths.source});
  if (dirty !== '') return {state: 'modified', reason: 'The pinned source has local modifications.'};
  await exec(paths.python, ['-I', '-c', 'import sys; sys.path.insert(0,sys.argv[1]); from run_agent import AIAgent', paths.source], {cwd: paths.source});
  return {state: 'ready', revision};
}

export async function installHermes(root, {log = console.log, exec = run, revision = HERMES_REVISION, fetchImpl = fetch, platform = process.platform, arch = process.arch} = {}) {
  const target = runtimeTarget(platform, arch);
  if (!target) throw new Error('Genie setup supports macOS and glibc Linux on ARM64 or x64.');
  const paths = runtimePaths(root, {revision});
  fs.mkdirSync(paths.base, {recursive: true, mode: 0o700});
  const env = installerEnvironment(paths.base);
  fs.mkdirSync(env.HOME, {recursive: true, mode: 0o700});

  const existing = await verifyRuntime(paths, {revision, exec});
  if (existing.state === 'ready') return {...paths, reused: true};
  if (existing.state !== 'absent') throw new Error(`The dedicated Hermes runtime cannot be reused: ${existing.reason} Nothing was replaced.`);

  try { fs.mkdirSync(paths.lock); }
  catch { throw new Error('A Genie installation is already running or was interrupted. Check it before removing runtime/genie-runtime/.install-lock and retrying.'); }

  try {
    const tools = path.join(paths.base, `uv-${UV_VERSION}`);
    fs.mkdirSync(tools, {recursive: true});
    const uv = path.join(tools, `uv-${target[0]}`, 'uv');
    if (!fs.existsSync(uv)) {
      log('Downloading Star Gate’s private installer…');
      const response = await fetchImpl(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target[0]}.tar.gz`, {signal: AbortSignal.timeout(180000)});
      if (!response.ok) throw new Error(`Installer download failed (${response.status}). Run setup again to retry.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== target[1]) throw new Error('Installer checksum does not match the pinned release.');
      const archive = path.join(tools, 'download.tar.gz');
      fs.writeFileSync(archive, bytes);
      await exec('tar', ['-xzf', archive, '-C', tools], {env});
      fs.unlinkSync(archive);
    }

    if (!fs.existsSync(path.join(paths.source, '.git'))) {
      if (fs.existsSync(paths.source) && fs.readdirSync(paths.source).length) throw new Error('The dedicated runtime directory is occupied; nothing overwritten.');
      fs.mkdirSync(paths.source, {recursive: true});
      await exec('git', ['init', '-q'], {cwd: paths.source, env});
    }
    log('Downloading the pinned Hermes source…');
    await exec('git', ['fetch', '--depth', '1', HERMES_UPSTREAM, revision], {cwd: paths.source, env});
    await exec('git', ['checkout', '--detach', revision], {cwd: paths.source, env});
    log('Installing private Python 3.12 and Hermes dependencies. This may take a few minutes…');
    await exec(uv, ['sync', '--frozen', '--no-dev', '--python', '3.12', '--managed-python'], {cwd: paths.source, env});
    await exec(paths.python, ['-I', '-c', 'import sys; sys.path.insert(0,sys.argv[1]); from run_agent import AIAgent', paths.source], {cwd: paths.source, env});
    fs.writeFileSync(paths.receipt, JSON.stringify({revision, uv: UV_VERSION, installed_at: new Date().toISOString()}, null, 2) + '\n', {mode: 0o600});
    return {...paths, reused: false};
  } finally {
    try { fs.rmdirSync(paths.lock); } catch {}
  }
}
