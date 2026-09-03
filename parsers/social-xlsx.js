// Métricas de redes sociais por PLANILHA — alternativa ao print lido por IA.
// xlsx ou csv na inbox. Dois tipos, detectados pelas colunas presentes:
//   - "conta":        visualizações / alcance / interações / visitas ao perfil / cliques no link / seguidores
//   - "trafego_pago": investimento / impressões / cliques / ctr / cpc / cpm / resultados / custo por resultado
// Layout: uma linha por MÊS (formato largo) — ou, para "conta", Métrica | Valor | Variação (formato longo).
//
// Config: config/social.json. Saída: { tipo, linhas, header, resumo }.
// Determinístico. Nada é estimado — coluna ausente = campo ausente.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { numBR } = require("./social-vision");

const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "social.json"), "utf8")); }
  catch { return { colunas: {}, arquivo_contem: ["social", "instagram", "metrica", "trafego"] }; }
})();

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

const CONTA_METRICAS = ["visualizacoes", "alcance", "interacoes", "visitas_perfil", "cliques_link", "seguidores"];
const CONTA_ROTULO = {
  visualizacoes: "Visualizações", alcance: "Alcance", interacoes: "Interações",
  visitas_perfil: "Visitas ao perfil", cliques_link: "Cliques no link", seguidores: "Seguidores",
};
const TP_NUM = ["investimento", "impressoes", "alcance", "cliques", "ctr_pct", "cpc", "cpm", "resultados", "custo_por_resultado"];
const MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function ehArquivoSocial(base) {
  const b = norm(base);
  return (CFG.arquivo_contem || []).some((w) => b.includes(norm(w)));
}

// -> "AAAA-MM" (ou null)
function parseYm(v, anoArq) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 7);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d) ? null : d.toISOString().slice(0, 7);
  }
  let s = norm(v);
  let m = s.match(/^(\d{4})[-/. ](\d{1,2})/);                 // 2026-09 / 2026/9
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{4})$/);                     // 09/2026
  if (m) return `${m[2]}-${String(+m[1]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);       // 01/09/2026 -> mês/ano
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${String(+m[2]).padStart(2, "0")}`; }
  m = s.match(new RegExp(`\\b(${MESES_PT.join("|")})[a-zç]*\\.?[-/. ]?(\\d{4})?`)); // "set", "setembro 2026"
  if (m) {
    const mi = MESES_PT.indexOf(m[1].slice(0, 3)) + 1;
    const ano = m[2] ? +m[2] : (anoArq || new Date().getFullYear());
    if (mi) return `${ano}-${String(mi).padStart(2, "0")}`;
  }
  if (/^\d{4}$/.test(s)) return null; // só ano, sem mês
  return null;
}

function pctBR(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? (Math.abs(v) < 1 ? v * 100 : v) : null;
  const s = String(v).trim();
  const neg = /^[-−–]/.test(s) || /queda|baix|red/i.test(s);
  const n = numBR(s.replace(/[+−–%]/g, "").replace(/[^\d.,-]/g, ""));
  if (n == null) return null;
  return neg && n > 0 ? -n : n;
}

function resolverColunas(headerRow) {
  const cells = headerRow.map((c) => norm(c));
  const idx = {};
  for (const [canon, nomes] of Object.entries(CFG.colunas || {})) {
    for (const nome of nomes) {
      const alvo = norm(nome);
      let j = cells.indexOf(alvo);
      if (j < 0) j = cells.findIndex((c) => c && (c === alvo || c.replace(/[:.()%]/g, "").trim() === alvo));
      if (j < 0) j = cells.findIndex((c) => c && (c.startsWith(alvo + " ") || c.endsWith(" " + alvo)));
      if (j >= 0) { idx[canon] = j; break; }
    }
  }
  return idx;
}

function acharCabecalho(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const idx = resolverColunas((rows[r] || []).map((c) => String(c ?? "")));
    const temTP = TP_NUM.some((k) => idx[k] != null && ["investimento", "impressoes", "cliques", "cpc", "cpm", "resultados"].includes(k));
    const temConta = CONTA_METRICAS.some((k) => idx[k] != null);
    const temLongo = idx.metrica != null && idx.valor != null;
    if (temTP) return { linha: r, idx, tipo: "trafego_pago" };
    if (temConta || temLongo) return { linha: r, idx, tipo: "conta", longo: temLongo && !temConta };
  }
  return null;
}

function resolverLoja(txt) {
  const b = norm(txt);
  if (/farma e farma|farmaefarma|\bff\b/.test(b)) return "Farma e Farma";
  if (/minas farma|minasfarma|\bmf\b|\bminas\b/.test(b)) return "Minas Farma";
  return null;
}

function chaveMetrica(rotulo) {
  const b = norm(rotulo);
  for (const [canon, nomes] of Object.entries(CFG.colunas || {})) {
    if (!CONTA_METRICAS.includes(canon)) continue;
    if (nomes.some((n) => b === norm(n) || b.includes(norm(n)))) return canon;
  }
  return null;
}

function parseSocialXlsx(filePath) {
  const base = path.basename(filePath);
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
    throw new Error(`nenhuma aba de métricas de rede social reconhecida em "${base}". ` +
      "Precisa de uma coluna de mês/período e ou (visualizações/alcance/interações/…) ou (investimento/impressões/cpc/…). Ajuste config/social.json.");
  }

  const { rows, cab } = alvo;
  const idx = cab.idx;
  const anoArq = +(base.match(/(20\d{2})/) || [])[1] || new Date().getFullYear();
  const lojaArq = resolverLoja(base);
  const ymArq = parseYm(base.replace(/20\d{2}/, ""), anoArq) || null; // p/ formato longo sem coluna de período

  const dataRows = rows.slice(cab.linha + 1).filter((row) => row && !row.every((c) => c == null || String(c).trim() === ""));
  const semLoja = new Set();
  const num = (row, k) => (idx[k] != null ? numBR(row[idx[k]]) : null);
  const txt = (row, k) => (idx[k] != null && row[idx[k]] != null && String(row[idx[k]]).trim() !== "" ? String(row[idx[k]]).trim() : null);
  const lojaDe = (row) => resolverLoja(txt(row, "loja") || "") || lojaArq;
  const ymDe = (row) => (idx.periodo != null ? parseYm(row[idx.periodo], anoArq) : null) || ymArq;

  const linhas = [];

  if (cab.tipo === "trafego_pago") {
    for (const row of dataRows) {
      const loja = lojaDe(row);
      const ym = ymDe(row);
      if (!loja) { semLoja.add(1); continue; }
      if (!ym) continue;
      const rec = { ym, loja, campanha: txt(row, "campanha"), plataforma: txt(row, "plataforma"), tipo_resultado: txt(row, "tipo_resultado") };
      let temAlgo = false;
      for (const k of TP_NUM) { const v = num(row, k); rec[k] = v; if (v != null) temAlgo = true; }
      // deriva o que falta
      if (rec.cpc == null && rec.investimento != null && rec.cliques) rec.cpc = Math.round((rec.investimento / rec.cliques) * 100) / 100;
      if (rec.cpm == null && rec.investimento != null && rec.impressoes) rec.cpm = Math.round((rec.investimento / rec.impressoes) * 1000 * 100) / 100;
      if (rec.ctr_pct == null && rec.cliques != null && rec.impressoes) rec.ctr_pct = Math.round((rec.cliques / rec.impressoes) * 10000) / 100;
      if (rec.custo_por_resultado == null && rec.investimento != null && rec.resultados) rec.custo_por_resultado = Math.round((rec.investimento / rec.resultados) * 100) / 100;
      if (temAlgo) linhas.push(rec);
    }
  } else if (cab.longo) {
    // Métrica | Valor | Variação  -> agrupa tudo num mês só (da coluna período, ou do nome do arquivo)
    const porLojaYm = new Map();
    for (const row of dataRows) {
      const chave = chaveMetrica(txt(row, "metrica") || "");
      if (!chave) continue;
      const loja = lojaDe(row);
      const ym = ymDe(row);
      if (!loja || !ym) { if (!loja) semLoja.add(1); continue; }
      const k = loja + "|" + ym;
      if (!porLojaYm.has(k)) porLojaYm.set(k, { ym, loja, metricas: {} });
      const bruto = row[idx.valor];
      porLojaYm.get(k).metricas[chave] = {
        valor: numBR(bruto), valor_texto: bruto == null ? null : String(bruto).trim(),
        delta_pct: idx.variacao != null ? pctBR(row[idx.variacao]) : null,
      };
    }
    linhas.push(...porLojaYm.values());
  } else {
    // formato largo: uma linha por mês, colunas = métricas
    for (const row of dataRows) {
      const loja = lojaDe(row);
      const ym = ymDe(row);
      if (!loja) { semLoja.add(1); continue; }
      if (!ym) continue;
      const metricas = {};
      for (const mk of CONTA_METRICAS) {
        if (idx[mk] == null) continue;
        const bruto = row[idx[mk]];
        if (bruto == null || String(bruto).trim() === "") continue;
        metricas[mk] = {
          valor: numBR(bruto), valor_texto: String(bruto).trim(),
          delta_pct: idx[mk + "_var"] != null ? pctBR(row[idx[mk + "_var"]]) : null,
        };
      }
      if (Object.keys(metricas).length) linhas.push({ ym, loja, metricas });
    }
  }

  if (!linhas.length) {
    throw new Error(`"${base}" foi lido como ${cab.tipo === "trafego_pago" ? "tráfego pago" : "resumo da conta"}, ` +
      "mas nenhuma linha tinha loja + mês + pelo menos um número. Inclua uma coluna 'Loja' (ou o nome da loja no arquivo) e uma coluna de mês.");
  }

  return {
    tipo: cab.tipo,
    header: { aba: alvo.aba, linha: cab.linha, colunas: Object.keys(idx), formato: cab.longo ? "longo" : "largo" },
    linhas,
    resumo: {
      tipo: cab.tipo,
      meses: [...new Set(linhas.map((l) => l.ym))].sort(),
      lojas: [...new Set(linhas.map((l) => l.loja))],
      linhas_sem_loja_ignoradas: semLoja.size ? dataRows.length - linhas.length : 0,
    },
    _rotulos: CONTA_ROTULO,
  };
}

module.exports = { parseSocialXlsx, ehArquivoSocial, CONTA_ROTULO };
