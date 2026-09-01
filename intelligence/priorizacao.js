// Fase 5 — Priority Engine. prioridade 0..100 a partir de severidade, confiança, impacto
// financeiro estimado, recência e acionabilidade. Pesos em config/intelligence.json.

const fs = require("fs");
const path = require("path");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "intelligence.json"), "utf8")).prioridade;

// quão "acionável" é cada tipo de sinal (dá pra fazer algo hoje?).
const ACIONABILIDADE = {
  STAGNANT_STOCK: 1.0,
  CROSS_SELL_OPPORTUNITY: 0.95,
  MARKETING_OPPORTUNITY: 0.95,
  CAMPAIGN_UNDERPERFORMANCE: 0.8,
  CAMPAIGN_OVERPERFORMANCE: 0.8,
  COMPETITOR_PRICE_ATTACK: 0.7,
  CATEGORY_GROWTH: 0.7,
  CATEGORY_DECLINE: 0.6,
  STOCK_RISK: 0.6,
  DEMAND_ANOMALY: 0.55,
  CREATIVE_FATIGUE: 0.5,
  CONTRADICTION: 0.4,
};

function recencia(primeiraVezIso, agora = Date.now()) {
  if (!primeiraVezIso) return 1;
  const dias = (agora - new Date(primeiraVezIso).getTime()) / 86400000;
  return Math.pow(0.5, dias / (CFG.meia_vida_dias || 14)); // 1 no dia, cai pela metade a cada meia-vida
}

function prioridade(sinal, opts = {}) {
  const w = CFG.pesos;
  const sev = Math.max(0, Math.min(1, sinal.severidade || 0));
  const conf = Math.max(0, Math.min(1, sinal.confianca || 0));
  const impactoNorm = sinal.impacto_estimado
    ? Math.min(1, sinal.impacto_estimado / (CFG.impacto_teto_mensal || 20000))
    : 0.15; // sem número de impacto, assume baixo mas não zero
  const rec = recencia(opts.primeira_vez || new Date().toISOString(), opts.agora);
  const acion = ACIONABILIDADE[sinal.tipo] ?? 0.5;
  const soma = w.severidade + w.confianca + w.impacto + w.recencia + w.acionabilidade;
  const bruto =
    (w.severidade * sev + w.confianca * conf + w.impacto * impactoNorm + w.recencia * rec + w.acionabilidade * acion) / soma;
  return Math.round(bruto * 1000) / 10; // 0..100, 1 casa
}

module.exports = { prioridade, recencia, ACIONABILIDADE };
