// Lê a TABELA DE PLANEJAMENTO DE PROMOÇÕES da loja (o "tabelão" / encarte): os produtos que
// vão entrar em oferta e a que preço. xlsx ou csv jogado na inbox.
//
// Config: config/promocoes.json (sinônimos de coluna, palavras do nome do arquivo, lojas).
// Saída: { linhas: [{descricao, ean, codigo, categoria, marca, preco_normal, preco_promo,
//          desconto_pct, data_inicio, data_fim, campanha, loja}], header, resumo }
//
// Determinístico. Preço/desconto: se falta um e dá pra derivar do outro, deriva.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "promocoes.json"), "utf8")); }
  catch { return { colunas: {}, arquivo_contem: ["promoc", "oferta", "encarte"], nome_todas_as_lojas: ["geral", "rede"] }; }
})();

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

function ehArquivoPromocao(base) {
  const b = norm(base);
  return (CFG.arquivo_contem || []).some((w) => b.includes(norm(w)));
}

function parsePreco(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  let s = String(v).replace(/r\$/i, "").replace(/\s/g, "");
  if (!s || /^-+$/.test(s)) return null;
  // 1.234,56 -> 1234.56 ; 1,99 -> 1.99 ; 12.90 -> 12.90
  if (s.includes(",")) s = s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePct(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 0 && v < 1 ? v : (v >= 1 && v <= 100 ? v / 100 : null);
  const m = String(v).replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return n > 0 && n < 1 ? n : (n >= 1 && n <= 100 ? n / 100 : null);
}

function parseData(v, refYear) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // serial do Excel (dias desde 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  let s = String(v).toLowerCase().replace(/at[eé]\s*/i, "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?/);
  if (m) {
    let [, dd, mm, yy] = m;
    let y = yy ? (yy.length === 2 ? 2000 + +yy : +yy) : (refYear || new Date().getFullYear());
    dd = dd.padStart(2, "0"); mm = mm.padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

// resolve os índices de coluna a partir de UMA linha de cabeçalho
function resolverColunas(headerRow) {
  const cells = headerRow.map((c) => norm(c));
  const idx = {};
  for (const [canon, nomes] of Object.entries(CFG.colunas || {})) {
    for (const nome of nomes) {
      const alvo = norm(nome);
      let j = cells.indexOf(alvo);
      if (j < 0) j = cells.findIndex((c) => c && (c === alvo || c.startsWith(alvo + " ") || c.replace(/[:.]/g, "").trim() === alvo));
      if (j >= 0) { idx[canon] = j; break; }
    }
  }
  return idx;
}

function acharCabecalho(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const idx = resolverColunas((rows[r] || []).map((c) => String(c ?? "")));
    if ((idx.produto != null || idx.ean != null) && (idx.preco_promo != null || idx.desconto_pct != null) && Object.keys(idx).length >= 2) {
      return { linha: r, idx };
    }
  }
  return null;
}

function lojaDoNome(base) {
  const b = norm(base);
  if ((CFG.nome_todas_as_lojas || []).some((w) => b.includes(norm(w)))) return "__todas__";
  if (/farma\s*e\s*farma|farmaefarma|\bff\b/.test(b)) return "Farma e Farma";
  if (/minas\s*farma|minasfarma|\bmf\b/.test(b)) return "Minas Farma";
  return null;
}

function parsePromocoes(filePath) {
  const base = path.basename(filePath);
  // raw:true → não deixa o XLSX "adivinhar" datas (planilha BR usa DD/MM; o adivinhador é US).
  // csv lido como UTF-8 explícito (senão acentos viram lixo).
  const wb = /\.csv$/i.test(filePath)
    ? XLSX.read(fs.readFileSync(filePath, "utf8"), { type: "string", raw: true })
    : XLSX.readFile(filePath, { cellDates: false, raw: true });
  let alvo = null;
  for (const nome of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: null, raw: true });
    const cab = acharCabecalho(rows);
    if (cab) { alvo = { rows, cab, aba: nome }; break; }
  }
  if (!alvo) {
    throw new Error(`nenhuma aba com cabeçalho reconhecível de tabela de promoções em "${base}". ` +
      "Precisa de uma coluna de produto (ou EAN) e uma de preço promocional (ou desconto). Ajuste config/promocoes.json.");
  }
  const { rows, cab } = alvo;
  const idx = cab.idx;
  const anoArq = +(base.match(/(20\d{2})/) || [])[1] || new Date().getFullYear();
  const lojaArq = idx.loja != null ? null : lojaDoNome(base);

  const linhas = [];
  let semPreco = 0, semLoja = 0;
  for (let r = cab.linha + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    const descricao = idx.produto != null ? String(row[idx.produto] ?? "").trim() : "";
    const ean = idx.ean != null ? String(row[idx.ean] ?? "").replace(/\D/g, "") || null : null;
    if (!descricao && !ean) continue;

    let precoNormal = idx.preco_normal != null ? parsePreco(row[idx.preco_normal]) : null;
    let precoPromo = idx.preco_promo != null ? parsePreco(row[idx.preco_promo]) : null;
    let desc = idx.desconto_pct != null ? parsePct(row[idx.desconto_pct]) : null;
    if (precoPromo == null && precoNormal != null && desc != null) precoPromo = Math.round(precoNormal * (1 - desc) * 100) / 100;
    if (desc == null && precoNormal != null && precoPromo != null && precoNormal > 0) desc = Math.round((1 - precoPromo / precoNormal) * 1000) / 1000;
    if (precoPromo == null && desc == null) { semPreco++; continue; } // linha sem oferta útil

    let loja = idx.loja != null ? String(row[idx.loja] ?? "").trim() : lojaArq;
    if (loja) {
      const ln = norm(loja);
      if ((CFG.nome_todas_as_lojas || []).some((w) => ln.includes(norm(w)))) loja = "__todas__";
      else if (/farma\s*e\s*farma|farmaefarma/.test(ln)) loja = "Farma e Farma";
      else if (/minas/.test(ln)) loja = "Minas Farma";
    }
    if (!loja) { loja = "__todas__"; semLoja++; }

    linhas.push({
      descricao: descricao || ean,
      ean,
      codigo: idx.codigo != null ? String(row[idx.codigo] ?? "").trim() || null : null,
      categoria: idx.categoria != null ? String(row[idx.categoria] ?? "").trim() || null : null,
      marca: idx.marca != null ? String(row[idx.marca] ?? "").trim() || null : null,
      preco_normal: precoNormal,
      preco_promo: precoPromo,
      desconto_pct: desc,
      data_inicio: idx.inicio != null ? parseData(row[idx.inicio], anoArq) : null,
      data_fim: idx.fim != null ? parseData(row[idx.fim], anoArq) : null,
      campanha: idx.campanha != null ? String(row[idx.campanha] ?? "").trim() || null : null,
      loja,
    });
  }

  return {
    header: { aba: alvo.aba, linha: cab.linha, colunas: Object.keys(idx) },
    linhas,
    resumo: {
      total: linhas.length,
      sem_preco_ignoradas: semPreco,
      sem_loja_assumido_todas: semLoja,
      lojas: [...new Set(linhas.map((l) => l.loja))],
      com_prazo: linhas.filter((l) => l.data_inicio || l.data_fim).length,
    },
  };
}

module.exports = { parsePromocoes, ehArquivoPromocao, parsePreco, parsePct, parseData };
