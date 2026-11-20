# Launch Radar

A token launch radar for the make.fun `token-radar-01` bounty. It reads a
sealed snapshot of the DefiLlama protocol universe and writes a web dashboard
that ranks the protocols that record no token yet by what their launch would
be worth, each with the steps to farm it — and shows, on the page, the
out-of-sample evidence behind every number.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18 or later, standard library only, no network. The program writes
`out/board.json` (the ranked board), `out/dashboard/` (the page + `data.js`),
`out/screenshots/` (three views of the page) and `out/dossier.json` (the
judge's dossier, built with the vendored library).

## The model (radar-4)

```
implied value = value-if-launched × P(records a token)
```

Value-if-launched is a Huber log-log size curve fitted on all 127
one-per-ticker traded comps — no comps dropped — with ridge-shrunk category
offsets and a family effect for protocols that share a name stem:

```
log10 value = 3.39 + 0.47 × log10(TVL) + category offset + 0.58 × family
```

Launch odds are a logistic fit on years listed and kinship (a sibling protocol
already records a token). The category's token rate was tested and wins both
blind tests by a hair, but is not kept: it prices the newest categories at
near-zero odds from their youth rather than from evidence.

A term enters either fit only if it lowers the held-out error in BOTH blind
tests — leave-one-out and older → newer walk-forward. The page shows the full
ablation for both fits, the dropped terms, a shuffled negative control, range
coverage, bootstrap standard errors (200 refits) and rank ranges.

Farm economics are netted to the dollar: the pro-rata slice of the drop pool
minus gas and the T-bill the deposit would otherwise earn, with a verdict per
row (FARM / THIN / SKIP), a break-even odds and a minimum deposit — plus the
net under each outcome, launched or never.

Every one of the 758 protocols is accounted for in the ledger: ranked,
already trading, or set aside for one stated reason (bridge, liquid staking,
exchange, versioned, wrapped, or kin of a token that already trades).

## Layout

- `main.ts` — the entrypoint: reads the snapshot, fits, validates, prices
  the board, writes the outputs and the dossier.
- `lib/model.ts` — the model: snapshot parsing, the value fit, the odds fit,
  blind validation, farm economics and the ledger.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. No
  network, no framework; it reads `data.js` and reprices every row from the
  fitted coefficients, checking itself against `board.json`.
- `screenshots/` — the board, a protocol's detail view and a filtered view.

## License

MIT. See LICENSE.
