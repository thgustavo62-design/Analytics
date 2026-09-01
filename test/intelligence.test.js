// Fases 5–12 — camada de inteligência. Banco temporário próprio. Ingere o PDF real de
// agosto e exercita: detectores (com dedupe/resolução), Priority Engine, War Room,
// investigação ("Por quê?"), decisão + resultado + padrão, ontologia 2.0, Ask e Editorial.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-intel-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { ingestVendas } = require("../ingest");
const intel = require("../intelligence");
const investigar = require("../intelligence/investigar");
const padroes = require("../intelligence/padroes");
const ontologia2 = require("../intelligence/ontologia2");
const ask = require("../ask");
const editorial = require("../editorial");
const { prioridade } = require("../intelligence/priorizacao");

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

let LOJA = null;
test("setup: ingere o PDF (a ingestão já roda a detecção)", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ingestVendas(FIX);
  LOJA = r.loja;
  assert.ok(r.inteligencia && r.inteligencia.sinais > 0, "detecção não rodou na ingestão");
});

test("Priority Engine: 0..100 e monotônico na severidade", () => {
  const base = { tipo: "CATEGORY_DECLINE", severidade: 0.3, confianca: 0.6, impacto_estimado: 1000 };
  const p1 = prioridade(base, {});
  const p2 = prioridade({ ...base, severidade: 0.9 }, {});
  assert.ok(p1 >= 0 && p1 <= 100 && p2 >= 0 && p2 <= 100);
  assert.ok(p2 > p1, "mais severidade deveria dar mais prioridade");
});

test("detectores: dedupe (2ª rodada não cria nada) e evidência em todo sinal", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r1 = intel.rodarDeteccao(LOJA);
  const r2 = intel.rodarDeteccao(LOJA);
  assert.equal(r2.novos, 0, "2ª rodada criou sinais novos (dedupe falhou)");
  assert.equal(r2.total, r1.total);
  const sinais = db.listSinais(LOJA, { limite: 200 });
  assert.ok(sinais.length > 0);
  for (const s of sinais) {
    assert.ok(s.codigo && /^(SIG|THR|OPP|CON)-\d{6}$/.test(s.codigo));
    assert.ok(s.prioridade >= 0 && s.prioridade <= 100);
    const full = db.getSinal(s.id);
    assert.ok(Array.isArray(full.evidencias) && full.evidencias.length >= 1, `${s.codigo} sem evidência`);
    for (const e of full.evidencias) assert.ok(e.campo && e.fonte, "evidência sem campo/fonte");
  }
});

test("detectores: sem feed de custo/estoque não inventam sinal — reportam indisponível", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = intel.rodarDeteccao(LOJA, { persistir: false });
  assert.ok(r.indisponivel.some((x) => /custo/.test(x)));
  assert.ok(r.indisponivel.some((x) => /estoque/.test(x)));
  // nenhum sinal de MARGIN e nenhum STOCK_RISK real (sem feed)
  assert.ok(!r.sinais.some((s) => s.tipo === "STOCK_RISK"));
});

test("resolução: sinal que some numa rodada seguinte é marcado resolvido", { skip: FIX ? false : "fixture não encontrada" }, () => {
  // injeta um sinal órfão de um tipo que os detectores rodam
  db.upsertSinal(LOJA, { classe: "AMEACA", tipo: "CATEGORY_DECLINE", titulo: "fake", severidade: 0.5, confianca: 0.5, dedupe_key: "category_decline|zzz-inexistente", evidencias: [{ campo: "x", valor: 1, fonte: "teste" }] });
  const antes = db.listSinais(LOJA, { tipo: "CATEGORY_DECLINE", status: "aberto" }).length;
  intel.rodarDeteccao(LOJA);
  const fake = db.listSinais(LOJA, { tipo: "CATEGORY_DECLINE", limite: 200 }).find((s) => s.dedupe_key === "category_decline|zzz-inexistente");
  assert.equal(fake.status, "resolvido");
  assert.ok(antes >= 1);
});

test("War Room: forma esperada", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const w = intel.warRoom(LOJA);
  assert.ok("kpis" in w && "threat_map" in w && "opportunity_map" in w && "situacao_categorias" in w);
  assert.equal(w.kpis.faturamento_mes, 196566.57);
  assert.ok(Array.isArray(w.situacao_categorias) && w.situacao_categorias.length);
  if (w.prioridade_1) assert.ok(w.prioridade_1.codigo && w.prioridade_1.prioridade >= 0);
});

test("investigação: hipóteses com veredito + evidência; investigarEGravar persiste", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const alvo = db.listSinais(LOJA, { classe: "AMEACA", limite: 1 })[0] || db.listSinais(LOJA, { limite: 1 })[0];
  const r = investigar.investigar(LOJA, { sinalId: alvo.id });
  assert.ok(r.hipoteses.length >= 1);
  for (const h of r.hipoteses) assert.ok(["suportada", "refutada", "inconclusiva"].includes(h.veredito));
  assert.ok(typeof r.conclusao === "string" && r.conclusao.length);

  const gravada = investigar.investigarEGravar(LOJA, { sinalId: alvo.id });
  assert.ok(/^INV-\d{6}$/.test(gravada.codigo));
  const lidaDoBanco = db.getInvestigacao(Number(gravada.id));
  assert.equal(lidaDoBanco.status, "concluida");
  assert.ok(lidaDoBanco.hipoteses.length === r.hipoteses.length);
});

test("investigação por pergunta livre roteia por categoria", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = investigar.investigar(LOJA, { pergunta: "por que fraldas caiu no mês?" });
  assert.equal(r.assunto.tipo, "categoria");
  assert.ok(/fralda/i.test(r.assunto.ref));
});

test("decisão → resultado → padrão aprende; semelhantes casa por tipo de sinal", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const sigs = db.listSinais(LOJA, { limite: 2 });
  const tipos = sigs.map((s) => s.tipo);
  const decId = db.criarDecisao(LOJA, { titulo: "Ação de teste", tipo: "CAMPANHA", sinais: sigs.map((s) => s.id), acoes: [{ texto: "fazer X" }] });
  const d = db.getDecisao(decId);
  assert.ok(/^DEC-\d{6}$/.test(d.codigo));
  assert.equal(d.acoes.length, 1);
  db.addResultado(decId, { metrica: "itens_por_cupom", antes: 2, depois: 2.3, veredito: "POSITIVO" });
  const pat = padroes.aprenderComDecisao(decId);
  assert.ok(pat && pat.amostra_n === 1 && pat.taxa_sucesso === 1);
  const sem = padroes.semelhantes(LOJA, { sinalTipos: tipos });
  assert.ok(Array.isArray(sem.decisoes) && sem.decisoes.length >= 1);
});

test("ontologia 2.0: sincroniza e persiste nós/arestas", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const per = db.findPeriodo(LOJA, 2026, 8);
  const lojasCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
  const r = ontologia2.sincronizarOntologia(LOJA, "2026-08", { vendasRows: db.getVendas(per.id), concRows: db.getConcorrencia(per.id), lojaCfg: lojasCfg[LOJA] });
  assert.ok(r.persistida.nodes > r.base.nodes, "enriquecimento não adicionou nós");
  const g = db.getOntologiaPersistida(LOJA);
  assert.ok(g.nodes.some((n) => n.tipo === "produto"));
  assert.ok(g.edges.length > 0);
  // idempotente: rodar de novo não multiplica
  const n1 = db.getOntologiaPersistida(LOJA).nodes.length;
  ontologia2.sincronizarOntologia(LOJA, "2026-08", { vendasRows: db.getVendas(per.id), concRows: db.getConcorrencia(per.id), lojaCfg: lojasCfg[LOJA] });
  assert.equal(db.getOntologiaPersistida(LOJA).nodes.length, n1);
});

test("Ask Analytics: resposta no formato analista, sem inventar (determinístico)", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ask.perguntar(LOJA, { pergunta: "o que eu anuncio essa semana?" });
  assert.equal(r.fonte, "deterministico");
  assert.ok(r.conclusao && Array.isArray(r.evidencias));
  assert.ok(r.confianca >= 0 && r.confianca <= 1);
  const why = await ask.perguntar(LOJA, { pergunta: "por que fraldas caiu?" });
  assert.ok(why.hipoteses.length >= 1);
});

test("Editorial: pauta de 7 dias, produto vindo do motor, com evidência", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const p = editorial.planoSemanal(LOJA);
  assert.equal(p.dias.length, 7);
  for (const d of p.dias) {
    assert.ok(d.data && d.dia_semana && d.tema);
    for (const pr of d.produtos) {
      assert.ok(pr.descricao && pr.angulo && pr.cta_sugestao);
      assert.ok(pr.evidencia && pr.evidencia.campo === "opportunity.score");
    }
  }
  // dias de campanha do calendário respeitam a categoria
  const quarta = p.dias.find((d) => d.dia_semana === "quarta");
  if (quarta && quarta.campanha) assert.ok(quarta.categorias.length);
});
