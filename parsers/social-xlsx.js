// Métricas de redes sociais por PLANILHA — alternativa ao print lido por IA.
// xlsx ou csv na inbox. Lê TODAS as abas e separa em dois blocos pelas colunas presentes:
//   - conta:        visualizações / alcance / interações / visitas ao perfil / cliques no link / seguidores
//   - trafego_pago: investimento / impressões / cliques / ctr / cpc / cpm / resultados / custo por resultado
// Uma linha por MÊS (formato largo) — ou, para conta, Métrica | Valor | Variação (formato longo).
// Abas "puras" (só um dos dois tipos) vencem uma aba combinada tipo "Resumo Mensal".
//
// Config: config/social.json. Saída: { conta:[], trafego:[], header, resumo }.
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
// tira acentos/pontuação/unidades do fim ("CPM (R$)" -> "cpm", "Alcance (soma)" -> "alcance")
const limpaHead = (s) => norm(s)
  .replace(/[:.()%$]/g, " ")
  .replace(/\b(r\$|brl|informado|reportad[oa]|soma|total|todos|todas)\b/g, " ")
  .replace(/\s+/g, " ").trim();

const CONTA_METRICAS = ["visualizacoes", "alcance", "interacoes", "visitas_perfil", "cliques_link", "seguidores"];
const CONTA_ROTULO = {
  visualizacoes: "Visualizações", alcance: "Alcance", interacoes: "Interações",
  visitas_perfil: "Visitas ao perfil", cliques_link: "Cliques no link", seguidores: "Seguidores",
};
const TP_NUM = ["investimento", "impressoes", "alcance", "cliques", "ctr_pct", "cpc", "cpm", "resultados", "custo_por_resultado"];
const GASTO_COLS = ["investimento", "cpc", "cpm", "custo_por_resultado"];
const MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function ehArquivoSocial(base) {
  const b = norm(base).replace(/[_-]+/g, " ");
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
  const cells = headerRow.map(limpaHead);
  const idx = {};
  const usadas = new Set();
  const canons = Object.entries(CFG.colunas || {});
  // passe 1: casamento EXATO (após limpar unidades) — o mais específico crava a coluna
  for (const [canon, nomes] of canons) {
    for (const nome of nomes) {
      const alvo = limpaHead(nome);
      const j = cells.findIndex((c, i) => c === alvo && !usadas.has(i));
      if (j >= 0) { idx[canon] = j; usadas.add(j); break; }
    }
  }
  // passe 2: fuzzy (prefixo/sufixo de palavra) só em coluna livre e só p/ sinônimo >= 4 letras
  for (const [canon, nomes] of canons) {
    if (idx[canon] != null) continue;
    for (const nome of nomes) {
      const alvo = limpaHead(nome);
      if (alvo.length < 4) continue;
      const j = cells.findIndex((c, i) => c && !usadas.has(i) && (c === alvo || c.startsWith(alvo + " ") || c.endsWith(" " + alvo)));
      if (j >= 0) { idx[canon] = j; usadas.add(j); break; }
    }
  }
  return idx;
}

// acha a linha do cabeçalho de UMA aba e diz o que ela tem
function analisarAba(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const idx = resolverColunas((rows[r] || []).map((c) => String(c ?? "")));
    const nConta = CONTA_METRICAS.filter((k) => idx[k] != null).length;
    const temLongo = idx.metrica != null && idx.valor != null;
    const temGasto = GASTO_COLS.some((k) => idx[k] != null);
    const temImpr = idx.impressoes != null;
    const daConta = nConta >= 2 || (temLongo && nConta === 0);
    const daTrafego = temGasto || (temImpr && nConta === 0);
    if (daConta || daTrafego) {
      return { linha: r, idx, nConta, longo: temLongo && nConta === 0, daConta, daTrafego, puraConta: daConta && !temGasto && !temImpr, puroTrafego: daTrafego && (idx.campanha != null || nConta === 0) };
    }
  }
  return null;
}

function resolverLoja(txt) {
  const b = norm(txt).replace(/[_-]+/g, " ");
  if (/farma e farma|farmaefarma|farmaefarmabg|\bff\b/.test(b)) return "Farma e Farma";
  if (/minas farma|minasfarma|\bmf\b|\bminas\b/.test(b)) return "Minas Farma";
  return null;
}

const APELIDO_METRICA = {
  visualizacoes: "visualizacoes", visualizacao: "visualizacoes", views: "visualizacoes",
  alcance: "alcance", reach: "alcance",
  interacoes: "interacoes", interacao: "interacoes", engajamento: "interacoes",
  visitas: "visitas_perfil", "visitas ao perfil": "visitas_perfil",
  cliques: "cliques_link", "cliques no link": "cliques_link",
  seguidores: "seguidores", "novos seguidores": "seguidores",
};
function chaveMetrica(rotulo) {
  const b = limpaHead(rotulo).replace(/\s+com o conteudo|\s+no link|\s+ao perfil|\s+novos|\s+no periodo/g, "").trim();
  if (APELIDO_METRICA[b]) return APELIDO_METRICA[b];
  for (const canon of CONTA_METRICAS) {
    for (const n of (CFG.colunas || {})[canon] || []) {
      const a = limpaHead(n);
      if (b === a || b.startsWith(a + " ") || b.endsWith(" " + a)) return canon;
    }
  }
  return null;
}

function parseSocialXlsx(filePath) {
  const base = path.basename(filePath);
  const wb = /\.csv$/i.test(filePath)
    ? XLSX.read(fs.readFileSync(filePath, "utf8"), { type: "string", raw: true })
    : XLSX.readFile(filePath, { cellDates: false, raw: true });

  const anoArq = +(base.match(/(20\d{2})/) || [])[1] || new Date().getFullYear();
  const lojaArq = resolverLoja(base);

  const IGNORAR_ABA = /leia[- ]?me|readme|instru|como usar|ajuda|help|dicion/i;
  const abas = [];
  for (const nome of wb.SheetNames) {
    if (IGNORAR_ABA.test(nome)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: null, raw: true });
    const a = analisarAba(rows);
    if (a) abas.push({ nome, rows, ...a, lojaAba: resolverLoja([nome, ...(rows.slice(0, 3).flat())].join(" ")) });
  }
  if (!abas.length) {
    throw new Error(`nenhuma aba de métricas de rede social reconhecida em "${base}". ` +
      "Precisa de coluna de mês/período e ou (visualizações/alcance/interações/…) ou (investimento/impressões/cpc/…). Ajuste config/social.json.");
  }

  const semLoja = new Set();
  const abasComContaPura = abas.filter((a) => a.puraConta);
  const abasComTrafegoPuro = abas.filter((a) => a.puroTrafego);
  const abasParaConta = (abasComContaPura.length ? abasComContaPura : abas.filter((a) => a.daConta));
  const abasParaTrafego = (abasComTrafegoPuro.length ? abasComTrafegoPuro : abas.filter((a) => a.daTrafego));

  const contaPorChave = new Map(); // loja|ym -> {ym, loja, metricas}
  const trafego = [];

  const linhasDados = (a) => a.rows.slice(a.linha + 1).filter((row) => row && !row.every((c) => c == null || String(c).trim() === ""));
  const cel = (row, idx, k) => (idx[k] != null ? row[idx[k]] : null);
  const txt = (row, idx, k) => { const v = cel(row, idx, k); return v != null && String(v).trim() !== "" ? String(v).trim() : null; };

  // ---- conta ----
  for (const a of abasParaConta) {
    const { idx } = a;
    const lojaFallback = a.lojaAba || lojaArq;
    for (const row of linhasDados(a)) {
      const primeira = String(row[0] ?? "").toLowerCase();
      if (/^total\b|^m[eé]dia\b|^como usar|^notas?\b/.test(primeira)) continue;
      const loja = resolverLoja(txt(row, idx, "loja") || "") || lojaFallback;
      const ym = parseYm(cel(row, idx, "periodo"), anoArq);
      if (!loja) { semLoja.add(1); continue; }
      if (!ym) continue;

      const chave = loja + "|" + ym;
      if (!contaPorChave.has(chave)) contaPorChave.set(chave, { ym, loja, metricas: {} });
      const alvoM = contaPorChave.get(chave).metricas;

      if (a.longo) {
        const ck = chaveMetrica(txt(row, idx, "metrica") || "");
        if (!ck) continue;
        const bruto = cel(row, idx, "valor");
        if (bruto == null || String(bruto).trim() === "") continue;
        alvoM[ck] = { valor: numBR(bruto), valor_texto: String(bruto).trim(), delta_pct: idx.variacao != null ? pctBR(cel(row, idx, "variacao")) : null };
      } else {
        // variação pode vir numa coluna livre de texto: "Visualizações +20,1% | Alcance -51% | ..."
        const varTexto = txt(row, idx, "variacao_texto");
        const deltaTexto = {};
        if (varTexto) for (const parte of varTexto.split(/[|;\n]+/)) {
          const m = parte.match(/^(.*?)([+\-−–]?\s*\d[\d.,]*\s*%)\s*$/);
          if (!m) continue;
          const ck = chaveMetrica(m[1]);
          if (ck) deltaTexto[ck] = pctBR(m[2]);
        }
        for (const mk of CONTA_METRICAS) {
          if (idx[mk] == null) continue;
          const bruto = row[idx[mk]];
          if (bruto == null || String(bruto).trim() === "") continue;
          const val = numBR(bruto);
          if (val === 0 && ym > new Date().toISOString().slice(0, 7)) continue; // meses futuros zerados na planilha
          const dCol = idx[mk + "_var"] != null ? pctBR(row[idx[mk + "_var"]]) : null;
          alvoM[mk] = { valor: val, valor_texto: String(bruto).trim(), delta_pct: dCol != null ? dCol : (deltaTexto[mk] ?? null) };
        }
      }
    }
  }
  const conta = [...contaPorChave.values()].filter((c) => Object.keys(c.metricas).length);

  // ---- tráfego pago ----
  for (const a of abasParaTrafego) {
    const { idx } = a;
    const lojaFallback = a.lojaAba || lojaArq;
    for (const row of linhasDados(a)) {
      const primeira = String(row[0] ?? "").toLowerCase();
      const camp = txt(row, idx, "campanha");
      if (/^total\b|^m[eé]dia\b|^notas?\b|^como usar/.test(primeira) || /^total\b/.test((camp || "").toLowerCase())) continue;
      const loja = resolverLoja(txt(row, idx, "loja") || "") || lojaFallback;
      const ym = parseYm(cel(row, idx, "periodo"), anoArq);
      if (!loja) { semLoja.add(1); continue; }
      if (!ym) continue;

      const rec = { ym, loja, campanha: camp, plataforma: txt(row, idx, "plataforma") };
      let temAlgo = false;
      for (const k of TP_NUM) { if (k === "resultados") continue; const v = numBR(cel(row, idx, k)); rec[k] = v; if (v != null && v !== 0) temAlgo = true; }
      // "Resultados" da Meta em campanha de alcance = pessoas alcançadas (não é conversão) — não some.
      // Prioridade real: Compras > Contatos > Resultados (só se o indicador for de conversão).
      const indicador = txt(row, idx, "tipo_resultado") || "";
      const ehAlcance = /alcance|reach|impress[õoã]/i.test(indicador);
      const compras = numBR(cel(row, idx, "compras"));
      const contatos = numBR(cel(row, idx, "contatos"));
      const resBrutos = numBR(cel(row, idx, "resultados"));
      rec.resultados = compras || contatos || (ehAlcance ? null : resBrutos) || null;
      rec.tipo_resultado = compras ? "compras" : contatos ? "contatos" : (ehAlcance ? null : (indicador || null));
      if (rec.resultados != null && rec.resultados !== 0) temAlgo = true;
      if (rec.cpc == null && rec.investimento != null && rec.cliques) rec.cpc = Math.round((rec.investimento / rec.cliques) * 100) / 100;
      if (rec.cpm == null && rec.investimento != null && rec.impressoes) rec.cpm = Math.round((rec.investimento / rec.impressoes) * 1000 * 100) / 100;
      if (rec.ctr_pct == null && rec.cliques != null && rec.impressoes) rec.ctr_pct = Math.round((rec.cliques / rec.impressoes) * 10000) / 100;
      if (rec.custo_por_resultado == null && rec.investimento != null && rec.resultados) rec.custo_por_resultado = Math.round((rec.investimento / rec.resultados) * 100) / 100;
      if (temAlgo || (rec.investimento != null && rec.investimento > 0)) trafego.push(rec);
    }
  }

  if (!conta.length && !trafego.length) {
    throw new Error(`"${base}" foi reconhecido como planilha de rede social, mas nenhuma linha tinha loja + mês + número. ` +
      "Inclua uma coluna 'Loja' (ou o nome da loja no arquivo/aba) e uma coluna de mês.");
  }

  const meses = [...new Set([...conta.map((c) => c.ym), ...trafego.map((t) => t.ym)])].sort();
  const lojas = [...new Set([...conta.map((c) => c.loja), ...trafego.map((t) => t.loja)])];
  return {
    conta, trafego,
    header: { abas: abas.map((a) => a.nome), abas_conta: abasParaConta.map((a) => a.nome), abas_trafego: abasParaTrafego.map((a) => a.nome) },
    resumo: { meses, lojas, n_conta: conta.length, n_trafego: trafego.length, linhas_sem_loja_ignoradas: semLoja.size },
    _rotulos: CONTA_ROTULO,
  };
}

module.exports = { parseSocialXlsx, ehArquivoSocial, CONTA_ROTULO };
