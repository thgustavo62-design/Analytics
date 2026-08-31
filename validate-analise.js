// Validador do JSON do Motor de Análise Comercial (schema da Parte 2 do prompt).
// Leve, sem dependência. Devolve { ok, erros: [] }.
// O contrato diz "campos sem dado recebem null" — então números aceitam null; o que é
// duro: raiz é objeto, meta/diagnostico_executivo/pergunta_central presentes e coerentes,
// as listas são listas, e cada item tem os campos-chave no tipo certo.

const LOJAS = ["Minas Farma", "Farma e Farma"];
const DECISOES = ["ESCALAR", "MANTER", "OTIMIZAR", "TESTAR", "REDUZIR", "ENCERRAR", "INCONCLUSIVO"];
const GRAVIDADES = ["critico", "alto", "medio", "baixo"];

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isArr = Array.isArray;
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v) => v == null || isNum(v);
const strOrNull = (v) => v == null || isStr(v);

function checkArr(erros, doc, key, itemCheck) {
  const a = doc[key];
  if (!isArr(a)) {
    erros.push(`${key} deve ser uma lista`);
    return;
  }
  a.forEach((it, i) => {
    if (!isObj(it)) {
      erros.push(`${key}[${i}] não é um objeto`);
      return;
    }
    const msg = itemCheck(it, i);
    if (msg) erros.push(msg);
  });
}

function validate(doc) {
  const e = [];
  if (!isObj(doc)) return { ok: false, erros: ["raiz não é um objeto JSON"] };

  const m = doc.meta;
  if (!isObj(m)) {
    e.push("meta ausente ou inválida");
  } else {
    if (!LOJAS.includes(m.loja)) e.push(`meta.loja deve ser uma de: ${LOJAS.join(", ")}`);
    if (!isObj(m.periodo) || !/^\d{4}-\d{2}-\d{2}$/.test(m.periodo.inicio || "")) e.push("meta.periodo.inicio deve ser AAAA-MM-DD");
    if (m.periodo && m.periodo.fim != null && !/^\d{4}-\d{2}-\d{2}$/.test(m.periodo.fim)) e.push("meta.periodo.fim inválido");
  }

  const dx = doc.diagnostico_executivo;
  if (!isObj(dx)) {
    e.push("diagnostico_executivo ausente");
  } else {
    if (!isStr(dx.titulo)) e.push("diagnostico_executivo.titulo deve ser string");
    if (!isArr(dx.paragrafos) || !dx.paragrafos.every(isStr)) e.push("diagnostico_executivo.paragrafos deve ser lista de strings");
    const dp = dx.decisao_principal;
    if (!isObj(dp)) e.push("diagnostico_executivo.decisao_principal ausente");
    else {
      if (!isStr(dp.acao)) e.push("decisao_principal.acao deve ser string");
      if (!numOrNull(dp.impacto_estimado_mes)) e.push("decisao_principal.impacto_estimado_mes deve ser número ou null");
      if (dp.confianca != null && !["alta", "media", "baixa"].includes(dp.confianca)) e.push("decisao_principal.confianca deve ser alta|media|baixa|null");
    }
  }

  checkArr(e, doc, "kpis", (k, i) => (!isStr(k.rotulo) ? `kpis[${i}].rotulo deve ser string` : !numOrNull(k.valor) ? `kpis[${i}].valor deve ser número ou null` : null));
  checkArr(e, doc, "baseline_semanal", (b, i) => (!isStr(b.rotulo) ? `baseline_semanal[${i}].rotulo deve ser string` : null));
  checkArr(e, doc, "campanhas", (c, i) => (!isStr(c.nome) ? `campanhas[${i}].nome deve ser string` : !DECISOES.includes(c.decisao) ? `campanhas[${i}].decisao inválida (${c.decisao}) — use ${DECISOES.join("|")}` : null));
  checkArr(e, doc, "canais", (c, i) => (!isStr(c.nome) ? `canais[${i}].nome deve ser string` : null));
  checkArr(e, doc, "riscos", (r, i) => (!isStr(r.titulo) ? `riscos[${i}].titulo deve ser string` : r.gravidade != null && !GRAVIDADES.includes(r.gravidade) ? `riscos[${i}].gravidade inválida (${r.gravidade})` : null));
  checkArr(e, doc, "oportunidades", (o, i) => (!isStr(o.titulo) ? `oportunidades[${i}].titulo deve ser string` : null));
  checkArr(e, doc, "acoes", (a, i) => (!isStr(a.acao) ? `acoes[${i}].acao deve ser string` : null));
  checkArr(e, doc, "correcoes", (c, i) => (!isStr(c.conclusao_nova) ? `correcoes[${i}].conclusao_nova deve ser string` : null));

  if (!isArr(doc.limitacoes) || !doc.limitacoes.every(strOrNull)) e.push("limitacoes deve ser lista de strings");
  if (!isObj(doc.pergunta_central) || typeof doc.pergunta_central.melhor_caminho !== "boolean") e.push("pergunta_central.melhor_caminho deve ser true/false");

  return { ok: e.length === 0, erros: e };
}

module.exports = { validate, LOJAS, DECISOES, GRAVIDADES };
