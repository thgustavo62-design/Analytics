// Fase 5 — monta, de forma 100% determinística, o "pacote de contexto" de uma loja que os
// detectores consomem. Reúne o que as fases 2/3/4 já calculam + concorrência + histórico de
// faturamento por mês. Nenhuma chamada de IA.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const basket = require("../basket");
const campanhas = require("../campanhas");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
const DIA = 86400000;
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);

function historicoFaturamento(loja) {
  // faturamento por período (mês) já existente, do mais recente para o mais antigo
  return db
    .listPeriodos(loja)
    .filter((p) => p.temVendas)
    .map((p) => {
      const per = db.findPeriodo(loja, p.ano, p.mes);
      return { periodo: p.periodo, ano: p.ano, mes: p.mes, faturamento: per ? db.getFaturamento(per.id) : 0, parcial: !!(per && per.vendas_ultimo_dia_parcial) };
    });
}

function concorrenciaContexto(loja) {
  // usa a coleta do período mais recente que tenha concorrência
  const ps = db.listPeriodos(loja).filter((p) => p.temVendas);
  for (const p of ps) {
    const per = db.findPeriodo(loja, p.ano, p.mes);
    if (!per) continue;
    const conc = db.getConcorrencia(per.id);
    if (conc.length) {
      const porCategoria = new Map();
      for (const o of conc) {
        if (!o.categoria) continue;
        const e = porCategoria.get(o.categoria) || { ofertas: 0, abaixo: 0, exemplos: [] };
        e.ofertas++;
        if (o.abaixo_do_nosso) {
          e.abaixo++;
          if (e.exemplos.length < 4) e.exemplos.push({ produto: o.produto, concorrente: o.concorrente, promo: o.preco_promo, nosso: o.nosso_preco_medio });
        }
        porCategoria.set(o.categoria, e);
      }
      return { periodo: p.periodo, totalOfertas: conc.length, porCategoria };
    }
  }
  return { periodo: null, totalOfertas: 0, porCategoria: new Map() };
}

function instagramContexto(loja) {
  const ps = db.listPeriodos(loja).filter((p) => p.temVendas).slice(0, 3);
  const linhas = [];
  for (const p of ps) {
    const per = db.findPeriodo(loja, p.ano, p.mes);
    if (!per) continue;
    for (const m of db.getInstagram(per.id)) linhas.push({ periodo: p.periodo, metrica: m.metrica, rotulo: m.rotulo, delta_pct: m.delta_pct });
  }
  return linhas;
}

function montarContexto(loja, opts = {}) {
  let refDate = opts.refDate || db.getUltimaDataVenda(loja);
  // se o último dia com venda é parcial (relatório extraído no meio do dia), recua 1 dia —
  // assim as janelas de tendência não comparam um dia truncado contra dias cheios.
  if (refDate && !opts.refDate) {
    const ps = db.listPeriodos(loja).filter((p) => p.temVendas);
    for (const p of ps) {
      const per = db.findPeriodo(loja, p.ano, p.mes);
      if (per && per.vendas_ultimo_dia === refDate && per.vendas_ultimo_dia_parcial) {
        refDate = new Date(new Date(refDate + "T12:00:00").getTime() - DIA).toISOString().slice(0, 10);
      }
      break;
    }
  }
  const lojaCfg = LOJAS_CFG[loja] || {};
  const ctxConc = concorrenciaContexto(loja);
  const concorrenciaCategorias = new Set();
  for (const [cat, e] of ctxConc.porCategoria) if (e.abaixo >= 1) concorrenciaCategorias.add(cat);

  const cestaCentralidade = (() => {
    try { return basket.centralidade(loja); } catch { return null; }
  })();

  const analiseProdutos = refDate
    ? mpa.analisarProdutos(loja, { refDate, concorrenciaCategorias, cestaCentralidade })
    : { erro: "sem vendas", produtos: [], feeds: { estoque: false, custo: false, preco: false } };

  const eficienciaCampanhas = (() => {
    try { return campanhas.eficienciaTodasDoCalendario(loja, { refDate }); } catch { return []; }
  })();

  const cesta = (() => {
    try { return db.getCestaPares(loja, { limite: 400 }); } catch { return { janela: null, pares: [] }; }
  })();

  // momentum por categoria: receita dos 14d recentes x 14d anteriores (ambas as janelas
  // cabem dentro de um mês típico de upload — não compara contra um mês vazio). O campo
  // `receita_30d` fica como volume de referência dos últimos 30d.
  const categoriasTendencia = [];
  const PSEUDO = new Set(["diversos", "taxa de entrega"]);
  if (refDate) {
    const r30 = db.vendasCategoriaPorData(loja, addDias(refDate, -29), refDate);
    const rec14 = db.vendasCategoriaPorData(loja, addDias(refDate, -13), refDate);
    const prev14 = db.vendasCategoriaPorData(loja, addDias(refDate, -27), addDias(refDate, -14));
    const acc = new Map();
    const bump = (rows, campo) => {
      for (const r of rows) {
        const e = acc.get(r.categoria) || { r30: 0, rec14: 0, prev14: 0 };
        e[campo] += r.receita;
        acc.set(r.categoria, e);
      }
    };
    bump(r30, "r30"); bump(rec14, "rec14"); bump(prev14, "prev14");
    for (const [cat, e] of acc) {
      if (PSEUDO.has(String(cat).toLowerCase())) continue;
      // exige base mínima nas duas quinzenas p/ afirmar tendência
      const temBase = e.prev14 >= 150 && e.rec14 >= 60;
      const varPct = temBase ? ((e.rec14 - e.prev14) / e.prev14) * 100 : null;
      categoriasTendencia.push({
        categoria: cat,
        receita_30d: Math.round(e.r30),
        receita_14d: Math.round(e.rec14),
        receita_14d_anterior: Math.round(e.prev14),
        var_pct: varPct == null ? null : Math.round(Math.max(-300, Math.min(300, varPct)) * 10) / 10,
      });
    }
    categoriasTendencia.sort((a, b) => b.receita_30d - a.receita_30d);
  }

  return {
    loja,
    refDate,
    lojaCfg,
    feeds: analiseProdutos.feeds || { estoque: false, custo: false, preco: false },
    analiseProdutos,
    eficienciaCampanhas,
    cesta,
    concorrencia: ctxConc,
    concorrenciaCategorias,
    instagram: instagramContexto(loja),
    historicoFaturamento: historicoFaturamento(loja),
    categoriasTendencia,
  };
}

module.exports = { montarContexto, historicoFaturamento };
