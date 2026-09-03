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
      '<button class="btn" type="submit" id="upGo">Gerar análise</button></form><div id="upRes" class="result" hidden></div></div>' +
      '<div class="card form-card"><form id="fPromo"><fieldset><legend>Tabela de promoções (o "tabelão" / encarte)</legend>' +
      '<div class="hint">Planilha (xlsx ou csv) com os produtos que vão entrar em oferta e o preço. Colunas: produto (ou EAN), preço de / preço por (ou desconto), início, fim, campanha, loja. Não precisa loja/mês aqui — o sistema descobre pelo arquivo. Alimenta o Share of Promotions e o Calendário.</div>' +
      '<input type="file" name="promo" accept=".xlsx,.csv" required></fieldset>' +
      '<button class="btn" type="submit">Enviar tabela de promoções</button></form><div id="promoRes" class="result" hidden></div></div>';
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
    view.querySelector("#fPromo").addEventListener("submit", promoSubmit);
  }
  async function promoSubmit(ev) {
    ev.preventDefault();
    var f = ev.target, btn = f.querySelector("button"), box = view.querySelector("#promoRes");
    if (!f.promo.files[0]) return;
    btn.disabled = true; btn.textContent = "Enviando…"; box.hidden = true;
    var fd = new FormData(); fd.append("arquivo", f.promo.files[0]);
    try {
      var r = await fetch("/upload/promocoes", { method: "POST", body: fd });
      var d = await r.json();
      if (!r.ok) throw new Error(d.erro || ("HTTP " + r.status));
      var p = d.promocoes || {};
      box.className = "result ok";
      box.textContent = "OK — " + (p.linhas || 0) + " linha(s) lidas, " + (p.casados_no_catalogo || 0) + " casadas com o catálogo (EAN/nome)." +
        (p.resumo ? "\nLojas: " + (p.resumo.lojas || []).join(", ") + " · com prazo: " + p.resumo.com_prazo + (p.resumo.sem_preco_ignoradas ? " · " + p.resumo.sem_preco_ignoradas + " sem preço/desconto (ignoradas)" : "") : "") +
        "\nVê em Concorrentes → Share of Promotions.";
      box.hidden = false;
    } catch (e) {
      box.className = "result err"; box.textContent = e.message; box.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Enviar tabela de promoções";
    }
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

  function dqSevCor(s) { return s === "ALTO" ? "var(--down)" : s === "MEDIO" ? "#c98a00" : "var(--ink-2)"; }
  function dataQualidadeHtml(d) {
    if (!d || d.erro) return "";
    var c = d.score >= 85 ? "var(--s1)" : d.score >= 60 ? "var(--s3)" : "var(--down)";
    var fresh = Object.keys(d.freshness).map(function (k) {
      var v = d.freshness[k];
      var atras = v.dias == null ? "" : v.dias > 20 ? ' <span class="tag bad">' + v.dias + "d</span>" : " " + v.dias + "d";
      return "<tr><td>" + k + "</td><td>" + (v.ultima || '<span class="cs">nunca</span>') + atras + "</td></tr>";
    }).join("");
    return '<div class="card" style="margin-bottom:16px"><div class="chead"><div class="ci red">🩺</div><div><h3>Qualidade dos dados — ' + esc(d.loja) + '</h3>' +
      '<div class="cs">o que dá para melhorar na origem (ERP/planilha) — conserta todas as telas de uma vez</div></div>' +
      '<div class="dq-score" style="background:' + c + '">' + d.score + '<small>/100</small></div></div>' +
      '<div class="cs" style="margin:2px 0 10px"><b>' + esc(d.veredito) + '</b> · ' + d.por_severidade.ALTO + " alto · " + d.por_severidade.MEDIO + " médio · " + d.por_severidade.BAIXO + " baixo</div>" +
      (d.problemas.length ? d.problemas.map(function (p) {
        return '<div class="dq-prob"><div class="dq-prob-h"><span class="tag" style="background:' + dqSevCor(p.severidade) + ';color:#fff">' + p.severidade + "</span> <b>" + esc(p.titulo) + '</b> <span class="cs">· ' + int(p.n) + "</span></div>" +
          '<div class="cs">' + esc(p.detalhe) + "</div>" +
          (p.exemplos && p.exemplos.length ? '<div class="cs" style="margin-top:2px">ex.: ' + p.exemplos.map(function (e) { return esc(Object.values(e).join(" · ")); }).join(" | ") + "</div>" : "") +
          '<div class="dq-fix">→ ' + esc(p.como_corrigir) + "</div></div>";
      }).join("") : '<div class="empty">Sem problemas detectáveis. 👌</div>') +
      '<div class="cs" style="margin:10px 0 4px;font-weight:600">Atualização dos feeds</div>' +
      '<table class="tbl"><tbody>' + fresh + "</tbody></table>" +
      '<div class="cs" style="margin-top:6px">' + esc(d.aviso) + "</div></div>";
  }
  async function renderConfig() {
    view.innerHTML = '<div class="page-head"><div><h1>⚙️ Configurações</h1><div class="sub">Somente leitura aqui. Edite os arquivos em <b>config/</b> e o site recarrega.</div></div></div><div id="cc"><div class="empty">Carregando…</div></div>';
    var log = await getJSON("/api/ingest-log");
    var dq = null;
    try { dq = await getJSON("/api/data-quality/" + encodeURIComponent(state.loja)); } catch (e) {}
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
      dataQualidadeHtml(dq) +
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
  var mkt = { tab: "resultado", cache: {} };
  var MKT_TABS = [
    ["resultado", "Resultado"], ["produtos", "Produtos"], ["recomendados", "Recomendados"], ["nao-anunciar", "Não anunciar"],
    ["estoque-parado", "Estoque parado"], ["cestas", "Cestas & Combos"], ["eficiencia", "Eficiência"], ["medicao", "Medição"],
    ["precificacao", "Precificação"],
    ["abc", "Curva ABC"], ["playbooks", "Playbooks"], ["calendario", "Calendário"], ["builder", "Montar campanha"], ["simulador", "Simulador de oferta"],
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
      '<td data-l="Classe">' + classeChip(p.classe) + "</td>" +
      '<td class="num" data-l="Un 30d">' + int(p.unidades[30]) + "</td>" +
      '<td class="num" data-l="Receita 30d">R$ ' + brl(p.receita.d30) + "</td>" +
      '<td data-l="Tendência">' + tendChip(p.tendencia) + "</td>" +
      '<td data-l="Cobertura">' + (p.cobertura_rotulo === "SEM_ESTOQUE" ? '<span class="cs">s/ feed</span>' : '<span class="tag">' + (p.cobertura_infinita ? "∞" : p.dias_cobertura + "d") + " · " + p.cobertura_rotulo + "</span>") + "</td>" +
      '<td data-l="Margem">' + (p.margem_pct == null ? '<span class="cs">s/ custo</span>' : pct(p.margem_pct * 100)) + "</td>" +
      '<td data-l="Opportunity">' + scoreBar(p.opportunity.score) + ' <span class="cs">conf ' + p.opportunity.confianca + "</span></td></tr>";
  }
  function prodTable(items, cols) {
    if (!items || !items.length) return '<div class="empty">Nada aqui neste período.</div>';
    return '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th>Classe</th><th class="num">Un 30d</th><th class="num">Receita 30d</th><th>Tendência</th><th>Cobertura</th><th>Margem</th><th>Opportunity</th></tr></thead><tbody>' +
      items.map(prodRow).join("") + "</tbody></table>";
  }
  var QUAD = {
    VACA_LEITEIRA: ["🐄", "Vaca leiteira", "sai bem + dá lucro"],
    ISCA_CARA: ["🎣", "Isca cara", "sai bem mas margem ruim"],
    PESO_MORTO: ["🪨", "Peso morto", "estoque preso, sem giro"],
    APOSTA: ["🎲", "Aposta", "margem boa, ainda não gira"],
    SUMINDO: ["📉", "Sumindo", "vendia e caiu forte"],
    RUPTURA: ["🔴", "Ruptura", "sai bem, estoque acabando"],
    NORMAL: ["·", "Normal", "sem sinal forte"],
  };
  function rTbl(titulo, sub, itens, colExtra) {
    if (!itens || !itens.length) return "";
    return '<div class="card" style="margin-bottom:12px"><div class="chead"><div class="ci gold">•</div><div><h3>' + titulo + '</h3><div class="cs">' + esc(sub) + "</div></div></div>" +
      '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th class="num">Un 30d</th><th class="num">Receita 30d</th><th>Margem</th>' + (colExtra ? "<th>" + colExtra.h + "</th>" : "") + "</tr></thead><tbody>" +
      itens.map(function (p) {
        return "<tr><td>" + esc(p.descricao) + '<div class="cs">' + esc(p.categoria || "") + (p.custo_suspeito ? ' · <b style="color:var(--down)">custo a conferir</b>' : "") + "</div></td>" +
          '<td class="num" data-l="Un 30d">' + int(p.unid_30d) + "</td>" +
          '<td class="num" data-l="Receita 30d">R$ ' + brl(p.receita_30d || 0) + "</td>" +
          '<td data-l="Margem">' + (p.margem_pct == null ? "—" : pct(p.margem_pct * 100)) + "</td>" +
          (colExtra ? '<td data-l="' + esc(colExtra.h) + '">' + colExtra.f(p) + "</td>" : "") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }
  function resultadoHtml(d) {
    if (!d || d.erro) return '<div class="empty">' + esc((d && d.erro) || "erro") + "</div>";
    var r = d.resumo;
    var out = feedsAviso(d);
    out += '<div class="cc-kpis">' +
      ccKpi("Lucro estimado (30d)", r.lucro_estimado_30d == null ? "s/ custo" : "R$ " + brl(r.lucro_estimado_30d), r.lucro_estimado_30d != null && r.lucro_estimado_30d < 0 ? "var(--down)" : "var(--ok)") +
      ccKpi("Capital parado (peso morto)", r.capital_parado_total == null ? "s/ estoque" : "R$ " + brl(r.capital_parado_total), r.capital_parado_total ? "var(--warn)" : null) +
      ccKpi("Receita 30d em risco de ruptura", r.receita_30d_em_risco_de_ruptura == null ? "s/ estoque" : "R$ " + brl(r.receita_30d_em_risco_de_ruptura), r.receita_30d_em_risco_de_ruptura ? "var(--down)" : null) +
      ccKpi("Cobertura do cálculo", r.cobertura_custo_pct + "% c/ custo" + (r.produtos_custo_suspeito ? " · " + r.produtos_custo_suspeito + " suspeitos" : "")) +
      "</div>";
    // quadrantes
    out += '<div class="card"><div class="chead"><div class="ci red">🧩</div><div><h3>Matriz: o que sai × dá lucro × encalha</h3></div></div><div class="quad-grid">' +
      Object.keys(QUAD).map(function (k) {
        var n = (r.por_quadrante || {})[k] || 0;
        var q = QUAD[k];
        return '<div class="quad' + (n ? "" : " off") + '"><div class="quad-n">' + int(n) + '</div><div class="quad-t">' + q[0] + " " + q[1] + '</div><div class="quad-s">' + q[2] + "</div></div>";
      }).join("") + "</div></div>";
    out += rTbl("💰 Onde está o lucro", "os que mais contribuem com margem × volume", r.top_lucro, { h: "Resultado 30d", f: function (p) { return "R$ " + brl(p.resultado_30d || 0); } });
    out += rTbl("🩸 Vende e não dá lucro (isca cara / prejuízo)", "revisar preço/custo — ou assumir como chamariz", r.top_prejuizo, { h: "Resultado 30d", f: function (p) { return '<span style="color:var(--down)">R$ ' + brl(p.resultado_30d || 0) + "</span>"; } });
    out += rTbl("⚠️ Custo a conferir", "custo cadastrado (Últ. Prc. Entrada) maior que o preço — provável erro no ERP", r.custo_a_conferir, { h: "Custo × Preço", f: function (p) { return "R$ " + brl(p.custo_atual || 0) + " / R$ " + brl(p.preco || 0); } });
    out += rTbl("🪨 Peso morto (capital parado)", "estoque parado sem giro — liquidar / combo", r.peso_morto, { h: "Parado / giro", f: function (p) { return "R$ " + brl(p.capital_parado || 0) + " · " + (p.giro_mensal == null ? "—" : p.giro_mensal + "x"); } });
    out += rTbl("🔴 Ruptura (perde venda)", "sai bem e o estoque está acabando — repor já", r.ruptura, { h: "Cobertura", f: function (p) { return (p.dias_cobertura == null ? "—" : p.dias_cobertura + "d"); } });
    out += rTbl("📉 Sumindo", "vendia e a demanda caiu forte — investigar", r.sumindo, { h: "Tendência", f: function (p) { return esc(p.tendencia || ""); } });
    return out;
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
      if (mkt.tab === "resultado") {
        var d = await mktFetch("/api/marketing/" + L + "/" + ym + "/resultado");
        host.innerHTML = resultadoHtml(d);
      } else if (mkt.tab === "produtos" || mkt.tab === "recomendados") {
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
      } else if (mkt.tab === "medicao") {
        var md = await mktFetch("/api/marketing/" + L + "/campaign-measure");
        host.innerHTML = medicaoHtml(md);
        wireMedicao();
      } else if (mkt.tab === "precificacao") {
        var pz = await mktFetch("/api/marketing/" + L + "/promo-pricing");
        host.innerHTML = promoPricingHtml(pz);
        wirePromoPricing();
      } else if (mkt.tab === "abc") {
        var abc = await mktFetch("/api/marketing/" + L + "/abc");
        host.innerHTML = abcHtml(abc);
      } else if (mkt.tab === "playbooks") {
        var pb = await mktFetch("/api/marketing/" + L + "/playbooks");
        host.innerHTML = playbooksHtml(pb);
      } else if (mkt.tab === "calendario") {
        var cal = await mktFetch("/api/marketing/" + L + "/calendar");
        host.innerHTML = calendarioHtml(cal);
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
  // ---- Campaign Builder 2.0 (Fase B) ----
  var DOW = [["1", "Seg"], ["2", "Ter"], ["3", "Qua"], ["4", "Qui"], ["5", "Sex"], ["6", "Sáb"], ["0", "Dom"]];
  var ANG_ICO = { PRECO: "💰", URGENCIA: "⏰", VOLUME: "📦", CONVENIENCIA: "📱", COMPARACAO: "⚖️", RECORRENCIA: "🔁" };
  function renderBuilderForm() {
    return '<div class="card form-card"><form id="cbForm"><fieldset><legend>Parâmetros da campanha</legend>' +
      '<div><label class="f">Dias da semana</label><div class="dow-pick">' +
      DOW.map(function (d) { return '<label class="dow"><input type="checkbox" name="dias" value="' + d[0] + '"' + (["5", "6", "0"].indexOf(d[0]) >= 0 ? " checked" : "") + ">" + d[1] + "</label>"; }).join("") + "</div></div>" +
      '<div class="rowf" style="margin-top:10px">' +
      '<div><label class="f">Tema (opcional)</label><input class="inp" name="tema" placeholder="Fim de semana da limpeza"></div>' +
      '<div><label class="f">Categorias (vírgula, opcional)</label><input class="inp" name="categorias" placeholder="Fraldas, Limpeza"></div>' +
      '</div></fieldset><button class="btn" type="submit">Montar campanha</button></form><div id="cbOut" style="margin-top:14px"></div></div>';
  }
  function cbScoreBadge(s) {
    var c = s >= 70 ? "var(--s1)" : s >= 50 ? "var(--s3)" : "var(--down)";
    return '<span class="cb-score" style="background:' + c + '">' + s + "<small>/100</small></span>";
  }
  function cbLegRow(it) {
    var f = it.forecast || {}, cen = (f.cenarios && f.cenarios.provavel) || {};
    var estTag = f.estoque_ok == null ? '<span class="cs">s/ estoque</span>' :
      f.estoque_ok ? '<span class="tag">estoque ok</span>' : '<span class="tag bad">falta estoque (' + int(f.estoque_necessario) + " vs " + int(f.estoque_atual) + ")</span>";
    return '<div class="cb-leg"><div class="cb-leg-h"><b>' + esc(it.descricao) + "</b>" +
      (it.preco_sugerido != null ? ' <span class="tag">R$ ' + brl(it.preco_ref) + " → <b>R$ " + brl(it.preco_sugerido) + "</b> (-" + it.desconto_pct + "%" + (it.desconto_proxy ? " proxy" : "") + ")</span>" : "") + "</div>" +
      '<div class="cb-ang">' + (ANG_ICO[it.angulo.primario] || "") + " <b>" + esc(it.angulo.rotulo) + '</b> — <span class="cs">"' + esc(it.angulo.sugestao_copy) + '"</span></div>' +
      '<div class="cs">' + esc(it.rationale || "") + "</div>" +
      '<div class="cb-fc">prov.: <b>' + int(cen.unidades) + "</b> un · R$ " + brl(cen.receita) + (cen.margem_incremental != null ? " · margem incr. R$ " + brl(cen.margem_incremental) : "") + " · " + estTag + "</div></div>";
  }
  function wireBuilder(ym) {
    view.querySelector("#cbForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target, out = view.querySelector("#cbOut");
      out.innerHTML = '<div class="empty">Montando campanha…</div>';
      var dias = Array.prototype.slice.call(f.querySelectorAll('input[name="dias"]:checked')).map(function (x) { return x.value; });
      var body = { dias: dias.join(",") };
      if (f.tema.value.trim()) body.tema = f.tema.value.trim();
      if (f.categorias.value.trim()) body.categorias = f.categorias.value.trim();
      try {
        var r = await fetch("/api/marketing/" + encodeURIComponent(state.loja) + "/campaign-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        var d = await r.json();
        if (!r.ok || d.erro) throw new Error(d.erro || ("HTTP " + r.status));
        var rz = d.resumo, jn = d.janela, fc = d.forecast;
        var html = feedsAviso(d);
        html += '<div class="card"><div class="cb-top">' + cbScoreBadge(rz.score_da_campanha) +
          '<div><h3 style="margin:0">' + (d.tema ? esc(d.tema) : "Campanha") + "</h3>" +
          '<div class="cs">' + (jn.proximo_periodo ? esc(jn.proximo_periodo.inicio) + " a " + esc(jn.proximo_periodo.fim) : "") + " · " + jn.duracao_dias + " dia(s) · " + rz.itens_no_elenco + " itens · confiança " + rz.score_confianca + "</div></div></div>" +
          '<div class="cb-comps">' + Object.keys(rz.score_componentes).map(function (k) {
            return '<div><span>' + k.replace(/_/g, " ") + '</span><b>' + Math.round(rz.score_componentes[k] * 100) + "</b></div>";
          }).join("") + "</div>" +
          (rz.score_dados_ausentes && rz.score_dados_ausentes.length ? '<div class="cs" style="margin-top:6px">⚠ ' + rz.score_dados_ausentes.map(esc).join(" · ") + "</div>" : "") +
          (rz.pernas_sem_estoque && rz.pernas_sem_estoque.length ? '<div class="cs" style="color:var(--down);margin-top:4px">Sem estoque p/ o forecast: ' + rz.pernas_sem_estoque.map(function (p) { return esc(p.descricao); }).join(", ") + "</div>" : "") +
          "</div>";
        html += Object.keys(d.elenco).map(function (papel) {
          var itens = d.elenco[papel] || [];
          if (!itens.length) return "";
          return '<div class="card" style="margin-bottom:10px"><div class="chead"><div class="ci red">' + papel[0] + '</div><div><h3>' + papel + ' <span class="cs">(' + itens.length + ")</span></h3></div></div>" +
            itens.map(cbLegRow).join("") + "</div>";
        }).join("");
        if (d.combos && d.combos.length) {
          html += '<div class="card"><div class="chead"><div class="ci gold">🔗</div><div><h3>Combos</h3><div class="cs">' + esc(d.combos_origem || "") + "</div></div></div>" +
            d.combos.map(function (c) {
              return '<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>' + esc(c.a) + "</b> + <b>" + esc(c.b) + '</b> <span class="tag">lift ' + c.lift + "×</span>" +
                (c.margem_combinada_pct != null ? ' <span class="cs">margem comb. ' + pct(c.margem_combinada_pct * 100) + "</span>" : "") +
                (c.alertas && c.alertas.length ? ' <span class="cs" style="color:var(--down)">' + c.alertas.map(esc).join(" · ") + "</span>" : "") + "</div>";
            }).join("") + "</div>";
        }
        html += '<div class="card"><div class="chead"><div class="ci">📈</div><div><h3>Forecast da campanha</h3><div class="cs">' + esc(fc.base) + (fc.margem_cobertura ? " · " + esc(fc.margem_cobertura) : "") + '</div></div></div>' +
          '<table class="tbl"><thead><tr><th>Cenário</th><th class="num">Unidades</th><th class="num">Receita</th><th class="num">Margem incremental</th></tr></thead><tbody>' +
          ["conservador", "provavel", "agressivo"].map(function (k) {
            var c = fc.cenarios[k];
            return "<tr><td>" + k + '</td><td class="num">' + int(c.unidades) + '</td><td class="num">R$ ' + brl(c.receita) + '</td><td class="num">' + (c.margem_incremental == null ? "—" : "R$ " + brl(c.margem_incremental)) + "</td></tr>";
          }).join("") + "</tbody></table>" +
          '<div class="cs" style="margin-top:6px">Estoque necessário total: ' + int(fc.estoque_necessario_total) + " un · " + esc(fc.aviso) + "</div></div>";
        if (d.evitar && d.evitar.length) {
          html += '<div class="card"><div class="chead"><div class="ci gold">🚫</div><div><h3>NÃO anunciar (' + d.evitar.length + ")</h3></div></div><ul style=\"margin:0 0 0 18px\">" +
            d.evitar.slice(0, 12).map(function (e) { return "<li>" + esc(e.descricao) + ' <span class="cs">' + esc(e.motivos.join("; ")) + (e.substituto ? " → no lugar: " + esc(e.substituto) : "") + "</span></li>"; }).join("") + "</ul></div>";
        }
        html += '<div class="card"><div class="chead"><div class="ci">📋</div><div><h3>Briefing</h3></div></div><pre style="white-space:pre-wrap;font:12.5px/1.5 ui-monospace,monospace;margin:0;overflow-x:auto">' + esc(d.briefing) + "</pre></div>";
        out.innerHTML = html;
      } catch (e) { out.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>"; }
    });
  }
  // ---- Medição de campanha (Fase C) ----
  var DOW_ABBR = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  function medVeredito(v) {
    var c = /incremental real/.test(v) ? "var(--s1)" : /parcialmente/.test(v) ? "var(--s3)" : /deslocou/.test(v) ? "var(--down)" : "var(--muted)";
    return '<span class="tag" style="background:' + c + ';color:#fff">' + esc(v) + "</span>";
  }
  function medCard(m) {
    if (m.erro) return '<div class="card"><div class="empty">' + esc(m.erro) + "</div></div>";
    var b = m.baseline, inc = m.incremental, ret = m.retorno, can = m.canibalizacao;
    var nome = (m.campanha && m.campanha.nome) || "Campanha";
    var dias = (m.campanha.dias_semana || []).map(function (d) { return DOW_ABBR[d]; }).join(", ");
    var confTag = m.confianca === "alta"
      ? '<span class="tag" style="background:var(--s1);color:#fff">confiança alta</span>'
      : '<span class="tag" style="background:var(--warn,#c98a00);color:#fff">confiança baixa</span>';
    return '<div class="card med-card" data-nome="' + esc(nome) + '">' +
      '<div class="chead"><div class="ci red">📊</div><div><h3>' + esc(nome) + " " + confTag + '</h3><div class="cs">' + esc(dias) + " · " + esc((m.campanha.categorias || []).join(", ")) + " · janela " + esc(m.janela.inicio) + "→" + esc(m.janela.fim) + (m.amostra.suficiente ? "" : ' · <b style="color:var(--down)">amostra curta</b>') + "</div></div></div>" +
      '<div class="cs" style="margin-bottom:8px">Baseline: <b>' + esc(b.metodo) + "</b> — R$ " + brl(b.receita_media_dia_campanha) + "/dia na campanha vs R$ " + brl(b.receita_media_dia_baseline) + "/dia baseline (" + b.n_dias_campanha + " dias)</div>" +
      '<div class="cc-kpis">' +
        ccKpi("Receita incremental", inc.receita_total == null ? "—" : "R$ " + brl(inc.receita_total), inc.receita_total > 0 ? "var(--ok)" : "var(--down)") +
        ccKpi("Sobre o baseline", inc.pct_sobre_baseline == null ? "—" : (inc.pct_sobre_baseline > 0 ? "+" : "") + pct(inc.pct_sobre_baseline)) +
        ccKpi("Unid. incrementais", inc.unidades_total == null ? "—" : int(inc.unidades_total)) +
        ccKpi("Lucro incremental", inc.lucro_total == null ? "s/ custo" : "R$ " + brl(inc.lucro_total), inc.lucro_total != null && inc.lucro_total < 0 ? "var(--down)" : null) +
      "</div>" +
      '<div class="med-row"><b>Canibalização:</b> ' + medVeredito(can.veredito) +
        (can.canibalizacao_pct != null ? ' <span class="cs">' + pct(can.canibalizacao_pct) + " do ganho veio de outras categorias · líquido R$ " + brl(can.incremento_liquido_dia) + "/dia</span>" : "") + "</div>" +
      '<form class="med-form"><label class="f">Investimento (R$)</label><input class="inp" name="inv" type="number" step="0.01" value="' + (m.investimento != null ? m.investimento : "") + '" placeholder="ex.: 250"><button class="btn" type="submit">Calcular retorno</button></form>' +
      '<div class="med-ret">' +
        (ret.ROAS == null ? '<span class="cs">informe o investimento para ROAS / retorno sobre margem</span>' :
          '<span class="tag">ROAS ' + ret.ROAS + "×</span> " +
          (ret.retorno_sobre_margem != null ? '<span class="tag" style="background:' + (ret.pagou ? "var(--s1)" : "var(--down)") + ';color:#fff">retorno s/ margem ' + ret.retorno_sobre_margem + "× " + (ret.pagou ? "(pagou)" : "(não pagou)") + "</span> " : "") +
          (ret.break_even_receita != null ? '<span class="cs">break-even: R$ ' + brl(ret.break_even_receita) + " de receita incremental</span>" : "")) +
      "</div>" +
      (m.dados_ausentes && m.dados_ausentes.length ? '<div class="cs" style="margin-top:6px">sem: ' + m.dados_ausentes.map(esc).join("; ") + "</div>" : "") +
      '<div class="cs" style="margin-top:4px">' + esc(m.aviso) + "</div></div>";
  }
  function medicaoHtml(md) {
    if (!md || md.erro) return '<div class="empty">' + esc((md && md.erro) || "erro") + "</div>";
    var arr = md.campanhas || [];
    if (!arr.length) return '<div class="empty">Nenhuma campanha no calendário desta loja (config/lojas.json).</div>';
    return '<div class="cs" style="margin-bottom:10px">Mede o que cada campanha recorrente do calendário fez de fato: incremento vs. o mesmo dia da semana, canibalização de outras categorias e — com o investimento — ROAS e retorno sobre a margem.</div>' +
      arr.map(medCard).join("");
  }
  function wireMedCard(card) {
    var nome = card.getAttribute("data-nome");
    card.querySelector(".med-form").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var inv = ev.target.inv.value.trim();
      var ret = card.querySelector(".med-ret");
      ret.innerHTML = '<span class="cs">calculando…</span>';
      try {
        var qs = "?nome=" + encodeURIComponent(nome) + (inv ? "&investimento=" + encodeURIComponent(inv) : "");
        var m = await getJSON("/api/marketing/" + encodeURIComponent(state.loja) + "/campaign-measure" + qs);
        var tmp = document.createElement("div"); tmp.innerHTML = medCard(m);
        var novo = tmp.firstElementChild;
        card.replaceWith(novo);
        wireMedCard(novo);
      } catch (e) { ret.innerHTML = '<span class="result err">' + esc((e.body && e.body.erro) || e.message) + "</span>"; }
    });
  }
  function wireMedicao() { view.querySelectorAll(".med-card").forEach(wireMedCard); }
  // ---- Curva ABC ----
  function abcClasseChip(k) {
    return '<span class="abc-chip abc-' + k + '">' + k + "</span>";
  }
  function abcHtml(d) {
    if (!d || d.erro) return '<div class="empty">' + esc((d && d.erro) || "erro") + "</div>";
    var p = d.produtos;
    var out = '<div class="cs" style="margin-bottom:8px">Receita dos últimos ' + d.janela_dias + " dias · A até " + Math.round(d.cortes.a * 100) + "% acumulado, B até " + Math.round(d.cortes.b * 100) + "%. " + esc(d.aviso) + "</div>";
    out += '<div class="card"><div class="chead"><div class="ci gold">📦</div><div><h3>Produtos</h3></div></div>' +
      '<div class="abc-bar big">' + ["A", "B", "C"].map(function (k) {
        return '<span class="abc-seg abc-' + k + '" style="flex:' + Math.max(1, p[k].receita || 1) + '">' + k + "<br>" + p[k].pct_receita + "%</span>";
      }).join("") + "</div>" +
      '<table class="tbl"><thead><tr><th>Classe</th><th class="num">Produtos</th><th class="num">% do catálogo</th><th class="num">Receita 90d</th><th class="num">% da receita</th></tr></thead><tbody>' +
      ["A", "B", "C"].map(function (k) {
        return "<tr><td>" + abcClasseChip(k) + "</td><td class=\"num\">" + int(p[k].n) + '</td><td class="num">' + (p.total_itens ? Math.round(p[k].n / p.total_itens * 100) : 0) + '%</td><td class="num">R$ ' + brl(p[k].receita) + '</td><td class="num"><b>' + p[k].pct_receita + "%</b></td></tr>";
      }).join("") + "</tbody></table>" +
      '<div class="cs" style="margin-top:6px">As telas de recomendação e o Campaign Builder usam só A+B. C ainda conta para estoque parado / liquidação.</div></div>';
    out += '<div class="card"><div class="chead"><div class="ci red">🗂️</div><div><h3>Categorias</h3></div></div>' +
      '<table class="tbl mobile-cards"><thead><tr><th>Categoria</th><th>Classe</th><th class="num">Receita 90d</th><th class="num">% da receita</th></tr></thead><tbody>' +
      d.categorias.map(function (c) {
        return "<tr><td data-l=\"Categoria\">" + esc(c.categoria) + "</td><td data-l=\"Classe\">" + abcClasseChip(c.abc) + '</td><td class="num" data-l="Receita">R$ ' + brl(c.receita_90d) + '</td><td class="num" data-l="%"><b>' + c.pct + "%</b></td></tr>";
      }).join("") + "</tbody></table></div>";
    var cl = d.clientes;
    out += '<div class="card"><div class="chead"><div class="ci conc">👤</div><div><h3>Clientes</h3></div></div>' +
      (!cl.disponivel ? '<div class="empty">' + esc(cl.nota) + "</div>" :
        '<div class="cs">' + int(cl.clientes_identificados) + " clientes identificados · top 8 = <b>" + cl.pct_top8 + "%</b> da receita identificada · A " + int(cl.classe_A.n) + " · B " + int(cl.classe_B.n) + " · C " + int(cl.classe_C.n) + "</div>" +
        '<table class="tbl"><thead><tr><th>Cliente</th><th class="num">Receita</th><th class="num">Cupons</th><th class="num">% do id.</th></tr></thead><tbody>' +
        cl.top_clientes.map(function (t) { return "<tr><td>" + esc(t.cliente) + '</td><td class="num">R$ ' + brl(t.receita) + '</td><td class="num">' + int(t.cupons) + '</td><td class="num">' + t.pct + "%</td></tr>"; }).join("") + "</tbody></table>") + "</div>";
    return out;
  }

  // ---- Playbooks por categoria (Fase D) ----
  function pbTendChip(t) {
    var m = { "melhorando": ["▲ melhorando", "var(--s1)"], "estável": ["= estável", "var(--ink-2)"], "piorando (possível fadiga)": ["▼ perdendo força", "var(--down)"], "sem base": ["· sem base", "var(--muted)"] };
    var x = m[t] || m["sem base"];
    return '<span class="tag" style="background:' + x[1] + ';color:#fff">' + x[0] + "</span>";
  }
  function pbDowBar(arr) {
    if (!arr || !arr.length) return "";
    var max = Math.max.apply(null, arr.map(function (d) { return d.lift_medio || 0; })) || 1;
    return '<div class="pb-dows">' + arr.map(function (d) {
      return '<div class="pb-dow"><span>' + esc(d.dia_nome) + '</span><span class="pb-bar"><i style="width:' + Math.round((d.lift_medio / max) * 100) + '%"></i></span><b>' + d.lift_medio + "×</b></div>";
    }).join("") + "</div>";
  }
  function pbCard(p) {
    return '<div class="card pb-card">' +
      '<div class="chead"><div class="ci red">📓</div><div><h3>' + esc(p.campanha) + " " + pbTendChip(p.tendencia) + '</h3>' +
      '<div class="cs">' + esc((p.categorias || []).join(", ")) + " · " + p.n_ocorrencias + " ocorrências na janela</div></div></div>" +
      '<div class="pb-grid">' +
        '<div><div class="cs">Melhor dia</div><b class="pb-big">' + esc(p.melhor_dia || "—") + "</b></div>" +
        '<div><div class="cs">Dias configurados</div><b class="pb-big">' + esc((p.dias_configurados || []).join(", ")) + "</b></div>" +
        '<div><div class="cs">Lift médio (indicativo)</div><b class="pb-big">' + (p.lift_medio == null ? "—" : p.lift_medio + "×") + "</b></div>" +
        '<div><div class="cs">Ângulo dominante</div><b class="pb-big">' + esc(p.angulo_dominante || "—") + "</b></div>" +
      "</div>" +
      pbDowBar(p.por_dia_semana) +
      '<div class="pb-vered">→ ' + esc(p.veredito) + "</div>" +
      (p.produtos_recomendados && p.produtos_recomendados.length ?
        '<div class="cs" style="margin-top:8px">Produtos para a campanha:</div><div class="pb-prods">' +
        p.produtos_recomendados.map(function (x) { return '<span class="chip">' + (PAP_ICO[x.papel] || "") + " " + esc(x.descricao) + '</span>'; }).join("") + "</div>" : "") +
      '<div class="cs" style="margin-top:6px">' + esc(p.lift_medio_nota || "") + "</div></div>";
  }
  function playbooksHtml(pb) {
    if (!pb || pb.erro) return '<div class="empty">' + esc((pb && pb.erro) || "erro") + "</div>";
    if (!pb.playbooks || !pb.playbooks.length) return '<div class="empty">Nenhuma campanha no calendário desta loja.</div>';
    var out = '<div class="cs" style="margin-bottom:10px">Manual aprendido dos próprios dados: como cada campanha recorrente vem se comportando semana a semana.</div>';
    out += pb.playbooks.map(pbCard).join("");
    var fad = pb.fadiga || {};
    out += '<div class="card"><div class="chead"><div class="ci gold">🥵</div><div><h3>Fadiga de produto</h3><div class="cs">' + esc(fad.aviso || "") + "</div></div></div>" +
      ((fad.produtos && fad.produtos.length) ?
        '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th>Categoria</th><th class="num">Lift ini → atual</th><th class="num">Queda</th><th>Ação</th></tr></thead><tbody>' +
        fad.produtos.map(function (f) {
          return "<tr><td>" + esc(f.descricao) + '</td><td data-l="Categoria">' + esc(f.categoria || "") + '</td><td class="num" data-l="Lift">' + f.lift_inicial + "× → " + f.lift_atual + '×</td><td class="num" data-l="Queda"><b style="color:var(--down)">-' + f.queda_pct + '%</b></td><td data-l="Ação"><span class="cs">' + esc(f.veredito) + "</span></td></tr>";
        }).join("") + "</tbody></table>" : '<div class="empty">Nada em fadiga.</div>') + "</div>";
    return out;
  }
  // ---- Marketing Calendar (Fase G) ----
  function calStatusChip(st) {
    var m = { OK: ["OK", "var(--s1)"], SUSPENDER: ["SUSPENDER", "var(--down)"], RENOVAR: ["RENOVAR", "#c98a00"], REVISAR: ["REVISAR", "var(--ink-2)"] };
    var x = m[st] || m.OK;
    return '<span class="tag" style="background:' + x[1] + ';color:#fff">' + x[0] + "</span>";
  }
  function calOccCard(o) {
    return '<div class="cal-occ"><div class="cal-occ-h"><b>' + esc(o.campanha) + "</b> " + calStatusChip(o.status) +
      ' <span class="cs">' + esc(o.datas[0]) + (o.datas.length > 1 ? " → " + esc(o.datas[o.datas.length - 1]) : "") + "</span></div>" +
      (o.status !== "OK" ? '<div class="cal-motivo">' + esc(o.motivo) + (o.acao ? ' <b>→ ' + esc(o.acao) + "</b>" : "") + "</div>" : "") +
      '<div class="cs">' + esc(o.papel_do_dia) + "</div></div>";
  }
  function calendarioHtml(c) {
    if (!c || c.erro) return '<div class="empty">' + esc((c && c.erro) || "erro") + "</div>";
    var out = '<div class="cs" style="margin-bottom:6px">Próximos ' + c.janela.dias + " dias (" + esc(c.janela.inicio) + " a " + esc(c.janela.fim) + ")</div>" +
      '<ul style="margin:0 0 12px 18px">' + c.resumo.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
    // semanas
    if (c.semanas && c.semanas.length) {
      out += '<div class="card"><div class="chead"><div class="ci gold">🗓️</div><div><h3>Semana a semana</h3></div></div>' +
        c.semanas.map(function (w) {
          return '<div class="cal-week"><b>' + esc(w.semana) + " → " + esc(w.fim) + "</b><ul>" +
            w.campanhas.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") +
            (w.slots && w.slots.length ? '<li class="cs">+ ' + w.slots.map(esc).join(", ") + "</li>" : "") + "</ul></div>";
        }).join("") + "</div>";
    }
    // ocorrências
    out += '<div class="card"><div class="chead"><div class="ci red">📌</div><div><h3>Ocorrências e ajustes</h3></div></div>' +
      (c.ocorrencias && c.ocorrencias.length ? c.ocorrencias.map(calOccCard).join("") : '<div class="empty">Sem campanha recorrente no calendário.</div>') + "</div>";
    // slots
    if (c.slots_sugeridos && c.slots_sugeridos.length) {
      out += '<div class="card"><div class="chead"><div class="ci conc">➕</div><div><h3>Slots sugeridos</h3></div></div>' +
        c.slots_sugeridos.map(function (s) {
          return '<div class="cal-occ"><div class="cal-occ-h"><b>' + esc(s.tipo) + " · " + esc(s.categoria) + "</b></div>" +
            '<div class="cal-motivo">' + esc(s.motivo) + " <b>→ " + esc(s.acao) + "</b></div></div>";
        }).join("") + "</div>";
    }
    // ciclo fechado
    out += '<div class="card"><div class="chead"><div class="ci">🔁</div><div><h3>Ciclo fechado</h3><div class="cs">medição → padrão → recomendação para a próxima rodada</div></div></div>' +
      c.ciclo_fechado.map(function (cf) {
        var m = cf.ultima_medicao, p = cf.padrao;
        return '<div class="cal-occ"><div class="cal-occ-h"><b>' + esc(cf.campanha) + "</b></div>" +
          '<div class="cs">Última medição: ' + (m ? "R$ " + brl(m.incremento_receita) + " incremental" + (m.pct_sobre_baseline != null ? " (" + pct(m.pct_sobre_baseline) + ")" : "") + (m.ROAS != null ? " · ROAS " + m.ROAS + "×" : "") + " · " + esc(m.canibalizacao) + " · confiança " + esc(m.confianca) : "—") + "</div>" +
          '<div class="cs">Padrão: ' + (p ? "melhor dia " + esc(p.melhor_dia) + " · " + esc(p.tendencia) + " · " + p.n_ocorrencias + " ocorrências" : "sem base") + (cf.produtos_em_fadiga.length ? " · " + cf.produtos_em_fadiga.length + " em fadiga" : "") + "</div>" +
          '<div class="cal-motivo">→ ' + esc(cf.recomendacao_proxima) + "</div></div>";
      }).join("") + "</div>" +
      '<div class="cs" style="margin-top:6px">' + esc(c.aviso) + "</div>";
    return out;
  }
  // ---- Precificação de promoção (Promo Pricing Engine) ----
  function ppLabelHorizonte(d) { return "Lucro incr. (" + ((d && d.horizonte_dias) || 7) + "d)"; }
  function ppRow(p) {
    return '<tr class="pp-clic" data-pp-id="' + esc(String(p.produto_id || "")) + '" data-pp-ean="' + esc(String(p.ean || "")) + '">' +
      '<td data-l="Produto">' + esc(p.produto) + (p.ean ? '<div class="cs">EAN ' + esc(p.ean) + "</div>" : "") +
      '</td><td data-l="Categoria">' + esc(p.categoria) + " " + abcClasseChip(p.abc) + (p.defensivo ? ' <span class="tag" style="background:var(--down);color:#fff">defesa</span>' : "") + (p.tem_promo_planejada ? ' <span class="tag">na tabela</span>' : "") +
      '</td><td class="num" data-l="Preço">R$ ' + brl(p.preco_normal) + ' → <b>R$ ' + brl(p.preco_recomendado) + "</b>" +
      '<div class="cs">-' + p.desconto_pct + "% · margem " + (p.margem_pct_na_promo == null ? "—" : Math.round(p.margem_pct_na_promo * 100) + "%") + (p.custo_proxy ? " · custo proxy" : "") + "</div>" +
      '</td><td class="num" data-l="Lucro incr."><b>' + (p.lucro_incremental_previsto == null ? "—" : "R$ " + brl(p.lucro_incremental_previsto)) + "</b>" +
      (p.efeito_cesta_estimado ? '<div class="cs">+R$ ' + brl(p.efeito_cesta_estimado) + " cesta</div>" : "") +
      '</td><td class="num" data-l="Unid. incr.">+' + int(p.unidades_incrementais) + "</td>" +
      '<td data-l="Por quê"><span class="cs">' + esc(p.motivo || "") + "</span></td></tr>";
  }
  function ppGrupoOpts(d) {
    return (d.por_grupo || []).map(function (g) {
      return '<option value="' + esc(g.categoria) + '">' + esc(g.categoria) + " — " + g.n_interessantes + " produto(s), R$ " + brl(g.lucro_incremental_total) + " lucro incr." + (g.margem_media_na_promo != null ? ", margem méd. " + Math.round(g.margem_media_na_promo * 100) + "%" : "") + "</option>";
    }).join("");
  }
  function promoGrupoTable(d, cat) {
    var g = (d.por_grupo || []).find(function (x) { return x.categoria === cat; });
    if (!g) return '<div class="empty">Grupo sem produtos interessantes para promoção.</div>';
    var out = '<div class="card"><div class="chead"><div class="ci gold">🏷️</div><div><h3>' + esc(g.categoria) + '</h3>' +
      '<div class="cs">' + g.n_interessantes + " produto(s) que valem promoção · lucro incremental total <b>R$ " + brl(g.lucro_incremental_total) + "</b>" +
      (g.margem_media_na_promo != null ? " · margem média na promo <b>" + Math.round(g.margem_media_na_promo * 100) + "%</b>" : "") +
      " · desconto médio -" + g.desconto_medio_pct + "%" + (g.mostrando < g.n_interessantes ? " · mostrando os " + g.mostrando + " maiores" : "") + "</div></div></div>" +
      '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th class="num">Preço → colocar</th><th class="num">Desc.</th><th class="num">Margem na promo</th><th class="num">' + ppLabelHorizonte(d) + '</th><th class="num">Unid. incr.</th></tr></thead><tbody>' +
      g.produtos.map(function (p) {
        return '<tr class="pp-clic" data-pp-id="' + esc(String(p.produto_id || "")) + '" data-pp-ean="' + esc(String(p.ean || "")) + '">' +
          '<td data-l="Produto">' + esc(p.produto) + " " + abcClasseChip(p.abc) + (p.custo_proxy ? ' <span class="cs">(custo proxy)</span>' : "") + (p.tem_promo_planejada ? ' <span class="tag">na tabela</span>' : "") + (p.ean ? '<div class="cs">EAN ' + esc(p.ean) + "</div>" : "") +
          '</td><td class="num" data-l="Preço">R$ ' + brl(p.preco_normal) + " → <b>R$ " + brl(p.preco_recomendado) + "</b>" +
          '</td><td class="num" data-l="Desc.">-' + p.desconto_pct + "%</td>" +
          '<td class="num" data-l="Margem">' + (p.margem_pct_na_promo == null ? "—" : Math.round(p.margem_pct_na_promo * 100) + "%") + "</td>" +
          '<td class="num" data-l="Lucro incr."><b>' + (p.lucro_incremental_previsto == null ? "—" : "R$ " + brl(p.lucro_incremental_previsto)) + "</b></td>" +
          '<td class="num" data-l="Unid. incr.">+' + int(p.unidades_incrementais) + "</td></tr>";
      }).join("") + "</tbody></table>" +
      '<div class="cs" style="margin-top:6px">Clique num produto para ver a curva lucro×desconto, os 3 preços para testar e o break-even.</div></div>';
    return out;
  }
  function promoPricingHtml(d) {
    if (!d || d.erro) return '<div class="empty">' + esc((d && d.erro) || "erro") + "</div>";
    mkt._pp = d;
    var hz = d.horizonte_dias || 7;
    var out =
      '<div class="card form-card"><form id="ppForm"><fieldset><legend>Ver um produto específico</legend><div class="rowf">' +
      '<div style="flex:2"><label class="f">EAN ou descrição</label><input class="inp" name="q" placeholder="7891... ou TOALHA BEBE"></div>' +
      '<div><label class="f">Duração da promo (dias)</label><input class="inp" name="dias" type="number" value="' + hz + '" min="1"></div>' +
      '</div></fieldset><button class="btn" type="submit">Analisar preço</button></form><div id="ppOut" style="margin-top:14px"></div></div>';
    // seletor de grupo — "escolho o grupo e vejo todos os produtos que valem promoção"
    out += '<div class="card"><div class="chead"><div class="ci red">📂</div><div><h3>Por grupo</h3><div class="cs">Escolha um grupo → todos os produtos que valem promoção nele, com preço a colocar e margem</div></div></div>' +
      (d.por_grupo && d.por_grupo.length ?
        '<select class="inp" id="ppGrupo" style="max-width:520px"><option value="">— escolha um grupo —</option>' + ppGrupoOpts(d) + "</select><div id=\"ppGrupoOut\" style=\"margin-top:12px\"></div>" :
        '<div class="empty">Nenhum grupo com produtos interessantes para promoção com os dados atuais.</div>') + "</div>";
    out += '<div class="cs" style="margin:12px 0 8px">Ranking geral — melhor promoção de cada produto A/B, projetada para ' + hz + ' dias. ' +
      "Potencial do top " + d.produtos.length + ": <b>R$ " + brl(d.potencial_lucro_incremental_top) + "</b> de lucro incremental" + (d.efeito_cesta_estimado_top ? " + R$ " + brl(d.efeito_cesta_estimado_top) + " de efeito-cesta estimado" : "") + ".</div>";
    out += '<div class="card"><div class="chead"><div class="ci gold">🥇</div><div><h3>Candidatos a promoção</h3><div class="cs">' + int(d.candidatos) + " produtos A/B avaliados · clique para o detalhe</div></div></div>" +
      (d.produtos.length ? '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th>Categoria</th><th class="num">Preço → recomendado</th><th class="num">' + ppLabelHorizonte(d) + "</th><th class=\"num\">Unid. incr.</th><th>Por quê</th></tr></thead><tbody>" +
        d.produtos.map(ppRow).join("") + "</tbody></table>" : '<div class="empty">Nenhum produto com promoção que aumente o lucro do próprio item com os dados atuais.</div>') + "</div>";
    if (d.sem_custo && d.sem_custo.n) {
      out += '<div class="card"><div class="chead"><div class="ci conc">❔</div><div><h3>Sem custo — ' + int(d.sem_custo.n) + " produtos</h3><div class=\"cs\">" + esc(d.sem_custo.nota) + "</div></div></div>" +
        '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th>Categoria</th><th class="num">Preço → recomendado</th><th class="num">Unid. incr.</th></tr></thead><tbody>' +
        d.sem_custo.produtos.map(function (p) {
          return '<tr class="pp-clic" data-pp-id="' + esc(String(p.produto_id || "")) + '" data-pp-ean="' + esc(String(p.ean || "")) + '"><td data-l="Produto">' + esc(p.produto) + '</td><td data-l="Categoria">' + esc(p.categoria) + " " + abcClasseChip(p.abc) +
            '</td><td class="num" data-l="Preço">R$ ' + brl(p.preco_normal) + " → <b>R$ " + brl(p.preco_recomendado) + "</b> <span class=\"cs\">-" + p.desconto_pct + "%</span></td>" +
            '<td class="num" data-l="Unid. incr.">+' + int(p.unidades_incrementais) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    out += '<div class="result" style="margin-top:10px;background:#fff6e6;border-color:#f0c98a;color:#8a5a00">' + esc(d.aviso) + "</div>";
    return out;
  }
  function ppCurvaSvg(curva, melhorD, breakEvenD) {
    if (!curva || curva.length < 2) return "";
    var W = 520, H = 150, pad = 28;
    var xs = curva.map(function (c) { return c.desconto_pct; });
    var ys = curva.map(function (c) { return c.lucro_incremental == null ? 0 : c.lucro_incremental; });
    var xMax = Math.max.apply(null, xs) || 1, yMax = Math.max.apply(null, ys), yMin = Math.min(0, Math.min.apply(null, ys));
    var sx = function (x) { return pad + (x / xMax) * (W - pad * 2); };
    var sy = function (y) { return H - pad - ((y - yMin) / ((yMax - yMin) || 1)) * (H - pad * 2); };
    var pts = curva.map(function (c, i) { return sx(xs[i]) + "," + sy(ys[i]); }).join(" ");
    var zeroY = sy(0);
    var mx = sx(melhorD);
    var g = '<svg class="pp-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">';
    g += '<line x1="' + pad + '" y1="' + zeroY + '" x2="' + (W - pad) + '" y2="' + zeroY + '" stroke="var(--line)" stroke-dasharray="3 3"/>';
    g += '<polyline points="' + pts + '" fill="none" stroke="var(--s1)" stroke-width="2"/>';
    g += '<line x1="' + mx + '" y1="' + pad + '" x2="' + mx + '" y2="' + (H - pad) + '" stroke="var(--s3)" stroke-width="1.5"/>';
    g += '<text x="' + Math.min(W - pad - 60, mx + 4) + '" y="' + (pad + 10) + '" fill="var(--s3)" font-size="10">recom. -' + melhorD + "%</text>";
    if (breakEvenD != null) { var bx = sx(breakEvenD); g += '<line x1="' + bx + '" y1="' + pad + '" x2="' + bx + '" y2="' + (H - pad) + '" stroke="var(--down)" stroke-dasharray="4 2"/><text x="' + Math.min(W - pad - 50, bx + 4) + '" y="' + (H - pad - 4) + '" fill="var(--down)" font-size="10">break-even</text>'; }
    g += '<text x="' + pad + '" y="' + (H - 6) + '" fill="var(--ink-2)" font-size="10">0%</text>';
    g += '<text x="' + (W - pad - 24) + '" y="' + (H - 6) + '" fill="var(--ink-2)" font-size="10">-' + xMax + '%</text>';
    g += "</svg>";
    return g;
  }
  function ppTestRow(t) {
    return "<tr><td><b>" + esc(t.rotulo) + '</b></td><td class="num">-' + t.desconto_pct + '%</td><td class="num">R$ ' + brl(t.preco) + '</td><td class="num">' + int(t.unidades) + '</td><td class="num">+' + int(t.unidades_incrementais) + '</td><td class="num">R$ ' + brl(t.receita) + '</td><td class="num"><b>' + (t.lucro_incremental == null ? "—" : "R$ " + brl(t.lucro_incremental)) + '</b></td><td class="num">' + (t.margem_pct == null ? "—" : Math.round(t.margem_pct * 100) + "%") + "</td></tr>";
  }
  // fallback quando não há curva embutida (recorte por_grupo): barras a partir dos 3 cenários
  function ppBarsFromTestar(testar) {
    var arr = (testar || []).filter(function (t) { return t.lucro_incremental != null; });
    if (!arr.length) return "";
    var max = Math.max.apply(null, arr.map(function (t) { return Math.abs(t.lucro_incremental); })) || 1;
    return '<div class="pp-bars">' + arr.map(function (t) {
      var w = Math.round((Math.abs(t.lucro_incremental) / max) * 100);
      return '<div class="pp-bar"><span>' + esc(t.rotulo) + " (-" + t.desconto_pct + '%)</span><i style="width:' + w + "%;background:" + (t.lucro_incremental < 0 ? "var(--down)" : "var(--s1)") + '"></i><b>R$ ' + brl(t.lucro_incremental) + "</b></div>";
    }).join("") + "</div>";
  }
  function promoDeepDiveHtml(d) {
    if (!d || d.erro) return '<div class="result err">' + esc((d && d.erro) || "produto não encontrado") + "</div>";
    if (!d.recomendado) return '<div class="result err">Sem dados de precificação para este produto (custo/preço/giro insuficiente).</div>';
    var r = d.recomendado || {}, lim = d.limites || {}, el = d.elasticidade || {};
    var out = '<div class="card"><div class="chead"><div class="ci gold">🏷️</div><div><h3>' + esc(d.produto) + " " + abcClasseChip(d.abc) + '</h3>' +
      '<div class="cs">' + esc(d.categoria) + " · " + esc(d.loja || state.loja) + " · giro 30d " + (d.venda_media_diaria_30d == null ? "—" : d.venda_media_diaria_30d + "/dia") + " · promo de " + d.duracao_dias + " dias" + (d.cobertura_rotulo ? " · estoque " + esc(d.cobertura_rotulo) : "") + "</div></div></div>";
    out += '<div class="pp-kpis">' +
      '<div class="pp-k"><span>Preço normal</span><b>R$ ' + brl(d.preco_normal) + "</b></div>" +
      '<div class="pp-k"><span>Custo' + (d.custo_proxy ? " (proxy " + esc(d.custo_proxy_origem || "") + ")" : "") + '</span><b>' + (d.custo == null ? "—" : "R$ " + brl(d.custo)) + "</b></div>" +
      '<div class="pp-k big"><span>Preço recomendado</span><b>R$ ' + brl(r.preco) + ' <small>-' + r.desconto_pct + "%</small></b></div>" +
      '<div class="pp-k"><span>Lucro incremental</span><b>R$ ' + brl(r.lucro_incremental) + "</b></div>" +
      '<div class="pp-k"><span>Efeito-cesta estimado</span><b>R$ ' + brl(r.efeito_cesta_estimado) + "</b></div>" +
      '<div class="pp-k"><span>Unid. proj. / incr.</span><b>' + int(r.unidades) + " / +" + int(r.unidades_incrementais) + "</b></div>" +
      '<div class="pp-k"><span>Margem na promo</span><b>' + (r.margem_pct == null ? "—" : Math.round(r.margem_pct * 100) + "%") + "</b></div>" +
      "</div>";
    out += '<div class="card"><div class="chead"><div class="ci red">📉</div><div><h3>Lucro incremental × desconto</h3><div class="cs">elasticidade ' + el.valor + " (" + esc(el.fonte) + ")" +
      (d.lift_historico_categoria ? " · lift histórico da categoria " + d.lift_historico_categoria + "×" : "") + "</div></div></div>" +
      (d.curva && d.curva.length >= 2 ? ppCurvaSvg(d.curva, r.desconto_pct, lim.break_even_desconto_pct) : ppBarsFromTestar(d.testar)) +
      '<div class="cs">Break-even em -' + (lim.break_even_desconto_pct == null ? "—" : lim.break_even_desconto_pct + "%") +
      " · desconto sem prejuízo até -" + (lim.desconto_max_sem_prejuizo_pct == null ? "—" : lim.desconto_max_sem_prejuizo_pct + "%") +
      " · teto avaliado -" + lim.desconto_teto_pct + "%</div></div>";
    out += '<div class="card"><div class="chead"><div class="ci conc">🧪</div><div><h3>Preços para testar</h3></div></div>' +
      '<table class="tbl"><thead><tr><th>Cenário</th><th class="num">Desc.</th><th class="num">Preço</th><th class="num">Unid.</th><th class="num">Incr.</th><th class="num">Receita</th><th class="num">Lucro incr.</th><th class="num">Margem</th></tr></thead><tbody>' +
      (d.testar || []).map(ppTestRow).join("") + "</tbody></table></div>";
    if (d.promocao_planejada) {
      var pp = d.promocao_planejada, pj = pp.projecao || {};
      out += '<div class="card"><div class="chead"><div class="ci gold">📋</div><div><h3>Promoção já planejada</h3><div class="cs">da tabela de promoções</div></div></div>' +
        '<div class="cs">Preço planejado <b>R$ ' + brl(pp.preco) + "</b> (-" + (pp.desconto_pct == null ? "?" : pp.desconto_pct) + "%)" +
        (pj.lucro_incremental != null ? " · projeção: <b>R$ " + brl(pj.lucro_incremental) + "</b> de lucro incremental, +" + int(pj.unidades_incrementais) + " unid., margem " + (pj.margem_pct == null ? "—" : Math.round(pj.margem_pct * 100) + "%") : "") +
        (pp.desconto_pct != null && r.desconto_pct != null ? " · recomendado é <b>-" + r.desconto_pct + "%</b> (R$ " + brl(r.preco) + ")" : "") + "</div></div>";
    }
    out += '<div class="result" style="margin-top:10px;background:#fff6e6;border-color:#f0c98a;color:#8a5a00">' + esc(d.aviso) + "</div>";
    return out;
  }
  // acha o detalhe embutido de um produto (ranking, sem_custo ou qualquer grupo) — usado no
  // site publicado, onde não dá para chamar o endpoint por produto.
  function ppDetalheEmbutido(id, ean) {
    var d = mkt._pp; if (!d) return null;
    var pools = [d.produtos || [], (d.sem_custo && d.sem_custo.produtos) || []];
    (d.por_grupo || []).forEach(function (g) { pools.push(g.produtos || []); });
    for (var i = 0; i < pools.length; i++) {
      var hit = pools[i].find(function (p) {
        return (id && String(p.produto_id) === String(id)) || (ean && String(p.ean) === String(ean));
      });
      if (hit && hit.detalhe) return hit.detalhe;
    }
    return null;
  }
  async function ppAbrirProduto(box, id, ean, dias) {
    box.innerHTML = '<div class="empty">Analisando…</div>';
    var qs = (id ? "produto_id=" + encodeURIComponent(id) : "ean=" + encodeURIComponent(ean)) + (dias ? "&dias=" + encodeURIComponent(dias) : "");
    try {
      var d = await getJSON("/api/marketing/" + encodeURIComponent(state.loja) + "/promo-pricing?" + qs);
      if (d && d.recomendado) { box.innerHTML = promoDeepDiveHtml(d); return; }
      var emb = ppDetalheEmbutido(id, ean);
      box.innerHTML = emb ? promoDeepDiveHtml(emb) : '<div class="result err">Detalhe indisponível para este produto.</div>';
    } catch (e) {
      var emb2 = ppDetalheEmbutido(id, ean);
      box.innerHTML = emb2 ? promoDeepDiveHtml(emb2) : '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
    }
  }
  function wirePromoPricing() {
    var root = view.querySelector("#mktBody");
    if (!root) return;
    var form = view.querySelector("#ppForm");
    var diasDe = function () { return (form && form.dias.value.trim()) || ""; };

    // seletor de grupo
    var sel = view.querySelector("#ppGrupo");
    if (sel) sel.addEventListener("change", function () {
      var box = view.querySelector("#ppGrupoOut");
      box.innerHTML = sel.value ? promoGrupoTable(mkt._pp, sel.value) : "";
    });

    // clique em qualquer linha de produto (ranking, grupo, sem custo) -> detalhe inline
    root.addEventListener("click", function (ev) {
      var tr = ev.target.closest && ev.target.closest("tr.pp-clic");
      if (!tr || !root.contains(tr)) return;
      var id = tr.getAttribute("data-pp-id"), ean = tr.getAttribute("data-pp-ean");
      if (!id && !ean) return;
      var box = tr.closest("table").parentNode.querySelector(".pp-detalhe") || (function () {
        var b = document.createElement("div"); b.className = "pp-detalhe"; b.style.marginTop = "12px";
        tr.closest("table").parentNode.appendChild(b); return b;
      })();
      view.querySelectorAll(".pp-clic.on").forEach(function (x) { x.classList.remove("on"); });
      tr.classList.add("on");
      ppAbrirProduto(box, id, ean, diasDe());
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    // busca livre por EAN / descrição
    if (form) form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var q = form.q.value.trim(), dias = diasDe();
      var out = view.querySelector("#ppOut");
      if (!q) { out.innerHTML = '<div class="cs">Informe um EAN ou parte da descrição.</div>'; return; }
      out.innerHTML = '<div class="empty">Analisando…</div>';
      var isEan = /^\d{6,}$/.test(q);
      var url = "/api/marketing/" + encodeURIComponent(state.loja) + "/promo-pricing?" +
        (isEan ? "ean=" + encodeURIComponent(q) : "produto=" + encodeURIComponent(q)) + (dias ? "&dias=" + encodeURIComponent(dias) : "");
      try {
        var d = await getJSON(url);
        if (d && d.recomendado) { out.innerHTML = promoDeepDiveHtml(d); return; }
        // site publicado devolveu o ranking (sem backend) — procura o produto nos dados embutidos
        var ql = q.toLowerCase();
        var d0 = mkt._pp, pools = [(d0 && d0.produtos) || [], (d0 && d0.sem_custo && d0.sem_custo.produtos) || []];
        (d0 && d0.por_grupo || []).forEach(function (g) { pools.push(g.produtos || []); });
        var hit = null;
        pools.some(function (arr) { return (hit = arr.find(function (p) { return (isEan && String(p.ean) === q) || String(p.produto).toLowerCase().indexOf(ql) >= 0; })); });
        out.innerHTML = hit && hit.detalhe ? promoDeepDiveHtml(hit.detalhe)
          : '<div class="result">No site publicado a busca livre cobre só os produtos já listados abaixo (ranking + grupos). Para qualquer produto do catálogo, abra a Precificação no servidor local.</div>';
      } catch (e) {
        out.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
      }
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

  // ---------- Command Center (Fase A) ----------
  var PAP_ICO = { CHAMARIZ: "🎯", TRAFEGO: "🧲", HERO: "🥇", MARGEM: "💰", COMPLEMENTAR: "➕", DESOVA: "📦", RECORRENCIA: "🔁", IMAGEM: "✨", GIRO: "•" };
  var ALERTA_COR = { ALTO: ["#c0392b", "#fdecec"], ATENCAO: ["#8a5a00", "#fff6e6"], INFORMATIVO: ["var(--ink-2)", "#f3f4f6"] };
  function ssPill(label, val) {
    var v = val == null ? null : Math.max(0, Math.min(100, val));
    var c = v == null ? "var(--muted)" : v >= 65 ? "var(--s1)" : v >= 40 ? "var(--s3)" : "var(--muted)";
    return '<div class="ss"><span>' + esc(label) + '</span><span class="ssb"><i style="width:' + (v == null ? 0 : v) + "%;background:" + c + '"></i></span><b>' + (v == null ? "—" : Math.round(v)) + "</b></div>";
  }
  function ccWhy(motivos) {
    return '<ul class="cc-why">' + (motivos || []).map(function (m) {
      return "<li>" + esc(m.texto) + ' <span class="cs">(' + esc(m.evidencia.campo) + " · " + esc(m.evidencia.periodo) + ")</span></li>";
    }).join("") + "</ul>";
  }
  function ccCard(p, i) {
    var s = p.sub_scores || {};
    var cob = p.cobertura_rotulo === "SEM_ESTOQUE" ? "s/ estoque" :
      (p.cobertura_infinita ? "∞" : (p.dias_cobertura == null ? "—" : p.dias_cobertura + "d")) + " · " + p.cobertura_rotulo;
    return '<div class="cc-card"><div class="cc-rank">' + (i + 1) + "</div><div class=\"cc-main\">" +
      '<div class="cc-h"><b>' + esc(p.descricao) + '</b> <span class="chip">' + (PAP_ICO[p.papel_primario] || "") + " " + esc(p.papel_primario) + "</span>" +
      (p.papeis && p.papeis.length > 1 ? ' <span class="cs">+ ' + p.papeis.slice(1).map(esc).join(", ") + "</span>" : "") + "</div>" +
      '<div class="cs">' + esc(p.categoria || "") + (p.ean ? " · EAN " + p.ean : "") + "</div>" +
      '<div class="cc-act">→ ' + esc(p.acao_sugerida) + "</div>" +
      (p.promo ? '<div class="cc-promo">🏷️ colocar a <b>R$ ' + brl(p.promo.preco_recomendado) + "</b> (-" + p.promo.desconto_pct + "% de R$ " + brl(p.promo.preco_normal) + ") · margem " +
        (p.promo.margem_pct_na_promo == null ? "—" : Math.round(p.promo.margem_pct_na_promo * 100) + "%") +
        " · +R$ " + brl(p.promo.lucro_incremental_previsto) + " lucro / " + p.promo.duracao_dias + "d" +
        (p.promo.tem_promo_planejada ? ' · <span class="tag">na tabela</span>' : "") + "</div>" : "") +
      '<div class="cc-scores">' +
        ssPill("Opport.", p.opportunity_score) +
        ssPill("Tráfego", s.traffic_score && s.traffic_score.valor) +
        ssPill("Lucro", s.profit_score && s.profit_score.valor) +
        ssPill("Desova", s.clearance_score && s.clearance_score.valor) +
        ssPill("Campanha", s.campaign_score && s.campaign_score.valor) +
        ssPill("Criativo", null) +
      "</div>" +
      '<div class="cc-interp">' + esc(p.interpretacao || "") + "</div>" +
      ccWhy(p.motivos) +
      '<div class="cc-tags">' + tendChip(p.tendencia || { rotulo: "SEM_BASE" }) +
      ' <span class="tag">' + esc(cob) + "</span> " +
      (p.margem_pct == null ? '<span class="cs">s/ custo</span>' : '<span class="tag">margem ' + pct(p.margem_pct * 100) + "</span>") +
      (s.profit_score && s.profit_score.ausente ? ' <span class="cs">lucro: ' + esc(s.profit_score.ausente) + "</span>" : "") +
      "</div></div></div>";
  }
  function ccNo(p) {
    return '<div class="cc-no"><div><b>' + esc(p.descricao) + '</b> <span class="tag bad">' + esc(p.motivo_curto) + '</span> <span class="cs">' + esc(p.categoria || "") + "</span></div>" +
      ccWhy(p.motivos) +
      (p.substituto ? '<div class="cs" style="margin-top:4px">↳ usar no lugar: <b>' + esc(p.substituto.descricao) + "</b> (opportunity " + p.substituto.opportunity_score + ")</div>" : "") +
      "</div>";
  }
  async function renderCommand() {
    state.view = "command";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "command"); });
    if (!state.loja) { view.innerHTML = '<div class="page-head"><div><h1>🔥 Command Center</h1></div></div><div class="empty">Suba um relatório de vendas primeiro.</div>'; return; }
    view.innerHTML = '<div class="page-head"><div><h1>🔥 Command Center</h1><div class="sub">' + esc(state.loja) + " · o que o marketing deve fazer hoje · camada determinística (a IA não inventa número)</div></div></div>" +
      '<div id="ccBody"><div class="empty">Carregando…</div></div>';
    var host = view.querySelector("#ccBody");
    try {
      var d = await getJSON("/api/marketing/" + encodeURIComponent(state.loja) + "/command-center");
      if (d.erro) { host.innerHTML = '<div class="empty">' + esc(d.erro) + "</div>"; return; }
      var pd = d.plano_do_dia || {};
      var rz = d.resumo || {};
      var mix = Object.keys(rz.mix_papeis || {}).map(function (k) { return (rz.mix_papeis[k]) + " " + k; }).join(" · ");
      var out = feedsAviso(d);
      out += (pd.alertas || []).map(function (a) {
        var c = ALERTA_COR[a.nivel] || ALERTA_COR.INFORMATIVO;
        return '<div class="cc-alert" style="color:' + c[0] + ";background:" + c[1] + '"><b>' + esc(a.nivel) + "</b><span>" + esc(a.texto) + "</span></div>";
      }).join("");
      out += '<div class="cs" style="margin:10px 0 4px">' + int(rz.total_analisado) + " produtos analisados · " + int(rz.anunciaveis) + " anunciáveis · " + int(rz.bloqueados) + " bloqueados" + (mix ? " · mix: " + esc(mix) : "") + "</div>";
      if (d.abc && d.abc.A) {
        var ab = d.abc;
        out += '<div class="abc-bar">' +
          ["A", "B", "C"].map(function (k) { return '<span class="abc-seg abc-' + k + '" style="flex:' + Math.max(1, ab[k].n) + '" title="' + k + ": " + int(ab[k].n) + " prod · " + ab[k].pct_receita + '% da receita">' + k + " " + ab[k].pct_receita + "%</span>"; }).join("") +
          "</div><div class=\"cs\">Curva ABC (receita 90d): <b>" + int(ab.A.n) + "</b> produtos classe A = " + ab.A.pct_receita + "% · " + int(ab.B.n) + " B · " + int(ab.C.n) + " C (cauda)</div>";
      }
      out += '<div class="cc-sec-h">🔥 O que anunciar hoje' + (rz.ocultos_classe_c ? ' <span class="cs" style="font-weight:400">(' + int(rz.ocultos_classe_c) + " da cauda / classe C fora)</span>" : "") + "</div>";
      out += (pd.anunciar && pd.anunciar.length) ? pd.anunciar.map(ccCard).join("") : '<div class="empty">Nada acima do piso de oportunidade neste período.</div>';
      out += '<div class="cc-sec-h">⛔ O que NÃO anunciar</div>';
      out += (pd.nao_anunciar && pd.nao_anunciar.length) ? pd.nao_anunciar.map(ccNo).join("") : '<div class="empty">Nenhum produto bloqueado com os feeds atuais.</div>';
      host.innerHTML = out;
    } catch (e) {
      host.innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
    }
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

  // ---------- Concorrentes ----------
  function renderConcorrentes() {
    state.view = "concorrentes";
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === "concorrentes"); });
    if (!state.loja) { view.innerHTML = '<div class="empty">Escolha uma loja.</div>'; return; }
    view.innerHTML = '<div class="page-head"><div><h1>⚔️ Concorrentes</h1><div class="sub">' + esc(state.loja) + ' · comparação automática de preço + análise</div></div>' +
      (EXPORT || window.__HOSTED__ || window.__PUBLICO__ ? "" : '<button class="btn" id="ccAddBtn">➕ Registrar oferta</button>') + "</div>" +
      '<div id="ccAdd" hidden></div><div id="ccBody"><div class="empty">Carregando…</div></div>';
    var addBtn = view.querySelector("#ccAddBtn");
    if (addBtn) addBtn.addEventListener("click", function () {
      var box = view.querySelector("#ccAdd");
      box.hidden = !box.hidden;
      if (!box.hidden && !box.innerHTML) { box.innerHTML = concAddHtml(); wireConcAdd(); }
    });
    getJSON("/api/concorrencia/" + encodeURIComponent(state.loja)).then(function (d) {
      state.concData = d;
      view.querySelector("#ccBody").innerHTML = concorrentesHtml(d);
    }).catch(function (e) {
      view.querySelector("#ccBody").innerHTML = '<div class="result err">' + esc((e.body && e.body.erro) || e.message) + "</div>";
    });
  }
  function concConcorrentesOpts() {
    var cfg = (state.lojas || []).length ? null : null;
    var nomes = (state.concData && state.concData.concorrentes || []).map(function (c) { return c.concorrente; });
    if (!nomes.length) nomes = ["Rede Inova / Farmácia Circulista", "Farmácias Lavagnoli", "Farmácia Indiana Baixo Guandu"];
    return nomes.map(function (n) { return '<option>' + esc(n) + "</option>"; }).join("") + '<option>Outro</option>';
  }
  function concAddHtml() {
    return '<div class="card form-card" style="margin-bottom:14px"><div class="tabs" id="ccMode">' +
      '<button data-cm="form" class="active">Uma oferta</button><button data-cm="colar">Colar encarte / post</button></div>' +
      '<div id="ccModeBody">' + concFormHtml() + "</div></div>";
  }
  function concFormHtml() {
    return '<form id="ccForm"><div class="rowf">' +
      '<div><label class="f">Concorrente</label><select class="inp" name="concorrente">' + concConcorrentesOpts() + "</select></div>" +
      '<div><label class="f">Produto</label><input class="inp" name="produto" placeholder="ex.: Fralda Pampers XXG 60un" required></div>' +
      '</div><div class="rowf">' +
      '<div><label class="f">Preço deles (R$)</label><input class="inp" name="preco_promo" type="number" step="0.01" required></div>' +
      '<div><label class="f">Preço normal (opcional)</label><input class="inp" name="preco_normal" type="number" step="0.01"></div>' +
      '<div><label class="f">Categoria (opcional)</label><input class="inp" name="categoria" placeholder="Fraldas"></div>' +
      '</div><div class="rowf">' +
      '<div><label class="f">Validade (opcional)</label><input class="inp" name="validade" placeholder="até 10/09/2026"></div>' +
      '<div><label class="f">Confiança</label><select class="inp" name="nivel_confianca"><option>Alta</option><option selected>Média</option><option>Baixa</option></select></div>' +
      '</div><button class="btn" type="submit">Salvar (vale p/ as 2 lojas)</button><div id="ccFormOut" class="result" hidden></div></form>';
  }
  function concColarHtml() {
    return '<form id="ccColar"><div class="rowf">' +
      '<div><label class="f">Concorrente</label><select class="inp" name="concorrente">' + concConcorrentesOpts() + "</select></div>" +
      '<div><label class="f">Categoria (opcional, p/ todas)</label><input class="inp" name="categoria" placeholder="Limpeza"></div></div>' +
      '<label class="f">Cole o texto do post / encarte (uma oferta por linha, ex.: "OMO 500g R$ 9,90")</label>' +
      '<textarea class="inp" name="texto" rows="7" placeholder="LAVA ROUPAS OMO 500G  9,90&#10;DETERGENTE YPÊ 500ML  2,49&#10;..."></textarea>' +
      '<button class="btn secondary" type="submit" style="margin-top:10px">Interpretar</button>' +
      '<div id="ccColarPrev"></div></form>';
  }
  function wireConcAdd() {
    view.querySelectorAll("#ccMode [data-cm]").forEach(function (b) {
      b.addEventListener("click", function () {
        view.querySelectorAll("#ccMode [data-cm]").forEach(function (x) { x.classList.toggle("active", x === b); });
        view.querySelector("#ccModeBody").innerHTML = b.getAttribute("data-cm") === "colar" ? concColarHtml() : concFormHtml();
        wireConcForms();
      });
    });
    wireConcForms();
  }
  function wireConcForms() {
    var L = encodeURIComponent(state.loja);
    var f = view.querySelector("#ccForm");
    if (f) f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var o = {}; ["concorrente", "produto", "preco_promo", "preco_normal", "categoria", "validade", "nivel_confianca"].forEach(function (k) { var v = f[k].value.trim(); if (v) o[k] = k.indexOf("preco") === 0 ? Number(v) : v; });
      var out = view.querySelector("#ccFormOut");
      try {
        var r = await fetch("/api/concorrencia/" + L + "/ofertas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) }).then(function (x) { return x.json(); });
        if (r.erro) throw new Error(r.erro);
        out.className = "result ok"; out.textContent = "Salvo em " + r.aplicadas.map(function (a) { return a.loja; }).join(" e ") + ". Recalculando…"; out.hidden = false;
        setTimeout(function () { renderConcorrentes(); }, 900);
      } catch (err) { out.className = "result err"; out.textContent = err.message; out.hidden = false; }
    });
    var c = view.querySelector("#ccColar");
    if (c) c.addEventListener("submit", async function (e) {
      e.preventDefault();
      var prev = view.querySelector("#ccColarPrev");
      prev.innerHTML = '<div class="empty">interpretando…</div>';
      try {
        var r = await fetch("/api/concorrencia/" + L + "/colar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto: c.texto.value, concorrente: c.concorrente.value, categoria: c.categoria.value.trim() || null }) }).then(function (x) { return x.json(); });
        if (!r.ofertas.length) { prev.innerHTML = '<div class="empty">Não achei linhas com preço. Formato: nome + preço no fim da linha.</div>'; return; }
        prev.innerHTML = '<table class="tbl mobile-cards" style="margin-top:10px"><thead><tr><th>Produto</th><th class="num">Deles</th><th class="num">Nós</th><th>Abaixo?</th></tr></thead><tbody>' +
          r.ofertas.map(function (o) { return '<tr><td>' + esc(o.produto) + '</td><td class="num" data-l="Deles">R$ ' + brl(o.preco_promo) + '</td><td class="num" data-l="Nós">' + (o.nosso_preco_medio ? "R$ " + brl(o.nosso_preco_medio) : "—") + '</td><td data-l="Abaixo?">' + (o.abaixo_do_nosso == null ? "—" : o.abaixo_do_nosso ? "sim" : "não") + "</td></tr>"; }).join("") +
          '</tbody></table><button class="btn" id="ccColarSave" style="margin-top:10px">Salvar ' + r.ofertas.length + " ofertas</button>";
        view.querySelector("#ccColarSave").addEventListener("click", async function () {
          this.disabled = true; this.textContent = "Salvando…";
          try {
            await fetch("/api/concorrencia/" + L + "/ofertas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concorrente: c.concorrente.value, categoria: c.categoria.value.trim() || null, ofertas: r.ofertas }) });
            renderConcorrentes();
          } catch (er) { this.textContent = "Falhou: " + er.message; }
        });
      } catch (err) { prev.innerHTML = '<div class="result err">' + esc(err.message) + "</div>"; }
    });
  }
  function pressPill(p) {
    var c = p === "ALTA" ? "var(--down)" : p === "MÉDIA" || p === "MEDIA" ? "var(--warn)" : "var(--muted)";
    return '<span class="tag" style="background:' + c + ';color:#fff">' + esc(p) + "</span>";
  }
  function concorrentesHtml(d) {
    if (!d || d.erro) return '<div class="empty">' + esc((d && d.erro) || "erro") + "</div>";
    if (d.pendente) {
      return '<div class="card"><div class="empty" style="padding:18px 6px">' + esc(d.nota) + "</div>" +
        (d.concorrentes && d.concorrentes.length ? '<table class="tbl mobile-cards"><thead><tr><th>Concorrente</th><th>Perfil</th><th>Nota</th></tr></thead><tbody>' +
          d.concorrentes.map(function (c) { return '<tr><td data-l="Concorrente">' + esc(c.concorrente) + '</td><td data-l="Perfil">' + esc(c.handle || "—") + '</td><td data-l="Nota">' + esc(c.nota || "—") + "</td></tr>"; }).join("") + "</tbody></table>" : "") + "</div>";
    }
    var pa = d.panorama;
    var out = "";
    // panorama
    out += '<div class="cc-kpis">' +
      ccKpi("Ofertas coletadas", int(pa.total_ofertas)) +
      ccKpi("Comparáveis c/ nosso preço", int(pa.comparaveis)) +
      ccKpi("Abaixo do nosso", int(pa.abaixo_do_nosso), pa.abaixo_do_nosso > 0 ? "var(--down)" : null) +
      ccKpi("Mais barato em média", pa.desconto_medio_vs_nosso_pct == null ? "—" : "−" + pa.desconto_medio_vs_nosso_pct + "%") +
      "</div>";
    // resumo + ações
    out += '<div class="card cc-resumo"><div class="chead"><div class="ci red">🧭</div><div><h3>Leitura automática</h3></div></div>' +
      "<ul>" + (d.resumo || []).map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" +
      (d.acoes && d.acoes.length ? '<div class="cc-acoes"><b>Ações sugeridas</b><ul>' + d.acoes.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul></div>" : "") + "</div>";
    // onde reagir
    var reagir = (d.onde_reagir || []).filter(function (r) { return r.score >= 30; });
    out += '<div class="card"><div class="chead"><div class="ci gold">🎯</div><div><h3>Onde reagir</h3><div class="cs">produto que eles baixaram e a gente vende — priorizado por volume × desconto × se dá pra cobrir</div></div></div>' +
      (reagir.length ? '<table class="tbl mobile-cards"><thead><tr><th>Produto</th><th>Concorrente</th><th class="num">Eles</th><th class="num">Nós</th><th class="num">Dif.</th><th class="num">Nosso giro 30d</th><th>Margem</th><th>Veredito</th></tr></thead><tbody>' +
        reagir.map(function (r) {
          return "<tr><td data-l=\"Produto\">" + esc(r.produto) + (r.nossa_classe ? ' <span class="chip">' + esc(r.nossa_classe) + "</span>" : "") + "</td>" +
            '<td data-l="Concorrente">' + esc(r.concorrente) + (r.confianca ? ' <span class="cs">(' + esc(r.confianca) + ")</span>" : "") + "</td>" +
            '<td class="num" data-l="Eles">R$ ' + brl(r.preco_deles) + "</td>" +
            '<td class="num" data-l="Nós">' + (r.nosso_preco == null ? "—" : "R$ " + brl(r.nosso_preco)) + "</td>" +
            '<td class="num" data-l="Dif." style="color:var(--down)">' + (r.diff_pct == null ? "—" : "−" + r.diff_pct + "%") + "</td>" +
            '<td class="num" data-l="Giro 30d">' + (r.nossa_receita_30d == null ? "—" : "R$ " + brl(r.nossa_receita_30d)) + "</td>" +
            '<td data-l="Margem">' + (r.nossa_margem_pct == null ? '<span class="cs">s/ custo</span>' : pct(r.nossa_margem_pct * 100)) + "</td>" +
            '<td data-l="Veredito">' + esc(r.veredito) +
              (r.reagir_com ? '<div class="cs" style="margin-top:3px;color:var(--s1)">🏷️ reagir a <b>R$ ' + brl(r.reagir_com.preco_recomendado) + "</b> (-" + r.reagir_com.desconto_pct + "%) · margem " +
                (r.reagir_com.margem_pct_na_promo == null ? "—" : Math.round(r.reagir_com.margem_pct_na_promo * 100) + "%") +
                (r.reagir_com.cobre_o_concorrente === false ? " · <b>não chega</b> no preço deles sem furar a margem" : r.reagir_com.cobre_o_concorrente === true ? " · cobre o preço deles" : "") + "</div>" : "") +
              (r.contra_ataque ? '<div class="cs" style="margin-top:3px;color:var(--brand-2)">→ promover no lugar: <b>' + esc(r.contra_ataque.produto) + "</b> <span class=\"cs\">(" + esc(r.contra_ataque.motivo) + ")</span></div>" : "") +
            "</td></tr>";
        }).join("") + "</tbody></table>" : '<div class="empty">Nada relevante para reagir — eles não baixaram nada que a gente venda em volume.</div>') + "</div>";
    // por concorrente
    out += '<div class="card"><div class="chead"><div class="ci conc">🏬</div><div><h3>Por concorrente</h3></div></div>' +
      d.concorrentes.map(function (c) {
        return '<div class="cc-conc">' +
          '<div class="cc-conc-h"><b>' + esc(c.concorrente) + "</b>" + (c.handle ? ' <span class="cs">' + esc(c.handle) + "</span>" : "") +
          (c.temColeta ? '<span class="tag" style="margin-left:auto">' + c.abaixo + " abaixo · " + c.ofertas + " ofertas</span>" : '<span class="tag conf-baixa" style="margin-left:auto">sem coleta</span>') + "</div>" +
          (c.nota ? '<div class="cs">' + esc(c.nota) + "</div>" : "") +
          (c.categorias_atacadas && c.categorias_atacadas.length ? '<div class="cs" style="margin-top:4px">Ataca: ' + c.categorias_atacadas.map(esc).join(", ") + "</div>" : "") +
          (c.exemplos && c.exemplos.length ? '<ul class="cc-ex">' + c.exemplos.map(function (e) { return "<li>" + esc(e.produto) + " — <b>R$ " + brl(e.preco_deles) + "</b>" + (e.diff_pct != null ? ' <span style="color:var(--down)">(−' + e.diff_pct + "%)</span>" : "") + (e.nosso ? " vs nosso R$ " + brl(e.nosso) : "") + "</li>"; }).join("") + "</ul>" : "") +
          "</div>";
      }).join("") + "</div>";
    // share of promotions
    if (d.share_promocoes) {
      var sp = d.share_promocoes;
      var spVerCor = function (v) {
        return /^subcomunicando/.test(v) ? "var(--down)" : /reavaliar prioridade/.test(v) ? "#c98a00" : /comunicando forte/.test(v) ? "var(--ink-2)" : "var(--muted)";
      };
      out += '<div class="card"><div class="chead"><div class="ci red">📣</div><div><h3>Share of Promotions</h3><div class="cs">nossa ação promocional × ofertas do concorrente, por categoria · fonte: ' + esc(sp.fonte_nossas) + '</div></div></div>' +
        '<ul style="margin:0 0 10px 18px">' + sp.resumo.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" +
        '<div class="cs" style="margin-bottom:8px">Ofertas na coleta — ' + sp.por_concorrente.map(function (c) { return esc(c.concorrente) + ": <b>" + int(c.ofertas) + "</b>"; }).join(" · ") + "</div>" +
        '<table class="tbl mobile-cards"><thead><tr><th>Categoria</th><th class="num">Nossa ação</th><th class="num">Ofertas deles</th><th class="num">Abaixo do nosso</th><th>Pressão</th><th>Leitura</th></tr></thead><tbody>' +
        sp.por_categoria.slice(0, 14).map(function (c) {
          var ex = (c.nossas_exemplos || []).map(function (x) { return esc(x.descricao) + (x.preco_promo ? " R$ " + brl(x.preco_promo) : x.desconto_pct ? " -" + Math.round(x.desconto_pct * 100) + "%" : ""); }).join(" · ");
          return "<tr><td data-l=\"Categoria\">" + esc(c.categoria) + (ex ? '<div class="cs">' + ex + "</div>" : "") + "</td>" +
            '<td class="num" data-l="Nossa ação">' + (c.nossas_promocoes ? int(c.nossas_promocoes) + " na tabela" : c.promo_recorrente ? "recorrente" : "—") + "</td>" +
            '<td class="num" data-l="Ofertas deles">' + int(c.ofertas_concorrentes) + "</td>" +
            '<td class="num" data-l="Abaixo">' + int(c.ofertas_abaixo_do_nosso) + "</td>" +
            '<td data-l="Pressão">' + pressPill(c.pressao) + "</td>" +
            '<td data-l="Leitura"><span style="color:' + spVerCor(c.veredito) + '">' + esc(c.veredito) + "</span></td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    // por categoria
    out += '<div class="card"><div class="chead"><div class="ci cat">📊</div><div><h3>Pressão por categoria</h3></div></div>' +
      (d.categorias.length ? '<table class="tbl mobile-cards"><thead><tr><th>Categoria</th><th class="num">Ofertas</th><th class="num">Abaixo</th><th class="num">Desc. médio</th><th class="num">Nossa tendência</th><th>Pressão</th></tr></thead><tbody>' +
        d.categorias.map(function (c) {
          return "<tr><td data-l=\"Categoria\">" + esc(c.categoria) + '</td><td class="num" data-l="Ofertas">' + int(c.ofertas) + '</td><td class="num" data-l="Abaixo">' + int(c.abaixo) + '</td>' +
            '<td class="num" data-l="Desc">' + (c.desconto_medio_vs_nosso_pct == null ? "—" : "−" + c.desconto_medio_vs_nosso_pct + "%") + '</td>' +
            '<td class="num" data-l="Tendência">' + (c.nossa_tendencia_pct == null ? "—" : (c.nossa_tendencia_pct > 0 ? "+" : "") + c.nossa_tendencia_pct + "%") + '</td>' +
            '<td data-l="Pressão">' + pressPill(c.pressao) + "</td></tr>";
        }).join("") + "</tbody></table>" : '<div class="empty">Sem categoria com dados.</div>') + "</div>";
    return out;
  }
  function ccKpi(label, val, cor) {
    return '<div class="cc-kpi"><span>' + esc(label) + '</span><b' + (cor ? ' style="color:' + cor + '"' : "") + ">" + val + "</b></div>";
  }

  // ---------- nav ----------
  var VIEWS = ["command", "painel", "marketing", "concorrentes", "intelligence", "conexoes", "analise", "upload", "historico", "config"];
  function go(v) {
    state.view = v;
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === v); });
    if (v === "command") renderCommand();
    else if (v === "painel") { if (state.data) renderPainel(); else loadAnalise(); }
    else if (v === "marketing") { mkt.cache = {}; renderMarketing(); }
    else if (v === "concorrentes") renderConcorrentes();
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
      if (state.view === "command") { renderCommand(); loadPeriodos(); }
      else if (state.view === "analise") { renderAnalise(); loadPeriodos(); }
      else if (state.view === "conexoes") { renderConexoes(); loadPeriodos(); }
      else if (state.view === "marketing") { mkt.cache = {}; loadPeriodos().then(function () { renderMarketing(); }); }
      else if (state.view === "intelligence") { itl.cache = {}; loadPeriodos().then(function () { renderIntelligence(); }); }
      else if (state.view === "concorrentes") { loadPeriodos().then(function () { renderConcorrentes(); }); }
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
      if ((window.__PUBLICO__ || window.__HOSTED__) && typeof window.__gateLogout__ === "function") { window.__gateLogout__(); return; }
      fetch("/logout", { method: "POST" }).then(function () { location.href = "/login"; });
    });
    document.querySelectorAll(".nav a").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); location.hash = a.getAttribute("data-view"); });
    });
    window.addEventListener("hashchange", function () {
      var v = (location.hash || "#command").slice(1);
      if (VIEWS.indexOf(v) >= 0) go(v);
    });
    loadLojas().then(function () {
      var v = (location.hash || "#command").slice(1);
      go(VIEWS.indexOf(v) >= 0 ? v : "command");
    }).catch(function (e) {
      if (e.status === 401) { location.href = "/login"; return; }
      view.innerHTML = '<div class="empty">Erro ao iniciar: ' + esc(e.message) + "</div>";
    });
  }
})();
