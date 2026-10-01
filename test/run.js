'use strict';

/**
 * Self-contained checks for the git and formatting layers.
 * Builds a throwaway repo in the system temp folder, runs against it, cleans up.
 *
 *   node test/run.js
 *
 * These cover everything except the VS Code layer itself, which needs the
 * editor running to exercise.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const git = require('../git');
const format = require('../format');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hanblame-test-'));
  const run = (args, env) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, stdio: 'pipe' });

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'First Author']);
  run(['config', 'user.email', 'first@example.com']);

  fs.writeFileSync(path.join(repo, 'app.js'), 'line one\nline two\nline three\n');
  run(['add', 'app.js']);
  run(['commit', '-q', '-m', 'Add the first three lines', '-m', 'Body text for the hover card.'], {
    GIT_AUTHOR_DATE: '2026-08-01T10:00:00+0100',
    GIT_COMMITTER_DATE: '2026-08-01T10:00:00+0100',
  });

  fs.writeFileSync(path.join(repo, 'app.js'), 'line one\nline two CHANGED\nline three\nline four\n');
  run(['config', 'user.name', 'Second Author']);
  run(['config', 'user.email', 'second@example.com']);
  run(['add', 'app.js']);
  run(['commit', '-q', '-m', 'Change line two and add line four'], {
    GIT_AUTHOR_DATE: '2026-09-15T09:00:00+0100',
    GIT_COMMITTER_DATE: '2026-09-15T09:00:00+0100',
  });

  run(['config', 'user.name', 'First Author']);
  run(['config', 'user.email', 'first@example.com']);
  fs.writeFileSync(path.join(repo, 'untracked.js'), 'untracked\n');

  return repo;
}

(async () => {
  const repo = setup();
  const file = path.join(repo, 'app.js');

  try {
    console.log('\nrepo discovery');
    const root = await git.findRepoRoot(file);
    check('finds the repo root', () =>
      assert.strictEqual(fs.realpathSync(root), fs.realpathSync(repo)));

    const outside = await git.findRepoRoot('/usr/lib/os-release');
    check('outside a repo returns null', () => assert.strictEqual(outside, null));

    const email = await git.getUserEmail(repo);
    check('reads user.email', () => assert.strictEqual(email, 'first@example.com'));

    console.log('\nsingle-line blame');
    const line0 = await git.blameLine(repo, file, 0);
    const line1 = await git.blameLine(repo, file, 1);
    check('line 1 keeps its original author', () => {
      assert.ok(line0, 'no blame returned');
      assert.strictEqual(line0.author, 'First Author');
      assert.strictEqual(line0.summary, 'Add the first three lines');
      assert.strictEqual(line0.uncommitted, false);
      assert.ok(line0.authorTime instanceof Date);
    });
    check('line 2 moves to the second author', () =>
      assert.strictEqual(line1.author, 'Second Author'));

    const pastEnd = await git.blameLine(repo, file, 99);
    check('line past end of file returns null', () => assert.strictEqual(pastEnd, null));

    const untracked = await git.blameLine(repo, path.join(repo, 'untracked.js'), 0);
    check('untracked file returns null', () => assert.strictEqual(untracked, null));

    console.log('\nwhole-file blame');
    const all = await git.blameFile(repo, file);
    check('one entry per line', () => assert.strictEqual(all.size, 4));
    check('agrees with single-line blame', () => {
      assert.strictEqual(all.get(0).sha, line0.sha);
      assert.strictEqual(all.get(1).sha, line1.sha);
    });
    check('lines from one commit share an object', () =>
      assert.strictEqual(all.get(0), all.get(2)));

    const dirty = await git.blameFile(repo, file, {
      contents: 'line one\nEDITED IN THE EDITOR\nline three\nline four\n',
    });
    check('unsaved edits show as uncommitted', () => {
      assert.ok(dirty.get(1).uncommitted);
      assert.ok(!dirty.get(0).uncommitted);
    });

    console.log('\nparser');
    check('junk input does not throw', () => {
      assert.strictEqual(git.parsePorcelainAll('garbage\n').size, 0);
      assert.strictEqual(git.parsePorcelain('garbage\n'), null);
    });
    check('zero sha reads as uncommitted', () => {
      const info = git.parsePorcelain(
        [`${git.UNCOMMITTED_SHA} 1 1 1`, 'author Not Committed Yet', '\tcode'].join('\n')
      );
      assert.strictEqual(info.uncommitted, true);
    });

    console.log('\ncommit detail');
    const body = await git.getCommitBody(repo, line0.sha);
    check('reads the full commit message', () => assert.ok(body.includes('Body text')));
    const patch = await git.getCommitPatch(repo, line1.sha);
    check('reads the commit patch', () => assert.ok(patch.includes('diff --git')));

    console.log('\nformatting');
    const now = new Date('2026-09-17T12:00:00Z');
    check('relative dates read plainly', () => {
      assert.strictEqual(format.relativeDate(new Date('2026-09-16T12:00:00Z'), now), '1 day ago');
      assert.strictEqual(format.relativeDate(new Date('2026-09-10T12:00:00Z'), now), '1 week ago');
      assert.strictEqual(format.relativeDate(new Date('2026-09-17T11:59:55Z'), now), 'just now');
    });
    check('default template', () =>
      assert.strictEqual(
        format.annotation(line1, { now }),
        'Second Author, 2 days ago • Change line two and add line four'
      ));
    check('own commits say You', () =>
      assert.ok(format.annotation(line0, { userEmail: 'first@example.com', now }).startsWith('You, ')));
    check('long messages truncate', () => {
      const text = format.annotation({ ...line1, summary: 'x'.repeat(200) }, { maxMessageLength: 20, now });
      assert.ok(text.endsWith('…'));
    });
    check('uncommitted lines get their own label', () =>
      assert.strictEqual(format.annotation(dirty.get(1), { now }), 'Uncommitted changes'));
    check('custom templates work', () =>
      assert.strictEqual(
        format.annotation(line1, { format: '${shortSha} ${author}', now }),
        `${line1.sha.slice(0, 8)} Second Author`
      ));

    check('compact dates stay short for narrow rows', () => {
      const ago = (seconds) => new Date(now.getTime() - seconds * 1000);
      assert.strictEqual(format.compactDate(ago(30), now), 'now');
      assert.strictEqual(format.compactDate(ago(60 * 5), now), '5m');
      assert.strictEqual(format.compactDate(ago(3600 * 6), now), '6h');
      assert.strictEqual(format.compactDate(ago(86400 * 6), now), '6d');
      assert.strictEqual(format.compactDate(ago(86400 * 20), now), '2w');
      assert.strictEqual(format.compactDate(ago(86400 * 90), now), '3mo');
      assert.strictEqual(format.compactDate(ago(86400 * 800), now), '2y');
      assert.strictEqual(format.compactDate(null, now), '');
    });

    check('every compact date fits in a few characters', () => {
      for (const days of [0, 0.01, 1, 6, 13, 29, 200, 400, 4000]) {
        const text = format.compactDate(new Date(now.getTime() - days * 86400000), now);
        assert.ok(text.length <= 4, `"${text}" is too long for the row`);
      }
    });

    console.log('\ncodeLens block summaries');
    const at = (iso) => new Date(iso);
    const commit = (author, mail, iso, sha = 'a'.repeat(40)) => ({
      author,
      authorMail: mail,
      authorTime: at(iso),
      sha,
      summary: 'some change',
      uncommitted: false,
    });

    const older = commit('First Author', 'first@example.com', '2026-09-10T12:00:00Z', 'a'.repeat(40));
    const newer = commit('Second Author', 'second@example.com', '2026-09-16T12:00:00Z', 'b'.repeat(40));

    check('one author reads as a name and a date', () => {
      const summary = format.blockSummary([older, older], { now });
      assert.strictEqual(summary.text, 'First Author, 1 week ago');
      assert.strictEqual(summary.authors, 1);
    });

    check('several authors are counted', () => {
      const summary = format.blockSummary([older, newer, older], { now });
      assert.strictEqual(summary.text, '2 authors, last changed 1 day ago');
      assert.strictEqual(summary.authors, 2);
    });

    check('the date belongs to the newest commit, not the first line', () => {
      const summary = format.blockSummary([older, newer], { now });
      assert.strictEqual(summary.newest.sha, newer.sha);
    });

    check('order of lines does not matter', () => {
      const forwards = format.blockSummary([older, newer], { now });
      const backwards = format.blockSummary([newer, older], { now });
      assert.strictEqual(forwards.text, backwards.text);
      assert.strictEqual(forwards.newest.sha, backwards.newest.sha);
    });

    check('one person under two spellings counts once', () => {
      const alias = { ...older, author: 'First A.' };
      const summary = format.blockSummary([older, alias], { now });
      assert.strictEqual(summary.authors, 1);
    });

    check('your own block says You', () => {
      const summary = format.blockSummary([older], { userEmail: 'first@example.com', now });
      assert.ok(summary.text.startsWith('You, '), `got: ${summary.text}`);
    });

    check('a block of only your own uncommitted edits says so', () => {
      const summary = format.blockSummary([{ ...older, uncommitted: true }], { now });
      assert.strictEqual(summary.text, 'Uncommitted');
      assert.strictEqual(summary.newest, null);
    });

    check('uncommitted lines do not hide the committed ones', () => {
      const summary = format.blockSummary([{ ...older, uncommitted: true }, newer], { now });
      assert.strictEqual(summary.text, 'Second Author, 1 day ago');
    });

    check('an empty block produces no lens at all', () => {
      assert.strictEqual(format.blockSummary([]), null);
      assert.strictEqual(format.blockSummary([null, undefined]), null);
    });

    check('absolute dates are honoured here too', () => {
      const summary = format.blockSummary([newer], { dateStyle: 'absolute', now });
      assert.match(summary.text, /Second Author, \d{4}-\d{2}-\d{2}/);
    });

    console.log('\nfile history');
    const history = await git.getFileHistory(repo, file);
    check('lists both commits, newest first', () => {
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].summary, 'Change line two and add line four');
    });
    check('each commit knows its path at that commit', () =>
      assert.ok(history.every((commit) => commit.path === 'app.js')));

    const atRevision = await git.getFileAtRevision(repo, history[1].sha, history[1].path);
    check('reads the file back at an older revision', () => {
      assert.strictEqual(atRevision, 'line one\nline two\nline three\n');
    });

    const limited = await git.getFileHistory(repo, file, { limit: 1 });
    check('history limit is respected', () => assert.strictEqual(limited.length, 1));

    const noHistory = await git.getFileHistory(repo, path.join(repo, 'untracked.js'));
    check('untracked file has no history', () => assert.deepStrictEqual(noHistory, []));

    console.log('\nrevision URIs');
    // extension.js needs a vscode module; stub the two bits these helpers touch.
    const Module = require('module');
    const realResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'vscode') return 'vscode';
      return realResolve.call(this, request, ...rest);
    };
    require.cache.vscode = {
      id: 'vscode',
      filename: 'vscode',
      loaded: true,
      exports: {
        Uri: { from: (parts) => parts, file: (p) => ({ fsPath: p }) },
        EventEmitter: class {
          constructor() {
            this.event = () => {};
          }
          fire() {}
        },
        TreeItem: class {},
        TreeItemCollapsibleState: { None: 0 },
        ThemeIcon: class {},
        ThemeColor: class {},
        MarkdownString: class {},
        DecorationRangeBehavior: { ClosedOpen: 0 },
        StatusBarAlignment: { Right: 2 },
        window: {},
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        commands: {},
        languages: {},
        env: {},
        ConfigurationTarget: { Global: 1 },
        Range: class {},
        CodeLens: class {},
        SymbolKind: {
          Module: 1,
          Namespace: 2,
          Class: 4,
          Method: 5,
          Property: 6,
          Constructor: 8,
          Enum: 9,
          Interface: 10,
          Function: 11,
          Struct: 22,
        },
      },
    };

    const { revisionUri, commitUri } = require('../extension')._internals;

    check('revision URI keeps the extension for syntax highlighting', () => {
      const uri = revisionUri('/repo', 'a'.repeat(40), 'src/deep/app.js');
      assert.strictEqual(uri.path, `app@${'a'.repeat(8)}.js`);
    });
    check('revision URI carries the path as of that commit', () => {
      const uri = revisionUri('/repo', 'b'.repeat(40), 'old/name.ts');
      const query = JSON.parse(uri.query);
      assert.strictEqual(query.kind, 'file');
      assert.strictEqual(query.path, 'old/name.ts');
      assert.strictEqual(query.repoRoot, '/repo');
    });
    check('handles a file with no extension', () => {
      const uri = revisionUri('/repo', 'c'.repeat(40), 'Makefile');
      assert.strictEqual(uri.path, `Makefile@${'c'.repeat(8)}`);
    });
    check('handles a dotfile', () => {
      const uri = revisionUri('/repo', 'd'.repeat(40), '.eslintrc');
      assert.strictEqual(uri.path, `.eslintrc@${'d'.repeat(8)}`);
    });
    check('commit URI is tagged as a patch', () => {
      const uri = commitUri('/repo', 'e'.repeat(40));
      assert.strictEqual(JSON.parse(uri.query).kind, 'patch');
      assert.ok(uri.path.endsWith('.diff'));
    });

    console.log('\nsymbol flattening');
    const { flattenSymbols } = require('../extension')._internals;
    const Kind = require.cache.vscode.exports.SymbolKind;
    const wanted = new Set([Kind.Function, Kind.Method, Kind.Class]);

    const nested = [
      {
        name: 'MyClass',
        kind: Kind.Class,
        range: { start: { line: 0 }, end: { line: 40 } },
        children: [
          {
            name: 'method',
            kind: Kind.Method,
            range: { start: { line: 5 }, end: { line: 12 } },
            children: [
              {
                name: 'inner',
                kind: Kind.Function,
                range: { start: { line: 7 }, end: { line: 9 } },
                children: [],
              },
            ],
          },
          {
            name: 'aField',
            kind: Kind.Property,
            range: { start: { line: 2 }, end: { line: 2 } },
            children: [],
          },
        ],
      },
    ];

    check('reaches symbols nested several levels deep', () => {
      const found = flattenSymbols(nested, wanted).map((s) => s.name);
      assert.deepStrictEqual(found, ['MyClass', 'method', 'inner']);
    });

    check('leaves out kinds that were not asked for', () =>
      assert.ok(!flattenSymbols(nested, wanted).some((s) => s.name === 'aField')));

    check('handles the older flat symbol shape', () => {
      // Some language extensions return SymbolInformation, where the range
      // lives under `location` instead of on the symbol itself.
      const flat = [
        { name: 'legacyFn', kind: Kind.Function, location: { range: { start: { line: 3 }, end: { line: 6 } } } },
        { name: 'legacyVar', kind: Kind.Property, location: { range: { start: { line: 9 }, end: { line: 9 } } } },
      ];
      const found = flattenSymbols(flat, wanted);
      assert.deepStrictEqual(found.map((s) => s.name), ['legacyFn']);
      assert.strictEqual(found[0].range.start.line, 3);
    });

    check('no symbols means no lenses, not a crash', () => {
      assert.strictEqual(flattenSymbols(undefined, wanted).length, 0);
      assert.strictEqual(flattenSymbols([], wanted).length, 0);
      assert.strictEqual(flattenSymbols(nested, new Set()).length, 0);
    });

    console.log('\nheatmap');
    const { heatStep, HEATMAP_STEPS } = require("../extension")._internals;
    const STEPS = HEATMAP_STEPS;
    const daysAgo = (n) => new Date(Date.now() - n * 86400000);

    const colour = require('../colour');

    check('a ramp has the requested number of steps', () =>
      assert.strictEqual(colour.buildRamp('#3FB950', { steps: STEPS }).length, STEPS));

    check('every step is a valid hex colour', () =>
      assert.ok(colour.buildRamp('#3FB950').every((c) => /^#[0-9A-F]{6}$/.test(c))));

    check('the ramp keeps one hue', () => {
      for (const base of ['#3FB950', '#D97706', '#3B82F6', '#A855F7']) {
        const hues = colour.buildRamp(base).map((c) => colour.hexToHsl(c).h);
        const spread = Math.max(...hues) - Math.min(...hues);
        assert.ok(spread < 2, `${base} spread over ${spread.toFixed(1)} degrees`);
      }
    });

    check('lightness is monotonic in both themes', () => {
      const light = colour.buildRamp('#3FB950', { dark: false }).map((c) => colour.hexToHsl(c).l);
      const dark = colour.buildRamp('#3FB950', { dark: true }).map((c) => colour.hexToHsl(c).l);
      assert.ok(light.every((l, i) => i === 0 || l > light[i - 1]), 'light ramp not monotonic');
      assert.ok(dark.every((l, i) => i === 0 || l < dark[i - 1]), 'dark ramp not monotonic');
    });

    check('dark is not just light flipped', () => {
      const light = colour.buildRamp('#3FB950', { dark: false });
      const dark = colour.buildRamp('#3FB950', { dark: true });
      assert.notDeepStrictEqual(dark, [...light].reverse());
    });

    check('the newest step stands out from the oldest', () => {
      for (const dark of [true, false]) {
        const ramp = colour.buildRamp('#3FB950', { dark });
        const first = colour.hexToHsl(ramp[0]).l;
        const last = colour.hexToHsl(ramp[ramp.length - 1]).l;
        assert.ok(Math.abs(first - last) > 0.4, `too little range in ${dark ? 'dark' : 'light'}`);
      }
    });

    check('accepts shorthand hex and a missing hash', () => {
      assert.ok(colour.hexToHsl('#0f0'));
      assert.ok(colour.hexToHsl('3FB950'));
      assert.strictEqual(colour.buildRamp('#0f0').length, 8);
    });

    check('falls back to the default on nonsense input', () => {
      const fallback = colour.buildRamp('not a colour');
      assert.deepStrictEqual(fallback, colour.buildRamp(colour.DEFAULT_COLOUR));
      assert.deepStrictEqual(colour.buildRamp(undefined), fallback);
      assert.deepStrictEqual(colour.buildRamp('#12345'), fallback);
    });

    check('a grey base does not produce a broken ramp', () => {
      const ramp = colour.buildRamp('#8B949E');
      assert.strictEqual(ramp.length, 8);
      assert.ok(ramp.every((c) => /^#[0-9A-F]{6}$/.test(c)));
    });

    check('hex and hsl round-trip closely', () => {
      for (const hex of ['#3FB950', '#D97706', '#3B82F6', '#FFFFFF', '#000000']) {
        const hsl = colour.hexToHsl(hex);
        const back = colour.hslToHex(hsl.h, hsl.s, hsl.l);
        assert.strictEqual(back.toUpperCase(), hex.toUpperCase());
      }
    });

    check('today lands on the hottest step', () =>
      assert.strictEqual(heatStep(daysAgo(0), 365, STEPS), 0));

    check('a year old lands on the coldest step', () =>
      assert.strictEqual(heatStep(daysAgo(365), 365, STEPS), STEPS - 1));

    check('anything older is clamped, never out of range', () => {
      assert.strictEqual(heatStep(daysAgo(5000), 365, STEPS), STEPS - 1);
      assert.strictEqual(heatStep(null, 365, STEPS), STEPS - 1);
    });

    check('a future timestamp does not go negative', () =>
      assert.strictEqual(heatStep(daysAgo(-10), 365, STEPS), 0));

    check('steps never fall outside the ramp', () => {
      for (const days of [0, 0.5, 1, 3, 7, 30, 90, 200, 364, 365, 400, 10000]) {
        const step = heatStep(daysAgo(days), 365, STEPS);
        assert.ok(step >= 0 && step < STEPS, `${days} days gave step ${step}`);
      }
    });

    check('age is scaled logarithmically, not linearly', () => {
      // The first week should spread across several steps; a linear scale would
      // squash it all into step 0.
      const week = [1, 2, 4, 7].map((d) => heatStep(daysAgo(d), 365, STEPS));
      assert.ok(new Set(week).size >= 3, `first week collapsed into ${new Set(week).size} step(s)`);
      // And the far end should not use up half the ramp on months 6-12.
      const late = [200, 250, 300, 364].map((d) => heatStep(daysAgo(d), 365, STEPS));
      assert.ok(new Set(late).size <= 2, `late months spread over ${new Set(late).size} steps`);
    });

    check('steps increase as code gets older', () => {
      const series = [0, 1, 7, 30, 120, 365].map((d) => heatStep(daysAgo(d), 365, STEPS));
      assert.ok(
        series.every((s, i) => i === 0 || s >= series[i - 1]),
        `not monotonic: ${series.join(',')}`
      );
    });

    check('a shorter max age compresses the scale', () => {
      // On a fast-moving repo, 30 days should already be the coldest step.
      assert.strictEqual(heatStep(daysAgo(30), 30, STEPS), STEPS - 1);
      assert.ok(heatStep(daysAgo(30), 365, STEPS) < STEPS - 1);
    });

    Module._resolveFilename = realResolve;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
