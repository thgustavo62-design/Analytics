// Camada de acesso ao SQLite (node:sqlite, nativo do Node 22+/24 — sem build nativo).
// Regra dura: nenhuma função aqui soma as duas lojas juntas. Tudo passa por periodo_id.

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.VA_DB_PATH || path.join(DATA_DIR, "analytics.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

const LOJAS_VALIDAS = ["Minas Farma", "Farma e Farma"];

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

// migrações leves: colunas adicionadas depois do primeiro deploy. ALTER falha se a coluna
// já existe — engolimos esse erro específico.
for (const stmt of [
  "ALTER TABLE periodos ADD COLUMN vendas_ultimo_dia_motivo TEXT",
  "ALTER TABLE vendas_transacoes ADD COLUMN emp_id TEXT",
  "ALTER TABLE vendas_transacoes ADD COLUMN cli_id TEXT",
  "ALTER TABLE concorrencia_ofertas ADD COLUMN data_coleta TEXT",
  "ALTER TABLE concorrencia_ofertas ADD COLUMN fonte TEXT",
  "ALTER TABLE produtos ADD COLUMN categoria_fonte TEXT",       // vendas | erp | manual (rank de sobrescrita)
  "ALTER TABLE produtos ADD COLUMN classe_comercial TEXT",      // Genérico | Similar | Ético | OTC (medicamentos)
  "ALTER TABLE produtos ADD COLUMN principio_ativo_cod TEXT",   // código do princípio ativo (planilha Minas)
  "ALTER TABLE produtos ADD COLUMN registro_ms TEXT",           // registro ANVISA (presente = medicamento)
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}

for (const nome of LOJAS_VALIDAS) {
  db.prepare("INSERT OR IGNORE INTO lojas (nome) VALUES (?)").run(nome);
}

function nowIso() {
  return new Date().toISOString();
}

function lojaId(nome) {
  const row = db.prepare("SELECT id FROM lojas WHERE nome = ?").get(nome);
  if (!row) throw new Error(`Loja desconhecida: ${nome}. Válidas: ${LOJAS_VALIDAS.join(", ")}`);
  return row.id;
}

function getOrCreatePeriodo(loja, ano, mes) {
  const lid = lojaId(loja);
  const existing = db.prepare("SELECT * FROM periodos WHERE loja_id = ? AND ano = ? AND mes = ?").get(lid, ano, mes);
  if (existing) {
    db.prepare("UPDATE periodos SET atualizado_em = ? WHERE id = ?").run(nowIso(), existing.id);
    return existing.id;
  }
  const ts = nowIso();
  const info = db
    .prepare("INSERT INTO periodos (loja_id, ano, mes, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)")
    .run(lid, ano, mes, ts, ts);
  return Number(info.lastInsertRowid);
}

function touchPeriodo(periodoId) {
  db.prepare("UPDATE periodos SET atualizado_em = ? WHERE id = ?").run(nowIso(), periodoId);
}

// --- vendas -------------------------------------------------------------------

function replaceVendas(periodoId, rows) {
  const del = db.prepare("DELETE FROM vendas_transacoes WHERE periodo_id = ?");
  const ins = db.prepare(
    `INSERT INTO vendas_transacoes
      (periodo_id, data, hora, lancamento, barras, descricao, categoria, preco_unit, quantidade, valor_liquido, forma_pagto, emp_id, cli_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    del.run(periodoId);
    for (const r of rows) {
      ins.run(
        periodoId,
        r.data,
        r.hora ?? null,
        r.lancamento,
        r.barras ?? null,
        r.descricao,
        r.categoria,
        r.preco_unit ?? null,
        r.quantidade,
        r.valor_liquido,
        r.forma_pagto ?? null,
        r.emp_id ?? null,
        r.cli_id ?? null
      );
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
  touchPeriodo(periodoId);
}

function getVendas(periodoId) {
  return db.prepare("SELECT * FROM vendas_transacoes WHERE periodo_id = ? ORDER BY data, hora").all(periodoId);
}

function setVendasMeta(periodoId, meta = {}) {
  db.prepare(
    `UPDATE periodos SET
       vendas_ultimo_dia = ?, vendas_ultimo_dia_parcial = ?, vendas_ultimo_dia_motivo = ?,
       vendas_total_impresso = ?, vendas_fonte_gerada_em = ?, atualizado_em = ?
     WHERE id = ?`
  ).run(
    meta.lastDay ?? null,
    meta.lastDayPartial == null ? null : meta.lastDayPartial ? 1 : 0,
    meta.lastDayMotivo ?? null,
    meta.printedTotal ?? null,
    meta.geradoEm ?? null,
    nowIso(),
    periodoId
  );
}

function getPeriodoById(periodoId) {
  return db.prepare("SELECT * FROM periodos WHERE id = ?").get(periodoId) || null;
}

function getFaturamento(periodoId) {
  const row = db.prepare("SELECT COALESCE(SUM(valor_liquido), 0) AS t FROM vendas_transacoes WHERE periodo_id = ?").get(periodoId);
  return Math.round((row.t + Number.EPSILON) * 100) / 100;
}

function getDiasComVenda(periodoId) {
  return db.prepare("SELECT COUNT(DISTINCT data) AS n FROM vendas_transacoes WHERE periodo_id = ?").get(periodoId).n;
}

// --- instagram --------------------------------------------------------------

function replaceInstagram(periodoId, metricas) {
  db.prepare("DELETE FROM instagram_metricas WHERE periodo_id = ?").run(periodoId);
  const ins = db.prepare(
    `INSERT INTO instagram_metricas (periodo_id, metrica, rotulo, valor_exibicao, delta_pct, observacao, ordem)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  metricas.forEach((m, i) => {
    ins.run(periodoId, m.metrica, m.rotulo, m.valor_exibicao, m.delta_pct ?? null, m.observacao ?? null, i);
  });
  touchPeriodo(periodoId);
}

function getInstagram(periodoId) {
  return db.prepare("SELECT * FROM instagram_metricas WHERE periodo_id = ? ORDER BY ordem").all(periodoId);
}

// mescla: mantém as métricas já gravadas e sobrepõe só as que vierem preenchidas agora
// (um print costuma trazer o resumo inteiro, mas dois prints parciais também funcionam).
function mergeInstagram(periodoId, metricas) {
  const atuais = getInstagram(periodoId);
  const porChave = new Map(atuais.map((m) => [m.metrica, m]));
  for (const m of metricas) {
    if (m.valor_exibicao == null || String(m.valor_exibicao).trim() === "") continue;
    porChave.set(m.metrica, {
      metrica: m.metrica, rotulo: m.rotulo,
      valor_exibicao: String(m.valor_exibicao).trim(),
      delta_pct: m.delta_pct ?? null,
      observacao: m.observacao ?? (porChave.get(m.metrica) || {}).observacao ?? null,
    });
  }
  replaceInstagram(periodoId, [...porChave.values()]);
}

// --- tráfego pago + auditoria de prints ------------------------------------
const TP_COLS = ["fonte_arquivo", "data_ini", "data_fim", "investimento", "impressoes", "alcance",
  "cliques", "ctr_pct", "cpc", "cpm", "resultados", "tipo_resultado", "custo_por_resultado", "campanha", "plataforma"];

function inserirTrafegoPago(periodoId, dados) {
  const vals = TP_COLS.map((c) => (dados[c] === undefined ? null : dados[c]));
  db.prepare(
    `INSERT INTO trafego_pago (periodo_id, ${TP_COLS.join(", ")}) VALUES (${["?", ...TP_COLS.map(() => "?")].join(", ")})`
  ).run(periodoId, ...vals);
  touchPeriodo(periodoId);
}

function getTrafegoPago(periodoId) {
  return db.prepare("SELECT * FROM trafego_pago WHERE periodo_id = ? ORDER BY COALESCE(data_fim, criado_em)").all(periodoId);
}

// soma do investimento de tráfego pago de um período (loja + AAAA-MM) — alimenta a Medição (Fase C)
function investimentoTrafegoPago(loja, ano, mes) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(tp.investimento), 0) AS total, COUNT(*) AS n
       FROM trafego_pago tp JOIN periodos p ON p.id = tp.periodo_id JOIN lojas l ON l.id = p.loja_id
      WHERE l.nome = ? AND p.ano = ? AND p.mes = ?`
  ).get(loja, ano, mes);
  return { total: row.total || 0, n: row.n || 0 };
}

function registrarSocialPrint(loja, periodoId, tipo, arquivo, extraidoJson, modelo) {
  db.prepare(
    "INSERT INTO social_prints (loja, periodo_id, tipo, arquivo, extraido_json, modelo) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(loja, periodoId ?? null, tipo, arquivo, extraidoJson ?? null, modelo ?? null);
}

function listSocialPrints(loja, limite = 40) {
  return db.prepare(
    "SELECT id, loja, periodo_id, tipo, arquivo, modelo, criado_em FROM social_prints WHERE loja = ? ORDER BY criado_em DESC LIMIT ?"
  ).all(loja, limite);
}

// série mensal de faturamento (para cruzar com métricas sociais) — uma loja só
function faturamentoMensal(loja) {
  return db.prepare(
    `SELECT p.ano, p.mes, printf('%04d-%02d', p.ano, p.mes) AS ym,
            ROUND(SUM(v.valor_liquido), 2) AS faturamento,
            COUNT(DISTINCT v.lancamento) AS vendas
       FROM periodos p JOIN lojas l ON l.id = p.loja_id
       JOIN vendas_transacoes v ON v.periodo_id = p.id
      WHERE l.nome = ?
      GROUP BY p.ano, p.mes ORDER BY p.ano, p.mes`
  ).all(loja);
}

// --- concorrência ----------------------------------------------------------

const _insOferta = () => db.prepare(
  `INSERT INTO concorrencia_ofertas
    (periodo_id, concorrente, categoria, produto, preco_normal, preco_promo, validade,
     nivel_confianca, status_validacao, nosso_preco_medio, abaixo_do_nosso, data_coleta, fonte)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
function _runOferta(ins, periodoId, o, fonte) {
  ins.run(
    periodoId, o.concorrente, o.categoria ?? null, o.produto,
    o.preco_normal ?? null, o.preco_promo ?? null, o.validade ?? null,
    o.nivel_confianca ?? null, o.status_validacao ?? null,
    o.nosso_preco_medio ?? null, o.abaixo_do_nosso == null ? null : o.abaixo_do_nosso ? 1 : 0,
    o.data_coleta ?? new Date().toISOString().slice(0, 10), fonte
  );
}

// substitui o LOTE dessa fonte (default 'coleta') — o que foi adicionado à mão (fonte 'manual')
// não é apagado ao re-importar a planilha.
function replaceConcorrencia(periodoId, ofertas, fonte = "coleta") {
  db.prepare("DELETE FROM concorrencia_ofertas WHERE periodo_id = ? AND (fonte = ? OR fonte IS NULL)").run(periodoId, fonte);
  const ins = _insOferta();
  for (const o of ofertas) _runOferta(ins, periodoId, o, fonte);
  touchPeriodo(periodoId);
}

// adiciona ofertas manuais; substitui a manual anterior do mesmo (concorrente, produto).
function adicionarOfertasConc(periodoId, ofertas) {
  const del = db.prepare("DELETE FROM concorrencia_ofertas WHERE periodo_id = ? AND fonte = 'manual' AND lower(concorrente) = lower(?) AND lower(produto) = lower(?)");
  const ins = _insOferta();
  db.exec("BEGIN");
  try {
    for (const o of ofertas) {
      del.run(periodoId, o.concorrente || "", o.produto || "");
      _runOferta(ins, periodoId, o, "manual");
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  touchPeriodo(periodoId);
  return ofertas.length;
}

function getConcorrencia(periodoId) {
  return db.prepare("SELECT * FROM concorrencia_ofertas WHERE periodo_id = ?").all(periodoId);
}

// --- promoções planejadas (o "tabelão"/encarte da loja) -------------------

function _normDesc(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// substitui todas as linhas vindas de UM arquivo (re-upload é seguro)
function substituirPromocoesPlanejadas(fonteArquivo, linhas) {
  const ts = nowIso();
  const ins = db.prepare(
    `INSERT INTO promocoes_planejadas
       (loja_id, produto_id, ean, descricao, categoria, preco_normal, preco_promo, desconto_pct, data_inicio, data_fim, campanha, fonte_arquivo, chave, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chave) DO UPDATE SET
       loja_id = excluded.loja_id, produto_id = excluded.produto_id, ean = excluded.ean, descricao = excluded.descricao,
       categoria = excluded.categoria, preco_normal = excluded.preco_normal, preco_promo = excluded.preco_promo,
       desconto_pct = excluded.desconto_pct, data_inicio = excluded.data_inicio, data_fim = excluded.data_fim,
       campanha = excluded.campanha, fonte_arquivo = excluded.fonte_arquivo, atualizado_em = excluded.atualizado_em`
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM promocoes_planejadas WHERE fonte_arquivo = ?").run(fonteArquivo);
    let casados = 0;
    for (const l of linhas) {
      const lojasAlvo = l.loja === "__todas__" ? [null] : [lojaId(l.loja)];
      // resolve produto + categoria efetiva
      let prod = null;
      if (l.ean) prod = getProdutoPorEan(l.ean);
      if (!prod && l.descricao) prod = getProdutoPorNorm(_normDesc(l.descricao));
      if (prod) casados++;
      const categoria = l.categoria || (prod && prod.categoria) || null;
      for (const lid of lojasAlvo) {
        const chave = [lid == null ? "__todas__" : lid, l.ean || _normDesc(l.descricao), l.data_inicio || ""].join("|");
        ins.run(
          lid, prod ? prod.id : null, l.ean || null, l.descricao, categoria,
          l.preco_normal ?? null, l.preco_promo ?? null, l.desconto_pct ?? null,
          l.data_inicio || null, l.data_fim || null, l.campanha || null, fonteArquivo, chave, ts, ts
        );
      }
    }
    db.exec("COMMIT");
    return { linhas: linhas.length, casados_no_catalogo: casados };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// promoções vigentes numa data: sem data (vale sempre) OU refDate dentro de [inicio, fim]
function promocoesVigentes(lojaNome, refDate) {
  const lid = lojaId(lojaNome);
  const d = refDate || nowIso().slice(0, 10);
  return db
    .prepare(
      `SELECT * FROM promocoes_planejadas
        WHERE (loja_id = ? OR loja_id IS NULL)
          AND (data_inicio IS NULL OR data_inicio <= ?)
          AND (data_fim IS NULL OR data_fim >= ?)
        ORDER BY COALESCE(preco_promo, 0) DESC`
    )
    .all(lid, d, d);
}

function promocoesPorCategoria(lojaNome, refDate) {
  const m = new Map();
  for (const p of promocoesVigentes(lojaNome, refDate)) {
    const cat = p.categoria || "(sem categoria)";
    if (!m.has(cat)) m.set(cat, { n: 0, exemplos: [] });
    const e = m.get(cat);
    e.n++;
    if (e.exemplos.length < 4) e.exemplos.push({ descricao: p.descricao, preco_promo: p.preco_promo, preco_normal: p.preco_normal, desconto_pct: p.desconto_pct, campanha: p.campanha });
  }
  return m;
}

function freshnessPromocoes(lojaNome) {
  const lid = lojaId(lojaNome);
  const r = db.prepare("SELECT MAX(atualizado_em) u, COUNT(*) n FROM promocoes_planejadas WHERE loja_id = ? OR loja_id IS NULL").get(lid);
  return { ultima: (r && r.u) || null, total: (r && r.n) || 0 };
}

// --- análise comercial (Fase 2) — guardada no banco ----------------------

function saveAnaliseComercial(loja, ano, mes, doc) {
  const lid = lojaId(loja);
  const ts = nowIso();
  const geradoEm = (doc && doc.meta && doc.meta.gerado_em) || ts;
  db.prepare(
    `INSERT INTO analises_comerciais (loja_id, ano, mes, gerado_em, json, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loja_id, ano, mes) DO UPDATE SET
       gerado_em = excluded.gerado_em, json = excluded.json, atualizado_em = excluded.atualizado_em`
  ).run(lid, ano, mes, geradoEm, JSON.stringify(doc), ts, ts);
}

function getAnaliseComercial(loja, ano, mes) {
  const lid = lojaId(loja);
  const row = db.prepare("SELECT json FROM analises_comerciais WHERE loja_id = ? AND ano = ? AND mes = ?").get(lid, ano, mes);
  if (!row) return null;
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

function listAnalisesComerciais(loja) {
  const lid = lojaId(loja);
  return db
    .prepare("SELECT ano, mes, gerado_em, atualizado_em FROM analises_comerciais WHERE loja_id = ? ORDER BY ano DESC, mes DESC")
    .all(lid)
    .map((r) => ({ ano: r.ano, mes: r.mes, periodo: `${r.ano}-${String(r.mes).padStart(2, "0")}`, geradoEm: r.gerado_em, atualizadoEm: r.atualizado_em }));
}

// --- Fase 1: catálogo (produtos) + histórico de estoque / custo / preço --------

function getProdutoPorEan(ean) {
  return ean ? db.prepare("SELECT * FROM produtos WHERE ean = ?").get(ean) || null : null;
}
function getProdutoPorNorm(norm) {
  return db.prepare("SELECT * FROM produtos WHERE ean IS NULL AND descricao_normalizada = ?").get(norm) || null;
}
function getProdutoPorId(id) {
  return db.prepare("SELECT * FROM produtos WHERE id = ?").get(id) || null;
}

// upsert por EAN (ou por descrição normalizada quando não há EAN). Nunca rebaixa a fonte
// (manual > catalogo > vendas) nem mexe nos campos *_manual.
function upsertProduto(p) {
  const ts = nowIso();
  const norm = p.descricao_normalizada;
  const existente = p.ean ? getProdutoPorEan(p.ean) : getProdutoPorNorm(norm);
  if (!existente) {
    const info = db
      .prepare(
        `INSERT INTO produtos (ean, descricao, descricao_normalizada, marca, categoria, categoria_fonte, subcategoria, fonte, primeira_venda, ultima_venda, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.ean || null, p.descricao, norm, p.marca || null, p.categoria || null, p.categoria_fonte || "vendas", p.subcategoria || null, p.fonte || "vendas", p.primeira_venda || null, p.ultima_venda || null, ts, ts);
    return { id: Number(info.lastInsertRowid), criado: true };
  }
  const rank = { vendas: 0, catalogo: 1, manual: 2 };
  const fonte = (rank[p.fonte] ?? 0) > (rank[existente.fonte] ?? 0) ? p.fonte : existente.fonte;
  const descricao = p.descricao && p.descricao.length > (existente.descricao || "").length ? p.descricao : existente.descricao;
  const primeira = !existente.primeira_venda || (p.primeira_venda && p.primeira_venda < existente.primeira_venda) ? p.primeira_venda || existente.primeira_venda : existente.primeira_venda;
  const ultima = !existente.ultima_venda || (p.ultima_venda && p.ultima_venda > existente.ultima_venda) ? p.ultima_venda || existente.ultima_venda : existente.ultima_venda;
  // categoria: só sobrescreve se a fonte que chega tem rank >= da fonte que já classificou
  // (vendas=palavra-chave < erp < manual). Sem categoria_fonte gravada = "vendas".
  const catRank = { vendas: 0, erp: 1, manual: 2 };
  const catFonteAtual = existente.categoria_fonte || "vendas";
  const catFonteNova = p.categoria_fonte || "vendas";
  const podeSobrescreverCat = (catRank[catFonteNova] ?? 0) >= (catRank[catFonteAtual] ?? 0);
  const novaCat = podeSobrescreverCat ? (p.categoria || null) : null;
  const novaCatFonte = novaCat ? catFonteNova : catFonteAtual;
  db.prepare(
    `UPDATE produtos SET descricao = ?, descricao_normalizada = ?, marca = COALESCE(?, marca),
       categoria = COALESCE(?, categoria), categoria_fonte = ?, subcategoria = COALESCE(?, subcategoria),
       ean = COALESCE(ean, ?), fonte = ?, primeira_venda = ?, ultima_venda = ?, atualizado_em = ?
     WHERE id = ?`
  ).run(descricao, norm, p.marca || null, novaCat, novaCatFonte, p.subcategoria || null, p.ean || null, fonte, primeira, ultima, ts, existente.id);
  return { id: existente.id, criado: false };
}

// categoria/subcategoria/classe vindas do ERP (grupo da planilha de estoque). Vence a
// classificação por palavra-chave, mas nunca a correção manual (categoria_fonte='manual').
function setProdutoErp(id, e) {
  const p = getProdutoPorId(id);
  if (!p) return null;
  const manual = (p.categoria_fonte || "") === "manual" || p.categoria_manual;
  const sets = ["principio_ativo_cod = COALESCE(?, principio_ativo_cod)", "registro_ms = COALESCE(?, registro_ms)", "classe_comercial = COALESCE(?, classe_comercial)"];
  const vals = [e.principio_ativo_cod || null, e.registro_ms || null, e.classe_comercial || null];
  if (e.categoria && !manual) {
    sets.push("categoria = ?", "categoria_fonte = 'erp'");
    vals.push(e.categoria);
    if (e.subcategoria) { sets.push("subcategoria = ?"); vals.push(e.subcategoria); }
  }
  db.prepare(`UPDATE produtos SET ${sets.join(", ")}, atualizado_em = ? WHERE id = ?`).run(...vals, nowIso(), id);
  return { id, categoria_aplicada: !!(e.categoria && !manual) };
}

// correção manual — prevalece sobre a classificação automática
function setProdutoOverride(id, campos) {
  const ok = ["descricao_manual", "marca_manual", "categoria_manual", "subcategoria_manual", "ativo"];
  const sets = [];
  const vals = [];
  for (const k of ok) if (k in campos) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  if (!sets.length) return getProdutoPorId(id);
  db.prepare(`UPDATE produtos SET ${sets.join(", ")}, fonte = 'manual', atualizado_em = ? WHERE id = ?`).run(...vals, nowIso(), id);
  return getProdutoPorId(id);
}

// visão "efetiva" do produto: override manual vence a classificação automática
function produtoEfetivo(p) {
  if (!p) return null;
  return {
    id: p.id, ean: p.ean,
    descricao: p.descricao_manual || p.descricao,
    marca: p.marca_manual || p.marca || null,
    categoria: p.categoria_manual || p.categoria || null,
    subcategoria: p.subcategoria_manual || p.subcategoria || null,
    fonte: p.fonte, ativo: !!p.ativo,
    primeira_venda: p.primeira_venda, ultima_venda: p.ultima_venda,
    tem_override: !!(p.categoria_manual || p.marca_manual || p.descricao_manual || p.subcategoria_manual),
  };
}

function listProdutos(filtro = {}) {
  const cond = [];
  const args = [];
  if (filtro.categoria) { cond.push("COALESCE(categoria_manual, categoria) = ?"); args.push(filtro.categoria); }
  if (filtro.semEan) cond.push("ean IS NULL");
  if (filtro.q) { cond.push("descricao_normalizada LIKE ?"); args.push("%" + String(filtro.q).toLowerCase() + "%"); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const lim = Math.min(2000, filtro.limite || 500);
  return db.prepare(`SELECT * FROM produtos ${where} ORDER BY ultima_venda DESC NULLS LAST, id DESC LIMIT ${lim}`).all(...args).map(produtoEfetivo);
}

function contagemCatalogo() {
  const g = db.prepare("SELECT COUNT(*) n, SUM(ean IS NOT NULL) com_ean, SUM(COALESCE(categoria_manual,categoria) IS NULL) sem_cat, SUM(fonte='manual') manuais FROM produtos").get();
  return { produtos: g.n || 0, comEan: g.com_ean || 0, semCategoria: g.sem_cat || 0, comOverride: g.manuais || 0 };
}

// snapshot de estoque (um por loja/produto/data)
function inserirEstoque(lojaId0, produtoId, r) {
  db.prepare(
    `INSERT INTO produto_estoque (loja_id, produto_id, quantidade, reservado, disponivel, data_referencia, fonte, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loja_id, produto_id, data_referencia) DO UPDATE SET
       quantidade = excluded.quantidade, reservado = excluded.reservado, disponivel = excluded.disponivel, fonte = excluded.fonte`
  ).run(lojaId0, produtoId, r.quantidade ?? null, r.reservado ?? null, r.disponivel ?? (r.quantidade != null ? r.quantidade - (r.reservado || 0) : null), r.data_referencia, r.fonte || null, nowIso());
}

// custo/preço historizados: fecha a vigência aberta anterior e abre a nova
function _inserirHistorico(tabela, campoValor, lojaId0, produtoId, valor, dataInicio, extra) {
  const ts = nowIso();
  const anterior = db.prepare(`SELECT id, data_inicio, ${campoValor} v FROM ${tabela} WHERE loja_id = ? AND produto_id = ? ${extra.tipoPreco ? "AND tipo_preco = ?" : ""} AND data_fim IS NULL ORDER BY data_inicio DESC LIMIT 1`)
    .get(...(extra.tipoPreco ? [lojaId0, produtoId, extra.tipoPreco] : [lojaId0, produtoId]));
  if (anterior) {
    if (anterior.data_inicio === dataInicio) {
      db.prepare(`UPDATE ${tabela} SET ${campoValor} = ? WHERE id = ?`).run(valor, anterior.id);
      return { atualizado: true };
    }
    if (Math.abs((anterior.v ?? 0) - valor) < 0.005 && anterior.data_inicio <= dataInicio) return { semMudanca: true };
    const fim = new Date(new Date(dataInicio + "T12:00:00").getTime() - 86400000).toISOString().slice(0, 10);
    db.prepare(`UPDATE ${tabela} SET data_fim = ? WHERE id = ?`).run(fim, anterior.id);
  }
  if (extra.tipoPreco) {
    db.prepare(`INSERT INTO produto_preco (loja_id, produto_id, preco, tipo_preco, data_inicio, fonte, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(lojaId0, produtoId, valor, extra.tipoPreco, dataInicio, extra.fonte || null, ts);
  } else {
    db.prepare(`INSERT INTO produto_custo (loja_id, produto_id, custo, data_inicio, fonte, criado_em) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(lojaId0, produtoId, valor, dataInicio, extra.fonte || null, ts);
  }
  return { inserido: true };
}
function inserirCusto(lojaId0, produtoId, custo, dataInicio, fonte) {
  return _inserirHistorico("produto_custo", "custo", lojaId0, produtoId, custo, dataInicio, { fonte });
}
function inserirPreco(lojaId0, produtoId, preco, dataInicio, tipoPreco, fonte) {
  return _inserirHistorico("produto_preco", "preco", lojaId0, produtoId, preco, dataInicio, { tipoPreco: tipoPreco || "normal", fonte });
}

function getEstoqueEm(lojaId0, produtoId, data) {
  return db.prepare("SELECT * FROM produto_estoque WHERE loja_id = ? AND produto_id = ? AND data_referencia <= ? ORDER BY data_referencia DESC LIMIT 1").get(lojaId0, produtoId, data || "9999-12-31") || null;
}
function getCustoEm(lojaId0, produtoId, data) {
  return db.prepare("SELECT * FROM produto_custo WHERE loja_id = ? AND produto_id = ? AND data_inicio <= ? AND (data_fim IS NULL OR data_fim >= ?) ORDER BY data_inicio DESC LIMIT 1").get(lojaId0, produtoId, data, data) || null;
}

// custo do MESMO produto em QUALQUER loja diferente da dada — proxy quando a loja não tem custo
function getCustoProxyOutraLoja(lojaId0, produtoId, data) {
  const r = db.prepare(
    `SELECT c.*, l.nome AS loja_origem FROM produto_custo c JOIN lojas l ON l.id = c.loja_id
      WHERE c.loja_id <> ? AND c.produto_id = ? AND c.data_inicio <= ? AND (c.data_fim IS NULL OR c.data_fim >= ?)
      ORDER BY c.data_inicio DESC LIMIT 1`
  ).get(lojaId0, produtoId, data, data);
  return r || null;
}
function getPrecoEm(lojaId0, produtoId, data, tipoPreco) {
  return db.prepare("SELECT * FROM produto_preco WHERE loja_id = ? AND produto_id = ? AND tipo_preco = ? AND data_inicio <= ? AND (data_fim IS NULL OR data_fim >= ?) ORDER BY data_inicio DESC LIMIT 1").get(lojaId0, produtoId, tipoPreco || "normal", data, data) || null;
}

function freshnessCatalogo(lojaNome) {
  const lid = lojaId(lojaNome);
  const e = db.prepare("SELECT MAX(data_referencia) d, COUNT(DISTINCT produto_id) n FROM produto_estoque WHERE loja_id = ?").get(lid);
  const c = db.prepare("SELECT MAX(data_inicio) d, COUNT(DISTINCT produto_id) n FROM produto_custo WHERE loja_id = ?").get(lid);
  const p = db.prepare("SELECT MAX(data_inicio) d, COUNT(DISTINCT produto_id) n FROM produto_preco WHERE loja_id = ?").get(lid);
  return {
    estoque: { ultima: e.d || null, produtos: e.n || 0 },
    custo: { ultima: c.d || null, produtos: c.n || 0 },
    preco: { ultima: p.d || null, produtos: p.n || 0 },
  };
}

// --- Fase 2/3/4: janelas de venda por produto (sempre de UMA loja) ------------

function getUltimaDataVenda(loja) {
  const lid = lojaId(loja);
  const r = db
    .prepare("SELECT MAX(v.data) d FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id WHERE p.loja_id = ?")
    .get(lid);
  return (r && r.d) || null;
}

// agregado por produto (barras) numa janela [ini, fim] — uma loja só.
function vendasPorProdutoJanela(loja, ini, fim) {
  const lid = lojaId(loja);
  return db
    .prepare(
      `SELECT v.barras AS barras,
              MAX(v.descricao) AS descricao,
              SUM(v.quantidade) AS unidades,
              SUM(v.valor_liquido) AS receita,
              COUNT(DISTINCT v.data || '#' || v.lancamento) AS cupons,
              COUNT(DISTINCT v.data) AS dias_com_venda,
              MIN(v.data) AS primeira,
              MAX(v.data) AS ultima
         FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
        WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?
        GROUP BY v.barras`
    )
    .all(lid, ini, fim);
}

// total de cupons distintos de uma loja numa janela (denominador da cesta / penetração)
function cuponsNaJanela(loja, ini, fim) {
  const lid = lojaId(loja);
  const r = db
    .prepare(
      "SELECT COUNT(DISTINCT v.data || '#' || v.lancamento) n FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?"
    )
    .get(lid, ini, fim);
  return (r && r.n) || 0;
}

// linhas cruas (lancamento, data, barras, descricao, quantidade) p/ a cesta — uma loja.
function linhasCestaJanela(loja, ini, fim) {
  const lid = lojaId(loja);
  return db
    .prepare(
      `SELECT v.data, v.lancamento, v.barras, v.descricao, v.quantidade, v.valor_liquido
         FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
        WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?`
    )
    .all(lid, ini, fim);
}

function todosProdutos() {
  return db.prepare("SELECT * FROM produtos").all().map(produtoEfetivo);
}

// soma diária por categoria (categoria já classificada na ingestão) — uma loja.
function vendasCategoriaPorData(loja, ini, fim) {
  const lid = lojaId(loja);
  return db
    .prepare(
      `SELECT v.data AS data, v.categoria AS categoria,
              SUM(v.valor_liquido) AS receita, SUM(v.quantidade) AS unidades
         FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
        WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?
        GROUP BY v.data, v.categoria`
    )
    .all(lid, ini, fim);
}

// --- Fase 3: campanhas como entidade -----------------------------------------

function criarCampanha(loja, c) {
  const lid = lojaId(loja);
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO campanhas (loja_id, nome, objetivo, categoria, data_inicio, data_fim, status, descricao, investimento, origem, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      c.nome,
      c.objetivo || null,
      c.categoria || null,
      c.data_inicio || null,
      c.data_fim || null,
      c.status || "rascunho",
      c.descricao || null,
      c.investimento ?? null,
      c.origem || "manual",
      ts,
      ts
    );
  return Number(info.lastInsertRowid);
}

function atualizarCampanha(id, campos) {
  const ok = ["nome", "objetivo", "categoria", "data_inicio", "data_fim", "status", "descricao", "investimento"];
  const sets = [];
  const vals = [];
  for (const k of ok) if (k in campos) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  if (!sets.length) return getCampanha(id);
  db.prepare(`UPDATE campanhas SET ${sets.join(", ")}, atualizado_em = ? WHERE id = ?`).run(...vals, nowIso(), id);
  return getCampanha(id);
}

function addCampanhaProduto(campanhaId, p) {
  db.prepare(
    `INSERT INTO campanha_produtos (campanha_id, produto_id, papel, preco_planejado, preco_promocional, prioridade)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(campanha_id, produto_id) DO UPDATE SET
       papel = excluded.papel, preco_planejado = excluded.preco_planejado,
       preco_promocional = excluded.preco_promocional, prioridade = excluded.prioridade`
  ).run(campanhaId, p.produto_id, p.papel || null, p.preco_planejado ?? null, p.preco_promocional ?? null, p.prioridade ?? null);
}

function getCampanha(id) {
  const c = db.prepare("SELECT c.*, l.nome AS loja FROM campanhas c JOIN lojas l ON l.id = c.loja_id WHERE c.id = ?").get(id);
  if (!c) return null;
  c.produtos = db
    .prepare(
      `SELECT cp.*, p.ean, COALESCE(p.descricao_manual, p.descricao) AS descricao,
              COALESCE(p.categoria_manual, p.categoria) AS categoria
         FROM campanha_produtos cp JOIN produtos p ON p.id = cp.produto_id
        WHERE cp.campanha_id = ? ORDER BY cp.prioridade IS NULL, cp.prioridade`
    )
    .all(id);
  const r = db.prepare("SELECT * FROM campanha_resultados WHERE campanha_id = ?").get(id);
  c.resultado = r ? { ...r, metricas: r.metricas_json ? JSON.parse(r.metricas_json) : null } : null;
  return c;
}

function listCampanhas(loja) {
  const lid = lojaId(loja);
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM campanha_produtos cp WHERE cp.campanha_id = c.id) AS n_produtos,
              (SELECT resultado FROM campanha_resultados r WHERE r.campanha_id = c.id) AS resultado
         FROM campanhas c WHERE c.loja_id = ? ORDER BY COALESCE(c.data_inicio, c.criado_em) DESC`
    )
    .all(lid);
}

function setCampanhaResultado(campanhaId, { metricas, resultado, score, analise }) {
  db.prepare(
    `INSERT INTO campanha_resultados (campanha_id, metricas_json, resultado, score, analise, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(campanha_id) DO UPDATE SET
       metricas_json = excluded.metricas_json, resultado = excluded.resultado,
       score = excluded.score, analise = excluded.analise, atualizado_em = excluded.atualizado_em`
  ).run(campanhaId, metricas ? JSON.stringify(metricas) : null, resultado || null, score ?? null, analise || null, nowIso());
}

function removerCampanha(id) {
  db.prepare("DELETE FROM campanha_resultados WHERE campanha_id = ?").run(id);
  db.prepare("DELETE FROM campanha_produtos WHERE campanha_id = ?").run(id);
  db.prepare("DELETE FROM campanhas WHERE id = ?").run(id);
}

// importa o calendário recorrente de config/lojas.json como campanhas 'calendario' (idempotente
// por nome+loja). Mantém o config intacto — é só um espelho navegável no banco.
function importarCalendarioCampanhas(loja, campanhasCfg) {
  const lid = lojaId(loja);
  let criadas = 0;
  for (const cc of campanhasCfg || []) {
    const ja = db.prepare("SELECT id FROM campanhas WHERE loja_id = ? AND nome = ? AND origem = 'calendario'").get(lid, cc.nome);
    if (ja) continue;
    criarCampanha(loja, {
      nome: cc.nome,
      objetivo: "GIRAR_ESTOQUE",
      categoria: (cc.categorias || []).join(" + ") || null,
      status: "ativa",
      descricao: `Recorrente — dias ${JSON.stringify(cc.dias)} (config/lojas.json). Categorias: ${(cc.categorias || []).join(", ")}.`,
      origem: "calendario",
    });
    criadas++;
  }
  return criadas;
}

// --- Fase 4: cesta (materialização) -----------------------------------------

function salvarCestaPares(loja, janelaIni, janelaFim, pares) {
  const lid = lojaId(loja);
  const ts = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cesta_pares WHERE loja_id = ? AND janela_ini = ? AND janela_fim = ?").run(lid, janelaIni, janelaFim);
    const ins = db.prepare(
      `INSERT INTO cesta_pares (loja_id, janela_ini, janela_fim, produto_a, produto_b, cupons_a, cupons_b, cupons_ab, support, confidence, lift, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of pares) {
      ins.run(lid, janelaIni, janelaFim, p.produto_a, p.produto_b, p.cupons_a, p.cupons_b, p.cupons_ab, p.support, p.confidence, p.lift, ts);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function getCestaPares(loja, { produtoId, limite } = {}) {
  const lid = lojaId(loja);
  const ult = db.prepare("SELECT janela_ini, janela_fim FROM cesta_pares WHERE loja_id = ? ORDER BY janela_fim DESC LIMIT 1").get(lid);
  if (!ult) return { janela: null, pares: [] };
  const cond = ["cp.loja_id = ?", "cp.janela_ini = ?", "cp.janela_fim = ?"];
  const args = [lid, ult.janela_ini, ult.janela_fim];
  if (produtoId) { cond.push("(cp.produto_a = ? OR cp.produto_b = ?)"); args.push(produtoId, produtoId); }
  const lim = Math.min(2000, limite || 400);
  const pares = db
    .prepare(
      `SELECT cp.*, COALESCE(pa.descricao_manual, pa.descricao) AS desc_a, COALESCE(pb.descricao_manual, pb.descricao) AS desc_b,
              pa.ean AS ean_a, pb.ean AS ean_b
         FROM cesta_pares cp
         JOIN produtos pa ON pa.id = cp.produto_a
         JOIN produtos pb ON pb.id = cp.produto_b
        WHERE ${cond.join(" AND ")}
        ORDER BY cp.lift DESC LIMIT ${lim}`
    )
    .all(...args);
  return { janela: { inicio: ult.janela_ini, fim: ult.janela_fim }, pares };
}

// --- Fases 5–12: camada de inteligência ------------------------------------

const _INTEL_CFG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config", "intelligence.json"), "utf8"));
  } catch {
    return { codigos: {} };
  }
})();

// id human-readable estável (deriva do id numérico — autoincrement é estável).
function codigoIntel(chave, id) {
  const pref = (_INTEL_CFG.codigos && _INTEL_CFG.codigos[chave]) || String(chave || "X").slice(0, 3).toUpperCase();
  return `${pref}-${String(id).padStart(6, "0")}`;
}

function registrarEventoIntel(loja, tipo, { refTabela = null, refId = null, payload = null } = {}) {
  db.prepare("INSERT INTO intel_eventos (loja_id, tipo, ref_tabela, ref_id, payload, criado_em) VALUES (?, ?, ?, ?, ?, ?)")
    .run(lojaId(loja), tipo, refTabela, refId, payload ? JSON.stringify(payload) : null, nowIso());
}

// cria ou atualiza um sinal por (loja, dedupe_key). Se estava resolvido e voltou a ser
// detectado, reabre. Sempre regrava as evidências.
function upsertSinal(loja, s) {
  const lid = lojaId(loja);
  const ts = nowIso();
  const ex = db.prepare("SELECT * FROM intel_sinais WHERE loja_id = ? AND dedupe_key = ?").get(lid, s.dedupe_key);
  let id;
  let reaberto = false;
  if (!ex) {
    const info = db
      .prepare(
        `INSERT INTO intel_sinais
          (loja_id, classe, tipo, titulo, resumo, severidade, confianca, impacto_estimado, prioridade,
           entidade_tipo, entidade_ref, periodo, status, dedupe_key, primeira_vez, ultima_vez, ocorrencias, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto', ?, ?, ?, 1, ?, ?)`
      )
      .run(lid, s.classe, s.tipo, s.titulo, s.resumo || null, s.severidade || 0, s.confianca || 0,
        s.impacto_estimado ?? null, s.prioridade || 0, s.entidade_tipo || null, s.entidade_ref || null,
        s.periodo || null, s.dedupe_key, ts, ts, ts, ts);
    id = Number(info.lastInsertRowid);
  } else {
    id = ex.id;
    reaberto = ex.status === "resolvido" || ex.status === "descartado";
    db.prepare(
      `UPDATE intel_sinais SET classe = ?, tipo = ?, titulo = ?, resumo = ?, severidade = ?, confianca = ?,
         impacto_estimado = ?, prioridade = ?, entidade_tipo = ?, entidade_ref = ?, periodo = ?,
         status = CASE WHEN status IN ('resolvido','descartado') THEN 'aberto' ELSE status END,
         ultima_vez = ?, ocorrencias = ocorrencias + 1, resolvido_em = NULL, atualizado_em = ?
       WHERE id = ?`
    ).run(s.classe, s.tipo, s.titulo, s.resumo || null, s.severidade || 0, s.confianca || 0,
      s.impacto_estimado ?? null, s.prioridade || 0, s.entidade_tipo || null, s.entidade_ref || null,
      s.periodo || null, ts, ts, id);
  }
  db.prepare("DELETE FROM intel_evidencias WHERE sinal_id = ?").run(id);
  const insE = db.prepare("INSERT INTO intel_evidencias (sinal_id, campo, valor, fonte, periodo, criado_em) VALUES (?, ?, ?, ?, ?, ?)");
  for (const e of s.evidencias || []) insE.run(id, e.campo, e.valor == null ? null : String(e.valor), e.fonte || null, e.periodo || null, ts);
  registrarEventoIntel(loja, ex ? (reaberto ? "SINAL_REABERTO" : "SINAL_ATUALIZADO") : "SINAL_ABERTO", { refTabela: "intel_sinais", refId: id, payload: { tipo: s.tipo } });
  return { id, codigo: codigoIntel(s.classe, id), novo: !ex, reaberto };
}

// marca como resolvidos os sinais abertos de uma leva anterior que NÃO reapareceram agora.
function resolverSinaisAusentes(loja, tipos, dedupeKeysAtuais) {
  const lid = lojaId(loja);
  const set = new Set(dedupeKeysAtuais);
  const abertos = db
    .prepare(`SELECT id, dedupe_key FROM intel_sinais WHERE loja_id = ? AND status IN ('aberto','observando') AND tipo IN (${tipos.map(() => "?").join(",")})`)
    .all(lid, ...tipos);
  let n = 0;
  for (const a of abertos) {
    if (!set.has(a.dedupe_key)) {
      db.prepare("UPDATE intel_sinais SET status = 'resolvido', resolvido_em = ?, atualizado_em = ? WHERE id = ?").run(nowIso(), nowIso(), a.id);
      registrarEventoIntel(loja, "SINAL_RESOLVIDO", { refTabela: "intel_sinais", refId: a.id });
      n++;
    }
  }
  return n;
}

function _sinalComCodigo(r) {
  if (!r) return null;
  r.codigo = codigoIntel(r.classe, r.id);
  return r;
}
function listSinais(loja, { status, classe, tipo, limite } = {}) {
  const lid = lojaId(loja);
  const cond = ["loja_id = ?"];
  const args = [lid];
  if (status) { cond.push("status = ?"); args.push(status); }
  if (classe) { cond.push("classe = ?"); args.push(classe); }
  if (tipo) { cond.push("tipo = ?"); args.push(tipo); }
  const lim = Math.min(500, limite || 200);
  return db.prepare(`SELECT * FROM intel_sinais WHERE ${cond.join(" AND ")} ORDER BY prioridade DESC, atualizado_em DESC LIMIT ${lim}`).all(...args).map(_sinalComCodigo);
}
function getSinal(id) {
  const r = _sinalComCodigo(db.prepare("SELECT * FROM intel_sinais WHERE id = ?").get(id));
  if (!r) return null;
  r.evidencias = db.prepare("SELECT campo, valor, fonte, periodo FROM intel_evidencias WHERE sinal_id = ? ORDER BY id").all(id);
  return r;
}
function setSinalStatus(id, status) {
  const ok = ["aberto", "observando", "resolvido", "descartado"];
  if (!ok.includes(status)) throw new Error("status inválido");
  db.prepare("UPDATE intel_sinais SET status = ?, resolvido_em = CASE WHEN ? IN ('resolvido','descartado') THEN ? ELSE NULL END, atualizado_em = ? WHERE id = ?")
    .run(status, status, nowIso(), nowIso(), id);
  return getSinal(id);
}

// -- investigações / hipóteses --
function criarInvestigacao(loja, { pergunta, sinal_id = null }) {
  const ts = nowIso();
  const info = db.prepare("INSERT INTO intel_investigacoes (loja_id, pergunta, sinal_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)")
    .run(lojaId(loja), pergunta, sinal_id, ts, ts);
  return Number(info.lastInsertRowid);
}
function addHipotese(investigacaoId, h) {
  db.prepare("INSERT INTO intel_hipoteses (investigacao_id, texto, veredito, confianca, evidencias_json, criado_em) VALUES (?, ?, ?, ?, ?, ?)")
    .run(investigacaoId, h.texto, h.veredito || "inconclusiva", h.confianca || 0, h.evidencias ? JSON.stringify(h.evidencias) : null, nowIso());
}
function concluirInvestigacao(id, { conclusao, confianca }) {
  db.prepare("UPDATE intel_investigacoes SET status = 'concluida', conclusao = ?, confianca = ?, atualizado_em = ? WHERE id = ?")
    .run(conclusao || null, confianca ?? null, nowIso(), id);
  return getInvestigacao(id);
}
function getInvestigacao(id) {
  const r = db.prepare("SELECT i.*, s.titulo AS sinal_titulo FROM intel_investigacoes i LEFT JOIN intel_sinais s ON s.id = i.sinal_id WHERE i.id = ?").get(id);
  if (!r) return null;
  r.codigo = codigoIntel("investigacao", r.id);
  r.hipoteses = db.prepare("SELECT * FROM intel_hipoteses WHERE investigacao_id = ? ORDER BY confianca DESC, id").all(id)
    .map((h) => ({ ...h, evidencias: h.evidencias_json ? JSON.parse(h.evidencias_json) : [] }));
  return r;
}
function listInvestigacoes(loja) {
  return db.prepare("SELECT i.*, (SELECT COUNT(*) FROM intel_hipoteses h WHERE h.investigacao_id = i.id) n_hip FROM intel_investigacoes i WHERE i.loja_id = ? ORDER BY i.criado_em DESC")
    .all(lojaId(loja)).map((r) => ({ ...r, codigo: codigoIntel("investigacao", r.id) }));
}

// -- decisões / ações / resultados --
function criarDecisao(loja, d) {
  const ts = nowIso();
  const info = db.prepare("INSERT INTO intel_decisoes (loja_id, titulo, contexto, tipo, sinais_json, decidido_por, decidido_em, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(lojaId(loja), d.titulo, d.contexto || null, d.tipo || null, d.sinais ? JSON.stringify(d.sinais) : null, d.decidido_por || null, d.decidido_em || ts, ts);
  const id = Number(info.lastInsertRowid);
  for (const a of d.acoes || []) addAcao(id, a);
  registrarEventoIntel(loja, "DECISAO_REGISTRADA", { refTabela: "intel_decisoes", refId: id });
  return id;
}
function addAcao(decisaoId, a) {
  db.prepare("INSERT INTO intel_acoes (decisao_id, texto, responsavel, prazo, status) VALUES (?, ?, ?, ?, ?)")
    .run(decisaoId, a.texto, a.responsavel || null, a.prazo || null, a.status || "pendente");
}
function setAcaoStatus(id, status) {
  db.prepare("UPDATE intel_acoes SET status = ? WHERE id = ?").run(status, id);
}
function addResultado(decisaoId, r) {
  db.prepare("INSERT INTO intel_resultados (decisao_id, metrica, antes, depois, unidade, veredito, avaliado_em, nota) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(decisaoId, r.metrica, r.antes ?? null, r.depois ?? null, r.unidade || null, r.veredito || null, r.avaliado_em || nowIso(), r.nota || null);
}
function getDecisao(id) {
  const r = db.prepare("SELECT d.*, l.nome AS loja FROM intel_decisoes d JOIN lojas l ON l.id = d.loja_id WHERE d.id = ?").get(id);
  if (!r) return null;
  r.codigo = codigoIntel("decisao", r.id);
  r.sinais = r.sinais_json ? JSON.parse(r.sinais_json) : [];
  r.acoes = db.prepare("SELECT * FROM intel_acoes WHERE decisao_id = ? ORDER BY id").all(id);
  r.resultados = db.prepare("SELECT * FROM intel_resultados WHERE decisao_id = ? ORDER BY avaliado_em").all(id);
  return r;
}
function listDecisoes(loja) {
  return db.prepare("SELECT d.*, (SELECT COUNT(*) FROM intel_acoes a WHERE a.decisao_id = d.id) n_acoes, (SELECT COUNT(*) FROM intel_resultados r WHERE r.decisao_id = d.id) n_result FROM intel_decisoes d WHERE d.loja_id = ? ORDER BY d.decidido_em DESC")
    .all(lojaId(loja)).map((r) => ({ ...r, codigo: codigoIntel("decisao", r.id), sinais: r.sinais_json ? JSON.parse(r.sinais_json) : [] }));
}

// -- padrões --
function upsertPadrao(loja, chave, { descricao, sucesso } = {}) {
  const lid = lojaId(loja);
  const ts = nowIso();
  const ex = db.prepare("SELECT * FROM intel_padroes WHERE loja_id = ? AND chave = ?").get(lid, chave);
  const inc = sucesso == null ? 0 : 1;
  const win = sucesso ? 1 : 0;
  if (!ex) {
    db.prepare("INSERT INTO intel_padroes (loja_id, chave, descricao, amostra_n, sucessos, taxa_sucesso, ultima_ocorrencia, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(lid, chave, descricao || null, inc, win, inc ? win / inc : null, ts, ts);
  } else {
    const n = ex.amostra_n + inc;
    const w = ex.sucessos + win;
    db.prepare("UPDATE intel_padroes SET descricao = COALESCE(?, descricao), amostra_n = ?, sucessos = ?, taxa_sucesso = ?, ultima_ocorrencia = ?, atualizado_em = ? WHERE id = ?")
      .run(descricao || null, n, w, n ? w / n : null, ts, ts, ex.id);
  }
  return getPadrao(loja, chave);
}
function getPadrao(loja, chave) {
  const r = db.prepare("SELECT * FROM intel_padroes WHERE loja_id = ? AND chave = ?").get(lojaId(loja), chave);
  if (!r) return null;
  r.codigo = codigoIntel("padrao", r.id);
  return r;
}
function listPadroes(loja) {
  return db.prepare("SELECT * FROM intel_padroes WHERE loja_id = ? ORDER BY amostra_n DESC, taxa_sucesso DESC").all(lojaId(loja))
    .map((r) => ({ ...r, codigo: codigoIntel("padrao", r.id) }));
}

// -- ontologia persistida (Fase 7) --
function upsertOntologyNode(loja, n) {
  const lid = lojaId(loja);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO ontology_nodes (loja_id, chave, tipo, rotulo, atributos_json, visto_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loja_id, chave) DO UPDATE SET tipo = excluded.tipo, rotulo = excluded.rotulo,
       atributos_json = excluded.atributos_json, atualizado_em = excluded.atualizado_em`
  ).run(lid, n.chave, n.tipo, n.rotulo, n.atributos ? JSON.stringify(n.atributos) : null, ts, ts);
}
function upsertOntologyEdge(loja, e) {
  const lid = lojaId(loja);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO ontology_edges (loja_id, de_chave, para_chave, tipo, forca, confianca, valid_from, valid_to, atributos_json, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loja_id, de_chave, para_chave, tipo) DO UPDATE SET forca = excluded.forca,
       confianca = excluded.confianca, valid_to = excluded.valid_to, atributos_json = excluded.atributos_json,
       atualizado_em = excluded.atualizado_em`
  ).run(lid, e.de, e.para, e.tipo, e.forca ?? 0.5, e.confianca ?? 0.5, e.valid_from || ts.slice(0, 10), e.valid_to || null, e.atributos ? JSON.stringify(e.atributos) : null, ts);
}
function getOntologiaPersistida(loja) {
  const lid = lojaId(loja);
  return {
    nodes: db.prepare("SELECT chave, tipo, rotulo, atributos_json, atualizado_em FROM ontology_nodes WHERE loja_id = ?").all(lid)
      .map((n) => ({ id: n.chave, tipo: n.tipo, rotulo: n.rotulo, atributos: n.atributos_json ? JSON.parse(n.atributos_json) : {}, atualizado_em: n.atualizado_em })),
    edges: db.prepare("SELECT de_chave, para_chave, tipo, forca, confianca, valid_from, valid_to FROM ontology_edges WHERE loja_id = ?").all(lid)
      .map((e) => ({ de: e.de_chave, para: e.para_chave, tipo: e.tipo, forca: e.forca, confianca: e.confianca, valid_from: e.valid_from, valid_to: e.valid_to })),
  };
}

// --- períodos --------------------------------------------------------------

function findPeriodo(loja, ano, mes) {
  const lid = lojaId(loja);
  return db.prepare("SELECT * FROM periodos WHERE loja_id = ? AND ano = ? AND mes = ?").get(lid, ano, mes) || null;
}

function listPeriodos(loja) {
  const lid = lojaId(loja);
  const rows = db
    .prepare(
      `SELECT p.ano, p.mes, p.atualizado_em,
              (SELECT COUNT(*) FROM vendas_transacoes v WHERE v.periodo_id = p.id) AS linhas
       FROM periodos p WHERE p.loja_id = ? ORDER BY p.ano DESC, p.mes DESC`
    )
    .all(lid);
  return rows.map((r) => ({
    ano: r.ano,
    mes: r.mes,
    periodo: `${r.ano}-${String(r.mes).padStart(2, "0")}`,
    atualizadoEm: r.atualizado_em,
    linhas: r.linhas,
    temVendas: r.linhas > 0,
  }));
}

module.exports = {
  db,
  LOJAS_VALIDAS,
  lojaId,
  nowIso,
  getOrCreatePeriodo,
  findPeriodo,
  getPeriodoById,
  getFaturamento,
  getDiasComVenda,
  listPeriodos,
  replaceVendas,
  setVendasMeta,
  getVendas,
  replaceInstagram,
  mergeInstagram,
  getInstagram,
  inserirTrafegoPago,
  getTrafegoPago,
  investimentoTrafegoPago,
  registrarSocialPrint,
  listSocialPrints,
  faturamentoMensal,
  replaceConcorrencia,
  adicionarOfertasConc,
  getConcorrencia,
  substituirPromocoesPlanejadas,
  promocoesVigentes,
  promocoesPorCategoria,
  freshnessPromocoes,
  saveAnaliseComercial,
  getAnaliseComercial,
  listAnalisesComerciais,
  // Fase 1 — catálogo / estoque / custo / preço
  getProdutoPorEan,
  getProdutoPorNorm,
  getProdutoPorId,
  upsertProduto,
  setProdutoErp,
  setProdutoOverride,
  produtoEfetivo,
  listProdutos,
  contagemCatalogo,
  inserirEstoque,
  inserirCusto,
  inserirPreco,
  getEstoqueEm,
  getCustoEm,
  getCustoProxyOutraLoja,
  getPrecoEm,
  freshnessCatalogo,
  // Fase 2/3/4 — janelas de venda + campanhas + cesta
  getUltimaDataVenda,
  vendasPorProdutoJanela,
  cuponsNaJanela,
  linhasCestaJanela,
  todosProdutos,
  vendasCategoriaPorData,
  criarCampanha,
  atualizarCampanha,
  addCampanhaProduto,
  getCampanha,
  listCampanhas,
  setCampanhaResultado,
  removerCampanha,
  importarCalendarioCampanhas,
  salvarCestaPares,
  getCestaPares,
  // Fases 5–12 — inteligência
  codigoIntel,
  registrarEventoIntel,
  upsertSinal,
  resolverSinaisAusentes,
  listSinais,
  getSinal,
  setSinalStatus,
  criarInvestigacao,
  addHipotese,
  concluirInvestigacao,
  getInvestigacao,
  listInvestigacoes,
  criarDecisao,
  addAcao,
  setAcaoStatus,
  addResultado,
  getDecisao,
  listDecisoes,
  upsertPadrao,
  getPadrao,
  listPadroes,
  upsertOntologyNode,
  upsertOntologyEdge,
  getOntologiaPersistida,
};
