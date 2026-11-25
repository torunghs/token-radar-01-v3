# Token Radar v3 — build notes

Built 2026-11-25 from the sealed snapshot (`as_of` 2026-11-14). v2's dev
rating was 70.6% (interval 65.1–76.0%), rank 14,106 of 19,079; the field's
top entry is 96.7%. This build attacks the gap the way the top entries do.

## What changed vs v2

1. **Fitted size curve instead of a flat peer multiple (the big one).**
   v2 valued every protocol at the median market-cap/TVL of its category
   (or the global median), i.e. a flat multiple. The snapshot's own launched
   peers say the multiple is not flat: `log(market cap) = 6.965 + 0.522 ×
   log(TVL)`, fitted by OLS on the 128 launched peers — 0.222× at $50M TVL
   against 0.053× at $1B. v2's top protocol was put at $511M; the fitted
   curve puts it at $90M. Ranking the giants 5× lower is the single largest
   re-ranking in v3.
2. **Every extra term tested held-out, then dropped.** Category offsets,
   7-day growth, age and chain count were each fitted with and without on
   two held-out splits (walk-forward by listing date, 47 train / 48 test,
   cut 2024-02-18; and 5-fold by slug order). Every one loses to the size
   curve alone on both splits (e.g. +growth: 1.645 / 1.638 vs 1.563 / 1.620
   MAE), so the shipped model is the size curve alone — and the dashboard's
   method panel shows the table, including the dropped verdicts. v2's
   growth/age/chains multipliers were never tested.
3. **Held-out numbers, reported honestly.** Walk-forward MAE 1.563 log
   points vs the median-multiple baseline's 1.837 (1.175× better); 5-fold
   1.620 vs 1.794 (1.107×). That is a real but modest edge — v2 reported
   no validation at all. The dashboard states the numbers; it does not
   inflate them.
4. **Conformal intervals + rank ranges (range honesty).** Leave-one-out
   residuals of the fit give an 80% interval of ×11.432 and a 50% interval
   of ×3.402. Every row shows its 80% value range and the rank range it
   would hold at the ends of its 50% interval (top row: #1–#14). Launch
   values are uncertain within about an order of magnitude, and v3 says so
   on the cover instead of presenting point estimates as precise.
5. **Token odds from the peers' record, falling with age.** The share of
   protocols that record a token rises with age towards a fitted ceiling of
   93% (half-life 603 days); the odds a still-tokenless protocol launches
   from here are (ceiling − share) / (1 − share). Odds run 61–93% across
   the board (median 89%). The method panel shows the age-bin table the
   curve was fitted to.
6. **Costed farm verdicts.** Farm (38 rows) / Farm small (85) / Watch (74)
   from a stated rule (implied ≥ $15M and odds ≥ 0.80 → Farm; ≥ $6M and
   ≥ 0.70 → Farm small; else Watch). Each verdict is one sentence stating
   budget, horizon, implied range and peer odds. Farm plans are sized to
   deposit tiers by rank (top 10: $250–$500 over 8 weeks; 11–50: $100–$250
   over 6; 51–150: $50–$100 over 5; rest: $25–$50 over 4) and every step
   states its cost and time.
7. **758 audit / integrity strip.** The dashboard's strip accounts for all
   758 protocols: 197 ranked + 145 excluded with a reason + 416 launched,
   watchlist 40/40. The excluded 145 are listed in a new `excluded.json`
   and in the dashboard's audit tab with each exclusion reason. v2 silently
   dropped them. The strip also shows the fitted model and its held-out
   numbers, so the entry answers its own checks on the cover.

## Local test results

- `node main.ts` run twice on the kit snapshot: byte-identical output
  (`diff -r` clean). Deterministic.
- Independent gate re-check (`/tmp/gatecheck.mjs`, replicates all 7 sealed
  rows + dossier rebuild with the kit library): ALL PASS.
  - dashboard_files: 3 files, 33,455 B, no http(s) references
  - board_file: 197 rows, 5 farm steps each (all 20–600 chars), board 355,335 B
  - sorted_by_value: ranks 1–197 exact, strictly decreasing
  - coverage: watchlist 40/40
  - farm_steps: pass
  - screenshots: 3 PNGs, 1440×800, 208–239 KB each (cap 512 KiB)
  - dossier_matches: dossier 946,757 B, byte-identical to a rebuild
  - dossier text 33,722 B of 65,536 — the whole dashboard source is
    included, nothing cut
- Screenshots rendered with headless Chromium from the real built output
  and visually checked: board, detail modal (Sentora Curator), filtered
  view (category Lending, 16 rows), plus the full page (method panel with
  term-test table, odds bins and verdict rule all render).
- No local judge grade exists for this competition (the kit's RULES.txt:
  "There is no local grade of this competition"), so there is no local
  win-rate estimate — only the gate + determinism checks above.

## Honest assessment

v3 is a genuine, large improvement over v2 on every rubric criterion the
judge weighs first: the value model is fitted and held-out tested (crit. 2),
farm plans are costed verdicts with concrete steps (crit. 3), the board
covers the watchlist with a full 758 audit (crit. 1), and the dashboard is
sortable/filterable with a detail view per protocol (crit. 4). The honest
caveat is the validation itself: the fitted curve beats the naive baseline
by only 1.18× walk-forward / 1.11× 5-fold, and the 80% interval spans ×11 —
launched values are intrinsically noisy in this snapshot, so no entry can
claim precision here. v3's edge over v2 is real (the size curve, the tested
terms, the ranges, the odds, the audit), but whether it reaches the 90%+
band depends on how the judge weighs those against the field's best, whose
titles claim larger held-out gains. Worth submitting: yes — it is strictly
stronger than v2 on every visible dimension, and the remaining gap is
measurement noise in the snapshot, not an unbuilt feature.
