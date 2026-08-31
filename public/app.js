/* Vermelhinha Analytics — app shell + dashboard. Vanilla JS, gráficos SVG à mão.
   Dados: GET /api/lojas, /api/periodos/:loja, /api/analise/:loja/:AAAA-MM. */
(function () {
  "use strict";

  var EXPORT = !!window.__EXPORT__;
  var SVGNS = "http://www.w3.org/2000/svg";

  // ---------- helpers ----------
  function brl(v, dec) { dec = dec == null ? 2 : dec; return (v == null ? 0 : v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  function int(v) { return (v == null ? 0 : v).toLocaleString("pt-BR"); }
  function pct(v, dec) { dec = dec == null ? 1 : dec; return (v == null ? 0 : v).toFixed(dec).replace(".", ",") + "%"; }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function h(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function svg(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function niceCeil(v) { if (v <= 0) return 1; var t = v * 1.1, m = Math.pow(10, Math.floor(Math.log10(t))), s = m / 2; return Math.ceil(t / s) * s; }
  async function getJSON(url) {
    var r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; try { e.body = await r.json(); } catch (x) {} throw e; }
    return r.json();
  }

  var CAT_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];

  // ---------- state ----------
  var state = { lojas: [], loja: null, periodos: [], periodo: null, data: null, tab: "geral", view: "painel", pollId: null };
  var view = document.getElementById("view");
  var selLoja = document.getElementById("sel-loja");
  var selPeriodo = document.getElementById("sel-periodo");
  var LS = window.localStorage;

  // ---------- charts ----------
  // combo: barras de faturamento + linha de qtde de vendas, eixos duplos
  function comboChart(host, daily) {
    clear(host);
    var pts = daily.filter(function (d) { return !d.parcial; });
    if (pts.length < 2) pts = daily.slice();
    var W = 620, H = 240, padL = 52, padR = 44, padT = 14, padB = 26;
    var pw = W - padL - padR, ph = H - padT - padB;
    var maxV = niceCeil(Math.max.apply(null, pts.map(function (p) { return p.v; })));
    var maxN = niceCeil(Math.max.apply(null, pts.map(function (p) { return p.n; })));
    var s = svg("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Faturamento diário" });
    for (var i = 0; i <= 4; i++) {
      var y = padT + ph - (i / 4) * ph;
      s.appendChild(svg("line", { class: "gridline", x1: padL, x2: W - padR, y1: y, y2: y }));
      var l = svg("text", { class: "axis", x: padL - 8, y: y + 3, "text-anchor": "end" });
      l.textContent = "R$ " + Math.round((maxV * i / 4) / 1000) + "k"; s.appendChild(l);
      var r = svg("text", { class: "axis", x: W - padR + 8, y: y + 3 });
      r.textContent = int(Math.round(maxN * i / 4)); s.appendChild(r);
    }
    var band = pw / pts.length, bw = Math.max(3, Math.min(16, band * 0.55));
    pts.forEach(function (p, idx) {
      var cx = padL + band * idx + band / 2;
      var bh = (p.v / maxV) * ph;
      s.appendChild(svg("rect", { x: cx - bw / 2, y: padT + ph - bh, width: bw, height: bh, rx: 2, fill: "var(--s1)", opacity: 0.9 }));
    });
    var d = "M";
    pts.forEach(function (p, idx) {
      var cx = padL + band * idx + band / 2, cy = padT + ph - (p.n / maxN) * ph;
      d += (idx ? " L" : " ") + cx.toFixed(1) + " " + cy.toFixed(1);
    });
    s.appendChild(svg("path", { d: d, fill: "none", stroke: "var(--s7)", "stroke-width": 2, "stroke-linejoin": "round" }));
    pts.forEach(function (p, idx) {
      var cx = padL + band * idx + band / 2, cy = padT + ph - (p.n / maxN) * ph;
      s.appendChild(svg("circle", { cx: cx, cy: cy, r: 2.6, fill: "var(--s7)" }));
    });
    [0, Math.floor(pts.length / 4), Math.floor(pts.length / 2), Math.floor(3 * pts.length / 4), pts.length - 1].forEach(function (idx) {
      if (idx < 0 || idx >= pts.length) return;
      var t = svg("text", { class: "axis", x: padL + band * idx + band / 2, y: H - 8, "text-anchor": "middle" });
      var dd = pts[idx].data;
      t.textContent = dd ? dd.slice(8) + "/" + dd.slice(5, 7) : pts[idx].d; s.appendChild(t);
    });
    host.appendChild(s);
  }

  function barChart(host, rows, key) {
    clear(host); key = key || "v";
    var W = 620, H = 240, padL = 48, padR = 12, padT = 14, padB = 30;
    var pw = W - padL - padR, ph = H - padT - padB;
    var maxV = niceCeil(Math.max.apply(null, rows.map(function (r) { return r[key]; })));
    var s = svg("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img" });
    for (var i = 0; i <= 4; i++) {
      var y = padT + ph - (i / 4) * ph;
      s.appendChild(svg("line", { class: "gridline", x1: padL, x2: W - padR, y1: y, y2: y }));
      var l = svg("text", { class: "axis", x: padL - 8, y: y + 3, "text-anchor": "end" });
      l.textContent = key === "v" ? "R$ " + Math.round((maxV * i / 4) / 1000) + "k" : int(Math.round(maxV * i / 4));
      s.appendChild(l);
    }
    var band = pw / rows.length, bw = Math.min(34, band * 0.6);
    rows.forEach(function (r, idx) {
      var cx = padL + band * idx + band / 2, bh = (r[key] / maxV) * ph;
      s.appendChild(svg("rect", { x: cx - bw / 2, y: padT + ph - bh, width: bw, height: bh, rx: 4, fill: "var(--s1)" }));
      var t = svg("text", { class: "axis", x: cx, y: H - 10, "text-anchor": "middle" });
      t.textContent = (r.label || r.d || "").toString().slice(0, 3); s.appendChild(t);
    });
    host.appendChild(s);
  }

  function lineChart(host, daily) {
    clear(host);
    var pts = daily.slice();
    var W = 900, H = 260, padL = 50, padR = 16, padT = 14, padB = 26;
    var pw = W - padL - padR, ph = H - padT - padB;
    var maxV = niceCeil(Math.max.apply(null, pts.map(function (p) { return p.v; })));
    var s = svg("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img" });
    for (var i = 0; i <= 4; i++) {
      var y = padT + ph - (i / 4) * ph;
      s.appendChild(svg("line", { class: "gridline", x1: padL, x2: W - padR, y1: y, y2: y }));
      var l = svg("text", { class: "axis", x: padL - 8, y: y + 3, "text-anchor": "end" });
      l.textContent = "R$ " + Math.round((maxV * i / 4) / 1000) + "k"; s.appendChild(l);
    }
    function xf(idx) { return padL + (idx / (pts.length - 1)) * pw; }
    function yf(v) { return padT + ph - (v / maxV) * ph; }
    var full = pts.filter(function (p) { return !p.parcial; });
    var d = "M";
    full.forEach(function (p, idx) { d += (idx ? " L" : " ") + xf(pts.indexOf(p)).toFixed(1) + " " + yf(p.v).toFixed(1); });
    s.appendChild(svg("path", { d: d + " L" + xf(pts.indexOf(full[full.length - 1])).toFixed(1) + " " + (padT + ph) + " L" + xf(pts.indexOf(full[0])).toFixed(1) + " " + (padT + ph) + " Z", fill: "var(--s1)", opacity: 0.08 }));
    s.appendChild(svg("path", { d: d, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round" }));
    var peak = full.reduce(function (a, b) { return b.v > a.v ? b : a; }, full[0]);
    var px = xf(pts.indexOf(peak)), py = yf(peak.v);
    s.appendChild(svg("circle", { cx: px, cy: py, r: 4, fill: "var(--brand)" }));
    var pl = svg("text", { class: "axis", x: px, y: py - 10, "text-anchor": "middle", "font-weight": "700", fill: "var(--brand)" });
    pl.textContent = "R$ " + (peak.v / 1000).toFixed(1).replace(".", ",") + " mil"; s.appendChild(pl);
    [0, Math.floor(pts.length / 4), Math.floor(pts.length / 2), Math.floor(3 * pts.length / 4), pts.length - 1].forEach(function (idx) {
      if (idx < 0 || idx >= pts.length) return;
      var t = svg("text", { class: "axis", x: xf(idx), y: H - 6, "text-anchor": "middle" });
      var dd = pts[idx].data; t.textContent = dd ? dd.slice(8) + "/" + dd.slice(5, 7) : pts[idx].d; s.appendChild(t);
    });
    host.appendChild(s);
  }

  function donut(host, cats, total) {
    clear(host);
    var R = 66, r = 42, cx = 78, cy = 78, C = 2 * Math.PI * ((R + r) / 2), sw = R - r;
    var s = svg("svg", { viewBox: "0 0 156 156", width: 156, height: 156 });
    var acc = 0, tot = cats.reduce(function (a, c) { return a + c.v; }, 0) || 1;
    cats.forEach(function (c, idx) {
      var frac = c.v / tot;
      var circ = svg("circle", {
        cx: cx, cy: cy, r: (R + r) / 2, fill: "none",
        stroke: c.color || CAT_COLORS[idx % 7], "stroke-width": sw,
        "stroke-dasharray": (frac * C).toFixed(2) + " " + C.toFixed(2),
        "stroke-dashoffset": (-acc * C).toFixed(2),
        transform: "rotate(-90 " + cx + " " + cy + ")",
      });
      s.appendChild(circ); acc += frac;
    });
    var t1 = svg("text", { x: cx, y: cy - 1, "text-anchor": "middle", class: "donut-center", "font-size": "13", fill: "var(--ink)" });
    t1.textContent = "R$ " + int(Math.round(total));
    var t2 = svg("text", { x: cx, y: cy + 15, "text-anchor": "middle", class: "axis" });
    t2.textContent = "Total";
    s.appendChild(t1); s.appendChild(t2);
    host.appendChild(s);
  }

  // ---------- summary cards ----------
  function summaryCards(d) {
    var k = d.kpis;
    var ig = d.instagram && d.instagram[0];
    var conc = d.concorrencia || {};
    var igDelta = ig && ig.delta != null ? '<div class="delta ' + (ig.delta >= 0 ? "up" : "down") + '">' + (ig.delta >= 0 ? "↑" : "↓") + " " + pct(Math.abs(ig.delta)) + ' <span class="vs">vs. mês anterior</span></div>' : '<div class="foot">sem métricas neste mês</div>';
    var igFoot = d.instagram && d.instagram.length > 1 ? '<div class="foot"><span><b>' + esc(d.instagram[1].label) + ":</b> " + esc(d.instagram[1].value) + "</span>" + (d.instagram[2] ? '<span><b>' + esc(d.instagram[2].label) + ":</b> " + esc(d.instagram[2].value) + "</span>" : "") + "</div>" : "";

    var vDelta = k.varFaturamentoPct != null
      ? '<div class="delta ' + (k.varFaturamentoPct >= 0 ? "up" : "down") + '">' + (k.varFaturamentoPct >= 0 ? "↑ " : "↓ ") + pct(Math.abs(k.varFaturamentoPct)) + ' <span class="vs">vs. mês anterior</span></div>'
      : '<div class="foot">sem mês anterior para comparar</div>';
    return '' +
    '<div class="summary">' +
      card_sc("red", "🛒", "Vendas Totais", "R$ " + brl(k.faturamento), vDelta,
        '<div class="foot"><span><b>' + int(k.vendas) + "</b> transações</span><span><b>" + int(k.itens) + "</b> itens</span></div>") +
      card_sc("ig", "📷", "Instagram", ig ? esc(ig.value) : "—", igDelta, igFoot) +
      card_sc("conc", "📊", "Concorrência",
        conc.pending ? "pendente" : int(conc.totalOfertas) + " ofertas",
        conc.pending ? '<div class="foot">aguardando coleta</div>' :
          '<div class="foot"><span>Média de desconto: <b>' + (conc.mediaDescontoPct != null ? conc.mediaDescontoPct + "%" : "—") + "</b></span></div>",
        conc.pending ? "" : '<div class="foot"><span>Melhor preço: <b>' + (conc.melhorPreco != null ? "R$ " + brl(conc.melhorPreco) : "—") + "</b></span></div>") +
      card_sc("red", "🏬", "Loja", '<span style="color:var(--brand)">' + esc(d.loja) + "</span>",
        '<div class="foot">📍 ' + esc(d.meta.endereco || "Baixo Guandu/ES") + "</div>", "") +
    "</div>";
  }
  function card_sc(cls, ico, label, big, l2, l3) {
    var bigCls = big && big.indexOf("R$") !== 0 && big.length > 10 ? "big sm" : "big";
    return '<div class="sc"><div class="icon ' + cls + '">' + ico + '</div><div class="body">' +
      '<div class="label">' + label + '</div><div class="' + bigCls + '">' + big + "</div>" + (l2 || "") + (l3 || "") + "</div></div>";
  }

  // ---------- tabs ----------
  var TABS = [
    ["geral", "Visão Geral"], ["vendas", "Vendas"], ["redes", "Redes Sociais"],
    ["conc", "Concorrência"], ["cat", "Categorias"], ["top", "Top Produtos"], ["tend", "Tendência"],
  ];
  function tabBar() {
    return '<div class="tabs">' + TABS.map(function (t) {
      return '<button data-tab="' + t[0] + '"' + (state.tab === t[0] ? ' class="active"' : "") + ">" + t[1] + "</button>";
    }).join("") + "</div>";
  }

  // ---------- cards / blocks ----------
  function cardVendas(d) {
    return '<div class="card"><div class="chead"><div class="ci red">🛒</div><div style="min-width:0"><h3>Vendas</h3>' +
      '<div class="cs">Faturamento diário' + (d.meta.diaParcial ? " · dias parciais fora" : "") + '</div>' +
      '<div style="display:flex;gap:14px;margin-top:6px"><span class="legend-dot"><i style="background:var(--s1)"></i>Faturamento</span>' +
      '<span class="legend-dot"><i style="background:var(--s7)"></i>Qtd. vendas</span></div></div></div>' +
      '<div class="chart-host" data-chart="combo"></div></div>';
  }
  function cardRedes(d) {
    var rows = (d.instagram || []).map(function (m) {
      var up = m.delta == null ? "" : (m.delta >= 0 ? "up" : "down");
      var darrow = m.delta == null ? "" : (m.delta >= 0 ? "↑ " : "↓ ") + pct(Math.abs(m.delta));
      return '<div class="mrow"><span class="k">' + esc(m.label) + '</span><span class="v"><span class="num">' + esc(m.value) + '</span>' +
        (darrow ? '<span class="d ' + up + '">' + darrow + "</span>" : "") + "</span></div>";
    }).join("");
    return '<div class="card"><div class="chead"><div class="ci ig">📷</div><div><h3>Redes Sociais</h3><div class="cs">Evolução do Instagram</div></div></div>' +
      (rows || '<div class="empty">Sem métricas de Instagram para este mês.</div>') + "</div>";
  }
  function offerRow(o, compact) {
    var conf = (o.confianca || "").toLowerCase();
    var confCls = /alta/.test(conf) ? "conf-alta" : /m.dia/.test(conf) ? "conf-media" : "conf-baixa";
    var sub = esc(o.concorrente || "") + (o.base === "nosso" ? " · nosso R$ " + brl(o.ref) : o.base === "normal" ? " · de R$ " + brl(o.ref) : "");
    return '<div class="offer"><div class="th">🏷️</div><div class="oi"><div class="n">' + esc(o.produto) + "</div>" +
      '<div class="sub">' + sub + "</div></div>" +
      '<div class="price">R$ ' + brl(o.promo) + "</div>" +
      '<span class="tag disc">-' + o.descPct + "%</span>" +
      (!compact && o.confianca ? '<span class="tag ' + confCls + '">' + esc(o.confianca) + "</span>" : "") + "</div>";
  }
  function cardConc(d) {
    var c = d.concorrencia || {};
    if (c.pending) {
      return '<div class="card"><div class="chead"><div class="ci conc">📊</div><div><h3>Concorrência</h3><div class="cs">aguardando coleta</div></div></div>' +
        '<div class="empty">Sem coleta de concorrentes neste mês.<br>Jogue um <b>Concorrentes_Coleta_*.xlsx</b> na pasta inbox.</div></div>';
    }
    var offers = (c.melhoresOfertas || []).slice(0, 4).map(function (o) { return offerRow(o, true); }).join("");
    return '<div class="card"><div class="chead"><div class="ci conc">📊</div><div><h3>Concorrência</h3><div class="cs">Melhores ofertas da região (confirmadas)</div></div></div>' +
      (offers || '<div class="empty">Nenhuma oferta com preço normal + promo.</div>') +
      '<a class="more" data-tab="conc" href="#">Ver todas as ofertas →</a></div>';
  }
  function cardCategoria(d) {
    var tot = d.kpis.faturamento;
    var legend = d.categories.map(function (c, i) {
      return '<div class="row"><span class="legend-dot"><i style="background:' + (c.color || CAT_COLORS[i % 7]) + '"></i></span>' +
        '<span class="nm">' + esc(c.label) + '</span><span class="pc">' + pct(c.v / tot * 100) + "</span></div>";
    }).join("");
    return '<div class="card"><div class="chead"><div class="ci cat">📅</div><div><h3>Vendas por Categoria</h3>' +
      '<div class="cs">Baseada em palavra-chave (categoria estimada)</div></div></div>' +
      '<div class="donut-wrap"><div class="donut-host" data-chart="donut"></div><div class="cat-legend">' + legend + "</div></div>" +
      '<div class="note">ⓘ Categoria estimada por palavra-chave. Não é o cadastro do sistema.</div></div>';
  }
  function cardTop(d) {
    var rows = d.topProducts.slice(0, 5).map(function (p, i) {
      return "<tr><td>" + (i + 1) + "</td><td>" + esc(p.name) + '</td><td class="num">' + int(p.n) + '</td><td class="num">R$ ' + brl(p.v) + "</td></tr>";
    }).join("");
    return '<div class="card"><div class="chead"><div class="ci gold">🏆</div><div><h3>Top 5 Produtos <span class="cs">(vendas)</span></h3></div></div>' +
      '<table class="tbl"><thead><tr><th>#</th><th>Produto</th><th class="num">Qtd</th><th class="num">Faturamento</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }
  function cardInsights(d) {
    var icons = ["up", "star", "people", "warn"], ig = ["📈", "🏷️", "👥", "⚠️"];
    var items = (d.insights || []).map(function (c, i) {
      return '<div class="insight"><div class="ii ' + icons[i % 4] + '">' + ig[i % 4] + "</div><div><h4>" + esc(c.title) + "</h4><p>" + esc(c.body) + "</p></div></div>";
    }).join("");
    return '<div class="card"><div class="chead"><div class="ci bulb">💡</div><div><h3>Insights Automáticos</h3></div></div>' +
      (items || '<div class="empty">Nenhum alerta automático neste mês — dentro do esperado.</div>') + "</div>";
  }

  // ---------- tab content ----------
  function tabContent(d) {
    if (state.tab === "geral") {
      return '<div class="grid cols-3">' + cardVendas(d) + cardRedes(d) + cardConc(d) + "</div>" +
        '<div class="grid cols-3" style="margin-top:18px">' + cardCategoria(d) + cardTop(d) + cardInsights(d) + "</div>";
    }
    if (state.tab === "vendas") {
      return '<div class="grid cols-2">' + cardVendas(d) +
        '<div class="card"><div class="chead"><div class="ci red">📆</div><div><h3>Por dia da semana</h3></div></div><div class="chart-host" data-chart="weekday"></div></div></div>';
    }
    if (state.tab === "redes") return '<div class="grid cols-2">' + cardRedes(d) + cardInsights(d) + "</div>";
    if (state.tab === "conc") return tabConc(d);
    if (state.tab === "cat") return '<div class="grid cols-2">' + cardCategoria(d) +
      '<div class="card"><div class="chead"><div class="ci cat">📊</div><div><h3>Categorias — tabela</h3></div></div>' + catTable(d) + "</div></div>";
    if (state.tab === "top") return '<div class="card">' + topTableFull(d) + "</div>";
    if (state.tab === "tend") return '<div class="card"><div class="chead"><div class="ci red">📈</div><div><h3>Tendência de faturamento</h3>' +
      '<div class="cs">' + (d.meta.diaParcial ? "Dia " + d.meta.diaParcial.dia.slice(8) + " (parcial) fora da linha, só na tabela." : "mês completo") + '</div></div></div><div class="chart-host" data-chart="line"></div>' + dailyTable(d) + "</div>";
    return "";
  }
  function tabConc(d) {
    var c = d.concorrencia || {};
    if (c.pending) return '<div class="card"><div class="empty">Sem coleta de concorrentes neste mês.</div></div>';
    var summary = '<div class="grid cols-3" style="margin-bottom:18px">' +
      miniStat("Abaixo do nosso preço", int(c.abaixoDoNosso)) + miniStat("Ofertas comparáveis", int(c.comparaveis)) + miniStat("Ofertas na coleta", int(c.totalOfertas)) + "</div>";
    var offers = '<div class="card"><div class="chead"><div class="ci conc">📊</div><div><h3>Todas as ofertas por desconto</h3><div class="cs">' + esc(c.nota || "") + "</div></div></div>" +
      (c.melhoresOfertas || []).map(offerRow).join("") + "</div>";
    var byc = '<div class="grid cols-3" style="margin-top:18px">' + (c.porConcorrente || []).map(function (e) {
      if (!e.temColeta) return '<div class="card"><h3 style="font-size:14px;margin:0 0 4px">' + esc(e.concorrente) + '</h3>' +
        (e.handle ? '<div class="cs">' + esc(e.handle) + "</div>" : "") + '<div class="tag conf-baixa" style="margin-top:8px;display:inline-block">sem coleta neste mês</div></div>';
      return '<div class="card"><h3 style="font-size:14px;margin:0 0 4px">' + esc(e.concorrente) + "</h3>" +
        '<p style="font-size:12.5px;color:var(--ink-2);margin:6px 0"><b>' + e.abaixo + "</b> de " + e.comparaveis + " comparáveis abaixo do nosso · " + e.ofertas + " ofertas</p>" +
        '<div style="display:flex;gap:6px;flex-wrap:wrap"><span class="tag conf-alta">Alta ' + e.confianca.Alta + '</span><span class="tag conf-media">Média ' + e.confianca["Média"] + '</span><span class="tag conf-baixa">Baixa ' + e.confianca.Baixa + "</span></div></div>";
    }).join("") + "</div>";
    return summary + offers + byc;
  }
  function miniStat(label, val) { return '<div class="card"><div class="label" style="font-size:12px;color:var(--ink-2);font-weight:600">' + label + '</div><div style="font-size:26px;font-weight:800">' + val + "</div></div>"; }
  function catTable(d) {
    var tot = d.kpis.faturamento;
    return '<table class="tbl"><thead><tr><th>Categoria</th><th class="num">Receita</th><th class="num">%</th></tr></thead><tbody>' +
      d.categories.map(function (c) { return "<tr><td>" + esc(c.label) + '</td><td class="num">R$ ' + brl(c.v) + '</td><td class="num">' + pct(c.v / tot * 100) + "</td></tr>"; }).join("") + "</tbody></table>";
  }
  function topTableFull(d) {
    return '<div class="chead"><div class="ci gold">🏆</div><div><h3>Top 15 produtos por receita</h3><div class="cs">excluindo "Diversos" e "Taxa de Entrega"</div></div></div>' +
      '<table class="tbl"><thead><tr><th>#</th><th>Produto</th><th>Categoria</th><th class="num">Qtd</th><th class="num">Receita</th></tr></thead><tbody>' +
      d.topProducts.map(function (p, i) {
        return "<tr><td>" + (i + 1) + "</td><td>" + esc(p.name) + '</td><td><span class="chip"><i style="background:' + catColor(d, p.cat) + '"></i>' + esc(p.cat) + '</span></td><td class="num">' + int(p.n) + '</td><td class="num">R$ ' + brl(p.v) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function catColor(d, label) {
    var base = label.split(" / ")[0];
    var hit = d.categories.filter(function (c) { return c.label.split(" / ")[0] === base; })[0];
    return hit ? hit.color : "var(--muted)";
  }
  function dailyTable(d) {
    return '<table class="tbl" style="margin-top:14px"><thead><tr><th>Dia</th><th class="num">Faturamento</th><th class="num">Vendas</th></tr></thead><tbody>' +
      d.daily.map(function (p) {
        return "<tr><td>" + p.d + (p.parcial ? ' <span class="tag conf-media">parcial</span>' : "") + '</td><td class="num">R$ ' + brl(p.v) + '</td><td class="num">' + int(p.n) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  // ---------- render painel ----------
  function renderPainel() {
    var d = state.data;
    if (!d) { view.innerHTML = '<div class="empty">Sem dados.</div>'; return; }
    var live = d.meta.aoVivo && !EXPORT ? '<span class="live"><i></i> ao vivo</span>' : "";
    var upd = d.meta.atualizadoEm ? new Date(d.meta.atualizadoEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    view.innerHTML =
      '<div class="page-head"><div><h1>📊 Painel de Resultados ' + live + "</h1>" +
        '<div class="sub">' + esc(d.loja) + " · " + cap(d.meta.periodoLabel) + " · visão de vendas, redes sociais e concorrência</div></div>" +
        (EXPORT ? "" : '<button class="btn" id="btn-baixar">⬇ Baixar painel (HTML)</button>') + "</div>" +
      summaryCards(d) + tabBar() + '<div id="tabc">' + tabContent(d) + "</div>" +
      '<div class="app-foot"><span>Vermelhinha Analytics v1.0</span><span class="sep">|</span>' +
        "<span>Dados atualizados em " + upd + "</span><span class=\"sep\">|</span>" +
        "<span>Categoria estimada por palavra-chave.</span><span class=\"sep\">|</span>" +
        "<span>Dia parcial excluído dos gráficos de tendência.</span><span class=\"sep\">|</span><span>❤️ Minas Farma &amp; Farma e Farma</span></div>";
    drawCharts(d);
    wirePainel(d);
  }
  function drawCharts(d) {
    view.querySelectorAll("[data-chart]").forEach(function (host) {
      var t = host.getAttribute("data-chart");
      if (t === "combo") comboChart(host, d.daily);
      else if (t === "donut") donut(host, d.categories, d.kpis.faturamento);
      else if (t === "weekday") barChart(host, d.weekday, "v");
      else if (t === "line") lineChart(host, d.daily);
    });
  }
  function wirePainel(d) {
    var b = view.querySelector("#btn-baixar");
    if (b) b.onclick = function () { window.location.href = "/export/" + encodeURIComponent(d.loja) + "/" + d.periodo; };
    view.querySelectorAll("[data-tab]").forEach(function (el) {
      el.addEventListener("click", function (ev) {
        ev.preventDefault();
        state.tab = el.getAttribute("data-tab");
        view.querySelectorAll(".tabs button").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-tab") === state.tab); });
        var tc = view.querySelector("#tabc");
        tc.innerHTML = tabContent(d);
        drawCharts(d);
        tc.querySelectorAll("[data-tab]").forEach(function (x) { x.addEventListener("click", function (e) { e.preventDefault(); state.tab = x.getAttribute("data-tab"); renderPainel(); }); });
      });
    });
  }

  // ---------- other views ----------
  function renderUpload() {
    var IG = [["visualizacoes", "Visualizações"], ["alcance", "Alcance"], ["interacoes", "Interações"], ["cliques_link", "Cliques no link"], ["visitas_perfil", "Visitas ao perfil"], ["seguidores", "Seguidores novos"]];
    var now = new Date(), prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    view.innerHTML =
      '<div class="page-head"><div><h1>⬆️ Upload de dados</h1><div class="sub">Ou é só jogar os arquivos na pasta <b>inbox</b> — o site percebe sozinho.</div></div></div>' +
      '<div class="card form-card"><form id="fUp">' +
      '<fieldset><legend>Loja e período</legend><div class="rowf">' +
        '<div><label class="f">Loja</label><select class="inp" name="loja" id="upLoja"></select></div>' +
        '<div><label class="f">Mês</label><select class="inp" name="mes" id="upMes"></select></div>' +
        '<div><label class="f">Ano</label><input type="number" name="ano" id="upAno" min="2020" max="2100"></div></div></fieldset>' +
      '<fieldset><legend>Relatório de vendas (PDF)</legend><input type="file" name="vendas" accept=".pdf">' +
        '<div class="hint">A soma é conferida contra o "Total:" do rodapé. Se não bater, é recusado.</div></fieldset>' +
      '<fieldset><legend>Instagram (Meta Business Suite)</legend><div class="hint">Digite olhando o print. Vazio = ignora. Variação pode ser negativa.</div><div id="igF"></div></fieldset>' +
      '<fieldset><legend>Concorrentes (xlsx)</legend><input type="file" name="concorrentes" accept=".xlsx"></fieldset>' +
      '<button class="btn" type="submit" id="upGo">Gerar análise</button></form><div id="upRes" class="result" hidden></div></div>';
    var mes = view.querySelector("#upMes");
    ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"].forEach(function (n, i) {
      var o = document.createElement("option"); o.value = i + 1; o.textContent = n; mes.appendChild(o);
    });
    mes.value = prev.getMonth() + 1; view.querySelector("#upAno").value = prev.getFullYear();
    var upLoja = view.querySelector("#upLoja");
    state.lojas.forEach(function (l) { var o = document.createElement("option"); o.value = l.nome; o.textContent = l.nome; upLoja.appendChild(o); });
    if (state.loja) upLoja.value = state.loja;
    var igF = view.querySelector("#igF");
    IG.forEach(function (m) {
      igF.appendChild(h('<div class="ig-grid3"><div><label class="f">' + m[1] + '</label><input type="text" data-ig="' + m[0] + '" data-k="valor" placeholder="ex.: 414,3 mil"></div>' +
        '<div><label class="f">Var %</label><input type="text" data-ig="' + m[0] + '" data-k="delta" placeholder="112,0"></div>' +
        '<div><label class="f">Obs (opcional)</label><input type="text" data-ig="' + m[0] + '" data-k="obs"></div></div>'));
    });
    view.querySelector("#fUp").addEventListener("submit", uploadSubmit);
  }
  async function uploadSubmit(ev) {
    ev.preventDefault();
    var f = ev.target, btn = view.querySelector("#upGo"), box = view.querySelector("#upRes");
    btn.disabled = true; btn.textContent = "Processando…"; box.hidden = true;
    var fd = new FormData();
    fd.append("loja", f.loja.value); fd.append("mes", f.mes.value); fd.append("ano", f.ano.value);
    if (f.vendas.files[0]) fd.append("vendas", f.vendas.files[0]);
    if (f.concorrentes.files[0]) fd.append("concorrentes", f.concorrentes.files[0]);
    var ig = {};
    view.querySelectorAll("[data-ig]").forEach(function (inp) {
      var v = inp.value.trim(); if (!v) return;
      var key = inp.getAttribute("data-ig"), kk = inp.getAttribute("data-k");
      ig[key] = ig[key] || {}; ig[key][kk === "valor" ? "valor" : kk] = v;
    });
    if (Object.keys(ig).length) fd.append("instagram", JSON.stringify(ig));
    try {
      var r = await fetch("/upload/analise", { method: "POST", body: fd });
      var d = await r.json();
      if (!r.ok) throw new Error(d.erro || ("HTTP " + r.status));
      box.className = "result ok";
      box.textContent = "OK — " + d.loja + " / " + d.periodo + "\n" +
        (d.vendas ? "Vendas: " + d.vendas.linhas + " linhas · R$ " + brl(d.vendas.total) + (d.vendas.lastDayPartial ? " (último dia parcial)" : "") + "\n" : "") +
        (d.instagram ? "Instagram: " + d.instagram.metricas + " métricas\n" : "") +
        (d.concorrentes ? "Concorrentes: " + d.concorrentes.ofertas + " ofertas\n" : "") + "\nAbra o Painel para ver.";
      box.hidden = false;
      loadPeriodos();
    } catch (e) {
      box.className = "result err"; box.textContent = "Falhou: " + e.message; box.hidden = false;
    } finally { btn.disabled = false; btn.textContent = "Gerar análise"; }
  }

  async function renderHistorico() {
    view.innerHTML = '<div class="page-head"><div><h1>🕘 Histórico</h1><div class="sub">Todos os meses já processados, por loja.</div></div></div><div id="hc"><div class="empty">Carregando…</div></div>';
    var hc = view.querySelector("#hc"), out = "";
    for (var i = 0; i < state.lojas.length; i++) {
      var loja = state.lojas[i].nome;
      var ps = await getJSON("/api/periodos/" + encodeURIComponent(loja));
      out += '<div class="card" style="margin-bottom:16px"><div class="chead"><div class="ci red">🏬</div><div><h3>' + esc(loja) + "</h3></div></div>";
      out += ps.length ? '<table class="tbl"><thead><tr><th>Período</th><th class="num">Linhas</th><th>Atualizado</th><th></th></tr></thead><tbody>' +
        ps.map(function (p) {
          return "<tr><td>" + p.periodo + (p.atual ? ' <span class="live"><i></i> atual</span>' : "") + '</td><td class="num">' + int(p.linhas || 0) + "</td><td>" +
            (p.atualizadoEm ? new Date(p.atualizadoEm).toLocaleString("pt-BR") : "—") + '</td><td><a class="more" href="#" data-open="' + esc(loja) + "|" + p.periodo + '">abrir →</a></td></tr>';
        }).join("") + "</tbody></table>" : '<div class="empty">Nenhum mês ainda.</div>';
      out += "</div>";
    }
    hc.innerHTML = out;
    hc.querySelectorAll("[data-open]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var parts = a.getAttribute("data-open").split("|");
        selLoja.value = parts[0]; state.loja = parts[0];
        loadPeriodos(parts[1]).then(function () { go("painel"); });
      });
    });
  }

  async function renderConfig() {
    view.innerHTML = '<div class="page-head"><div><h1>⚙️ Configurações</h1><div class="sub">Somente leitura aqui. Edite os arquivos em <b>config/</b> e o site recarrega.</div></div></div><div id="cc"><div class="empty">Carregando…</div></div>';
    var log = await getJSON("/api/ingest-log");
    var evs = log.eventos.slice(0, 20).map(function (e) {
      return "<tr><td>" + new Date(e.ts).toLocaleString("pt-BR") + "</td><td>" + esc(e.arquivo) + "</td><td>" +
        (e.ok ? '<span class="tag disc">ok</span>' : '<span class="tag up-price">erro</span>') + "</td><td>" +
        esc(e.ok ? JSON.stringify(e.resultado && (e.resultado.loja || e.resultado.tipo)) : e.erro) + "</td></tr>";
    }).join("");
    view.querySelector("#cc").innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="chead"><div class="ci red">📥</div><div><h3>Pasta de entrada</h3>' +
        '<div class="cs">' + esc(log.inbox) + "</div></div></div>" +
        '<p style="font-size:13px;color:var(--ink-2)">Jogue aqui o "Analítico de Vendas" (.pdf) e o Concorrentes_Coleta_*.xlsx. O painel do mês corrente se atualiza sozinho (a cada ' + log.pollMin + ' min no navegador).</p></div>' +
      '<div class="card"><div class="chead"><div class="ci gold">🧾</div><div><h3>Últimos arquivos processados</h3></div></div>' +
        (evs ? '<table class="tbl"><thead><tr><th>Quando</th><th>Arquivo</th><th>Status</th><th>Detalhe</th></tr></thead><tbody>' + evs + "</tbody></table>" : '<div class="empty">Nada ainda.</div>') + "</div>";
  }

  // ---------- data loading ----------
  async function loadLojasOnly() {
    state.lojas = await getJSON("/api/lojas");
    clear(selLoja);
    state.lojas.forEach(function (l) { var o = document.createElement("option"); o.value = l.nome; o.textContent = l.nome; selLoja.appendChild(o); });
    var qs = new URLSearchParams(location.search);
    var saved = qs.get("loja") || LS.getItem("va_loja");
    if (saved && state.lojas.some(function (l) { return l.nome === saved; })) selLoja.value = saved;
    state.loja = selLoja.value;
  }
  async function loadLojas() {
    state.lojas = await getJSON("/api/lojas");
    clear(selLoja);
    state.lojas.forEach(function (l) { var o = document.createElement("option"); o.value = l.nome; o.textContent = l.nome; selLoja.appendChild(o); });
    var qs = new URLSearchParams(location.search);
    var saved = qs.get("loja") || LS.getItem("va_loja");
    if (saved && state.lojas.some(function (l) { return l.nome === saved; })) selLoja.value = saved;
    state.loja = selLoja.value;
    await loadPeriodos(qs.get("periodo"));
  }
  async function loadPeriodos(want) {
    state.loja = selLoja.value; LS.setItem("va_loja", state.loja);
    var ps = (await getJSON("/api/periodos/" + encodeURIComponent(state.loja))).filter(function (p) { return p.temVendas; });
    state.periodos = ps;
    clear(selPeriodo);
    if (!ps.length) { state.periodo = null; if (state.view === "painel") view.innerHTML = emptyMsg(state.loja); return; }
    ps.forEach(function (p) {
      var o = document.createElement("option"); o.value = p.periodo;
      var mm = ["", "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
      o.textContent = mm[p.mes] + "/" + p.ano + (p.atual ? " (atual)" : ""); selPeriodo.appendChild(o);
    });
    var atual = ps.filter(function (p) { return p.atual; })[0];
    var pick = want || LS.getItem("va_per_" + state.loja) || (atual ? atual.periodo : ps[0].periodo);
    if (!ps.some(function (p) { return p.periodo === pick; })) pick = ps[0].periodo;
    selPeriodo.value = pick;
    await loadAnalise();
  }
  async function loadAnalise() {
    state.periodo = selPeriodo.value;
    if (!state.periodo) return;
    LS.setItem("va_per_" + state.loja, state.periodo);
    try {
      state.data = await getJSON("/api/analise/" + encodeURIComponent(state.loja) + "/" + state.periodo);
      if (state.view === "painel") renderPainel();
      setupPolling();
    } catch (e) {
      state.data = null;
      if (state.view === "painel") view.innerHTML = '<div class="empty"><div class="big">' + esc(e.body && e.body.erro || "Não foi possível carregar") + "</div>" + emptyHint() + "</div>";
    }
  }
  function emptyMsg(loja) { return '<div class="empty"><div class="big">Ainda não há dados para ' + esc(loja) + ".</div>" + emptyHint() + "</div>"; }
  function emptyHint() { return EXPORT ? "" : '<p>Jogue o "Analítico de Vendas" (.pdf) na pasta <b>inbox</b>, ou use <a class="more" href="#upload">Upload de dados</a>.</p>'; }

  function setupPolling() {
    if (state.pollId) { clearInterval(state.pollId); state.pollId = null; }
    if (EXPORT || !state.data || !state.data.meta.aoVivo) return;
    var min = state.data.meta.pollMin || 5;
    state.pollId = setInterval(refreshIfChanged, min * 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshIfChanged(); });
  }
  async function refreshIfChanged() {
    if (state.view !== "painel" || !state.data) return;
    try {
      var fresh = await getJSON("/api/analise/" + encodeURIComponent(state.loja) + "/" + state.periodo);
      if (fresh.meta.atualizadoEm !== state.data.meta.atualizadoEm) { state.data = fresh; renderPainel(); }
    } catch (e) {}
  }

  // ---------- Análise Comercial (Fase 2) ----------
  var DECISAO_CLS = { ESCALAR: "d-escalar", MANTER: "d-manter", OTIMIZAR: "d-otimizar", TESTAR: "d-testar", REDUZIR: "d-reduzir", ENCERRAR: "d-encerrar", INCONCLUSIVO: "d-inconc" };
  var GRAV_ORDEM = { critico: 0, alto: 1, medio: 2, baixo: 3 };

  function acBRL(v) { return v == null ? "—" : "R$ " + brl(Math.abs(v), 0) + (v < 0 ? " neg." : ""); }
  function acPct(v) { return v == null ? "—" : (v >= 0 ? "+" : "") + String(v).replace(".", ",") + "%"; }

  async function renderAnalise(ym) {
    state.view = "analise";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "analise"); });
    view.innerHTML = '<div class="empty">Carregando…</div>';
    var url = "/api/analise-comercial/" + encodeURIComponent(state.loja) + (ym ? "/" + ym : "");
    var d;
    try {
      d = await getJSON(url);
    } catch (e) {
      view.innerHTML =
        '<div class="page-head"><div><h1>🧭 Análise Comercial</h1><div class="sub">' + esc(state.loja) + "</div></div></div>" +
        '<div class="empty"><div class="big">' + esc((e.body && e.body.erro) || "Sem análise comercial ainda") + ".</div>" +
        (EXPORT ? "" : '<p>A análise mensal é gerada por fora (tarefa agendada) e chega como um JSON — pela pasta <b>inbox</b> ou por <code>POST /analise-comercial/upload</code>. Veja <b>prompts/motor-analise-comercial.md</b>.</p>') + "</div>";
      return;
    }
    var a = d.analise;
    var meses = d.meses || [ym || d.periodo];
    var sel = meses.map(function (m) { return '<option value="' + m + '"' + (m === d.periodo ? " selected" : "") + ">" + m + "</option>"; }).join("");
    var m = a.meta || {};
    var metaLine = [
      m.gerado_em ? "gerado em " + new Date(m.gerado_em).toLocaleString("pt-BR") : null,
      m.linhas_lidas != null ? int(m.linhas_lidas) + (m.linhas_totais ? "/" + int(m.linhas_totais) : "") + " linhas" : null,
      m.cobertura_custo_pct != null ? "cobertura de custo " + acPct(m.cobertura_custo_pct).replace("+", "") : null,
      m.confianca_global ? "confiança " + esc(m.confianca_global) : null,
    ].filter(Boolean).join(" · ");

    view.innerHTML =
      '<div class="page-head"><div><h1>🧭 Análise Comercial</h1><div class="sub">' + esc(d.loja) + " · " + esc(d.periodo) +
        (meses.length > 1 ? ' &nbsp; <select id="acMes" class="inp" style="width:auto;display:inline-block">' + sel + "</select>" : "") + "</div></div>" +
        (EXPORT ? "" : '<button class="btn secondary" id="acBaixar">⬇ Baixar (HTML)</button>') + "</div>" +
      (metaLine ? '<div class="note" style="margin:-8px 0 16px">' + metaLine + "</div>" : "") +
      acDiagnostico(a) +
      acKpis(a) +
      '<div class="grid cols-2" style="margin-top:18px">' + acBaseline(a) + acCanais(a) + "</div>" +
      acCampanhas(a) +
      '<div class="grid cols-2" style="margin-top:18px">' + acRiscos(a) + acOportunidades(a) + "</div>" +
      acAcoes(a) +
      acCorrecoes(a) +
      acPergunta(a);

    view.querySelectorAll('[data-chart="acbaseline"]').forEach(function (host) {
      barChart(host, (a.baseline_semanal || []).map(function (b) { return { label: b.rotulo, v: b.faturamento_medio || 0 }; }), "v");
    });
    var acMes = view.querySelector("#acMes");
    if (acMes) acMes.addEventListener("change", function () { renderAnalise(acMes.value); });
    var acB = view.querySelector("#acBaixar");
    if (acB) acB.addEventListener("click", function () { window.location.href = "/export-analise/" + encodeURIComponent(d.loja) + "/" + d.periodo; });
  }

  function acDiagnostico(a) {
    var dx = a.diagnostico_executivo || {};
    var dp = dx.decisao_principal || {};
    var chips = [
      dp.impacto_estimado_mes != null ? "Impacto/mês: <b>" + acBRL(dp.impacto_estimado_mes) + "</b>" : null,
      dp.custo != null ? "Custo: <b>" + acBRL(dp.custo) + "</b>" : null,
      dp.confianca ? "Confiança: <b>" + esc(dp.confianca) + "</b>" : null,
      dp.prazo ? "Prazo: <b>" + esc(dp.prazo) + "</b>" : null,
    ].filter(Boolean).map(function (c) { return "<span>" + c + "</span>"; }).join("");
    return '<div class="card ac-diag"><div class="chead"><div class="ci red">🧭</div><div><h3>Diagnóstico executivo</h3></div></div>' +
      "<h2 style=\"font-size:19px;margin:2px 0 10px\">" + esc(dx.titulo || "—") + "</h2>" +
      (dx.paragrafos || []).map(function (p) { return "<p style=\"margin:0 0 8px;color:var(--ink-2)\">" + esc(p) + "</p>"; }).join("") +
      (dp.acao ? '<div class="ac-decisao"><div class="k">Decisão mais importante agora</div><div class="v">' + esc(dp.acao) + "</div>" +
        (chips ? '<div class="ac-chips">' + chips + "</div>" : "") + "</div>" : "") + "</div>";
  }
  function acKpis(a) {
    var ks = a.kpis || [];
    if (!ks.length) return "";
    return '<div class="summary" style="margin-top:18px">' + ks.slice(0, 4).map(function (k) {
      var sent = k.sentido === "bom" ? "up" : k.sentido === "ruim" ? "down" : "";
      var val = k.unidade === "BRL" ? "R$ " + brl(k.valor) : k.unidade === "%" ? pct(k.valor) : int(k.valor);
      return '<div class="sc"><div class="body"><div class="label">' + esc(k.rotulo) + '</div><div class="big">' + val + "</div>" +
        (k.variacao_pct != null ? '<div class="delta ' + sent + '">' + acPct(k.variacao_pct) + '</div>' : "") + "</div></div>";
    }).join("") + "</div>";
  }
  function acBaseline(a) {
    var b = a.baseline_semanal || [];
    if (!b.length) return '<div class="card"><div class="chead"><div class="ci red">📆</div><div><h3>Baseline semanal</h3></div></div><div class="empty">sem dados</div></div>';
    return '<div class="card"><div class="chead"><div class="ci red">📆</div><div><h3>Baseline semanal</h3><div class="cs">faturamento médio por dia da semana</div></div></div>' +
      '<div class="chart-host" data-chart="acbaseline"></div>' +
      '<table class="tbl" style="margin-top:12px"><thead><tr><th>Dia</th><th class="num">N</th><th class="num">Média</th><th class="num">Mediana</th><th class="num">Desvio</th><th class="num">Ticket</th></tr></thead><tbody>' +
      b.map(function (r) {
        return "<tr><td>" + esc(r.rotulo) + '</td><td class="num">' + int(r.n) + '</td><td class="num">R$ ' + brl(r.faturamento_medio || 0, 0) +
          '</td><td class="num">R$ ' + brl(r.mediana || 0, 0) + '</td><td class="num">R$ ' + brl(r.desvio_padrao || 0, 0) + '</td><td class="num">R$ ' + brl(r.ticket || 0) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function acCanais(a) {
    var c = a.canais || [];
    if (!c.length) return '<div class="card"><div class="chead"><div class="ci conc">🧾</div><div><h3>Canais</h3></div></div><div class="empty">sem dados</div></div>';
    return '<div class="card"><div class="chead"><div class="ci conc">🧾</div><div><h3>Canais (sem sobreposição)</h3></div></div>' +
      '<table class="tbl"><thead><tr><th>Canal</th><th class="num">Cupons</th><th class="num">%</th><th class="num">Faturamento</th><th class="num">%</th><th class="num">Ticket</th></tr></thead><tbody>' +
      c.map(function (r) {
        return "<tr><td>" + esc(r.nome) + '</td><td class="num">' + int(r.cupons) + '</td><td class="num">' + (r.cupons_pct != null ? pct(r.cupons_pct) : "—") +
          '</td><td class="num">R$ ' + brl(r.faturamento || 0, 0) + '</td><td class="num">' + (r.faturamento_pct != null ? pct(r.faturamento_pct) : "—") +
          '</td><td class="num">R$ ' + brl(r.ticket || 0) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function acCampanhas(a) {
    var cs = a.campanhas || [];
    if (!cs.length) return "";
    return '<div class="card" style="margin-top:18px"><div class="chead"><div class="ci gold">🎯</div><div><h3>Scorecard de campanhas</h3><div class="cs">a margem incremental decide, não o faturamento</div></div></div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr><th>Campanha</th><th>Decisão</th><th class="num">Fat. incr.</th><th class="num">Margem promo</th><th class="num">Margem base</th><th class="num">Margem incr./mês</th><th class="num">Penetr.</th><th>Confiança</th></tr></thead><tbody>' +
      cs.map(function (c) {
        var badge = '<span class="dbadge ' + (DECISAO_CLS[c.decisao] || "d-inconc") + '">' + esc(c.decisao || "—") + "</span>";
        return "<tr><td><b>" + esc(c.nome) + "</b>" + (c.justificativa ? '<div class="cs">' + esc(c.justificativa) + "</div>" : "") + "</td>" +
          "<td>" + badge + '</td><td class="num">' + acPct(c.faturamento_incremental_pct) + '</td><td class="num">' + acPct(c.margem_pct_promo) +
          '</td><td class="num">' + acPct(c.margem_pct_base) + '</td><td class="num">' + acBRL(c.margem_incremental_mes) + '</td><td class="num">' + acPct(c.penetracao_cupons_pct) +
          "</td><td>" + esc(c.confianca || "—") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }
  function acRiscos(a) {
    var rs = (a.riscos || []).slice().sort(function (x, y) { return (GRAV_ORDEM[x.gravidade] ?? 9) - (GRAV_ORDEM[y.gravidade] ?? 9); });
    return '<div class="card"><div class="chead"><div class="ci" style="background:#fdecec;color:var(--down)">⚠️</div><div><h3>Riscos</h3></div></div>' +
      (rs.length ? rs.map(function (r) {
        return '<div class="ac-risco g-' + esc(r.gravidade || "baixo") + '"><div><b>' + esc(r.titulo) + "</b>" +
          (r.evidencia ? '<div class="cs">' + esc(r.evidencia) + "</div>" : "") + "</div>" +
          (r.valor_em_risco != null ? '<div class="ac-valor">' + acBRL(r.valor_em_risco) + "</div>" : "") + "</div>";
      }).join("") : '<div class="empty">Nenhum risco material.</div>') + "</div>";
  }
  function acOportunidades(a) {
    var os = a.oportunidades || [];
    return '<div class="card"><div class="chead"><div class="ci" style="background:var(--ok-bg);color:var(--ok)">💰</div><div><h3>Oportunidades</h3></div></div>' +
      (os.length ? os.map(function (o) {
        return '<div class="insight"><div class="ii up">＋</div><div><h4>' + esc(o.titulo) + "</h4>" +
          '<p>Impacto/mês <b>' + acBRL(o.impacto_estimado_mes) + "</b> · custo " + acBRL(o.custo) + " · confiança " + esc(o.confianca || "—") +
          (o.premissas && o.premissas.length ? "<br><i>premissas: " + o.premissas.map(esc).join("; ") + "</i>" : "") + "</p></div></div>";
      }).join("") : '<div class="empty">—</div>') + "</div>";
  }
  function acAcoes(a) {
    var as = (a.acoes || []).slice().sort(function (x, y) { return (x.ordem || 99) - (y.ordem || 99); });
    if (!as.length) return "";
    return '<div class="card" style="margin-top:18px"><div class="chead"><div class="ci bulb">✅</div><div><h3>Plano de ação</h3></div></div>' +
      '<table class="tbl"><thead><tr><th>#</th><th>Ação</th><th>Responsável</th><th class="num">Prazo</th><th class="num">Custo</th><th class="num">Impacto/mês</th></tr></thead><tbody>' +
      as.map(function (x) {
        return "<tr><td>" + (x.ordem || "") + "</td><td>" + esc(x.acao) + "</td><td>" + esc(x.responsavel || "—") + '</td><td class="num">' +
          (x.prazo_dias != null ? x.prazo_dias + " d" : "—") + '</td><td class="num">' + acBRL(x.custo) + '</td><td class="num">' + acBRL(x.impacto_estimado_mes) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function acCorrecoes(a) {
    var cs = a.correcoes || [];
    if (!cs.length) return "";
    return '<div class="card ac-correcoes" style="margin-top:18px"><div class="chead"><div class="ci" style="background:var(--warn-bg);color:var(--warn)">🔄</div><div><h3>O que mudou desde a última análise</h3></div></div>' +
      cs.map(function (c) {
        return '<div class="ac-corr"><div><span class="tag ' + (c.gravidade === "material" ? "up-price" : "conf-baixa") + '">' + esc(c.gravidade || "menor") + "</span></div>" +
          "<div><div class=\"cs\">antes</div>" + esc(c.conclusao_anterior || "—") + "<div class=\"cs\" style=\"margin-top:6px\">agora</div><b>" + esc(c.conclusao_nova || "—") + "</b>" +
          (c.motivo ? '<div class="cs" style="margin-top:4px">motivo: ' + esc(c.motivo) + "</div>" : "") + "</div></div>";
      }).join("") + "</div>";
  }
  function acPergunta(a) {
    var p = a.pergunta_central || {};
    var ok = p.melhor_caminho === true;
    return '<div class="ac-band ' + (ok ? "sim" : "nao") + '"><div class="q">No caminho atual, estamos no melhor caminho possível?</div>' +
      '<div class="ans">' + (ok ? "SIM" : "NÃO") + "</div>" +
      (p.motivo ? '<div class="why">' + esc(p.motivo) + "</div>" : "") +
      (a.limitacoes && a.limitacoes.length ? '<div class="lims">Limitações: ' + a.limitacoes.map(esc).join(" · ") + "</div>" : "") + "</div>";
  }

  // ---------- nav ----------
  var VIEWS = ["painel", "analise", "upload", "historico", "config"];
  function go(v) {
    state.view = v;
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === v); });
    if (v === "painel") { if (state.data) renderPainel(); else loadAnalise(); }
    else if (v === "analise") renderAnalise();
    else if (v === "upload") renderUpload();
    else if (v === "historico") renderHistorico();
    else if (v === "config") renderConfig();
  }

  // ---------- boot ----------
  if (EXPORT) {
    document.body.classList.add("export");
    if (window.__EXPORT_VIEW__ === "analise") {
      loadLojasOnly().then(function () { renderAnalise(); }).catch(function (e) { view.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    } else {
      loadLojas().catch(function (e) { view.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
  } else {
    selLoja.addEventListener("change", function () {
      state.loja = selLoja.value;
      LS.setItem("va_loja", state.loja);
      if (state.view === "analise") { renderAnalise(); loadPeriodos(); }
      else loadPeriodos();
    });
    selPeriodo.addEventListener("change", loadAnalise);
    document.getElementById("btn-sair").addEventListener("click", function () {
      fetch("/logout", { method: "POST" }).then(function () { location.href = "/login"; });
    });
    document.querySelectorAll(".nav a").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); location.hash = a.getAttribute("data-view"); });
    });
    window.addEventListener("hashchange", function () {
      var v = (location.hash || "#painel").slice(1);
      if (VIEWS.indexOf(v) >= 0) go(v);
    });
    loadLojas().then(function () {
      var v = (location.hash || "#painel").slice(1);
      go(VIEWS.indexOf(v) >= 0 ? v : "painel");
    }).catch(function (e) {
      if (e.status === 401) { location.href = "/login"; return; }
      view.innerHTML = '<div class="empty">Erro ao iniciar: ' + esc(e.message) + "</div>";
    });
  }
})();
