// Lê preço de concorrente jogado na inbox/. Dois formatos:
//   1) a planilha padrão Concorrentes_Coleta_AAAA-MM-DD.xlsx (36 colunas);
//   2) qualquer planilha simples com Concorrente + Produto + um preço (colunas mapeadas
//      por config/concorrentes.json; sem status = tudo confirmado; sem validade = nada expira).
// Cruza as ofertas com o preço médio que a gente pratica no mesmo produto.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { bestMatch } = require("../match");

const CFG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "concorrentes.json"), "utf8"));
  } catch {
    return { colunas: {}, posicional_36col: {} };
  }
})();

// Nome canônico -> sinônimos de cabeçalho (do config) + índice posicional da planilha de 36 col.
const COLS = {};
for (const [k, nomes] of Object.entries(CFG.colunas || {})) {
  COLS[k] = { nomes: (nomes || []).map((n) => String(n).toLowerCase()), idx: (CFG.posicional_36col || {})[k] };
}
// se o config falhar, mantém o mínimo p/ a planilha padrão
if (!COLS.produto) {
  Object.assign(COLS, {
    concorrente: { nomes: ["concorrente"], idx: 2 }, categoria: { nomes: ["categoria"], idx: 6 },
    produto: { nomes: ["produto"], idx: 8 }, marca: { nomes: ["marca"], idx: 9 },
    preco_normal: { nomes: ["preco normal"], idx: 15 }, preco_promo: { nomes: ["preco promo"], idx: 16 },
    validade: { nomes: ["validade"], idx: 28 }, nivel_confianca: { nomes: ["nivel confianca"], idx: 33 },
    status_validacao: { nomes: ["status validacao"], idx: 34 },
  });
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePreco(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v)
    .replace(/r\$/i, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "") // milhar
    .replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// "até 10/09/2026" | "10/09/2026" | Date | "2026-09-10" -> 'AAAA-MM-DD' ou null
function parseValidade(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function resolveIndices(header) {
  const normHeader = header.map(norm);
  const largo = header.length >= 20; // parece a planilha padrão de 36 colunas
  const idx = {};
  for (const [key, spec] of Object.entries(COLS)) {
    // 1) cabeçalho igual a um sinônimo
    let i = normHeader.findIndex((h) => spec.nomes.includes(h));
    // 2) cabeçalho que CONTÉM um sinônimo (só sinônimos com >= 4 letras, p/ não casar "de"/"por" solto)
    if (i < 0) i = normHeader.findIndex((h) => spec.nomes.some((n) => n.length >= 4 && h.includes(n)));
    // 3) só na planilha larga: fallback posicional fixo
    if (i < 0 && largo && spec.idx != null) i = spec.idx;
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

/**
 * @param {string} xlsxPath
 * @param {Array<{name:string, precoMedio:number|null}>} nossosProdutos  de aggregate().precoMedioPorProduto
 * @param {{ referenceDate?: string }} opts  data de referência p/ "não expirada" (default: hoje)
 */
function parseConcorrentes(xlsxPath, nossosProdutos = [], opts = {}) {
  const refDate = opts.referenceDate || new Date().toISOString().slice(0, 10);
  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!rows.length) throw new Error("Planilha de concorrentes vazia.");

  const idx = resolveIndices(rows[0]);
  if (idx.produto == null) {
    throw new Error(
      "planilha de concorrente sem coluna de produto reconhecível. Precisa ter ao menos " +
      "'Produto' e um 'Preço' (ajuste os nomes em config/concorrentes.json)."
    );
  }
  const temStatus = idx.status_validacao != null;
  const temValidade = idx.validade != null;
  const candidatos = nossosProdutos.filter((p) => p.precoMedio != null).map((p) => ({ name: p.name, precoMedio: p.precoMedio }));

  const ofertas = [];
  let descartadasStatus = 0;
  let expiradas = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const produto = row[idx.produto];
    if (!produto || String(produto).trim() === "") continue; // linha vazia no fim da planilha

    const status = temStatus ? String(row[idx.status_validacao] ?? "").trim() : "Confirmada";
    if (temStatus && norm(status) !== "confirmada") {
      descartadasStatus++;
      continue;
    }

    if (temValidade) {
      const validadeIso = parseValidade(row[idx.validade]);
      if (validadeIso && validadeIso < refDate) {
        expiradas++;
        continue;
      }
    }

    // sem coluna de "preço promo", usa o único preço que houver (normal)
    const precoPromo = idx.preco_promo != null ? parsePreco(row[idx.preco_promo]) : parsePreco(row[idx.preco_normal]);
    const marca = row[idx.marca] ? String(row[idx.marca]).trim() : null;
    const m = candidatos.length
      ? bestMatch(String(produto), candidatos, { minScore: 0.5, minOverlap: 2, brand: marca })
      : null;
    const nossoPreco = m ? m.match.precoMedio : null;
    let abaixo = null;
    if (precoPromo != null && nossoPreco != null) abaixo = precoPromo < nossoPreco;

    ofertas.push({
      concorrente: String(row[idx.concorrente] ?? "").trim() || "(não informado)",
      categoria: row[idx.categoria] ? String(row[idx.categoria]).trim() : null,
      produto: String(produto).trim(),
      marca: marca,
      preco_normal: parsePreco(row[idx.preco_normal]),
      preco_promo: precoPromo,
      validade: row[idx.validade] ? String(row[idx.validade]).trim() : null,
      nivel_confianca: row[idx.nivel_confianca] ? String(row[idx.nivel_confianca]).trim() : null,
      status_validacao: status,
      produto_casado: m ? m.match.name : null,
      match_score: m ? m.score : null,
      nosso_preco_medio: nossoPreco,
      abaixo_do_nosso: abaixo,
    });
  }

  return { ofertas, resumo: resumir(ofertas, { descartadasStatus, expiradas }) };
}

function resumir(ofertas, extra = {}) {
  const porConc = new Map();
  for (const o of ofertas) {
    if (!porConc.has(o.concorrente))
      porConc.set(o.concorrente, { concorrente: o.concorrente, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, "Média": 0, Baixa: 0 } });
    const e = porConc.get(o.concorrente);
    e.ofertas++;
    if (o.abaixo_do_nosso != null) {
      e.comparaveis++;
      if (o.abaixo_do_nosso) e.abaixo++;
    }
    const nc = o.nivel_confianca || "";
    if (/alta/i.test(nc)) e.confianca.Alta++;
    else if (/m[eé]dia/i.test(nc)) e.confianca["Média"]++;
    else if (/baixa/i.test(nc)) e.confianca.Baixa++;
  }
  return {
    totalOfertas: ofertas.length,
    comparaveis: ofertas.filter((o) => o.abaixo_do_nosso != null).length,
    abaixoDoNosso: ofertas.filter((o) => o.abaixo_do_nosso === true).length,
    descartadasStatus: extra.descartadasStatus || 0,
    expiradas: extra.expiradas || 0,
    porConcorrente: [...porConc.values()].sort((a, b) => b.abaixo - a.abaixo || b.ofertas - a.ofertas),
  };
}

module.exports = { parseConcorrentes, parsePreco, parseValidade };
