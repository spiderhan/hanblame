'use strict';

const vscode = require('vscode');
const git = require('./git');
const format = require('./format');
const colour = require('./colour');

const SCHEME = 'hanblame';
const CACHE_LIMIT = 30;

/**
 * Above this many lines we blame one line at a time instead of the whole file,
 * to keep git's output from outgrowing the buffer we read it into.
 */
const WHOLE_FILE_LINE_LIMIT = 20000;

/** How many steps the heatmap ramp is divided into. */
const HEATMAP_STEPS = 8;

let decorationType;
let statusBarItem;
let output;

let timer = null;
let sequence = 0;
let historyProvider = null;
let codeLensProvider = null;

/** Last blame we resolved, so the commands know what the cursor is sitting on. */
let current = null;

/** uri -> { version, whole: boolean, lines: Map<lineNumber, info|null> } */
const blameCache = new Map();
/** directory -> repo root (or null when the file is not in a repo) */
const repoRootCache = new Map();
/** repo root -> git user.email */
const emailCache = new Map();
/** sha -> full commit message, for the hover card */
const bodyCache = new Map();

async function resolveCommitBody(repoRoot, sha) {
  if (bodyCache.has(sha)) return bodyCache.get(sha);

  const body = await git.getCommitBody(repoRoot, sha, gitOptions());
  bodyCache.set(sha, body);
  if (bodyCache.size > 200) bodyCache.delete(bodyCache.keys().next().value);
  return body;
}

function config() {
  return vscode.workspace.getConfiguration('hanblame');
}

function log(message) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function gitOptions() {
  const configured = (config().get('gitPath') || '').trim();
  return configured ? { gitPath: configured } : {};
}

/** One line of diagnostics output. */
function report(text) {
  output.appendLine(text);
}

/** `note` when `condition` holds, nothing otherwise — for the "<- this is it" hints. */
function hint(condition, note) {
  return condition ? note : '';
}

/** The inline annotation text for a blamed line, as the user has configured it. */
function annotationText(info, settings, userEmail) {
  return format.annotation(info, {
    format: settings.get('format'),
    dateStyle: settings.get('dateStyle'),
    useYou: settings.get('useYou', true),
    maxMessageLength: settings.get('maxMessageLength', 60),
    userEmail,
  });
}

/**
 * Walk through everything the extension needs and report each step into the
 * output channel. Faster than guessing when nothing appears on screen.
 *
 * Each step returns something falsy when it found the problem, which stops the
 * walk there — later steps would only report noise caused by the earlier one.
 */
async function diagnose() {
  output.clear();
  output.show(true);

  const settings = config();
  diagnoseSettings(settings);

  if (!(await diagnoseGit(settings))) return;

  const editor = vscode.window.activeTextEditor;
  if (!diagnoseEditor(editor)) return;

  const repoRoot = await diagnoseRepo(editor);
  if (!repoRoot) return;

  const text = await diagnoseBlame(editor, repoRoot, settings);
  if (text === null) return;

  diagnoseHeatmap(editor, settings);
  await diagnoseCodeLens(editor, settings);
  diagnoseVerdict(text);
}

function diagnoseSettings(settings) {
  report('Hanblame diagnostics');
  report('='.repeat(60));
  report(`enabled:        ${settings.get('enabled')}`);
  report(`statusBar:      ${settings.get('statusBar')}`);
  report(`gitPath:        ${settings.get('gitPath') || '(auto)'}`);
  report('');
}

async function diagnoseGit(settings) {
  report('1. Finding git');
  try {
    const found = await git.resolveGit((settings.get('gitPath') || '').trim() || undefined);
    report(`   found:  ${found.path}`);
    report(`   version: ${found.version}`);
  } catch (error) {
    report(`   FAILED: ${error.message}`);
    report('');
    report('This is the problem. VS Code launched from the Dock does not get your');
    report('shell PATH, so a Homebrew git can be invisible to it. Run `which git`');
    report('in Terminal and put that path in the "hanblame.gitPath" setting.');
    return false;
  }
  report('');
  return true;
}

/** True when the active editor holds a file on disk that blame can work with. */
function diagnoseEditor(editor) {
  report('2. Active editor');
  if (!editor) {
    report('   FAILED: no file is open. Open a file in a git repo and run this again.');
    return false;
  }

  const { uri } = editor.document;
  const onDisk = uri.scheme === 'file';
  report(`   file:   ${uri.fsPath}`);
  report(`   scheme: ${uri.scheme}${hint(!onDisk, '  <- not a file on disk, blame is skipped')}`);
  report(`   line:   ${editor.selection.active.line + 1} of ${editor.document.lineCount}`);
  report(`   dirty:  ${editor.document.isDirty}`);
  report('');
  return onDisk;
}

async function diagnoseRepo(editor) {
  report('3. Finding the repo');
  const repoRoot = await git.findRepoRoot(editor.document.uri.fsPath, gitOptions());
  if (!repoRoot) {
    report('   FAILED: this file is not inside a git repository.');
    const last = git.getLastError();
    if (last) report(`   git said: ${last.stderr || last.message}`);
    return null;
  }
  report(`   root:   ${repoRoot}`);
  report('');
  return repoRoot;
}

function reportLastGitError() {
  const last = git.getLastError();
  if (!last) return;
  report(`   while:  ${last.context}`);
  report(`   error:  ${last.message}`);
  if (last.stderr) report(`   stderr: ${last.stderr}`);
}

/** The annotation text for the current line, or null when blame failed. */
async function diagnoseBlame(editor, repoRoot, settings) {
  report('4. Blaming the current line');
  const { document } = editor;
  const info = await git.blameLine(repoRoot, document.uri.fsPath, editor.selection.active.line, {
    ...gitOptions(),
    contents: document.isDirty ? document.getText() : undefined,
    ignoreWhitespace: settings.get('ignoreWhitespace', true),
  });

  if (!info) {
    report('   FAILED: no blame for this line.');
    reportLastGitError();
    report('');
    report('   Common causes: the file is untracked (git add it), the line is');
    report('   blank at the end of the file, or the repo has no commits yet.');
    return null;
  }

  report(`   sha:    ${info.sha}`);
  report(`   author: ${info.author} <${info.authorMail}>`);
  report(`   when:   ${info.authorTime}`);
  report(`   message:${info.summary}`);
  report(`   uncommitted: ${info.uncommitted}`);
  report('');

  const email = await git.getUserEmail(repoRoot, gitOptions());
  const text = annotationText(info, settings, email) || '';

  report('5. What should appear on the line');
  report(`   "${text}"`);
  report('');
  return text;
}

function diagnoseHeatmap(editor, settings) {
  report('6. Gutter heatmap');
  report(`   setting:        ${settings.get('heatmap', true)}`);
  report(`   theme:          ${isDarkTheme() ? 'dark' : 'light'} ramp`);

  const configuredColour = (settings.get('heatmapColor') || '').trim();
  const invalidColour = Boolean(configuredColour) && !colour.hexToHsl(configuredColour);
  report(
    `   colour:         ${configuredColour || `${colour.DEFAULT_COLOUR} (default)`}` +
      hint(invalidColour, '  <- not a valid hex colour, falling back to the default')
  );
  report(`   ramp:           ${heatmapRamp().join(' ')}`);
  report(
    `   colour steps:   ${heatmapTypes.length}` +
      hint(!heatmapTypes.length, '  <- none built, this is the problem')
  );

  const glyphMargin = vscode.workspace.getConfiguration('editor').get('glyphMargin');
  report(
    `   editor.glyphMargin: ${glyphMargin}` +
      hint(glyphMargin === false, '  <- turn this on, gutter icons need it')
  );

  const cache = blameCache.get(editor.document.uri.toString());
  if (cache && cache.whole) {
    diagnoseHeatmapSpread(cache, settings);
  } else {
    report('   whole-file blame: not done for this file yet');
    report('   The heatmap needs blame for every line. Move the cursor around and');
    report('   run this again; files over 20,000 lines never take that path.');
  }
  report('');
}

/** How many lines land on each step of the ramp, newest first. */
function heatmapSpread(cache, maxAge) {
  const spread = new Array(heatmapTypes.length).fill(0);
  for (const [, info] of cache.lines) {
    if (!info) continue;
    const step = info.uncommitted ? 0 : heatStep(info.authorTime, maxAge, heatmapTypes.length);
    spread[step] += 1;
  }
  return spread;
}

function diagnoseHeatmapSpread(cache, settings) {
  const maxAge = settings.get('heatmapMaxAge', 365);
  const spread = heatmapSpread(cache, Math.max(1, maxAge));
  const counted = spread.reduce((sum, n) => sum + n, 0);

  report(`   lines coloured: ${counted}`);
  report(`   spread (newest to oldest): ${spread.join(', ')}`);
  if (counted && spread.filter(Boolean).length === 1) {
    report('   Every line is the same age, so the gutter is one flat colour.');
    report(`   Try lowering hanblame.heatmapMaxAge (currently ${maxAge} days).`);
  }
}

async function diagnoseCodeLens(editor, settings) {
  report('7. CodeLens above functions');
  const lensOn = settings.get('codeLens', false);
  const editorLensOn = vscode.workspace.getConfiguration('editor').get('codeLens');
  report(`   hanblame.codeLens:  ${lensOn}${hint(!lensOn, '  <- off by default, this is probably it')}`);
  report(
    `   editor.codeLens:    ${editorLensOn}` +
      hint(editorLensOn === false, "  <- VS Code's own switch is off, nothing can show a CodeLens")
  );

  if (lensOn && editorLensOn !== false) {
    report(`   kinds wanted:       ${(settings.get('codeLensKinds') || []).join(', ') || '(none)'}`);
    await diagnoseSymbols(editor.document);
  }
  report('');
}

async function diagnoseSymbols(document) {
  let symbols = null;
  try {
    symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  } catch (error) {
    report(`   symbol provider:    failed (${error && error.message})`);
  }

  if (!symbols || !symbols.length) {
    report(`   symbols found:      0`);
    report(`   Nothing provides symbols for ${document.languageId} files, so there is`);
    report('   nothing to hang a CodeLens on. Install the language extension for this');
    report('   file type, or try a .js/.ts file where VS Code has symbols built in.');
    return;
  }

  const blocks = flattenSymbols(symbols, allowedSymbolKinds());
  report(`   symbols found:      ${symbols.length} top level`);
  report(`   matching your kinds: ${blocks.length}`);
  if (!blocks.length) {
    report('   The file has symbols, but none of the kinds you asked for. Try adding');
    report('   more to hanblame.codeLensKinds.');
    return;
  }

  const sample = blocks.slice(0, 3).map((b) => `${b.name} (line ${b.range.start.line + 1})`);
  report(`   first few:          ${sample.join(', ')}`);
}

function diagnoseVerdict(text) {
  if (!text) {
    report('The annotation came out empty — check the hanblame.format setting.');
    return;
  }
  report('Everything works. If nothing shows on screen, check that the line is not');
  report('scrolled out of view horizontally, and that hanblame.enabled is true.');
}

function isBlamable(document) {
  return Boolean(document) && document.uri.scheme === 'file';
}

async function resolveRepoRoot(filePath) {
  const dir = require('path').dirname(filePath);
  if (repoRootCache.has(dir)) return repoRootCache.get(dir);

  const root = await git.findRepoRoot(filePath, gitOptions());
  repoRootCache.set(dir, root);
  return root;
}

async function resolveUserEmail(repoRoot) {
  if (emailCache.has(repoRoot)) return emailCache.get(repoRoot);

  const email = await git.getUserEmail(repoRoot, gitOptions());
  emailCache.set(repoRoot, email);
  return email;
}

function cacheFor(document) {
  const key = document.uri.toString();
  const entry = blameCache.get(key);

  if (entry && entry.version === document.version) return entry;

  const fresh = { version: document.version, whole: false, lines: new Map() };
  blameCache.set(key, fresh);

  // Cheap eviction: Maps keep insertion order, so the first key is the oldest.
  if (blameCache.size > CACHE_LIMIT) {
    const oldest = blameCache.keys().next().value;
    blameCache.delete(oldest);
  }

  return fresh;
}

function commitUri(repoRoot, sha) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `${sha.slice(0, 8)}.diff`,
    query: JSON.stringify({ kind: 'patch', repoRoot, sha }),
  });
}

/**
 * A URI standing for one file as it was at one commit.
 *
 * The path is cosmetic — it is what shows on the editor tab — but the extension
 * is kept so VS Code picks the right syntax highlighting, and `pathAtCommit` is
 * the file's name *at that commit*, which differs from today's after a rename.
 */
function revisionUri(repoRoot, sha, pathAtCommit) {
  const base = pathAtCommit.split('/').pop() || pathAtCommit;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';

  return vscode.Uri.from({
    scheme: SCHEME,
    path: `${stem}@${sha.slice(0, 8)}${extension}`,
    query: JSON.stringify({ kind: 'file', repoRoot, sha, path: pathAtCommit }),
  });
}

function buildHover(info, repoRoot, body) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;

  if (info.uncommitted) {
    md.appendMarkdown('**Uncommitted changes**\n\nThis line has not been committed yet.');
    return md;
  }

  const when = info.authorTime
    ? `${format.relativeDate(info.authorTime)} (${info.authorTime.toLocaleString()})`
    : 'unknown date';

  const message = (body || info.summary || '').trim();
  const [subject, ...rest] = message.split('\n');

  md.appendMarkdown(`**${subject || '(no commit message)'}**\n\n`);
  if (rest.join('\n').trim()) {
    md.appendMarkdown(`${rest.join('\n').trim()}\n\n`);
  }
  md.appendMarkdown(`${info.author} · ${when}\n\n`);

  const args = encodeURIComponent(JSON.stringify([{ repoRoot, sha: info.sha }]));
  md.appendMarkdown(
    `\`${info.sha.slice(0, 8)}\` — ` +
      `[Show commit](command:hanblame.showCommit?${args}) · ` +
      `[Copy SHA](command:hanblame.copySha?${args})`
  );

  return md;
}

/** One decoration type per heatmap step, rebuilt when the colour theme flips. */
let heatmapTypes = [];
/** What the heatmap currently shows, so we only repaint when it actually changes. */
let heatmapKey = null;
/** Every editor currently painted — a file can be open in more than one group. */
let heatmapEditors = [];

function isDarkTheme() {
  const theme = vscode.window.activeColorTheme;
  if (!theme) return true;
  return (
    theme.kind === vscode.ColorThemeKind.Dark || theme.kind === vscode.ColorThemeKind.HighContrast
  );
}

/** A thin rounded bar, inlined as a data URI so there are no image files to ship. */
function gutterBar(colour) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18" viewBox="0 0 6 18">' +
    `<rect x="1" y="0" width="4" height="18" rx="2" fill="${colour}"/></svg>`;

  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function disposeHeatmapTypes() {
  for (const type of heatmapTypes) type.dispose();
  heatmapTypes = [];
  heatmapKey = null;
  heatmapEditors = [];
}

/** The ramp for the current theme, derived from whatever colour is configured. */
function heatmapRamp() {
  const configured = (config().get('heatmapColor') || '').trim() || colour.DEFAULT_COLOUR;
  return colour.buildRamp(configured, { dark: isDarkTheme(), steps: HEATMAP_STEPS });
}

function buildHeatmapTypes() {
  disposeHeatmapTypes();
  heatmapTypes = heatmapRamp().map((step) =>
    vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar(step),
      gutterIconSize: 'contain',
    })
  );
}

/**
 * Which step of the ramp a commit date falls on.
 *
 * Age is scaled logarithmically, because the difference between today and last
 * week matters far more than the difference between 300 and 330 days — a linear
 * scale would collapse everything recent into one step.
 */
function heatStep(date, maxAgeDays, steps) {
  if (!date) return steps - 1;

  const days = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  const t = Math.min(1, Math.log1p(days) / Math.log1p(Math.max(1, maxAgeDays)));
  return Math.min(steps - 1, Math.floor(t * steps));
}

function clearHeatmap(editors) {
  const targets = editors ? (Array.isArray(editors) ? editors : [editors]) : heatmapEditors;

  for (const target of targets) {
    if (!target) continue;
    try {
      for (const type of heatmapTypes) target.setDecorations(type, []);
    } catch {
      // Editor closed underneath us.
    }
  }

  heatmapKey = null;
  heatmapEditors = [];
}

function applyHeatmap(editor, cache) {
  if (!heatmapTypes.length) return;

  const maxAge = Math.max(1, config().get('heatmapMaxAge', 365));
  const buckets = heatmapTypes.map(() => []);
  const lineCount = editor.document.lineCount;

  for (const [line, info] of cache.lines) {
    if (!info || line >= lineCount) continue;

    const step = info.uncommitted ? 0 : heatStep(info.authorTime, maxAge, heatmapTypes.length);
    buckets[step].push(new vscode.Range(line, 0, line, 0));
  }

  try {
    heatmapTypes.forEach((type, index) => editor.setDecorations(type, buckets[index]));
  } catch (error) {
    log(`could not paint the heatmap: ${error && error.message}`);
  }
}

/**
 * Paint every editor showing this document — the same file can be open in a
 * split, and a heatmap in only one half looks broken.
 */
function paintHeatmap(document, cache) {
  const key = `${document.uri.toString()}@${document.version}`;
  const targets = vscode.window.visibleTextEditors.filter(
    (candidate) => candidate.document.uri.toString() === document.uri.toString()
  );

  const unchanged =
    key === heatmapKey &&
    targets.length === heatmapEditors.length &&
    targets.every((target) => heatmapEditors.includes(target));
  if (unchanged) return;

  clearHeatmap();
  for (const target of targets) applyHeatmap(target, cache);

  heatmapEditors = targets;
  heatmapKey = key;
}

/** The editor currently carrying an annotation, so we can wipe it on switch. */
let decorated = null;

function clear(editor) {
  current = null;

  // Decorations are per-editor, so clear whichever editor still has one as
  // well as the one being asked about.
  for (const target of new Set([editor, decorated])) {
    if (!target) continue;
    try {
      target.setDecorations(decorationType, []);
    } catch {
      // The editor was closed while we were working; nothing to clean up.
    }
  }

  decorated = null;
  if (statusBarItem) statusBarItem.hide();
}

async function update(editor) {
  if (!editor) return;

  const settings = config();
  const wantAnnotation = settings.get('enabled', true);
  const wantHeatmap = settings.get('heatmap', true);

  const document = editor.document;

  // Something that is not a file on disk — an output panel, a diff view. The
  // annotation goes, but the heatmap belongs to whichever file editor is still
  // on screen, so it stays put unless the feature itself is off.
  if (!isBlamable(document) || (!wantAnnotation && !wantHeatmap)) {
    clear(editor);
    if (!wantHeatmap) clearHeatmap();
    return;
  }

  const token = ++sequence;
  const filePath = document.uri.fsPath;
  const painted = (uri) => heatmapKey && heatmapKey.startsWith(`${uri.toString()}@`);

  const repoRoot = await resolveRepoRoot(filePath);
  if (!repoRoot) {
    clear(editor);
    if (painted(document.uri)) clearHeatmap();
    return;
  }

  // The heatmap describes the whole file, so it is painted before — and
  // independently of — anything to do with where the cursor happens to be.
  // Otherwise resting on a blank line would wipe it.
  if (wantHeatmap) {
    const filled = await ensureWholeFileBlame(document, repoRoot);
    if (token !== sequence) return;
    if (filled) paintHeatmap(document, filled);
  } else if (heatmapEditors.length) {
    clearHeatmap();
  }

  if (!wantAnnotation) {
    clear(editor);
    return;
  }

  if (!hasSingleCursorInFile(editor)) {
    clear(editor);
    return;
  }

  const line = editor.selection.active.line;
  const info = await blameForLine(document, repoRoot, line, settings);

  // The cursor moved on while git was working; that newer call owns the view.
  if (token !== sequence) return;
  if (!info) {
    clear(editor);
    return;
  }

  const userEmail = await resolveUserEmail(repoRoot);
  if (token !== sequence) return;

  const text = annotationText(info, config(), userEmail);
  if (!text) {
    clear(editor);
    return;
  }

  const body = info.uncommitted ? '' : await resolveCommitBody(repoRoot, info.sha);
  if (token !== sequence) return;

  current = { repoRoot, sha: info.sha, info };

  if (decorate(editor, line, text, buildHover(info, repoRoot, body))) {
    showInStatusBar(info, text, settings);
  }
}

/** Multiple cursors would mean multiple annotations; not worth the noise. */
function hasSingleCursorInFile(editor) {
  return (
    editor.selections.length === 1 && editor.selection.active.line < editor.document.lineCount
  );
}

function blameOptions(document, settings) {
  const dirty = document.isDirty && settings.get('blameDirtyFiles', true);
  return {
    ...gitOptions(),
    contents: dirty ? document.getText() : undefined,
    ignoreWhitespace: settings.get('ignoreWhitespace', true),
  };
}

/** Blame for one line, from the cache when possible. Null means git has none. */
async function blameForLine(document, repoRoot, line, settings) {
  const cache = cacheFor(document);
  const cached = cache.lines.get(line);
  if (cached !== undefined) return cached;

  const options = blameOptions(document, settings);

  // Blaming the whole file costs about the same as blaming one line, so do
  // it once and every other line in the file answers instantly afterwards.
  if (!cache.whole && document.lineCount <= WHOLE_FILE_LINE_LIMIT) {
    if (await ensureWholeFileBlame(document, repoRoot)) {
      // A line git did not report has no blame; record that so we stop asking.
      const info = cache.lines.has(line) ? cache.lines.get(line) : null;
      cache.lines.set(line, info);
      return info;
    }

    // Whole-file blame failed. Fall back rather than blanking the file,
    // since the next line may well work.
    const failure = git.getLastError();
    log(`whole-file blame failed (${failure ? failure.message : 'unknown'}), falling back`);
  }

  const info = await git.blameLine(repoRoot, document.uri.fsPath, line, options);
  cache.lines.set(line, info);
  return info;
}

/** Put the annotation at the end of the line. False if the editor went away. */
function decorate(editor, line, text, hoverMessage) {
  const endOfLine = editor.document.lineAt(line).range.end;
  try {
    editor.setDecorations(decorationType, [
      {
        range: new vscode.Range(endOfLine, endOfLine),
        renderOptions: { after: { contentText: text } },
        hoverMessage,
      },
    ]);
    decorated = editor;
    return true;
  } catch (error) {
    log(`could not decorate: ${error && error.message}`);
    return false;
  }
}

function showInStatusBar(info, text, settings) {
  if (!settings.get('statusBar', true)) {
    statusBarItem.hide();
    return;
  }

  statusBarItem.text = `$(git-commit) ${text}`;
  statusBarItem.tooltip = info.uncommitted
    ? 'Uncommitted changes'
    : `${info.sha.slice(0, 8)} — click to show the commit`;
  statusBarItem.show();
}

function scheduleUpdate(editor) {
  if (timer) clearTimeout(timer);

  const delay = Math.max(0, config().get('delay', 200));
  timer = setTimeout(() => {
    timer = null;
    update(editor).catch((error) => log(`update failed: ${error && error.message}`));
  }, delay);
}

/**
 * The File History view in the activity bar: commits touching the active file,
 * newest first. Selecting one opens its patch.
 */
class FileHistoryProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.description = '';
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(commit) {
    const item = new vscode.TreeItem(
      commit.summary || '(no commit message)',
      vscode.TreeItemCollapsibleState.None
    );

    const when =
      config().get('dateStyle') === 'absolute'
        ? format.absoluteDate(commit.authorTime)
        : format.relativeDate(commit.authorTime);

    // The row is narrow and the description is the first thing to be cut, so
    // the date leads — it survives truncation, and the author is in the tooltip.
    item.description = `${format.compactDate(commit.authorTime)} · ${commit.author}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'hanblame.commit';
    item.tooltip = new vscode.MarkdownString(
      `**${commit.summary}**\n\n${commit.author} · ${when}\n\n\`${commit.sha.slice(0, 8)}\``
    );
    item.command = {
      command: 'hanblame.showCommit',
      title: 'Show commit',
      arguments: [{ repoRoot: commit.repoRoot, sha: commit.sha }],
    };

    return item;
  }

  async getChildren(element) {
    if (element) return [];

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      await vscode.commands.executeCommand('setContext', 'hanblame.hasHistory', false);
      return [];
    }

    const filePath = editor.document.uri.fsPath;
    const repoRoot = await resolveRepoRoot(filePath);
    if (!repoRoot) {
      await vscode.commands.executeCommand('setContext', 'hanblame.hasHistory', false);
      return [];
    }

    const commits = await git.getFileHistory(repoRoot, filePath, {
      ...gitOptions(),
      limit: Math.max(1, config().get('historyLimit', 50)),
    });

    await vscode.commands.executeCommand('setContext', 'hanblame.hasHistory', commits.length > 0);

    // Carry the repo root and today's path along, so each item can fetch its
    // own revision and diff it against the file on disk.
    return commits.map((commit) => ({ ...commit, repoRoot, filePath }));
  }
}

/**
 * Make sure the whole file's blame is cached, so callers can ask about any line
 * without each one paying for its own git call. Returns null when the file
 * cannot be blamed that way — too large, or git said no.
 */
async function ensureWholeFileBlame(document, repoRoot) {
  const cache = cacheFor(document);
  if (cache.whole) return cache;
  if (document.lineCount > WHOLE_FILE_LINE_LIMIT) return null;

  const all = await git.blameFile(repoRoot, document.uri.fsPath, blameOptions(document, config()));

  if (!all) return null;

  cache.whole = true;
  for (const [line, info] of all) cache.lines.set(line, info);
  return cache;
}

const SYMBOL_KIND_NAMES = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
  constructor: 'Constructor',
  interface: 'Interface',
  enum: 'Enum',
  namespace: 'Namespace',
  module: 'Module',
  struct: 'Struct',
  property: 'Property',
};

function allowedSymbolKinds() {
  const configured = config().get('codeLensKinds') || ['function', 'method', 'class', 'constructor'];
  const kinds = new Set();

  for (const name of configured) {
    const kind = vscode.SymbolKind[SYMBOL_KIND_NAMES[String(name).toLowerCase()]];
    if (kind !== undefined) kinds.add(kind);
  }

  return kinds;
}

/**
 * Walk the symbol tree into a flat list. VS Code hands back either
 * DocumentSymbol (nested, with `children`) or the older flat SymbolInformation
 * depending on the language extension, so both shapes are handled.
 */
function flattenSymbols(symbols, kinds, collected = []) {
  for (const symbol of symbols || []) {
    const range = symbol.range || (symbol.location && symbol.location.range);
    if (range && kinds.has(symbol.kind)) {
      collected.push({ name: symbol.name, range });
    }
    if (symbol.children && symbol.children.length) {
      flattenSymbols(symbol.children, kinds, collected);
    }
  }
  return collected;
}

/** A blame summary above every function, method and class in the file. */
class BlameCodeLensProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

  async provideCodeLenses(document, token) {
    if (!config().get('codeLens', false)) return [];
    if (document.uri.scheme !== 'file') return [];

    const repoRoot = await resolveRepoRoot(document.uri.fsPath);
    if (!repoRoot || token.isCancellationRequested) return [];

    const blocks = await symbolBlocks(document);
    if (!blocks.length || token.isCancellationRequested) return [];

    const cache = await ensureWholeFileBlame(document, repoRoot);
    if (!cache || token.isCancellationRequested) return [];

    const userEmail = await resolveUserEmail(repoRoot);
    if (token.isCancellationRequested) return [];

    const settings = config();
    return blocks
      .map((block) => blockLens(block, cache, repoRoot, userEmail, settings))
      .filter(Boolean);
  }
}

/**
 * The functions, classes etc. in a document that the user wants lenses on.
 *
 * Symbols come from whichever language extension owns this file. A language
 * with no symbol provider simply gets no lenses, which is the right outcome.
 */
async function symbolBlocks(document) {
  const kinds = allowedSymbolKinds();
  if (!kinds.size) return [];

  try {
    const symbols = await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    return flattenSymbols(symbols, kinds);
  } catch (error) {
    log(`no symbols for ${document.uri.fsPath}: ${error && error.message}`);
    return [];
  }
}

/** The blame for every line in a range that has any. */
function blameInRange(cache, range) {
  const infos = [];
  for (let line = range.start.line; line <= range.end.line; line++) {
    const info = cache.lines.get(line);
    if (info) infos.push(info);
  }
  return infos;
}

/** The lens above one block, or null when nothing in it has been committed. */
function blockLens(block, cache, repoRoot, userEmail, settings) {
  const summary = format.blockSummary(blameInRange(cache, block.range), {
    userEmail,
    useYou: settings.get('useYou', true),
    dateStyle: settings.get('dateStyle'),
  });
  if (!summary) return null;

  const { newest } = summary;
  return new vscode.CodeLens(new vscode.Range(block.range.start, block.range.start), {
    title: summary.text,
    command: newest ? 'hanblame.showCommit' : '',
    arguments: newest ? [{ repoRoot, sha: newest.sha }] : [],
  });
}

/** Serves `git show` output into a read-only editor tab. */
const commitContentProvider = {
  async provideTextDocumentContent(uri) {
    try {
      const params = JSON.parse(uri.query);

      if (params.kind === 'file') {
        return await git.getFileAtRevision(params.repoRoot, params.sha, params.path, gitOptions());
      }

      return await git.getCommitPatch(params.repoRoot, params.sha, gitOptions());
    } catch (error) {
      return `Could not load this from git.\n\n${(error && error.message) || error}`;
    }
  },
};

function shortSha(sha) {
  return sha.slice(0, 8);
}

/** Open a read-only editor showing the file as it was at that commit. */
async function openRevision(item) {
  if (!item || !item.sha || !item.path) return;

  const document = await vscode.workspace.openTextDocument(
    revisionUri(item.repoRoot, item.sha, item.path)
  );
  await vscode.window.showTextDocument(document, { preview: true });
}

/** Diff that revision against what is on disk right now. */
async function diffWithWorking(item) {
  if (!item || !item.sha || !item.path || !item.filePath) return;

  const name = item.filePath.split('/').pop();
  await vscode.commands.executeCommand(
    'vscode.diff',
    revisionUri(item.repoRoot, item.sha, item.path),
    vscode.Uri.file(item.filePath),
    `${name} @ ${shortSha(item.sha)} ↔ working copy`
  );
}

async function showCommit(arg) {
  const target = arg && arg.sha ? arg : current;
  if (!target || !target.sha) {
    vscode.window.showInformationMessage('Hanblame: no commit for this line yet.');
    return;
  }
  if (target.info && target.info.uncommitted) {
    vscode.window.showInformationMessage('Hanblame: this line has not been committed yet.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(commitUri(target.repoRoot, target.sha));
  await vscode.languages.setTextDocumentLanguage(document, 'diff');
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

async function copySha(arg) {
  const target = arg && arg.sha ? arg : current;
  if (!target || !target.sha) {
    vscode.window.showInformationMessage('Hanblame: no commit for this line yet.');
    return;
  }

  await vscode.env.clipboard.writeText(target.sha);
  vscode.window.showInformationMessage(`Copied ${target.sha.slice(0, 8)}`);
}

async function toggleCodeLens() {
  const settings = config();
  const next = !settings.get('codeLens', false);
  await settings.update('codeLens', next, vscode.ConfigurationTarget.Global);

  codeLensProvider.refresh();
  vscode.window.setStatusBarMessage(`Hanblame CodeLens ${next ? 'on' : 'off'}`, 2000);
}

async function toggleHeatmap() {
  const settings = config();
  const next = !settings.get('heatmap', true);
  await settings.update('heatmap', next, vscode.ConfigurationTarget.Global);

  if (!next) clearHeatmap(heatmapEditors.length ? heatmapEditors : vscode.window.activeTextEditor);
  else {
    heatmapKey = null;
    scheduleUpdate(vscode.window.activeTextEditor);
  }

  vscode.window.setStatusBarMessage(`Hanblame heatmap ${next ? 'on' : 'off'}`, 2000);
}

async function toggle() {
  const settings = config();
  const next = !settings.get('enabled', true);
  await settings.update('enabled', next, vscode.ConfigurationTarget.Global);

  if (!next) clear(vscode.window.activeTextEditor);
  else scheduleUpdate(vscode.window.activeTextEditor);

  vscode.window.setStatusBarMessage(`Hanblame ${next ? 'on' : 'off'}`, 2000);
}

async function copyShaFromTree(item) {
  const sha = item && (item.sha || (item.commit && item.commit.sha));
  if (!sha) return;

  await vscode.env.clipboard.writeText(sha);
  vscode.window.showInformationMessage(`Copied ${sha.slice(0, 8)}`);
}

function onConfigurationChanged(event) {
  const affects = (key) => event.affectsConfiguration(`hanblame${key}`);
  if (!affects('')) return;

  if (affects('.gitPath')) {
    git.resetGit();
    blameCache.clear();
    repoRootCache.clear();
    emailCache.clear();
  }
  if (affects('.heatmapColor')) {
    clearHeatmap();
    buildHeatmapTypes();
  }
  if (affects('.codeLens') || affects('.codeLensKinds')) {
    codeLensProvider.refresh();
  }
  scheduleUpdate(vscode.window.activeTextEditor);
}

function activate(context) {
  output = vscode.window.createOutputChannel('Hanblame');
  historyProvider = new FileHistoryProvider();
  codeLensProvider = new BlameCodeLensProvider();

  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2.5em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'hanblame.showCommit';

  buildHeatmapTypes();

  context.subscriptions.push(
    output,
    decorationType,
    statusBarItem,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, commitContentProvider),
    vscode.commands.registerCommand('hanblame.toggle', toggle),
    vscode.commands.registerCommand('hanblame.toggleHeatmap', toggleHeatmap),
    vscode.commands.registerCommand('hanblame.toggleCodeLens', toggleCodeLens),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.window.onDidChangeActiveColorTheme(() => {
      // Light and dark get different steps, so the ramp is rebuilt rather than
      // reused when the theme changes.
      buildHeatmapTypes();
      scheduleUpdate(vscode.window.activeTextEditor);
    }),
    vscode.commands.registerCommand('hanblame.copySha', copySha),
    vscode.commands.registerCommand('hanblame.showCommit', showCommit),
    vscode.commands.registerCommand('hanblame.diagnose', () =>
      diagnose().catch((error) => log(`diagnostics failed: ${error && error.message}`))
    ),
    vscode.commands.registerCommand('hanblame.refreshHistory', () => historyProvider.refresh()),
    vscode.commands.registerCommand('hanblame.copyShaFromTree', copyShaFromTree),
    vscode.commands.registerCommand('hanblame.openRevision', (item) =>
      openRevision(item).catch((error) =>
        vscode.window.showErrorMessage(`Hanblame: ${(error && error.message) || error}`)
      )
    ),
    vscode.commands.registerCommand('hanblame.diffWithWorking', (item) =>
      diffWithWorking(item).catch((error) =>
        vscode.window.showErrorMessage(`Hanblame: ${(error && error.message) || error}`)
      )
    ),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      clear(editor);
      scheduleUpdate(editor);
      historyProvider.refresh();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => scheduleUpdate(event.textEditor)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      // Saving can rewrite line numbers (formatters, trailing newlines), so the
      // saved file needs blaming again — but only that file. Wiping every
      // cached file made switching tabs pay for a fresh blame each time.
      blameCache.delete(document.uri.toString());
      heatmapKey = null;
      scheduleUpdate(vscode.window.activeTextEditor);
      historyProvider.refresh();
      codeLensProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(onConfigurationChanged)
  );

  // Registered on its own, because this is the one call that can fail for a
  // reason outside the code: if package.json on disk is newer than the manifest
  // VS Code loaded at startup, the view does not exist yet. Letting that throw
  // would take the event listeners above down with it and stop annotations
  // updating at all, so it fails quietly and a reload sorts it out.
  try {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('hanblame.fileHistory', historyProvider)
    );
  } catch (error) {
    log(
      `File History view is not available yet (${error && error.message}). ` +
        'Reload the window if the extension was just updated.'
    );
  }

  scheduleUpdate(vscode.window.activeTextEditor);
  log('Hanblame activated');

  // Locate git up front so a missing one is reported instead of silently
  // turning every annotation into nothing.
  const configured = (config().get('gitPath') || '').trim();
  git
    .resolveGit(configured || undefined)
    .then((found) => log(`using git at ${found.path} (${found.version})`))
    .catch((error) => {
      log(error.message);
      vscode.window
        .showWarningMessage(
          'Hanblame could not find git, so blame annotations are off.',
          'Show details'
        )
        .then((choice) => {
          if (choice === 'Show details') vscode.commands.executeCommand('hanblame.diagnose');
        });
    });
}

function deactivate() {
  if (timer) clearTimeout(timer);
  disposeHeatmapTypes();
  blameCache.clear();
  repoRootCache.clear();
  emailCache.clear();
  bodyCache.clear();
}

module.exports = { activate, deactivate };

// Exposed for test/run.js, which loads this file against a stubbed vscode.
module.exports._internals = {
  commitUri,
  revisionUri,
  heatStep,
  flattenSymbols,
  HEATMAP_STEPS,
};
