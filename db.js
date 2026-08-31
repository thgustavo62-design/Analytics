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
      (periodo_id, data, hora, lancamento, barras, descricao, categoria, preco_unit, quantidade, valor_liquido, forma_pagto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        r.forma_pagto ?? null
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

// --- concorrência ----------------------------------------------------------

function replaceConcorrencia(periodoId, ofertas) {
  db.prepare("DELETE FROM concorrencia_ofertas WHERE periodo_id = ?").run(periodoId);
  const ins = db.prepare(
    `INSERT INTO concorrencia_ofertas
      (periodo_id, concorrente, categoria, produto, preco_normal, preco_promo, validade,
       nivel_confianca, status_validacao, nosso_preco_medio, abaixo_do_nosso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const o of ofertas) {
    ins.run(
      periodoId,
      o.concorrente,
      o.categoria ?? null,
      o.produto,
      o.preco_normal ?? null,
      o.preco_promo ?? null,
      o.validade ?? null,
      o.nivel_confianca ?? null,
      o.status_validacao ?? null,
      o.nosso_preco_medio ?? null,
      o.abaixo_do_nosso == null ? null : o.abaixo_do_nosso ? 1 : 0
    );
  }
  touchPeriodo(periodoId);
}

function getConcorrencia(periodoId) {
  return db.prepare("SELECT * FROM concorrencia_ofertas WHERE periodo_id = ?").all(periodoId);
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
    temVendas: r.linhas > 0,
  }));
}

module.exports = {
  db,
  LOJAS_VALIDAS,
  lojaId,
  getOrCreatePeriodo,
  findPeriodo,
  getPeriodoById,
  listPeriodos,
  replaceVendas,
  setVendasMeta,
  getVendas,
  replaceInstagram,
  getInstagram,
  replaceConcorrencia,
  getConcorrencia,
};
