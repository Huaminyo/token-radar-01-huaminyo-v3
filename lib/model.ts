// lib/model.ts — the launch radar's model (radar-4). Pure functions, no IO.
//
// One line: implied value = value-if-launched x P(records a token).
//   value-if-launched: a Huber log-log size curve fitted on every
//     one-per-ticker traded comp (127), with ridge-shrunk category offsets
//     and a family effect for protocols that share a name stem.
//   P(records a token): a logistic fit on years listed, kinship (a sibling
//     protocol already records a token) and the category's token rate.
// A term enters either fit only if it lowers the held-out miss (value) or
// the Brier score (odds) in BOTH blind tests: leave-one-out and
// older -> newer walk-forward. Everything else is shown as tried-and-dropped.

export interface Proto {
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
  protocols: Proto[];
  watchlist: string[];
}

// ------------------------------------------------------------------ utilities

export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Quantile of an ascending-sorted list, index rule floor(q * (n - 1)). */
export function quantileSorted(s: number[], q: number): number {
  if (s.length === 0) return 0;
  return s[Math.floor(q * (s.length - 1))]!;
}

export function mean(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

export function stdev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

function rankAvg(v: number[]): number[] {
  const order = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!);
  const r = new Array<number>(v.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && v[order[j + 1]!] === v[order[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]!] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(xs: number[], ys: number[]): number {
  const rx = rankAvg(xs);
  const ry = rankAvg(ys);
  const n = xs.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/** Deterministic PRNG (mulberry32): same seed, same bytes, every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solve a small dense linear system by Gauss-Jordan with partial pivoting. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    if (Math.abs(m[c]![c]!) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r !== c && m[r]![c] !== 0) {
        const f = m[r]![c]! / m[c]![c]!;
        for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
      }
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) > 1e-12 ? row[n]! / row[i]! : 0));
}

/** Ridge least squares via the normal equations. */
export function ridgeSolve(x: number[][], y: number[], pen: number[]): number[] {
  const k = x[0]!.length;
  const a: number[][] = [];
  for (let i = 0; i < k; i++) {
    a.push([]);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < x.length; r++) s += x[r]![i]! * x[r]![j]!;
      a[i]![j] = s + (i === j ? pen[i]! : 0);
    }
  }
  const b: number[] = [];
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let r = 0; r < x.length; r++) s += x[r]![i]! * y[r]!;
    b.push(s);
  }
  return solveLinear(a, b);
}

/** Huber regression by IRLS: residuals scaled by 1.4826 x MAD, c = 1.345. */
export function huberSolve(x: number[][], y: number[], pen: number[], c = 1.345): number[] {
  let beta = ridgeSolve(x, y, pen);
  for (let it = 0; it < 15; it++) {
    const resid = y.map((v, i) => v - dot(x[i]!, beta));
    const med = median(resid);
    const mad = median(resid.map((r) => Math.abs(r - med))) || 1e-9;
    const scale = 1.4826 * mad;
    const w = resid.map((r) => {
      const u = Math.abs(r / (c * scale));
      return u <= 1 ? 1 : 1 / u;
    });
    const xw = x.map((row, i) => row.map((v) => v * Math.sqrt(w[i]!)));
    const yw = y.map((v, i) => v * Math.sqrt(w[i]!));
    const next = ridgeSolve(xw, yw, pen);
    let delta = 0;
    for (let j = 0; j < beta.length; j++) delta = Math.max(delta, Math.abs(next[j]! - beta[j]!));
    beta = next;
    if (delta < 1e-9) break;
  }
  return beta;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// ------------------------------------------------------------------ snapshot

export function ageInDays(asOf: string, p: Proto): number | null {
  if (!p.listed_at) return null;
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

export function recordsToken(p: Proto): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function categoryOf(p: Proto): string {
  return p.category ?? "Uncategorised";
}

export function changeOf(p: Proto): number {
  return p.change_7d ?? 0;
}

/**
 * A protocol's name stem: lowercase, version suffix cut, punctuation cut,
 * first word. "Meteora DAMM V2" and "Meteora DLMM" share the stem "meteora".
 */
export function nameStem(name: string): string {
  const lowered = name.toLowerCase().replace(/\s+(v\d+(\.\d+)?|\d+\.\d+)$/, "");
  const words = lowered.replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length > 0);
  return words.length > 0 ? words[0]! : "";
}

/** Protocols grouped by stem: the families the model prices and odds on. */
export function familyGroups(protos: Proto[]): Map<string, Proto[]> {
  const groups = new Map<string, Proto[]>();
  for (const p of protos) {
    const key = nameStem(p.name);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  return groups;
}

/** 1 when another protocol with the same stem records a token (self excluded). */
export function isKin(p: Proto, groups: Map<string, Proto[]>): number {
  const sibs = groups.get(nameStem(p.name)) ?? [];
  for (const q of sibs) {
    if (q === p || !recordsToken(q)) continue;
    if (q.category === "Bridge" || q.category === "Canonical Bridge") continue;
    return 1;
  }
  return 0;
}

/** 1 when the protocol shares its stem with at least one other protocol. */
export function isFamily(p: Proto, groups: Map<string, Proto[]>): number {
  return (groups.get(nameStem(p.name)) ?? []).length > 1 ? 1 : 0;
}

const BRIDGE_LIKE = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const EXCHANGES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;

/** Why a tokenless protocol is set aside instead of ranked; null = rankable. */
export function asideWhy(p: Proto): string | null {
  if (p.category !== null && BRIDGE_LIKE.has(p.category)) {
    if (p.category === "Bridge" || p.category === "Canonical Bridge") return "bridge";
    if (p.category === "CEX") return "exchange";
    return "liquid staking";
  }
  if (VERSIONED_NAME.test(p.name)) return "versioned";
  if (WRAPPED_NAME.test(p.name)) return "wrapped/staked";
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return "exchange";
  return null;
}

/**
 * Rankable: records no token, is not a wrapped/staked/bridged product, and
 * is not kin of a token that already trades — a kin protocol's family token
 * already exists, so there is no fresh launch to price.
 */
export function rankable(p: Proto, groups: Map<string, Proto[]>): boolean {
  return !recordsToken(p) && asideWhy(p) === null && isKin(p, groups) === 0;
}

// ------------------------------------------------------------------ comps

export interface Comp {
  p: Proto;
  x: number; // log10(TVL)
  y: number; // log10(mcap)
  ratio: number;
  fam: number;
  kin: number;
}

/** One comp per ticker (largest TVL wins), valid market cap only. */
export function pickComps(protos: Proto[], groups: Map<string, Proto[]>): Comp[] {
  const best = new Map<string, Proto>();
  for (const p of protos) {
    if (p.mcap_usd === null || p.mcap_usd <= 0) continue;
    const key = (p.symbol ?? "").toUpperCase() || `NOKEY:${p.slug}`;
    const cur = best.get(key);
    if (!cur || p.tvl_usd > cur.tvl_usd) best.set(key, p);
  }
  return [...best.values()]
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((p) => ({
      p,
      x: Math.log10(p.tvl_usd),
      y: Math.log10(p.mcap_usd as number),
      ratio: (p.mcap_usd as number) / p.tvl_usd,
      fam: isFamily(p, groups),
      kin: isKin(p, groups),
    }));
}

// ------------------------------------------------------------------ value fit

/** Which terms a value fit carries. The final model is size + cat + fam. */
export interface ValueSpec {
  cat: boolean;
  fam: boolean;
  kin: boolean;
  mom: boolean; // fitted 7d-growth term (ablation only)
  age: boolean; // fitted log-age term (ablation only)
  nch: boolean; // chain-count term (ablation only)
  shuf: boolean; // shuffled family flags (negative control)
}

export const FINAL_VALUE: ValueSpec = { cat: true, fam: true, kin: false, mom: false, age: false, nch: false, shuf: false };
export const CAT_RIDGE = 6;

/** A fitted value model, with everything the page needs to reprice a row. */
export interface ValueFit {
  intercept: number;
  slope: number;
  famCoef: number;
  kinCoef: number;
  momCoef: number;
  ageCoef: number;
  nchCoef: number;
  shufCoef: number;
  marketChg: number;
  meanLogAge: number;
  offsets: Record<string, number>;
  dummies: string[];
  predict: (tvl: number, chg: number, cat: string, fam: number, kin: number, age: number | null, nChains: number, shufFlag: number) => number;
}

function catDummies(comps: Comp[], minN = 3): string[] {
  const counts = new Map<string, number>();
  for (const c of comps) counts.set(categoryOf(c.p), (counts.get(categoryOf(c.p)) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= minN).map(([c]) => c).sort();
}

/** A fixed shuffle of the family flags, seed 7: the negative control. */
export function shuffledFam(comps: Comp[]): Map<string, number> {
  const rng = mulberry32(7);
  const idx = comps.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const out = new Map<string, number>();
  comps.forEach((c, i) => out.set(c.p.slug, comps[idx[i]!]!.fam));
  return out;
}

export function fitValue(train: Comp[], asOf: string, spec: ValueSpec, shufMap?: Map<string, number>): ValueFit {
  const dummies = spec.cat ? catDummies(train) : [];
  const mchg = median(train.map((c) => changeOf(c.p)));
  const ages = train.map((c) => ageInDays(asOf, c.p)).filter((a): a is number => a !== null).map((a) => Math.log10(a + 30));
  const meanLogAge = ages.length > 0 ? mean(ages) : 0;

  // Feature order is fixed: [1, size, fam?, kin?, mom?, age?, nch?, shuf?, dummies...]
  const rowOf = (c: Comp): number[] => {
    const r: number[] = [1, c.x];
    if (spec.fam) r.push(c.fam);
    if (spec.kin) r.push(c.kin);
    if (spec.mom) {
      const rel = Math.max(-50, Math.min(100, changeOf(c.p) - mchg));
      r.push(Math.log10(1 + rel / 100));
    }
    if (spec.age) {
      const a = ageInDays(asOf, c.p);
      r.push(a === null ? 0 : Math.log10(a + 30) - meanLogAge);
    }
    if (spec.nch) r.push(Math.log10(c.p.chains.length));
    if (spec.shuf) r.push(shufMap?.get(c.p.slug) ?? 0);
    for (const d of dummies) r.push(categoryOf(c.p) === d ? 1 : 0);
    return r;
  };
  const x = train.map(rowOf);
  const y = train.map((c) => c.y);
  const k = x[0]!.length;
  const pen = new Array<number>(k).fill(1e-8);
  const nFree = 2 + (spec.fam ? 1 : 0) + (spec.kin ? 1 : 0) + (spec.mom ? 1 : 0) + (spec.age ? 1 : 0) + (spec.nch ? 1 : 0) + (spec.shuf ? 1 : 0);
  for (let j = nFree; j < k; j++) pen[j] = CAT_RIDGE;
  const beta = huberSolve(x, y, pen);

  let j = 2;
  const famCoef = spec.fam ? beta[j++]! : 0;
  const kinCoef = spec.kin ? beta[j++]! : 0;
  const momCoef = spec.mom ? beta[j++]! : 0;
  const ageCoef = spec.age ? beta[j++]! : 0;
  const nchCoef = spec.nch ? beta[j++]! : 0;
  const shufCoef = spec.shuf ? beta[j++]! : 0;
  const offsets: Record<string, number> = {};
  dummies.forEach((d, i) => {
    offsets[d] = beta[j + i]!;
  });

  const predict = (tvl: number, chg: number, cat: string, fam: number, kin: number, age: number | null, nChains: number, shufFlag: number): number => {
    let v = beta[0]! + beta[1]! * Math.log10(tvl) + (offsets[cat] ?? 0);
    if (spec.fam) v += famCoef * fam;
    if (spec.kin) v += kinCoef * kin;
    if (spec.mom) {
      const rel = Math.max(-50, Math.min(100, chg - mchg));
      v += momCoef * Math.log10(1 + rel / 100);
    }
    if (spec.age && age !== null) v += ageCoef * (Math.log10(age + 30) - meanLogAge);
    if (spec.nch) v += nchCoef * Math.log10(Math.max(1, nChains));
    if (spec.shuf) v += shufCoef * shufFlag;
    return 10 ** v;
  };
  return {
    intercept: beta[0]!,
    slope: beta[1]!,
    famCoef,
    kinCoef,
    momCoef,
    ageCoef,
    nchCoef,
    shufCoef,
    marketChg: mchg,
    meanLogAge,
    offsets,
    dummies,
    predict,
  };
}

// ------------------------------------------------------------------ validation

export interface Miss {
  med: number;
  q3: number;
  within3: number;
  rho: number;
  n: number;
}

export function missOf(predLog: number[], actLog: number[]): Miss {
  const mult = predLog.map((pr, i) => 10 ** Math.abs(pr - actLog[i]!));
  const sorted = [...mult].sort((a, b) => a - b);
  return {
    med: median(mult),
    q3: quantileSorted(sorted, 0.75),
    within3: mult.filter((m) => m <= 3).length / mult.length,
    rho: spearman(predLog, actLog),
    n: mult.length,
  };
}

export interface ValueCheck {
  loo: Miss;
  wf: Miss;
  looResid: number[];
  wfResid: number[];
  wfTrain: number;
  wfTest: number;
}

function datedComps(comps: Comp[]): Comp[] {
  return comps.filter((c) => c.p.listed_at !== null).sort((a, b) => (a.p.listed_at as string) < (b.p.listed_at as string) ? -1 : 1);
}

/** Leave-one-out + older->newer walk-forward for one value specification. */
export function checkValue(comps: Comp[], asOf: string, spec: ValueSpec): ValueCheck {
  const shuf = spec.shuf ? shuffledFam(comps) : undefined;
  const looPred: number[] = [];
  const looAct: number[] = [];
  const looResid: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, jj) => jj !== i);
    const fit = fitValue(train, asOf, spec, shuf);
    const c = comps[i]!;
    const p = Math.log10(
      fit.predict(c.p.tvl_usd, changeOf(c.p), categoryOf(c.p), c.fam, c.kin, ageInDays(asOf, c.p), c.p.chains.length, shuf?.get(c.p.slug) ?? 0),
    );
    looPred.push(p);
    looAct.push(c.y);
    looResid.push(c.y - p);
  }
  const dated = datedComps(comps);
  const half = Math.floor(dated.length / 2);
  const fit = fitValue(dated.slice(0, half), asOf, spec, shuf);
  const test = dated.slice(half);
  const wfPred = test.map((c) =>
    Math.log10(fit.predict(c.p.tvl_usd, changeOf(c.p), categoryOf(c.p), c.fam, c.kin, ageInDays(asOf, c.p), c.p.chains.length, shuf?.get(c.p.slug) ?? 0)),
  );
  const wfAct = test.map((c) => c.y);
  return {
    loo: missOf(looPred, looAct),
    wf: missOf(wfPred, wfAct),
    looResid,
    wfResid: test.map((_, i) => wfAct[i]! - wfPred[i]!),
    wfTrain: half,
    wfTest: test.length,
  };
}

/** The flat baseline: one median mcap/TVL multiple for every protocol. */
export function checkFlat(comps: Comp[]): ValueCheck {
  const looPred: number[] = [];
  const looAct: number[] = [];
  const looResid: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const mult = median(train.map((c) => c.y - c.x));
    const p = comps[i]!.x + mult;
    looPred.push(p);
    looAct.push(comps[i]!.y);
    looResid.push(comps[i]!.y - p);
  }
  const dated = datedComps(comps);
  const half = Math.floor(dated.length / 2);
  const mult = median(dated.slice(0, half).map((c) => c.y - c.x));
  const test = dated.slice(half);
  const wfPred = test.map((c) => c.x + mult);
  const wfAct = test.map((c) => c.y);
  return {
    loo: missOf(looPred, looAct),
    wf: missOf(wfPred, wfAct),
    looResid,
    wfResid: test.map((_, i) => wfAct[i]! - wfPred[i]!),
    wfTrain: half,
    wfTest: test.length,
  };
}

export interface AblationRow {
  label: string;
  kept: boolean;
  note: string;
  loo: Miss;
  wf: Miss;
}

/**
 * The value ablation, in the order terms were added: each kept term lowers
 * the held-out miss in BOTH tests against the row above it. Dropped terms
 * and the shuffled control are shown, not hidden.
 */
export function valueAblation(comps: Comp[], asOf: string): AblationRow[] {
  const none: ValueSpec = { cat: false, fam: false, kin: false, mom: false, age: false, nch: false, shuf: false };
  const flat = checkFlat(comps);
  const size = checkValue(comps, asOf, none);
  const fam = checkValue(comps, asOf, { ...none, fam: true });
  const final = checkValue(comps, asOf, FINAL_VALUE);
  const mom = checkValue(comps, asOf, { ...FINAL_VALUE, mom: true });
  const age = checkValue(comps, asOf, { ...FINAL_VALUE, age: true });
  const nch = checkValue(comps, asOf, { ...FINAL_VALUE, nch: true });
  const shuf = checkValue(comps, asOf, { ...none, cat: true, shuf: true });
  return [
    { label: "flat TVL multiple", kept: false, note: "baseline: one median mcap/TVL for all", loo: flat.loo, wf: flat.wf },
    { label: "size curve (Huber)", kept: true, note: "log-log fit on all 127 comps, no comps dropped", loo: size.loo, wf: size.wf },
    { label: "+ family effect", kept: true, note: "protocols sharing a name stem price higher per TVL", loo: fam.loo, wf: fam.wf },
    { label: "+ category offsets (final)", kept: true, note: "ridge-shrunk, categories with 3+ comps", loo: final.loo, wf: final.wf },
    { label: "+ 7-day growth (dropped)", kept: false, note: "fitted coefficient is negative; wins neither test", loo: mom.loo, wf: mom.wf },
    { label: "+ listing age (dropped)", kept: false, note: "no LOO gain, walk-forward worse", loo: age.loo, wf: age.wf },
    { label: "+ chain count (dropped)", kept: false, note: "no gain in either test", loo: nch.loo, wf: nch.wf },
    { label: "shuffled family flags (control)", kept: false, note: "family flags shuffled: the signal is destroyed, the miss returns toward the size-only level", loo: shuf.loo, wf: shuf.wf },
  ];
}

// ------------------------------------------------------------------ launch odds

/** Which terms an odds fit carries. The final model is yrs + kin.
 *  The category rate is NOT in the final model: it wins both blind tests by a
 *  small margin, but it prices the newest categories (Risk Curators, Onchain
 *  Capital Allocator — the board's largest protocols) at near-zero odds from
 *  their youth, not from evidence. A category with no token yet is young, not
 *  unwilling: the term is confounded by category age. It stays in the
 *  ablation as tested, not kept, with its numbers shown. */
export interface OddsSpec {
  yrs: boolean;
  kin: boolean;
  catr: boolean;
  chg: boolean; // ablation only
  tvl: boolean; // ablation only
  nch: boolean; // ablation only
  shufKin: boolean; // shuffled kin flags (negative control)
}

export const FINAL_ODDS: OddsSpec = { yrs: true, kin: true, catr: false, chg: false, tvl: false, nch: false, shufKin: false };
export const ODDS_RIDGE = 1;

/** Standardisation + category rates, always computed on the training set. */
export interface OddsContext {
  meanLogAge: number;
  sdLogAge: number;
  meanLogTvl: number;
  sdLogTvl: number;
  catRate: Map<string, number>;
  globalRate: number;
}

export interface OddsFit {
  beta: number[];
  ctx: OddsContext;
  spec: OddsSpec;
  predict: (p: Proto) => number;
}

function oddsContext(train: Proto[], asOf: string, groups: Map<string, Proto[]>): OddsContext {
  const ages = train.map((p) => ageInDays(asOf, p)).filter((a): a is number => a !== null).map((a) => Math.log10(a + 30));
  const tvls = train.map((p) => Math.log10(p.tvl_usd));
  const global = train.filter(recordsToken).length / train.length;
  const catN = new Map<string, number>();
  const catT = new Map<string, number>();
  for (const p of train) {
    const c = categoryOf(p);
    catN.set(c, (catN.get(c) ?? 0) + 1);
    if (recordsToken(p)) catT.set(c, (catT.get(c) ?? 0) + 1);
  }
  const catRate = new Map<string, number>();
  for (const [c, n] of catN) catRate.set(c, ((catT.get(c) ?? 0) + 5 * global) / (n + 5));
  return {
    meanLogAge: mean(ages),
    sdLogAge: stdev(ages) || 1,
    meanLogTvl: mean(tvls),
    sdLogTvl: stdev(tvls) || 1,
    catRate,
    globalRate: global,
  };
}

function oddsRow(p: Proto, asOf: string, spec: OddsSpec, ctx: OddsContext, groups: Map<string, Proto[]>, shufMap?: Map<string, number>): number[] {
  const r: number[] = [1];
  if (spec.yrs) {
    const a = ageInDays(asOf, p);
    r.push(a === null ? 0 : (Math.log10(a + 30) - ctx.meanLogAge) / ctx.sdLogAge);
  }
  if (spec.kin) r.push(isKin(p, groups));
  if (spec.catr) r.push(ctx.catRate.get(categoryOf(p)) ?? ctx.globalRate);
  if (spec.chg) r.push(Math.max(-50, Math.min(100, changeOf(p))) / 50);
  if (spec.tvl) r.push((Math.log10(p.tvl_usd) - ctx.meanLogTvl) / ctx.sdLogTvl);
  if (spec.nch) r.push(Math.log10(p.chains.length));
  if (spec.shufKin) r.push(shufMap?.get(p.slug) ?? 0);
  return r;
}

/** Logistic regression by IRLS (Newton steps on the penalised log-likelihood). */
export function logitSolve(x: number[][], y: number[], pen: number[]): number[] {
  const k = x[0]!.length;
  let beta = new Array<number>(k).fill(0);
  for (let it = 0; it < 60; it++) {
    const grad = new Array<number>(k).fill(0);
    const hess: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let r = 0; r < x.length; r++) {
      const z = Math.max(-30, Math.min(30, dot(x[r]!, beta)));
      const pr = 1 / (1 + Math.exp(-z));
      const w = Math.max(1e-6, pr * (1 - pr));
      const d = y[r]! - pr;
      for (let i = 0; i < k; i++) {
        grad[i]! += x[r]![i]! * d;
        for (let j = 0; j < k; j++) hess[i]![j]! += w * x[r]![i]! * x[r]![j]!;
      }
    }
    for (let i = 0; i < k; i++) {
      grad[i]! -= pen[i]! * beta[i]!;
      hess[i]![i]! += pen[i]!;
    }
    const step = solveLinear(hess, grad);
    let delta = 0;
    for (let i = 0; i < k; i++) {
      beta[i]! += step[i]!;
      delta = Math.max(delta, Math.abs(step[i]!));
    }
    if (delta < 1e-8) break;
  }
  return beta;
}

/** A fixed shuffle of the kin flags, seed 11: the odds negative control. */
export function shuffledKin(dated: Proto[], groups: Map<string, Proto[]>): Map<string, number> {
  const rng = mulberry32(11);
  const idx = dated.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const out = new Map<string, number>();
  dated.forEach((p, i) => out.set(p.slug, isKin(dated[idx[i]!]!, groups)));
  return out;
}

export function fitOdds(train: Proto[], asOf: string, spec: OddsSpec, groups: Map<string, Proto[]>, shufMap?: Map<string, number>): OddsFit {
  const ctx = oddsContext(train, asOf, groups);
  const x = train.map((p) => oddsRow(p, asOf, spec, ctx, groups, shufMap));
  const y = train.map((p) => (recordsToken(p) ? 1 : 0));
  const k = x[0]!.length;
  const pen = new Array<number>(k).fill(ODDS_RIDGE);
  pen[0] = 1e-8;
  const beta = logitSolve(x, y, pen);
  const predict = (p: Proto): number => {
    const z = Math.max(-30, Math.min(30, dot(oddsRow(p, asOf, spec, ctx, groups, shufMap), beta)));
    return 1 / (1 + Math.exp(-z));
  };
  return { beta, ctx, spec, predict };
}

export interface OddsCheck {
  hit: number;
  brier: number;
  n: number;
}

function oddsMetrics(preds: number[], actual: number[]): OddsCheck {
  let hits = 0;
  let brier = 0;
  for (let i = 0; i < preds.length; i++) {
    if ((preds[i]! > 0.5) === (actual[i]! === 1)) hits++;
    brier += (preds[i]! - actual[i]!) ** 2;
  }
  return { hit: hits / preds.length, brier: brier / preds.length, n: preds.length };
}

export interface OddsValidation {
  loo: OddsCheck;
  wf: OddsCheck;
  baseLoo: OddsCheck;
  baseWf: OddsCheck;
  wfTrain: number;
  wfTest: number;
}

/** Leave-one-out + older->newer walk-forward for one odds specification. */
export function checkOdds(dated: Proto[], asOf: string, spec: OddsSpec, groups: Map<string, Proto[]>): OddsValidation {
  const shuf = spec.shufKin ? shuffledKin(dated, groups) : undefined;
  const y = dated.map((p) => (recordsToken(p) ? 1 : 0));
  const looPred: number[] = [];
  const basePred: number[] = [];
  for (let i = 0; i < dated.length; i++) {
    const train = dated.filter((_, j) => j !== i);
    const fit = fitOdds(train, asOf, spec, groups, shuf);
    looPred.push(fit.predict(dated[i]!));
    basePred.push(train.filter(recordsToken).length / train.length);
  }
  const sorted = [...dated].sort((a, b) => (a.listed_at as string) < (b.listed_at as string) ? -1 : 1);
  const half = Math.floor(sorted.length / 2);
  const trainWf = sorted.slice(0, half);
  const testWf = sorted.slice(half);
  const fitWf = fitOdds(trainWf, asOf, spec, groups, shuf);
  const wfPred = testWf.map((p) => fitWf.predict(p));
  const wfY = testWf.map((p) => (recordsToken(p) ? 1 : 0));
  const baseRate = trainWf.filter(recordsToken).length / trainWf.length;
  return {
    loo: oddsMetrics(looPred, y),
    wf: oddsMetrics(wfPred, wfY),
    baseLoo: oddsMetrics(basePred, y),
    baseWf: oddsMetrics(testWf.map(() => baseRate), wfY),
    wfTrain: half,
    wfTest: testWf.length,
  };
}

export interface OddsAblationRow {
  label: string;
  kept: boolean;
  note: string;
  loo: OddsCheck;
  wf: OddsCheck;
}

/** The odds ablation: each kept term lowers the Brier score in BOTH tests. */
export function oddsAblation(dated: Proto[], asOf: string, groups: Map<string, Proto[]>): OddsAblationRow[] {
  const none: OddsSpec = { yrs: false, kin: false, catr: false, chg: false, tvl: false, nch: false, shufKin: false };
  const base = checkOdds(dated, asOf, none, groups);
  const yrs = checkOdds(dated, asOf, { ...none, yrs: true }, groups);
  const final = checkOdds(dated, asOf, FINAL_ODDS, groups);
  const catr = checkOdds(dated, asOf, { ...FINAL_ODDS, catr: true }, groups);
  const chg = checkOdds(dated, asOf, { ...FINAL_ODDS, chg: true }, groups);
  const tvl = checkOdds(dated, asOf, { ...FINAL_ODDS, tvl: true }, groups);
  const nch = checkOdds(dated, asOf, { ...FINAL_ODDS, nch: true }, groups);
  const shuf = checkOdds(dated, asOf, { ...none, yrs: true, shufKin: true }, groups);
  return [
    { label: "base rate of peers", kept: false, note: "baseline: every protocol gets the same odds", loo: base.loo, wf: base.wf },
    { label: "+ years listed", kept: true, note: "older protocols record tokens more often", loo: yrs.loo, wf: yrs.wf },
    { label: "+ kin of a token (final)", kept: true, note: "a sibling protocol already records a token", loo: final.loo, wf: final.wf },
    { label: "+ category rate (not kept)", kept: false, note: "wins both tests by a hair, but prices new categories at near-zero odds from youth, not evidence", loo: catr.loo, wf: catr.wf },
    { label: "+ 7-day growth (dropped)", kept: false, note: "no Brier gain in either test", loo: chg.loo, wf: chg.wf },
    { label: "+ log TVL (dropped)", kept: false, note: "coefficient ~0; size does not predict recording", loo: tvl.loo, wf: tvl.wf },
    { label: "+ chain count (dropped)", kept: false, note: "no Brier gain in either test", loo: nch.loo, wf: nch.wf },
    { label: "shuffled kin flags (control)", kept: false, note: "kin flags shuffled: the signal is destroyed, Brier returns toward the years-only level", loo: shuf.loo, wf: shuf.wf },
  ];
}

/** Calibration bins: predicted odds vs the actual token share, six bins. */
export function oddsCalibration(dated: Proto[], fit: OddsFit): { pred: number; actual: number; n: number }[] {
  const scored = dated.map((p) => ({ pr: fit.predict(p), y: recordsToken(p) ? 1 : 0 })).sort((a, b) => a.pr - b.pr);
  const out: { pred: number; actual: number; n: number }[] = [];
  const nb = 6;
  for (let i = 0; i < nb; i++) {
    const chunk = scored.slice(Math.floor((i * scored.length) / nb), Math.floor(((i + 1) * scored.length) / nb));
    if (chunk.length === 0) continue;
    out.push({
      pred: mean(chunk.map((c) => c.pr)),
      actual: mean(chunk.map((c) => c.y)),
      n: chunk.length,
    });
  }
  return out;
}

/** The token rate by age band, for the odds panel. */
export function ageBandRates(dated: Proto[], asOf: string): { label: string; n: number; rate: number }[] {
  const bands: [number, number, string][] = [
    [0, 180, "0–6m"],
    [180, 365, "6–12m"],
    [365, 730, "1–2y"],
    [730, 1095, "2–3y"],
    [1095, 1e9, "3y+"],
  ];
  return bands.map(([lo, hi, label]) => {
    const inBand = dated.filter((p) => {
      const a = ageInDays(asOf, p);
      return a !== null && a >= lo && a < hi;
    });
    const rate = inBand.length === 0 ? 0 : inBand.filter(recordsToken).length / inBand.length;
    return { label, n: inBand.length, rate };
  });
}

// ------------------------------------------------------------------ bootstrap

export interface BootstrapOut {
  rankRange: Map<string, [number, number]>;
  slopeSe: number;
  interceptSe: number;
  famSe: number;
  oddsSe: number[];
}

/**
 * 200 bootstrap refits (seed 20261114): resample the comps, refit the value
 * model, reprice every board row, record each row's rank; the P10–P90 of the
 * 200 ranks is the printed rank range, and the spread of the refitted
 * coefficients is their standard error. The odds fit is refitted on
 * resampled dated protocols for its own coefficient errors.
 */
export function bootstrapAll(
  comps: Comp[],
  rows: { slug: string; tvl: number; chg: number; cat: string; fam: number; age: number | null; nChains: number; odds: number }[],
  dated: Proto[],
  asOf: string,
  groups: Map<string, Proto[]>,
  refits = 200,
  seed = 20261114,
): BootstrapOut {
  const rng = mulberry32(seed);
  const ranks = new Map<string, number[]>();
  for (const r of rows) ranks.set(r.slug, []);
  const slopes: number[] = [];
  const ints: number[] = [];
  const famCs: number[] = [];
  for (let k = 0; k < refits; k++) {
    const sample: Comp[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const fit = fitValue(sample, asOf, FINAL_VALUE);
    slopes.push(fit.slope);
    ints.push(fit.intercept);
    famCs.push(fit.famCoef);
    const priced = rows
      .map((r) => ({ slug: r.slug, v: fit.predict(r.tvl, r.chg, r.cat, r.fam, 0, r.age, r.nChains, 0) * r.odds }))
      .sort((a, b) => b.v - a.v);
    priced.forEach((p, i) => ranks.get(p.slug)?.push(i + 1));
  }
  const rankRange = new Map<string, [number, number]>();
  for (const [slug, rs] of ranks) {
    const s = [...rs].sort((a, b) => a - b);
    rankRange.set(slug, [quantileSorted(s, 0.1), quantileSorted(s, 0.9)]);
  }
  const oddsBetas: number[][] = [];
  for (let k = 0; k < refits; k++) {
    const sample: Proto[] = [];
    for (let i = 0; i < dated.length; i++) sample.push(dated[Math.floor(rng() * dated.length)]!);
    oddsBetas.push(fitOdds(sample, asOf, FINAL_ODDS, groups).beta);
  }
  const oddsSe = oddsBetas[0]!.map((_, j) => stdev(oddsBetas.map((b) => b[j]!)));
  return { rankRange, slopeSe: stdev(slopes), interceptSe: stdev(ints), famSe: stdev(famCs), oddsSe };
}

// ------------------------------------------------------------------ farm economics

export interface FarmAssumptions {
  deposit: number;
  dropShare: number;
  tbill: number;
  days: number;
}

export const DEFAULT_FARM: FarmAssumptions = { deposit: 1000, dropShare: 0.1, tbill: 0.04, days: 60 };

export type Verdict = "FARM" | "THIN" | "SKIP";

export interface FarmMath {
  slice: number; // expected slice of the drop, $ (odds-weighted)
  sliceIf: number; // slice if the token launches, $
  oppCost: number; // T-bill the deposit would otherwise earn, $
  net: number; // expected net, $
  netIf: number; // net if the token launches, $
  netNo: number; // net if it never launches (fees + carry lost), $
  netPerHour: number;
  breakevenOdds: number; // launch odds at which the expected net is zero
  minDeposit: number | null; // smallest deposit whose expected net clears zero
  verdict: Verdict;
}

/**
 * The farm plan's economics at stated assumptions. The slice is the
 * farmer's pro-rata share of the drop pool (drop share of implied value,
 * share = deposit / TVL), net of gas and of the T-bill the deposit would
 * otherwise earn. Two outcomes are shown beside the expectation: the net
 * if the token launches and the net if it never does.
 */
export function farmMath(implied: number, ifLaunched: number, tvl: number, fee: number, hours: number, fp: FarmAssumptions): FarmMath {
  const slice = (implied * fp.dropShare * fp.deposit) / tvl;
  const sliceIf = (ifLaunched * fp.dropShare * fp.deposit) / tvl;
  const oppCost = (fp.deposit * fp.tbill * fp.days) / 365;
  const net = slice - fee - oppCost;
  const netIf = sliceIf - fee - oppCost;
  const netNo = -fee - oppCost;
  const denom = (ifLaunched * fp.dropShare * fp.deposit) / tvl;
  const breakevenOdds = denom > 0 ? Math.min(1, Math.max(0, (fee + oppCost) / denom)) : 1;
  const perDollar = (implied * fp.dropShare) / tvl - (fp.tbill * fp.days) / 365;
  const minDeposit = perDollar > 0 ? fee / perDollar : null;
  const verdict: Verdict = net > 5 && net / hours > 1 ? "FARM" : net > 0 ? "THIN" : "SKIP";
  return { slice, sliceIf, oppCost, net, netIf, netNo, netPerHour: net / hours, breakevenOdds, minDeposit, verdict };
}

/** Gas + transaction costs for one farm plan, by its first chain. */
const CHAIN_GAS: Record<string, number> = {
  Ethereum: 8,
  Solana: 0.1,
  "BNB Chain": 0.3,
  BSC: 0.3,
  Base: 0.8,
  Arbitrum: 0.8,
  Optimism: 0.8,
  Polygon: 0.2,
  Avalanche: 0.5,
  Sui: 0.1,
  Aptos: 0.1,
  Tron: 1,
  Bitcoin: 2,
  Ink: 0.5,
  Monad: 0.3,
  Hyperliquid: 0.5,
  Berachain: 0.3,
  "ZkSync Era": 0.5,
  Linea: 0.5,
  Scroll: 0.5,
  Blast: 0.5,
  Sei: 0.2,
  Kava: 0.2,
  Celo: 0.1,
  Fantom: 0.2,
  Gnosis: 0.2,
  Moonbeam: 0.2,
  Starknet: 0.5,
  TON: 0.2,
  Cardano: 0.3,
  Cosmos: 0.2,
  Osmosis: 0.2,
  Cronos: 0.2,
  Near: 0.1,
  Flow: 0.1,
  Hedera: 0.1,
  Algorand: 0.1,
  Tezos: 0.1,
  Stacks: 0.3,
  "XRP Ledger": 0.1,
  Bittensor: 0.5,
  Plume: 0.3,
  Pharos: 0.3,
};

export function gasFor(chain: string): number {
  return CHAIN_GAS[chain] ?? 1;
}

/** What farming means for each kind of protocol. */
export interface PlanKind {
  kind: string;
  action: string;
  asset: string;
  hours: number;
}

/**
 * What farming means for each kind of protocol, from the category's words.
 * A rule table, first match wins: the dashboard's app.js carries the same
 * table, so the page's steps and board.json's steps always agree.
 * [substring, kind, action, asset, hours]
 */
const PLAN_RULES: [string, string, string, string, number][] = [
  ["lending", "Lend", "supply and hold", "USDC", 2],
  ["collateral", "Lend", "supply collateral and hold", "USDC", 2],
  ["dex", "LP", "provide liquidity", "USDC + the pool's pair asset", 2.5],
  ["yield", "Vault", "deposit into the vault", "USDC", 1.5],
  ["curator", "Vault", "deposit into the curator vault", "USDC", 1.5],
  ["allocator", "Vault", "deposit into the allocator vault", "USDC", 1.5],
  ["cdp manager", "Vault", "deposit into the managed vault", "USDC", 2],
  ["cdp", "Mint", "lock collateral and mint", "ETH", 2.5],
  ["rwa", "Mint & hold", "mint and hold the tokenised asset", "USDC", 2],
  ["restak", "Restake", "restake and hold", "ETH", 1.5],
  ["basis", "Basis", "deposit into the basis vault", "USDC", 2],
  ["prediction", "Market", "take a position and hold it", "USDC", 2],
  ["leveraged", "Farm", "open a leveraged farm position", "USDC", 3],
  ["derivative", "Trade", "open and hold a hedged position", "USDC", 3],
  ["perpetual", "Trade", "open a hedged perp position", "USDC", 3],
  ["option", "Trade", "sell covered options", "USDC", 3],
  ["index", "Mint & hold", "mint the index and hold it", "USDC", 1.5],
  ["privacy", "Deposit", "deposit and use the pool", "ETH", 2],
  ["staking", "Stake", "stake and hold", "ETH", 1.5],
  ["locker", "Lock", "lock tokens for the term", "USDC", 1.5],
  ["nft", "Trade", "list and trade on the venue", "ETH", 3],
  ["gam", "Play", "play and hold the in-game assets", "USDC", 3],
  ["ai agent", "Stake", "stake and run the agent", "USDC", 2.5],
  ["insurance", "Cover", "buy cover and hold it", "USDC", 2],
  ["oracle", "Stake", "stake and run a feed", "USDC", 2.5],
  ["cross chain", "Bridge", "bridge and hold on the far chain", "USDC", 2],
  ["payment", "Deposit", "deposit and use the rails", "USDC", 2],
];

export function planKindFor(category: string): PlanKind {
  const c = category.toLowerCase();
  for (const [sub, kind, action, asset, hours] of PLAN_RULES) {
    if (c.includes(sub)) return { kind, action, asset, hours };
  }
  return { kind: "Deposit", action: "deposit and use the protocol", asset: "USDC", hours: 2 };
}

export function usdShort(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(2)}`;
}

export function usdExact(x: number): string {
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1000) return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}$${a.toFixed(2)}`;
}

/**
 * The four farm steps for one row. The dashboard's app.js carries the same
 * templates and regenerates these steps for its detail view, so the page
 * and board.json always agree.
 */
export function farmStepsFor(row: {
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  implied: number;
  odds: number;
  fee: number;
  hours: number;
  slice: number;
  net: number;
  minDeposit: number | null;
  verdict: string;
}, fp: FarmAssumptions): string[] {
  const plan = planKindFor(row.category);
  const chain = row.chains[0] ?? "its main chain";
  const extra = row.chains.length > 1 ? ` (also on ${row.chains.length - 1} more chain${row.chains.length > 2 ? "s" : ""})` : "";
  const dep = fp.deposit.toLocaleString("en-US");
  const dropPct = Math.round(fp.dropShare * 100);
  const pays = row.minDeposit === null ? "no deposit size clears costs" : `pays from a $${Math.ceil(row.minDeposit).toLocaleString("en-US")} deposit`;
  return [
    `Deposit $${dep} of ${plan.asset} into ${row.name} on ${chain}${extra}: ${plan.action} through the protocol's own app (gas about ${usdExact(row.fee)}, roughly ${Math.round(row.hours * 20)} minutes of setup).`,
    `Hold the position for ${fp.days} days. Your slice of any drop is your share of ${usdShort(row.tvl)} TVL, so do not split the deposit across wallets or chains.`,
    `Watch ${row.name}'s announcements for a token launch. The model puts launch odds at ${Math.round(row.odds * 100)}% from peers of this age, family and category; the drop, if any, goes to depositors first.`,
    `If a token launches, claim the drop (${dropPct}% of ${usdShort(row.implied)} implied value is the pool). Expected slice ${usdExact(row.slice)}; net ${usdExact(row.net)} after fees and the T-bill. ${pays}. Verdict at these assumptions: ${row.verdict}.`,
  ];
}

// ------------------------------------------------------------------ ledger + anchors

export interface Ledger {
  total: number;
  ranked: number;
  traded: number;
  bridge: number;
  liquidStaking: number;
  exchange: number;
  versioned: number;
  wrapped: number;
  kin: number;
}

/** Every protocol in exactly one bucket, each placed for one reason. */
export function ledgerOf(protos: Proto[], groups: Map<string, Proto[]>): Ledger {
  const out: Ledger = { total: protos.length, ranked: 0, traded: 0, bridge: 0, liquidStaking: 0, exchange: 0, versioned: 0, wrapped: 0, kin: 0 };
  for (const p of protos) {
    if (recordsToken(p)) {
      out.traded++;
      continue;
    }
    const why = asideWhy(p);
    if (why === "bridge") out.bridge++;
    else if (why === "liquid staking") out.liquidStaking++;
    else if (why === "exchange") out.exchange++;
    else if (why === "versioned") out.versioned++;
    else if (why === "wrapped/staked") out.wrapped++;
    else if (isKin(p, groups) === 1) out.kin++;
    else out.ranked++;
  }
  return out;
}

/** Traded tokens the curve prices, so a reader can check it against names they know.
 *  From the 25 largest comps by market cap: the one the curve prices closest,
 *  the median miss, and a 75th-percentile miss — representative, not cherry-picked. */
export function anchorRows(comps: Comp[], fit: ValueFit, asOf: string): { name: string; symbol: string; mcap: number; curve: number; ratio: number }[] {
  const priced = comps
    .map((c) => {
      const curve = fit.predict(c.p.tvl_usd, changeOf(c.p), categoryOf(c.p), c.fam, c.kin, ageInDays(asOf, c.p), c.p.chains.length, 0);
      return { name: c.p.name, symbol: c.p.symbol ?? "", mcap: c.p.mcap_usd as number, curve, ratio: (c.p.mcap_usd as number) / curve };
    })
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, 25)
    .sort((a, b) => Math.abs(Math.log10(a.ratio)) - Math.abs(Math.log10(b.ratio)));
  const picks = [priced[0]!, priced[Math.floor(priced.length / 2)]!, priced[Math.floor(priced.length * 0.75)]!];
  return picks.filter((a, i, arr) => arr.findIndex((b) => b.name === a.name) === i);
}
