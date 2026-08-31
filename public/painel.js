/* Painel Vermelhinha — funções de render portadas de Vermelhinha_em_Numeros_Agosto2026.html.
   Única mudança de fundo: os dados vêm de fetch('/api/analise/{loja}/{periodo}') em vez de
   arrays fixos. As funções de desenho (linha diária, barras por dia da semana, barra
   empilhada de categorias, tabela de top produtos, KPIs de Instagram) são as mesmas. */
(function () {
  "use strict";

  var fmtBRL = function (v, decimals) {
    decimals = decimals === undefined ? 2 : decimals;
    return (v == null ? 0 : v).toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };
  var fmtInt = function (v) { return (v == null ? 0 : v).toLocaleString("pt-BR"); };

  var SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function niceCeil(v) {
    if (v <= 0) return 1;
    var t = v * 1.08;
    var mag = Math.pow(10, Math.floor(Math.log10(t)));
    var step = mag / 2;
    return Math.ceil(t / step) * step;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ============ TOOLTIP ============ */
  var tooltipEl = document.getElementById("tooltip");
  function showTooltip(x, y) {
    tooltipEl.innerHTML = "";
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
    tooltipEl.classList.add("show");
  }
  function hideTooltip() { tooltipEl.classList.remove("show"); }
  function ttRow(label, val) {
    var row = document.createElement("div");
    row.className = "tt-row";
    var l = document.createElement("span"); l.textContent = label;
    var v = document.createElement("span"); v.className = "tt-val"; v.textContent = val;
    row.appendChild(l); row.appendChild(v);
    return row;
  }
  function ttTitle(text) {
    var t = document.createElement("div"); t.className = "tt-title"; t.textContent = text;
    return t;
  }

  /* ============ LINE CHART: faturamento diário ============ */
  function renderDailyChart(daily) {
    var vizHost = document.getElementById("chart-daily-viz");
    var tableHost = document.getElementById("chart-daily-table");
    clear(vizHost); clear(tableHost);

    var plot = daily.filter(function (d) { return !d.parcial; });
    if (plot.length < 2) plot = daily.slice();

    var W = 900, H = 280, padL = 46, padR = 16, padT = 16, padB = 28;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxV = niceCeil(Math.max.apply(null, plot.map(function (p) { return p.v; })));
    var svg = el("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Faturamento diário" });

    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var yv = maxV * i / ticks;
      var y = padT + plotH - (yv / maxV) * plotH;
      svg.appendChild(el("line", { class: "grid-line", x1: padL, x2: W - padR, y1: y, y2: y }));
      var lbl = el("text", { class: "axis-label", x: 4, y: y + 3 });
      lbl.textContent = (yv / 1000).toFixed(0) + " mil";
      svg.appendChild(lbl);
    }
    svg.appendChild(el("line", { class: "axis-line", x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH }));

    function xFor(idx) { return padL + (idx / (plot.length - 1)) * plotW; }
    function yFor(v) { return padT + plotH - (v / maxV) * plotH; }

    var step = Math.max(1, Math.round((plot.length - 1) / 6));
    for (var t = 0; t < plot.length; t += step) {
      var tx = el("text", { class: "axis-label", x: xFor(t), y: H - 6, "text-anchor": "middle" });
      tx.textContent = plot[t].d + "/" + String(plot[t].data ? +plot[t].data.slice(5, 7) : "");
      svg.appendChild(tx);
    }

    var path = "M";
    plot.forEach(function (pt, idx) {
      path += (idx === 0 ? "" : " L") + xFor(idx).toFixed(1) + " " + yFor(pt.v).toFixed(1);
    });
    var areaPath = path + " L" + xFor(plot.length - 1).toFixed(1) + " " + (padT + plotH) +
      " L" + xFor(0).toFixed(1) + " " + (padT + plotH) + " Z";
    svg.appendChild(el("path", { d: areaPath, fill: "var(--s1)", opacity: 0.1 }));
    svg.appendChild(el("path", { d: path, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

    var peakIdx = 0;
    plot.forEach(function (p, i) { if (p.v > plot[peakIdx].v) peakIdx = i; });
    var px = xFor(peakIdx), py = yFor(plot[peakIdx].v);
    svg.appendChild(el("circle", { cx: px, cy: py, r: 5, fill: "var(--brand)", stroke: "var(--chart-surface)", "stroke-width": 2 }));
    var peakLbl = el("text", { class: "peak-label", x: px, y: py - 12, "text-anchor": "middle" });
    peakLbl.textContent = "R$ " + (plot[peakIdx].v / 1000).toFixed(1).replace(".", ",") + " mil";
    svg.appendChild(peakLbl);

    plot.forEach(function (pt, idx) {
      var hit = el("rect", { x: xFor(idx) - (plotW / (plot.length - 1)) / 2, y: padT, width: plotW / (plot.length - 1), height: plotH, fill: "transparent" });
      hit.addEventListener("pointerenter", function () {
        svg.querySelectorAll(".crosshair").forEach(function (n) { n.remove(); });
        var cx = xFor(idx);
        svg.appendChild(el("line", { class: "crosshair", x1: cx, x2: cx, y1: padT, y2: padT + plotH, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "2,3" }));
        var rect = svg.getBoundingClientRect();
        var scale = rect.width / W;
        showTooltip(rect.left + cx * scale, rect.top + yFor(pt.v) * scale);
        tooltipEl.appendChild(ttTitle("Dia " + pt.d));
        tooltipEl.appendChild(ttRow("Faturamento", "R$ " + fmtBRL(pt.v)));
        tooltipEl.appendChild(ttRow("Vendas", fmtInt(pt.n)));
      });
      hit.addEventListener("pointerleave", function () {
        svg.querySelectorAll(".crosshair").forEach(function (n) { n.remove(); });
        hideTooltip();
      });
      svg.appendChild(hit);
    });
    vizHost.appendChild(svg);

    var tbl = document.createElement("table");
    tbl.className = "data";
    tbl.innerHTML = '<thead><tr><th>Dia</th><th class="num">Faturamento</th><th class="num">Vendas</th></tr></thead>';
    var tbody = document.createElement("tbody");
    daily.forEach(function (pt) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + pt.d + (pt.parcial ? ' <span class="badge-parcial">parcial</span>' : "") +
        '</td><td class="num tab">R$ ' + fmtBRL(pt.v) + '</td><td class="num tab">' + fmtInt(pt.n) + "</td>";
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    tableHost.appendChild(tbl);
  }

  /* ============ BAR CHART: por dia da semana ============ */
  function renderWeekdayChart(weekday) {
    var vizHost = document.getElementById("chart-weekday-viz");
    var tableHost = document.getElementById("chart-weekday-table");
    clear(vizHost); clear(tableHost);

    var W = 460, H = 260, padL = 42, padR = 10, padT = 14, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxV = niceCeil(Math.max.apply(null, weekday.map(function (w) { return w.v; })));
    var svg = el("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Faturamento por dia da semana" });

    var ticks = 3;
    for (var i = 0; i <= ticks; i++) {
      var yv = maxV * i / ticks;
      var y = padT + plotH - (yv / maxV) * plotH;
      svg.appendChild(el("line", { class: "grid-line", x1: padL, x2: W - padR, y1: y, y2: y }));
      var lbl = el("text", { class: "axis-label", x: 4, y: y + 3 });
      lbl.textContent = (yv / 1000).toFixed(0) + "k";
      svg.appendChild(lbl);
    }
    svg.appendChild(el("line", { class: "axis-line", x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH }));

    var n = weekday.length;
    var band = plotW / n;
    var barW = Math.min(28, band * 0.55);
    weekday.forEach(function (w) {
      var idx = weekday.indexOf(w);
      var cx = padL + band * idx + band / 2;
      var h = (w.v / maxV) * plotH;
      var y = padT + plotH - h;
      var bar = el("rect", { x: cx - barW / 2, y: y, width: barW, height: h, rx: 4, fill: "var(--s1)" });
      svg.appendChild(bar);
      var lbl = el("text", { class: "axis-label", x: cx, y: H - 6, "text-anchor": "middle" });
      lbl.textContent = w.label.slice(0, 3);
      svg.appendChild(lbl);

      var hit = el("rect", { x: padL + band * idx, y: padT, width: band, height: plotH, fill: "transparent" });
      hit.addEventListener("pointerenter", (function (w, bar) {
        return function () {
          bar.setAttribute("fill", "var(--brand)");
          var rect = svg.getBoundingClientRect();
          var scale = rect.width / W;
          var bx = parseFloat(bar.getAttribute("x")) + barW / 2;
          var by = parseFloat(bar.getAttribute("y"));
          showTooltip(rect.left + bx * scale, rect.top + by * scale);
          tooltipEl.appendChild(ttTitle(w.label));
          tooltipEl.appendChild(ttRow("Faturamento", "R$ " + fmtBRL(w.v)));
          tooltipEl.appendChild(ttRow("Vendas", fmtInt(w.n)));
          tooltipEl.appendChild(ttRow("Ticket médio", "R$ " + fmtBRL(w.n ? w.v / w.n : 0)));
        };
      })(w, bar));
      hit.addEventListener("pointerleave", (function (bar) {
        return function () { bar.setAttribute("fill", "var(--s1)"); hideTooltip(); };
      })(bar));
      svg.appendChild(hit);
    });
    vizHost.appendChild(svg);

    var tbl = document.createElement("table");
    tbl.className = "data";
    tbl.innerHTML = '<thead><tr><th>Dia</th><th class="num">Faturamento</th><th class="num">Vendas</th><th class="num">Ticket médio</th></tr></thead>';
    var tbody = document.createElement("tbody");
    weekday.forEach(function (w) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + w.label + '</td><td class="num tab">R$ ' + fmtBRL(w.v) + '</td><td class="num tab">' + fmtInt(w.n) +
        '</td><td class="num tab">R$ ' + fmtBRL(w.n ? w.v / w.n : 0) + "</td>";
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    tableHost.appendChild(tbl);
  }

  /* ============ STACKED BAR: categorias ============ */
  function renderCategoryChart(categories) {
    var vizHost = document.getElementById("chart-category-viz");
    var tableHost = document.getElementById("chart-category-table");
    clear(vizHost); clear(tableHost);

    var total = categories.reduce(function (s, c) { return s + c.v; }, 0) || 1;
    var bar = document.createElement("div");
    bar.className = "stackbar";
    categories.forEach(function (c) {
      var pct = c.v / total * 100;
      var seg = document.createElement("div");
      seg.className = "seg";
      seg.style.width = pct + "%";
      seg.style.background = c.color;
      if (pct > 7) {
        var lab = document.createElement("span");
        lab.className = "seg-label";
        lab.textContent = pct.toFixed(0) + "%";
        seg.appendChild(lab);
      }
      seg.addEventListener("pointerenter", (function (c, pct) {
        return function (ev) {
          showTooltip(ev.clientX, ev.clientY);
          tooltipEl.appendChild(ttTitle(c.label));
          tooltipEl.appendChild(ttRow("Receita", "R$ " + fmtBRL(c.v)));
          tooltipEl.appendChild(ttRow("Participação", pct.toFixed(1) + "%"));
        };
      })(c, pct));
      seg.addEventListener("pointermove", function (ev) {
        tooltipEl.style.left = ev.clientX + "px";
        tooltipEl.style.top = ev.clientY + "px";
      });
      seg.addEventListener("pointerleave", hideTooltip);
      bar.appendChild(seg);
    });
    vizHost.appendChild(bar);

    var legend = document.createElement("div");
    legend.className = "legend";
    categories.forEach(function (c) {
      var item = document.createElement("div");
      item.className = "legend-item";
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = c.color;
      var txt = document.createElement("span");
      txt.textContent = c.label + " — " + (c.v / total * 100).toFixed(1) + "%";
      item.appendChild(sw); item.appendChild(txt);
      legend.appendChild(item);
    });
    vizHost.appendChild(legend);

    var tbl = document.createElement("table");
    tbl.className = "data";
    tbl.innerHTML = '<thead><tr><th>Categoria</th><th class="num">Receita</th><th class="num">%</th></tr></thead>';
    var tbody = document.createElement("tbody");
    categories.forEach(function (c) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + c.label + '</td><td class="num tab">R$ ' + fmtBRL(c.v) + '</td><td class="num tab">' + (c.v / total * 100).toFixed(1) + "%</td>";
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    tableHost.appendChild(tbl);
  }

  /* ============ TOP PRODUCTS TABLE ============ */
  function renderTopProducts(topProducts, categories) {
    var catByLabel = {};
    categories.forEach(function (c) { catByLabel[c.label.split(" / ")[0]] = c; });
    var tbody = document.querySelector("#table-top-products tbody");
    clear(tbody);
    topProducts.forEach(function (p) {
      var c = catByLabel[p.cat.split(" / ")[0]];
      var tr = document.createElement("tr");
      var tdName = document.createElement("td"); tdName.textContent = p.name;
      var tdCat = document.createElement("td");
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.style.background = "color-mix(in srgb, " + (c ? c.color : "var(--muted)") + " 16%, transparent)";
      chip.style.color = "var(--ink-2)";
      var dot = document.createElement("span"); dot.className = "dot"; dot.style.background = c ? c.color : "var(--muted)";
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(p.cat));
      tdCat.appendChild(chip);
      var tdVal = document.createElement("td"); tdVal.className = "num tab"; tdVal.textContent = "R$ " + fmtBRL(p.v);
      tr.appendChild(tdName); tr.appendChild(tdCat); tr.appendChild(tdVal);
      tbody.appendChild(tr);
    });
  }

  /* ============ INSTAGRAM KPI ============ */
  function renderInstagram(instagram) {
    var grid = document.getElementById("ig-grid");
    var empty = document.getElementById("ig-empty");
    clear(grid);
    if (!instagram || !instagram.length) { grid.hidden = true; empty.hidden = false; return; }
    grid.hidden = false; empty.hidden = true;
    instagram.forEach(function (m) {
      var card = document.createElement("div");
      card.className = "card stat";
      var hasDelta = m.delta !== null && m.delta !== undefined;
      var up = hasDelta && m.delta >= 0;
      card.innerHTML =
        '<div class="label">' + m.label + "</div>" +
        '<div class="value tab">' + m.value + "</div>" +
        (hasDelta
          ? '<div class="delta ' + (up ? "up" : "down") + '">' + (up ? "▲" : "▼") + " " +
            Math.abs(m.delta).toFixed(1).replace(".", ",") + "% <span class=\"vs\">vs. período anterior</span></div>"
          : "") +
        (m.extra ? '<div class="foot">' + m.extra + "</div>" : "");
      grid.appendChild(card);
    });
  }

  /* ============ KPIs de vendas ============ */
  function renderKpis(k) {
    var grid = document.getElementById("kpi-grid");
    clear(grid);
    var tiles = [
      { label: "Faturamento do mês", value: "R$ " + fmtBRL(k.faturamento), foot: "soma líquida de todos os lançamentos" },
      { label: "Ticket médio", value: "R$ " + fmtBRL(k.ticketMedio), foot: "por venda (Nº de lançamento único)" },
      { label: "Vendas realizadas", value: fmtInt(k.vendas), foot: fmtInt(k.itens) + " itens vendidos no total" },
      { label: "À vista", value: fmtBRL(k.aVistaPct, 1) + "%", foot: "R$ " + fmtBRL(k.aPrazoValor) + " (" + fmtBRL(k.aPrazoPct, 1) + "%) foi a prazo" },
    ];
    tiles.forEach(function (t) {
      var d = document.createElement("div");
      d.className = "card stat";
      d.innerHTML = '<div class="label">' + t.label + '</div><div class="value tab">' + t.value + '</div><div class="foot">' + t.foot + "</div>";
      grid.appendChild(d);
    });
  }

  /* ============ Insights ============ */
  function renderInsights(insights) {
    var section = document.getElementById("insights-section");
    var grid = document.getElementById("insight-grid");
    clear(grid);
    if (!insights || !insights.length) { section.hidden = true; return; }
    section.hidden = false;
    insights.forEach(function (c) {
      var card = document.createElement("div");
      card.className = "card insight-card";
      card.innerHTML = '<div class="icon">' + (c.icon || "◆") + '</div><h3>' + c.title + "</h3><p>" + c.body + "</p>";
      grid.appendChild(card);
    });
  }

  /* ============ Concorrência ============ */
  function renderConcorrencia(conc) {
    var titulo = document.getElementById("conc-titulo");
    var sub = document.getElementById("conc-sub");
    var body = document.getElementById("conc-body");
    clear(body);

    if (!conc || conc.pending) {
      titulo.textContent = "Comparação de preços — pendente";
      sub.textContent = "aguardando nova coleta (Concorrentes_Coleta_AAAA-MM-DD.xlsx)";
      var grid = document.createElement("div");
      grid.className = "grid comp-grid";
      (conc && conc.competitors ? conc.competitors : []).forEach(function (c) {
        var card = document.createElement("div");
        card.className = "card comp-card";
        card.innerHTML =
          '<div class="name">' + (c.nome || "") + "</div>" +
          (c.handle ? '<div class="handle">' + c.handle + "</div>" : "") +
          (c.nota ? '<div class="note">' + c.nota + "</div>" : "") +
          '<div class="pending-chip">Sem coleta recente</div>';
        grid.appendChild(card);
      });
      body.appendChild(grid);
      return;
    }

    titulo.textContent = "Comparação de preços";
    sub.textContent = conc.totalOfertas + " ofertas confirmadas e vigentes na última coleta";

    var summary = document.createElement("div");
    summary.className = "conc-summary";
    summary.innerHTML =
      "<div><strong>" + conc.abaixoDoNosso + "</strong> ofertas abaixo do nosso preço médio</div>" +
      "<div><strong>" + conc.comparaveis + "</strong> ofertas comparáveis (casaram com produto nosso)</div>" +
      "<div><strong>" + conc.totalOfertas + "</strong> ofertas no total</div>";
    body.appendChild(summary);

    var grid2 = document.createElement("div");
    grid2.className = "grid comp-grid";
    conc.porConcorrente.forEach(function (e) {
      var card = document.createElement("div");
      card.className = "card comp-card";
      var exemplos = (e.exemplos || []).map(function (x) {
        return "<li>" + x.produto + " — <strong>R$ " + fmtBRL(x.promo) + "</strong> vs. nosso R$ " + fmtBRL(x.nosso) + "</li>";
      }).join("");
      card.innerHTML =
        '<div class="name">' + e.concorrente + "</div>" +
        '<div class="note"><strong>' + e.abaixo + "</strong> de " + e.comparaveis + " ofertas comparáveis abaixo do nosso preço · " + e.ofertas + " ofertas coletadas</div>" +
        '<div class="conf-badges">' +
          '<span class="conf-badge">Alta: ' + e.confianca.Alta + "</span>" +
          '<span class="conf-badge">Média: ' + e.confianca["Média"] + "</span>" +
          '<span class="conf-badge">Baixa: ' + e.confianca.Baixa + "</span>" +
        "</div>" +
        (exemplos ? '<ul class="note" style="margin:6px 0 0;padding-left:16px">' + exemplos + "</ul>" : "");
      grid2.appendChild(card);
    });
    body.appendChild(grid2);
  }

  /* ============ TOGGLES ============ */
  function wireToggles() {
    document.querySelectorAll("[data-toggle]").forEach(function (btn) {
      if (btn._wired) return;
      btn._wired = true;
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-toggle");
        var viz = document.getElementById(key + "-viz");
        var table = document.getElementById(key + "-table");
        var showingTable = table.classList.toggle("show");
        viz.classList.toggle("hide", showingTable);
        btn.textContent = showingTable ? "Ver gráfico" : "Ver tabela";
        btn.setAttribute("aria-expanded", showingTable ? "true" : "false");
      });
    });
  }

  /* ============ BOOT / DATA ============ */
  var selLoja = document.getElementById("sel-loja");
  var selPeriodo = document.getElementById("sel-periodo");
  var painel = document.getElementById("painel");
  var emptyState = document.getElementById("empty-state");
  var LS = window.localStorage;

  function setEmpty(msg) {
    painel.hidden = true;
    emptyState.hidden = false;
    emptyState.innerHTML = msg + ' <br><br><a class="upload-link" href="/upload.html">+ Nova análise</a>';
  }

  async function getJSON(url) {
    var r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      var e = new Error("HTTP " + r.status);
      e.status = r.status;
      try { e.body = await r.json(); } catch (_) {}
      throw e;
    }
    return r.json();
  }

  function fmtPeriodoOption(p) {
    var meses = ["", "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return meses[p.mes] + "/" + p.ano;
  }

  var qs = new URLSearchParams(location.search);

  async function loadLojas() {
    var lojas = await getJSON("/api/lojas");
    clear(selLoja);
    lojas.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l.nome; o.textContent = l.nome;
      selLoja.appendChild(o);
    });
    var saved = qs.get("loja") || LS.getItem("va_loja");
    if (saved && lojas.some(function (l) { return l.nome === saved; })) selLoja.value = saved;
    await loadPeriodos();
  }

  async function loadPeriodos() {
    var loja = selLoja.value;
    LS.setItem("va_loja", loja);
    var periodos = await getJSON("/api/periodos/" + encodeURIComponent(loja));
    periodos = periodos.filter(function (p) { return p.temVendas; });
    clear(selPeriodo);
    if (!periodos.length) {
      setEmpty("Ainda não há análise para <strong>" + loja + "</strong>.");
      return;
    }
    periodos.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.periodo; o.textContent = fmtPeriodoOption(p);
      selPeriodo.appendChild(o);
    });
    var savedP = qs.get("periodo") || LS.getItem("va_periodo_" + loja);
    if (savedP && periodos.some(function (p) { return p.periodo === savedP; })) selPeriodo.value = savedP;
    qs.delete("periodo"); qs.delete("loja"); // só na primeira carga
    await loadAnalise();
  }

  async function loadAnalise() {
    var loja = selLoja.value, periodo = selPeriodo.value;
    if (!periodo) return;
    LS.setItem("va_periodo_" + loja, periodo);
    try {
      var d = await getJSON("/api/analise/" + encodeURIComponent(loja) + "/" + periodo);
      render(d);
    } catch (e) {
      setEmpty((e.body && e.body.erro ? e.body.erro : "Não foi possível carregar") + " para " + loja + " / " + periodo + ".");
    }
  }

  function render(d) {
    emptyState.hidden = true;
    painel.hidden = false;

    document.getElementById("wordmark").textContent = d.loja;
    document.getElementById("tag").textContent = d.loja === "Farma e Farma" ? "A Vermelhinha" : "";
    document.getElementById("topbar-meta").innerHTML =
      (d.meta.endereco ? d.meta.endereco + "<br>" : "") +
      "<strong>Vermelhinha em Números</strong> · vendas, redes sociais e concorrência";

    var parcialTxt = d.meta.diaParcial
      ? " · " + d.meta.diaParcial.dia + " é dia parcial (relatório gerado " +
        (d.meta.diaParcial.geradoEm || "").replace("T", " ") + ") e foi excluído do gráfico de tendência"
      : "";
    document.getElementById("period-label").innerHTML = "Período: <strong>" + d.meta.periodoLabel + "</strong>" + parcialTxt;
    document.getElementById("source-label").textContent = "Fonte: Analítico de Vendas (sistema) · Meta Business Suite (Instagram)";

    document.getElementById("vendas-titulo").textContent = d.meta.periodoLabel[0].toUpperCase() + d.meta.periodoLabel.slice(1) + " fechou em R$ " + fmtBRL(d.kpis.faturamento);
    document.getElementById("vendas-sub").textContent = fmtInt(d.kpis.vendas) + " vendas registradas no período";
    document.getElementById("daily-note").textContent = d.meta.diaParcial
      ? "Dia " + d.meta.diaParcial.dia.slice(8) + " está truncado no relatório — fica só na tabela, fora da linha de tendência."
      : "";
    document.getElementById("top-caption").textContent = "Valores líquidos somados em " + d.meta.periodoLabel + ".";
    document.getElementById("ig-titulo").textContent = "Instagram — " + d.meta.periodoLabel;

    renderKpis(d.kpis);
    renderDailyChart(d.daily);
    renderWeekdayChart(d.weekday);
    renderCategoryChart(d.categories);
    renderTopProducts(d.topProducts, d.categories);
    renderInsights(d.insights);
    renderInstagram(d.instagram);
    renderConcorrencia(d.concorrencia);
    wireToggles();

    document.getElementById("footer").textContent = d.meta.fonteNota +
      (d.meta.totalImpresso ? " Soma das transações conferida contra o Total impresso no PDF (R$ " + fmtBRL(d.meta.totalImpresso) + ")." : "") +
      " Painel gerado automaticamente a partir dos documentos enviados.";
  }

  selLoja.addEventListener("change", loadPeriodos);
  selPeriodo.addEventListener("change", loadAnalise);

  loadLojas().catch(function (e) {
    if (e.status === 401) { window.location.href = "/login"; return; }
    setEmpty("Erro ao iniciar: " + e.message);
  });
})();
