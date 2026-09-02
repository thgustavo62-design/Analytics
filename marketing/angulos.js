// Fase B — Motor de Ângulos.
//
// Camada DETERMINÍSTICA. Recebe um produto analisado (Fase 2 + papel da Fase A) e o contexto
// da campanha (duração, pressão de concorrência, mediana de preço da categoria) e pontua cada
// ângulo de venda a partir de dado real. Devolve o ângulo primário + ranking + uma sugestão
// de copy (template preenchido — não é a copy final).

const fs = require("fs");
const path = require("path");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "angulos.json"), "utf8"));
const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketing-stock.json"), "utf8"));
const W = CFG.pesos;
const PISO_MARGEM = CFG_STOCK.margem_pct_minima_para_anunciar != null ? CFG_STOCK.margem_pct_minima_para_anunciar : 0.1;

function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }

function diasTexto(dias) {
  const N = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  if (!dias || !dias.length) return "esta semana";
  if (dias.length === 1) return N[dias[0]];
  const nomes = dias.map((d) => N[d]);
  return nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
}

function preencher(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

// p: produto de marketing-product-analytics (com .papeis da Fase A anexado, ou papel_primario)
// ctx: { duracaoDias, concorrenciaCategorias:Set, medianaPrecoCategoria, precoPromo, descontoPct, dias:[dow] }
function angulosDeProduto(p, ctx = {}) {
  const papeis = new Set(p.papeis || (p.papel_primario ? [p.papel_primario] : []));
  const cand = {};
  const preco = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
  const catAtaque = ctx.concorrenciaCategorias instanceof Set && ctx.concorrenciaCategorias.has(p.categoria);
  const janelaCurta = ctx.duracaoDias != null && ctx.duracaoDias <= 3;
  const margemFolga = p.margem_pct != null && p.margem_pct >= PISO_MARGEM + CFG.margem_folga_acima_do_piso;
  const tetoTicket = ctx.medianaPrecoCategoria != null ? ctx.medianaPrecoCategoria * CFG.ticket_alto_multiplo_mediana : null;
  const estoqueAlto = papeis.has("DESOVA") || ["PARADO", "OPORTUNIDADE"].includes(p.cobertura_rotulo) || p.cobertura_infinita;

  // PRECO segue o desconto realmente planejado para a campanha (sinal mais honesto);
  // sem contexto de campanha, cai para folga de margem / ticket alto.
  const descPlanej = ctx.descontoPct != null ? Number(ctx.descontoPct) : null;
  if (descPlanej != null && descPlanej >= 5) {
    const forca = descPlanej >= 15 ? W.preco_desconto_alto : descPlanej >= 8 ? W.preco_desconto_medio : W.preco_desconto_baixo;
    cand.PRECO = { forca, motivo: `desconto de ${Math.round(descPlanej)}% planejado — economia direta`, proxy: p.margem_pct == null };
  } else if (margemFolga) {
    cand.PRECO = { forca: W.preco_margem_folga, motivo: `margem de ${(p.margem_pct * 100).toFixed(0)}% comporta o desconto` };
  } else if (tetoTicket != null && preco != null && preco >= tetoTicket) {
    cand.PRECO = { forca: W.preco_ticket_alto, motivo: `ticket de R$ ${preco.toFixed(2)} acima da mediana da categoria — desconto chama atenção` };
  } else if (p.margem_pct == null && preco != null) {
    cand.PRECO = { forca: W.preco_ticket_alto * 0.7, motivo: "sem custo cadastrado — desconto declarado como proxy", proxy: true };
  }

  if (janelaCurta) cand.URGENCIA = { forca: W.urgencia_janela_curta, motivo: `campanha de ${ctx.duracaoDias} dia(s) — escassez real` };
  else if (papeis.has("DESOVA")) cand.URGENCIA = { forca: W.urgencia_desova, motivo: "estoque em excesso — prazo curto força a saída" };

  if (estoqueAlto) cand.VOLUME = { forca: W.volume_estoque_alto, motivo: "estoque sobrando — 'leve mais' escoa mais rápido" };
  else if (papeis.has("RECORRENCIA")) cand.VOLUME = { forca: W.volume_recorrencia, motivo: "item de recompra — leve o do mês inteiro de uma vez" };

  if (catAtaque) cand.COMPARACAO = { forca: W.comparacao_concorrencia, motivo: `concorrência com oferta abaixo da nossa em "${p.categoria}" — reforçar competitividade` };

  if (papeis.has("RECORRENCIA")) cand.RECORRENCIA = { forca: W.recorrencia_papel, motivo: "papel de recorrência — comunicar frequência de recompra" };

  cand.CONVENIENCIA = { forca: W.conveniencia_base, motivo: "reforço padrão de pedido por WhatsApp / entrega" };

  // o papel primário puxa o ângulo que combina com ele (mantém variedade e coerência)
  const pp = ctx.papelPrimario;
  const bonusPorPapel = { CHAMARIZ: "PRECO", DESOVA: "URGENCIA", RECORRENCIA: "RECORRENCIA", COMPLEMENTAR: "VOLUME" };
  if (pp && bonusPorPapel[pp] && cand[bonusPorPapel[pp]]) cand[bonusPorPapel[pp]].forca += 0.15;
  // MARGEM não deve liderar com desconto — seu papel é preservar rentabilidade
  if (pp === "MARGEM" && cand.PRECO) cand.PRECO.forca *= 0.5;

  const nomes = Object.keys(cand).sort((a, b) => cand[b].forca - cand[a].forca);
  const vars = {
    produto: p.descricao,
    preco_promo: ctx.precoPromo != null ? Number(ctx.precoPromo).toFixed(2) : (preco != null ? preco.toFixed(2) : "—"),
    desconto: ctx.descontoPct != null ? Math.round(ctx.descontoPct) : "—",
    dias_texto: diasTexto(ctx.dias),
  };
  const detalhe = nomes.map((id) => ({
    id,
    rotulo: CFG.angulos[id].rotulo,
    icone: CFG.angulos[id].icone,
    forca: r2(cand[id].forca),
    motivo: cand[id].motivo,
    proxy: !!cand[id].proxy,
    sugestao_copy: preencher(CFG.angulos[id].copy, vars),
  }));

  return {
    primario: nomes[0],
    angulos: detalhe,
    evidencia: { campo: "angulo", valor: nomes[0], fonte: "marketing/angulos.js (margem, cobertura, papel, janela, concorrência)", periodo: ctx.refDate || null },
  };
}

module.exports = { angulosDeProduto, diasTexto, ANGULOS: CFG.angulos };
