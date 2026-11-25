// Token Radar v3 — entrypoint.
//
// Reads the sealed snapshot, fits the value model on the launched peers,
// validates it held-out two ways, prices every board-eligible pre-token
// protocol with a conformal interval and token odds, and writes the board,
// the launched list, the excluded-protocol audit, the dashboard and the
// dossier with the kit's library.
//
// The value model is a size curve fitted from the snapshot itself —
// log(market cap) = intercept + slope * log(TVL) on the 128 launched peers
// — with every extra term (category, growth, age, chains) tested held-out
// and dropped when it loses. See lib/model.ts for the method and the
// dashboard's method panel for the fitted numbers.
//
// Fully deterministic: no clocks, no randomness, fixed key order, stable
// sorts. Two runs on the same snapshot write byte-identical output.
//
// Usage:
//   node main.ts --input <snapshot.json> --output <dir>
// Defaults: --input /input/snapshot.json, --output $MAKEFUN_OUTPUT_DIR or /output.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, productExclusionReason } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i];
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i];
    else if (argv[i].startsWith('--input=')) input = argv[i].slice('--input='.length);
    else if (argv[i].startsWith('--output=')) output = argv[i].slice('--output='.length);
    else throw new Error(`main.ts: unknown argument ${argv[i]}`);
  }
  return { input, output };
}

function fail(msg: string): never {
  throw new Error(`main.ts: ${msg}`);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const outDir = resolve(output);
  const snap = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const { rows, launched, excluded, validation, oddsFit, fallbackAge } = buildBoard(snap);

  // ---- gate assertions: fail loudly instead of writing a bad board ----
  if (rows.length < 100 || rows.length > 4000) {
    fail(`board has ${rows.length} rows, must be 100-4000`);
  }
  // The 758 audit: every protocol of the snapshot is accounted for exactly
  // once — ranked, excluded with a reason, or already launched.
  if (rows.length + excluded.length + launched.length !== snap.protocols.length) {
    fail(`audit does not add up: ${rows.length} ranked + ${excluded.length} excluded + ${launched.length} launched != ${snap.protocols.length} protocols`);
  }
  const rowSlugs = new Set(rows.map((r) => r.slug));
  for (const slug of snap.watchlist) {
    if (!rowSlugs.has(slug)) fail(`watchlist slug ${slug} missing from board`);
  }
  const bySlug = new Map(snap.protocols.map((p: { slug: string }) => [p.slug, p]));
  for (const r of rows) {
    const p = bySlug.get(r.slug);
    if (p === undefined) fail(`row ${r.slug} is not in the snapshot`);
    if (p.gecko_id !== null || p.symbol !== null) fail(`row ${r.slug} records a token`);
    const reason = productExclusionReason(p);
    if (reason !== null) fail(`row ${r.slug} fails the product rule: ${reason}`);
  }
  const ranks = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.rank !== i + 1) fail(`row ${r.slug} has rank ${r.rank}, expected ${i + 1}`);
    if (ranks.has(r.rank)) fail(`duplicate rank ${r.rank}`);
    ranks.add(r.rank);
    if (i > 0 && rows[i].implied_value_usd >= rows[i - 1].implied_value_usd) {
      fail(`implied value rises at rank ${r.rank}`);
    }
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      fail(`row ${r.slug} has bad implied_value_usd ${r.implied_value_usd}`);
    }
    if (r.breakdown.implied !== r.implied_value_usd) {
      fail(`row ${r.slug} breakdown implied ${r.breakdown.implied} != implied_value_usd ${r.implied_value_usd}`);
    }
    if (!(r.value_low_usd < r.implied_value_usd && r.implied_value_usd < r.value_high_usd)) {
      fail(`row ${r.slug} has a bad conformal interval ${r.value_low_usd} / ${r.implied_value_usd} / ${r.value_high_usd}`);
    }
    if (!(r.rank_low <= r.rank && r.rank <= r.rank_high)) {
      fail(`row ${r.slug} has a bad rank range ${r.rank_low}-${r.rank_high} for rank ${r.rank}`);
    }
    if (!(r.token_odds >= 0.02 && r.token_odds <= 0.98)) {
      fail(`row ${r.slug} has token odds ${r.token_odds} outside [0.02, 0.98]`);
    }
    if (!['Farm', 'Farm small', 'Watch'].includes(r.verdict_label)) {
      fail(`row ${r.slug} has verdict label ${r.verdict_label}`);
    }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      fail(`row ${r.slug} has ${r.farm_steps.length} farm steps, must be 3-12`);
    }
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) fail(`row ${r.slug} has a farm step of ${len} chars, must be 20-600`);
    }
  }
  for (let i = 1; i < launched.length; i++) {
    if ((launched[i].mcap_usd ?? -1) > (launched[i - 1].mcap_usd ?? -1)) {
      fail('launched list is not sorted by mcap desc');
    }
  }
  for (let i = 1; i < excluded.length; i++) {
    if (excluded[i].tvl_usd > excluded[i - 1].tvl_usd) fail('excluded list is not sorted by TVL desc');
  }
  // No extra term may have slipped into the shipped model: the board's
  // breakdown must carry exactly the fitted size curve.
  for (const t of validation.termTests) {
    if (t.kept) fail(`term test ${t.term} was kept; the shipped model must be the size curve alone`);
  }

  const board = {
    as_of: snap.as_of,
    model: {
      formula: 'log(market cap) = intercept + slope * log(TVL), fitted by OLS on the launched peers; implied value = exp(intercept + slope * log(TVL))',
      intercept: round3(validation.intercept),
      slope: round3(validation.slope),
      peers: validation.peers,
      fitted_multiple_at_50m: round3(Math.exp(validation.intercept) * Math.pow(50_000_000, validation.slope - 1)),
      fitted_multiple_at_1b: round3(Math.exp(validation.intercept) * Math.pow(1_000_000_000, validation.slope - 1)),
      validation: {
        walk_forward: {
          train: validation.walkForward.train,
          test: validation.walkForward.test,
          cutoff_listed_at: validation.walkForward.cutoff,
          model_mae_log: round3(validation.walkForward.modelMae),
          baseline_mae_log: round3(validation.walkForward.baselineMae),
          times_better_than_baseline: round3(validation.walkForward.ratio),
        },
        five_fold: {
          model_mae_log: round3(validation.fiveFold.modelMae),
          baseline_mae_log: round3(validation.fiveFold.baselineMae),
          times_better_than_baseline: round3(validation.fiveFold.ratio),
        },
        baseline: 'train-set median market-cap/TVL multiple',
        term_tests: validation.termTests.map((t) => ({
          term: t.label,
          walk_forward_mae_log: round3(t.walkForwardMae),
          walk_forward_vs_size_curve_only: round3(t.walkForwardVsBase),
          five_fold_mae_log: round3(t.fiveFoldMae),
          five_fold_vs_size_curve_only: round3(t.fiveFoldVsBase),
          kept: t.kept,
        })),
        note: 'A term is kept only when adding it beats the size curve alone on BOTH held-out splits. On this snapshot every extra term loses on both, so the shipped model is the size curve alone.',
      },
      conformal_interval: {
        q50_log: round3(validation.conformalQ50),
        q80_log: round3(validation.conformalQ80),
        factor_50: round3(validation.factor50),
        factor_80: round3(validation.factor80),
        method: 'leave-one-out absolute residuals of the fitted size curve; value range is the 80% interval, rank range the 50% interval',
      },
      token_odds: {
        method: 'share of protocols that record a token rises with age towards a fitted ceiling S_inf; odds a still-tokenless protocol launches from here = (S_inf - S(age)) / (1 - S(age))',
        s_inf: oddsFit.sInf,
        lambda: oddsFit.lambda,
        half_life_days: Math.round(oddsFit.halfLifeDays),
        fallback_age_days: fallbackAge,
        bins: oddsFit.bins.map((b) => ({ age_days: `${b.lo}-${b.hi}`, n: b.n, launched_share: round3(b.share) })),
      },
      verdict_rule: 'Farm when implied value >= $15M and token odds >= 0.80; Farm small when implied value >= $6M and odds >= 0.70; otherwise Watch. Each verdict states its budget, horizon, implied value range and peer odds.',
      note: 'No hardcoded protocol names; every figure derives from the sealed snapshot. Implied value is this entry\u2019s own claim, never a prediction of whether or when a token is issued.',
    },
    audit: {
      total_protocols: snap.protocols.length,
      ranked_pre_token: rows.length,
      excluded_pre_token: excluded.length,
      launched: launched.length,
      watchlist: snap.watchlist.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
    },
    count: rows.length,
    rows,
  };
  const launchedDoc = { as_of: snap.as_of, count: launched.length, rows: launched };
  const excludedDoc = { as_of: snap.as_of, count: excluded.length, rows: excluded };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'launched.json'), JSON.stringify(launchedDoc, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'excluded.json'), JSON.stringify(excludedDoc, null, 2) + '\n', 'utf8');

  const dashSrc = join(REPO_DIR, 'dashboard');
  const shotsSrc = join(REPO_DIR, 'screenshots');
  if (!existsSync(join(dashSrc, 'index.html'))) fail('dashboard/index.html missing from repo');
  if (!existsSync(shotsSrc)) fail('screenshots/ missing from repo');
  cpSync(dashSrc, join(outDir, 'dashboard'), { recursive: true });
  cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  // Gate size caps, checked on our own output before reporting success.
  const boardBytes = statSync(join(outDir, 'board.json')).size;
  const dossierBytes = statSync(join(outDir, 'dossier.json')).size;
  if (boardBytes > 8 * 1024 * 1024) fail(`board.json is ${boardBytes} bytes, over the 8 MiB cap`);
  if (dossierBytes > 1536 * 1024) fail(`dossier.json is ${dossierBytes} bytes, over the 1.5 MiB cap`);
  // The judge reads the dashboard's whole source only when it fits the
  // 65,536-byte text cap: fail loudly if any of it was cut.
  const dossierText = JSON.parse(Buffer.from(dossier).toString('utf8')).text as string;
  if (dossierText.includes('[Cut at')) fail('dossier text cut the dashboard source; shrink the dashboard');
  const dashBytes = ['index.html', 'app.css', 'app.js'].reduce((n, f) => n + statSync(join(outDir, 'dashboard', f)).size, 0);
  console.log(`Token Radar v3: ${rows.length} rows, ${launched.length} launched, ${excluded.length} excluded, top ${rows[0].slug} $${rows[0].implied_value_usd} (range $${rows[0].value_low_usd}-$${rows[0].value_high_usd}) -> ${outDir} (board ${boardBytes} B, dossier ${dossierBytes} B, dashboard source ${dashBytes} B)`);
  console.log(`Model: log(mcap) = ${round3(validation.intercept)} + ${round3(validation.slope)}*log(TVL) on ${validation.peers} peers; walk-forward ${round3(validation.walkForward.modelMae)} vs baseline ${round3(validation.walkForward.baselineMae)} (${round3(validation.walkForward.ratio)}x); 5-fold ${round3(validation.fiveFold.modelMae)} vs ${round3(validation.fiveFold.baselineMae)} (${round3(validation.fiveFold.ratio)}x); conformal x${round3(validation.factor80)} (80%)`);
}

main();
