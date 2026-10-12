'use strict';

// Original report checker. This file contains no simulation engine or network calls.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_SCENARIO_BYTES = 1024 * 1024;

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function finite(value, label, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < 0 || (positive && value === 0)) {
    throw new Error(`${label} must be a finite ${positive ? 'positive' : 'nonnegative'} number.`);
  }
  return value;
}

function amounts(values, label) {
  if (!Array.isArray(values) || values.length > 10) {
    throw new Error(`${label} must contain at most 10 milestone amounts.`);
  }
  values.forEach(value => finite(value, label, true));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate amounts.`);
  return [...values].sort((a, b) => a - b);
}

function parseBudgets(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Explicit budgets are required (for example 1000:300).');
  }
  const entries = text.trim().split(/[,\n]/);
  if (entries.length > 10) throw new Error('At most 10 explicit budgets are supported.');
  const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const budgets = entries.map(entry => {
    const parts = entry.trim().split(':').map(part => part.trim());
    if (parts.length !== 2 || !parts.every(part => decimal.test(part))) {
      throw new Error('Every budget must be amount:maximum-seconds, separated by commas or newlines.');
    }
    return { amount: finite(Number(parts[0]), 'Budget amount', true),
      maxSeconds: finite(Number(parts[1]), 'Budget deadline') };
  });
  if (new Set(budgets.map(item => item.amount)).size !== budgets.length) {
    throw new Error('Budget amounts must be unique.');
  }
  return budgets;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Scenario contains a nonfinite number.');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  object(value, 'Scenario value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function validateReport(report, currentScenario, budgetText) {
  object(report, 'Report');
  object(currentScenario, 'Current scenario');
  const budgets = parseBudgets(budgetText);
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1) {
    throw new Error('Only CLI report schemaVersion 1 is supported.');
  }
  if (report.version !== undefined && report.version !== 1) {
    throw new Error('Unsupported report version marker. Browser reports use scenario.version 1.');
  }
  const comparison = ['candidate', 'baseline', 'comparison'].some(key => Object.hasOwn(report, key));
  if (comparison && (Object.hasOwn(report, 'scenario') || Object.hasOwn(report, 'milestones')
      || report.schemaVersion !== 1 || !Object.hasOwn(report, 'baseline') || !Object.hasOwn(report, 'candidate'))) {
    throw new Error('Ambiguous or unsupported comparison report; supply a version-1 CLI comparison.');
  }
  const selected = object(comparison ? report.candidate : report, 'Selected report');
  const scenario = object(selected.scenario, 'Report scenario');
  const summary = object(selected.summary, 'Report summary');
  if (scenario.version !== 1 || currentScenario.version !== 1) {
    throw new Error('Both scenarios must be version 1.');
  }
  const horizon = finite(scenario.horizonSeconds, 'Scenario horizon', true);
  const totalProduced = finite(summary.lifetimeEarned, 'Reported total production');
  if (summary.horizonSeconds !== horizon) throw new Error('Summary and scenario horizons disagree.');
  if (summary.purchasingTruncated !== false) {
    throw new Error('Truncated or unspecified purchase-cap results are not accepted; regenerate a complete report.');
  }
  if (budgets.some(item => item.maxSeconds > horizon)) {
    throw new Error('A deadline exceeds the reported horizon; regenerate a report covering the deadline.');
  }
  const currentAmounts = amounts(currentScenario.milestones, 'Current scenario milestones');
  const reportedAmounts = amounts(scenario.milestones, 'Report scenario milestones');
  const allowedAmounts = [...new Set([...currentAmounts, ...budgets.map(item => item.amount)])].sort((a, b) => a - b);
  if (allowedAmounts.length > 10 || canonical(reportedAmounts) !== canonical(allowedAmounts)) {
    throw new Error('Report milestone targets must equal current targets plus explicit budget targets; export a matching report.');
  }
  // The CLI may add explicit budget targets to its exported scenario. All other
  // fields must match exactly; object key order is irrelevant, array order is not.
  const currentFields = { ...currentScenario };
  const reportFields = { ...scenario };
  delete currentFields.milestones;
  delete reportFields.milestones;
  if (canonical(currentFields) !== canonical(reportFields)) {
    throw new Error('Report scenario differs from the current scenario; regenerate or export it again.');
  }
  if (!Array.isArray(selected.milestones) || selected.milestones.length !== reportedAmounts.length) {
    throw new Error('Reported milestones must cover the declared scenario targets exactly.');
  }
  const milestones = new Map();
  for (const item of selected.milestones) {
    object(item, 'Milestone');
    const amount = finite(item.amount, 'Milestone amount', true);
    if (milestones.has(amount)) throw new Error('Reported milestone amounts must be unique.');
    if (item.reached !== true && item.reached !== false) throw new Error('Milestone reached must be a boolean.');
    if (item.reached) {
      finite(item.timeSeconds, 'Reached milestone time');
      if (item.timeSeconds > horizon) throw new Error('Reached milestone time exceeds the report horizon.');
    } else if (item.timeSeconds !== null) {
      throw new Error('An unreached milestone must have a null time.');
    }
    if (item.reached !== (amount <= totalProduced)) {
      throw new Error('Milestone reached status contradicts the reported total production.');
    }
    milestones.set(amount, item);
  }
  if (canonical([...milestones.keys()].sort((a, b) => a - b)) !== canonical(reportedAmounts)) {
    throw new Error('Reported milestone amounts differ from the declared targets.');
  }
  let previousTime = -1;
  let unreachedSeen = false;
  for (const amount of reportedAmounts) {
    const item = milestones.get(amount);
    if (!item.reached) unreachedSeen = true;
    else if (unreachedSeen || item.timeSeconds < previousTime) {
      throw new Error('Cumulative production milestone timing is inconsistent.');
    } else previousTime = item.timeSeconds;
  }
  const checks = budgets.map(budget => {
    const milestone = milestones.get(budget.amount);
    if (!milestone) throw new Error('A requested milestone is missing; export it explicitly.');
    return { ...budget, reached: milestone.reached, timeSeconds: milestone.timeSeconds,
      passed: milestone.reached && milestone.timeSeconds <= budget.maxSeconds };
  });
  return { passed: checks.every(item => item.passed), checks, selection: comparison ? 'candidate' : 'single' };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readJson(workspace, relativePath, maxBytes) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error('Report and scenario paths must be relative to the workspace.');
  }
  const root = await fs.realpath(workspace);
  const lexical = path.resolve(root, relativePath);
  if (!within(root, lexical)) throw new Error('Input path leaves the workspace.');
  const resolved = await fs.realpath(lexical);
  if (!within(root, resolved)) throw new Error('Input symlink leaves the workspace.');
  const handle = await fs.open(resolved, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Input must be a regular JSON file.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > maxBytes) throw new Error('Input JSON file exceeds its documented size limit.');
    try {
      return JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('Input contains invalid JSON.');
    }
  } finally { await handle.close(); }
}

function optionsFrom(argv, env) {
  if (!argv.length) return { report: env.INPUT_REPORT, scenario: env.INPUT_SCENARIO, budgets: env.INPUT_BUDGETS };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--report', '--scenario', '--budgets'].includes(flag)
        || argv[index + 1] === undefined || Object.hasOwn(options, flag.slice(2))) {
      throw new Error('Usage: node check.cjs --report FILE --scenario FILE --budgets AMOUNT:SECONDS');
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

async function runner(argv = process.argv.slice(2), env = process.env) {
  let result;
  let exitCode = 1;
  try {
    const options = optionsFrom(argv, env);
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const [report, scenario] = await Promise.all([
      readJson(workspace, options.report, MAX_REPORT_BYTES),
      readJson(workspace, options.scenario, MAX_SCENARIO_BYTES),
    ]);
    result = validateReport(report, scenario, options.budgets);
    // Only validated numbers and fixed labels enter runner logs or summaries.
    for (const check of result.checks) {
      process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.amount} earned by ${check.maxSeconds}s: `
        + `${check.reached ? `${check.timeSeconds}s` : 'not reached'}\n`);
    }
    exitCode = result.passed ? 0 : 2;
  } catch (error) {
    const message = error.code ? 'Input file could not be read.' : error.message;
    process.stderr.write(`Pacing report check failed: ${message}\n`);
  }
  if (env.GITHUB_OUTPUT) {
    await fs.appendFile(env.GITHUB_OUTPUT, `passed=${result?.passed === true}\nchecked-count=${result?.checks.length ?? 0}\n`, 'utf8');
  }
  if (env.GITHUB_STEP_SUMMARY && result) {
    const rows = result.checks.map(item => `| ${item.amount} | ${item.maxSeconds} | ${item.timeSeconds ?? 'not reached'} | ${item.passed ? 'Pass' : 'Fail'} |`).join('\n');
    await fs.appendFile(env.GITHUB_STEP_SUMMARY,
      `## Pacing report deadlines\n\n| Earned amount | Maximum seconds | Reported seconds | Result |\n| --- | --- | --- | --- |\n${rows}\n\n`
      + 'This checks supplied report values and scenario consistency. It does not run the simulation or establish freshness, authenticity, or player behavior.\n', 'utf8');
  }
  return exitCode;
}

module.exports = { validateReport, parseBudgets, readJson, runner, MAX_REPORT_BYTES, MAX_SCENARIO_BYTES };
if (require.main === module) {
  runner().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Pacing report check failed: runner output could not be written.\n');
    process.exitCode = 1;
  });
}
