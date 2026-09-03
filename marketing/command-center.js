// Fase A — Marketing Command Center.
//
// "O QUE O MARKETING DEVE FAZER HOJE?" — plano do dia de UMA loja, montado sobre a camada
// determinística (marketing-product-analytics) + papel (roles) + sub-scores (scores).
//
//   plano_do_dia.anunciar[]     : produtos recomendados, ranqueados, com papel + ação + motivos + evidência
//   plano_do_dia.nao_anunciar[] : produtos bloqueados (ruptura / margem / sem giro) + substituto
//   plano_do_dia.alertas[]      : ruptura em massa, categoria sob ataque, capital parado, feed faltando
//
// A IA não entra aqui. Todo item carrega evidência (campo, valor, fonte, período).

const mpa = require("../marketing-product-analytics");
const { papelDeProduto } = require("./roles");
const { subScores } = require("./scores");
const promoPricing = require("./promo-pricing");

function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }

// motivos = os 3 componentes de maior contribuição no Opportunity Score, em texto + evidência
function motivosDoProduto(p) {
  const comp = (p.opportunity && p.opportunity.componentes) || {};
  return Object.entries(comp)
    .map(([nome, c]) => ({ nome, valor: c.valor, contribuicao: c.contribuicao, fonte: c.fonte, periodo: c.periodo }))
    .filter((c) => c.contribuicao != null)
    .sort((a, b) => b.contribuicao - a.contribuicao)
    .slice(0, 3)
    .map((c) => ({
      texto: `${nome2txt(c.nome)}: ${c.fonte}`,
      contribuicao: c.contribuicao,
      evidencia: { campo: c.nome, valor: r2(c.valor), fonte: "opportunity-score", periodo: c.periodo },
    }));
}
function nome2txt(n) {
  return {
    demanda: "demanda", tendencia: "tendência", margem: "margem", estoque: "cobertura de estoque",
    campanha_historica: "histórico de campanha da categoria", concorrencia: "pressão de concorrência", cesta: "cesta",
  }[n] || n;
}

function slim(p, promoMap) {
  const pap = papelDeProduto(p);
  const sub = subScores(p);
  const promo = promoMap && promoMap.get(String(p.produto_id));
  return {
    descricao: p.descricao,
    ean: p.ean,
    categoria: p.categoria,
    promo: promo || null,
    opportunity_score: p.opportunity.score,
    opportunity_confianca: p.opportunity.confianca,
    papel_primario: pap.papel_primario,
    papeis: pap.papeis,
    papel_confianca: pap.confianca,
    acao_sugerida: pap.detalhe[0].acao,
    papel_rationale: pap.detalhe[0].rationale,
    papel_detalhe: pap.detalhe,
    sub_scores: sub,
    interpretacao: sub.interpretacao,
    tendencia: p.tendencia,
    cobertura_rotulo: p.cobertura_rotulo,
    dias_cobertura: p.cobertura_infinita ? null : p.dias_cobertura,
    cobertura_infinita: p.cobertura_infinita,
    margem_pct: p.margem_pct,
    estoque_atual: p.estoque_atual,
    unidades_30d: (p.unidades && p.unidades[30]) || 0,
    receita_30d: p.receita && p.receita.d30,
    motivos: motivosDoProduto(p),
  };
}

const MOTIVO_CURTO = { RUPTURA: "risco de ruptura", MARGEM: "margem insuficiente", SEM_GIRO: "sem giro" };

function commandCenter(loja, opts = {}) {
  const r = mpa.analisarProdutos(loja, opts);
  if (r.erro) return r;
  const limAnunciar = opts.limiteAnunciar || 12;
  const limBloq = opts.limiteBloqueados || 8;
  const pisoScore = opts.pisoScore != null ? opts.pisoScore : 40;

  const anunciaveisRaw = r.produtos.filter((p) => !p.do_not_promote && p.opportunity.score >= pisoScore);
  // a cauda longa (classe C da curva ABC) não vale slot de campanha — escondida por padrão
  const anunciaveis = opts.incluirC ? anunciaveisRaw : anunciaveisRaw.filter((p) => p.abc !== "C");
  const ocultosC = anunciaveisRaw.length - anunciaveis.length;
  const bloqueados = r.produtos.filter((p) => p.do_not_promote);

  const aList = anunciaveis.slice(0, limAnunciar);
  let promoMap = new Map();
  try { promoMap = promoPricing.precoRapido(loja, opts, aList); } catch (e) { /* segue sem preço de promo */ }
  const anunciar = aList.map((p) => slim(p, promoMap));

  const nao_anunciar = bloqueados.slice(0, limBloq).map((p) => {
    const m = p.do_not_promote.motivos || [];
    return {
      descricao: p.descricao,
      ean: p.ean,
      categoria: p.categoria,
      motivo_curto: MOTIVO_CURTO[m[0] && m[0].tipo] || "bloqueado",
      motivos: m.map((x) => ({ tipo: x.tipo, texto: x.texto, evidencia: x.evidencia })),
      substituto: p.do_not_promote.substituto || null,
      estoque_atual: p.estoque_atual,
      dias_cobertura: p.cobertura_infinita ? null : p.dias_cobertura,
      venda_media_diaria: p.venda_media_diaria && p.venda_media_diaria.d30,
      margem_pct: p.margem_pct,
    };
  });

  // ---- alertas derivados dos próprios produtos ----
  const alertas = [];
  // ruptura: só conta o que tem venda relevante (evita alarmar com centenas de SKUs de cauda)
  const RUPTURA_RECEITA_MIN = opts.rupturaReceitaMin != null ? opts.rupturaReceitaMin : 80;
  const emRuptura = r.produtos
    .filter((p) => p.cobertura_rotulo === "RUPTURA" && (p.receita && p.receita.d30) >= RUPTURA_RECEITA_MIN)
    .sort((a, b) => b.receita.d30 - a.receita.d30);
  if (emRuptura.length) {
    alertas.push({
      nivel: "ALTO",
      texto: `${emRuptura.length} produto(s) com venda relevante (≥ R$ ${RUPTURA_RECEITA_MIN}/30d) e risco de ruptura — repor antes de anunciar a categoria; prioridade pelos de maior receita`,
      itens: emRuptura.slice(0, 10).map((p) => ({ descricao: p.descricao, dias_cobertura: p.dias_cobertura, receita_30d: p.receita.d30 })),
    });
  }
  const catsAtaque = opts.concorrenciaCategorias instanceof Set ? [...opts.concorrenciaCategorias] : [];
  if (catsAtaque.length) {
    alertas.push({ nivel: "ATENCAO", texto: `Concorrência com oferta abaixo da nossa em: ${catsAtaque.join(", ")}`, itens: catsAtaque.map((c) => ({ categoria: c })) });
  }
  const parados = r.produtos.filter((p) => (p.cobertura_rotulo === "PARADO" || p.cobertura_infinita) && p.custo_atual != null && p.estoque_atual != null);
  const capitalParado = r2(parados.reduce((s, p) => s + p.custo_atual * p.estoque_atual, 0));
  if (capitalParado > 0) {
    alertas.push({ nivel: "INFORMATIVO", texto: `R$ ${capitalParado.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} em estoque parado sem giro — candidatos a desova/combo`, itens: parados.sort((a, b) => b.custo_atual * b.estoque_atual - a.custo_atual * a.estoque_atual).slice(0, 6).map((p) => ({ descricao: p.descricao, capital: r2(p.custo_atual * p.estoque_atual) })) });
  }
  for (const g of r.dados_ausentes_globais || []) alertas.push({ nivel: "INFORMATIVO", texto: "Feed faltando — " + g });

  // ---- mix de papéis entre os recomendados (ajuda a montar campanha equilibrada) ----
  const mix = {};
  for (const a of anunciar) mix[a.papel_primario] = (mix[a.papel_primario] || 0) + 1;

  return {
    loja,
    refDate: r.refDate,
    feeds: r.feeds,
    dados_ausentes_globais: r.dados_ausentes_globais,
    abc: r.abc,
    resumo: {
      total_analisado: r.total,
      anunciaveis: anunciaveis.length,
      bloqueados: bloqueados.length,
      mostrando_anunciar: anunciar.length,
      mostrando_bloqueados: nao_anunciar.length,
      ocultos_classe_c: ocultosC,
      mix_papeis: mix,
    },
    plano_do_dia: { anunciar, nao_anunciar, alertas },
  };
}

module.exports = { commandCenter, slim };
