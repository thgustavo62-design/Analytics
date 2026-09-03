// Fase C — Medição de campanha: o que a campanha REALMENTE fez.
//
// medirCampanha(loja, { nome | dias+categorias, janelaDias, investimento })
//
//   - baseline pelo MESMO DIA DA SEMANA: compara os dias-de-campanha da categoria com o
//     mesmo dia da semana fora da campanha (ou, se a campanha ocupa todos os dias daquele
//     dia-da-semana, com os demais dias — método declarado)
//   - incremento provável (+receita, +unidades, % sobre baseline)
//   - lucro incremental (só com custo), ROAS e RETORNO SOBRE MARGEM (só com investimento)
//   - CANIBALIZAÇÃO: quanto do ganho da categoria veio à custa das outras categorias da loja
//
// Determinístico. Leitura observacional (correlação dia-da-semana × categoria), não isola
// preço/clima/pagamento/concorrência — o aviso acompanha o resultado.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "campaign-plan.json"), "utf8")).medicao;
const DIA = 86400000;
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + "T12:00:00").getDay();
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const NOMES_DOW = { domingo: 0, segunda: 1, terca: 2, "terça": 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, "sábado": 6, dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
function parseDias(dias) {
  if (Array.isArray(dias)) return [...new Set(dias.map(Number).filter((n) => n >= 0 && n <= 6))];
  if (typeof dias === "string" && dias.trim()) {
    return [...new Set(dias.split(/[,\s]+/).map((t) => {
      const s = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
      return /^\d$/.test(s) ? Number(s) : NOMES_DOW[s];
    }).filter((n) => n != null && n >= 0 && n <= 6))];
  }
  return [];
}

// margem média (ponderada por receita 30d) das categorias da campanha — null sem custo
function margemMediaCategorias(loja, cats, opts) {
  const a = mpa.analisarProdutos(loja, opts || {});
  if (a.erro || !a.feeds || !a.feeds.custo) return null;
  let somaMargem = 0, somaReceita = 0;
  for (const p of a.produtos) {
    if (!cats.has(p.categoria) || p.margem_pct == null) continue;
    const rec = (p.receita && p.receita.d30) || 0;
    somaMargem += p.margem_pct * rec;
    somaReceita += rec;
  }
  return somaReceita > 0 ? somaMargem / somaReceita : null;
}

function medirCampanha(loja, opts = {}) {
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja" };

  // --- definição da campanha ---
  let nome = opts.nome || null;
  let diasCamp = parseDias(opts.dias);
  let cats = opts.categorias
    ? (Array.isArray(opts.categorias) ? opts.categorias : String(opts.categorias).split(",").map((s) => s.trim()).filter(Boolean))
    : [];
  let fonte = "parâmetros";
  if (nome) {
    const c = (LOJAS_CFG[loja] && LOJAS_CFG[loja].campanhas || []).find((x) => x.nome === nome);
    if (!c) return { erro: `campanha "${nome}" não está no calendário de ${loja}`, disponiveis: (LOJAS_CFG[loja] && LOJAS_CFG[loja].campanhas || []).map((x) => x.nome) };
    diasCamp = c.dias || [];
    cats = c.categorias || [];
    fonte = "calendário (config/lojas.json)";
  }
  if (!diasCamp.length || !cats.length) return { erro: "informe nome (do calendário) ou dias + categorias" };

  const janelaDias = +opts.janelaDias || CFG.janela_dias_padrao;
  const ini = addDias(refDate, -(janelaDias - 1));
  const setDows = new Set(diasCamp);
  const setCats = new Set(cats);
  // investimento: o parâmetro manda; se não vier, usa o tráfego pago do mês (prints lidos por visão)
  let investimento = opts.investimento != null && opts.investimento !== "" ? Number(opts.investimento) : null;
  let investimentoFonte = investimento != null ? "informado" : null;
  if (investimento == null) {
    try {
      const [ay, am] = refDate.split("-").map(Number);
      const tp = db.investimentoTrafegoPago(loja, ay, am);
      if (tp && tp.total > 0) { investimento = r2(tp.total); investimentoFonte = `tráfego pago do mês (${tp.n} print(s))`; }
    } catch (e) { /* sem tráfego pago — segue sem investimento */ }
  }

  // --- soma diária: receita da categoria da campanha e das OUTRAS categorias ---
  const rows = db.vendasCategoriaPorData(loja, ini, refDate);
  const porDia = new Map(); // data -> { camp, outras, unidCamp }
  for (const r of rows) {
    const cur = porDia.get(r.data) || { camp: 0, outras: 0, unidCamp: 0 };
    if (setCats.has(r.categoria)) { cur.camp += r.receita; cur.unidCamp += r.unidades || 0; }
    else cur.outras += r.receita;
    porDia.set(r.data, cur);
  }

  // separa dias em "campanha" (dia-da-semana da campanha) e "fora"
  const campD = [], foraD = [];
  for (const [data, v] of porDia) (setDows.has(dow(data)) ? campD : foraD).push({ data, ...v });

  // baseline pelo MESMO dia da semana, se houver dias daquele dia-da-semana fora da campanha
  let baselineMetodo, baseCamp, baseOutras, baselineMesmoDow;
  const foraMesmoDow = foraD.filter((d) => setDows.has(dow(d.data)));
  if (foraMesmoDow.length >= CFG.amostra_min_dias_baseline) {
    baselineMesmoDow = true;
    baselineMetodo = "mesmo dia da semana, fora da campanha";
    baseCamp = media(foraMesmoDow.map((d) => d.camp));
    baseOutras = media(foraMesmoDow.map((d) => d.outras));
  } else {
    baselineMesmoDow = false;
    baselineMetodo = "demais dias da semana — a campanha ocupa todo o dia-da-semana; mistura sazonalidade do dia com efeito da campanha (confiança baixa)";
    baseCamp = media(foraD.map((d) => d.camp));
    baseOutras = media(foraD.map((d) => d.outras));
  }

  const mediaCamp = media(campD.map((d) => d.camp));
  const mediaOutras = media(campD.map((d) => d.outras));
  const unidMediaCamp = media(campD.map((d) => d.unidCamp));
  const nDiasCamp = campD.length;

  const incDia = mediaCamp - baseCamp;
  const incTotal = incDia * nDiasCamp;
  const pctSobreBase = baseCamp > 0 ? incDia / baseCamp : null;
  // unidades incrementais ≈ fração incremental da receita × unidades médias dos dias de campanha
  const unidIncDia = mediaCamp > 0 && incDia > 0 ? unidMediaCamp * (incDia / mediaCamp) : (incDia <= 0 ? 0 : null);
  const unidIncTotal = unidIncDia != null ? unidIncDia * nDiasCamp : null;

  // canibalização: variação das OUTRAS categorias nos dias de campanha.
  // Só é confiável com baseline do MESMO dia da semana — senão está comparando dias
  // estruturalmente diferentes (fim de semana × dia útil) e o número é ruído.
  const deltaOutrasDia = mediaOutras - baseOutras;
  const incLiquidoDia = incDia + deltaOutrasDia;
  let canibalizacaoPct = null, veredito;
  if (!baselineMesmoDow) {
    veredito = "não medível — sem baseline do mesmo dia da semana";
  } else if (incDia > 0) {
    canibalizacaoPct = Math.max(0, Math.min(1, 1 - incLiquidoDia / incDia));
    veredito = canibalizacaoPct < CFG.canibalizacao_parcial ? "venda incremental real"
      : canibalizacaoPct < CFG.canibalizacao_alta ? "parcialmente incremental — deslocou parte da demanda"
      : "deslocou demanda de outras categorias — pouco incremental";
  } else {
    veredito = "sem incremento de receita da categoria nos dias de campanha";
  }

  // lucro incremental + retorno
  const margemMedia = margemMediaCategorias(loja, setCats, opts);
  const lucroIncTotal = margemMedia != null ? incTotal * margemMedia : null;
  const lucroLiquidoTotal = margemMedia != null ? incLiquidoDia * nDiasCamp * margemMedia : null;
  const feeds = db.freshnessCatalogo(loja);

  let ROAS = null, retornoSobreMargem = null, breakEvenReceita = null;
  if (investimento != null && investimento > 0) {
    ROAS = r2(incTotal / investimento);
    if (lucroIncTotal != null) retornoSobreMargem = r2(lucroIncTotal / investimento);
    if (margemMedia != null && margemMedia > 0) breakEvenReceita = r2(investimento / margemMedia);
  }

  const amostraOk = nDiasCamp >= CFG.amostra_min_dias_campanha && (foraMesmoDow.length >= CFG.amostra_min_dias_baseline || foraD.length >= CFG.amostra_min_dias_baseline);
  const ausentes = [];
  if (!feeds.custo.ultima) ausentes.push("custo (lucro incremental, retorno sobre margem, break-even indisponíveis)");
  if (investimento == null) ausentes.push("investimento (ROAS e retorno indisponíveis — informe no parâmetro ou jogue o print de tráfego pago na inbox)");

  return {
    loja, refDate,
    janela: { inicio: ini, fim: refDate, dias: janelaDias },
    campanha: { nome, dias_semana: diasCamp, categorias: cats, fonte },
    investimento,
    investimento_fonte: investimentoFonte,
    confianca: baselineMesmoDow ? "alta" : "baixa",
    baseline: {
      metodo: baselineMetodo,
      mesmo_dia_da_semana: baselineMesmoDow,
      receita_media_dia_campanha: r2(mediaCamp),
      receita_media_dia_baseline: r2(baseCamp),
      n_dias_campanha: nDiasCamp,
    },
    incremental: {
      receita_dia: r2(incDia),
      receita_total: r2(incTotal),
      unidades_total: unidIncTotal != null ? Math.round(unidIncTotal) : null,
      pct_sobre_baseline: pctSobreBase != null ? r2(pctSobreBase * 100) : null,
      lucro_total: r2(lucroIncTotal),
      lucro_liquido_total: r2(lucroLiquidoTotal),
      margem_media_categoria_pct: margemMedia != null ? r2(margemMedia * 100) : null,
    },
    retorno: {
      ROAS,
      retorno_sobre_margem: retornoSobreMargem,
      pagou: retornoSobreMargem != null ? retornoSobreMargem >= 1 : null,
      break_even_receita: breakEvenReceita,
    },
    canibalizacao: {
      delta_outras_categorias_dia: r2(deltaOutrasDia),
      incremento_bruto_dia: r2(incDia),
      incremento_liquido_dia: r2(incLiquidoDia),
      canibalizacao_pct: canibalizacaoPct != null ? r2(canibalizacaoPct * 100) : null,
      veredito,
    },
    amostra: { dias_campanha: nDiasCamp, dias_baseline: foraMesmoDow.length || foraD.length, suficiente: amostraOk },
    dados_ausentes: ausentes,
    evidencia: {
      campo: "incremental.receita_total", valor: r2(incTotal),
      fonte: `receita diária da(s) categoria(s) [${cats.join(", ")}] nos dias ${JSON.stringify(diasCamp)} vs ${baselineMetodo}`,
      periodo: `${ini}..${refDate}`,
    },
    aviso: "Leitura observacional: mede correlação dia-da-semana × categoria. Não isola efeito de preço, clima, pagamento de salário ou concorrência. Baseline pelo mesmo dia da semana quando há amostra.",
  };
}

function medirTodasDoCalendario(loja, opts = {}) {
  const camps = (LOJAS_CFG[loja] && LOJAS_CFG[loja].campanhas) || [];
  return camps.map((c) => medirCampanha(loja, { ...opts, nome: c.nome }));
}

module.exports = { medirCampanha, medirTodasDoCalendario };
