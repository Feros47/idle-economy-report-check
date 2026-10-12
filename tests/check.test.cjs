'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateReport, parseBudgets, readJson, MAX_REPORT_BYTES } = require('../check.cjs');

const root = path.resolve(__dirname, '..');
const fixture = name => JSON.parse(readFileSync(path.join(root, 'examples', name), 'utf8').replace(/^\uFEFF/, ''));
const baseline = fixture('baseline-report.json');
const candidate = fixture('candidate-report.json');
const baseScenario = fixture('baseline.json');
const candidateScenario = fixture('candidate-cost-growth.json');
const clone = value => structuredClone(value);

async function temporary(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'workbench-report-check-'));
  assert.equal(path.dirname(directory), temporaryRoot);
  t.after(async () => {
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('workbench-report-check-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function cli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'check.cjs'), ...args], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...extraEnv },
  });
}

test('verified browser baseline passes two explicit deadlines', () => {
  const result = validateReport(baseline, baseScenario, '100:90\n1000:300');
  assert.equal(result.passed, true);
  assert.equal(result.selection, 'single');
  assert.equal(result.checks[1].timeSeconds, 293.8247111111111);
});

test('verified browser candidate fails despite forged report flags', () => {
  const report = { ...clone(candidate), passed: true, budgets: [{ amount: 1000, passed: true }] };
  const result = validateReport(report, candidateScenario, '1000:300');
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].timeSeconds, 312);
});

test('a reported time exactly at the deadline passes', () => {
  assert.equal(validateReport(candidate, candidateScenario, '1000:312').passed, true);
});

test('version-1 CLI comparison checks candidate, not its passing baseline', () => {
  const report = { schemaVersion: 1, baseline, candidate, comparison: {}, passed: true, budgets: [] };
  const result = validateReport(report, candidateScenario, '1000:300');
  assert.equal(result.selection, 'candidate');
  assert.equal(result.passed, false);
});

test('CLI-added requested targets are allowed without weakening other field comparison', () => {
  const source = clone(baseScenario);
  source.milestones = [1000, 100];
  const report = { ...clone(baseline), schemaVersion: 1 };
  assert.equal(validateReport(report, source, '10000:600').passed, true);
  source.generators[0].costGrowth = 1.2;
  assert.throws(() => validateReport(report, source, '10000:600'), /differs from the current/);
});

test('changed scenario data and changed array ordering cannot reuse an old report', () => {
  assert.throws(() => validateReport(baseline, candidateScenario, '1000:300'), /differs from the current/);
  const changed = clone(baseScenario);
  changed.generators.reverse();
  assert.throws(() => validateReport(baseline, changed, '1000:300'), /differs from the current/);
});

test('object key order does not affect matching exported data', () => {
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  assert.equal(validateReport(baseline, reverseKeys(baseScenario), '1000:300').passed, true);
});

test('missing requested milestone cannot be inferred from final production', () => {
  const report = clone(baseline);
  report.scenario.milestones = [100, 10000];
  report.milestones = report.milestones.filter(item => item.amount !== 1000);
  assert.throws(() => validateReport(report, baseScenario, '1000:300'), /targets/);
});

test('unreached requested milestone fails instead of passing a null numeric comparison', () => {
  const report = clone(baseline);
  report.milestones[2].reached = false;
  report.milestones[2].timeSeconds = null;
  report.summary.lifetimeEarned = 9000;
  const result = validateReport(report, baseScenario, '10000:600');
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].timeSeconds, null);
});

test('empty, duplicate, malformed and nonfinite budgets fail', () => {
  for (const value of ['', ' ', '1000:300,1000:400', '1000:300,,100:90', '0:300',
    '-1:300', '1000:-1', '1000:Infinity', '1000:1e999', '1000:', '1000:300:400']) {
    assert.throws(() => parseBudgets(value), undefined, value);
  }
});

test('malformed milestone values, duplicate targets and inconsistent timing fail', () => {
  const mutations = [
    r => { r.milestones[1].timeSeconds = '293'; },
    r => { r.milestones[1].timeSeconds = -1; },
    r => { r.milestones[1].timeSeconds = Infinity; },
    r => { r.milestones[1].timeSeconds = null; },
    r => { r.milestones[1].reached = 'true'; },
    r => { r.milestones[1].reached = false; },
    r => { r.milestones[1].amount = r.milestones[0].amount; },
    r => { r.milestones[1].timeSeconds = 2000; },
    r => { r.milestones[1].timeSeconds = 1; },
    r => { r.milestones[1].reached = false; r.milestones[1].timeSeconds = null; },
  ];
  for (const mutate of mutations) {
    const report = clone(baseline);
    mutate(report);
    assert.throws(() => validateReport(report, baseScenario, '1000:300'));
  }
});

test('unknown versions, ambiguous wrappers, truncated reports and short horizons fail', () => {
  const mutations = [
    r => { r.schemaVersion = 2; },
    r => { r.version = 2; },
    r => { r.candidate = clone(candidate); r.baseline = clone(baseline); r.schemaVersion = 1; },
    r => { r.baseline = {}; },
    r => { r.summary.purchasingTruncated = true; },
    r => { delete r.summary.purchasingTruncated; },
    r => { r.summary.horizonSeconds = 1200; },
  ];
  for (const mutate of mutations) {
    const report = clone(baseline);
    mutate(report);
    assert.throws(() => validateReport(report, baseScenario, '1000:300'));
  }
  assert.throws(() => validateReport(baseline, baseScenario, '1000:1801'), /exceeds the reported horizon/);
  assert.equal(validateReport(baseline, baseScenario, '1000:0').passed, false);
});

test('obvious production contradictions fail while untagged browser reports remain supported', () => {
  assert.equal(validateReport(baseline, baseScenario, '1000:300').passed, true);
  for (const produced of [0, -1, '624759', Infinity]) {
    const report = clone(baseline);
    report.summary.lifetimeEarned = produced;
    assert.throws(() => validateReport(report, baseScenario, '1000:300'));
  }
});

test('reader accepts BOM and rejects malformed JSON, oversized data and outside paths', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'bom.json'), '\uFEFF{"ok":true}');
  assert.deepEqual(await readJson(directory, 'bom.json', 64), { ok: true });
  await fs.writeFile(path.join(directory, 'bad.json'), '{invalid');
  await assert.rejects(readJson(directory, 'bad.json', 64), /invalid JSON/);
  await fs.writeFile(path.join(directory, 'big.json'), JSON.stringify({ text: 'x'.repeat(64) }));
  await assert.rejects(readJson(directory, 'big.json', 64), /size limit/);
  await assert.rejects(readJson(directory, '../outside.json', 64), /leaves the workspace/);
  await assert.rejects(readJson(directory, path.join(directory, 'bom.json'), 64), /relative/);
});

test('8 MiB report limit accepts comparison-sized JSON above the previous 4 MiB cap', async t => {
  const directory = await temporary(t);
  const large = { ...clone(baseline), unusedTraceFixture: 'x'.repeat(4 * 1024 * 1024) };
  await fs.writeFile(path.join(directory, 'large.json'), JSON.stringify(large));
  const report = await readJson(directory, 'large.json', MAX_REPORT_BYTES);
  assert.equal(validateReport(report, baseScenario, '1000:300').passed, true);
});

test('reader rejects symlinks that resolve outside the workspace', async t => {
  const directory = await temporary(t);
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  const outside = path.join(directory, 'outside.json');
  await fs.writeFile(outside, '{"ok":true}');
  try { await fs.symlink(outside, path.join(workspace, 'link.json'), 'file'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks; Linux CI exercises this check.'); return; }
    throw error;
  }
  await assert.rejects(readJson(workspace, 'link.json', 64), /symlink leaves the workspace/);
});

test('entry point preserves pass/fail/invalid exit codes and writes runner outputs', async t => {
  const directory = await temporary(t);
  const output = path.join(directory, 'outputs');
  const summary = path.join(directory, 'summary');
  const passing = cli(['--report', 'examples/baseline-report.json', '--scenario', 'examples/baseline.json', '--budgets', '1000:300'],
    { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'passed=true\nchecked-count=1\n');
  assert.match(await fs.readFile(summary, 'utf8'), /293\.8247111111111/);
  const failing = cli(['--report', 'examples/candidate-report.json', '--scenario', 'examples/candidate-cost-growth.json', '--budgets', '1000:300']);
  assert.equal(failing.status, 2);
  assert.match(failing.stdout, /FAIL 1000 earned by 300s: 312s/);
  assert.equal(cli(['--report', 'examples/baseline-report.json', '--scenario', 'examples/baseline.json', '--budgets', '']).status, 1);
});

test('Action input environment works and missing required inputs fail explicitly', () => {
  assert.equal(cli([], { INPUT_REPORT: 'examples/baseline-report.json', INPUT_SCENARIO: 'examples/baseline.json', INPUT_BUDGETS: '1000:300' }).status, 0);
  assert.equal(cli([], { INPUT_REPORT: '', INPUT_SCENARIO: '', INPUT_BUDGETS: '' }).status, 1);
});

test('input names and attempted workflow commands are absent from output', async t => {
  const directory = await temporary(t);
  const report = clone(baseline);
  const scenario = clone(baseScenario);
  report.scenario.name = scenario.name = 'private scenario\n::error::injected';
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
  await fs.writeFile(path.join(directory, 'scenario.json'), JSON.stringify(scenario));
  const result = cli(['--report', 'report.json', '--scenario', 'scenario.json', '--budgets', '1000:300'], { GITHUB_WORKSPACE: directory });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /private scenario|::error::injected/);
});
