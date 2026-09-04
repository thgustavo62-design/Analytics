// Fase G — Marketing Calendar + ciclo fechado.
// Integração: ingere vendas (+ coleta, se houver) e verifica o calendário sugerido.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-cal-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas, ingestConcorrentes } = require("../ingest");
const { calendarioMarketing } = require("../marketing/calendar");
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

const PDF = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Sistema Marketing\\inbox\\vendas\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));
const XLSX = ["C:\\Sistema Marketing\\inbox\\concorrentes\\Concorrentes_Coleta_2026-08-31.xlsx"].find((p) => fs.existsSync(p));
const SKIP = PDF ? false : "fixture de vendas não encontrada";

const STATUS_OK = new Set(["OK", "SUSPENDER", "RENOVAR", "REVISAR"]);
let LOJA = null;

test("setup: ingere vendas (+ coleta se houver)", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA = r.loja;
  if (XLSX) { try { ingestConcorrentes(XLSX); } catch (e) {} }
  assert.ok(LOJA);
});

test("calendarioMarketing: estrutura, janela e ocorrências coerentes", { skip: SKIP }, () => {
  const c = calendarioMarketing(LOJA, { dias: 28 });
  assert.ok(!c.erro, c.erro);
  assert.ok(c.janela.inicio > c.refDate, "janela deve começar depois do último dia de dados");
  assert.equal(c.janela.dias, 28);
  assert.ok(Array.isArray(c.ocorrencias) && Array.isArray(c.slots_sugeridos));
  assert.ok(Array.isArray(c.semanas) && Array.isArray(c.ciclo_fechado));
  assert.ok(c.resumo.length >= 1);

  const camps = LOJAS_CFG[LOJA].campanhas || [];
  const dowsPorCamp = new Map(camps.map((x) => [x.nome, new Set(x.dias || [])]));
  for (const o of c.ocorrencias) {
    assert.ok(STATUS_OK.has(o.status), `status inválido: ${o.status}`);
    assert.ok(o.datas.length > 0);
    for (const d of o.datas) {
      assert.ok(d >= c.janela.inicio && d <= c.janela.fim, "data da ocorrência fora da janela");
      const dw = new Date(d + "T12:00:00").getDay();
      assert.ok(dowsPorCamp.get(o.campanha).has(dw), "data não bate com o dia-da-semana da campanha");
    }
    if (o.status === "SUSPENDER") assert.match(o.acao, /repor|trocar/i);
    if (o.status === "RENOVAR") assert.match(o.acao, /trocar|renovar/i);
    if (o.status !== "OK") assert.ok(o.motivo && o.evidencia && o.evidencia.fonte, "ajuste sem motivo/evidência");
  }
});

test("calendarioMarketing: slots sugeridos são de categoria sem campanha", { skip: SKIP }, () => {
  const c = calendarioMarketing(LOJA, { dias: 28 });
  const catsComCampanha = new Set((LOJAS_CFG[LOJA].campanhas || []).flatMap((x) => x.categorias || []));
  for (const s of c.slots_sugeridos) {
    assert.ok(["DEFESA", "OPORTUNIDADE"].includes(s.tipo));
    assert.ok(!catsComCampanha.has(s.categoria), `slot em categoria que já tem campanha: ${s.categoria}`);
    assert.ok(s.motivo && s.acao && s.evidencia);
  }
});

test("calendarioMarketing: ciclo fechado — uma entrada por campanha, com recomendação e link de montagem", { skip: SKIP }, () => {
  const c = calendarioMarketing(LOJA, { dias: 28 });
  const camps = LOJAS_CFG[LOJA].campanhas || [];
  assert.equal(c.ciclo_fechado.length, camps.length);
  for (const cf of c.ciclo_fechado) {
    assert.ok(typeof cf.recomendacao_proxima === "string" && cf.recomendacao_proxima.length > 0);
    assert.match(cf.como_montar, /campaign-plan\?dias=/);
    assert.ok(cf.padrao === null || typeof cf.padrao.n_ocorrencias === "number");
    assert.ok(Array.isArray(cf.produtos_em_fadiga));
    // se há produtos em fadiga, a recomendação fala em renovar/trocar
    if (cf.produtos_em_fadiga.length >= 2) assert.match(cf.recomendacao_proxima, /renovar|trocar|adiar/i);
  }
});
