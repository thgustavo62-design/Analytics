// Fase D — Memória de marketing: padrões por campanha, playbooks por categoria e fadiga de produto.
// Integração com o PDF real de agosto (o histórico do banco temporário pode ter só 1 mês →
// alguns padrões saem "sem base", o que também é testado).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-pd-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas } = require("../ingest");
const { padroesMarketing, playbooks, fadigaProdutos } = require("../marketing/padroes-mkt");
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

test("padroesMarketing: uma entrada por campanha do calendário, com leituras relativas", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const p = padroesMarketing(LOJA);
  assert.ok(!p.erro, p.erro);
  assert.equal(p.por_campanha.length, (LOJAS_CFG[LOJA].campanhas || []).length);
  for (const pc of p.por_campanha) {
    assert.ok(Array.isArray(pc.por_dia_semana));
    // por_dia_semana ordenado por lift desc
    for (let i = 1; i < pc.por_dia_semana.length; i++) {
      assert.ok(pc.por_dia_semana[i].lift_medio <= pc.por_dia_semana[i - 1].lift_medio + 1e-9, "por_dia_semana fora de ordem");
    }
    assert.ok(["sem base", "estável", "melhorando", "piorando (possível fadiga)"].includes(pc.tendencia));
    if (pc.suficiente) {
      assert.ok(pc.melhor_dia && pc.melhor_dia.dia_nome, "campanha com amostra mas sem melhor_dia");
      assert.ok(typeof pc.lift_medio === "number");
    } else {
      assert.ok(pc.nota, "campanha sem amostra deveria ter nota");
    }
    // ocorrências: lift ≈ receita_dia_campanha / receita_dia_base
    for (const o of pc.ocorrencias.slice(0, 5)) {
      assert.ok(Math.abs(o.lift - o.receita_dia_campanha / o.receita_dia_base) < 0.02, "lift da ocorrência não bate");
    }
  }
  assert.ok(/relativas|indicativo/i.test(p.aviso));
});

test("playbooks: manual por categoria com veredito pela tendência", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = playbooks(LOJA);
  assert.ok(!r.erro, r.erro);
  assert.ok(r.playbooks.length > 0);
  for (const pb of r.playbooks) {
    assert.ok(typeof pb.veredito === "string" && pb.veredito.length > 0);
    assert.ok(Array.isArray(pb.produtos_recomendados));
    assert.ok(Array.isArray(pb.dias_configurados) && pb.dias_configurados.length === pb.duracao_dias);
    // veredito coerente com a tendência
    if (pb.tendencia === "piorando (possível fadiga)") assert.match(pb.veredito, /perdendo força|renovar/i);
    if (pb.tendencia === "melhorando") assert.match(pb.veredito, /ganhando força|reforçar/i);
  }
  assert.ok(r.fadiga && Array.isArray(r.fadiga.produtos));
  assert.ok(Array.isArray(r.padroes));
});

test("fadigaProdutos: só produtos de categoria de campanha, ainda vendendo, com queda real", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const f = fadigaProdutos(LOJA);
  assert.ok(!f.erro, f.erro);
  const catsCamp = new Set((LOJAS_CFG[LOJA].campanhas || []).flatMap((c) => c.categorias || []));
  for (const p of f.produtos) {
    assert.ok(catsCamp.has(p.categoria), `fadiga fora de categoria de campanha: ${p.categoria}`);
    assert.ok(p.lift_atual > 0, "fadiga não deve incluir queda a zero (isso é ruptura/saída de linha)");
    assert.ok(p.lift_atual < p.lift_inicial * 0.6 + 1e-9, "queda insuficiente para fadiga");
    assert.ok(p.unidades_dias_campanha >= 20, "volume abaixo do mínimo");
    assert.ok(p.queda_pct > 0);
  }
  assert.ok(f.produtos.length <= 20, "payload de fadiga não foi limitado");
});
