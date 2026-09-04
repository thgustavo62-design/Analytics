// Kanban de marketing: CRUD, colunas, carimbo de entrega e sugestões amarradas ao
// playbook de multinacionais (só sugere quando o gatilho existe nos dados).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-kb-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const kanban = require("../marketing/kanban");
const { ingestVendas } = require("../ingest");

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

const LOJA = "Minas Farma";

test("playbook: toda jogada tem empresa, gatilho e como adaptar", () => {
  assert.ok(kanban.JOGADAS.length >= 10, "playbook curto demais");
  const gatilhosOk = new Set(["sempre", "categoria_sob_ataque", "estoque_parado", "cesta_lift_alto",
    "produto_recorrente", "subcomunicando", "margem_alta_sem_giro", "ruptura", "campanha_em_fadiga", "ticket_baixo"]);
  const ids = new Set();
  for (const j of kanban.JOGADAS) {
    assert.ok(j.id && !ids.has(j.id), `id duplicado/ausente: ${j.id}`);
    ids.add(j.id);
    for (const k of ["empresa", "jogada", "o_que_e", "por_que_funciona", "como_adaptar", "gatilho"]) {
      assert.ok(j[k], `jogada ${j.id} sem ${k}`);
    }
    assert.ok(gatilhosOk.has(j.gatilho), `gatilho desconhecido em ${j.id}: ${j.gatilho}`);
    assert.ok(["baixo", "medio", "alto"].includes(j.esforco), `esforço inválido em ${j.id}`);
    assert.ok(["baixo", "medio", "alto"].includes(j.impacto), `impacto inválido em ${j.id}`);
  }
});

test("quadro começa vazio, com as 4 colunas na ordem", () => {
  const q = kanban.quadro(LOJA);
  assert.ok(!q.erro, q.erro);
  assert.deepEqual(q.colunas.map((c) => c.id), ["ideia", "fazer", "fazendo", "feito"]);
  assert.deepEqual(q.totais, { ideia: 0, fazer: 0, fazendo: 0, feito: 0 });
});

test("criar exige título e cai em 'ideia' por padrão", () => {
  assert.ok(kanban.criar(LOJA, {}).erro);
  assert.ok(kanban.criar(LOJA, { titulo: "   " }).erro);
  const r = kanban.criar(LOJA, { titulo: "Kit fralda + lenço" });
  assert.ok(r.ok && r.id);
  const q = kanban.quadro(LOJA);
  assert.equal(q.totais.ideia, 1);
  assert.equal(q.colunas[0].tarefas[0].titulo, "Kit fralda + lenço");
});

test("mover para 'feito' carimba entregue_em; voltar limpa", () => {
  const { id } = kanban.criar(LOJA, { titulo: "Post único do herói", coluna: "fazendo", playbook: "apple-um-heroi" });
  let t = kanban.quadro(LOJA).colunas.find((c) => c.id === "fazendo").tarefas.find((x) => x.id === id);
  assert.equal(t.entregue_em, null);
  assert.equal(t.jogada.empresa, "Apple"); // enriquecido com a jogada

  kanban.atualizar(id, { coluna: "feito", resultado: "alcance +18%" });
  t = kanban.quadro(LOJA).colunas.find((c) => c.id === "feito").tarefas.find((x) => x.id === id);
  assert.ok(t.entregue_em, "não carimbou a entrega");
  assert.equal(t.resultado, "alcance +18%");
  assert.equal(kanban.quadro(LOJA).entregues_30d, 1);

  kanban.atualizar(id, { coluna: "fazendo" });
  t = kanban.quadro(LOJA).colunas.find((c) => c.id === "fazendo").tarefas.find((x) => x.id === id);
  assert.equal(t.entregue_em, null, "voltar de 'feito' deveria limpar a data");
});

test("atualizar ignora coluna inválida e campo não permitido", () => {
  const { id } = kanban.criar(LOJA, { titulo: "X" });
  assert.ok(kanban.atualizar(id, { coluna: "inventada" }).erro); // nada válido para atualizar
  kanban.atualizar(id, { titulo: "Y", entregue_em: "2020-01-01" });
  const t = kanban.quadro(LOJA).colunas.flatMap((c) => c.tarefas).find((x) => x.id === id);
  assert.equal(t.titulo, "Y");
  assert.equal(t.entregue_em, null, "entregue_em não pode ser setado direto");
});

test("remover apaga; id inexistente devolve erro", () => {
  const { id } = kanban.criar(LOJA, { titulo: "Some" });
  assert.ok(kanban.remover(id).ok);
  assert.ok(kanban.remover(999999).erro);
});

test("quadro/sugestoes recusam loja inválida", () => {
  assert.ok(kanban.quadro("Loja X").erro);
  assert.ok(kanban.sugestoes("Loja X").erro);
});

const PDF = [
  process.env.VENDAS_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\vendas\\vendas agosto minas farma.pdf",
  "C:\\Sistema Marketing\\inbox\\vendas\\vendas agosto farma e farma.pdf",
].find((p) => p && fs.existsSync(p));
const SKIP = PDF ? false : "fixture de vendas não encontrada";

let LOJA_PDF = null;
test("setup: ingere o PDF", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA_PDF = r.loja;
});

test("sugestoes: só saem com gatilho, trazem a jogada e a evidência dos dados", { skip: SKIP }, () => {
  const s = kanban.sugestoes(LOJA_PDF);
  assert.ok(!s.erro, s.erro);
  assert.ok(Array.isArray(s.sugestoes) && s.sugestoes.length >= 1);
  const idsPlaybook = new Set(kanban.JOGADAS.map((j) => j.id));
  for (const x of s.sugestoes) {
    assert.ok(idsPlaybook.has(x.playbook), `sugestão fora do playbook: ${x.playbook}`);
    assert.ok(x.empresa && x.jogada && x.por_que_funciona && x.descricao);
    assert.equal(typeof x.ja_no_quadro, "boolean");
  }
  // as com evidência concreta vêm antes das genéricas
  const comEvid = s.sugestoes.filter((x) => x.evidencia).length;
  for (let i = 0; i < comEvid; i++) assert.ok(s.sugestoes[i].evidencia, "sugestão sem evidência furou a ordem");
  assert.ok(s.contexto && typeof s.contexto.rupturas === "number");
});

test("sugestoes: o que já está no quadro vem marcado", { skip: SKIP }, () => {
  const antes = kanban.sugestoes(LOJA_PDF).sugestoes[0];
  kanban.criar(LOJA_PDF, { titulo: antes.jogada, playbook: antes.playbook, origem: "sugestao" });
  const depois = kanban.sugestoes(LOJA_PDF).sugestoes.find((x) => x.playbook === antes.playbook);
  assert.equal(depois.ja_no_quadro, true);
});
