// Precificação de promoção — "que preço colocar, quanto de lucro dá, qual produto promover".
//
//   precificarProduto(loja, {ean|produto_id|descricao, duracaoDias})
//     -> varre descontos de 0..teto, projeta unidades pela elasticidade da categoria,
//        e devolve: preço recomendado (maximiza LUCRO INCREMENTAL do próprio item),
//        3 preços para testar, a curva lucro×desconto, break-even e limite sem prejuízo.
//
//   oportunidadesPromo(loja, {n, duracaoDias})
//     -> ranqueia os produtos A/B pelo lucro incremental da melhor promoção de cada um,
//        já com o detalhe (`.detalhe`) embutido em cada linha (funciona no site publicado,
//        sem backend), e um recorte por_grupo com TODOS os produtos interessantes de cada
//        categoria (preço a colocar + margem).
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
const DUR_PADRAO = Math.max(1, +CFG.duracao_dias_padrao || 7);

const AVISO = "A elasticidade é premissa de categoria (config/elasticidade.json), não medida dos seus dados ainda. " +
  "Trate os números como cenário — o real depende de execução, concorrência e do que a promoção rouba de vendas futuras. " +
  "Calibra quando promoções da tabela tiverem histórico. Confira estoque antes de anunciar.";

function elasticidadeDe(categoria) {
  const c = categoriaCanonica(categoria);
  const v = (CFG.por_categoria || {})[c];
  return { valor: v != null ? v : CFG.default, categoria: c, fonte: v != null ? "categoria (premissa, sem histórico ainda)" : "default (premissa)" };
}

// projeção de 1 ponto de desconto para 1 produto (usa p._E/_P/_C/_V já setados)
function _ponto(p, d, dur) {
  const E = p._E, P = p._P, C = p._C, V = p._V;
  const preco = r2(P * (1 - d));
  // unidades/dia sob promoção: V * (1 - E*d), com E negativo -> sobe; cap no uplift_max
  const fator = clamp(1 - E * d, 0, CFG.uplift_max);
  const undPromo = V * fator * dur;
  const undBase = V * dur;
  const receita = r2(undPromo * preco);
  const undInc = undPromo - undBase;
  const halo = (CFG.halo_r$_por_unidade || 0) * Math.max(0, undInc);
  let lucroPromo = null, lucroInc = null, lucroIncTotal = null, margemPct = null;
  if (C != null) {
    lucroPromo = undPromo * (preco - C);
    const lucroBase = undBase * (P - C);
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

// contexto caro (1 query de promoções vigentes + 1 mapa de lift) montado UMA vez e reusado
// em todos os produtos — sem isto, ranquear 3 mil candidatos dispara 3 mil queries.
function _contexto(loja, analise) {
  const promos = new Map();
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const ref = hoje > analise.refDate ? hoje : analise.refDate;
    for (const x of db.promocoesVigentes(loja, ref) || []) {
      if (x.ean) promos.set("e:" + String(x.ean).replace(/\D/g, ""), x);
      if (x.descricao) promos.set("d:" + String(x.descricao).toLowerCase().trim(), x);
    }
  } catch (e) { /* sem tabela de promoções — segue */ }
  let liftCat = new Map();
  try { liftCat = mpa.liftCampanhaPorCategoria(loja, analise.refDate) || new Map(); } catch (e) {}
  return { promos, liftCat };
}

// varre a curva e escolhe o melhor desconto para 1 produto JÁ localizado em analise.produtos
function _deepDive(loja, analise, p, dur, ctx) {
  ctx = ctx || _contexto(loja, analise);
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
  const rot = (x, r) => ({ rotulo: r, ...x });
  const testar = [];
  const cons = curva[Math.max(0, idx - 2)];
  if (cons !== melhor) testar.push(rot(cons, "conservador"));
  testar.push(rot(melhor, "recomendado"));
  const agr = curva[Math.min(curva.length - 1, idx + 2)];
  if (agr !== melhor) testar.push(rot(agr, "agressivo"));

  // break-even (lucro incremental cruza 0) e limite sem prejuízo
  let breakEven = null;
  for (let i = 1; i < curva.length; i++) {
    if (curva[i].lucro_incremental != null && curva[i - 1].lucro_incremental != null &&
        curva[i - 1].lucro_incremental >= 0 && curva[i].lucro_incremental < 0) { breakEven = curva[i].desconto_pct; break; }
  }
  const descSemPrejuizo = C != null && P > 0 ? r2(clamp(1 - C / P, 0, 1) * 100) : null;

  // promoção já planejada para esse produto? (lookup no contexto, sem query por produto)
  let planejada = null;
  const pl = (p.ean && ctx.promos.get("e:" + p.ean)) || ctx.promos.get("d:" + String(p.descricao).toLowerCase().trim());
  if (pl && pl.preco_promo) {
    const dd = P > 0 ? 1 - pl.preco_promo / P : null;
    planejada = { preco: pl.preco_promo, desconto_pct: dd != null ? r2(dd * 100) : null, ...(dd != null ? { projecao: _ponto(p, clamp(dd, 0, CFG.desconto_teto), dur) } : {}) };
  }

  return {
    loja, refDate: analise.refDate,
    produto: p.descricao, produto_id: p.produto_id, ean: p.ean,
    categoria: categoriaCanonica(p.categoria), abc: p.abc, papel_ok: !p.do_not_promote,
    preco_normal: r2(P), custo: r2(C), custo_proxy: !!p.custo_proxy, custo_proxy_origem: p.custo_proxy_origem || null,
    venda_media_diaria_30d: r2(V), duracao_dias: dur,
    elasticidade: el,
    lift_historico_categoria: r2(ctx.liftCat.get(p.categoria) || ctx.liftCat.get(categoriaCanonica(p.categoria)) || null),
    cobertura_rotulo: p.cobertura_rotulo, estoque_atual: p.estoque_atual,
    recomendado: { ...melhor },
    testar,
    curva,
    limites: { break_even_desconto_pct: breakEven, desconto_max_sem_prejuizo_pct: descSemPrejuizo, desconto_teto_pct: r2(descMax * 100) },
    promocao_planejada: planejada,
    aviso: AVISO,
  };
}

// tira o que é redundante quando o detalhe vai EMBUTIDO numa lista (o aviso/loja/refDate já
// estão no envelope) — economiza muito no snapshot publicado.
function _enxuto(dd) {
  if (!dd || dd.erro) return dd;
  const { aviso, loja, refDate, ...resto } = dd;
  return resto;
}
// versão p/ o ranking global: curva reamostrada (o gráfico precisa dela; sem backend não dá p/ recalcular)
function _compacto(dd, pts = 12) {
  if (!dd || dd.erro) return dd;
  const c = dd.curva || [];
  const step = Math.max(1, Math.ceil(c.length / pts));
  return { ..._enxuto(dd), curva: c.filter((_, i) => i % step === 0 || i === c.length - 1) };
}
// versão p/ o recorte por_grupo: sem curva (o deep-dive desenha barras a partir de `testar`)
function _minimo(dd) {
  if (!dd || dd.erro) return dd;
  const { curva, ...resto } = _enxuto(dd);
  return resto;
}

function _acharProduto(analise, opts) {
  const alvoEan = normalizarEan(opts.ean);
  const alvoDesc = opts.descricao ? String(opts.descricao).toLowerCase().trim() : null;
  const rec = (x) => (x.receita && (x.receita.d90 || x.receita.d30)) || 0;
  let p = analise.produtos.find((x) =>
    (opts.produto_id && String(x.produto_id) === String(opts.produto_id)) ||
    (alvoEan && x.ean === alvoEan) ||
    (alvoDesc && String(x.descricao).toLowerCase().trim() === alvoDesc)
  );
  if (!p && alvoDesc && alvoDesc.length >= 3) {
    const cand = analise.produtos
      .filter((x) => String(x.descricao).toLowerCase().includes(alvoDesc))
      .sort((a, b) => rec(b) - rec(a));
    if (cand.length) p = cand[0];
  }
  return p || null;
}

function precificarProduto(loja, opts = {}) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  const dur = Math.max(1, +opts.duracaoDias || DUR_PADRAO);
  const p = _acharProduto(analise, opts);
  if (!p) return { erro: "produto não encontrado nas vendas da loja no período", ...(opts.ean ? { ean: normalizarEan(opts.ean) } : {}), ...(opts.descricao ? { busca: opts.descricao } : {}) };
  return _deepDive(loja, analise, p, dur);
}

// ---- qual produto colocar em promoção (global + por grupo) ----
function oportunidadesPromo(loja, opts = {}) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  // horizonte da projeção — mesma duração para o ranking e para o detalhe embutido, p/ os
  // números baterem entre a lista e o card do produto.
  const dur = Math.max(1, +opts.duracaoDias || DUR_PADRAO);
  const n = Math.max(1, Math.min(80, +opts.n || 20));
  const porGrupoMax = Math.max(1, Math.min(50, +opts.porGrupoMax || 30));
  const catsAtaque = opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias : new Set();

  const candidatos = analise.produtos.filter((p) =>
    !p.do_not_promote &&
    p.abc !== "C" &&
    (p.venda_media_diaria && p.venda_media_diaria.d30) > 0 &&
    (p.preco_atual != null || p.preco_praticado != null) &&
    ["NORMAL", "OPORTUNIDADE", "ATENCAO", "SEM_ESTOQUE", "PARADO"].includes(p.cobertura_rotulo)
  );

  const ctx = _contexto(loja, analise);
  const linhas = [];
  for (const p of candidatos) {
    const dd = _deepDive(loja, analise, p, dur, ctx);
    if (dd.erro) continue;
    const m = dd.recomendado;
    if (!m || m.desconto_pct === 0) continue;                 // promo só entra se algum desconto ajuda
    if (dd.custo != null && !(m.lucro_incremental > 0)) continue; // com custo: exige lucro incremental positivo
    if (!(m.unidades_incrementais >= 1)) continue;            // e tem que mover ao menos 1 unidade extra na janela
    const defensivo = catsAtaque.has(dd.categoria);
    linhas.push({
      produto: dd.produto, produto_id: dd.produto_id, ean: dd.ean,
      categoria: dd.categoria, abc: dd.abc,
      preco_normal: dd.preco_normal, custo: dd.custo, custo_proxy: dd.custo_proxy,
      preco_recomendado: m.preco, desconto_pct: m.desconto_pct,
      margem_pct_na_promo: m.margem_pct,
      lucro_incremental_previsto: m.lucro_incremental,
      efeito_cesta_estimado: m.efeito_cesta_estimado,
      unidades_incrementais: m.unidades_incrementais,
      tem_promo_planejada: !!dd.promocao_planejada,
      defensivo,
      motivo: [
        `elasticidade ${dd.elasticidade.valor} (${dd.elasticidade.fonte.split(" ")[0]})`,
        dd.custo != null ? `margem na promo ${m.margem_pct != null ? (m.margem_pct * 100).toFixed(0) + "%" : "—"}` : "sem custo (proxy/ausente)",
        defensivo ? "categoria sob ataque de concorrência" : null,
        `classe ${dd.abc}`,
      ].filter(Boolean).join(" · "),
      _dd: dd,
    });
  }

  const comCusto = linhas.filter((x) => x.lucro_incremental_previsto != null).sort((a, b) => b.lucro_incremental_previsto - a.lucro_incremental_previsto);
  const semCusto = linhas.filter((x) => x.lucro_incremental_previsto == null).sort((a, b) => b.unidades_incrementais * b.preco_recomendado - a.unidades_incrementais * a.preco_recomendado);

  const finalizar = (lista, full) => lista.map(({ _dd, ...row }) => ({ ...row, detalhe: full ? _compacto(_dd) : _minimo(_dd) }));

  const top = finalizar(comCusto.slice(0, n), true);
  const totalLucro = r2(top.reduce((s, x) => s + (x.lucro_incremental_previsto || 0), 0));
  const totalCesta = r2(top.reduce((s, x) => s + (x.efeito_cesta_estimado || 0), 0));

  // ---- recorte por grupo/categoria: TODOS os produtos interessantes de cada grupo ----
  const grupos = {};
  for (const row of linhas) {
    const g = row.categoria || "Sem categoria";
    (grupos[g] || (grupos[g] = [])).push(row);
  }
  const por_grupo = Object.entries(grupos).map(([categoria, arr]) => {
    arr.sort((a, b) => (b.lucro_incremental_previsto ?? b.unidades_incrementais * b.preco_recomendado) - (a.lucro_incremental_previsto ?? a.unidades_incrementais * a.preco_recomendado));
    const comMargem = arr.filter((x) => x.margem_pct_na_promo != null);
    return {
      categoria,
      n_interessantes: arr.length,
      lucro_incremental_total: r2(arr.reduce((s, x) => s + (x.lucro_incremental_previsto || 0), 0)),
      margem_media_na_promo: comMargem.length ? r2(comMargem.reduce((s, x) => s + x.margem_pct_na_promo, 0) / comMargem.length) : null,
      desconto_medio_pct: arr.length ? r2(arr.reduce((s, x) => s + x.desconto_pct, 0) / arr.length) : null,
      mostrando: Math.min(arr.length, porGrupoMax),
      produtos: finalizar(arr.slice(0, porGrupoMax), false),
    };
  }).sort((a, b) => b.lucro_incremental_total - a.lucro_incremental_total);

  return {
    loja, refDate: analise.refDate, horizonte_dias: dur,
    candidatos: candidatos.length,
    potencial_lucro_incremental_top: totalLucro,
    efeito_cesta_estimado_top: totalCesta,
    produtos: top,
    por_grupo,
    grupos_disponiveis: por_grupo.map((g) => g.categoria),
    sem_custo: { n: semCusto.length, produtos: finalizar(semCusto.slice(0, n), false), nota: "Sem custo (próprio ou proxy) — ranqueados por receita incremental estimada, não por lucro." },
    aviso: `Lucro incremental projetado para uma promo de ${dur} dias, pela MELHOR promoção de cada produto, sob a premissa de elasticidade da categoria (config/elasticidade.json). O efeito-cesta é estimativa e não entra no ranqueamento. Não substitui teste real; considere estoque e o que a promoção antecipa de vendas futuras.`,
  };
}

// preço de promoção recomendado para uma LISTA de produtos já conhecidos (ids ou objetos com
// produto_id) — usado pelo Command Center e pela tela de Concorrentes para mostrarem o preço
// a colocar sem cada tela reimplementar o cálculo. Devolve Map(produto_id -> resumo) só para
// os que valem promoção (desconto > 0 e, com custo, lucro incremental positivo).
function precoRapido(loja, opts = {}, produtos = []) {
  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return new Map();
  const dur = Math.max(1, +opts.duracaoDias || DUR_PADRAO);
  const ctx = _contexto(loja, analise);
  const byId = new Map(analise.produtos.map((p) => [String(p.produto_id), p]));
  const byEan = new Map(analise.produtos.filter((p) => p.ean).map((p) => [String(p.ean), p]));
  const out = new Map();
  for (const q of produtos) {
    const key = q && typeof q === "object" ? q.produto_id : q;
    const p = byId.get(String(key)) || (q && q.ean && byEan.get(String(q.ean)));
    if (!p) continue;
    const dd = _deepDive(loja, analise, p, dur, ctx);
    const m = dd && dd.recomendado;
    if (!m || m.desconto_pct === 0) continue;
    if (dd.custo != null && !(m.lucro_incremental > 0)) continue;
    out.set(String(p.produto_id), {
      preco_normal: dd.preco_normal,
      preco_recomendado: m.preco,
      desconto_pct: m.desconto_pct,
      margem_pct_na_promo: m.margem_pct,
      lucro_incremental_previsto: m.lucro_incremental,
      unidades_incrementais: m.unidades_incrementais,
      duracao_dias: dur,
      elasticidade: dd.elasticidade.valor,
      elasticidade_premissa: true,
      break_even_desconto_pct: dd.limites.break_even_desconto_pct,
      tem_promo_planejada: !!dd.promocao_planejada,
    });
  }
  return out;
}

module.exports = { precificarProduto, oportunidadesPromo, precoRapido, elasticidadeDe, DUR_PADRAO };
