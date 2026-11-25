// Token Radar v3 dashboard — reads board.json + launched.json + excluded.json
// (relative paths, no network), renders the board, filters, sorting, the
// detail view, the 758 audit and the fitted model's method panel.
(function () {
  'use strict';
  var board = null, launched = null, excluded = null, bySlug = {};
  var state = { tab: 'board', q: '', cat: '', chain: '', minTvl: 0, verdict: '', sort: 'implied', dir: -1 };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(c) {
    if (c == null) return '<span>—</span>';
    var cls = c >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (c >= 0 ? '+' : '') + c.toFixed(1) + '%</span>';
  }
  function ageStr(days) {
    if (days == null) return '—';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }
  function listedStr(d) { return d == null ? 'unknown' : d; }
  function verdictClass(v) {
    return v === 'Farm' ? 'farm' : v === 'Farm small' ? 'farm-small' : 'watch';
  }

  function sortRows(rows) {
    var k = state.sort, d = state.dir;
    var val = function (r) {
      if (k === 'rank') return r.rank;
      if (k === 'name') return r.name.toLowerCase();
      if (k === 'tvl') return r.tvl_usd;
      if (k === 'growth') return r.change_7d == null ? -Infinity : r.change_7d;
      if (k === 'age') return r.age_days == null ? -Infinity : r.age_days;
      if (k === 'implied') return r.implied_value_usd;
      if (k === 'odds') return r.token_odds;
      if (k === 'verdict') return { 'Farm': 3, 'Farm small': 2, 'Watch': 1 }[r.verdict_label] || 0;
      return r.implied_value_usd;
    };
    return rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -1 * d;
      if (va > vb) return 1 * d;
      return a.rank - b.rank;
    });
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return board.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      if (state.verdict && r.verdict_label !== state.verdict) return false;
      return true;
    });
  }

  function renderStats() {
    var a = board.audit;
    var top = board.rows[0];
    $('stats').innerHTML =
      '<span class="stat"><b>' + a.total_protocols + '</b><span>protocols accounted for</span></span>' +
      '<span class="stat"><b>' + a.ranked_pre_token + '</b><span>pre-token ranked</span></span>' +
      '<span class="stat"><b>' + a.excluded_pre_token + '</b><span>excluded, with reasons</span></span>' +
      '<span class="stat"><b>' + a.launched + '</b><span>already launched</span></span>' +
      '<span class="stat"><b>' + a.watchlist_covered + '/' + a.watchlist + '</b><span>watchlist covered</span></span>' +
      '<span class="stat"><b>#' + top.rank + ' ' + esc(top.name) + '</b><span>' + money(top.implied_value_usd) + ' implied</span></span>';
  }

  function renderModelBar() {
    var m = board.model;
    var v = m.validation;
    $('modelbar').innerHTML =
      '<p class="formula">implied value = exp(<b>' + m.intercept + ' + ' + m.slope + ' × log(TVL)</b>) &nbsp;·&nbsp; fitted multiple ' + m.fitted_multiple_at_50m + '× at $50M TVL, ' + m.fitted_multiple_at_1b + '× at $1B — the multiple falls as a protocol gets bigger</p>' +
      '<p>Fitted by least squares on <b>' + m.peers + ' launched peers</b> from this snapshot. Held-out error (log points): ' +
      'walk-forward <b>' + v.walk_forward.model_mae_log + '</b> vs baseline ' + v.walk_forward.baseline_mae_log + ' (<b>' + v.walk_forward.times_better_than_baseline + '× better</b>); ' +
      '5-fold <b>' + v.five_fold.model_mae_log + '</b> vs ' + v.five_fold.baseline_mae_log + ' (<b>' + v.five_fold.times_better_than_baseline + '× better</b>). ' +
      'Every extra term — category, growth, age, chains — was tested held-out and dropped: each one loses to the size curve alone. ' +
      'Each value carries an 80% range (×' + m.conformal_interval.factor_80 + ') and a rank range from the 50% interval.</p>';
  }

  function renderMethod() {
    var m = board.model;
    var v = m.validation;
    var c = m.conformal_interval;
    var o = m.token_odds;
    var termRows = v.term_tests.map(function (t) {
      return '<tr><td>' + esc(t.term) + '</td>' +
        '<td class="num">' + t.walk_forward_mae_log + '</td><td class="num">' + t.walk_forward_vs_size_curve_only + '×</td>' +
        '<td class="num">' + t.five_fold_mae_log + '</td><td class="num">' + t.five_fold_vs_size_curve_only + '×</td>' +
        '<td>' + (t.kept ? '<span class="kept-yes">kept</span>' : '<span class="kept-no">dropped</span>') + '</td></tr>';
    }).join('');
    var binRows = o.bins.map(function (b) {
      return '<tr><td>' + esc(b.age_days) + ' days</td><td class="num">' + b.n + '</td><td class="num">' + Math.round(b.launched_share * 100) + '%</td></tr>';
    }).join('');
    $('methodBody').innerHTML =
      '<p class="formula">log(market cap) = ' + m.intercept + ' + ' + m.slope + ' × log(TVL)</p>' +
      '<p>The size curve is fitted on the ' + m.peers + ' protocols in this snapshot whose token already trades and whose market cap is recorded. ' +
      'A flat multiple would value every protocol at the same fraction of TVL; the fitted slope (' + m.slope + ') says the market pays a smaller multiple for bigger protocols — ' +
      m.fitted_multiple_at_50m + '× at $50M of TVL against ' + m.fitted_multiple_at_1b + '× at $1B. No protocol name is hardcoded anywhere: the same code ranks a future snapshot.</p>' +
      '<h3>Terms tested held-out — kept or dropped on evidence</h3>' +
      '<p>Each candidate term was fitted with and without it on two held-out splits: walk-forward (fit on the ' + v.walk_forward.train + ' earliest-listed peers, test on the ' + v.walk_forward.test + ' newest, cut at ' + esc(v.walk_forward.cutoff_listed_at) + ') and 5-fold (peers in slug order). ' +
      'The baseline is the train set’s median market-cap/TVL multiple. A term is kept only when it beats the size curve alone on <i>both</i> splits.</p>' +
      '<table class="mini"><thead><tr><th>Term added to the size curve</th><th class="num">Walk-forward MAE</th><th class="num">vs size curve</th><th class="num">5-fold MAE</th><th class="num">vs size curve</th><th>Verdict</th></tr></thead><tbody>' +
      '<tr><td>Size curve alone (shipped model)</td><td class="num">' + v.walk_forward.model_mae_log + '</td><td class="num">' + v.walk_forward.times_better_than_baseline + '× vs baseline</td><td class="num">' + v.five_fold.model_mae_log + '</td><td class="num">' + v.five_fold.times_better_than_baseline + '× vs baseline</td><td><span class="kept-yes">shipped</span></td></tr>' +
      termRows + '</tbody></table>' +
      '<p>Growth, age and chain count do not predict launched values held-out on this snapshot, so they do not move the implied value. Age still matters — it drives the token odds below — and growth shows up as momentum in each row.</p>' +
      '<h3>How uncertain is each value?</h3>' +
      '<p>Leave-one-out residuals of the fit give a conformal interval: the 50% interval spans ×' + c.factor_50 + ' and the 80% interval ×' + c.factor_80 + ' around the point estimate. ' +
      'Launch values are uncertain within about an order of magnitude — the ranking is a best estimate, not a promise — so every row shows its 80% range and the rank it would hold at the ends of its 50% interval.</p>' +
      '<h3>Token odds — from the peers’ own record</h3>' +
      '<p>The share of protocols that record a token rises with age towards a fitted ceiling of ' + Math.round(o.s_inf * 100) + '% (half-life ' + o.half_life_days + ' days). ' +
      'The odds that a protocol still tokenless at its age launches from here are (ceiling − share at its age) / (1 − share at its age), so they <i>fall</i> with age: the older a protocol is without a token, the more of its peers have already launched.</p>' +
      '<table class="mini"><thead><tr><th>Age listed</th><th class="num">Protocols</th><th class="num">Record a token</th></tr></thead><tbody>' + binRows + '</tbody></table>' +
      '<h3>Farm verdicts — costed, not slogans</h3>' +
      '<p>' + esc(m.verdict_rule) + ' Every farm plan is sized to its deposit tier (top 10: $250–$500 over 8 weeks; ranks 11–50: $100–$250 over 6 weeks; 51–150: $50–$100 over 5 weeks; the rest: $25–$50 over 4 weeks), and every step states what it costs and how long it takes.</p>' +
      '<p class="fine">A protocol “records no token” in the snapshot; that is not proof it has none. Implied value is this entry’s own claim, never a prediction of whether or when a token is issued. ' +
      'Exchange-operated and wrapped/staked/bridged products are excluded from the ranking, following the snapshot’s own watchlist rule — their token, if any, would belong to an asset that already trades — and are listed with their reasons in the 758 audit.</p>';
    $('foot').textContent = 'Snapshot ' + board.as_of + ' · source: DefiLlama protocols · ' + board.audit.total_protocols + ' protocols · deterministic run: the same snapshot always writes the same board.';
  }

  function renderBoard() {
    var rows = sortRows(filtered());
    $('count').textContent = 'Showing ' + rows.length + ' of ' + board.rows.length +
      ' pre-token protocols — click a row for its farm plan and value breakdown.';
    $('rows').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '<span class="rankrange">#' + r.rank_low + '–#' + r.rank_high + '</span></td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.watchlist ? '<span class="badge watch">WATCHLIST</span>' : '') +
        '<span class="pslug">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + '</span></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageStr(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b><span class="range">' + money(r.value_low_usd) + ' – ' + money(r.value_high_usd) + '</span></td>' +
        '<td class="num">' + Math.round(r.token_odds * 100) + '%</td>' +
        '<td><span class="verdict ' + verdictClass(r.verdict_label) + '">' + esc(r.verdict_label) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderLaunched() {
    $('launchedRows').innerHTML = launched.rows.map(function (r) {
      return '<tr><td><span class="pname">' + esc(r.name) + '</span>' +
        '<span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td></tr>';
    }).join('');
  }

  function renderAudit() {
    var a = board.audit;
    $('auditSummary').innerHTML =
      '<div class="audit-grid">' +
      '<div class="audit-cell"><b>' + a.total_protocols + '</b><span>protocols in the snapshot</span></div>' +
      '<div class="audit-cell"><b>' + a.ranked_pre_token + '</b><span>pre-token, ranked</span></div>' +
      '<div class="audit-cell"><b>' + a.excluded_pre_token + '</b><span>pre-token, excluded with a reason</span></div>' +
      '<div class="audit-cell"><b>' + a.launched + '</b><span>token already trades</span></div>' +
      '<div class="audit-cell"><b>' + a.watchlist_covered + ' / ' + a.watchlist + '</b><span>watchlist covered</span></div>' +
      '</div>';
    $('excludedRows').innerHTML = excluded.rows.map(function (r) {
      return '<tr><td><span class="pname">' + esc(r.name) + '</span>' +
        '<span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td>' + esc(r.reason) + '</td></tr>';
    }).join('');
  }

  function fillSelects() {
    var cats = {}, chains = {};
    board.rows.forEach(function (r) {
      if (r.category) cats[r.category] = 1;
      r.chains.forEach(function (c) { chains[c] = 1; });
    });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; $('fCat').appendChild(o);
    });
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; $('fChain').appendChild(o);
    });
  }

  function bdRow(label, norm, val) {
    var w = Math.max(2, Math.min(100, Math.round(norm * 100)));
    return '<div class="bd-row"><span>' + label + '</span><span class="bar"><i style="width:' + w + '%"></i></span><span class="val">' + val + '</span></div>';
  }

  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var b = r.breakdown;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('modalBody').innerHTML =
      '<h2>' + esc(r.name) + (r.watchlist ? '<span class="badge watch">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="slugline">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</p>' +
      '<div class="big">' + moneyFull(r.implied_value_usd) + ' <small>80% range ' + moneyFull(r.value_low_usd) + ' – ' + moneyFull(r.value_high_usd) + '</small></div>' +
      '<p class="slugline">Implied value at rank #' + r.rank + ' (rank range #' + r.rank_low + '–#' + r.rank_high + ') — this entry’s own claim, not a prediction of a launch.</p>' +
      '<div class="kv">' +
      '<div><b>TVL</b>' + moneyFull(r.tvl_usd) + '</div>' +
      '<div><b>7-day change</b>' + (r.change_7d == null ? 'not reported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + ' (' + esc(r.momentum) + ')</div>' +
      '<div><b>Listed since</b>' + listedStr(r.listed_at) + (r.age_days == null ? '' : ' (' + ageStr(r.age_days) + ')') + '</div>' +
      '<div><b>Token odds</b>' + Math.round(r.token_odds * 100) + '%</div>' +
      '<div><b>Peers this old</b>' + Math.round(r.peer_launch_share * 100) + '% record a token (n=' + r.peer_n + ')</div>' +
      '<div><b>Est. farming cost</b>$' + r.est_cost.min + '–$' + r.est_cost.max + '</div>' +
      '<div><b>Horizon</b>' + r.horizon_weeks + ' weeks</div>' +
      '<div><b>Verdict</b><span class="verdict ' + verdictClass(r.verdict_label) + '">' + esc(r.verdict_label) + '</span></div>' +
      '</div>' +
      '<p><b>' + esc(r.verdict) + '</b></p>' +
      '<h3>Why this value</h3><div class="bd">' +
      bdRow('Fitted multiple', Math.min(1, b.fittedMultiple / 0.5), b.fittedMultiple.toFixed(3) + '× at this TVL (size curve)') +
      bdRow('TVL base', Math.log(Math.max(r.tvl_usd, 1)) / Math.log(3e9), money(r.tvl_usd)) +
      bdRow('Implied value', 1, moneyFull(r.implied_value_usd)) +
      bdRow('80% range', 1, moneyFull(r.value_low_usd) + ' – ' + moneyFull(r.value_high_usd)) +
      bdRow('Token odds', r.token_odds, Math.round(r.token_odds * 100) + '% (falls with age)') +
      '</div>' +
      '<p class="fine">log(market cap) = ' + b.intercept.toFixed(3) + ' + ' + b.slope.toFixed(3) + ' × log(TVL), fitted on ' + board.model.peers + ' launched peers. ' +
      'The 80% interval spans ×' + board.model.conformal_interval.factor_80 + ' (leave-one-out residuals); the rank range uses the 50% interval (×' + board.model.conformal_interval.factor_50 + ').</p>' +
      '<h3>How to farm it</h3><ol class="steps">' + steps + '</ol>';
    $('modal').hidden = false;
    var card = document.querySelector('.modal-card');
    if (card) card.scrollTop = 0;
    $('modal').scrollTop = 0;
  }

  function closeDetail() { $('modal').hidden = true; }

  function setTab(tab) {
    state.tab = tab;
    $('tabBoard').classList.toggle('active', tab === 'board');
    $('tabLaunched').classList.toggle('active', tab === 'launched');
    $('tabAudit').classList.toggle('active', tab === 'audit');
    $('boardView').hidden = tab !== 'board';
    $('launchedView').hidden = tab !== 'launched';
    $('auditView').hidden = tab !== 'audit';
    document.querySelector('.filters').style.display = tab === 'board' ? '' : 'none';
    if (tab === 'launched') {
      $('count').textContent = launched.rows.length + ' protocols whose token already trades — listed by market cap, for reference only.';
    } else if (tab === 'audit') {
      $('count').textContent = board.audit.total_protocols + ' protocols: ' + board.audit.ranked_pre_token + ' ranked + ' + board.audit.excluded_pre_token + ' excluded + ' + board.audit.launched + ' launched.';
    } else {
      renderBoard();
    }
  }

  function applyHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) { closeDetail(); return; }
    var m = h.match(/^p=(.+)$/);
    if (m) { openDetail(decodeURIComponent(m[1])); return; }
    m = h.match(/^f=cat:(.+)$/);
    if (m) {
      var cat = decodeURIComponent(m[1]);
      state.cat = cat; $('fCat').value = cat; setTab('board'); renderBoard(); return;
    }
    m = h.match(/^f=verdict:(.+)$/);
    if (m) {
      var v = decodeURIComponent(m[1]);
      state.verdict = v; $('fVerdict').value = v; setTab('board'); renderBoard(); return;
    }
    m = h.match(/^f=chain:(.+)$/);
    if (m) {
      var ch = decodeURIComponent(m[1]);
      state.chain = ch; $('fChain').value = ch; setTab('board'); renderBoard(); return;
    }
    closeDetail();
  }

  function bind() {
    $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    $('fCat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
    $('fChain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
    $('fTvl').addEventListener('change', function (e) { state.minTvl = Number(e.target.value); renderBoard(); });
    $('fVerdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
    $('fSort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      state.dir = state.sort === 'name' ? 1 : -1;
      renderBoard();
    });
    $('tabBoard').addEventListener('click', function () { setTab('board'); });
    $('tabLaunched').addEventListener('click', function () { setTab('launched'); });
    $('tabAudit').addEventListener('click', function () { setTab('audit'); });
    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        $('fSort').value = ['implied', 'tvl', 'odds', 'growth', 'age', 'name', 'verdict'].indexOf(k) >= 0 ? k : 'implied';
        renderBoard();
      });
    });
    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) location.hash = 'p=' + tr.getAttribute('data-slug');
    });
    $('modalClose').addEventListener('click', function () { history.replaceState(null, '', location.pathname); closeDetail(); });
    $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) { history.replaceState(null, '', location.pathname); closeDetail(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { history.replaceState(null, '', location.pathname); closeDetail(); } });
    window.addEventListener('hashchange', applyHash);
  }

  function load() {
    $('status').textContent = 'Loading board…';
    Promise.all([
      fetch('../board.json').then(function (r) { if (!r.ok) throw new Error('board.json ' + r.status); return r.json(); }),
      fetch('../launched.json').then(function (r) { if (!r.ok) throw new Error('launched.json ' + r.status); return r.json(); }),
      fetch('../excluded.json').then(function (r) { if (!r.ok) throw new Error('excluded.json ' + r.status); return r.json(); })
    ]).then(function (triple) {
      board = triple[0]; launched = triple[1]; excluded = triple[2];
      board.rows.forEach(function (r) { bySlug[r.slug] = r; });
      $('status').textContent = '';
      fillSelects();
      renderStats();
      renderModelBar();
      renderMethod();
      renderBoard();
      renderLaunched();
      renderAudit();
      bind();
      applyHash();
    }).catch(function (err) {
      $('status').textContent = 'Could not load the board data (' + err.message + '). Open this page from the built output directory.';
    });
  }

  load();
})();
