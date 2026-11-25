# Token Radar v3

A token launch radar: every protocol in the sealed DefiLlama snapshot that
records no token yet, ranked by an implied launch value, each with a concrete
farm plan. Protocols whose token already trades are listed separately, and
the 145 pre-token protocols the ranking rule leaves out are listed with the
reason each one fails it — all 758 protocols of the snapshot are accounted
for exactly once.

## The model

```text
log(market cap) = intercept + slope × log(TVL)
```

fitted by ordinary least squares on the 128 launched peers (protocols with
a recorded market cap) in the snapshot itself. The fitted slope is well
below 1, so the implied market-cap/TVL multiple falls as a protocol gets
bigger — a flat median multiple would overvalue the giants several times
over.

Every extra term a radar could add — a category offset, the 7-day growth,
the protocol's age, its chain count — is tested, not assumed: each term is
fitted with and without it on two held-out splits (walk-forward by listing
date, and 5-fold by slug order) and kept only when it beats the model
without it on both splits. On this snapshot every extra term loses on both
splits, so the shipped model is the size curve alone. The dashboard's method
panel shows the numbers.

Uncertainty is shown, not hidden: each implied value carries an 80%
conformal interval from the model's leave-one-out residuals, and a rank
range from the 50% interval. Token odds come from the peers' own record:
the share of protocols that record a token rises with age towards a fitted
ceiling, so the odds that a protocol still tokenless at its age launches
from here fall with age. Each farm verdict states its budget, horizon,
implied value range and peer odds.

No protocol name is hardcoded anywhere: every figure derives from the
snapshot's own fields, so the same program ranks a future snapshot's
protocols too. Implied value is this entry's own claim, never a prediction
of whether or when a token is issued.

## Run it

```sh
node main.ts --input <path to snapshot.json> --output <dir>
```

Defaults: `--input /input/snapshot.json`, `--output $MAKEFUN_OUTPUT_DIR`
or `/output`. The run writes `board.json` (197 pre-token rows),
`launched.json` (416 launched protocols), `excluded.json` (145 pre-token
protocols with their exclusion reason), copies `dashboard/` and
`screenshots/`, and writes `dossier.json` with the kit's `buildDossier`.
The run is fully deterministic — two runs write byte-identical output.

## Layout

- `main.ts` — entrypoint: reads the snapshot, asserts the board is valid,
  writes the outputs.
- `lib/model.ts` — the fitted value model, held-out validation, token
  odds, costed farm plans and the board build.
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.
- `dashboard/` — the static page (index.html, app.css and app.js); no network.
- `screenshots/` — board, detail and filtered views of the dashboard.
