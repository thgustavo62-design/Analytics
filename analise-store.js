// Armazenamento dos JSONs do Motor de Análise Comercial (Fase 2).
// Um arquivo por loja/mês: data/analises/<slug-da-loja>/analise_AAAA-MM.json
// Nunca sobrescreve um JSON bom por um quebrado — o quebrado vai para *.INVALIDO.json.

const fs = require("fs");
const path = require("path");

const DIR = process.env.VA_ANALISES || path.join(__dirname, "data", "analises");

const slug = (loja) => String(loja).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

function dirFor(loja) {
  const d = path.join(DIR, slug(loja));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function save(loja, ym, doc) {
  const f = path.join(dirFor(loja), `analise_${ym}.json`);
  fs.writeFileSync(f, JSON.stringify(doc, null, 2), "utf8");
  return f;
}

function saveErro(loja, ym, erros, recebido) {
  const f = path.join(dirFor(loja), `analise_${ym}.INVALIDO.json`);
  fs.writeFileSync(f, JSON.stringify({ recusadoEm: new Date().toISOString(), erros, recebido }, null, 2), "utf8");
  return f;
}

function listMeses(loja) {
  try {
    return fs
      .readdirSync(dirFor(loja))
      .filter((n) => /^analise_\d{4}-\d{2}\.json$/.test(n))
      .map((n) => n.slice(8, 15))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function read(loja, ym) {
  const f = path.join(dirFor(loja), `analise_${ym}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function latest(loja) {
  const meses = listMeses(loja);
  return meses.length ? { ym: meses[0], doc: read(loja, meses[0]) } : null;
}

module.exports = { save, saveErro, listMeses, read, latest, DIR };
