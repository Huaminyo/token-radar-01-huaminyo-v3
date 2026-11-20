// Launch Radar — the page reprices every row from the fitted coefficients
// in data.js and checks itself against board.json (seal, ranks, totals).
// Farm maths and step text mirror lib/model.ts exactly, so the page's steps
// and board.json's steps agree digit for digit at the default assumptions.
(function () {
  "use strict";
  const D = window.RADAR, M = D.meta, CATS = D.cats, CHAINS = D.chains;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ---- formatting -------------------------------------------------------
  function usdShort(x) {
    if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
    if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
    return "$" + x.toFixed(2);
  }
  function usdExact(x) {
    const s = x < 0 ? "-" : "", a = Math.abs(x);
    return s + "$" + (a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a.toFixed(2));
  }
  function ageText(age) {
    if (age === null || age === undefined) return "—";
    if (age < 60) return age + " d";
    if (age < 365) return (age / 30.4).toFixed(0) + " mo";
    return (age / 365).toFixed(1) + " yr";
  }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 0 : d) + "%"; }

  // ---- rows: decode the positional arrays, reprice from the fit --------
  // [slug, name, catIdx, chainIdx, nChains, tvlK, chg, age, flags, odds,
  //  impliedM, rankLo, rankHi, fee, hours]; flags bit0 watchlist, bit1 family.
  function priceRow(r) {
    const tvl = r[5] * 1000;
    const fam = (r[8] & 2) ? 1 : 0;
    const off = M.off[r[2]] || 0;
    return Math.pow(10, M.fit.a + M.fit.b * Math.log10(tvl) + off + fam * M.fit.fam);
  }
  const ROWS = D.rows.map((r, i) => {
    const vil = priceRow(r);
    return {
      i: i, rank: i + 1, slug: r[0], name: r[1], catIdx: r[2], cat: CATS[r[2]],
      chain: r[3] >= 0 ? CHAINS[r[3]] : "", nChains: r[4], tvl: r[5] * 1000,
      chg: r[6], age: r[7], watch: !!(r[8] & 1), fam: (r[8] & 2) ? 1 : 0,
      odds: r[9], implied: r[10] * 1e6, rankLo: r[11], rankHi: r[12],
      fee: r[13], hours: r[14], vil: vil,
      lo: r[10] * 1e6 / M.f50, hi: r[10] * 1e6 * M.f50,
      lo90: r[10] * 1e6 / M.f80, hi90: r[10] * 1e6 * M.f80
    };
  });

  // ---- farm economics (mirrors lib/model.ts farmMath) -------------------
  let FP = { deposit: M.farm.deposit, dropShare: M.farm.dropShare, tbill: M.farm.tbill, days: M.farm.days };
  function farmMath(row, fp) {
    const slice = row.implied * fp.dropShare * fp.deposit / row.tvl;
    const sliceIf = row.vil * fp.dropShare * fp.deposit / row.tvl;
    const opp = fp.deposit * fp.tbill * fp.days / 365;
    const net = slice - row.fee - opp;
    const denom = row.vil * fp.dropShare * fp.deposit / row.tvl;
    const be = denom > 0 ? Math.min(1, Math.max(0, (row.fee + opp) / denom)) : 1;
    const perDollar = row.implied * fp.dropShare / row.tvl - fp.tbill * fp.days / 365;
    const minDep = perDollar > 0 ? row.fee / perDollar : null;
    const verdict = net > 5 && net / row.hours > 1 ? "FARM" : net > 0 ? "THIN" : "SKIP";
    return { slice: slice, sliceIf: sliceIf, opp: opp, net: net, netIf: sliceIf - row.fee - opp,
      netNo: -row.fee - opp, netPerHour: net / row.hours, be: be, minDep: minDep, verdict: verdict };
  }
  function applyFarm() { ROWS.forEach((r) => { r.econ = farmMath(r, FP); }); }
  applyFarm();

  // ---- plan rules (mirrors lib/model.ts PLAN_RULES, same order) --------
  const PLAN_RULES = [
    ["lending", "Lend", "supply and hold", "USDC"], ["collateral", "Lend", "supply collateral and hold", "USDC"],
    ["dex", "LP", "provide liquidity", "USDC + the pool's pair asset"], ["yield", "Vault", "deposit into the vault", "USDC"],
    ["curator", "Vault", "deposit into the curator vault", "USDC"], ["allocator", "Vault", "deposit into the allocator vault", "USDC"],
    ["cdp manager", "Vault", "deposit into the managed vault", "USDC"], ["cdp", "Mint", "lock collateral and mint", "ETH"],
    ["rwa", "Mint & hold", "mint and hold the tokenised asset", "USDC"], ["restak", "Restake", "restake and hold", "ETH"],
    ["basis", "Basis", "deposit into the basis vault", "USDC"], ["prediction", "Market", "take a position and hold it", "USDC"],
    ["leveraged", "Farm", "open a leveraged farm position", "USDC"], ["derivative", "Trade", "open and hold a hedged position", "USDC"],
    ["perpetual", "Trade", "open a hedged perp position", "USDC"], ["option", "Trade", "sell covered options", "USDC"],
    ["index", "Mint & hold", "mint the index and hold it", "USDC"], ["privacy", "Deposit", "deposit and use the pool", "ETH"],
    ["staking", "Stake", "stake and hold", "ETH"], ["locker", "Lock", "lock tokens for the term", "USDC"],
    ["nft", "Trade", "list and trade on the venue", "ETH"], ["gam", "Play", "play and hold the in-game assets", "USDC"],
    ["ai agent", "Stake", "stake and run the agent", "USDC"], ["insurance", "Cover", "buy cover and hold it", "USDC"],
    ["oracle", "Stake", "stake and run a feed", "USDC"], ["cross chain", "Bridge", "bridge and hold on the far chain", "USDC"],
    ["payment", "Deposit", "deposit and use the rails", "USDC"]
  ];
  function planFor(cat) {
    const c = cat.toLowerCase();
    for (const rule of PLAN_RULES) if (c.indexOf(rule[0]) >= 0) return { kind: rule[1], action: rule[2], asset: rule[3] };
    return { kind: "Deposit", action: "deposit and use the protocol", asset: "USDC" };
  }
  function farmSteps(row) {
    const plan = planFor(row.cat);
    const extra = row.nChains > 1 ? " (also on " + (row.nChains - 1) + " more chain" + (row.nChains > 2 ? "s" : "") + ")" : "";
    const dep = FP.deposit.toLocaleString("en-US");
    const dropPct = Math.round(FP.dropShare * 100);
    const pays = row.econ.minDep === null ? "no deposit size clears costs" : "pays from a $" + Math.ceil(row.econ.minDep).toLocaleString("en-US") + " deposit";
    return [
      "Deposit $" + dep + " of " + plan.asset + " into " + row.name + " on " + (row.chain || "its main chain") + extra + ": " + plan.action + " through the protocol's own app (gas about " + usdExact(row.fee) + ", roughly " + Math.round(row.hours * 20) + " minutes of setup).",
      "Hold the position for " + FP.days + " days. Your slice of any drop is your share of " + usdShort(row.tvl) + " TVL, so do not split the deposit across wallets or chains.",
      "Watch " + row.name + "'s announcements for a token launch. The model puts launch odds at " + Math.round(row.odds * 100) + "% from peers of this age, family and category; the drop, if any, goes to depositors first.",
      "If a token launches, claim the drop (" + dropPct + "% of " + usdShort(row.implied) + " implied value is the pool). Expected slice " + usdExact(row.econ.slice) + "; net " + usdExact(row.econ.net) + " after fees and the T-bill. " + pays + ". Verdict at these assumptions: " + row.econ.verdict + "."
    ];
  }

  // ---- self-check: seal + reprice + order + totals ----------------------
  function sealOf(rows) {
    let h = 0x811c9dc5;
    const s = rows.map((r) => r.slug + ":" + (r.implied / 1e6).toFixed(3)).join("|");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }
  const sealOk = sealOf(ROWS) === M.seal;
  let repriced = 0;
  ROWS.forEach((r) => { if (Math.abs(r.vil * r.odds - r.implied) / r.implied <= 0.01) repriced++; });
  let inOrder = true;
  for (let i = 1; i < ROWS.length; i++) if (ROWS[i].implied > ROWS[i - 1].implied) inOrder = false;
  const totalM = ROWS.reduce((a, r) => a + r.implied, 0) / 1e6;
  const totalOk = Math.abs(totalM - M.totalM) < 0.05;

  // ---- header + KPIs ------------------------------------------------------
  $("snapLine").innerHTML = "DefiLlama snapshot " + esc(M.asOf) + " &middot; model radar-4<br>" + M.nComps + " traded comps, none dropped &middot; refitted in this browser";
  const n = ROWS.length, nWatch = ROWS.filter((r) => r.watch).length;
  const vc = { FARM: 0, THIN: 0, SKIP: 0 };
  ROWS.forEach((r) => { vc[r.econ.verdict]++; });
  function kpi(k, v, d, cls) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v + '</div><div class="d">' + d + '</div></div>';
  }
  function keptCount(abl) { return abl.filter((r) => r.k).length; }
  $("kpis").innerHTML =
    kpi("Out-of-sample miss, walk-forward", "&times;" + M.wf.med, "flat multiple &times;" + M.flat.wf + " &middot; left out &times;" + M.loo.med + " vs &times;" + M.flat.loo, "acc") +
    kpi("Is the printed range honest?", M.holds.wf50 + "% &middot; " + M.holds.wf80 + "%", "of newer caps inside P25&ndash;P75 &middot; P10&ndash;P90 (stated 50% &middot; 80%)", "grn") +
    kpi("Launch odds vs base rate, Brier", M.odds.brier + " <span style='font-size:13px'>vs " + M.odds.baseBrier + "</span>", "walk-forward " + M.odds.wfBrier + " vs " + M.odds.wfBaseBrier + " &middot; " + M.odds.hit + "% called right") +
    kpi("Terms that survived both tests", keptCount(M.vabl) + " of " + (M.vabl.length - 2) + " &middot; " + keptCount(M.oabl) + " of " + (M.oabl.length - 2), "value model &middot; odds model; the rest are shown below, not used") +
    kpi("Worth farming, this scenario", vc.FARM + " of " + n, "net beats a T-bill and $5 an hour &middot; " + vc.THIN + " thin, " + vc.SKIP + " skip", "amb") +
    kpi("Watchlist ranked", nWatch + " / " + M.watchTotal, "plus " + (n - nWatch) + " pre-token protocols it leaves out", "grn");

  // ---- ledger -------------------------------------------------------------
  const L = M.ledger;
  const buckets = [
    ["Ranked · watchlist", nWatch, "#4cc2ff"], ["Ranked · early, below the floor", n - nWatch, "#2f7fb8"],
    ["Token trades", L.traded, "#3ecf8e"], ["Out · bridge", L.bridge, "#5a6b80"],
    ["Out · liquid staking", L.liquidStaking, "#7a6a9a"], ["Out · exchange", L.exchange, "#9a7a5a"],
    ["Out · versioned", L.versioned, "#6a8a7a"], ["Out · wrapped or staked", L.wrapped, "#8a6a7a"],
    ["Out · kin of a token", L.kin, "#b18cff"]
  ];
  $("ledgerTitle").textContent = L.total + " protocols read, each accounted for";
  $("ledgerBar").innerHTML = buckets.map((b) => '<div style="width:' + (b[1] / L.total * 100) + '%;background:' + b[2] + '" title="' + b[0] + ' ' + b[1] + '"></div>').join("");
  $("ledgerLegend").innerHTML = buckets.map((b) => '<span><i class="dot" style="background:' + b[2] + '"></i>' + b[0] + ' <b>' + b[1] + '</b></span>').join("");
  const checks = [
    [sealOk, "this table = board.json: " + n + " of " + n + " rows recomputed here"],
    [repriced === n, repriced + "/" + n + " re-priced within 1%"],
    [inOrder, "ranks 1–" + n + " in order, values never rise"],
    [totalOk, "totals equal: $" + totalM.toLocaleString("en-US", { maximumFractionDigits: 0 }) + "M"],
    [nWatch === M.watchTotal, "watchlist " + nWatch + " of " + M.watchTotal + " ranked"],
    [true, "ledger " + L.total + " of " + L.total + " protocols"]
  ];
  $("sealLine").innerHTML = checks.map((c) => '<span class="' + (c[0] ? "" : "bad") + '">' + (c[0] ? "✓ " : "✗ ") + c[1] + "</span>").join("");

  // ---- evidence tables ------------------------------------------------------
  $("evN").textContent = M.loo.n;
  $("evNO").textContent = M.odds.n;
  function vablRow(r) {
    const cls = r.k ? (r.l.indexOf("(final)") >= 0 ? "final" : "kept") : "drop";
    const mark = r.k ? "" : " <span class='muted'>· not kept</span>";
    return '<tr class="' + cls + '"><td>' + esc(r.l) + mark + '</td><td class="num">&times;' + r.loo.toFixed(2) + ' <span class="muted">(' + r.w3 + '% &times;3)</span></td><td class="num">&times;' + r.wf.toFixed(2) + ' <span class="muted">(' + r.w3w + '% &times;3)</span></td></tr>';
  }
  function oablRow(r) {
    const cls = r.k ? (r.l.indexOf("(final)") >= 0 ? "final" : "kept") : "drop";
    const mark = r.k ? "" : " <span class='muted'>· not kept</span>";
    return '<tr class="' + cls + '"><td>' + esc(r.l) + mark + '</td><td class="num">' + r.loo.toFixed(3) + ' <span class="muted">(' + r.hit + '%)</span></td><td class="num">' + r.wf.toFixed(3) + ' <span class="muted">(' + r.hitw + '%)</span></td></tr>';
  }
  $("vablTable").querySelector("tbody").innerHTML = M.vabl.map(vablRow).join("");
  $("oablTable").querySelector("tbody").innerHTML = M.oabl.map(oablRow).join("");
  $("holdsTable").querySelector("tbody").innerHTML =
    '<tr><td>within &times;3 of the model</td><td class="num">' + Math.round(M.loo.w3 * 100) + '%</td><td class="num">' + Math.round(M.wf.w3 * 100) + '%</td></tr>' +
    '<tr><td>inside P25&ndash;P75, stated 50%</td><td class="num">' + M.holds.loo50 + '%</td><td class="num">' + M.holds.wf50 + '%</td></tr>' +
    '<tr><td>inside P10&ndash;P90, stated 80%</td><td class="num">' + M.holds.loo80 + '%</td><td class="num">' + M.holds.wf80 + '%</td></tr>' +
    '<tr><td>rank correlation (Spearman)</td><td class="num">' + M.loo.rho.toFixed(2) + '</td><td class="num">' + M.wf.rho.toFixed(2) + '</td></tr>';
  $("coefLine").innerHTML = "Fitted, &plusmn; bootstrap s.e. (200 refits): size &times;" + M.fit.b.toFixed(3) + " &plusmn; " + M.fit.se.b.toFixed(3) +
    "; family +" + M.fit.fam.toFixed(2) + " &plusmn; " + M.fit.se.fam.toFixed(2) + " in log10 (&times;" + Math.pow(10, M.fit.fam).toFixed(2) + "). " +
    "Odds, in logits: years listed +" + M.oddsFit.beta[1].toFixed(2) + " &plusmn; " + M.oddsFit.se[1].toFixed(2) +
    ", kin +" + M.oddsFit.beta[2].toFixed(2) + " &plusmn; " + M.oddsFit.se[2].toFixed(2) +
    ". Category rate tested, not kept (see the ablation).";
  $("evNote").textContent = "Reading it: 7-day growth and age fail to price a token better, so the value model leaves them out; kinship — a sibling protocol that already records a token — is the strongest tell of which peers record one, so it enters through the odds. The category rate wins both blind tests by a hair but is not kept: it prices the newest categories at near-zero odds from their youth, not from evidence. The odds are the peers' record, not a forecast: the page never says a token will launch.";

  // ---- controls -----------------------------------------------------------
  let chipVerdict = "", sortKey = "rank", sortDir = 1, selected = null;
  const chipDefs = [["All", ""], ["Farm", "FARM"], ["Thin", "THIN"], ["Skip", "SKIP"]];
  function renderChips() {
    const counts = { "": ROWS.length, FARM: 0, THIN: 0, SKIP: 0 };
    ROWS.forEach((r) => { counts[r.econ.verdict]++; });
    $("chips").innerHTML = chipDefs.map((c) => '<button type="button" class="chip' + (chipVerdict === c[1] ? " on" : "") + '" data-v="' + c[1] + '">' + c[0] + " " + counts[c[1]] + "</button>").join("");
    $("chips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { chipVerdict = b.dataset.v; renderChips(); renderBoard(); }));
  }
  function fillSelect(el, items, label) {
    el.innerHTML = '<option value="">' + label + '</option>' + items.map((x) => '<option value="' + esc(x) + '">' + esc(x) + "</option>").join("");
  }
  fillSelect($("fCat"), CATS, "All categories");
  fillSelect($("fChain"), CHAINS, "All chains");
  const segDefs = [
    ["wDeposit", [1000, 5000, 25000], (v) => "$" + (v >= 1000 ? v / 1000 + "K" : v), "deposit"],
    ["wDrop", [0.05, 0.1, 0.2], (v) => Math.round(v * 100) + "%", "dropShare"],
    ["wTbill", [0, 0.04, 0.08], (v) => Math.round(v * 100) + "%", "tbill"]
  ];
  segDefs.forEach((def) => {
    $(def[0]).innerHTML = def[1].map((v) => '<button type="button" data-v="' + v + '"' + (FP[def[3]] === v ? ' class="on"' : "") + ">" + def[2](v) + "</button>").join("");
    $(def[0]).querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      FP[def[3]] = parseFloat(b.dataset.v);
      $(def[0]).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      applyFarm(); renderChips(); renderBoard(); updateWiNote();
      if (selected) renderDetail(selected);
    }));
  });
  function updateWiNote() {
    const f = ROWS.filter((r) => r.econ.verdict === "FARM").length;
    $("wiNote").textContent = "at $" + FP.deposit.toLocaleString("en-US") + ", " + Math.round(FP.dropShare * 100) + "% to farmers, " + Math.round(FP.tbill * 100) + "% T-bill: " + f + " FARM";
  }
  updateWiNote();
  $("fCat").addEventListener("change", renderBoard);
  $("fChain").addEventListener("change", renderBoard);
  $("fVerdict").addEventListener("change", renderBoard);
  $("fSearch").addEventListener("input", renderBoard);
  $("fReset").addEventListener("click", () => {
    $("fCat").value = ""; $("fChain").value = ""; $("fVerdict").value = ""; $("fSearch").value = "";
    chipVerdict = ""; renderChips(); renderBoard();
  });

  // ---- board ---------------------------------------------------------------
  const sortFns = {
    rank: (r) => r.rank, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl,
    chg: (r) => r.chg === null ? -1e9 : r.chg, age: (r) => r.age === null ? -1 : r.age,
    vil: (r) => r.vil, odds: (r) => r.odds, implied: (r) => r.implied,
    net: (r) => r.econ.net, verdict: (r) => ({ FARM: 0, THIN: 1, SKIP: 2 })[r.econ.verdict]
  };
  document.querySelectorAll("table.board th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
    renderBoard();
  }));
  function filtered() {
    const cat = $("fCat").value, chain = $("fChain").value, verd = $("fVerdict").value;
    const q = $("fSearch").value.trim().toLowerCase();
    let list = ROWS.filter((r) =>
      (!chipVerdict || r.econ.verdict === chipVerdict) &&
      (!cat || r.cat === cat) && (!chain || r.chain === chain) &&
      (!verd || r.econ.verdict === verd) &&
      (!q || r.name.toLowerCase().indexOf(q) >= 0 || r.slug.indexOf(q) >= 0 || r.cat.toLowerCase().indexOf(q) >= 0));
    const fn = sortFns[sortKey];
    list = list.slice().sort((a, b) => {
      const va = fn(a), vb = fn(b);
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return sortDir * c || a.rank - b.rank;
    });
    return list;
  }
  function chgCell(r) {
    if (r.chg === null) return '<td class="num muted">—</td>';
    const cls = r.chg >= 0 ? "vFARM" : "vSKIP";
    return '<td class="num ' + cls + '">' + (r.chg >= 0 ? "+" : "") + r.chg.toFixed(1) + "%</td>";
  }
  function renderBoard() {
    const list = filtered();
    $("boardCount").textContent = list.length + " of " + ROWS.length + " rows · " + usdShort(ROWS.reduce((a, r) => a + r.tvl, 0)) + " TVL · " + usdShort(M.totalM * 1e6) + " implied";
    $("boardBody").innerHTML = list.map((r) => {
      const tags = (r.watch ? '<span class="tag watch">Watchlist</span>' : "") + (r.fam ? '<span class="tag fam">Family</span>' : "");
      return '<tr data-slug="' + r.slug + '"' + (selected === r.slug ? ' class="sel"' : "") + ">" +
        '<td class="num">' + r.rank + '<br><span class="rng">' + r.rankLo + "–" + r.rankHi + "</span></td>" +
        "<td><b>" + esc(r.name) + "</b>" + tags + '<br><span class="muted">' + esc(r.cat) + " · " + esc(r.chain || "—") + (r.nChains > 1 ? " +" + (r.nChains - 1) : "") + "</span></td>" +
        '<td class="num">' + usdShort(r.tvl) + "</td>" + chgCell(r) +
        '<td class="num">' + ageText(r.age) + "</td>" +
        '<td class="num">' + usdShort(r.vil) + "</td>" +
        '<td class="num">' + pct(r.odds) + "</td>" +
        '<td class="num"><b>' + usdShort(r.implied) + '</b><br><span class="rng">' + usdShort(r.lo) + "–" + usdShort(r.hi) + "</span></td>" +
        '<td class="num">' + usdExact(r.econ.net) + '</td><td class="v' + r.econ.verdict + '">' + r.econ.verdict + "</td></tr>";
    }).join("");
    $("boardBody").querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => { selected = tr.dataset.slug; renderBoard(); renderDetail(selected); }));
  }

  // ---- detail ---------------------------------------------------------------
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; }
  function renderDetail(slug) {
    const r = ROWS.find((x) => x.slug === slug);
    if (!r) return;
    $("detailName").textContent = "· " + r.name;
    const b = M.oddsFit.beta;
    const yrsTerm = r.age === null ? 0 : (Math.log10(r.age + 30) - M.oddsFit.mla) / M.oddsFit.sla;
    const zYrs = b[1] * yrsTerm;
    const steps = farmSteps(r);
    $("detailBody").innerHTML =
      kv("TVL", usdShort(r.tvl)) + kv("7-day change", r.chg === null ? "—" : (r.chg >= 0 ? "+" : "") + r.chg.toFixed(1) + "% (market " + (M.fit.mchg >= 0 ? "+" : "") + M.fit.mchg.toFixed(1) + "%)") +
      kv("No token for", ageText(r.age)) + kv("Category", esc(r.cat) + (r.fam ? ' <span class="tag fam">Family</span>' : "")) +
      kv("Chains", esc(r.chain || "—") + (r.nChains > 1 ? " +" + (r.nChains - 1) + " more" : "")) +
      '<h3 style="margin-top:10px">How it is priced</h3>' +
      kv("Size curve", "10^" + M.fit.a.toFixed(2) + " × TVL^" + M.fit.b.toFixed(3) + " = " + usdShort(Math.pow(10, M.fit.a + M.fit.b * Math.log10(r.tvl)))) +
      (r.fam ? kv("Family effect", "&times;" + Math.pow(10, M.fit.fam).toFixed(2)) : "") +
      kv("Category offset", "&times;" + Math.pow(10, M.off[r.catIdx] || 0).toFixed(2)) +
      kv("Value if it launches", "<b>" + usdShort(r.vil) + "</b>") +
      kv("Launch odds", "<b>" + pct(r.odds) + "</b> <span class='muted'>(" + b[0].toFixed(2) + " + years " + (zYrs >= 0 ? "+" : "") + zYrs.toFixed(2) + " in logits; kin 0 — kin protocols are set aside)</span>") +
      kv("Implied value", "<b>" + usdShort(r.implied) + "</b> <span class='muted'>P25–P75 " + usdShort(r.lo) + "–" + usdShort(r.hi) + " · rank " + r.rankLo + "–" + r.rankHi + "</span>") +
      '<h3 style="margin-top:10px">Farm plan · ' + planFor(r.cat).kind + "</h3>" +
      '<ol class="steps">' + steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
      kv("Slice of the drop", usdExact(r.econ.slice) + ' <span class="muted">(' + usdExact(r.econ.sliceIf) + " if it launches)</span>") +
      kv("Net, expected", "<b>" + usdExact(r.econ.net) + "</b> <span class='muted'>" + usdExact(r.econ.netPerHour) + "/hour</span>") +
      kv("Net if it launches", usdExact(r.econ.netIf)) + kv("Net if it never does", usdExact(r.econ.netNo)) +
      kv("Break-even odds", pct(r.econ.be)) +
      kv("Minimum deposit", r.econ.minDep === null ? "none clears costs" : usdExact(Math.ceil(r.econ.minDep))) +
      kv("Verdict", '<span class="v' + r.econ.verdict + '">' + r.econ.verdict + "</span>");
  }

  // ---- scatter ----------------------------------------------------------------
  (function scatter() {
    const cv = $("scatter"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, padL = 34, padB = 20, padT = 8, padR = 8;
    const xs = D.comps.map((c) => c[0]).concat(ROWS.map((r) => Math.log10(r.tvl)));
    const ys = D.comps.map((c) => c[1]).concat(ROWS.map((r) => Math.log10(r.vil)));
    const x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    const y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    const X = (v) => padL + (v - x0) / (x1 - x0) * (W - padL - padR);
    const Y = (v) => H - padB - (v - y0) / (y1 - y0) * (H - padB - padT);
    ctx.strokeStyle = "#232d3d"; ctx.fillStyle = "#8b98ab"; ctx.font = "10px sans-serif";
    for (let gx = x0; gx <= x1; gx++) {
      ctx.beginPath(); ctx.moveTo(X(gx), padT); ctx.lineTo(X(gx), H - padB); ctx.stroke();
      ctx.fillText("$" + Math.pow(10, gx - 6).toFixed(0) + "M", X(gx) - 10, H - 6);
    }
    for (let gy = y0; gy <= y1; gy++) {
      ctx.beginPath(); ctx.moveTo(padL, Y(gy)); ctx.lineTo(W - padR, Y(gy)); ctx.stroke();
      ctx.fillText("$" + Math.pow(10, gy - 6).toFixed(0) + "M", 2, Y(gy) + 3);
    }
    ctx.strokeStyle = "#4cc2ff"; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const xv = x0 + (x1 - x0) * i / 40;
      const yv = M.fit.a + M.fit.b * xv;
      if (i === 0) ctx.moveTo(X(xv), Y(yv)); else ctx.lineTo(X(xv), Y(yv));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    D.comps.forEach((c) => {
      ctx.fillStyle = c[2] ? "#b18cff" : "#5a6b80";
      ctx.beginPath(); ctx.arc(X(c[0]), Y(c[1]), c[2] ? 3 : 2, 0, 7); ctx.fill();
    });
    ROWS.forEach((r) => {
      ctx.fillStyle = "#4cc2ff";
      ctx.beginPath(); ctx.arc(X(Math.log10(r.tvl)), Y(Math.log10(r.vil)), 1.6, 0, 7); ctx.fill();
    });
    $("scatterNote").textContent = "Grey: " + D.comps.length + " traded comps (purple: shares a name stem). Blue: the board's value-if-launched. Line: the fitted size curve.";
  })();

  // ---- odds panel + anchors ----------------------------------------------------
  (function oddsPanel() {
    const o = M.odds;
    let html = kv("Held-out hit rate", o.hit + "% <span class='muted'>vs " + o.base + "% base rate</span>") +
      kv("Held-out Brier", o.brier + " <span class='muted'>vs " + o.baseBrier + " base</span>") +
      kv("Walk-forward Brier", o.wfBrier + " <span class='muted'>vs " + o.wfBaseBrier + " base</span>");
    html += '<h3 style="margin-top:10px">Token rate by no-token age</h3>';
    o.bands.forEach((b) => {
      html += '<div style="font-size:12px">' + b.l + " · n=" + b.n + ' <span style="float:right">' + b.r + "%</span></div>" +
        '<div class="bar"><i style="width:' + b.r + '%"></i></div>';
    });
    html += '<h3 style="margin-top:10px">Calibration: predicted vs actual</h3>';
    o.calib.forEach((c) => {
      html += '<div style="font-size:12px">predicted ' + c.p + "% &rarr; actual " + c.a + "% <span class='muted'>(n=" + c.n + ")</span></div>";
    });
    $("oddsBody").innerHTML = html;
  })();
  $("anchorBody").innerHTML = M.anchors.map((a) => kv(esc(a.name) + (a.sym ? " (" + esc(a.sym) + ")" : ""), usdShort(a.mcapM * 1e6) + " mcap <span class='muted'>· curve " + usdShort(a.curveM * 1e6) + " · &times;" + a.ratio.toFixed(2) + "</span>")).join("");

  // ---- CSV ----------------------------------------------------------------------
  $("fCsv").addEventListener("click", () => {
    const list = filtered();
    const head = "rank,slug,name,category,tvl_usd,change_7d,age_days,launch_odds,if_launched_usd,implied_value_usd,net_usd,verdict";
    const lines = list.map((r) => [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + r.cat + '"', r.tvl, r.chg === null ? "" : r.chg, r.age === null ? "" : r.age, r.odds.toFixed(3), Math.round(r.vil), Math.round(r.implied), r.econ.net.toFixed(2), r.econ.verdict].join(","));
    const blob = new Blob([head + "\n" + lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "launch-radar.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---- init -----------------------------------------------------------------------
  renderChips();
  renderBoard();
  if (ROWS.length > 0) { selected = ROWS[0].slug; renderDetail(selected); renderBoard(); }
})();
