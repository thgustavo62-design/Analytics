// Lê a planilha padrão Concorrentes_Coleta_AAAA-MM-DD.xlsx (36 colunas, cabeçalho na
// linha 1) e cruza as ofertas confirmadas e vigentes com o preço médio que a gente
// pratica no mesmo produto. Reaproveita o formato já usado no ecossistema — não inventa
// planilha nova.

const XLSX = require("xlsx");
const { bestMatch } = require("../match");

// Nome canônico -> possíveis cabeçalhos (normalizados) + índice de fallback (0-based).
const COLS = {
  concorrente: { nomes: ["concorrente"], idx: 2 },
  categoria: { nomes: ["categoria"], idx: 6 },
  produto: { nomes: ["produto"], idx: 8 },
  marca: { nomes: ["marca"], idx: 9 },
  preco_normal: { nomes: ["preco normal"], idx: 15 },
  preco_promo: { nomes: ["preco promo"], idx: 16 },
  validade: { nomes: ["validade"], idx: 28 },
  nivel_confianca: { nomes: ["nivel confianca", "nivel de confianca"], idx: 33 },
  status_validacao: { nomes: ["status validacao", "status de validacao"], idx: 34 },
};

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
  const idx = {};
  for (const [key, spec] of Object.entries(COLS)) {
    let i = normHeader.findIndex((h) => spec.nomes.includes(h));
    if (i < 0) i = spec.idx; // fallback posicional
    idx[key] = i;
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
  const candidatos = nossosProdutos.filter((p) => p.precoMedio != null).map((p) => ({ name: p.name, precoMedio: p.precoMedio }));

  const ofertas = [];
  let descartadasStatus = 0;
  let expiradas = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const produto = row[idx.produto];
    if (!produto || String(produto).trim() === "") continue; // linha vazia no fim da planilha

    const status = String(row[idx.status_validacao] ?? "").trim();
    if (norm(status) !== "confirmada") {
      descartadasStatus++;
      continue;
    }

    const validadeIso = parseValidade(row[idx.validade]);
    if (validadeIso && validadeIso < refDate) {
      expiradas++;
      continue;
    }

    const precoPromo = parsePreco(row[idx.preco_promo]);
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
