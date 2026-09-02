// Fase C — Medição de campanha: baseline mesmo dia da semana, incremento, ROAS,
// retorno sobre margem e canibalização. Integração com o PDF real de agosto.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-cm-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas } = require("../ingest");
const { medirCampanha, medirTodasDoCalendario } = require("../marketing/campaign-measure");
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

let LOJA = null;
test("setup: ingere o PDF de agosto", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ingestVendas(FIX);
  LOJA = r.loja;
  assert.ok(LOJA);
});

test("medirCampanha: erro claro para campanha fora do calendário", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = medirCampanha(LOJA, { nome: "Campanha Inexistente XPTO" });
  assert.ok(r.erro && Array.isArray(r.disponiveis));
});

test("medirCampanha: exige nome OU dias+categorias", { skip: FIX ? false : "fixture não encontrada" }, () => {
  assert.ok(medirCampanha(LOJA, {}).erro);
  assert.ok(medirCampanha(LOJA, { dias: "5,6" }).erro); // sem categorias
});

test("medirCampanha: estrutura, baseline, incremento e evidência", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const nome = (LOJAS_CFG[LOJA].campanhas || [])[0].nome;
  const m = medirCampanha(LOJA, { nome });
  assert.ok(!m.erro, m.erro);
  assert.ok(["alta", "baixa"].includes(m.confianca));
  assert.ok(m.baseline && typeof m.baseline.receita_media_dia_campanha === "number");
  assert.ok(m.baseline.n_dias_campanha > 0);
  // incremento total ≈ (média campanha − baseline) × n dias
  const esperado = (m.baseline.receita_media_dia_campanha - m.baseline.receita_media_dia_baseline) * m.baseline.n_dias_campanha;
  assert.ok(Math.abs(m.incremental.receita_total - esperado) <= 1, `incremental ${m.incremental.receita_total} vs ${esperado}`);
  // evidência sempre presente
  assert.ok(m.evidencia && m.evidencia.campo && m.evidencia.periodo);
  // aviso observacional
  assert.ok(/observacional/i.test(m.aviso));
});

test("medirCampanha: canibalização só é medida com baseline do mesmo dia da semana", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const nome = (LOJAS_CFG[LOJA].campanhas || [])[0].nome;
  const m = medirCampanha(LOJA, { nome });
  if (m.confianca === "baixa") {
    assert.equal(m.canibalizacao.canibalizacao_pct, null);
    assert.match(m.canibalizacao.veredito, /não medível/i);
  } else {
    assert.ok(m.canibalizacao.canibalizacao_pct == null || (m.canibalizacao.canibalizacao_pct >= 0 && m.canibalizacao.canibalizacao_pct <= 100));
  }
});

test("medirCampanha: ROAS e retorno sobre margem só com investimento", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const nome = (LOJAS_CFG[LOJA].campanhas || [])[0].nome;
  const sem = medirCampanha(LOJA, { nome });
  assert.equal(sem.retorno.ROAS, null);
  assert.ok(sem.dados_ausentes.some((x) => /investimento/i.test(x)));

  const com = medirCampanha(LOJA, { nome, investimento: 300 });
  if (com.incremental.receita_total != null) {
    assert.ok(Math.abs(com.retorno.ROAS - com.incremental.receita_total / 300) < 0.01);
  }
  // retorno sobre margem existe só se houver custo
  if (com.incremental.lucro_total == null) assert.equal(com.retorno.retorno_sobre_margem, null);
  else assert.ok(Math.abs(com.retorno.retorno_sobre_margem - com.incremental.lucro_total / 300) < 0.01);
});

test("medirCampanha: sem feed de custo, lucro incremental fica null + flag", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const nome = (LOJAS_CFG[LOJA].campanhas || [])[0].nome;
  const m = medirCampanha(LOJA, { nome });
  const db = require("../db");
  const temCusto = db.freshnessCatalogo(LOJA).custo.ultima;
  if (!temCusto) {
    assert.equal(m.incremental.lucro_total, null);
    assert.ok(m.dados_ausentes.some((x) => /custo/i.test(x)));
  } else {
    assert.ok(typeof m.incremental.lucro_total === "number");
  }
});

test("medirTodasDoCalendario: uma entrada por campanha do calendário", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const all = medirTodasDoCalendario(LOJA);
  assert.equal(all.length, (LOJAS_CFG[LOJA].campanhas || []).length);
});

test("medirCampanha ad-hoc: dias + categorias sem estar no calendário", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const m = medirCampanha(LOJA, { dias: "5,6", categorias: "Limpeza", investimento: 100 });
  assert.ok(!m.erro, m.erro);
  assert.equal(m.campanha.fonte, "parâmetros");
  assert.deepEqual(m.campanha.dias_semana.sort(), [5, 6]);
});
