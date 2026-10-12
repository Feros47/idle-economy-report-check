# Idle Economy Report Check

Fail a GitHub Actions step when an exported idle-economy production milestone misses an explicit deadline, or when its scenario differs from the current scenario file. The check is free, MIT licensed and uses Node.js builtins only.

**This checks a supplied report. It does not run an economy simulation.** Export a new report after changing the scenario. Matching inputs do not prove regeneration, a correct simulation, an authentic report or real player behavior. Keep report generation in the same build when you need automatic regression detection.

## Try the original example locally

Use Node.js 20 or newer. The GitHub Action itself uses GitHub's Node.js 24 runtime.

```sh
node check.cjs --report examples/baseline-report.json --scenario examples/baseline.json --budgets 1000:300
node check.cjs --report examples/candidate-report.json --scenario examples/candidate-cost-growth.json --budgets 1000:300
```

The first passes: 1,000 coins were produced by 293.8247111111111 seconds. The second fails with exit code 2: the same target arrived at 312 seconds. The candidate changes only the seed-bed cost growth from 1.16 to 1.20. These are original hypothetical Cozy Garden results, not player data. Milestones count cumulative production before spending and exclude starting cash. The 300-second deadline is an example choice.

Import either scenario into the [free Workbench browser demo](https://idle-economy-workbench.feros47.chatgpt.site/demo/index.html), run it and use **Export full JSON report**. Use **Export scenario** to save the current normalized scenario. This free workflow needs no paid kit. The selected `best-payback` purchase policy is greedy and does not establish optimal play or retention.

## Use in a workflow

Use this repository as a local action, or reference a reviewed published commit or release. The example's `FULL_COMMIT_SHA` placeholder must be replaced with the actual reviewed 40-character commit SHA before use.

```yaml
name: Check exported economy report
on: [push, pull_request]
permissions:
  contents: read
jobs:
  pacing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # actions/checkout v6
        with:
          persist-credentials: false
      # Generate or export reports/candidate.json for this exact current scenario
      # before this step. A committed old report is not an automatic simulation.
      - name: Check supplied milestones
        uses: Feros47/idle-economy-report-check@FULL_COMMIT_SHA
        with:
          report: reports/candidate.json
          scenario: economy/candidate.json
          budgets: |
            100:90
            1000:300
```

The Action reads two workspace files, writes a numeric result table to the job summary and sets `passed` and `checked-count` outputs. It makes no network calls, executes no supplied code, requests no token or secret and writes neither input file. Keep ordinary pull-request checks unprivileged; no `pull_request_target` or write permission is required. GitHub itself still processes workflow data and logs, and runner usage follows the repository's GitHub plan.

## Inputs and report contract

| Input | Required value |
| --- | --- |
| `report` | Workspace-relative path to the full browser JSON report, version-1 single CLI report, or version-1 CLI comparison report. A comparison checks **candidate** only. |
| `scenario` | Workspace-relative path to the current version-1 scenario with all exported fields explicit. Save/export it from Workbench; omitted defaults, additional fields and changed array order do not match an exported report. |
| `budgets` | 1–10 unique `amount:maximum-seconds` checks, separated by commas or newlines. Amounts must be positive; deadlines may be zero and must fit inside the reported horizon. |

Browser exports have no root schema marker; their scenario has `version: 1`. CLI reports have `schemaVersion: 1`. Unknown supplied version markers are rejected. Report `passed` and `budgets` fields are ignored. An explicit Action budget must be in the reported milestone list. The CLI can add requested amounts to `scenario.milestones`; the Action permits precisely the union of current scenario targets and explicit Action budget targets, ignoring target order. All other scenario fields must match structurally, ignoring object-key order and preserving array order. CLI-added targets not requested by this Action must also be listed in the current scenario file.

The check rejects unknown versions, ambiguous comparison/single wrappers, duplicate targets, numeric strings, nonfinite/negative times, inconsistent reached/null pairs, times outside the horizon, impossible ordering of cumulative milestones and reached statuses that contradict the reported final production. An unreached requested target fails its deadline. Purchase-cap-truncated reports are rejected even if an earlier milestone passed: regenerate with sufficient purchase capacity. It does not independently validate generator economics, recompute milestones or verify other trace/summary arithmetic.

Paths must stay inside the workspace, including resolved symlink targets. No glob, URL or absolute-path inputs are supported. Reports are limited to 8 MiB; scenarios to 1 MiB. Only validated numbers and fixed labels appear in logs and summaries; scenario names, generator names, paths, traces and input bodies are not emitted.

Exit codes: **0** all explicit deadlines pass; **2** valid report with a missed/unreached deadline; **1** invalid inputs, inconsistent scenario/report, unreadable files or failed runner-output writing. Missing inputs fail explicitly even though metadata marks them required.

## Report generation and support

For manually exported reports, re-export after every scenario edit. For generated reports, run your trusted generator earlier in the same build and preserve failures; the checker cannot establish when or how a report was created. Review scenario and report changes together. Do not use a static passing fixture as evidence that a changing game's pacing is safe.

The optional [149 DKK Workbench developer kit](https://idle-economy-workbench.feros47.chatgpt.site/#bundle) includes the simulation CLI, engine source and offline application for generating reports. None of that engine or CLI code is included or required here. This repository's MIT license covers this checker, documentation and example data only.

This project was developed with AI assistance and tested against the original hypothetical examples. Report reproducible issues through this repository's Issues page; avoid player data, credentials or other secrets. Run the local suite with `node --test tests/check.test.cjs`.

The runtime and metadata follow the [official metadata reference](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax). Outputs and summaries use the documented [runner environment files](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands). This free Action remains useful independently of the paid kit; publishing source or a release does not establish adoption or sales.
