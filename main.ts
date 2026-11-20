// main.ts — token launch radar entrypoint (Node 22, standard library only).
// Reads the sealed snapshot, fits the value curve and the odds model, checks
// both blind, prices the board, costs every farm plan, and writes:
//   /output/board.json     the ranked board (the gate's file)
//   /output/dashboard/     the page + its data (data.js)
//   /output/screenshots/   three screenshots of the page
//   /output/dossier.json   the judge's dossier, built by the kit library
// Deterministic: the same snapshot in, the same bytes out, every run.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  ageInDays,
  recordsToken,
  categoryOf,
  changeOf,
  familyGroups,
  isKin,
  isFamily,
  rankable,
  pickComps,
  fitValue,
  checkValue,
  checkFlat,
  valueAblation,
  fitOdds,
  checkOdds,
  oddsAblation,
  oddsCalibration,
  ageBandRates,
  bootstrapAll,
  farmMath,
  farmStepsFor,
  gasFor,
  planKindFor,
  ledgerOf,
  anchorRows,
  median,
  quantileSorted,
  FINAL_VALUE,
  FINAL_ODDS,
  DEFAULT_FARM,
  type Snapshot,
  type Proto,
  type FarmAssumptions,
} from "./lib/model.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = process.env.MAKEFUN_INPUT ?? "/input/snapshot.json";
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) input = argv[++i];
    else if (argv[i] === "--output" && argv[i + 1]) output = argv[++i];
    else if (argv[i]!.startsWith("--input=")) input = argv[i]!.slice("--input=".length);
    else if (argv[i]!.startsWith("--output=")) output = argv[i]!.slice("--output=".length);
  }
  return { input, output };
}

// FNV-1a 32-bit, hex. The seal runs over the same rounded $M values the page
// carries in data.js, so the page recomputes it exactly: the seal on the page
// matches board.json only when the two agree.
function sealOf(rows: { slug: string; implied: number }[]): string {
  let h = 0x811c9dc5;
  const s = rows.map((r) => `${r.slug}:${roundM3(r.implied).toFixed(3)}`).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const roundM = (x: number): number => Math.round((x / 1e6) * 100) / 100;
const roundM3 = (x: number): number => Math.round((x / 1e6) * 1000) / 1000;

async function main(): Promise<void> {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap: Snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const asOf = snap.as_of;
  const protos: Proto[] = snap.protocols;
  const watch = new Set(snap.watchlist);
  const groups = familyGroups(protos);

  // ---- comps, value fit, blind checks -----------------------------------
  const comps = pickComps(protos, groups);
  const valueFit = fitValue(comps, asOf, FINAL_VALUE);
  const vAbl = valueAblation(comps, asOf);
  const vFinal = checkValue(comps, asOf, FINAL_VALUE);
  const vFlat = checkFlat(comps);

  // Range bands from the final model's leave-one-out residuals: the median
  // absolute miss sets the P25–P75 half-width, the 80th percentile the
  // P10–P90 half-width. Coverage is then measured, not assumed.
  const absRes = [...vFinal.looResid].map(Math.abs).sort((a, b) => a - b);
  const f50 = 10 ** median(absRes);
  const f80 = 10 ** quantileSorted(absRes, 0.8);
  const cover = (res: number[], f: number): number => res.filter((r) => Math.abs(r) <= Math.log10(f)).length / res.length;
  const holds = {
    f50: round2(f50),
    f80: round2(f80),
    loo50: cover(vFinal.looResid, f50),
    loo80: cover(vFinal.looResid, f80),
    wf50: cover(vFinal.wfResid, f50),
    wf80: cover(vFinal.wfResid, f80),
    wfN: vFinal.wfTest,
  };

  // ---- odds fit, blind checks -------------------------------------------
  const dated = protos.filter((p) => ageInDays(asOf, p) !== null);
  const oddsFit = fitOdds(dated, asOf, FINAL_ODDS, groups);
  const oAbl = oddsAblation(dated, asOf, groups);
  const oFinal = checkOdds(dated, asOf, FINAL_ODDS, groups);
  const calib = oddsCalibration(dated, oddsFit);
  const bands = ageBandRates(dated, asOf);

  // ---- the board ----------------------------------------------------------
  const priced = protos
    .filter((p) => rankable(p, groups))
    .map((p) => {
      const vil = valueFit.predict(p.tvl_usd, changeOf(p), categoryOf(p), isFamily(p, groups), 0, ageInDays(asOf, p), p.chains.length, 0);
      const o = oddsFit.predict(p);
      return { p, vil, odds: o, implied: vil * o };
    })
    .sort((a, b) => b.implied - a.implied);

  const boot = bootstrapAll(
    comps,
    priced.map(({ p, odds }) => ({
      slug: p.slug,
      tvl: p.tvl_usd,
      chg: changeOf(p),
      cat: categoryOf(p),
      fam: isFamily(p, groups),
      age: ageInDays(asOf, p),
      nChains: p.chains.length,
      odds,
    })),
    dated,
    asOf,
    groups,
  );

  const fp: FarmAssumptions = DEFAULT_FARM;
  const rows = priced.map(({ p, vil, odds, implied }, i) => {
    const plan = planKindFor(categoryOf(p));
    const fee = gasFor(p.chains[0] ?? "");
    // Farm economics and step text use the SAME quantised inputs the page
    // sees (TVL to the nearest $1,000, implied to $1,000, odds to 3
    // decimals), so board.json's steps and the page's steps agree digit for
    // digit. The model's own fields stay exact; only the economics are
    // quantised, and the shift is at most a cent on a slice.
    const tvlQ = Math.round(p.tvl_usd / 1000) * 1000;
    const impQ = roundM3(implied) * 1e6;
    const oddsQ = round3(odds);
    const econ = farmMath(impQ, vil, tvlQ, fee, plan.hours, fp);
    const [rlo, rhi] = boot.rankRange.get(p.slug) ?? [i + 1, i + 1];
    const steps = farmStepsFor(
      {
        name: p.name,
        category: categoryOf(p),
        chains: p.chains,
        tvl: tvlQ,
        implied: impQ,
        odds: oddsQ,
        fee,
        hours: plan.hours,
        slice: econ.slice,
        net: econ.net,
        minDeposit: econ.minDeposit,
        verdict: econ.verdict,
      },
      fp,
    );
    return {
      slug: p.slug,
      name: p.name,
      category: categoryOf(p),
      chains: p.chains,
      tvl: p.tvl_usd,
      chg: p.change_7d,
      age: ageInDays(asOf, p),
      watch: watch.has(p.slug),
      fam: isFamily(p, groups),
      ifLaunched: vil,
      odds,
      implied,
      lo: implied / f50,
      hi: implied * f50,
      lo90: implied / f80,
      hi90: implied * f80,
      rankLo: rlo,
      rankHi: rhi,
      rank: i + 1,
      planKind: plan.kind,
      fee,
      hours: plan.hours,
      slice: econ.slice,
      sliceIf: econ.sliceIf,
      oppCost: econ.oppCost,
      net: econ.net,
      netIf: econ.netIf,
      netNo: econ.netNo,
      netPerHour: econ.netPerHour,
      breakevenOdds: econ.breakevenOdds,
      minDeposit: econ.minDeposit,
      verdict: econ.verdict,
      farmSteps: steps,
    };
  });

  const totalImplied = rows.reduce((a, r) => a + r.implied, 0);
  const verdictCounts = {
    FARM: rows.filter((r) => r.verdict === "FARM").length,
    THIN: rows.filter((r) => r.verdict === "THIN").length,
    SKIP: rows.filter((r) => r.verdict === "SKIP").length,
  };
  // Top-20 stability: how many of the board's top 20 still rank top 20 in
  // at least 80% of the 200 bootstrap refits.
  const top20Hold = rows.slice(0, 20).filter((r) => (boot.top20Share.get(r.slug) ?? 0) >= 0.8).length;
  const bestFarm = [...rows].sort((a, b) => b.netPerHour - a.netPerHour)[0]!;
  const led = ledgerOf(protos, groups);
  const anch = anchorRows(comps, valueFit, asOf);
  const rowSeal = sealOf(rows);

  // ---- board.json ---------------------------------------------------------
  const boardJson = {
    meta: {
      asOf,
      source: snap.source,
      floorUsd: snap.floor_usd,
      nProtocols: protos.length,
      nComps: comps.length,
      fit: {
        intercept: valueFit.intercept,
        slope: valueFit.slope,
        famCoef: valueFit.famCoef,
        marketChg: valueFit.marketChg,
        offsets: valueFit.offsets,
        slopeSe: boot.slopeSe,
        interceptSe: boot.interceptSe,
        famSe: boot.famSe,
      },
      odds: {
        beta: oddsFit.beta,
        betaSe: boot.oddsSe,
        looHit: oFinal.loo.hit,
        looBrier: oFinal.loo.brier,
        wfHit: oFinal.wf.hit,
        wfBrier: oFinal.wf.brier,
        baseLooBrier: oFinal.baseLoo.brier,
        baseWfBrier: oFinal.baseWf.brier,
        n: dated.length,
      },
      validation: {
        loo: vFinal.loo,
        wf: vFinal.wf,
        flatLoo: vFlat.loo,
        flatWf: vFlat.wf,
        wfTrain: vFinal.wfTrain,
        wfTest: vFinal.wfTest,
        rangeHolds: holds,
      },
      ledger: led,
      totalImpliedUsd: Math.round(totalImplied),
      verdictCounts,
      top20Hold: { hold: top20Hold, of: 20, threshold: 0.8, refits: 200 },
      farmDefaults: fp,
      seal: rowSeal,
    },
    rows: rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: Math.max(1, Math.round(r.implied)),
      farm_steps: r.farmSteps,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl,
      change_7d: r.chg,
      age_days: r.age,
      watchlist: r.watch,
      family: r.fam === 1,
      if_launched_usd: Math.round(r.ifLaunched),
      launch_odds: round3(r.odds),
      p25_usd: Math.round(r.lo),
      p75_usd: Math.round(r.hi),
      p10_usd: Math.round(r.lo90),
      p90_usd: Math.round(r.hi90),
      rank_p10: r.rankLo,
      rank_p90: r.rankHi,
      plan: r.planKind,
      fee_usd: r.fee,
      hours: r.hours,
      slice_usd: round2(r.slice),
      slice_if_launched_usd: round2(r.sliceIf),
      net_usd: round2(r.net),
      net_if_launched_usd: round2(r.netIf),
      net_if_never_usd: round2(r.netNo),
      net_per_hour_usd: round2(r.netPerHour),
      breakeven_odds: round2(r.breakevenOdds),
      min_deposit_usd: r.minDeposit === null ? null : Math.round(r.minDeposit),
      verdict: r.verdict,
    })),
  };

  // ---- dashboard data (compact, inside dashboard/) -----------------------
  // Row arrays, positional: [slug, name, catIdx, chainIdx, nChains, tvlK,
  // chg, age, flags, odds, impliedM, rankLo, rankHi, fee, hours]
  // flags: bit 0 = watchlist, bit 1 = shares a name stem (family).
  // tvlK is whole $K; impliedM carries 3 decimals; chg is carried at full
  // snapshot precision because the page's 7-day carry depends on it. The
  // page derives value-if-launched (from the fitted coefficients + the
  // fixed 7-day carry), ranges (implied x/div f50/f80), farm economics and
  // verdicts from these + meta, with the same formulas as lib/model.ts.
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  const catIdx = new Map(cats.map((c, i) => [c, i]));
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  const chainIdx = new Map(chains.map((c, i) => [c, i]));
  const offArr = cats.map((c) => round3(valueFit.offsets[c] ?? 0));
  const data = {
    meta: {
      asOf,
      floorM: snap.floor_usd / 1e6,
      totalM: roundM(totalImplied),
      seal: rowSeal,
      fit: {
        a: +valueFit.intercept.toFixed(4),
        b: +valueFit.slope.toFixed(4),
        fam: +valueFit.famCoef.toFixed(4),
        mchg: +valueFit.marketChg.toFixed(4),
        se: { b: +boot.slopeSe.toFixed(3), a: +boot.interceptSe.toFixed(3), fam: +boot.famSe.toFixed(3) },
      },
      top20: { hold: top20Hold, of: 20 },
      oddsFit: {
        beta: oddsFit.beta.map((v) => +v.toFixed(3)),
        se: boot.oddsSe.map((v) => +v.toFixed(3)),
        mla: +oddsFit.ctx.meanLogAge.toFixed(4),
        sla: +oddsFit.ctx.sdLogAge.toFixed(4),
      },
      f50: round2(f50),
      f80: round2(f80),
      nComps: comps.length,
      loo: { med: +vFinal.loo.med.toFixed(2), q3: +vFinal.loo.q3.toFixed(2), w3: +vFinal.loo.within3.toFixed(2), rho: +vFinal.loo.rho.toFixed(2), n: vFinal.loo.n },
      wf: { med: +vFinal.wf.med.toFixed(2), q3: +vFinal.wf.q3.toFixed(2), w3: +vFinal.wf.within3.toFixed(2), rho: +vFinal.wf.rho.toFixed(2), train: vFinal.wfTrain, test: vFinal.wfTest },
      flat: { loo: +vFlat.loo.med.toFixed(2), wf: +vFlat.wf.med.toFixed(2) },
      vabl: vAbl.map((r) => ({ l: r.label, k: r.kept ? 1 : 0, loo: +r.loo.med.toFixed(2), w3: Math.round(r.loo.within3 * 100), wf: +r.wf.med.toFixed(2), w3w: Math.round(r.wf.within3 * 100) })),
      oabl: oAbl.map((r) => ({ l: r.label, k: r.kept ? 1 : 0, loo: +r.loo.brier.toFixed(3), hit: Math.round(r.loo.hit * 100), wf: +r.wf.brier.toFixed(3), hitw: Math.round(r.wf.hit * 100) })),
      holds: {
        loo50: Math.round(holds.loo50 * 100),
        loo80: Math.round(holds.loo80 * 100),
        wf50: Math.round(holds.wf50 * 100),
        wf80: Math.round(holds.wf80 * 100),
        wfN: holds.wfN,
      },
      odds: {
        hit: Math.round(oFinal.loo.hit * 100),
        base: Math.round(oFinal.baseLoo.hit * 100),
        brier: +oFinal.loo.brier.toFixed(3),
        baseBrier: +oFinal.baseLoo.brier.toFixed(3),
        wfHit: Math.round(oFinal.wf.hit * 100),
        wfBrier: +oFinal.wf.brier.toFixed(3),
        wfBaseBrier: +oFinal.baseWf.brier.toFixed(3),
        n: dated.length,
        bands: bands.map((b) => ({ l: b.label, n: b.n, r: Math.round(b.rate * 100) })),
        calib: calib.map((c) => ({ p: Math.round(c.pred * 100), a: Math.round(c.actual * 100), n: c.n })),
      },
      ledger: led,
      verdicts: verdictCounts,
      watchTotal: snap.watchlist.length,
      bestFarm: { name: bestFarm.name, netPerHour: round2(bestFarm.netPerHour), net: round2(bestFarm.net) },
      anchors: anch.map((a) => ({ name: a.name, sym: a.symbol, mcapM: roundM(a.mcap), curveM: roundM(a.curve), ratio: round2(a.ratio) })),
      farm: fp,
      off: offArr,
    },
    cats,
    chains,
    rows: rows.map((r) => [
      r.slug,
      r.name,
      catIdx.get(r.category) as number,
      chainIdx.get(r.chains[0] ?? "") ?? -1,
      r.chains.length,
      Math.round(r.tvl / 1000),
      r.chg,
      r.age,
      (r.watch ? 1 : 0) + (r.fam === 1 ? 2 : 0),
      round3(r.odds),
      roundM3(r.implied),
      r.rankLo,
      r.rankHi,
      r.fee,
      r.hours,
    ]),
    comps: comps.map((c) => [+c.x.toFixed(2), +c.y.toFixed(2), c.fam]),
  };

  // ---- write outputs -------------------------------------------------------
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "board.json"), JSON.stringify(boardJson));
  const outDash = path.join(output, "dashboard");
  fs.rmSync(outDash, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "dashboard"), outDash, { recursive: true });
  fs.writeFileSync(path.join(outDash, "data.js"), `window.RADAR=${JSON.stringify(data)};`);
  const outShots = path.join(output, "screenshots");
  fs.rmSync(outShots, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "screenshots"), outShots, { recursive: true });
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  fs.writeFileSync(path.join(output, "dossier.json"), dossier);

  // ---- summary ---------------------------------------------------------------
  console.log(`snapshot ${asOf} — ${protos.length} protocols, ${watch.size} watchlist`);
  console.log(`comps: ${comps.length} one-per-ticker, none dropped`);
  console.log(`value: log10 value = ${valueFit.intercept.toFixed(3)} + ${valueFit.slope.toFixed(3)} x log10(TVL) + fam ${valueFit.famCoef.toFixed(3)} + cat offsets + 7d carry (market ${valueFit.marketChg.toFixed(2)}%, clip +-25%)`);
  console.log(`LOO x${vFinal.loo.med.toFixed(2)} (flat x${vFlat.loo.med.toFixed(2)}) | WF x${vFinal.wf.med.toFixed(2)} (flat x${vFlat.wf.med.toFixed(2)}) | rho LOO ${vFinal.loo.rho.toFixed(2)} WF ${vFinal.wf.rho.toFixed(2)} | top-20 hold ${top20Hold}/20`);
  console.log(`value ablation: ${vAbl.map((r) => `${r.label}=x${r.loo.med.toFixed(2)}/x${r.wf.med.toFixed(2)}${r.kept ? " K" : ""}`).join(" | ")}`);
  console.log(`range holds: LOO ${Math.round(holds.loo50 * 100)}%/${Math.round(holds.loo80 * 100)}% WF ${Math.round(holds.wf50 * 100)}%/${Math.round(holds.wf80 * 100)}% (f50 x${holds.f50}, f80 x${holds.f80})`);
  console.log(`odds: beta [${oddsFit.beta.map((b) => b.toFixed(2)).join(" ")}] | LOO hit ${Math.round(oFinal.loo.hit * 100)}% Brier ${oFinal.loo.brier.toFixed(3)} (base ${oFinal.baseLoo.brier.toFixed(3)}) | WF hit ${Math.round(oFinal.wf.hit * 100)}% Brier ${oFinal.wf.brier.toFixed(3)} (base ${oFinal.baseWf.brier.toFixed(3)})`);
  console.log(`board: ${rows.length} rows, total implied $${(totalImplied / 1e9).toFixed(2)}B, #1 ${rows[0]!.name} $${(rows[0]!.implied / 1e6).toFixed(1)}M`);
  console.log(`verdicts: ${verdictCounts.FARM} FARM / ${verdictCounts.THIN} THIN / ${verdictCounts.SKIP} SKIP | seal ${rowSeal}`);
  console.log(`wrote ${output} (board.json ${fs.statSync(path.join(output, "board.json")).size} B, dossier ${dossier.length} B)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
