// Armazenamento dos JSONs do Motor de Análise Comercial (Fase 2).
//
// Fonte de verdade = o BANCO (tabela analises_comerciais em data/analytics.db). Assim a
// análise não se perde se os arquivos forem mexidos. Também gravamos um espelho legível
// em data/analises/<loja>/analise_AAAA-MM.json (para inspeção / exportação manual), e
// um analise_AAAA-MM.INVALIDO.json quando um JSON chega quebrado.

const fs = require("fs");
const path = require("path");
const { saveAnaliseComercial, getAnaliseComercial, listAnalisesComerciais } = require("./db");

const DIR = process.env.VA_ANALISES || path.join(__dirname, "data", "analises");

const slug = (loja) => String(loja).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const parseYm = (ym) => {
  const m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`período inválido: ${ym}`);
  return [+m[1], +m[2]];
};

function dirFor(loja) {
  const d = path.join(DIR, slug(loja));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function save(loja, ym, doc) {
  const [ano, mes] = parseYm(ym);
  saveAnaliseComercial(loja, ano, mes, doc); // banco = fonte de verdade
  try {
    fs.writeFileSync(path.join(dirFor(loja), `analise_${ym}.json`), JSON.stringify(doc, null, 2), "utf8");
  } catch (e) {
    console.error("[analise-store] espelho em disco falhou (banco ok):", e.message);
  }
  return `db:analises_comerciais ${loja} ${ym}`;
}

function saveErro(loja, ym, erros, recebido) {
  const f = path.join(dirFor(loja), `analise_${ym}.INVALIDO.json`);
  fs.writeFileSync(f, JSON.stringify({ recusadoEm: new Date().toISOString(), erros, recebido }, null, 2), "utf8");
  return f;
}

function read(loja, ym) {
  const [ano, mes] = parseYm(ym);
  const doDb = getAnaliseComercial(loja, ano, mes);
  if (doDb) return doDb;
  // migração: se só existir o arquivo antigo, importa para o banco
  try {
    const f = path.join(dirFor(loja), `analise_${ym}.json`);
    if (fs.existsSync(f)) {
      const doc = JSON.parse(fs.readFileSync(f, "utf8"));
      saveAnaliseComercial(loja, ano, mes, doc);
      return doc;
    }
  } catch (e) {
    /* ignora */
  }
  return null;
}

function listMeses(loja) {
  const doBanco = listAnalisesComerciais(loja).map((r) => r.periodo);
  const set = new Set(doBanco);
  try {
    for (const n of fs.readdirSync(dirFor(loja))) {
      const m = n.match(/^analise_(\d{4}-\d{2})\.json$/);
      if (m) set.add(m[1]);
    }
  } catch (e) {
    /* ignora */
  }
  return [...set].sort().reverse();
}

function latest(loja) {
  const meses = listMeses(loja);
  return meses.length ? { ym: meses[0], doc: read(loja, meses[0]) } : null;
}

module.exports = { save, saveErro, listMeses, read, latest, DIR };
