// Curva ABC por receita — separa os produtos (e categorias, e clientes) que concentram o
// faturamento da cauda longa. As listas de marketing usam isso para mostrar só A+B por padrão.
//
//   classificarProdutosABC(produtos)  -> marca cada produto com .abc ("A"|"B"|"C") in-place
//   curvaABC(loja, opts)              -> resumo: produtos / categorias / clientes
//
// Determinístico. Base = receita 90d (o que analisarProdutos já calcula).

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { categoriaCanonica } = require("../categorias");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "abc.json"), "utf8"));
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// walk cumulativo: [{chave, receita}] ordenado desc -> Map(chave -> "A"|"B"|"C") + resumo
function _abcSobre(itens) {
  const ord = [...itens].filter((x) => x.receita > 0).sort((a, b) => b.receita - a.receita);
  const total = ord.reduce((s, x) => s + x.receita, 0);
  const classe = new Map();
  const resumo = { A: { n: 0, receita: 0 }, B: { n: 0, receita: 0 }, C: { n: 0, receita: 0 } };
  let acc = 0;
  for (const x of ord) {
    const antes = total > 0 ? acc / total : 1;
    const cl = antes < CFG.corte_a ? "A" : antes < CFG.corte_b ? "B" : "C";
    classe.set(x.chave, cl);
    resumo[cl].n++; resumo[cl].receita += x.receita;
    acc += x.receita;
  }
  // itens com receita 0 -> C
  for (const x of itens) if (!(x.receita > 0)) { classe.set(x.chave, "C"); resumo.C.n++; }
  for (const k of ["A", "B", "C"]) {
    resumo[k].receita = r2(resumo[k].receita);
    resumo[k].pct_receita = total > 0 ? r2((resumo[k].receita / total) * 100) : 0;
  }
  resumo.total_itens = itens.length;
  resumo.total_receita = r2(total);
  return { classe, resumo };
}

// marca cada produto com .abc (in-place) e devolve o resumo
function classificarProdutosABC(produtos) {
  const itens = produtos.map((p) => ({ chave: p.ean || p.descricao, receita: (p.receita && p.receita.d90) || 0 }));
  const { classe, resumo } = _abcSobre(itens);
  for (const p of produtos) p.abc = classe.get(p.ean || p.descricao) || "C";
  return resumo;
}

// concentração de cliente (a partir de cli_id nas vendas da janela) — top N + curva
function _abcClientes(loja, refDate, janelaDias) {
  const lid = db.lojaId(loja);
  const ini = new Date(new Date(refDate + "T12:00:00").getTime() - (janelaDias - 1) * 86400000).toISOString().slice(0, 10);
  let rows = [];
  try {
    rows = db.db.prepare(
      `SELECT v.cli_id AS cli, SUM(v.valor_liquido) AS receita, COUNT(DISTINCT v.data || '#' || v.lancamento) AS cupons
         FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
        WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?
          AND v.cli_id IS NOT NULL AND v.cli_id <> '' AND v.cli_id NOT GLOB '0*'
        GROUP BY v.cli_id`
    ).all(lid, ini, refDate);
  } catch (e) { rows = []; }
  if (!rows.length) return { disponivel: false, nota: "sem identificação de cliente nas vendas (cli_id vazio/zero)" };
  const itens = rows.map((r) => ({ chave: r.cli, receita: r.receita }));
  const { resumo } = _abcSobre(itens);
  const total = resumo.total_receita || 0;
  const top = [...rows].sort((a, b) => b.receita - a.receita).slice(0, 8)
    .map((r) => ({ cliente: r.cli, receita: r2(r.receita), cupons: r.cupons, pct: total > 0 ? r2((r.receita / total) * 100) : 0 }));
  return {
    disponivel: true,
    clientes_identificados: rows.length,
    receita_identificada: total,
    pct_top8: top.reduce((s, x) => s + x.pct, 0),
    classe_A: resumo.A, classe_B: resumo.B, classe_C: resumo.C,
    top_clientes: top,
  };
}

function curvaABC(loja, opts = {}) {
  const janelaDias = +opts.janelaDias || CFG.janela_dias;
  const a = mpa.analisarProdutos(loja, opts);
  if (a.erro) return a;

  const resumoProd = classificarProdutosABC(a.produtos);

  // ABC de categoria (receita 90d agregada por categoria canônica)
  const porCat = new Map();
  for (const p of a.produtos) {
    const c = categoriaCanonica(p.categoria) || "(sem categoria)";
    porCat.set(c, (porCat.get(c) || 0) + ((p.receita && p.receita.d90) || 0));
  }
  const itensCat = [...porCat.entries()].map(([chave, receita]) => ({ chave, receita }));
  const { classe: classeCat } = _abcSobre(itensCat);
  const totalCat = itensCat.reduce((s, x) => s + x.receita, 0);
  const categorias = itensCat
    .map((x) => ({ categoria: x.chave, receita_90d: r2(x.receita), pct: totalCat > 0 ? r2((x.receita / totalCat) * 100) : 0, abc: classeCat.get(x.chave) }))
    .sort((a, b) => b.receita_90d - a.receita_90d);

  return {
    loja,
    refDate: a.refDate,
    janela_dias: janelaDias,
    cortes: { a: CFG.corte_a, b: CFG.corte_b },
    produtos: resumoProd,
    categorias,
    clientes: _abcClientes(loja, a.refDate, janelaDias),
    aviso: "A = concentra a receita (foco de campanha e ruptura); C = cauda longa (não vale slot de campanha, mas conta para peso morto/liquidação).",
  };
}

module.exports = { curvaABC, classificarProdutosABC };
