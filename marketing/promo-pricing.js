// Precificação de promoção — "que preço colocar, quanto de lucro dá, qual produto promover".
//
//   precificarProduto(loja, {ean|produto_id|descricao, duracaoDias})
//     -> varre descontos de 0..teto, projeta unidades pela elasticidade da categoria,
//        e devolve: preço recomendado (maximiza LUCRO INCREMENTAL), 3 preços para testar,
//        a curva lucro×desconto, break-even e limite sem prejuízo.
//
//   oportunidadesPromo(loja, {n, duracaoDias})
//     -> ranqueia os produtos A/B pelo lucro incremental da melhor promoção de cada um.
//
// Determinístico. A elasticidade é PREMISSA de categoria (config/elasticidade.json) enquanto
// não há histórico de promoções — o aviso acompanha todo resultado. Custo pode ser proxy da
// outra loja (marcado). Nunca abaixo do piso de margem.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { categoriaCanonica } = require("../categorias");
const { normalizarEan } = require("../catalogo");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "elasticidade.json"), "utf8"));
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function elasticidadeDe(categoria) {
  const c = categoriaCanonica(categoria);
  const v = (CFG.por_categoria || {})[c];
  return { valor: v != null ? v : CFG.default, categoria: c, fonte: v != null ? "categoria (premissa, sem histórico ainda)" : "default (premissa)" };
}

// projeção de 1 ponto de desconto para 1 produto
function _ponto(p, d, dur) {
  const E = p._E, P = p._P, C = p._C, V = p._V;
  const preco = r2(P * (1 - d));
  // unidades/dia sob promoção: V * (1 - E*d), com E negativo -> sobe; cap no uplift_max
  const fator = clamp(1 - E * d, 0, CFG.uplift_max);
  const undDia = V * fator;
  const undPromo = undDia * dur;
  const undBase = V * dur;
  const receita = r2(undPromo * preco);
  const undInc = undPromo - undBase;
  const halo = (CFG.halo_r$_por_unidade || 0) * Math.max(0, undInc);
  let lucroPromo = null, lucroBase = null, lucroInc = null, lucroIncTotal = null, margemPct = null;
  if (C != null) {
    lucroPromo = undPromo * (preco - C);
    lucroBase = undBase * (P - C);
    lucroInc = r2(lucroPromo - lucroBase);
    lucroIncTotal = r2(lucroPromo - lucroBase + halo);
    margemPct = preco > 0 ? r2((preco - C) / preco) : null;
  }
  return {
    desconto_pct: r2(d * 100),
    preco,
    multiplicador_demanda: r2(fator),
    unidades: Math.round(undPromo),
    unidades_incrementais: Math.round(undInc),
    receita,
    lucro_incremental: lucroInc,
    efeito_cesta_estimado: r2(halo),
    lucro_incremental_mais_cesta: lucroIncTotal,
    lucro_total_promo: r2(lucroPromo),
    margem_pct: margemPct,
  };
}

function precificarProduto(loja, opts = {}) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  const dur = Math.max(1, +opts.duracaoDias || CFG.duracao_dias_padrao);

  const alvoEan = normalizarEan(opts.ean);
  const alvoDesc = opts.descricao ? String(opts.descricao).toLowerCase().trim() : null;
  const rec = (x) => (x.receita && (x.receita.d90 || x.receita.d30)) || 0;
  let p = analise.produtos.find((x) =>
    (opts.produto_id && x.produto_id === opts.produto_id) ||
    (alvoEan && x.ean === alvoEan) ||
    (alvoDesc && String(x.descricao).toLowerCase().trim() === alvoDesc)
  );
  if (!p && alvoDesc && alvoDesc.length >= 3) {
    // fallback: descrição parcial — pega a de maior receita entre as que contêm o texto
    const cand = analise.produtos
      .filter((x) => String(x.descricao).toLowerCase().includes(alvoDesc))
      .sort((a, b) => rec(b) - rec(a));
    if (cand.length) p = cand[0];
  }
  if (!p) return { erro: "produto não encontrado nas vendas da loja no período", ...(opts.ean ? { ean: alvoEan } : {}), ...(alvoDesc ? { busca: opts.descricao } : {}) };

  const P = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
  const C = p.custo_atual;
  const V = (p.venda_media_diaria && p.venda_media_diaria.d30) || 0;
  if (P == null) return { erro: "sem preço de referência para o produto", produto: p.descricao };
  const el = elasticidadeDe(p.categoria);
  p._E = el.valor; p._P = P; p._C = C; p._V = V;

  // limite: não vender abaixo do piso de margem (se há custo)
  const descMax = C != null && P > 0 ? clamp(1 - (C / (1 - CFG.piso_margem_pct)) / P, 0, CFG.desconto_teto) : CFG.desconto_teto;

  const curva = [];
  for (let d = 0; d <= CFG.desconto_teto + 1e-9; d += CFG.passo_desconto) {
    if (d > descMax + 1e-9) break;
    curva.push(_ponto(p, d, dur));
  }
  if (!curva.length) curva.push(_ponto(p, 0, dur));

  // recomendado = maior lucro incremental DO SKU (com custo); sem custo, maior receita incremental.
  // o halo/efeito-cesta é exibido, mas NÃO decide — assim nunca recomenda desconto que dá prejuízo no item.
  const chave = C != null ? (x) => x.lucro_incremental : (x) => x.unidades_incrementais * x.preco;
  let melhor = curva[0];
  for (const x of curva) if ((chave(x) ?? -Infinity) > (chave(melhor) ?? -Infinity)) melhor = x;

  // 3 preços para testar: em torno do recomendado
  const idx = curva.indexOf(melhor);
  const cons = curva[Math.max(0, idx - 2)];
  const agr = curva[Math.min(curva.length - 1, idx + 2)];
  const rot = (x, r) => ({ rotulo: r, ...x });
  const testar = [];
  if (cons !== melhor) testar.push(rot(cons, "conservador"));
  testar.push(rot(melhor, "recomendado"));
  if (agr !== melhor) testar.push(rot(agr, "agressivo"));

  // break-even (lucro incremental cruza 0) e limite sem prejuízo
  let breakEven = null;
  for (let i = 1; i < curva.length; i++) {
    if (curva[i].lucro_incremental != null && curva[i - 1].lucro_incremental != null &&
        curva[i - 1].lucro_incremental >= 0 && curva[i].lucro_incremental < 0) { breakEven = curva[i].desconto_pct; break; }
  }
  const descSemPrejuizo = C != null && P > 0 ? r2(clamp(1 - C / P, 0, 1) * 100) : null;

  // promoção já planejada para esse produto?
  let planejada = null;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const vig = db.promocoesVigentes(loja, hoje > analise.refDate ? hoje : analise.refDate);
    const pl = vig.find((x) => (p.ean && String(x.ean).replace(/\D/g, "") === p.ean) || String(x.descricao || "").toLowerCase().trim() === String(p.descricao).toLowerCase().trim());
    if (pl && pl.preco_promo) {
      const d = P > 0 ? 1 - pl.preco_promo / P : null;
      planejada = { preco: pl.preco_promo, desconto_pct: d != null ? r2(d * 100) : null, ...(d != null ? { projecao: _ponto(p, clamp(d, 0, CFG.desconto_teto), dur) } : {}) };
    }
  } catch (e) {}

  return {
    loja, refDate: analise.refDate,
    produto: p.descricao, ean: p.ean, categoria: categoriaCanonica(p.categoria), abc: p.abc, papel_ok: !p.do_not_promote,
    preco_normal: r2(P), custo: r2(C), custo_proxy: !!p.custo_proxy, custo_proxy_origem: p.custo_proxy_origem || null,
    venda_media_diaria_30d: r2(V), duracao_dias: dur,
    elasticidade: el,
    lift_historico_categoria: r2(mpa.liftCampanhaPorCategoria(loja, analise.refDate).get(p.categoria) || null),
    cobertura_rotulo: p.cobertura_rotulo, estoque_atual: p.estoque_atual,
    recomendado: { ...melhor },
    testar,
    curva,
    limites: { break_even_desconto_pct: breakEven, desconto_max_sem_prejuizo_pct: descSemPrejuizo, desconto_teto_pct: r2(descMax * 100) },
    promocao_planejada: planejada,
    aviso: "A elasticidade é premissa de categoria (config/elasticidade.json), não medida dos seus dados ainda. Trate os números como cenário — o real depende de execução, concorrência e do que a promoção rouba de vendas futuras. Calibra quando promoções da tabela tiverem histórico.",
  };
}

// ---- qual produto colocar em promoção ----
function oportunidadesPromo(loja, opts = {}) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  // horizonte de 30 dias para comparar produtos numa base comum (o deep-dive usa a duração real da promo)
  const dur = Math.max(1, +opts.duracaoDias || 30);
  const n = Math.max(1, Math.min(60, +opts.n || 15));
  const catsAtaque = opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias : new Set();

  const candidatos = analise.produtos.filter((p) =>
    !p.do_not_promote &&
    p.abc !== "C" &&
    (p.venda_media_diaria && p.venda_media_diaria.d30) > 0 &&
    (p.preco_atual != null || p.preco_praticado != null) &&
    ["NORMAL", "OPORTUNIDADE", "ATENCAO", "SEM_ESTOQUE", "PARADO"].includes(p.cobertura_rotulo)
  );

  const linhas = [];
  for (const p of candidatos) {
    const P = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
    const C = p.custo_atual;
    const V = p.venda_media_diaria.d30;
    const el = elasticidadeDe(p.categoria);
    p._E = el.valor; p._P = P; p._C = C; p._V = V;
    const descMax = C != null && P > 0 ? clamp(1 - (C / (1 - CFG.piso_margem_pct)) / P, 0, CFG.desconto_teto) : CFG.desconto_teto;
    let melhor = null;
    const chave = C != null ? (x) => x.lucro_incremental : (x) => x.unidades_incrementais * x.preco;
    for (let d = 0; d <= descMax + 1e-9; d += CFG.passo_desconto) {
      const x = _ponto(p, d, dur);
      if (!melhor || (chave(x) ?? -Infinity) > (chave(melhor) ?? -Infinity)) melhor = x;
    }
    // promo só entra na lista se algum desconto melhora o resultado do próprio item
    if (!melhor || melhor.desconto_pct === 0) continue;
    if (C != null && !(melhor.lucro_incremental > 0)) continue; // com custo: exige lucro incremental positivo
    const defensivo = catsAtaque.has(p.categoria);
    linhas.push({
      produto: p.descricao, ean: p.ean, categoria: categoriaCanonica(p.categoria), abc: p.abc,
      preco_normal: r2(P), preco_recomendado: melhor.preco, desconto_pct: melhor.desconto_pct,
      custo_proxy: !!p.custo_proxy,
      lucro_incremental_previsto: melhor.lucro_incremental,
      efeito_cesta_estimado: melhor.efeito_cesta_estimado,
      unidades_incrementais: melhor.unidades_incrementais,
      margem_pct_na_promo: melhor.margem_pct,
      defensivo,
      motivo: [
        `elasticidade ${el.valor} (${el.fonte.split(" ")[0]})`,
        C != null ? `margem na promo ${melhor.margem_pct != null ? (melhor.margem_pct * 100).toFixed(0) + "%" : "—"}` : "sem custo (proxy/ausente)",
        defensivo ? "categoria sob ataque de concorrência" : null,
        `classe ${p.abc}`,
      ].filter(Boolean).join(" · "),
    });
  }
  // com custo -> lista principal, ranqueada por lucro incremental do SKU
  // sem custo -> lista à parte, ranqueada por receita incremental (não dá para projetar lucro)
  const comCusto = linhas.filter((x) => x.lucro_incremental_previsto != null);
  const semCusto = linhas.filter((x) => x.lucro_incremental_previsto == null);
  comCusto.sort((a, b) => b.lucro_incremental_previsto - a.lucro_incremental_previsto);
  semCusto.sort((a, b) => b.unidades_incrementais * b.preco_recomendado - a.unidades_incrementais * a.preco_recomendado);
  const top = comCusto.slice(0, n);
  const totalLucro = r2(top.reduce((s, x) => s + (x.lucro_incremental_previsto || 0), 0));
  const totalCesta = r2(top.reduce((s, x) => s + (x.efeito_cesta_estimado || 0), 0));

  return {
    loja, refDate: analise.refDate, horizonte_dias: dur,
    candidatos: candidatos.length,
    potencial_lucro_incremental_top: totalLucro,
    efeito_cesta_estimado_top: totalCesta,
    produtos: top,
    sem_custo: { n: semCusto.length, produtos: semCusto.slice(0, n), nota: "Sem custo (próprio ou proxy) — ranqueados por receita incremental estimada, não por lucro." },
    aviso: `Lucro incremental projetado em ${dur} dias, pela MELHOR promoção de cada produto, sob a premissa de elasticidade da categoria (config/elasticidade.json). Base comum de ${dur} dias só para comparar; a duração real da promo você define no detalhe do produto. O efeito-cesta é estimativa e não entra no ranqueamento. Não substitui teste real; considere estoque e o que a promoção antecipa de vendas futuras.`,
  };
}

module.exports = { precificarProduto, oportunidadesPromo, elasticidadeDe };
