'use strict';

const { execFile } = require('child_process');
const path = require('path');

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

/**
 * Where to look for git.
 *
 * A GUI app launched from the Dock does not inherit the PATH from your shell,
 * so a Homebrew git can be invisible to the extension host even though it works
 * perfectly in Terminal. Try the bare name first, then the usual install sites.
 */
const GIT_CANDIDATES = [
  'git',
  '/usr/bin/git',
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/usr/local/git/bin/git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
];

let resolvedGit = null;
let resolving = null;

/** Last failure, kept so the diagnostics command can explain what went wrong. */
let lastError = null;

function getLastError() {
  return lastError;
}

function recordError(context, error) {
  lastError = {
    context,
    message: (error && error.message) || String(error),
    stderr: ((error && error.stderr) || '').trim(),
    at: new Date(),
  };
  return lastError;
}

function tryExec(exe, args, options = {}) {
  const { cwd, stdin, timeout = 15000 } = options;

  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );

    if (stdin !== undefined && child.stdin) {
      // A file can disappear or git can bail before we finish writing.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

/**
 * Find a working git and remember it. `preferred` comes from the user's
 * settings and wins if it runs. Resolves to { path, version } or throws.
 */
async function resolveGit(preferred) {
  if (resolvedGit && (!preferred || resolvedGit.path === preferred)) return resolvedGit;
  if (resolving) return resolving;

  const candidates = preferred ? [preferred, ...GIT_CANDIDATES] : GIT_CANDIDATES;
  const tried = [];

  resolving = (async () => {
    for (const candidate of candidates) {
      try {
        const stdout = await tryExec(candidate, ['--version'], { timeout: 5000 });
        resolvedGit = { path: candidate, version: stdout.trim() };
        lastError = null;
        return resolvedGit;
      } catch (error) {
        tried.push(`${candidate}: ${(error && error.code) || (error && error.message)}`);
      }
    }

    const error = new Error(
      `Could not find a working git. Tried:\n  ${tried.join('\n  ')}\n` +
        'Set "hanblame.gitPath" to the output of `which git` in your terminal.'
    );
    recordError('resolving git', error);
    throw error;
  })().finally(() => {
    resolving = null;
  });

  return resolving;
}

/** Forget the cached git, so a settings change takes effect immediately. */
function resetGit() {
  resolvedGit = null;
  resolving = null;
}

function getResolvedGit() {
  return resolvedGit;
}

/**
 * Run a git command and resolve with its stdout.
 * Rejects on a non-zero exit code; callers are expected to treat that as
 * "no blame available" rather than something to show the user.
 */
async function run(args, options = {}) {
  const { gitPath } = options;
  const git = await resolveGit(gitPath);
  return tryExec(git.path, args, options);
}

/** Absolute path of the repo containing `filePath`, or null if it is not in one. */
async function findRepoRoot(filePath, options = {}) {
  try {
    const stdout = await run(['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(filePath),
      gitPath: options.gitPath,
    });
    return stdout.trim() || null;
  } catch (error) {
    recordError(`finding the repo for ${filePath}`, error);
    return null;
  }
}

/** The email in git config for this repo, used to decide what counts as "You". */
async function getUserEmail(repoRoot, options = {}) {
  try {
    const stdout = await run(['config', '--get', 'user.email'], {
      cwd: repoRoot,
      gitPath: options.gitPath,
    });
    return stdout.trim().toLowerCase() || null;
  } catch {
    // No user.email set is normal enough; it only turns off the "You" label.
    return null;
  }
}

const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/i;

function emptyInfo(sha) {
  return {
    sha,
    author: 'Unknown',
    authorMail: '',
    authorTime: null,
    summary: '',
    filename: '',
    uncommitted: sha === UNCOMMITTED_SHA,
  };
}

function applyField(info, line) {
  const space = line.indexOf(' ');
  const key = space === -1 ? line : line.slice(0, space);
  const value = space === -1 ? '' : line.slice(space + 1);

  switch (key) {
    case 'author':
      info.author = value;
      // Git reports uncommitted work with a zero SHA and this author name.
      if (value === 'Not Committed Yet') info.uncommitted = true;
      break;
    case 'author-mail':
      info.authorMail = value.replace(/^<|>$/g, '').toLowerCase();
      break;
    case 'author-time': {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) info.authorTime = new Date(seconds * 1000);
      break;
    }
    case 'summary':
      info.summary = value;
      break;
    case 'filename':
      info.filename = value;
      break;
    default:
      break;
  }
}

/**
 * Parse `git blame --porcelain` output into a Map of 0-based line -> commit info.
 *
 * Each line of the file produces a header of "<sha> <origLine> <finalLine> <count>",
 * optionally a block of key/value lines, then the source line prefixed with a tab.
 * Git only describes a commit the first time it appears, so later lines from the
 * same commit carry just the header — hence the lookup table of commits.
 */
function parsePorcelainAll(stdout) {
  const commits = new Map();
  const byLine = new Map();

  let pendingLine = null;
  let pendingInfo = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('\t')) {
      if (pendingLine !== null && pendingInfo) byLine.set(pendingLine - 1, pendingInfo);
      pendingLine = null;
      pendingInfo = null;
      continue;
    }

    const header = HEADER.exec(line);
    if (header) {
      const sha = header[1];
      if (!commits.has(sha)) commits.set(sha, emptyInfo(sha));
      pendingInfo = commits.get(sha);
      pendingLine = Number(header[3]);
      continue;
    }

    if (pendingInfo) applyField(pendingInfo, line);
  }

  // Tolerate output that ends without its trailing source line.
  if (pendingLine !== null && pendingInfo) byLine.set(pendingLine - 1, pendingInfo);

  return byLine;
}

/** Back-compat helper: the first (usually only) entry of a porcelain block. */
function parsePorcelain(stdout) {
  const byLine = parsePorcelainAll(stdout);
  const first = byLine.values().next();
  return first.done ? null : first.value;
}

function blameArgs({ range, contents, ignoreWhitespace, filePath }) {
  const args = ['blame', '--porcelain'];
  if (range) args.push('-L', `${range[0]},${range[1]}`);
  if (ignoreWhitespace) args.push('-w');
  if (contents !== undefined) args.push('--contents', '-');
  args.push('--', filePath);
  return args;
}

/**
 * Blame a single line (0-based) of a file.
 * Returns null when the line has no blame — outside a repo, untracked file,
 * empty file, or a line number past the end of the buffer.
 */
async function blameLine(repoRoot, filePath, zeroBasedLine, options = {}) {
  const { contents, ignoreWhitespace = true, gitPath } = options;
  const lineNumber = zeroBasedLine + 1;

  try {
    const stdout = await run(
      blameArgs({ range: [lineNumber, lineNumber], contents, ignoreWhitespace, filePath }),
      { cwd: repoRoot, stdin: contents, gitPath }
    );
    return parsePorcelain(stdout);
  } catch (error) {
    recordError(`blaming line ${lineNumber} of ${filePath}`, error);
    return null;
  }
}

/**
 * Blame every line of a file at once.
 *
 * Git spends most of its time walking history rather than on the line range,
 * so one whole-file blame costs about the same as one single-line blame and
 * then every other line in the file is free. Returns null on failure.
 */
async function blameFile(repoRoot, filePath, options = {}) {
  const { contents, ignoreWhitespace = true, gitPath } = options;

  try {
    const stdout = await run(blameArgs({ contents, ignoreWhitespace, filePath }), {
      cwd: repoRoot,
      stdin: contents,
      gitPath,
    });
    return parsePorcelainAll(stdout);
  } catch (error) {
    recordError(`blaming ${filePath}`, error);
    return null;
  }
}

/** Full commit message body, used to fill out the hover card. */
async function getCommitBody(repoRoot, sha, options = {}) {
  try {
    const stdout = await run(['show', '-s', '--format=%B', sha], {
      cwd: repoRoot,
      gitPath: options.gitPath,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ASCII unit separator, written as an escape so the source survives being
// copied through editors and clipboards that strip control characters.
const FIELD = '\u001f';

/**
 * Recent commits touching a file, newest first.
 * `--follow` keeps the history intact across renames.
 */
async function getFileHistory(repoRoot, filePath, options = {}) {
  const { limit = 50, gitPath } = options;

  try {
    const stdout = await run(
      [
        'log',
        `--max-count=${limit}`,
        '--follow',
        '--name-only',
        `--format=${FIELD}%H${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`,
        '--',
        filePath,
      ],
      { cwd: repoRoot, gitPath }
    );

    // With --name-only, each commit is a header line followed by the path the
    // file had at that commit. That path is what `git show <sha>:<path>` needs,
    // and it differs from today's path anywhere the file was renamed.
    const commits = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;

      if (line.startsWith(FIELD)) {
        const [, sha, author, authorMail, authorTime, summary] = line.split(FIELD);
        if (!/^[0-9a-f]{40}$/i.test(sha || '')) continue;

        const seconds = Number(authorTime);
        commits.push({
          sha,
          author,
          authorMail: (authorMail || '').toLowerCase(),
          authorTime: Number.isFinite(seconds) ? new Date(seconds * 1000) : null,
          summary: summary || '',
          path: null,
          uncommitted: false,
        });
        continue;
      }

      // A filename for the commit we are currently collecting.
      const commit = commits[commits.length - 1];
      if (commit && !commit.path) commit.path = line.trim();
    }

    return commits;
  } catch (error) {
    recordError(`reading history for ${filePath}`, error);
    return [];
  }
}

/** The contents of a file as of a given commit. */
async function getFileAtRevision(repoRoot, sha, pathAtCommit, options = {}) {
  return run(['show', `${sha}:${pathAtCommit}`], {
    cwd: repoRoot,
    gitPath: options.gitPath,
  });
}

/** Full patch for a commit, shown when the user opens it. */
async function getCommitPatch(repoRoot, sha, options = {}) {
  return run(['show', '--stat', '--patch', sha], { cwd: repoRoot, gitPath: options.gitPath });
}

module.exports = {
  UNCOMMITTED_SHA,
  GIT_CANDIDATES,
  run,
  resolveGit,
  resetGit,
  getResolvedGit,
  getLastError,
  findRepoRoot,
  getUserEmail,
  parsePorcelain,
  parsePorcelainAll,
  blameLine,
  blameFile,
  getFileHistory,
  getFileAtRevision,
  getCommitBody,
  getCommitPatch,
};
