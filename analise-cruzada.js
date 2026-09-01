// Análise cruzada — "o que sai e dá lucro, o que encalha, o que some".
// Cruza vendas × estoque × custo × margem por produto e monta:
//   - resultado (lucro estimado) do período por produto = receita − custo×unidades
//   - matriz movimento × lucro × estoque preso -> quadrante (VACA_LEITEIRA / ISCA_CARA /
//     PESO_MORTO / APOSTA / SUMINDO / RUPTURA / NORMAL)
//   - resumo: lucro estimado do mês, top contribuidores, top prejuízo (vende e perde),
//     capital parado, receita em risco de ruptura, contagem por quadrante.
// Determinístico. Sem custo cadastrado, os campos de lucro/margem saem null (flag).

const fs = require("fs");
const path = require("path");
const mpa = require("./marketing-product-analytics");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "marketing-stock.json"), "utf8"));
const PISO_LUCRO = CFG.margem_pct_lucrativo || 0.18; // margem_pct a partir da qual "dá lucro de verdade"
const round = (n, d) => (n == null ? null : Math.round((n + Number.EPSILON) * Math.pow(10, d ?? 2)) / Math.pow(10, d ?? 2));

// custo > 1.3× preço quase sempre é erro de cadastro (Últ. Prc. Entrada de caixa vs venda
// unitária, valor stale no ERP, etc.) — não é prejuízo real de -300%.
function custoSuspeito(p) {
  return p.margem_pct != null && p.margem_pct < -0.3;
}

function classificar(p, pRecAlta) {
  const saiBem = p.percentis && p.percentis.receita >= 0.6 && p.unidades[30] > 0 && p.tendencia.rotulo !== "CAINDO";
  const saiuParou = p.unidades[60] > p.unidades[30] * 2.2 && p.tendencia.rotulo === "CAINDO" && (p.unidades[90] || 0) >= 6;
  const lucrativo = p.margem_pct == null || custoSuspeito(p) ? null : p.margem_pct >= PISO_LUCRO;
  const margemRuim = p.margem_pct != null && !custoSuspeito(p) && p.margem_pct < 0.06;
  const parado = p.cobertura_rotulo === "PARADO" || p.cobertura_infinita ||
    (p.estoque_atual != null && p.venda_media_diaria.d30 > 0 && p.dias_cobertura != null && p.dias_cobertura > (CFG.default.parado || 120));
  const semGiro = (p.unidades[30] || 0) === 0 && (p.dias_sem_venda == null || p.dias_sem_venda > 30);

  if (p.cobertura_rotulo === "RUPTURA" && p.unidades[30] > 0) return "RUPTURA";
  if (saiuParou) return "SUMINDO";
  if ((parado || semGiro) && (p.estoque_atual == null || p.estoque_atual > 0)) return "PESO_MORTO";
  if (saiBem && margemRuim) return "ISCA_CARA";
  if (saiBem && lucrativo !== false) return "VACA_LEITEIRA";
  if (!saiBem && lucrativo === true && p.cobertura_rotulo !== "RUPTURA") return "APOSTA";
  return "NORMAL";
}

const QUADRANTE_INFO = {
  VACA_LEITEIRA: { rotulo: "Vaca leiteira", acao: "Proteger: nunca deixar faltar, não descontar sem motivo." },
  ISCA_CARA: { rotulo: "Isca cara", acao: "Vende bem mas a margem é ruim — revisar custo/preço, ou assumir como chamariz consciente." },
  PESO_MORTO: { rotulo: "Peso morto", acao: "Estoque preso sem giro — liquidar / combo / chamariz para recuperar capital." },
  APOSTA: { rotulo: "Aposta", acao: "Margem boa mas ainda não gira — empurrar na pauta / campanha." },
  SUMINDO: { rotulo: "Sumindo", acao: "Vendia e caiu forte — investigar ('Por quê?') antes que morra." },
  RUPTURA: { rotulo: "Ruptura", acao: "Sai bem e o estoque está acabando — repor com urgência." },
  NORMAL: { rotulo: "Normal", acao: "Sem sinal forte." },
};

function analiseCruzada(loja, opts = {}) {
  const a = mpa.analisarProdutos(loja, opts);
  if (a.erro) return a;
  const temCusto = a.feeds.custo;
  const temEstoque = a.feeds.estoque;

  const produtos = a.produtos
    .filter((p) => !/^(diversos|taxa de entrega)$/i.test(p.descricao))
    .map((p) => {
      const u30 = p.unidades[30] || 0;
      const u90 = p.unidades[90] || 0;
      const resultado30 = p.margem_unitaria != null ? round(p.margem_unitaria * u30, 2) : null;
      const resultado90 = p.margem_unitaria != null ? round(p.margem_unitaria * u90, 2) : null;
      const refPreco = p.custo_atual != null ? p.custo_atual : p.preco_praticado;
      const capitalParado = p.estoque_atual != null && refPreco != null ? round(p.estoque_atual * refPreco, 2) : null;
      const giroMensal = p.estoque_atual != null && p.estoque_atual > 0 ? round(u30 / p.estoque_atual, 2) : null;
      const q = classificar(p, a);
      const suspeito = custoSuspeito(p);
      return {
        ean: p.ean, descricao: p.descricao, categoria: p.categoria, classe: p.classe, custo_suspeito: suspeito,
        unid_30d: u30, unid_90d: u90, receita_30d: p.receita.d30, tendencia: p.tendencia.rotulo, tendencia_pct: p.tendencia.pct,
        estoque_atual: p.estoque_atual, dias_cobertura: p.dias_cobertura, cobertura_rotulo: p.cobertura_rotulo,
        custo_atual: p.custo_atual, preco: p.preco_atual ?? p.preco_praticado, margem_unitaria: p.margem_unitaria, margem_pct: p.margem_pct,
        resultado_30d: resultado30, resultado_90d: resultado90,
        capital_parado: capitalParado, giro_mensal: giroMensal,
        dias_sem_venda: p.dias_sem_venda,
        opportunity: p.opportunity.score,
        quadrante: q, quadrante_rotulo: QUADRANTE_INFO[q].rotulo, acao: QUADRANTE_INFO[q].acao,
        motivo: motivo(p, q, resultado30, capitalParado, giroMensal),
      };
    });

  // ---- resumo ----
  const comCustoOk = produtos.filter((p) => p.resultado_30d != null && !p.custo_suspeito);
  const suspeitos = produtos.filter((p) => p.custo_suspeito).sort((x, y) => (y.receita_30d || 0) - (x.receita_30d || 0));
  const lucro30 = comCustoOk.reduce((s, p) => s + p.resultado_30d, 0);
  const positivos = comCustoOk.filter((p) => p.resultado_30d > 0).sort((x, y) => y.resultado_30d - x.resultado_30d);
  const negativos = comCustoOk.filter((p) => (p.resultado_30d < 0 || (p.margem_pct != null && p.margem_pct < 0.06)) && p.unid_30d > 0)
    .sort((x, y) => (x.resultado_30d || 0) - (y.resultado_30d || 0));
  const comCusto = comCustoOk;
  const pesoMorto = produtos.filter((p) => p.quadrante === "PESO_MORTO" && p.capital_parado != null).sort((x, y) => y.capital_parado - x.capital_parado);
  const capitalParadoTotal = pesoMorto.reduce((s, p) => s + p.capital_parado, 0);
  const receitaEmRisco = produtos.filter((p) => p.quadrante === "RUPTURA").reduce((s, p) => s + (p.receita_30d || 0), 0);

  const porQuadrante = {};
  for (const p of produtos) porQuadrante[p.quadrante] = (porQuadrante[p.quadrante] || 0) + 1;

  const resumo = {
    lucro_estimado_30d: temCusto ? round(lucro30, 2) : null,
    produtos_no_calculo_de_lucro: comCusto.length,
    produtos_custo_suspeito: suspeitos.length,
    cobertura_custo_pct: produtos.length ? Math.round((comCusto.length / produtos.length) * 100) : 0,
    capital_parado_total: temEstoque ? round(capitalParadoTotal, 2) : null,
    receita_30d_em_risco_de_ruptura: temEstoque ? round(receitaEmRisco, 2) : null,
    por_quadrante: porQuadrante,
    top_lucro: positivos.slice(0, 6).map(slim),
    top_prejuizo: negativos.slice(0, 6).map(slim),
    custo_a_conferir: suspeitos.slice(0, 8).map(slim),
    peso_morto: pesoMorto.slice(0, 8).map(slim),
    ruptura: produtos.filter((p) => p.quadrante === "RUPTURA").sort((x, y) => y.receita_30d - x.receita_30d).slice(0, 8).map(slim),
    sumindo: produtos.filter((p) => p.quadrante === "SUMINDO").sort((x, y) => (y.receita_30d || 0) - (x.receita_30d || 0)).slice(0, 8).map(slim),
  };

  const dados_ausentes = [
    !temCusto && "custo (lucro por produto, isca cara e prejuízo indisponíveis — sobe uma planilha de estoque com a coluna 'Últ. Prc. Entrada')",
    !temEstoque && "estoque (capital parado, giro e ruptura indisponíveis)",
  ].filter(Boolean);

  const quadrantes = {};
  for (const q of Object.keys(QUADRANTE_INFO)) {
    quadrantes[q] = {
      rotulo: QUADRANTE_INFO[q].rotulo, acao: QUADRANTE_INFO[q].acao,
      itens: produtos.filter((p) => p.quadrante === q).sort((x, y) => (y.receita_30d || 0) - (x.receita_30d || 0)).slice(0, 40),
    };
  }

  return { loja, refDate: a.refDate, feeds: a.feeds, dados_ausentes, resumo, quadrantes, total: produtos.length };
}

function slim(p) {
  return {
    ean: p.ean, descricao: p.descricao, categoria: p.categoria,
    unid_30d: p.unid_30d, receita_30d: p.receita_30d, margem_pct: p.margem_pct, custo_atual: p.custo_atual, preco: p.preco,
    resultado_30d: p.resultado_30d, capital_parado: p.capital_parado, giro_mensal: p.giro_mensal,
    dias_cobertura: p.dias_cobertura, tendencia: p.tendencia, quadrante: p.quadrante, custo_suspeito: p.custo_suspeito,
  };
}

function motivo(p, q, res30, capital, giro) {
  const un = p.unidades[30] || 0;
  const parts = [`${un} un/30d`];
  if (p.receita.d30) parts.push(`R$ ${p.receita.d30}`);
  if (p.margem_pct != null) parts.push(`margem ${(p.margem_pct * 100).toFixed(0)}%`);
  if (res30 != null) parts.push(`resultado R$ ${res30}`);
  if (p.dias_cobertura != null) parts.push(`cobertura ${p.dias_cobertura}d`);
  if (giro != null) parts.push(`girou ${giro}x`);
  if (capital != null && q === "PESO_MORTO") parts.push(`R$ ${capital} parado`);
  if (p.tendencia.pct != null && Math.abs(p.tendencia.pct) >= 20) parts.push(`tendência ${p.tendencia.pct > 0 ? "+" : ""}${p.tendencia.pct}%`);
  return parts.join(" · ");
}

module.exports = { analiseCruzada, QUADRANTE_INFO };
