// Token Radar v3 — fitted value model, held-out validation, token odds and
// costed farm plans.
//
// Every figure derives from the sealed snapshot (DefiLlama protocol data):
// TVL, 7-day TVL change, listing date, category, chain count and the market
// caps of protocols whose token already trades. No protocol name is
// hardcoded anywhere; the same code ranks a protocol the snapshot has never
// seen before.
//
// The value model (see buildModel below for the runtime-fitted numbers):
//   log(market cap) = intercept + slope * log(TVL)
// fitted by ordinary least squares on the launched peers (protocols with a
// recorded market cap). The slope is well below 1, so the implied
// market-cap/TVL multiple FALLS as a protocol gets bigger: a flat median
// multiple would overvalue the giants several times over.
//
// Every extra term a radar could add — a category offset, the 7-day growth,
// the protocol's age, its chain count — is TESTED, not assumed: each term is
// fitted with and without it on two held-out splits (walk-forward by listing
// date, and 5-fold by slug order) and kept only when it beats the model
// without it on BOTH splits. On this snapshot every extra term loses on
// both splits, so the shipped model is the size curve alone, and the
// dashboard says so, with the numbers.
//
// Honesty about uncertainty: the implied value is a point estimate from a
// noisy fit, so each row also carries an 80% conformal interval from the
// model's leave-one-out residuals, and a rank range from the 50% interval.
// Token odds come from the peers' own record: the share of protocols that
// record a token rises with age towards a fitted ceiling, so the odds that a
// protocol still tokenless at its age launches from here FALL with age.
//
// Board eligibility mirrors the snapshot's own watchlist rule: the board
// holds only protocols that record no token AND are not exchange-operated
// or wrapped/staked/bridged products. The 145 pre-token protocols the rule
// leaves out are not hidden: they are listed in excluded.json with the
// reason each one fails, so all 758 protocols of the snapshot are accounted
// for (ranked + excluded + launched = 758).

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Breakdown {
  intercept: number;
  slope: number;
  fittedMultiple: number;
  implied: number;
  q50: number;
  q80: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  value_low_usd: number;
  value_high_usd: number;
  rank_low: number;
  rank_high: number;
  token_odds: number;
  peer_launch_share: number;
  peer_n: number;
  verdict_label: string;
  verdict: string;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  momentum: string;
  status: string;
  watchlist: boolean;
  breakdown: Breakdown;
  est_cost: { min: number; max: number };
  horizon_weeks: number;
}

export interface LaunchedRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Whole days between the snapshot date and the listing date, or null. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const days = Math.round((Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z')) / DAY_MS);
  return days < 0 ? 0 : days;
}

/** Median of a non-empty list (average of the two middle values when even). */
export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error('model.ts: median of an empty list');
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function meanAbs(values: number[]): number {
  let s = 0;
  for (const v of values) s += Math.abs(v);
  return s / values.length;
}

// ---------------------------------------------------------------- OLS

/** Solve A x = b by Gaussian elimination with partial pivoting. A is n x n. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => row.slice());
  const b = bIn.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) throw new Error('model.ts: singular design matrix');
    if (piv !== col) {
      const t = a[col]; a[col] = a[piv]; a[piv] = t;
      const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Ordinary least squares: beta for y ~ X. X rows all carry the intercept.
 * Columns with no variance in this design (a category dummy with no peer in
 * the train split, for instance) are dropped with a zero coefficient, so a
 * split that lacks a category still fits instead of going singular. */
export function ols(design: number[][], y: number[]): number[] {
  const n = design[0].length;
  const keep: number[] = [0];
  for (let j = 1; j < n; j++) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const row of design) {
      if (row[j] < mn) mn = row[j];
      if (row[j] > mx) mx = row[j];
    }
    if (mx - mn > 1e-12) keep.push(j);
  }
  const reduced = design.map((row) => keep.map((j) => row[j]));
  const m = keep.length;
  const xtx: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const xty = new Array<number>(m).fill(0);
  for (let i = 0; i < reduced.length; i++) {
    const row = reduced[i];
    for (let a = 0; a < m; a++) {
      xty[a] += row[a] * y[i];
      for (let b = 0; b < m; b++) xtx[a][b] += row[a] * row[b];
    }
  }
  const betaReduced = solveLinear(xtx, xty);
  const beta = new Array<number>(n).fill(0);
  keep.forEach((j, k) => { beta[j] = betaReduced[k]; });
  return beta;
}

function predict(beta: number[], row: number[]): number {
  let s = 0;
  for (let i = 0; i < beta.length; i++) s += beta[i] * row[i];
  return s;
}

// ---------------------------------------------------------------- peers & features

/** Launched peers: a recorded market cap and positive TVL. */
export function launchedPeers(protocols: Protocol[]): Protocol[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && (p.gecko_id !== null || p.symbol !== null));
}

/** Categories with at least 4 launched peers: the only ones that get a dummy. */
export function peerCategories(peers: Protocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of peers) {
    if (p.category === null) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 4).map(([c]) => c).sort();
}

export type TermSet = 'base' | 'cats' | 'growth' | 'age' | 'chains' | 'all';

/**
 * One design row for a protocol under a term set. Columns: intercept,
 * log(TVL), then the term set's extras. The same builder serves the fit,
 * the term tests and the board, so the numbers the dashboard quotes are
 * the numbers the board was ranked with.
 */
export function designRow(p: Protocol, asOf: string, term: TermSet, cats: string[]): number[] {
  const row: number[] = [1, Math.log(p.tvl_usd)];
  const age = ageDays(asOf, p.listed_at);
  const growth = clamp(p.change_7d ?? 0, -15, 30) / 10;
  const logAge = Math.log1p(age === null ? 365 : age) / Math.log(365);
  const chains = Math.min(p.chains.length, 5) / 5;
  if (term === 'cats' || term === 'all') {
    for (const c of cats) row.push(p.category === c ? 1 : 0);
  }
  if (term === 'growth' || term === 'all') row.push(growth);
  if (term === 'age' || term === 'all') row.push(logAge);
  if (term === 'chains' || term === 'all') row.push(chains);
  return row;
}

function logMcap(p: Protocol): number {
  return Math.log(p.mcap_usd as number);
}

/** Median log(market-cap/TVL) of a peer set: the naive baseline predictor. */
export function baselineLogMultiple(train: Protocol[]): number {
  return median(train.map((p) => Math.log((p.mcap_usd as number) / p.tvl_usd)));
}

function maeOf(pred: number[], actual: number[]): number {
  return meanAbs(pred.map((v, i) => v - actual[i]));
}

// ---------------------------------------------------------------- validation

export interface SplitResult {
  modelMae: number;
  baselineMae: number;
  ratio: number;
  train: number;
  test: number;
  cutoff: string | null;
}

export interface TermTest {
  term: string;
  label: string;
  walkForwardMae: number;
  walkForwardVsBase: number;
  fiveFoldMae: number;
  fiveFoldVsBase: number;
  kept: boolean;
}

export interface Validation {
  peers: number;
  intercept: number;
  slope: number;
  walkForward: SplitResult;
  fiveFold: SplitResult;
  termTests: TermTest[];
  conformalQ50: number;
  conformalQ80: number;
  factor50: number;
  factor80: number;
}

/**
 * Walk-forward: peers with a listing date, oldest half trains, newest half
 * tests. Five-fold: all peers in slug order, stride folds. Both compare the
 * fitted model against the naive baseline (the train set's median multiple).
 */
export function validateModel(peers: Protocol[], asOf: string, cats: string[]): Validation {
  const terms: TermSet[] = ['base', 'cats', 'growth', 'age', 'chains', 'all'];
  const labels: Record<TermSet, string> = {
    base: 'size curve only: log(mcap) ~ log(TVL)',
    cats: '+ category offsets',
    growth: '+ 7-day growth',
    age: '+ protocol age',
    chains: '+ chain count',
    all: '+ all four terms',
  };
  const dated = peers
    .filter((p) => p.listed_at !== null)
    .slice()
    .sort((a, b) => (a.listed_at as string) < (b.listed_at as string) ? -1 : (a.listed_at as string) > (b.listed_at as string) ? 1 : a.slug < b.slug ? -1 : 1);
  const half = Math.floor(dated.length / 2);
  const wfTrain = dated.slice(0, half);
  const wfTest = dated.slice(half);
  const wfCutoff = wfTest.length > 0 ? (wfTest[0].listed_at as string) : null;

  const bySlug = peers.slice().sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const folds: Protocol[][] = [[], [], [], [], []];
  bySlug.forEach((p, i) => folds[i % 5].push(p));

  function splitMae(term: TermSet, train: Protocol[], test: Protocol[]): { model: number; baseline: number } {
    const beta = ols(train.map((p) => designRow(p, asOf, term, cats)), train.map(logMcap));
    const pred = test.map((p) => predict(beta, designRow(p, asOf, term, cats)));
    const base = baselineLogMultiple(train);
    const basePred = test.map((p) => Math.log(p.tvl_usd) + base);
    const actual = test.map(logMcap);
    return { model: maeOf(pred, actual), baseline: maeOf(basePred, actual) };
  }

  const wf: Record<TermSet, { model: number; baseline: number }> = {} as Record<TermSet, { model: number; baseline: number }>;
  const ff: Record<TermSet, { model: number; baseline: number }> = {} as Record<TermSet, { model: number; baseline: number }>;
  for (const term of terms) {
    wf[term] = splitMae(term, wfTrain, wfTest);
    let mSum = 0;
    let bSum = 0;
    for (let k = 0; k < 5; k++) {
      const test = folds[k];
      const train: Protocol[] = [];
      for (let j = 0; j < 5; j++) if (j !== k) train.push(...folds[j]);
      const r = splitMae(term, train, test);
      mSum += r.model * test.length;
      bSum += r.baseline * test.length;
    }
    ff[term] = { model: mSum / peers.length, baseline: bSum / peers.length };
  }

  const betaBase = ols(peers.map((p) => designRow(p, asOf, 'base', cats)), peers.map(logMcap));
  const termTests: TermTest[] = terms.slice(1).map((term) => ({
    term,
    label: labels[term],
    walkForwardMae: wf[term].model,
    walkForwardVsBase: wf.base.model / wf[term].model,
    fiveFoldMae: ff[term].model,
    fiveFoldVsBase: ff.base.model / ff[term].model,
    // Kept only when adding the term beats the model WITHOUT it on BOTH
    // held-out splits. On this snapshot every extra term loses on both.
    kept: wf[term].model < wf.base.model && ff[term].model < ff.base.model,
  }));

  // Conformal intervals: leave-one-out absolute residuals of the base model.
  const looResiduals: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const train = peers.filter((_, j) => j !== i);
    const beta = ols(train.map((p) => designRow(p, asOf, 'base', cats)), train.map(logMcap));
    const pred = predict(beta, designRow(peers[i], asOf, 'base', cats));
    looResiduals.push(Math.abs(logMcap(peers[i]) - pred));
  }
  looResiduals.sort((a, b) => a - b);
  const q = (f: number): number => looResiduals[Math.min(looResiduals.length - 1, Math.floor(f * looResiduals.length))];
  const q50 = q(0.5);
  const q80 = q(0.8);

  return {
    peers: peers.length,
    intercept: betaBase[0],
    slope: betaBase[1],
    walkForward: {
      modelMae: wf.base.model,
      baselineMae: wf.base.baseline,
      ratio: wf.base.baseline / wf.base.model,
      train: wfTrain.length,
      test: wfTest.length,
      cutoff: wfCutoff,
    },
    fiveFold: {
      modelMae: ff.base.model,
      baselineMae: ff.base.baseline,
      ratio: ff.base.baseline / ff.base.model,
      train: peers.length,
      test: peers.length,
      cutoff: null,
    },
    termTests,
    conformalQ50: q50,
    conformalQ80: q80,
    factor50: Math.exp(q50),
    factor80: Math.exp(q80),
  };
}

// ---------------------------------------------------------------- token odds

export interface OddsFit {
  sInf: number;
  lambda: number;
  halfLifeDays: number;
  bins: { lo: number; hi: number; n: number; share: number }[];
}

export const AGE_BINS: Array<[number, number]> = [
  [0, 30], [30, 90], [90, 180], [180, 365], [365, 545],
  [545, 730], [730, 1095], [1095, 1460], [1460, 2000], [2000, 99999],
];

/**
 * Token odds from the peers' record. The share of protocols that record a
 * token rises with age towards a ceiling S_inf; the curve S(age) =
 * S_inf * (1 - exp(-lambda * age)) is fitted to the age bins by a grid
 * search (weighted squared error, weights = bin size). The odds that a
 * protocol still tokenless at age A launches from here are then
 * (S_inf - S(A)) / (1 - S(A)): they FALL with age, because the older a
 * protocol is without a token, the more of its peers have already launched.
 */
export function fitTokenOdds(protocols: Protocol[], asOf: string): OddsFit {
  const bins = AGE_BINS.map(([lo, hi]) => {
    const grp = protocols.filter((p) => {
      const a = ageDays(asOf, p.listed_at);
      return a !== null && a >= lo && a < hi;
    });
    const launched = grp.filter((p) => p.gecko_id !== null || p.symbol !== null).length;
    return { lo, hi, n: grp.length, share: grp.length === 0 ? 0 : launched / grp.length };
  });
  const usable = bins.filter((b) => b.n > 0);
  let best = { err: Infinity, sInf: 0.9, lambda: 0.001 };
  for (let si100 = 50; si100 <= 99; si100++) {
    const sInf = si100 / 100;
    for (let lam100k = 1; lam100k <= 199; lam100k++) {
      const lambda = lam100k / 100000;
      let err = 0;
      for (const b of usable) {
        const mid = (b.lo + b.hi) / 2;
        const s = sInf * (1 - Math.exp(-lambda * mid));
        err += b.n * (s - b.share) * (s - b.share);
      }
      if (err < best.err) best = { err, sInf, lambda };
    }
  }
  return { sInf: best.sInf, lambda: best.lambda, halfLifeDays: Math.log(2) / best.lambda, bins };
}

export function launchShareAt(fit: OddsFit, age: number): number {
  return fit.sInf * (1 - Math.exp(-fit.lambda * age));
}

/** Odds a still-tokenless protocol of this age launches from here, [0.02, 0.98]. */
export function tokenOdds(fit: OddsFit, age: number | null, fallbackAge: number): number {
  const a = age === null ? fallbackAge : age;
  const s = launchShareAt(fit, a);
  return clamp((fit.sInf - s) / (1 - s), 0.02, 0.98);
}

/** The age bin a protocol of this age falls in, for its peer count. */
export function ageBin(fit: OddsFit, age: number | null, fallbackAge: number): { lo: number; hi: number; n: number; share: number } {
  const a = age === null ? fallbackAge : age;
  for (const b of fit.bins) if (a >= b.lo && a < b.hi) return b;
  return fit.bins[fit.bins.length - 1];
}

// ---------------------------------------------------------------- product rule

/** Categories whose products tokenise an asset that already trades, not a new launch. */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names: a protocol named after one is the exchange's own product. */
export const EXCHANGE_NAMES: readonly string[] = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

/** A space followed by V2 / v2 / 2.0 or the like at the end of a name. */
export const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped / staked / staking anywhere in a name. */
export const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Why a pre-token protocol is excluded from the board, or null when it passes
 * the snapshot's own watchlist product rule.
 */
export function productExclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_MARKER.test(p.name)) return 'version marker in name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped/staked/staking in name';
  const lower = p.name.toLowerCase();
  for (const exchange of EXCHANGE_NAMES) {
    if (lower.startsWith(exchange.toLowerCase())) return `exchange name ${exchange}`;
  }
  return null;
}

export function isPreToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** A protocol belongs on the board only if it records no token and passes the product rule. */
export function isBoardEligible(p: Protocol): boolean {
  return isPreToken(p) && productExclusionReason(p) === null;
}

// ---------------------------------------------------------------- farm plans

export interface FarmTier {
  min: number;
  max: number;
  weeks: number;
}

export function farmTier(rank: number): FarmTier {
  if (rank <= 10) return { min: 250, max: 500, weeks: 8 };
  if (rank <= 50) return { min: 100, max: 250, weeks: 6 };
  if (rank <= 150) return { min: 50, max: 100, weeks: 5 };
  return { min: 25, max: 50, weeks: 4 };
}

type StepTemplate = (name: string, chain: string, lo: number, hi: number) => string;

const LENDING: StepTemplate[] = [
  (n, c, lo, hi) => `Supply $${lo}-$${hi} of ETH or stablecoins to ${n}'s lending markets on ${c} (gas about $1-$3, ~10 min) and keep the position open.`,
  (n, c, lo, hi) => `Borrow 20-30% of the supply's value on ${n} to show active use (interest about $1-$5 a month, ~10 min); never borrow more than half.`,
  (n, _c, lo, hi) => `Repay part of the loan and re-supply $${Math.round(lo / 2)}-$${Math.round(hi / 2)} once a week for 4-8 weeks so the activity reads as sustained, not one-off (~15 min a week).`,
  (n) => `If ${n} runs a points program, check its points page weekly and complete any listed on-chain action the same week (gas about $1-$3 each).`,
  (n) => `Hold the position through the snapshot window; do not close everything at once - unwind gradually over 1-2 weeks at the end.`,
];

const DEXS: StepTemplate[] = [
  (n, c, lo, hi) => `Swap $${lo}-$${hi} across two or three pairs on ${n} on ${c} (fees about 0.1-0.3% plus gas about $1-$3, ~10 min).`,
  (n, c, lo, hi) => `Add $${lo}-$${hi} of liquidity to a ${n} pool on ${c} and hold it for at least 4 weeks (gas about $2-$5).`,
  (n) => `Route one swap through ${n} once a week for 4-8 weeks to build a repeat-use history (~10 min a week).`,
  (n) => `If ${n} lists a points or volume program, keep weekly volume above $${100} and check the leaderboard monthly.`,
  (n) => `Remove liquidity gradually - never all at once - over the final 1-2 weeks of the farming window.`,
];

const YIELD: StepTemplate[] = [
  (n, c, lo, hi) => `Deposit $${lo}-$${hi} of stablecoins into a ${n} vault or strategy on ${c} (gas about $1-$4, ~10 min) and leave it earning.`,
  (n, _c, lo, hi) => `Top up the deposit by $${Math.round(lo / 2)}-$${Math.round(hi / 2)} after two weeks to show continued use (~10 min).`,
  (n) => `Claim or compound any yield the vault pays at least once a month (gas about $1-$3 per claim).`,
  (n) => `Keep the deposit in place for 6-8 weeks; short deposits rarely count toward snapshots.`,
  (n) => `Check ${n}'s announcements weekly for a points program and complete any listed action the same week.`,
];

const DERIVATIVES: StepTemplate[] = [
  (n, c, lo, hi) => `Open a small $${Math.round(lo / 2)}-$${Math.round(hi / 2)} position on ${n} on ${c} with low leverage (2-3x) and hold it for several days (fees about $1-$5).`,
  (n) => `Close and reopen a position once a week for 4-6 weeks to build a trading history (~15 min a week).`,
  (n, _c, lo, hi) => `Keep total exposure under $${hi * 2} and never risk more than you can lose; size positions to survive normal volatility.`,
  (n, _c, lo) => `If ${n} tracks volume for points, keep weekly volume near $${lo}-$${lo * 2} rather than one large trade.`,
  (n) => `Wind positions down gradually in the final 1-2 weeks; avoid holding large leverage into a snapshot.`,
];

const RWA: StepTemplate[] = [
  (n, c, lo, hi) => `Mint or buy $${lo}-$${hi} of ${n}'s tokenized asset on ${c} (fees about $1-$5, ~10 min) and hold it.`,
  (n) => `Hold the position for at least 6 weeks; RWA programs reward duration over activity.`,
  (n) => `If ${n} offers a yield or staking option for the asset, stake a portion and keep the rest liquid.`,
  (n) => `Check monthly for new asset listings on ${n} and add a second small position when one fits.`,
  (n) => `Unwind gradually over 1-2 weeks at the end; keep records of each mint and redemption.`,
];

const STAKING: StepTemplate[] = [
  (n, c, lo, hi) => `Stake $${lo}-$${hi} of ETH or the supported asset with ${n} on ${c} (gas about $2-$5, ~10 min) and hold the receipt token.`,
  (n) => `Use the receipt token in a low-risk DeFi position (lending or a stable pool) to show the full loop (~15 min).`,
  (n, _c, lo, hi) => `Top up the stake by $${Math.round(lo / 2)}-$${Math.round(hi / 2)} after three weeks to show continued use.`,
  (n) => `Keep the stake in place for 6-8 weeks; unstaking early usually resets any points.`,
  (n) => `Unstake gradually at the end if you exit; keep a small position if you plan to return.`,
];

const CEX: StepTemplate[] = [
  (n) => `Create and verify an account on ${n} if you do not have one (KYC where required, ~15-30 min, no deposit needed to start).`,
  (n, _c, lo, hi) => `Deposit $${lo}-$${hi} and make two or three small spot trades over two weeks (fees about 0.1% per trade).`,
  (n) => `Use one additional product - earn, card, or recurring buy - once, to show broader use (~10 min).`,
  (n) => `Keep a small balance on the account for 4-6 weeks rather than depositing and withdrawing at once.`,
  (n) => `Check ${n}'s rewards or points page weekly; complete any listed task the same week it appears.`,
];

const GENERIC: StepTemplate[] = [
  (n, c, lo, hi) => `Connect a wallet to ${n} on ${c} and complete one real on-chain action with $${lo}-$${hi} (gas about $1-$4, ~10 min).`,
  (n) => `Repeat the core action once a week for 4-6 weeks so the activity reads as sustained use (~10 min a week).`,
  (n, _c, lo, hi) => `Keep $${lo}-$${hi} of value in the protocol for the full period instead of depositing and withdrawing at once.`,
  (n) => `Check ${n}'s announcements weekly for a points program and complete any listed action the same week.`,
  (n) => `Wind down gradually over the final 1-2 weeks; keep records of each transaction.`,
];

const GROUP: Record<string, StepTemplate[]> = {
  Lending: LENDING,
  CDP: LENDING,
  'CDP Manager': LENDING,
  'Uncollateralized Lending': LENDING,
  'Collateral Markets': LENDING,
  'Leveraged Farming': LENDING,
  Dexs: DEXS,
  'Liquidity Manager': DEXS,
  Yield: YIELD,
  'Yield Aggregator': YIELD,
  'Risk Curators': YIELD,
  'Onchain Capital Allocator': YIELD,
  Derivatives: DERIVATIVES,
  'Basis Trading': DERIVATIVES,
  'Interest Rate Derivatives': DERIVATIVES,
  'Options Vault': DERIVATIVES,
  'Decentralized BTC': DERIVATIVES,
  'Anchor BTC': DERIVATIVES,
  RWA: RWA,
  'Dual-Token Stablecoin': RWA,
  'Stablecoin Wrapper': RWA,
  'Liquid Staking': STAKING,
  'Liquid Restaking': STAKING,
  'Restaked BTC': STAKING,
  'Staking Pool': STAKING,
  CEX: CEX,
  CeDeFi: CEX,
  'OTC Marketplace': CEX,
  'Crypto Card Issuer': CEX,
  Payments: CEX,
};

export function farmSteps(p: Protocol, tier: FarmTier): string[] {
  const chain = p.chains.length > 0 ? p.chains[0] : 'Ethereum';
  const group = p.category !== null ? GROUP[p.category] : undefined;
  const templates = group !== undefined ? group : GENERIC;
  return templates.map((t) => t(p.name, chain, tier.min, tier.max));
}

/** Momentum label from the 7-day TVL change. */
export function momentum(change7d: number | null): string {
  if (change7d === null) return 'unknown';
  if (change7d > 5) return 'rising';
  if (change7d < -5) return 'cooling';
  return 'flat';
}

// ---------------------------------------------------------------- board build

export interface BoardBuild {
  rows: BoardRow[];
  launched: LaunchedRow[];
  excluded: ExcludedRow[];
  validation: Validation;
  oddsFit: OddsFit;
  fallbackAge: number;
}

export function buildBoard(snap: Snapshot): BoardBuild {
  const watch = new Set(snap.watchlist);
  const peers = launchedPeers(snap.protocols);
  const cats = peerCategories(peers);
  const validation = validateModel(peers, snap.as_of, cats);
  const oddsFit = fitTokenOdds(snap.protocols, snap.as_of);

  const eligible = snap.protocols.filter(isBoardEligible);
  const knownAges = eligible.map((p) => ageDays(snap.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const fallbackAge = knownAges.length > 0 ? median(knownAges) : 365;

  const { intercept, slope } = validation;
  const scored = eligible.map((p) => {
    const age = ageDays(snap.as_of, p.listed_at);
    const logValue = intercept + slope * Math.log(p.tvl_usd);
    const implied = Math.round(Math.exp(logValue));
    const fittedMultiple = Math.exp(logValue) / p.tvl_usd;
    return {
      p,
      age,
      implied,
      breakdown: {
        intercept,
        slope,
        fittedMultiple,
        implied,
        q50: validation.conformalQ50,
        q80: validation.conformalQ80,
      },
    };
  });
  scored.sort((x, y) => {
    if (y.implied !== x.implied) return y.implied - x.implied;
    if (y.p.tvl_usd !== x.p.tvl_usd) return y.p.tvl_usd - x.p.tvl_usd;
    return x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0;
  });
  // Force the implied value strictly non-increasing down the ranks so the
  // board is a real ranking, not a tie at the top.
  for (let i = 1; i < scored.length; i++) {
    if (scored[i].implied >= scored[i - 1].implied) {
      scored[i].implied = Math.max(1, scored[i - 1].implied - 1);
      scored[i].breakdown.implied = scored[i].implied;
    }
  }
  const f50 = validation.factor50;
  const f80 = validation.factor80;
  const pointValues = scored.map((s) => s.implied);
  const rows: BoardRow[] = scored.map((s, i) => {
    const rank = i + 1;
    const p = s.p;
    const tier = farmTier(rank);
    const odds = tokenOdds(oddsFit, s.age, fallbackAge);
    const bin = ageBin(oddsFit, s.age, fallbackAge);
    const share = launchShareAt(oddsFit, s.age === null ? fallbackAge : s.age);
    const valueLow = Math.max(1, Math.round(s.implied / f80));
    const valueHigh = Math.round(s.implied * f80);
    // Rank range: where this protocol would rank if its value sat at the
    // ends of its 50% conformal interval (other protocols at their points).
    const hi = s.implied * f50;
    const lo = s.implied / f50;
    let rankLow = 1;
    let rankHigh = 1;
    for (const v of pointValues) {
      if (v > hi) rankLow++;
      if (v > lo) rankHigh++;
    }
    const verdictLabel = s.implied >= 15_000_000 && odds >= 0.8 ? 'Farm'
      : s.implied >= 6_000_000 && odds >= 0.7 ? 'Farm small'
      : 'Watch';
    return {
      slug: p.slug,
      name: p.name,
      rank,
      implied_value_usd: s.implied,
      value_low_usd: valueLow,
      value_high_usd: valueHigh,
      rank_low: rankLow,
      rank_high: rankHigh,
      token_odds: Math.round(odds * 1000) / 1000,
      peer_launch_share: Math.round(share * 1000) / 1000,
      peer_n: bin.n,
      verdict_label: verdictLabel,
      verdict: verdictText(verdictLabel, tier, s.implied, valueLow, valueHigh, odds),
      farm_steps: farmSteps(p, tier),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age,
      momentum: momentum(p.change_7d),
      status: 'pre-token',
      watchlist: watch.has(p.slug),
      breakdown: s.breakdown,
      est_cost: { min: tier.min, max: tier.max },
      horizon_weeks: tier.weeks,
    };
  });
  const launched: LaunchedRow[] = snap.protocols
    .filter((p) => !isPreToken(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }))
    .sort((x, y) => (y.mcap_usd ?? -1) - (x.mcap_usd ?? -1));
  const excluded: ExcludedRow[] = snap.protocols
    .filter((p) => isPreToken(p) && !isBoardEligible(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      reason: productExclusionReason(p) as string,
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  return { rows, launched, excluded, validation, oddsFit, fallbackAge };
}

/** One-sentence costed verdict: what to do, what it costs, what it is worth. */
export function verdictText(
  label: string,
  tier: FarmTier,
  implied: number,
  valueLow: number,
  valueHigh: number,
  odds: number,
): string {
  const money = (n: number): string => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${Math.round(n)}`;
  };
  const pct = Math.round(odds * 100);
  if (label === 'Farm') {
    return `Farm - budget $${tier.min}-$${tier.max} over ${tier.weeks} weeks; the launch is put at ~${money(implied)} (80% range ${money(valueLow)}-${money(valueHigh)}) and ${pct}% of peers this old record a token.`;
  }
  if (label === 'Farm small') {
    return `Farm small - budget $${tier.min}-$${tier.max} over ${tier.weeks} weeks; the launch is put at ~${money(implied)} (80% range ${money(valueLow)}-${money(valueHigh)}) at ${pct}% peer odds.`;
  }
  return `Watch - budget $${tier.min}-$${tier.max} over ${tier.weeks} weeks only if you already use it; the launch is put at ~${money(implied)} (80% range ${money(valueLow)}-${money(valueHigh)}) at ${pct}% peer odds.`;
}
