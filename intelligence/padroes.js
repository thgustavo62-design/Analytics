// Fase 10 — Pattern Engine. Aprende, a partir das decisões que TIVERAM resultado medido, o
// que costuma funcionar: chave = "(tipos de sinal que motivaram) => (tipo de decisão)".
// Só conta amostra quando há resultado avaliado. Amostra mínima em config/intelligence.json.

const fs = require("fs");
const path = require("path");
const db = require("../db");

const AMOSTRA_MIN = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "intelligence.json"), "utf8")).padroes || {}).amostra_minima || 3;

function chaveDaDecisao(dec) {
  const tipos = new Set();
  for (const sid of dec.sinais || []) {
    const s = db.getSinal(Number(sid));
    if (s) tipos.add(s.tipo);
  }
  const alvo = dec.tipo || "OUTRO";
  return [...tipos].sort().join("+") + " => " + alvo || "SEM_SINAL => " + alvo;
}

// chamado quando um resultado é adicionado a uma decisão
function aprenderComDecisao(decisaoId) {
  const dec = db.getDecisao(decisaoId);
  if (!dec || !dec.resultados.length) return null;
  const chave = chaveDaDecisao(dec);
  // veredito consolidado: POSITIVO se a maioria dos resultados é POSITIVO
  const pos = dec.resultados.filter((r) => r.veredito === "POSITIVO").length;
  const neg = dec.resultados.filter((r) => r.veredito === "NEGATIVO").length;
  const sucesso = pos > neg ? true : neg > pos ? false : null;
  if (sucesso == null) return db.upsertPadrao(dec.loja, chave, { descricao: chave });
  return db.upsertPadrao(dec.loja, chave, { descricao: chave, sucesso });
}

// "situação semelhante já aconteceu em…" — padrões + decisões passadas que casam com os
// tipos de sinal atuais.
function semelhantes(loja, { sinalTipos = [], tipoDecisao = null } = {}) {
  const setTipos = new Set(sinalTipos);
  const padroes = db.listPadroes(loja).filter((p) => {
    if (p.amostra_n < AMOSTRA_MIN) return false;
    const [lado] = p.chave.split(" => ");
    const tp = lado.split("+");
    return tp.some((t) => setTipos.has(t)) && (!tipoDecisao || p.chave.endsWith("=> " + tipoDecisao));
  });
  const decisoes = db.listDecisoes(loja).filter((d) => {
    const tipos = (d.sinais || []).map((sid) => { const s = db.getSinal(Number(sid)); return s && s.tipo; }).filter(Boolean);
    return tipos.some((t) => setTipos.has(t));
  }).slice(0, 8);
  return { padroes, decisoes };
}

// visão geral p/ a tela: padrões ordenados por confiança de amostra
function panorama(loja) {
  return db.listPadroes(loja).map((p) => ({
    ...p,
    maduro: p.amostra_n >= AMOSTRA_MIN,
    leitura: p.amostra_n < AMOSTRA_MIN
      ? `amostra pequena (${p.amostra_n}) — ainda aprendendo`
      : `${Math.round((p.taxa_sucesso || 0) * 100)}% de acerto em ${p.amostra_n} decisões`,
  }));
}

module.exports = { aprenderComDecisao, semelhantes, panorama, chaveDaDecisao, AMOSTRA_MIN };
