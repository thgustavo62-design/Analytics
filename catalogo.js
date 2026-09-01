// Fase 1 — Data Foundation.
//  A) sincronizarProdutosDeVendas: popula/atualiza a tabela `produtos` a partir dos
//     `barras` (EAN) das vendas de um período. EAN é a espinha dorsal; sem EAN, a chave
//     é a descrição normalizada.
//  B) ingestPlanilhaProduto: lê planilhas de ESTOQUE / CUSTO / PREÇO jogadas na inbox/,
//     com mapeamento de coluna configurável (config/catalogo.json). Resolve o produto por
//     EAN; sem EAN, tenta casar por nome (match.js) e marca a confiança.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { normalize } = require("./match");
const { classificar } = require("./classify");
const db = require("./db");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "catalogo.json"), "utf8"));
const LOJAS = require("./db").LOJAS_VALIDAS;

const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");
// aceita 8–14 dígitos, não tudo-zero (os "barras" das vendas têm 10–14)
function normalizarEan(v) {
  const d = soDigitos(v);
  if (d.length < 8 || d.length > 14 || /^0+$/.test(d)) return null;
  return d;
}
const iso = (d) => {
  if (d == null || d === "") return null;
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  const s = String(d).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[R$\s.](?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ---------- A) produtos a partir das vendas ----------

function sincronizarProdutosDeVendas(periodoId) {
  const linhas = db.db
    .prepare("SELECT barras, descricao, MIN(data) primeira, MAX(data) ultima FROM vendas_transacoes WHERE periodo_id = ? GROUP BY barras, descricao")
    .all(periodoId);
  // agrupa por EAN (ou por descrição normalizada quando não há EAN), pegando a descrição mais longa
  const porChave = new Map();
  for (const l of linhas) {
    const ean = normalizarEan(l.barras);
    const norm = normalize(l.descricao);
    const chave = ean || "norm:" + norm;
    const cur = porChave.get(chave) || { ean, descricao: "", norm, primeira: l.primeira, ultima: l.ultima };
    if ((l.descricao || "").length > cur.descricao.length) cur.descricao = l.descricao;
    if (l.primeira < cur.primeira) cur.primeira = l.primeira;
    if (l.ultima > cur.ultima) cur.ultima = l.ultima;
    porChave.set(chave, cur);
  }
  let criados = 0;
  let atualizados = 0;
  db.db.exec("BEGIN");
  try {
    for (const p of porChave.values()) {
      if (!p.descricao) continue;
      const r = db.upsertProduto({
        ean: p.ean,
        descricao: p.descricao,
        descricao_normalizada: p.ean ? normalize(p.descricao) : p.norm,
        categoria: classificar(p.descricao),
        fonte: "vendas",
        primeira_venda: p.primeira,
        ultima_venda: p.ultima,
      });
      if (r.criado) criados++;
      else atualizados++;
    }
    db.db.exec("COMMIT");
  } catch (e) {
    db.db.exec("ROLLBACK");
    throw e;
  }
  return { produtosVistos: porChave.size, criados, atualizados };
}

// ---------- B) planilhas de estoque / custo / preço ----------

function detectarTipoPlanilha(base) {
  for (const tipo of ["estoque", "custo", "preco"]) {
    if ((CFG[tipo].arquivo_contem || []).some((w) => base.includes(w))) return tipo;
  }
  return null;
}

function lojaDoNome(base) {
  for (const [loja, marcas] of Object.entries(CFG.loja_no_nome || {})) {
    if (marcas.some((m) => base.includes(m))) return loja;
  }
  return null;
}

// resolve para uma LISTA de lojas: nome "geral"/"rede"/... => todas; senão a que casar.
function lojasDoNome(base) {
  if ((CFG.nome_todas_as_lojas || []).some((m) => base.includes(m))) return LOJAS.slice();
  const one = lojaDoNome(base);
  return one ? [one] : null;
}

const normHead = (s) => normalize(s).replace(/\s+/g, " ").trim();
function resolverColunas(header, mapa) {
  const hn = header.map(normHead);
  const idx = {};
  for (const [campo, nomes] of Object.entries(mapa)) {
    let i = -1;
    for (const nome of nomes) {
      const alvo = normHead(nome);
      i = hn.findIndex((h) => h === alvo);
      if (i < 0) i = hn.findIndex((h) => h.includes(alvo));
      if (i >= 0) break;
    }
    if (i >= 0) idx[campo] = i;
  }
  return idx;
}

// encontra a linha do cabeçalho (1ª com >= 2 colunas mapeadas, incluindo ean OU descricao)
function acharCabecalho(rows, mapa) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const idx = resolverColunas((rows[r] || []).map((c) => String(c ?? "")), mapa);
    const n = Object.keys(idx).length;
    if (n >= 2 && (idx.ean != null || idx.descricao != null)) return { linha: r, idx };
  }
  return null;
}

function resolverProduto(ean, descricao) {
  if (ean) {
    const p = db.getProdutoPorEan(ean);
    if (p) return { produtoId: p.id, confianca: 1, via: "ean" };
    // cria produto novo a partir da planilha
    const r = db.upsertProduto({ ean, descricao: descricao || ean, descricao_normalizada: normalize(descricao || ean), categoria: descricao ? classificar(descricao) : null, fonte: "catalogo" });
    return { produtoId: r.id, confianca: 1, via: "ean-novo" };
  }
  if (descricao) {
    const p = db.getProdutoPorNorm(normalize(descricao));
    if (p) return { produtoId: p.id, confianca: 0.6, via: "descricao" };
  }
  return null;
}

function ingestPlanilhaProduto(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const tipo = detectarTipoPlanilha(base);
  if (!tipo) throw new Error("xlsx de catálogo não reconhecido (nome deve conter estoque/custo/preco).");
  const cfg = CFG[tipo];
  const wb = XLSX.readFile(filePath, { cellDates: true });

  let alvo = null;
  for (const nome of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: null });
    const cab = acharCabecalho(rows, cfg.colunas);
    if (cab) { alvo = { rows, cab, aba: nome }; break; }
  }
  if (!alvo) throw new Error(`nenhuma aba com cabeçalho reconhecível para "${tipo}". Ajuste config/catalogo.json.`);

  const { rows, cab } = alvo;
  const idx = cab.idx;
  const hojeIso = new Date().toISOString().slice(0, 10);
  const dataArq = (base.match(/(\d{4})-(\d{2})-(\d{2})/) || []).slice(1).join("-") || hojeIso;

  const lojasAplicar = idx.loja != null ? null : lojasDoNome(base);
  if (idx.loja == null && (!lojasAplicar || !lojasAplicar.length)) {
    throw new Error(
      `não deu para saber a loja de "${base}". Ponha 'minas' ou 'farma e farma' no nome do arquivo ` +
      `(ou 'geral'/'rede' para as duas), ou inclua uma coluna 'loja'.`
    );
  }
  const multiLoja = lojasAplicar && lojasAplicar.length > 1;

  let aplicadas = 0;
  let semProduto = 0;
  let baixaConfianca = 0;
  const extra = { estoque: 0, preco: 0, preco_promocional: 0, custo: 0 }; // sub-tipos vindos do MESMO arquivo
  const lojasIds = {};
  for (const l of LOJAS) lojasIds[l] = db.lojaId(l);

  // aplica UMA linha (já resolvida a produtoId) a UMA loja
  function aplicarLinha(lid, produtoId, row) {
    if (tipo === "estoque") {
      const q = num(row[idx.quantidade]);
      const di = (idx.data_referencia != null ? iso(row[idx.data_referencia]) : null) || dataArq;
      if (q != null || idx.disponivel != null) {
        db.inserirEstoque(lid, produtoId, {
          quantidade: q,
          reservado: idx.reservado != null ? num(row[idx.reservado]) : null,
          disponivel: idx.disponivel != null ? num(row[idx.disponivel]) : null,
          data_referencia: di,
          fonte: base,
        });
        aplicadas++;
        extra.estoque++;
      }
      // o export de estoque da rede já carrega preço e custo — aproveita do MESMO arquivo
      if (idx.preco != null) {
        const pv = num(row[idx.preco]);
        if (pv != null && pv > 0) { db.inserirPreco(lid, produtoId, pv, di, "normal", base); extra.preco++; }
      }
      if (idx.preco_promocional != null) {
        const pp = num(row[idx.preco_promocional]);
        if (pp != null && pp > 0) { db.inserirPreco(lid, produtoId, pp, di, "promocional", base); extra.preco_promocional++; }
      }
      if (idx.custo != null && idx.custo !== idx.preco && idx.custo !== idx.preco_promocional) {
        const c = num(row[idx.custo]);
        if (c != null && c > 0) { db.inserirCusto(lid, produtoId, c, di, base); extra.custo++; }
      }
    } else if (tipo === "custo") {
      const c = num(row[idx.custo]);
      if (c == null || c <= 0) return;
      db.inserirCusto(lid, produtoId, c, (idx.data_inicio != null ? iso(row[idx.data_inicio]) : null) || dataArq, base);
      aplicadas++;
    } else if (tipo === "preco") {
      const pNormal = num(row[idx.preco]);
      const di = (idx.data_inicio != null ? iso(row[idx.data_inicio]) : null) || dataArq;
      if (pNormal != null && pNormal > 0) { db.inserirPreco(lid, produtoId, pNormal, di, "normal", base); aplicadas++; }
      if (idx.preco_promocional != null) {
        const pp = num(row[idx.preco_promocional]);
        if (pp != null && pp > 0) { db.inserirPreco(lid, produtoId, pp, di, "promocional", base); aplicadas++; }
      }
    }
  }

  // uma transação só — a planilha da rede tem ~15k linhas e cada uma pode gerar 4 escritas
  // historizadas (estoque + preço + promo + custo). Sem isto, são dezenas de milhares de commits.
  db.db.exec("BEGIN");
  try {
    for (let r = cab.linha + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const ean = normalizarEan(idx.ean != null ? row[idx.ean] : null);
      const descricao = idx.descricao != null ? String(row[idx.descricao] ?? "").trim() : "";
      if (!ean && !descricao) continue;

      const resolvido = resolverProduto(ean, descricao);
      if (!resolvido) { semProduto++; continue; }
      if (resolvido.confianca < 1) baixaConfianca++;

      const alvos = idx.loja != null
        ? [lojasIds[String(row[idx.loja] ?? "").trim()] || lojasIds[lojaDoNome(String(row[idx.loja] ?? "").toLowerCase()) || ""]]
        : lojasAplicar.map((l) => lojasIds[l]);
      for (const lid of alvos) {
        if (!lid) continue;
        aplicarLinha(lid, resolvido.produtoId, row);
      }
    }
    db.db.exec("COMMIT");
  } catch (e) {
    db.db.exec("ROLLBACK");
    throw e;
  }

  return {
    tipo: "catalogo-" + tipo,
    aba: alvo.aba,
    lojas: idx.loja != null ? ["(coluna 'loja')"] : lojasAplicar,
    linhas_aplicadas: aplicadas,
    sem_produto: semProduto,
    casados_por_nome: baixaConfianca,
    feeds_do_arquivo: tipo === "estoque" ? extra : undefined,
  };
}

module.exports = { sincronizarProdutosDeVendas, ingestPlanilhaProduto, detectarTipoPlanilha, normalizarEan };
