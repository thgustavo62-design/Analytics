// Data Quality — o que está sujo nos dados de UMA loja, com R$ de impacto e como corrigir.
// Determinístico. Só leitura. Não julga o que não dá pra medir com os feeds atuais.

const db = require("../db");
const { categoriaCanonica } = require("../categorias");

const DIA = 86400000;
const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (iso) => (iso ? Math.round((Date.now() - new Date(iso + "T12:00:00").getTime()) / DIA) : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const PEN = { ALTO: 18, MEDIO: 9, BAIXO: 3 };

function dataQuality(loja) {
  const lid = db.lojaId(loja);
  const refDate = db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja" };
  const ini90 = new Date(new Date(refDate + "T12:00:00").getTime() - 89 * DIA).toISOString().slice(0, 10);
  const q1 = (s, ...a) => db.db.prepare(s).get(...a);
  const qa = (s, ...a) => db.db.prepare(s).all(...a);
  const problemas = [];
  const add = (p) => problemas.push(p);

  // receita 90d por produto (para dar peso de R$ aos problemas)
  const recPorProd = new Map();
  for (const r of qa(
    `SELECT pr.id, SUM(v.valor_liquido) rec FROM vendas_transacoes v
       JOIN periodos p ON p.id = v.periodo_id
       JOIN produtos pr ON pr.ean = v.barras
      WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ? AND v.barras IS NOT NULL
      GROUP BY pr.id`, lid, ini90, refDate)) recPorProd.set(r.id, r.rec || 0);

  // --- 1) custo cadastrado MAIOR que o preço de venda (erro de ERP) ---
  const custoAlto = qa(
    `SELECT pr.id, pr.descricao, c.custo, pn.preco
       FROM produtos pr
       JOIN (SELECT produto_id, custo FROM produto_custo WHERE loja_id = ? AND data_fim IS NULL) c ON c.produto_id = pr.id
       JOIN (SELECT produto_id, preco FROM produto_preco WHERE loja_id = ? AND tipo_preco = 'normal' AND data_fim IS NULL) pn ON pn.produto_id = pr.id
      WHERE c.custo > pn.preco AND pn.preco > 0`, lid, lid);
  if (custoAlto.length) {
    const receitaAfetada = custoAlto.reduce((s, x) => s + (recPorProd.get(x.id) || 0), 0);
    add({
      id: "custo_maior_que_preco", severidade: receitaAfetada >= 2000 ? "ALTO" : "MEDIO",
      titulo: "Custo cadastrado maior que o preço de venda",
      n: custoAlto.length,
      detalhe: `Distorce a margem e o lucro estimado. Receita 90d nesses itens: R$ ${r2(receitaAfetada)}.`,
      exemplos: custoAlto.sort((a, b) => (recPorProd.get(b.id) || 0) - (recPorProd.get(a.id) || 0)).slice(0, 6)
        .map((x) => ({ produto: x.descricao, custo: r2(x.custo), preco: r2(x.preco) })),
      como_corrigir: "Corrija na planilha de custo/estoque (coluna 'Últ. Prc. Entrada') — provável troca de coluna ou unidade no export do ERP.",
    });
  }

  // --- 2) categoria ainda no 'chute' (palavra-chave), sem grupo do ERP nem correção manual ---
  const catChute = q1(
    `SELECT COUNT(*) n FROM produtos
      WHERE (categoria_fonte IS NULL OR categoria_fonte = 'vendas')
        AND categoria_manual IS NULL AND categoria = 'Medicamento'`).n;
  const totalProd = q1("SELECT COUNT(*) n FROM produtos").n;
  if (catChute > 0) {
    const pct = totalProd ? Math.round((catChute / totalProd) * 100) : 0;
    add({
      id: "categoria_sem_erp", severidade: pct >= 40 ? "MEDIO" : "BAIXO",
      titulo: "Produtos sem categoria real (só palavra-chave)",
      n: catChute,
      detalhe: `${pct}% do catálogo. Playbooks e cruzamentos por categoria ficam grosseiros nesses itens.`,
      exemplos: [],
      como_corrigir: "Suba a planilha de estoque que tem a coluna 'Nome Grupo' (a da Farma e Farma já tem). Produtos com o mesmo EAN nas duas lojas herdam o grupo automaticamente.",
    });
  }

  // --- 3) produto que vende sem custo EM NENHUMA loja (nem próprio, nem proxy) ---
  const semCusto = q1(
    `SELECT COUNT(DISTINCT pr.id) n, COALESCE(SUM(x.rec),0) rec FROM (
        SELECT pr.id id, SUM(v.valor_liquido) rec FROM vendas_transacoes v
          JOIN periodos p ON p.id = v.periodo_id JOIN produtos pr ON pr.ean = v.barras
         WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ? GROUP BY pr.id
      ) x JOIN produtos pr ON pr.id = x.id
      LEFT JOIN produto_custo c ON c.produto_id = pr.id AND c.custo > 0 AND c.data_fim IS NULL
      WHERE c.produto_id IS NULL`, lid, ini90, refDate);
  // dos que a LOJA não tem custo próprio, quantos são cobertos pelo proxy da outra loja
  const proxyN = q1(
    `SELECT COUNT(DISTINCT pr.id) n FROM (
        SELECT pr.id id FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id JOIN produtos pr ON pr.ean = v.barras
         WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ? GROUP BY pr.id
      ) x JOIN produtos pr ON pr.id = x.id
      LEFT JOIN produto_custo cp ON cp.produto_id = pr.id AND cp.loja_id = ? AND cp.custo > 0 AND cp.data_fim IS NULL
      JOIN produto_custo co ON co.produto_id = pr.id AND co.loja_id <> ? AND co.custo > 0 AND co.data_fim IS NULL
      WHERE cp.produto_id IS NULL`, lid, ini90, refDate, lid, lid).n;
  if (semCusto.n > 0) {
    add({
      id: "vende_sem_custo", severidade: semCusto.rec >= 20000 ? "MEDIO" : "BAIXO",
      titulo: "Produtos que vendem sem custo em nenhuma loja",
      n: semCusto.n,
      detalhe: `Margem, lucro e ROI não saem para R$ ${r2(semCusto.rec)} de receita 90d — nem esta loja nem a outra têm o custo do EAN.`,
      exemplos: [],
      como_corrigir: "Inclua a coluna de custo ('Últ. Prc. Entrada' / 'Custo Médio') preenchida no export de estoque.",
    });
  }
  if (proxyN > 0) {
    add({
      id: "custo_proxy_outra_loja", severidade: "BAIXO",
      titulo: "Produtos usando o custo da outra loja como proxy",
      n: proxyN,
      detalhe: "A margem/lucro desses itens é aproximada (custo do mesmo EAN na outra loja). Some quando o export de custo desta loja vier preenchido.",
      exemplos: [],
      como_corrigir: "Traga o custo próprio desta loja no export de estoque; o proxy sai sozinho.",
    });
  }

  // --- 4) estoque disponível negativo ---
  const estNeg = qa(
    `SELECT pr.descricao, e.disponivel FROM produto_estoque e JOIN produtos pr ON pr.id = e.produto_id
      WHERE e.loja_id = ? AND e.disponivel < 0
        AND e.data_referencia = (SELECT MAX(data_referencia) FROM produto_estoque WHERE loja_id = ? AND produto_id = e.produto_id)`, lid, lid);
  if (estNeg.length) {
    add({
      id: "estoque_negativo", severidade: "ALTO",
      titulo: "Estoque disponível negativo",
      n: estNeg.length,
      detalhe: "Days-of-cover e ruptura ficam errados nesses itens.",
      exemplos: estNeg.slice(0, 6).map((x) => ({ produto: x.descricao, disponivel: x.disponivel })),
      como_corrigir: "Acerto de inventário no ERP; enquanto isso o Analytics trata como 0.",
    });
  }

  // --- 5) promoções da tabela que não casaram com o catálogo ---
  let promoNaoCasada = 0, promoSemDesc = 0;
  try {
    promoNaoCasada = q1("SELECT COUNT(*) n FROM promocoes_planejadas WHERE produto_id IS NULL AND (loja_id = ? OR loja_id IS NULL)", lid).n;
    promoSemDesc = q1("SELECT COUNT(*) n FROM promocoes_planejadas WHERE preco_normal > 0 AND preco_promo >= preco_normal AND (loja_id = ? OR loja_id IS NULL)", lid).n;
  } catch (e) {}
  if (promoNaoCasada > 0) add({
    id: "promocao_nao_casada", severidade: "MEDIO",
    titulo: "Promoções que não casaram com o catálogo",
    n: promoNaoCasada,
    detalhe: "O produto da tabela de promoções não foi achado por EAN nem por nome — a promoção não entra no Share of Promotions.",
    exemplos: [],
    como_corrigir: "Confira o EAN (ou padronize o nome) na planilha de promoções.",
  });
  if (promoSemDesc > 0) add({
    id: "promocao_sem_desconto", severidade: "BAIXO",
    titulo: "Linhas de promoção sem desconto (preço promo ≥ preço normal)",
    n: promoSemDesc, detalhe: "Provável erro de digitação na tabela.", exemplos: [],
    como_corrigir: "Revise as colunas 'Preço De' / 'Valor Aproximado' dessas linhas.",
  });

  // --- 6) vendas sem código de barras (não casam com o catálogo) ---
  const vSemEan = q1(
    `SELECT SUM(CASE WHEN barras IS NULL OR barras GLOB '0*' OR LENGTH(barras) < 8 THEN 1 ELSE 0 END) sem, COUNT(*) tot
       FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
      WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?`, lid, ini90, refDate);
  const pctSemEan = vSemEan.tot ? Math.round((vSemEan.sem / vSemEan.tot) * 100) : 0;
  if (pctSemEan >= 3) add({
    id: "vendas_sem_ean", severidade: pctSemEan >= 10 ? "MEDIO" : "BAIXO",
    titulo: "Linhas de venda sem código de barras",
    n: vSemEan.sem,
    detalhe: `${pctSemEan}% das linhas de venda (90d) não têm EAN — esses itens casam com o catálogo só pelo nome.`,
    exemplos: [], como_corrigir: "Depende do relatório do ERP; itens sem EAN (manipulados, taxa) são esperados.",
  });

  // --- 7) cliente não identificado (bloqueia ABC de cliente / concentração) ---
  const cliNulo = q1(
    `SELECT SUM(CASE WHEN cli_id IS NULL OR cli_id = '' OR cli_id GLOB '0*' THEN 1 ELSE 0 END) sem, COUNT(*) tot
       FROM vendas_transacoes v JOIN periodos p ON p.id = v.periodo_id
      WHERE p.loja_id = ? AND v.data >= ? AND v.data <= ?`, lid, ini90, refDate);
  const pctCli = cliNulo.tot ? Math.round((cliNulo.sem / cliNulo.tot) * 100) : 100;
  if (pctCli >= 60) add({
    id: "cliente_nao_identificado", severidade: "BAIXO",
    titulo: "Vendas sem identificação de cliente",
    n: cliNulo.sem,
    detalhe: `${pctCli}% das linhas sem cli_id — a curva ABC de cliente e a análise de concentração/recompra ficam indisponíveis.`,
    exemplos: [], como_corrigir: "Se o ERP registra o cliente/CPF, incluir a coluna no relatório de vendas.",
  });

  // --- 8) freshness dos feeds ---
  const fr = db.freshnessCatalogo(loja);
  let frPromo = { ultima: null };
  try { const f = db.freshnessPromocoes(loja); frPromo = { ultima: f.ultima ? String(f.ultima).slice(0, 10) : null }; } catch (e) {}
  const concUlt = q1(
    `SELECT MAX(COALESCE(data_coleta, '')) d FROM concorrencia_ofertas o JOIN periodos p ON p.id = o.periodo_id WHERE p.loja_id = ?`, lid).d || null;
  const freshness = {
    vendas: { ultima: refDate, dias: diasAtras(refDate) },
    estoque: { ultima: fr.estoque.ultima, dias: diasAtras(fr.estoque.ultima) },
    custo: { ultima: fr.custo.ultima, dias: diasAtras(fr.custo.ultima) },
    preco: { ultima: fr.preco.ultima, dias: diasAtras(fr.preco.ultima) },
    concorrencia: { ultima: concUlt || null, dias: diasAtras(concUlt) },
    promocoes: { ultima: frPromo.ultima || null, dias: diasAtras(frPromo.ultima) },
  };
  const stale = Object.entries(freshness).filter(([k, v]) => k !== "vendas" && v.dias != null && v.dias > 20).map(([k]) => k);
  const semFeed = Object.entries(freshness).filter(([k, v]) => v.ultima == null).map(([k]) => k);
  if (stale.length) add({
    id: "feed_desatualizado", severidade: "MEDIO",
    titulo: "Feeds desatualizados (> 20 dias)", n: stale.length,
    detalhe: stale.map((k) => `${k} (${freshness[k].dias}d)`).join(", "),
    exemplos: [], como_corrigir: "Suba a planilha correspondente na inbox.",
  });
  if (semFeed.length) add({
    id: "feed_ausente", severidade: "MEDIO",
    titulo: "Feeds nunca recebidos", n: semFeed.length,
    detalhe: semFeed.join(", "),
    exemplos: [], como_corrigir: "Envie ao menos uma vez (planilha de estoque, coleta de concorrente, tabela de promoções).",
  });

  // --- score ---
  const porSeveridade = { ALTO: 0, MEDIO: 0, BAIXO: 0 };
  let pen = 0;
  for (const p of problemas) { porSeveridade[p.severidade]++; pen += PEN[p.severidade] || 0; }
  const score = Math.max(0, Math.min(100, 100 - pen));
  problemas.sort((a, b) => (PEN[b.severidade] - PEN[a.severidade]) || b.n - a.n);

  return {
    loja, refDate,
    score,
    veredito: score >= 85 ? "dados saudáveis" : score >= 60 ? "dá para confiar, com ressalvas" : "precisa de faxina",
    por_severidade: porSeveridade,
    catalogo: { produtos: totalProd, sem_categoria_real: catChute },
    freshness,
    problemas,
    aviso: "Só aponta o que dá para medir com os feeds atuais. Corrigir na origem (ERP/planilha) melhora todas as telas de uma vez.",
  };
}

module.exports = { dataQuality };
