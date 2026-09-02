// Fase A — sub-scores de marketing por produto.
//
// Camada DETERMINÍSTICA. Recompoe os 7 componentes do Opportunity Score (cada um já em
// 0..1, calculado no backend) em quatro leituras nomeadas + uma interpretação:
//   - traffic_score   : serve para trazer gente para a loja?
//   - profit_score    : serve para gerar lucro?  (null sem custo cadastrado)
//   - clearance_score : preciso vender por excesso de estoque?  (null sem feed de estoque)
//   - campaign_score  : vale colocar em campanha? (opportunity, penalizado se do-not-promote)
//   - creative_score  : potencial de gerar interesse — SEMPRE null nesta fase
//                       (requer o log de publicações — Creative Intelligence, Fase F)
//
// Nada é inventado: um sub-score só existe se os componentes que o alimentam têm dado real.

function r1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function clamp100(x) { return x < 0 ? 0 : x > 100 ? 100 : x; }

function ausente(dados_ausentes, prefixo) {
  return (dados_ausentes || []).some((a) => String(a).startsWith(prefixo));
}

function subScores(p) {
  const opp = p.opportunity || {};
  const comp = opp.componentes || {};
  const da = opp.dados_ausentes || [];
  const val = (k) => (comp[k] && comp[k].valor != null ? comp[k].valor : 0.5);
  const perc = p.percentis || {};
  const pCup = perc.cupons == null ? 0.5 : perc.cupons;

  // ---- traffic: demanda + presença em cupom + lift histórico da categoria + centralidade na cesta
  const trafPesos = { demanda: 0.45, cupom: 0.2, campanha_historica: 0.2, cesta: 0.15 };
  const traffic = 100 * (
    trafPesos.demanda * val("demanda") +
    trafPesos.cupom * pCup +
    trafPesos.campanha_historica * val("campanha_historica") +
    trafPesos.cesta * val("cesta")
  );
  const trafComDado = trafPesos.demanda + trafPesos.cupom +
    (ausente(da, "campanha_historica") ? 0 : trafPesos.campanha_historica) +
    (ausente(da, "cesta") ? 0 : trafPesos.cesta);
  const traffic_score = { valor: r1(clamp100(traffic)), confianca: Math.round(trafComDado * 100) / 100, base: ["demanda", "cupom", "campanha_historica", "cesta"] };

  // ---- profit: margem manda; um pouco de demanda para diferenciar volume
  let profit_score;
  if (ausente(da, "margem")) {
    profit_score = { valor: null, confianca: 0, ausente: "requer custo cadastrado" };
  } else {
    profit_score = { valor: r1(clamp100(100 * (0.7 * val("margem") + 0.3 * val("demanda")))), confianca: 0.9, base: ["margem", "demanda"] };
  }

  // ---- clearance: só faz sentido com feed de estoque; parte da cobertura, modula por demanda
  let clearance_score;
  if (ausente(da, "estoque") || p.cobertura_rotulo === "SEM_ESTOQUE" || p.estoque_atual == null) {
    clearance_score = { valor: null, ausente: "requer feed de estoque" };
  } else {
    const base = { PARADO: 95, OPORTUNIDADE: 72, NORMAL: 28, ATENCAO: 8, RUPTURA: 0 }[p.cobertura_rotulo];
    const b = base == null ? 0 : base;
    clearance_score = { valor: r1(clamp100(b * (0.7 + 0.3 * val("demanda")))), confianca: 0.9, base: ["cobertura", "demanda"] };
  }

  // ---- campaign: vale colocar em campanha?  = opportunity, cortado se bloqueado
  let campaign_score;
  if (p.do_not_promote) {
    campaign_score = { valor: Math.min(25, opp.score == null ? 25 : opp.score), nota: "bloqueado (do-not-promote) — não deve entrar em campanha agora" };
  } else {
    campaign_score = { valor: opp.score == null ? null : r1(opp.score), confianca: opp.confianca };
  }

  const creative_score = { valor: null, ausente: "requer log de publicações (Creative Intelligence — Fase F)" };

  // ---- interpretação: traffic x profit x clearance
  const t = traffic_score.valor, pr = profit_score.valor, cl = clearance_score.valor;
  let interpretacao;
  if (cl != null && cl >= 70) interpretacao = "Prioridade de desova — estoque em excesso; usar preço/combo para girar.";
  else if (t >= 65 && pr != null && pr >= 65) interpretacao = "Forte para atrair e para lucrar — bom candidato a Hero.";
  else if (t >= 60 && pr != null && pr < 45) interpretacao = "Bom para atração, fraco em rentabilidade — usar como chamariz/tráfego, não como margem.";
  else if (pr != null && pr >= 65 && t < 45) interpretacao = "Bom para margem, atração fraca — anunciar ao lado de um produto de tráfego.";
  else if (t >= 60) interpretacao = "Puxa fluxo — topo de post/stories.";
  else interpretacao = "Sinais medianos — sem papel de destaque.";

  return { traffic_score, profit_score, clearance_score, campaign_score, creative_score, interpretacao };
}

module.exports = { subScores };
