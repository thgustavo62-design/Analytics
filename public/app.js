/* Analytics — app shell + dashboard. Vanilla JS, gráficos SVG à mão.
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
      return '<div class="row cx-jump" data-cat="' + esc(c.catRaw || c.label) + '" title="ver no mapa de conexões" style="cursor:pointer">' +
        '<span class="legend-dot"><i style="background:' + (c.color || CAT_COLORS[i % 7]) + '"></i></span>' +
        '<span class="nm">' + esc(c.label) + '</span><span class="pc">' + pct(c.v / tot * 100) + "</span></div>";
    }).join("");
    return '<div class="card"><div class="chead"><div class="ci cat">📅</div><div><h3>Vendas por Categoria</h3>' +
      '<div class="cs">Baseada em palavra-chave · clique numa categoria p/ ver as conexões</div></div></div>' +
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
      '<div class="app-foot"><span>Analytics v1.0</span><span class="sep">|</span>' +
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
    if (!view._cxDelegated) {
      view._cxDelegated = true;
      view.addEventListener("click", function (ev) {
        var j = ev.target.closest && ev.target.closest(".cx-jump");
        if (j && state.view === "painel") abrirConexoes("cat:" + j.getAttribute("data-cat"));
      });
    }
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
    var cat = null;
    try { cat = await getJSON("/api/catalogo/" + encodeURIComponent(state.loja)); } catch (e) {}
    var catHtml = "";
    if (cat) {
      var fr = cat.freshness;
      var frRow = function (nm, o) {
        return "<tr><td>" + nm + "</td><td>" + (o.ultima ? o.ultima : '<span class="tag up-price">sem dados</span>') + "</td><td class=\"num\">" + int(o.produtos) + "</td></tr>";
      };
      catHtml =
        '<div class="card" style="margin-bottom:16px"><div class="chead"><div class="ci cat">🧬</div><div><h3>Catálogo (EAN) — ' + esc(state.loja) + "</h3>" +
        '<div class="cs">produtos vêm dos códigos de barras das vendas; estoque/custo/preço vêm de planilhas na inbox (Estoque_/Custo_/Precos_*.xlsx)</div></div></div>' +
        '<div class="cx-metrs" style="margin-bottom:10px">' +
          '<div class="cx-m"><span>Produtos no catálogo</span><b>' + int(cat.contagem.produtos) + "</b></div>" +
          '<div class="cx-m"><span>Com EAN</span><b>' + int(cat.contagem.comEan) + "</b></div>" +
          '<div class="cx-m"><span>Sem categoria</span><b>' + int(cat.contagem.semCategoria) + "</b></div>" +
          '<div class="cx-m"><span>Com correção manual</span><b>' + int(cat.contagem.comOverride) + "</b></div>" +
        "</div>" +
        '<table class="tbl"><thead><tr><th>Feed</th><th>Última atualização</th><th class="num">Produtos</th></tr></thead><tbody>' +
          frRow("Estoque", fr.estoque) + frRow("Custo", fr.custo) + frRow("Preço", fr.preco) + "</tbody></table>" +
        (cat.faltando && cat.faltando.length ? '<div class="note" style="color:var(--down)">⚠ Sem feed de ' + cat.faltando.join(", ") + " — days-of-cover, margem e simulador ficam indisponíveis até você subir essas planilhas (Fase 2).</div>" : "") +
        "</div>";
    }
    var evs = log.eventos.slice(0, 20).map(function (e) {
      return "<tr><td>" + new Date(e.ts).toLocaleString("pt-BR") + "</td><td>" + esc(e.arquivo) + "</td><td>" +
        (e.ok ? '<span class="tag disc">ok</span>' : '<span class="tag up-price">erro</span>') + "</td><td>" +
        esc(e.ok ? JSON.stringify(e.resultado && (e.resultado.loja || e.resultado.tipo)) : e.erro) + "</td></tr>";
    }).join("");
    view.querySelector("#cc").innerHTML =
      '<div class="card" style="margin-bottom:16px"><div class="chead"><div class="ci red">📥</div><div><h3>Pasta de entrada</h3>' +
        '<div class="cs">' + esc(log.inbox) + "</div></div></div>" +
        '<p style="font-size:13px;color:var(--ink-2)">Jogue aqui o "Analítico de Vendas" (.pdf), o Concorrentes_Coleta_*.xlsx e as planilhas Estoque_/Custo_/Precos_*.xlsx. O painel do mês corrente se atualiza sozinho (a cada ' + log.pollMin + ' min no navegador).</p></div>' +
      catHtml +
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
      var b = e.body || {};
      view.innerHTML =
        '<div class="page-head"><div><h1>🧭 Análise Comercial</h1><div class="sub">' + esc(state.loja) + "</div></div></div>" +
        '<div class="empty"><div class="big">' + esc(b.erro || "Sem análise comercial ainda") + ".</div>" +
        (!EXPORT && b.podeGerar ? '<p><button class="btn" id="acGerar">🧠 Gerar análise agora</button><br><span class="hint">usa a API da Anthropic (' + esc(b.model || "") + ") · custa alguns centavos por rodada</span></p>" : "") +
        (EXPORT ? "" : '<p class="hint">Também dá para entregar o JSON pela pasta <b>inbox</b> ou por <code>POST /analise-comercial/upload</code> (tarefa agendada). Veja <b>prompts/motor-analise-comercial.md</b>.</p>') + "</div>";
      var g = view.querySelector("#acGerar");
      if (g) g.addEventListener("click", function () { gerarAnaliseAgora(g); });
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
        '<div style="display:flex;gap:8px">' +
        (EXPORT ? "" : '<button class="btn secondary" id="acMapa" title="Ver os achados ligados aos objetos">🕸️ Ver no mapa</button>') +
        (!EXPORT && d.podeGerar ? '<button class="btn secondary" id="acRegerar" title="Regera com a API da Anthropic">🧠 Regerar</button>' : "") +
        (EXPORT ? "" : '<button class="btn secondary" id="acBaixar">⬇ Baixar (HTML)</button>') + "</div></div>" +
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
    var acR = view.querySelector("#acRegerar");
    if (acR) acR.addEventListener("click", function () { gerarAnaliseAgora(acR, d.periodo); });
    var acM = view.querySelector("#acMapa");
    if (acM) acM.addEventListener("click", function () { state.periodo = d.periodo; abrirConexoes(); });
  }

  async function gerarAnaliseAgora(btn, ym) {
    var loja = state.loja;
    btn.disabled = true;
    var txt0 = btn.textContent;
    btn.textContent = "Gerando… (pode levar 1–2 min)";
    try {
      if (!ym) {
        var ps = (await getJSON("/api/periodos/" + encodeURIComponent(loja))).filter(function (p) { return p.temVendas; });
        if (!ps.length) throw new Error("não há vendas processadas para " + loja);
        ym = (ps.filter(function (p) { return p.atual; })[0] || ps[0]).periodo;
      }
      var r = await fetch("/analise-comercial/gerar/" + encodeURIComponent(loja) + "/" + ym, { method: "POST" });
      var j = await r.json();
      if (!r.ok) throw new Error(j.erro || ("HTTP " + r.status));
      renderAnalise(ym);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = txt0;
      alert("Não deu para gerar: " + e.message);
    }
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

  // ---------- Conexões (ontologia — grafo de objetos interligados) ----------
  var NODE_COR = {
    loja: "#111827", categoria: "var(--s1)", campanha: "var(--s3)", canal: "var(--s4)",
    concorrente: "var(--s2)", sinal: "#6b7280", risco: "#dc2626", oportunidade: "#16a34a",
    acao: "#2563eb", decisao: "#7c3aed", veredito: "#7c3aed",
  };
  var EDGE_COR = {
    vende: "#c9ced6", canal: "#93b4e6", promove: "#7fca9f", pressiona: "#e88", afeta: "#e88",
    causa: "#e88", risco: "#e88", sobre: "#b7a4e0", veredito: "#b7a4e0", decisao: "#b7a4e0",
    oportunidade: "#7fca9f", acao: "#93b4e6", campanha: "#c9ced6", concorrente: "#c9ced6",
    sinal: "#c9ced6", explica: "#c9ced6",
  };
  var TIPO_LABEL = { loja: "Loja", categoria: "Categoria", campanha: "Campanha", canal: "Canal", concorrente: "Concorrente", sinal: "Sinal", risco: "Risco", oportunidade: "Oportunidade", acao: "Ação", decisao: "Decisão", veredito: "Veredito de campanha" };
  var REL_LABEL = { vende: "vende", canal: "canal", promove: "promove", pressiona: "pressão de preço em", afeta: "afeta", causa: "origem", risco: "risco", sobre: "sobre", veredito: "veredito de", decisao: "decisão", oportunidade: "oportunidade", acao: "ação", campanha: "campanha", concorrente: "concorrente", sinal: "sinal", explica: "explica" };

  function circMean(angs) {
    if (!angs.length) return null;
    var x = 0, y = 0;
    angs.forEach(function (a) { x += Math.cos(a); y += Math.sin(a); });
    return Math.atan2(y / angs.length, x / angs.length);
  }

  var CX_ONT = 620, CY_ONT = 430;
  function layoutOntologia(g) {
    var pos = {};
    pos["loja"] = { x: CX_ONT, y: CY_ONT, r: 32, ang: 0 };
    var viz = {};
    g.edges.forEach(function (e) {
      (viz[e.de] = viz[e.de] || []).push(e.para);
      (viz[e.para] = viz[e.para] || []).push(e.de);
    });
    // anel de categorias — distribuído por igual, ordenado por receita
    var cats = g.nodes.filter(function (n) { return n.tipo === "categoria"; }).sort(function (a, b) { return (b.valor || 0) - (a.valor || 0); });
    var maxVal = Math.max.apply(null, cats.map(function (c) { return c.valor || 1; }).concat([1]));
    cats.forEach(function (n, i) {
      var ang = (i / Math.max(1, cats.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = { x: CX_ONT + Math.cos(ang) * 185, y: CY_ONT + Math.sin(ang) * 185, r: 7 + 15 * Math.sqrt((n.valor || 1) / maxVal), ang: ang, ring: 1 };
    });
    // anéis externos — ângulo preferido = média dos vizinhos já posicionados; depois
    // distribui por igual respeitando essa ordem (garante que não encavala).
    function anel(tipos, radius, stagger) {
      var arr = g.nodes.filter(function (n) { return tipos.indexOf(n.tipo) >= 0 && !pos[n.id]; });
      if (!arr.length) return;
      arr.forEach(function (n) {
        var angs = (viz[n.id] || []).map(function (v) { return pos[v] ? pos[v].ang : null; }).filter(function (a) { return a != null; });
        n._pref = circMean(angs);
        if (n._pref == null) n._pref = Math.random() * Math.PI * 2;
      });
      arr.sort(function (a, b) { return a._pref - b._pref; });
      arr.forEach(function (n, i) {
        var ang = (i / arr.length) * Math.PI * 2 - Math.PI / 2;
        var rr = radius + (stagger && i % 2 ? 42 : 0);
        pos[n.id] = { x: CX_ONT + Math.cos(ang) * rr, y: CY_ONT + Math.sin(ang) * rr, r: 12, ang: ang, ring: radius };
      });
    }
    anel(["campanha", "canal"], 300);
    anel(["concorrente", "sinal", "risco", "oportunidade", "acao", "decisao", "veredito"], 400, true);
    return pos;
  }
  function boundsOf(pos) {
    var xs = [], ys = [];
    for (var k in pos) { xs.push(pos[k].x); ys.push(pos[k].y); }
    var pad = 140;
    var minX = Math.min.apply(null, xs) - pad, maxX = Math.max.apply(null, xs) + pad;
    var minY = Math.min.apply(null, ys) - pad, maxY = Math.max.apply(null, ys) + pad;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  async function renderConexoes(ym) {
    state.view = "conexoes";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "conexoes"); });
    view.innerHTML = '<div class="empty">Montando o mapa…</div>';
    var periodo = ym || state.periodo;
    try {
      if (!periodo) {
        var ps = (await getJSON("/api/periodos/" + encodeURIComponent(state.loja))).filter(function (p) { return p.temVendas; });
        if (!ps.length) throw { body: { erro: "sem dados para " + state.loja } };
        periodo = (ps.filter(function (p) { return p.atual; })[0] || ps[0]).periodo;
      }
      var g = await getJSON("/api/ontologia/" + encodeURIComponent(state.loja) + "/" + periodo);
      state.conexoes = { g: g, periodo: periodo, pos: layoutOntologia(g), filtro: null };
      drawConexoes();
    } catch (e) {
      view.innerHTML = '<div class="page-head"><div><h1>🕸️ Conexões</h1><div class="sub">' + esc(state.loja) + "</div></div></div>" +
        '<div class="empty"><div class="big">' + esc((e.body && e.body.erro) || "Não deu para montar o mapa") + ".</div><p>Suba um relatório de vendas primeiro.</p></div>";
    }
  }

  function drawConexoes() {
    var C = state.conexoes;
    if (!C) return;
    var g = C.g, pos = C.pos;
    var focus = state.conexoesFocus && g.nodes.some(function (n) { return n.id === state.conexoesFocus; }) ? state.conexoesFocus : null;
    var vizIds = {};
    if (focus) { vizIds[focus] = 1; g.edges.forEach(function (e) { if (e.de === focus) vizIds[e.para] = 1; if (e.para === focus) vizIds[e.de] = 1; }); }
    var visivel = function (n) { return !C.filtro || n.tipo === C.filtro || n.tipo === "loja" || (focus && vizIds[n.id]); };

    var tipos = [];
    g.nodes.forEach(function (n) { if (n.tipo !== "loja" && tipos.indexOf(n.tipo) < 0) tipos.push(n.tipo); });
    var chips = '<button class="cx-chip' + (!C.filtro ? " on" : "") + '" data-f="">Tudo</button>' + tipos.map(function (t) {
      return '<button class="cx-chip' + (C.filtro === t ? " on" : "") + '" data-f="' + t + '"><i style="background:' + (NODE_COR[t] || "#999") + '"></i>' + (TIPO_LABEL[t] || t) + " (" + (g.contagem[t] || 0) + ")</button>";
    }).join("");

    // SVG — viewBox ajustado ao conteúdo
    var bb = boundsOf(pos), parts = [];
    g.edges.forEach(function (e) {
      var a = pos[e.de], b = pos[e.para];
      if (!a || !b) return;
      var n1 = g.nodes.find(function (n) { return n.id === e.de; }), n2 = g.nodes.find(function (n) { return n.id === e.para; });
      if (!visivel(n1) || !visivel(n2)) return;
      var on = !focus || e.de === focus || e.para === focus;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var cxp = mx + (CX_ONT - mx) * 0.14, cyp = my + (CY_ONT - my) * 0.14;
      parts.push('<path d="M' + a.x.toFixed(0) + " " + a.y.toFixed(0) + " Q" + cxp.toFixed(0) + " " + cyp.toFixed(0) + " " + b.x.toFixed(0) + " " + b.y.toFixed(0) +
        '" fill="none" stroke="' + (on ? (EDGE_COR[e.tipo] || "#c9ced6") : "#eceef1") + '" stroke-width="' + (on ? Math.min(4, 1 + (e.peso || 1) / 6) : 1) + '" opacity="' + (on ? 0.85 : 0.35) + '"/>');
      if (e.rotulo && on && focus) parts.push('<text x="' + mx.toFixed(0) + '" y="' + (my - 3).toFixed(0) + '" text-anchor="middle" class="cx-elabel">' + esc(e.rotulo) + "</text>");
    });
    g.nodes.forEach(function (n) {
      var p = pos[n.id];
      if (!p || !visivel(n)) return;
      var dim = focus && !vizIds[n.id];
      var ring = { risco: "#dc2626", oportunidade: "#16a34a", atencao: "#d97706", decisao: "#7c3aed" }[n.destaque];
      parts.push('<g class="cx-node" data-id="' + esc(n.id) + '" opacity="' + (dim ? 0.22 : 1) + '" style="cursor:pointer">');
      if (ring) parts.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (p.r + 4) + '" fill="none" stroke="' + ring + '" stroke-width="2.5"/>');
      parts.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + p.r + '" fill="' + (NODE_COR[n.tipo] || "#999") + '" stroke="' + (n.id === focus ? "#111" : "#fff") + '" stroke-width="' + (n.id === focus ? 3 : 2) + '"/>');
      // rótulo: nós externos empurram o texto para fora do centro
      var out = n.tipo === "loja" ? 0 : 1;
      var lx = out ? p.x + Math.cos(p.ang) * (p.r + 4) : p.x;
      var ly = out ? p.y + Math.sin(p.ang) * (p.r + 4) + 4 : p.y + p.r + 12;
      var anchor = !out ? "middle" : Math.cos(p.ang) > 0.35 ? "start" : Math.cos(p.ang) < -0.35 ? "end" : "middle";
      var txt = n.rotulo.length > 30 ? n.rotulo.slice(0, 29) + "…" : n.rotulo;
      parts.push('<text x="' + lx.toFixed(0) + '" y="' + ly.toFixed(0) + '" text-anchor="' + anchor + '" class="cx-nlabel' + (n.id === focus ? " f" : "") + '">' + esc(txt) + "</text>");
      parts.push("</g>");
    });

    view.innerHTML =
      '<div class="page-head"><div><h1>🕸️ Conexões <span class="cs" style="font-weight:500">' + esc(state.loja) + " · " + esc(C.periodo) + "</span></h1>" +
        '<div class="sub">Cada objeto — categoria, campanha, canal, concorrente, risco — ligado ao que ele toca. Clique para focar.' +
        (g.tem_analise_comercial ? " Inclui os achados da Análise Comercial." : " (gere a Análise Comercial para trazer riscos e ações pro mapa.)") + "</div></div></div>" +
      '<div class="cx-chips">' + chips + "</div>" +
      '<div class="cx-wrap"><div class="cx-graph"><svg viewBox="' + bb.x.toFixed(0) + " " + bb.y.toFixed(0) + " " + bb.w.toFixed(0) + " " + bb.h.toFixed(0) + '" class="cx-svg">' + parts.join("") + "</svg></div>" +
      '<div class="cx-panel" id="cxPanel">' + cxPanelHtml(focus ? g.nodes.find(function (n) { return n.id === focus; }) : null, g) + "</div></div>";

    view.querySelectorAll(".cx-chip").forEach(function (b) {
      b.addEventListener("click", function () { C.filtro = b.getAttribute("data-f") || null; state.conexoesFocus = null; drawConexoes(); });
    });
    view.querySelectorAll(".cx-node").forEach(function (el) {
      el.addEventListener("click", function () { state.conexoesFocus = el.getAttribute("data-id"); drawConexoes(); });
    });
    view.querySelectorAll("[data-goto]").forEach(function (el) {
      el.addEventListener("click", function () { state.conexoesFocus = el.getAttribute("data-goto"); drawConexoes(); });
    });
    var lim = view.querySelector("#cxLimpar");
    if (lim) lim.addEventListener("click", function () { state.conexoesFocus = null; drawConexoes(); });
  }

  function cxPanelHtml(node, g) {
    if (!node) {
      var destaques = g.nodes.filter(function (n) { return ["risco", "oportunidade"].indexOf(n.destaque) >= 0 || n.tipo === "sinal" || n.tipo === "risco" || n.tipo === "oportunidade"; });
      return '<div class="cx-p-empty"><b>Selecione um objeto</b><p>ou comece pelos pontos de atenção:</p>' +
        destaques.slice(0, 8).map(function (n) {
          return '<div class="cx-link" data-goto="' + esc(n.id) + '"><span class="cx-dot" style="background:' + (NODE_COR[n.tipo] || "#999") + '"></span>' + esc(n.rotulo) + "</div>";
        }).join("") + "</div>";
    }
    var conn = [];
    g.edges.forEach(function (e) {
      if (e.de === node.id) conn.push({ rel: e.tipo, id: e.para, rotulo: e.rotulo });
      else if (e.para === node.id) conn.push({ rel: e.tipo, id: e.de, rotulo: e.rotulo });
    });
    var porRel = {};
    conn.forEach(function (c) {
      var alvo = g.nodes.find(function (n) { return n.id === c.id; });
      if (!alvo) return;
      (porRel[c.rel] = porRel[c.rel] || []).push({ alvo: alvo, rotulo: c.rotulo });
    });
    var metr = Object.keys(node.metricas || {}).map(function (k) {
      return '<div class="cx-m"><span>' + esc(k) + "</span><b>" + esc(node.metricas[k]) + "</b></div>";
    }).join("");
    var conexHtml = Object.keys(porRel).map(function (rel) {
      return '<div class="cx-relgrp"><div class="cx-rel">' + esc(REL_LABEL[rel] || rel) + "</div>" +
        porRel[rel].map(function (x) {
          return '<div class="cx-link" data-goto="' + esc(x.alvo.id) + '"><span class="cx-dot" style="background:' + (NODE_COR[x.alvo.tipo] || "#999") + '"></span>' +
            esc(x.alvo.rotulo) + (x.rotulo ? ' <span class="cx-tag">' + esc(x.rotulo) + "</span>" : "") + "</div>";
        }).join("") + "</div>";
    }).join("");
    return '<div class="cx-p-head"><span class="cx-badge" style="background:' + (NODE_COR[node.tipo] || "#999") + '">' + esc(TIPO_LABEL[node.tipo] || node.tipo) + "</span>" +
      (node.destaque ? '<span class="cx-badge d-' + node.destaque + '">' + node.destaque + "</span>" : "") + "</div>" +
      "<h3>" + esc(node.rotulo) + "</h3>" +
      (node.nota ? '<p class="cx-nota">' + esc(node.nota) + "</p>" : "") +
      (metr ? '<div class="cx-metrs">' + metr + "</div>" : "") +
      (node.lista ? '<div class="cx-lista"><b>' + esc(node.lista.titulo) + "</b>" + node.lista.itens.map(function (i) { return "<div>• " + esc(i) + "</div>"; }).join("") + "</div>" : "") +
      (conexHtml ? '<div class="cx-conex"><div class="cx-conex-h">Conectado a</div>' + conexHtml + "</div>" : "") +
      '<button class="btn secondary" id="cxLimpar" style="margin-top:12px">← limpar foco</button>';
  }

  // ---------- Marketing (Fase 2/3/4) ----------
  var mkt = { tab: "produtos", cache: {} };
  var MKT_TABS = [
    ["produtos", "Produtos"], ["recomendados", "Recomendados"], ["nao-anunciar", "Não anunciar"],
    ["estoque-parado", "Estoque parado"], ["cestas", "Cestas & Combos"], ["eficiencia", "Eficiência"],
    ["builder", "Montar campanha"], ["simulador", "Simulador de oferta"],
  ];
  function mktPeriodo() { return state.periodo || (state.periodos[0] && state.periodos[0].periodo) || null; }
  function scoreBar(s) {
    var c = s >= 68 ? "var(--s1)" : s >= 45 ? "var(--s3)" : "var(--muted)";
    return '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:60px;height:7px;border-radius:4px;background:var(--line);display:inline-block;overflow:hidden"><span style="display:block;height:100%;width:' + Math.max(2, Math.min(100, s)) + '%;background:' + c + '"></span></span><b>' + (s == null ? "—" : s) + "</b></span>";
  }
  function classeChip(cl) {
    var m = { HERO: "🥇", TRAFEGO: "🧲", OPORTUNIDADE: "📈", GIRO_URGENTE: "⏱️", PROTEGIDO: "🛡️", COMPLEMENTAR: "➕", DEFESA: "⚔️", GIRO: "•" };
    return '<span class="chip">' + (m[cl] || "") + " " + esc(cl) + "</span>";
  }
  function tendChip(t) {
    var m = { SUBINDO: ["▲", "var(--s1)"], CAINDO: ["▼", "var(--down)"], ESTAVEL: ["=", "var(--ink-2)"], SEM_BASE: ["·", "var(--muted)"] };
    var x = m[t.rotulo] || m.SEM_BASE;
    return '<span style="color:' + x[1] + '">' + x[0] + " " + (t.pct == null ? "s/ base" : (t.pct > 0 ? "+" : "") + t.pct + "%") + "</span>";
  }
  function feedsAviso(r) {
    if (!r || !r.dados_ausentes_globais || !r.dados_ausentes_globais.length) return "";
    return '<div class="result" style="background:#fff6e6;border-color:#f0c98a;color:#8a5a00;margin-bottom:14px">⚠ Sem alguns feeds — números pré-calculados só do que existe (a IA não completa nada):<ul style="margin:6px 0 0 18px">' +
      r.dados_ausentes_globais.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>";
  }
  function prodRow(p) {
    return "<tr><td>" + esc(p.descricao) + (p.ean ? '<div class="cs">EAN ' + p.ean + "</div>" : "") + "</td>" +
      "<td>" + classeChip(p.classe) + "</td>" +
      '<td class="num">' + int(p.unidades[30]) + "</td>" +
      '<td class="num">R$ ' + brl(p.receita.d30) + "</td>" +
      "<td>" + tendChip(p.tendencia) + "</td>" +
      "<td>" + (p.cobertura_rotulo === "SEM_ESTOQUE" ? '<span class="cs">s/ feed</span>' : '<span class="tag">' + (p.cobertura_infinita ? "∞" : p.dias_cobertura + "d") + " · " + p.cobertura_rotulo + "</span>") + "</td>" +
      "<td>" + (p.margem_pct == null ? '<span class="cs">s/ custo</span>' : pct(p.margem_pct * 100)) + "</td>" +
      "<td>" + scoreBar(p.opportunity.score) + ' <span class="cs">conf ' + p.opportunity.confianca + "</span></td></tr>";
  }
  function prodTable(items, cols) {
    if (!items || !items.length) return '<div class="empty">Nada aqui neste período.</div>';
    return '<table class="tbl"><thead><tr><th>Produto</th><th>Classe</th><th class="num">Un 30d</th><th class="num">Receita 30d</th><th>Tendência</th><th>Cobertura</th><th>Margem</th><th>Opportunity</th></tr></thead><tbody>' +
      items.map(prodRow).join("") + "</tbody></table>";
  }
  async function mktFetch(path) {
    if (mkt.cache[path]) return mkt.cache[path];
    var d = await getJSON(path);
    mkt.cache[path] = d;
    return d;
  }
  function renderMarketing() {
    state.view = "marketing";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "marketing"); });
    var ym = mktPeriodo();
    if (!state.loja || !ym) { view.innerHTML = '<div class="page-head"><div><h1>🎯 Marketing</h1></div></div><div class="empty">Suba um relatório de vendas primeiro.</div>'; return; }
    view.innerHTML =
      '<div class="page-head"><div><h1>🎯 Marketing Intelligence</h1><div class="sub">' + esc(state.loja) + " · decisões de anúncio a partir de sinais de venda/estoque/margem · camada determinística (a IA não inventa número)</div></div></div>" +
      '<div class="tabs" id="mktTabs">' + MKT_TABS.map(function (t) { return '<button data-mtab="' + t[0] + '"' + (t[0] === mkt.tab ? ' class="active"' : "") + ">" + t[1] + "</button>"; }).join("") + "</div>" +
      '<div id="mktBody"><div class="empty">Carregando…</div></div>';
    view.querySelectorAll("[data-mtab]").forEach(function (b) {
      b.addEventListener("click", function () { mkt.tab = b.getAttribute("data-mtab"); renderMarketing(); });
    });
    mktBody(ym);
  }
  async function mktBody(ym) {
    var host = view.querySelector("#mktBody");
    var L = encodeURIComponent(state.loja);
    try {
      if (mkt.tab === "produtos" || mkt.tab === "recomendados") {
        var url = mkt.tab === "recomendados" ? "/api/marketing/" + L + "/" + ym + "/recommended-products" : "/api/marketing/" + L + "/" + ym + "/produtos?limite=150";
        var d = await mktFetch(url);
        host.innerHTML = feedsAviso(d) + '<div class="card">' + prodTable(d.produtos) + "</div>";
      } else if (mkt.tab === "nao-anunciar") {
        var d = await mktFetch("/api/marketing/" + L + "/" + ym + "/do-not-promote");
        host.innerHTML = feedsAviso(d) + '<div class="card">' + (d.produtos.length ? d.produtos.map(function (p) {
          return '<div class="dnp-item" style="padding:10px 0;border-bottom:1px solid var(--line)"><b>' + esc(p.descricao) + "</b> " + classeChip(p.classe) +
            "<ul style=\"margin:6px 0 0 18px\">" + p.do_not_promote.motivos.map(function (m) { return "<li>" + esc(m.texto) + ' <span class="cs">(' + esc(m.evidencia.campo) + " · " + esc(m.evidencia.periodo) + ")</span></li>"; }).join("") + "</ul>" +
            (p.do_not_promote.substituto ? '<div class="cs" style="margin-top:4px">↳ usar no lugar: <b>' + esc(p.do_not_promote.substituto.descricao) + "</b> (opportunity " + p.do_not_promote.substituto.opportunity_score + ")</div>" : "") + "</div>";
        }).join("") : '<div class="empty">Nenhum produto bloqueado neste período — nada com risco de ruptura ou margem negativa detectável com os feeds atuais.</div>') + "</div>";
      } else if (mkt.tab === "estoque-parado") {
        var d = await mktFetch("/api/marketing/" + L + "/" + ym + "/stagnant-stock");
        var proxy = d.modo === "sem_giro_proxy";
        host.innerHTML = feedsAviso(d) +
          (proxy ? '<div class="result" style="margin-bottom:12px">Sem feed de estoque: mostrando <b>produtos sem giro</b> (nenhuma venda há 45+ dias) como proxy.</div>' : "") +
          '<div class="card">' + (d.produtos.length ? '<table class="tbl"><thead><tr><th>Produto</th><th>Categoria</th>' + (proxy ? "<th>Sem venda há</th>" : '<th class="num">Cobertura</th><th class="num">Capital parado</th>') + "</tr></thead><tbody>" +
            d.produtos.map(function (p) {
              return "<tr><td>" + esc(p.descricao) + "</td><td>" + esc(p.categoria) + "</td>" +
                (proxy ? "<td>" + p.dias_sem_venda + "d</td>" : '<td class="num">' + (p.cobertura_infinita ? "∞" : p.dias_cobertura + "d") + '</td><td class="num">' + (p.capital_parado == null ? "—" : "R$ " + brl(p.capital_parado)) + "</td>") + "</tr>";
            }).join("") + "</tbody></table>" : '<div class="empty">Nada parado detectável.</div>') + "</div>";
      } else if (mkt.tab === "cestas") {
        var b = await mktFetch("/api/marketing/" + L + "/" + ym + "/baskets");
        var c = await mktFetch("/api/marketing/" + L + "/" + ym + "/combos");
        host.innerHTML =
          (b.erro ? '<div class="result err" style="margin-bottom:12px">' + esc(b.erro) + "</div>" : '<div class="cs" style="margin-bottom:10px">Janela ' + esc(b.janela.inicio) + " a " + esc(b.janela.fim) + " · " + int(b.total_cupons) + " cupons · " + b.pares.length + " pares acima do corte de ruído</div>") +
          '<div class="card"><div class="chead"><div class="ci gold">🧺</div><div><h3>Pares (support / confidence / lift)</h3></div></div>' +
          ((b.pares && b.pares.length) ? '<table class="tbl"><thead><tr><th>A</th><th>B</th><th class="num">Cupons A+B</th><th class="num">Support</th><th class="num">Confidence</th><th class="num">Lift</th></tr></thead><tbody>' +
            b.pares.map(function (p) { return "<tr><td>" + esc(p.desc_a) + "</td><td>" + esc(p.desc_b) + '</td><td class="num">' + p.cupons_ab + '</td><td class="num">' + (p.support * 100).toFixed(2) + '%</td><td class="num">' + (p.confidence * 100).toFixed(1) + '%</td><td class="num"><b>' + p.lift + "×</b></td></tr>"; }).join("") + "</tbody></table>" : '<div class="empty">Sem pares acima do corte ainda (precisa de mais histórico).</div>') + "</div>" +
          '<div class="card" style="margin-top:14px"><div class="chead"><div class="ci red">🔗</div><div><h3>Combos sugeridos</h3><div class="cs">par de cesta + retrato de marketing de cada perna</div></div></div>' +
          ((c.combos && c.combos.length) ? c.combos.slice(0, 20).map(function (co) {
            return '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>' + esc(co.produto_a.descricao) + "</b> + <b>" + esc(co.produto_b.descricao) + "</b> " +
              '<span class="tag">lift ' + co.lift + "×</span> " +
              '<span class="cs">âncora: ' + (co.papel.ancora === "A" ? esc(co.produto_a.descricao) : esc(co.produto_b.descricao)) + "</span>" +
              (co.alertas && co.alertas.length ? '<div class="cs" style="color:#b23">' + co.alertas.map(esc).join(" · ") + "</div>" : "") + "</div>";
          }).join("") : '<div class="empty">' + esc(c.nota || "Sem combos.") + "</div>") + "</div>";
      } else if (mkt.tab === "eficiencia") {
        var d = await mktFetch("/api/marketing/" + L + "/campaign-efficiency");
        host.innerHTML = '<div class="card">' + d.campanhas.map(function (e) {
          if (e.erro) return '<div class="empty">' + esc(e.erro) + "</div>";
          var vc = { EXCELENTE: "var(--s1)", BOA: "var(--s3)", ACEITAVEL: "var(--s5)", FRACA: "var(--muted)", DESTRUTIVA: "#d81f2a", INCONCLUSIVO: "var(--ink-2)" };
          return '<div style="padding:12px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(e.campanha) + '</b><span class="tag" style="background:' + (vc[e.veredito] || "#ccc") + ';color:#fff">' + e.veredito + "</span></div>" +
            '<div class="cs">' + esc((e.categorias || []).join(", ")) + " · janela " + esc(e.janela.inicio) + "→" + esc(e.janela.fim) + " · amostra " + (e.amostra.suficiente ? "ok" : "curta") + "</div>" +
            '<div class="cx-metrs" style="margin-top:6px">' +
            '<div class="cx-m"><span>DEMAND_LIFT receita</span><b>' + (e.metricas.DEMAND_LIFT_receita == null ? "—" : e.metricas.DEMAND_LIFT_receita + "×") + "</b></div>" +
            '<div class="cx-m"><span>Receita média dia campanha</span><b>R$ ' + brl(e.metricas.receita_media_dia_campanha) + "</b></div>" +
            '<div class="cx-m"><span>Receita média dia normal</span><b>R$ ' + brl(e.metricas.receita_media_dia_fora) + "</b></div>" +
            '<div class="cx-m"><span>EFFICIENCY_SCORE</span><b>' + (e.metricas.EFFICIENCY_SCORE == null ? "—" : e.metricas.EFFICIENCY_SCORE) + "</b></div>" +
            "</div>" +
            (e.dados_ausentes.length ? '<div class="cs" style="margin-top:4px">sem: ' + e.dados_ausentes.map(esc).join("; ") + "</div>" : "") +
            '<div class="cs" style="margin-top:4px">' + esc(e.aviso) + "</div></div>";
        }).join("") + "</div>";
      } else if (mkt.tab === "builder") {
        host.innerHTML = renderBuilderForm();
        wireBuilder(ym);
      } else if (mkt.tab === "simulador") {
        host.innerHTML = renderSimForm();
        wireSim();
      }
    } catch (e) {
      host.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
    }
  }
  function renderBuilderForm() {
    var cats = ["Fraldas", "Leite Infantil", "Limpeza"];
    return '<div class="card form-card"><form id="cbForm"><fieldset><legend>Parâmetros</legend><div class="rowf">' +
      '<div><label class="f">Objetivo</label><select class="inp" name="objetivo">' +
      ["GIRAR_ESTOQUE", "AUMENTAR_TICKET", "DEFENDER_CONCORRENCIA", "CONVERSAO", "LANCAMENTO"].map(function (o) { return "<option>" + o + "</option>"; }).join("") + "</select></div>" +
      '<div><label class="f">Categorias (vírgula, opcional)</label><input class="inp" name="categorias" placeholder="' + cats.join(", ") + '"></div>' +
      '</div></fieldset><button class="btn" type="submit">Montar elenco</button></form><div id="cbOut" style="margin-top:14px"></div></div>';
  }
  function wireBuilder(ym) {
    view.querySelector("#cbForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target, out = view.querySelector("#cbOut");
      out.innerHTML = '<div class="empty">Montando…</div>';
      var qs = "objetivo=" + encodeURIComponent(f.objetivo.value);
      if (f.categorias.value.trim()) qs += "&categorias=" + encodeURIComponent(f.categorias.value.trim());
      try {
        var d = await getJSON("/api/marketing/" + encodeURIComponent(state.loja) + "/" + ym + "/campaign-builder?" + qs);
        out.innerHTML = feedsAviso(d) + ["CHAMARIZ", "HERO", "MARGEM", "GIRO", "COMPLEMENTAR", "DEFESA"].map(function (papel) {
          var itens = d.elenco[papel] || [];
          return '<div class="card" style="margin-bottom:10px"><div class="chead"><div class="ci red">' + papel[0] + '</div><div><h3>' + papel + " <span class=\"cs\">(" + itens.length + ")</span></h3></div></div>" +
            (itens.length ? '<table class="tbl"><tbody>' + itens.map(function (it) {
              return "<tr><td>" + esc(it.descricao) + (it.proxy ? ' <span class="tag">proxy</span>' : "") + '</td><td class="cs">' + esc(it.motivo) + '</td><td class="num">' + scoreBar(it.opportunity) + "</td></tr>";
            }).join("") + "</tbody></table>" : '<div class="cs">— sem candidato (feed faltando ou categoria sem produto)</div>') + "</div>";
        }).join("") +
          (d.evitar.length ? '<div class="card"><div class="chead"><div class="ci gold">🚫</div><div><h3>NÃO anunciar (' + d.evitar.length + ")</h3></div></div><ul style=\"margin:0 0 0 18px\">" + d.evitar.slice(0, 15).map(function (e) { return "<li>" + esc(e.descricao) + ' <span class="cs">' + esc(e.motivos.join("; ")) + "</span></li>"; }).join("") + "</ul></div>" : "") +
          '<div class="card" style="margin-top:10px"><div class="chead"><div class="ci">📋</div><div><h3>Briefing</h3></div></div><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;margin:0">' + esc(d.briefing) + "</pre></div>";
      } catch (e) { out.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>"; }
    });
  }
  function renderSimForm() {
    return '<div class="card form-card"><form id="simForm"><fieldset><legend>Produto e oferta</legend><div class="rowf">' +
      '<div><label class="f">EAN</label><input class="inp" name="ean" placeholder="7891..." required></div>' +
      '<div><label class="f">Preço atual (R$)</label><input class="inp" name="preco_atual" type="number" step="0.01" required></div>' +
      '<div><label class="f">Preço promocional (R$)</label><input class="inp" name="preco_promocional" type="number" step="0.01" required></div>' +
      '</div><div class="rowf"><div><label class="f">Custo atual (R$, opcional)</label><input class="inp" name="custo_atual" type="number" step="0.01"></div>' +
      '<div><label class="f">Estoque atual (opcional)</label><input class="inp" name="estoque_atual" type="number" step="1"></div>' +
      '<div><label class="f">Duração (dias)</label><input class="inp" name="duracao_dias" type="number" value="4"></div>' +
      '</div></fieldset><button class="btn" type="submit">Simular</button></form><div id="simOut" style="margin-top:14px"></div></div>';
  }
  function wireSim() {
    view.querySelector("#simForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target, out = view.querySelector("#simOut");
      out.innerHTML = '<div class="empty">Simulando…</div>';
      var body = {};
      ["ean", "preco_atual", "preco_promocional", "custo_atual", "estoque_atual", "duracao_dias"].forEach(function (k) {
        var v = f[k].value.trim(); if (v) body[k] = k === "ean" ? v : Number(v);
      });
      try {
        var r = await fetch("/api/marketing/" + encodeURIComponent(state.loja) + "/offer-simulator", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        var d = await r.json();
        if (!r.ok) throw new Error(d.erro || ("HTTP " + r.status));
        out.innerHTML =
          '<div class="card"><div class="cs">' + esc(d.descricao || d.ean) + " · desconto <b>" + d.desconto_pct + "%</b> · âncora dos cenários: " + esc(d.ancora_cenarios.fonte) + "</div>" +
          '<table class="tbl" style="margin-top:8px"><thead><tr><th>Cenário</th><th class="num">×demanda</th><th class="num">Unid. proj.</th><th class="num">Receita proj.</th><th class="num">Δ margem vs sem promo</th><th>Risco ruptura</th></tr></thead><tbody>' +
          d.cenarios.map(function (c) {
            return "<tr><td><b>" + c.cenario + '</b></td><td class="num">' + c.multiplicador_demanda + '×</td><td class="num">' + int(c.unidades_projetadas) + '</td><td class="num">R$ ' + brl(c.receita_projetada) + '</td><td class="num">' + (c.variacao_margem_vs_sem_promo == null ? "—" : "R$ " + brl(c.variacao_margem_vs_sem_promo)) + "</td><td>" + c.risco_ruptura + "</td></tr>";
          }).join("") + "</tbody></table>" +
          (d.dados_ausentes && d.dados_ausentes.length ? '<div class="cs" style="margin-top:6px">sem: ' + d.dados_ausentes.map(esc).join("; ") + "</div>" : "") +
          '<div class="result" style="margin-top:10px;background:#fff6e6;border-color:#f0c98a;color:#8a5a00">' + esc(d.aviso) + "</div></div>";
      } catch (e) { out.innerHTML = '<div class="result err">' + esc(e.message) + "</div>"; }
    });
  }

  // ---------- Intelligence (Fases 5–12) ----------
  var itl = { tab: "warroom", cache: {} };
  var ITL_TABS = [
    ["warroom", "War Room"], ["recomendacoes", "Recomendações"], ["sinais", "Sinais"], ["investigacoes", "Investigações"],
    ["decisoes", "Decisões"], ["padroes", "Padrões"], ["pauta", "Pauta 7 dias"], ["perguntar", "Perguntar"],
  ];
  function itlGet(url, noCache) {
    if (!noCache && itl.cache[url]) return Promise.resolve(itl.cache[url]);
    return getJSON(url).then(function (d) { itl.cache[url] = d; return d; });
  }
  function sevPill(s) {
    var cls = s.classe === "AMEACA" ? "thr" : s.classe === "OPORTUNIDADE" ? "opp" : s.classe === "CONTRADICAO" ? "con" : "sig";
    return '<span class="itl-badge ' + cls + '">' + esc(s.codigo || s.classe) + "</span>";
  }
  function sinalCard(s) {
    return '<div class="itl-sig" data-sig="' + s.id + '">' +
      '<div class="itl-sig-h">' + sevPill(s) + '<b>' + esc(s.titulo) + "</b><span class=\"itl-prio\">P" + Math.round(s.prioridade) + "</span></div>" +
      (s.resumo ? '<div class="itl-sig-r">' + esc(s.resumo) + "</div>" : "") +
      '<div class="itl-sig-m">sev ' + (s.severidade != null ? s.severidade.toFixed(2) : "—") + " · conf " + (s.confianca != null ? s.confianca.toFixed(2) : "—") +
      (s.impacto_estimado ? " · ~R$ " + int(s.impacto_estimado) + "/mês" : "") + " · " + esc(s.status) + "</div>" +
      '<div class="itl-sig-a"><button data-act="why" data-id="' + s.id + '">Por quê?</button>' +
      '<button data-act="obs" data-id="' + s.id + '">Observando</button>' +
      '<button data-act="res" data-id="' + s.id + '">Resolver</button>' +
      '<button data-act="dec" data-id="' + s.id + '">Virar decisão</button></div>' +
      '<div class="itl-why" id="why-' + s.id + '" hidden></div></div>';
  }
  function renderIntelligence() {
    state.view = "intelligence";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "intelligence"); });
    if (!state.loja) { view.innerHTML = '<div class="empty">Escolha uma loja.</div>'; return; }
    view.innerHTML =
      '<div class="page-head"><div><h1>🧠 Intelligence</h1><div class="sub">' + esc(state.loja) + " · sinais, ameaças, oportunidades e decisões — tudo com evidência e prioridade. A IA só narra o que o backend calculou.</div></div>" +
      '<button class="btn" id="itlDetect">↻ Rodar detecção</button></div>' +
      '<div class="tabs" id="itlTabs">' + ITL_TABS.map(function (t) { return '<button data-itab="' + t[0] + '"' + (t[0] === itl.tab ? ' class="active"' : "") + ">" + t[1] + "</button>"; }).join("") + "</div>" +
      '<div id="itlBody"><div class="empty">Carregando…</div></div>';
    view.querySelector("#itlDetect").addEventListener("click", function () {
      var b = this; b.disabled = true; b.textContent = "Rodando…";
      fetch("/api/intelligence/" + encodeURIComponent(state.loja) + "/detect", { method: "POST" }).then(function (r) { return r.json(); }).then(function () {
        itl.cache = {}; renderIntelligence();
      }).finally(function () { b.disabled = false; b.textContent = "↻ Rodar detecção"; });
    });
    view.querySelectorAll("[data-itab]").forEach(function (b) { b.addEventListener("click", function () { itl.tab = b.getAttribute("data-itab"); renderIntelligence(); }); });
    itlBody();
  }
  async function itlBody() {
    var host = view.querySelector("#itlBody");
    var L = encodeURIComponent(state.loja);
    try {
      if (itl.tab === "warroom") {
        var w = await itlGet("/api/intelligence/" + L + "/war-room", true);
        host.innerHTML = warRoomHtml(w);
        wireSigActions(host);
        wireRecs(host, L);
      } else if (itl.tab === "recomendacoes") {
        var d = await itlGet("/api/intelligence/" + L + "/recommendations", true);
        host.innerHTML = recsHtml(d, true);
        wireRecs(host, L);
      } else if (itl.tab === "sinais") {
        var arr = await itlGet("/api/intelligence/" + L + "/signals?limite=200", true);
        host.innerHTML = arr.length ? '<div class="itl-grid">' + arr.map(sinalCard).join("") + "</div>" : '<div class="empty">Nenhum sinal. Rode a detecção.</div>';
        wireSigActions(host);
      } else if (itl.tab === "investigacoes") {
        var arr = await itlGet("/api/intelligence/" + L + "/investigations", true);
        host.innerHTML = '<div class="card">' + (arr.length ? '<table class="tbl"><thead><tr><th>#</th><th>Pergunta</th><th>Conclusão</th><th class="num">Conf</th><th>Hip.</th></tr></thead><tbody>' +
          arr.map(function (i) { return "<tr><td>" + i.codigo + "</td><td>" + esc(i.pergunta) + "</td><td>" + esc(i.conclusao || "—") + '</td><td class="num">' + (i.confianca == null ? "—" : i.confianca) + "</td><td>" + i.n_hip + "</td></tr>"; }).join("") + "</tbody></table>" : '<div class="empty">Nenhuma investigação ainda — use "Por quê?" num sinal.</div>') + "</div>";
      } else if (itl.tab === "decisoes") {
        host.innerHTML = await decisoesHtml(L);
        wireDecisoes(host, L);
      } else if (itl.tab === "padroes") {
        var arr = await itlGet("/api/intelligence/" + L + "/patterns", true);
        host.innerHTML = '<div class="card"><div class="cs" style="margin-bottom:8px">O que costuma funcionar — aprendido das decisões que tiveram resultado medido.</div>' +
          (arr.length ? '<table class="tbl"><thead><tr><th>Padrão</th><th class="num">Amostra</th><th>Leitura</th></tr></thead><tbody>' +
            arr.map(function (p) { return "<tr><td>" + esc(p.chave) + '</td><td class="num">' + p.amostra_n + "</td><td>" + esc(p.leitura) + "</td></tr>"; }).join("") + "</tbody></table>" : '<div class="empty">Sem padrões ainda — registre decisões e seus resultados.</div>') + "</div>";
      } else if (itl.tab === "pauta") {
        var p = await itlGet("/api/intelligence/" + L + "/editorial-plan", true);
        host.innerHTML = pautaHtml(p);
      } else if (itl.tab === "perguntar") {
        host.innerHTML = perguntarForm();
        wirePerguntar(L);
      }
    } catch (e) {
      host.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
    }
  }
  var REC_ICO = { DEFENDER_CATEGORIA: "🛡️", CAMPANHA_SEM_ESTOQUE: "⛽", APROVEITAR_ALTA: "📈", DESOVAR_COMBO: "🔗", REVISAR_DADO: "⚠️", SINAL_ISOLADO: "•" };
  function recCard(r, aberto) {
    return '<div class="rec" data-rec="' + esc(r.codigo) + '">' +
      '<div class="rec-h"><span class="rec-ico">' + (REC_ICO[r.tipo] || "•") + '</span><b>' + esc(r.titulo) + '</b><span class="rec-p">P' + Math.round(r.prioridade) + "</span></div>" +
      '<div class="rec-acao">👉 ' + esc(r.acao) + "</div>" +
      '<div class="rec-efeito">' + esc(r.efeito_esperado || "") + '</div>' +
      '<div class="rec-meta">' + esc(r.codigo) + " · conf " + (r.confianca != null ? r.confianca.toFixed(2) : "—") +
        " · sinais " + (r.sinais_codigos || []).join(", ") + "</div>" +
      (aberto && r.evidencias && r.evidencias.length
        ? '<ul class="rec-ev">' + r.evidencias.map(function (e) { return "<li><b>" + esc(e.campo) + ":</b> " + esc(String(e.valor)) + (e.fonte ? ' <span class="cs">(' + esc(e.fonte) + ")</span>" : "") + "</li>"; }).join("") + "</ul>"
        : "") +
      '<div class="rec-a"><button data-rec-act="decidir" data-rec="' + esc(r.codigo) + '">Registrar como decisão</button></div>' +
      "</div>";
  }
  function recsHtml(d, aberto) {
    if (!d || d.erro) return '<div class="empty">' + esc((d && d.erro) || "sem recomendações") + "</div>";
    var recs = d.recomendacoes || [];
    if (!recs.length) return '<div class="empty">Sem recomendações agora — nenhuma combinação de sinais pede ação. Rode a detecção se acabou de subir dados.</div>';
    RECS_CACHE = {}; recs.forEach(function (r) { RECS_CACHE[r.codigo] = r; });
    return '<div class="cs" style="margin-bottom:10px">Decisões propostas cruzando os sinais abertos entre si (modelo Palantir) — cada uma traz a ação, o efeito esperado e a cadeia de evidências.</div>' +
      recs.map(function (r) { return recCard(r, aberto); }).join("");
  }
  var RECS_CACHE = {};
  function wireRecs(host, L) {
    host.querySelectorAll('[data-rec-act="decidir"]').forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = RECS_CACHE[b.getAttribute("data-rec")];
        if (!r) return;
        var titulo = prompt("Título da decisão:", r.titulo);
        if (!titulo) return;
        var tipoMap = { DEFENDER_CATEGORIA: "CAMPANHA", CAMPANHA_SEM_ESTOQUE: "ESTOQUE", APROVEITAR_ALTA: "EDITORIAL", DESOVAR_COMBO: "CAMPANHA", REVISAR_DADO: "OUTRO", SINAL_ISOLADO: "OUTRO" };
        try {
          await fetch("/api/intelligence/" + L + "/decisions", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ titulo: titulo, tipo: tipoMap[r.tipo] || "OUTRO", contexto: r.acao + "\n\nEfeito esperado: " + r.efeito_esperado, sinais: r.sinais || [], acoes: [{ texto: r.acao }] }),
          });
          itl.tab = "decisoes"; itl.cache = {}; renderIntelligence();
        } catch (e) { alert("Falhou: " + e.message); }
      });
    });
  }
  function warRoomHtml(w) {
    if (w.erro) return '<div class="empty">' + esc(w.erro) + "</div>";
    var k = w.kpis;
    var p1 = w.prioridade_1;
    return '<div class="warroom">' +
      '<div class="wr-top">' +
        '<div class="wr-kpi"><span>Faturamento do mês</span><b>' + (k.faturamento_mes == null ? "—" : "R$ " + brl(k.faturamento_mes)) + "</b>" + (k.var_faturamento_pct == null ? "" : '<i class="' + (k.var_faturamento_pct >= 0 ? "up" : "down") + '">' + (k.var_faturamento_pct >= 0 ? "▲" : "▼") + " " + Math.abs(k.var_faturamento_pct) + "%</i>") + "</div>" +
        '<div class="wr-kpi"><span>Sinais abertos</span><b>' + k.sinais_abertos + "</b></div>" +
        '<div class="wr-kpi thr"><span>Ameaças</span><b>' + k.ameacas_abertas + "</b></div>" +
        '<div class="wr-kpi opp"><span>Oportunidades</span><b>' + k.oportunidades_abertas + "</b></div>" +
      "</div>" +
      (p1 ? '<div class="wr-p1"><div class="wr-p1-tag">PRIORIDADE #1 · ' + esc(p1.codigo) + ' · P' + Math.round(p1.prioridade) + '</div><div class="wr-p1-t">' + esc(p1.titulo) + "</div><div class=\"wr-p1-r\">" + esc(p1.resumo || "") + '</div><button class="wr-btn" data-act="why" data-id="' + p1.id + '">Por quê?</button> <button class="wr-btn" data-act="dec" data-id="' + p1.id + '">Virar decisão</button><div class="itl-why" id="why-' + p1.id + '" hidden></div></div>' : '<div class="wr-p1 calm">Sem prioridade urgente. Operação dentro do esperado.</div>') +
      ((w.recomendacoes && w.recomendacoes.length) ? '<div class="wr-recs"><h3>🎯 Decisões recomendadas (sinais cruzados)</h3>' + recsHtml({ recomendacoes: w.recomendacoes.slice(0, 5) }, false) + '</div>' : "") +
      '<div class="wr-cols">' +
        '<div class="wr-col"><h3>🔴 Threat Map</h3>' + (w.threat_map.length ? w.threat_map.map(miniSig).join("") : '<div class="wr-empty">nada</div>') + "</div>" +
        '<div class="wr-col"><h3>🟢 Opportunity Map</h3>' + (w.opportunity_map.length ? w.opportunity_map.map(miniSig).join("") : '<div class="wr-empty">nada</div>') + "</div>" +
      "</div>" +
      (w.contradicoes.length ? '<div class="wr-col wr-con"><h3>⚠ Contradições</h3>' + w.contradicoes.map(miniSig).join("") + "</div>" : "") +
      '<div class="wr-cat"><h3>Situação por categoria</h3><table class="wr-tbl"><thead><tr><th>Categoria</th><th>Receita 30d</th><th>2 semanas</th><th>Estado</th></tr></thead><tbody>' +
        w.situacao_categorias.map(function (c) { return "<tr><td>" + esc(c.categoria) + (c.sob_pressao ? ' <span class="wr-flag">concorrência</span>' : "") + "</td><td>R$ " + brl(c.receita_30d) + "</td><td>" + (c.var_pct == null ? "—" : (c.var_pct > 0 ? "+" : "") + c.var_pct + "%") + '</td><td class="st-' + c.estado.replace(/[^A-Z]/gi, "") + '">' + esc(c.estado) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +
      '<div class="wr-foot">gerado ' + new Date(w.gerado_em).toLocaleString("pt-BR") + (w.feeds && (!w.feeds.estoque || !w.feeds.custo) ? " · sem feed de " + [!w.feeds.estoque && "estoque", !w.feeds.custo && "custo"].filter(Boolean).join("/") + " — sinais dependentes ficam limitados" : "") + "</div>" +
      "</div>";
  }
  function miniSig(s) {
    return '<div class="wr-sig" data-sig="' + s.id + '"><span class="wr-prio">P' + Math.round(s.prioridade) + "</span> " + esc(s.titulo) +
      ' <button class="wr-x" data-act="why" data-id="' + s.id + '">?</button><div class="itl-why" id="why-' + s.id + '" hidden></div></div>';
  }
  function wireSigActions(host) {
    host.addEventListener("click", async function (ev) {
      var b = ev.target.closest("[data-act]");
      if (!b) return;
      var id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
      var L = encodeURIComponent(state.loja);
      if (act === "why") {
        var box = host.querySelector("#why-" + id);
        if (box.hidden) {
          box.hidden = false; box.innerHTML = "investigando…";
          try {
            var r = await fetch("/api/intelligence/" + L + "/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sinalId: +id, gravar: true }) }).then(function (x) { return x.json(); });
            box.innerHTML = '<div class="itl-why-c"><b>' + esc(r.conclusao || "") + '</b> <span class="cs">(conf ' + (r.confianca || 0) + ")</span></div>" +
              "<ul>" + (r.hipoteses || []).map(function (h) { return '<li><span class="hv ' + esc(h.veredito) + '">' + esc(h.veredito) + "</span> " + esc(h.texto) + "</li>"; }).join("") + "</ul>";
          } catch (e) { box.innerHTML = '<span class="cs">' + esc(e.message) + "</span>"; }
        } else box.hidden = true;
      } else if (act === "obs" || act === "res") {
        await fetch("/api/intelligence/" + L + "/signals/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: act === "obs" ? "observando" : "resolvido" }) });
        itl.cache = {}; renderIntelligence();
      } else if (act === "dec") {
        var titulo = prompt("Título da decisão:", "");
        if (!titulo) return;
        await fetch("/api/intelligence/" + L + "/decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ titulo: titulo, tipo: "OUTRO", sinais: [+id] }) });
        itl.tab = "decisoes"; itl.cache = {}; renderIntelligence();
      }
    });
  }
  async function decisoesHtml(L) {
    var arr = await itlGet("/api/intelligence/" + L + "/decisions", true);
    return '<div class="card"><div class="chead"><div class="ci red">D</div><div><h3>Memória de decisão</h3><div class="cs">o que foi decidido, por quê, e o que deu</div></div></div>' +
      (arr.length ? arr.map(function (d) {
        return '<div class="itl-dec" data-dec="' + d.id + '"><div><b>' + d.codigo + " · " + esc(d.titulo) + '</b> <span class="cs">' + esc(d.tipo || "") + " · " + new Date(d.decidido_em).toLocaleDateString("pt-BR") + " · " + d.n_acoes + " ação(ões) · " + d.n_result + " resultado(s)</span></div>" +
          '<button data-act="outcome" data-id="' + d.id + '">+ resultado</button></div>';
      }).join("") : '<div class="empty">Nenhuma decisão registrada — use "Virar decisão" num sinal.</div>') + "</div>";
  }
  function wireDecisoes(host, L) {
    host.addEventListener("click", async function (ev) {
      var b = ev.target.closest('[data-act="outcome"]'); if (!b) return;
      var id = b.getAttribute("data-id");
      var metrica = prompt("Métrica (ex.: itens_por_cupom, faturamento_categoria):", "");
      if (!metrica) return;
      var antes = parseFloat(prompt("Valor ANTES:", "") || "");
      var depois = parseFloat(prompt("Valor DEPOIS:", "") || "");
      var vd = depois > antes ? "POSITIVO" : depois < antes ? "NEGATIVO" : "NEUTRO";
      await fetch("/api/intelligence/" + L + "/decisions/" + id + "/outcomes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metrica: metrica, antes: antes, depois: depois, veredito: vd }) });
      itl.cache = {}; renderIntelligence();
    });
  }
  function pautaHtml(p) {
    if (p.erro) return '<div class="empty">' + esc(p.erro) + "</div>";
    return feedsAviso(p) + '<div class="card"><div class="chead"><div class="ci gold">📅</div><div><h3>Pauta dos próximos 7 dias — ' + esc(state.loja) + '</h3><div class="cs">produto e ângulo saem do motor; CTA é sugestão de template</div></div></div>' +
      p.dias.map(function (d) {
        return '<div class="pauta-dia"><div class="pauta-h"><b>' + d.data + " · " + d.dia_semana + '</b> <span class="chip">' + esc(d.tema) + "</span></div>" +
          '<table class="tbl"><tbody>' + d.produtos.map(function (pr) {
            return "<tr><td><b>" + esc(pr.descricao) + '</b><div class="cs">' + esc(pr.angulo) + '</div></td><td class="cs">' + esc(pr.cta_sugestao) + '</td><td class="num">' + scoreBar(pr.opportunity) + "</td></tr>";
          }).join("") + "</tbody></table></div>";
      }).join("") +
      (p.evitar && p.evitar.length ? '<div class="cs" style="margin-top:8px">Evitar nos posts: ' + p.evitar.map(function (e) { return esc(e.descricao); }).join(", ") + "</div>" : "") +
      '<ul class="cs" style="margin:8px 0 0 18px">' + p.observacoes.map(function (o) { return "<li>" + esc(o) + "</li>"; }).join("") + "</ul></div>";
  }
  function perguntarForm() {
    return '<div class="card form-card"><form id="askForm"><label class="f">Pergunte em português (ex.: "por que fraldas caiu?", "o que anuncio essa semana?", "a campanha de limpeza vale a pena?")</label>' +
      '<input class="inp" name="q" placeholder="sua pergunta" autocomplete="off"><button class="btn" type="submit" style="margin-top:10px">Perguntar</button></form><div id="askOut" style="margin-top:14px"></div></div>';
  }
  function wirePerguntar(L) {
    view.querySelector("#askForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var q = ev.target.q.value.trim(); if (!q) return;
      var out = view.querySelector("#askOut"); out.innerHTML = '<div class="empty">pensando…</div>';
      try {
        var r = await fetch("/api/intelligence/" + L + "/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pergunta: q }) }).then(function (x) { return x.json(); });
        if (r.erro) throw new Error(r.erro);
        out.innerHTML = '<div class="card"><div class="cs">fonte: ' + esc(r.fonte) + " · confiança " + (r.confianca == null ? "—" : r.confianca) + "</div>" +
          '<p style="font-size:15px"><b>' + esc(r.conclusao) + "</b></p>" +
          (r.evidencias && r.evidencias.length ? '<div class="cs">Evidências</div><ul class="cs" style="margin:4px 0 8px 18px">' + r.evidencias.map(function (e) { return "<li>" + esc(e.campo) + ": " + esc(String(e.valor)) + (e.extra ? " (" + esc(e.extra) + ")" : "") + (e.periodo ? ' <i>' + esc(e.periodo) + "</i>" : "") + "</li>"; }).join("") + "</ul>" : "") +
          (r.hipoteses && r.hipoteses.length ? '<div class="cs">Hipóteses</div><ul class="cs" style="margin:4px 0 8px 18px">' + r.hipoteses.map(function (h) { return '<li><span class="hv ' + (h.veredito || "") + '">' + esc(h.veredito || "") + "</span> " + esc(h.texto) + "</li>"; }).join("") + "</ul>" : "") +
          (r.acao_sugerida ? '<div class="cs">Ação: ' + esc(r.acao_sugerida) + "</div>" : "") +
          (r.monitorar ? '<div class="cs">Monitorar: ' + esc(r.monitorar) + "</div>" : "") +
          (r.nota_ia ? '<div class="cs" style="color:var(--warn)">' + esc(r.nota_ia) + "</div>" : "") + "</div>";
      } catch (e) { out.innerHTML = '<div class="result err">' + esc(e.message) + "</div>"; }
    });
  }

  // ---------- nav ----------
  var VIEWS = ["painel", "marketing", "intelligence", "conexoes", "analise", "upload", "historico", "config"];
  function go(v) {
    state.view = v;
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === v); });
    if (v === "painel") { if (state.data) renderPainel(); else loadAnalise(); }
    else if (v === "marketing") { mkt.cache = {}; renderMarketing(); }
    else if (v === "intelligence") { itl.cache = {}; renderIntelligence(); }
    else if (v === "conexoes") renderConexoes();
    else if (v === "analise") renderAnalise();
    else if (v === "upload") renderUpload();
    else if (v === "historico") renderHistorico();
    else if (v === "config") renderConfig();
  }
  function abrirConexoes(focusId) {
    state.conexoesFocus = focusId || null;
    location.hash = "conexoes";
    if (state.view === "conexoes") renderConexoes();
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
      else if (state.view === "conexoes") { renderConexoes(); loadPeriodos(); }
      else if (state.view === "marketing") { mkt.cache = {}; loadPeriodos().then(function () { renderMarketing(); }); }
      else if (state.view === "intelligence") { itl.cache = {}; loadPeriodos().then(function () { renderIntelligence(); }); }
      else loadPeriodos();
    });
    selPeriodo.addEventListener("change", function () {
      state.periodo = selPeriodo.value;
      if (state.view === "conexoes") { state.conexoesFocus = null; renderConexoes(selPeriodo.value); }
      else if (state.view === "marketing") { mkt.cache = {}; renderMarketing(); }
      else if (state.view === "intelligence") { itl.cache = {}; renderIntelligence(); }
      else loadAnalise();
    });
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
