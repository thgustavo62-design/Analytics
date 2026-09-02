// Fase B — Campaign Builder 2.0 + Forecast de campanha inteira.
//
// montarCampanha(loja, { dias, tema, categorias, objetivo }) devolve uma campanha pronta:
//   - janela (dias da semana + duração + próximo período)
//   - elenco por papel (Fase A) com preço sugerido, ângulo (Fase B) e forecast por perna
//   - combos viáveis entre os produtos do elenco
//   - lista de evitar (do-not-promote)
//   - forecast da campanha inteira: 3 cenários (conservador / provável / agressivo),
//     margem incremental, estoque necessário, pernas sem estoque
//   - score_da_campanha 0–100 (cobertura de papéis + margem prevista + estoque + força da âncora)
//
// Determinístico. Sem custo → margem incremental fica null + flag. Nunca promete venda.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { papelDeProduto } = require("./roles");
const { subScores } = require("./scores");
const { angulosDeProduto } = require("./angulos");
const basket = require("../basket");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "campaign-plan.json"), "utf8"));
const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketing-stock.json"), "utf8"));
const PISO_MARGEM = CFG_STOCK.margem_pct_minima_para_anunciar != null ? CFG_STOCK.margem_pct_minima_para_anunciar : 0.1;
const DIA = 86400000;

const NOMES_DOW = { domingo: 0, segunda: 1, terca: 2, "terça": 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, "sábado": 6, dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };

function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function addDias(iso, n) { return new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10); }
function mediana(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function parseDias(dias) {
  if (Array.isArray(dias)) return [...new Set(dias.map(Number).filter((n) => n >= 0 && n <= 6))].sort();
  if (typeof dias === "string" && dias.trim()) {
    return [...new Set(dias.split(/[,\s]+/).map((t) => {
      const s = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
      return /^\d$/.test(s) ? Number(s) : NOMES_DOW[s];
    }).filter((n) => n != null && n >= 0 && n <= 6))].sort();
  }
  return null;
}

// próximo intervalo de datas (a partir de amanhã) que cobre os dias-da-semana pedidos
function proximoPeriodo(dias, refDate) {
  const base = refDate || new Date().toISOString().slice(0, 10);
  let ini = null;
  for (let k = 1; k <= 14; k++) {
    const d = addDias(base, k);
    if (dias.includes(new Date(d + "T12:00:00").getDay())) { ini = d; break; }
  }
  if (!ini) return null;
  // run contíguo a partir do primeiro dia: para no primeiro dia fora do conjunto
  let fim = ini;
  for (let k = 1; k <= 10; k++) {
    const d = addDias(ini, k);
    if (dias.includes(new Date(d + "T12:00:00").getDay())) fim = d;
    else break;
  }
  return { inicio: ini, fim };
}

// desconto sugerido: alvo do papel, reduzido se estourar o piso de margem
function precoSugerido(p, papel) {
  const preco = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
  const alvo = CFG.desconto_alvo_pct[papel] != null ? CFG.desconto_alvo_pct[papel] : 0.1;
  const teto = CFG.desconto_teto_pct;
  if (preco == null) return { preco_sugerido: null, desconto_pct: null, proxy: true, margem_promo_pct: null };
  let desc = Math.min(alvo, teto);
  let proxy = false;
  if (p.custo_atual != null) {
    // maior desconto que mantém (preco_promo - custo)/preco_promo >= PISO
    const precoMin = p.custo_atual / (1 - PISO_MARGEM);
    const descMax = 1 - precoMin / preco;
    desc = Math.max(0, Math.min(desc, descMax));
  } else {
    proxy = true;
  }
  const precoPromo = r2(preco * (1 - desc));
  const margemPromoPct = p.custo_atual != null && precoPromo > 0 ? r2((precoPromo - p.custo_atual) / precoPromo) : null;
  return { preco_sugerido: precoPromo, desconto_pct: r2(desc * 100), proxy, margem_promo_pct: margemPromoPct };
}

function forecastPerna(p, precoPromo, duracaoDias, liftCat) {
  const vmd = (p.venda_media_diaria && p.venda_media_diaria.d30) || 0;
  const lift = liftCat && liftCat > 1 ? liftCat : CFG.forecast.lift_fallback;
  const fc = CFG.forecast;
  const cen = [
    ["conservador", 1 + (lift - 1) * fc.fator_conservador],
    ["provavel", lift],
    ["agressivo", 1 + (lift - 1) * fc.fator_agressivo],
  ];
  const precoRef = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
  const baseUnidades = vmd * duracaoDias;
  const out = {};
  for (const [nome, mult] of cen) {
    const unidades = Math.round(vmd * mult * duracaoDias);
    const receita = precoPromo != null ? r2(unidades * precoPromo) : null;
    let margemIncremental = null;
    if (p.custo_atual != null && precoPromo != null && precoRef != null) {
      const margemPromo = (unidades) * (precoPromo - p.custo_atual);
      const margemBase = baseUnidades * (precoRef - p.custo_atual);
      margemIncremental = r2(margemPromo - margemBase);
    }
    out[nome] = { multiplicador: r2(mult), unidades, receita, margem_incremental: margemIncremental };
  }
  const seguranca = Math.ceil((CFG.forecast.estoque_margem_seguranca_dias || 0) * vmd);
  const estoqueNecessario = out.provavel.unidades + seguranca;
  const estoqueOk = p.estoque_atual == null ? null : p.estoque_atual >= estoqueNecessario;
  const estoqueDepois = p.estoque_atual == null ? null : p.estoque_atual - out.provavel.unidades;
  return {
    baseline_unidades_periodo: Math.round(baseUnidades),
    lift_ancora: r2(lift),
    cenarios: out,
    estoque_necessario: estoqueNecessario,
    estoque_atual: p.estoque_atual,
    estoque_ok: estoqueOk,
    estoque_depois_provavel: estoqueDepois,
  };
}

const ORDEM_PAPEIS = ["CHAMARIZ", "TRAFEGO", "HERO", "MARGEM", "COMPLEMENTAR", "DESOVA", "RECORRENCIA", "IMAGEM"];

function montarCampanha(loja, opts = {}) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  const refDate = analise.refDate;

  let dias = parseDias(opts.dias);
  if (!dias || !dias.length) {
    const cfgLoja = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"))[loja] || {});
    const primeira = (cfgLoja.campanhas || [])[0];
    dias = (primeira && primeira.dias && primeira.dias.length) ? [...primeira.dias].sort() : [5, 6, 0];
  }
  const duracaoDias = dias.length || CFG.duracao_dias_padrao;
  const periodo = proximoPeriodo(dias, refDate);

  const categorias = opts.categorias && opts.categorias.length ? new Set(opts.categorias) : null;
  let pool = analise.produtos;
  if (categorias) pool = pool.filter((p) => categorias.has(p.categoria));

  const promoviveis = pool.filter((p) => !p.do_not_promote);
  const evitar = pool.filter((p) => p.do_not_promote).slice(0, 15).map((p) => ({
    descricao: p.descricao, ean: p.ean, categoria: p.categoria,
    motivos: p.do_not_promote.motivos.map((m) => m.texto),
    substituto: p.do_not_promote.substituto ? p.do_not_promote.substituto.descricao : null,
  }));

  // mediana de preço por categoria (gatilho do ângulo de ticket alto)
  const precoPorCat = new Map();
  for (const p of pool) {
    const pr = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
    if (pr == null) continue;
    if (!precoPorCat.has(p.categoria)) precoPorCat.set(p.categoria, []);
    precoPorCat.get(p.categoria).push(pr);
  }
  const medianaCat = new Map([...precoPorCat].map(([c, a]) => [c, mediana(a)]));

  const liftPorCat = mpa.liftCampanhaPorCategoria(loja, refDate);
  const ctxAngulo = {
    duracaoDias, dias, refDate,
    concorrenciaCategorias: opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias : new Set(),
  };

  // enriquece cada promovível com papel + sub-scores
  const enriquecidos = promoviveis.map((p) => {
    const pap = papelDeProduto(p);
    return { p, papel: pap.papel_primario, papeis: pap.papeis, papel_rationale: pap.detalhe[0].rationale, pap };
  });

  const usados = new Set();
  const elenco = {};
  const legs = [];
  for (const papel of ORDEM_PAPEIS) {
    const cands = enriquecidos
      .filter((e) => e.papel === papel && !usados.has(e.p.ean || e.p.descricao))
      .sort((a, b) => b.p.opportunity.score - a.p.opportunity.score)
      .slice(0, CFG.por_papel_max);
    if (!cands.length) { elenco[papel] = []; continue; }
    elenco[papel] = cands.map((e) => {
      usados.add(e.p.ean || e.p.descricao);
      const p = e.p;
      const ps = precoSugerido(p, papel);
      const ang = angulosDeProduto({ ...p, papeis: e.papeis }, {
        ...ctxAngulo,
        papelPrimario: papel,
        medianaPrecoCategoria: medianaCat.get(p.categoria),
        precoPromo: ps.preco_sugerido,
        descontoPct: ps.desconto_pct,
      });
      const fc = forecastPerna(p, ps.preco_sugerido, duracaoDias, liftPorCat.get(p.categoria));
      const leg = {
        descricao: p.descricao, ean: p.ean, categoria: p.categoria,
        papel, opportunity_score: p.opportunity.score,
        preco_ref: p.preco_atual != null ? p.preco_atual : p.preco_praticado,
        preco_sugerido: ps.preco_sugerido, desconto_pct: ps.desconto_pct, desconto_proxy: ps.proxy,
        margem_promo_pct: ps.margem_promo_pct,
        angulo: { primario: ang.primario, rotulo: ang.angulos[0].rotulo, sugestao_copy: ang.angulos[0].sugestao_copy, alternativas: ang.angulos.slice(1, 3).map((a) => a.id) },
        rationale: e.papel_rationale,
        forecast: fc,
        evidencia: { campo: "opportunity.score", valor: p.opportunity.score, fonte: "marketing-product-analytics", periodo: refDate },
      };
      legs.push(leg);
      return leg;
    });
  }

  // ---- forecast da campanha inteira (soma das pernas) ----
  const feedCusto = analise.feeds && analise.feeds.custo;
  const feedEstoque = analise.feeds && analise.feeds.estoque;
  const agg = { conservador: { receita: 0, margem_incremental: 0, unidades: 0 }, provavel: { receita: 0, margem_incremental: 0, unidades: 0 }, agressivo: { receita: 0, margem_incremental: 0, unidades: 0 } };
  const legsComMargem = legs.filter((l) => l.forecast.cenarios.provavel.margem_incremental != null).length;
  const margemParcial = legsComMargem > 0 && legsComMargem < legs.length;
  const margemNula = legsComMargem === 0;
  for (const leg of legs) {
    for (const c of ["conservador", "provavel", "agressivo"]) {
      const cen = leg.forecast.cenarios[c];
      agg[c].unidades += cen.unidades;
      agg[c].receita += cen.receita || 0;
      if (cen.margem_incremental != null) agg[c].margem_incremental += cen.margem_incremental;
    }
  }
  for (const c of ["conservador", "provavel", "agressivo"]) {
    agg[c].receita = r2(agg[c].receita);
    agg[c].margem_incremental = margemNula ? null : r2(agg[c].margem_incremental);
  }
  const estoqueNecessarioTotal = legs.reduce((s, l) => s + (l.forecast.estoque_necessario || 0), 0);
  const legsSemEstoque = legs.filter((l) => l.forecast.estoque_ok === false);

  // ---- score da campanha 0..100 ----
  const w = CFG.score_campanha_pesos;
  const chave = ["CHAMARIZ", "HERO", "MARGEM", "COMPLEMENTAR"];
  const coberturaPapeis = chave.filter((k) => (elenco[k] || []).length > 0).length / chave.length;
  const heros = elenco.HERO || [];
  const liftHeros = heros.map((h) => h.forecast.lift_ancora).filter((x) => x != null);
  const forcaAncora = liftHeros.length ? clamp01((liftHeros.reduce((s, x) => s + x, 0) / liftHeros.length - 1) / 0.5) : 0.3;
  let margemComp = 0.5, estoqueComp = 0.5;
  const ausentesScore = [];
  if (feedCusto && !margemNula && agg.provavel.receita > 0) {
    margemComp = clamp01(agg.provavel.margem_incremental / (agg.provavel.receita * 0.15));
    if (margemParcial) ausentesScore.push(`margem prevista parcial — ${legsComMargem}/${legs.length} pernas com custo`);
  } else { ausentesScore.push("margem prevista (sem custo) — componente neutro"); }
  if (feedEstoque && legs.length) {
    estoqueComp = 1 - legsSemEstoque.length / legs.length;
  } else { ausentesScore.push("estoque suficiente (sem feed) — componente neutro"); }
  const scoreCampanha = Math.round(100 * (
    w.cobertura_papeis * coberturaPapeis +
    w.margem_prevista_positiva * margemComp +
    w.estoque_suficiente * estoqueComp +
    w.forca_ancora * forcaAncora
  ));
  const pesoComDado = w.cobertura_papeis + w.forca_ancora + (feedCusto && !margemNula ? w.margem_prevista_positiva : 0) + (feedEstoque ? w.estoque_suficiente : 0);
  const scoreConfianca = r2(pesoComDado / (w.cobertura_papeis + w.margem_prevista_positiva + w.estoque_suficiente + w.forca_ancora));

  // ---- combos viáveis entre os produtos do elenco ----
  const eansElenco = new Set(legs.map((l) => l.ean).filter(Boolean));
  let combosCampanha = [];
  let combosOrigem = null;
  try {
    const cc = basket.combos(loja, { ...opts, apenasViaveis: true, limite: 60 });
    const fmtCombo = (co) => ({
      a: co.produto_a.descricao, b: co.produto_b.descricao,
      lift: co.lift, confidence: co.confidence, qualidade: co.qualidade,
      margem_combinada_pct: co.margem_combinada_pct,
      ancora: co.papel && co.papel.ancora, alertas: co.alertas || [],
      no_elenco: eansElenco.has(co.produto_a.ean) || eansElenco.has(co.produto_b.ean),
    });
    const noElenco = (cc.combos || []).filter((co) => eansElenco.has(co.produto_a.ean) || eansElenco.has(co.produto_b.ean));
    if (noElenco.length) { combosCampanha = noElenco.slice(0, 5).map(fmtCombo); combosOrigem = "produtos do elenco"; }
    else if ((cc.combos || []).length) { combosCampanha = cc.combos.slice(0, 3).map(fmtCombo); combosOrigem = "melhores combos viáveis da loja (fora do elenco)"; }
  } catch (e) { /* cesta ainda não materializada */ }

  const nEleco = legs.length;
  const briefing = gerarBriefing(loja, opts.tema, dias, periodo, duracaoDias, elenco, evitar, agg, scoreCampanha, refDate);

  return {
    loja, tema: opts.tema || null, refDate,
    janela: { dias_semana: dias, duracao_dias: duracaoDias, proximo_periodo: periodo },
    objetivo: opts.objetivo || null,
    categorias: opts.categorias || null,
    feeds: analise.feeds,
    dados_ausentes_globais: analise.dados_ausentes_globais,
    resumo: {
      itens_no_elenco: nEleco,
      papeis_preenchidos: ORDEM_PAPEIS.filter((k) => (elenco[k] || []).length),
      score_da_campanha: scoreCampanha,
      score_confianca: scoreConfianca,
      score_componentes: {
        cobertura_papeis: r2(coberturaPapeis), margem_prevista: r2(margemComp),
        estoque_suficiente: r2(estoqueComp), forca_ancora: r2(forcaAncora),
      },
      score_dados_ausentes: ausentesScore,
      pernas_sem_estoque: legsSemEstoque.map((l) => ({ descricao: l.descricao, necessario: l.forecast.estoque_necessario, atual: l.forecast.estoque_atual })),
    },
    elenco,
    combos: combosCampanha,
    combos_origem: combosOrigem,
    evitar,
    forecast: {
      base: "venda média diária 30d por produto × dias da campanha × lift histórico da categoria",
      estoque_necessario_total: estoqueNecessarioTotal,
      margem_cobertura: legs.length ? `${legsComMargem}/${legs.length} pernas com custo` : null,
      cenarios: agg,
      aviso: "PROJEÇÃO a partir de comportamento histórico. Não é promessa. Volume real depende de execução, preço, clima e concorrência.",
    },
    briefing,
  };
}

function gerarBriefing(loja, tema, dias, periodo, duracao, elenco, evitar, agg, score, refDate) {
  const N = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const L = [];
  L.push(`CAMPANHA${tema ? " — " + tema : ""} · ${loja}`);
  L.push(`Dias: ${dias.map((d) => N[d]).join(", ")} (${duracao} dia(s))${periodo ? ` · próxima: ${periodo.inicio} a ${periodo.fim}` : ""}`);
  L.push(`Score da campanha: ${score}/100 · base de dados: vendas até ${refDate} (números do backend, sem estimativa de IA)`);
  L.push("");
  for (const papel of ORDEM_PAPEIS) {
    const itens = elenco[papel] || [];
    if (!itens.length) continue;
    L.push(`## ${papel}`);
    for (const it of itens) {
      L.push(`- ${it.descricao}${it.preco_sugerido != null ? ` — R$ ${it.preco_sugerido.toFixed(2)} (-${it.desconto_pct}%)` : ""} · ângulo: ${it.angulo.rotulo}`);
      L.push(`  "${it.angulo.sugestao_copy}"`);
    }
    L.push("");
  }
  if (evitar.length) {
    L.push("## NÃO ANUNCIAR");
    for (const e of evitar.slice(0, 10)) L.push(`- ${e.descricao} — ${e.motivos.join("; ")}${e.substituto ? ` → no lugar: ${e.substituto}` : ""}`);
    L.push("");
  }
  L.push(`Forecast (provável): ${agg.provavel.unidades} un · receita R$ ${agg.provavel.receita}` + (agg.provavel.margem_incremental != null ? ` · margem incremental R$ ${agg.provavel.margem_incremental}` : " · margem incremental s/ custo"));
  return L.join("\n");
}

module.exports = { montarCampanha, parseDias, precoSugerido };
