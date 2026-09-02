// Fase G — Marketing Calendar + ciclo fechado.
//
// calendarioMarketing(loja, {dias}) monta os próximos N dias a partir do calendário recorrente
// (config/lojas.json) e AJUSTA cada ocorrência com os sinais das fases anteriores:
//   - ruptura na categoria (Command Center / cobertura)   -> SUSPENDER / trocar categoria
//   - campanha em fadiga (Playbooks / tendência, Fase D)   -> RENOVAR produtos e ângulo
//   - esforço sem pressão (Share of Promotions, Fase E)    -> REVISAR prioridade
//   - concorrência subcomunicada e sem campanha nossa      -> +slot de DEFESA
//   - categoria de alta oportunidade sem cobertura         -> +slot de OPORTUNIDADE
//
// ciclo_fechado: por campanha recorrente, junta a última Medição (C) + o padrão (D) + a fadiga
// numa recomendação para a PRÓXIMA rodada. Fecha dados -> medição -> aprendizado -> próxima.
//
// Determinístico. Cada ajuste carrega motivo + evidência.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { playbooks } = require("./padroes-mkt");
const { medirTodasDoCalendario } = require("./campaign-measure");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "campaign-plan.json"), "utf8")).calendario;
const DIA = 86400000;
const NOMES_DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + "T12:00:00").getDay();
const semanaKey = (iso) => addDias(iso, -((dow(iso) + 6) % 7)); // segunda daquela semana
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function calendarioMarketing(loja, opts = {}) {
  const cfg = LOJAS_CFG[loja] || {};
  const camps = cfg.campanhas || [];
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja" };
  const dias = Math.max(7, Math.min(60, +opts.dias || CFG.dias_padrao));
  const hoje = new Date().toISOString().slice(0, 10);
  const inicio = addDias(hoje > refDate ? hoje : refDate, 1);
  const fim = addDias(inicio, dias - 1);

  // ---- sinais das fases anteriores ----
  const analise = mpa.analisarProdutos(loja, opts);
  const rupturaPorCat = new Map(); // categoria -> { n, receita }
  for (const p of analise.erro ? [] : analise.produtos) {
    if (p.cobertura_rotulo !== "RUPTURA") continue;
    const rec = (p.receita && p.receita.d30) || 0;
    if (rec < CFG.ruptura_receita_min_30d) continue;
    const e = rupturaPorCat.get(p.categoria) || { n: 0, receita: 0 };
    e.n++; e.receita += rec;
    rupturaPorCat.set(p.categoria, e);
  }
  const catEmRuptura = (cats) => (cats || []).find((c) => {
    const e = rupturaPorCat.get(c);
    return e && e.n >= CFG.ruptura_min_produtos;
  });

  const pb = playbooks(loja, opts);
  const pbByCamp = new Map((pb.playbooks || []).map((p) => [p.campanha, p]));
  const fadigaPorCat = new Map();
  for (const f of (pb.fadiga && pb.fadiga.produtos) || []) {
    if (!fadigaPorCat.has(f.categoria)) fadigaPorCat.set(f.categoria, []);
    fadigaPorCat.get(f.categoria).push(f.descricao);
  }

  // medirTodasDoCalendario devolve um ARRAY (o wrapper {campanhas:[...]} é da rota)
  const med = medirTodasDoCalendario(loja, opts);
  const medByCamp = new Map((Array.isArray(med) ? med : med.campanhas || []).filter((m) => m && !m.erro && m.campanha).map((m) => [m.campanha.nome, m]));

  let conc = {};
  try { conc = require("../concorrencia-analise").analisarConcorrencia(loja); } catch (e) { conc = {}; }
  const share = (conc.share_promocoes && conc.share_promocoes.por_categoria) || [];
  const subComunic = share.filter((c) => /^subcomunicando/.test(c.veredito));
  const catsComCampanha = new Set(camps.flatMap((c) => c.categorias || []));

  // ---- ocorrências das campanhas recorrentes na janela ----
  const ocorrencias = [];
  for (const c of camps) {
    const setDows = new Set(c.dias || []);
    const porSemana = new Map();
    for (let k = 0; k < dias; k++) {
      const d = addDias(inicio, k);
      if (!setDows.has(dow(d))) continue;
      const sk = semanaKey(d);
      if (!porSemana.has(sk)) porSemana.set(sk, []);
      porSemana.get(sk).push(d);
    }
    const p = pbByCamp.get(c.nome) || {};
    for (const [sk, datas] of [...porSemana.entries()].sort()) {
      const catRup = catEmRuptura(c.categorias);
      const semPressao = (c.categorias || []).every((cat) => {
        const s = share.find((x) => x.categoria === cat);
        return s && /reavaliar prioridade/.test(s.veredito);
      });
      const fadigaItens = (c.categorias || []).flatMap((cat) => fadigaPorCat.get(cat) || []);

      let status = "OK", motivo = "sem ajuste — manter a campanha", acao = null;
      if (catRup) {
        status = "SUSPENDER";
        motivo = `${catRup} em risco de ruptura (${rupturaPorCat.get(catRup).n} produtos, R$ ${Math.round(rupturaPorCat.get(catRup).receita)}/30d) — anunciar agora gera falta`;
        acao = "repor o estoque OU trocar o foco da semana para outra categoria";
      } else if (p.tendencia === "piorando (possível fadiga)") {
        status = "RENOVAR";
        motivo = `Playbooks: campanha perdendo força ao longo das semanas${fadigaItens.length ? ` — ${fadigaItens.length} produto(s) em fadiga` : ""}`;
        acao = fadigaItens.length ? `trocar: ${fadigaItens.slice(0, 4).join("; ")}` : "renovar produtos e ângulo antes de repetir";
      } else if (fadigaItens.length >= 2) {
        status = "RENOVAR";
        motivo = `${fadigaItens.length} produto(s) da categoria em fadiga (rendiam nos dias de campanha e caíram)`;
        acao = `manter a campanha, mas trocar os produtos: ${fadigaItens.slice(0, 4).join("; ")}`;
      } else if (semPressao) {
        status = "REVISAR";
        motivo = "Share of Promotions: temos campanha e a concorrência está parada nessa categoria";
        acao = "reduzir esforço nesta semana — reaproveitar para uma categoria sob pressão";
      }
      ocorrencias.push({
        campanha: c.nome,
        categorias: c.categorias,
        semana: sk,
        datas,
        dias_semana: (c.dias || []).map((d) => NOMES_DOW[d]),
        melhor_dia: p.melhor_dia || null,
        papel_do_dia: `CHAMARIZ no dia de maior fluxo${p.melhor_dia ? ` (${p.melhor_dia})` : ""}; HERO e MARGEM o período todo; COMPLEMENTAR no PDV`,
        status, motivo, acao,
        forecast_endpoint: `/api/marketing/${encodeURIComponent(loja)}/campaign-plan?dias=${(c.dias || []).join(",")}&tema=${encodeURIComponent(c.nome)}`,
        evidencia: {
          campo: "ajuste_calendario", valor: status,
          fonte: catRup ? "cobertura de estoque" : p.tendencia === "piorando (possível fadiga)" ? "Playbooks (tendência)" : semPressao ? "Share of Promotions" : "calendário",
          periodo: `${datas[0]}..${datas[datas.length - 1]}`,
        },
      });
    }
  }
  ocorrencias.sort((a, b) => (a.datas[0] < b.datas[0] ? -1 : 1));

  // ---- slots sugeridos (defesa / oportunidade) ----
  const slots = [];
  for (const s of subComunic) {
    if (catsComCampanha.has(s.categoria)) continue;
    slots.push({
      tipo: "DEFESA",
      categoria: s.categoria,
      motivo: `concorrência abaixo do nosso preço em "${s.categoria}" (${s.ofertas_abaixo_do_nosso} ofertas) e sem campanha nossa`,
      acao: `abrir 1–2 dias de "${s.categoria}" na semana — cobrir preço nos itens de peso`,
      evidencia: { campo: "share_promocoes", valor: s.veredito, fonte: "Concorrentes", periodo: `${inicio}..${fim}` },
    });
  }
  // oportunidade: categorias mais frequentes entre os recomendados do Command Center, sem cobertura
  try {
    const cc = require("./command-center").commandCenter(loja, opts);
    const contCat = {};
    for (const a of (cc.plano_do_dia && cc.plano_do_dia.anunciar) || []) contCat[a.categoria] = (contCat[a.categoria] || 0) + 1;
    for (const [cat, n] of Object.entries(contCat).sort((a, b) => b[1] - a[1])) {
      if (catsComCampanha.has(cat) || slots.some((x) => x.categoria === cat) || slots.length >= CFG.slots_sugeridos_max) continue;
      if (n < 2) continue;
      slots.push({
        tipo: "OPORTUNIDADE",
        categoria: cat,
        motivo: `${n} produtos de "${cat}" no topo do Command Center e sem campanha recorrente`,
        acao: `testar 1 dia de "${cat}" — usar os recomendados do Command Center`,
        evidencia: { campo: "command-center", valor: n, fonte: "Command Center", periodo: `${inicio}..${fim}` },
      });
    }
  } catch (e) { /* command center indisponível */ }
  const slotsFinais = slots.slice(0, CFG.slots_sugeridos_max);

  // ---- digest por semana ----
  const semanas = [];
  const semKeys = [...new Set(ocorrencias.map((o) => o.semana))].sort();
  for (const sk of semKeys) {
    const occ = ocorrencias.filter((o) => o.semana === sk);
    const linhas = occ.map((o) => `${o.campanha}: ${o.status}${o.status !== "OK" ? ` (${o.motivo.split(" — ")[0]})` : ""}`);
    semanas.push({ semana: sk, fim: addDias(sk, 6), campanhas: linhas, slots: slotsFinais.map((s) => `${s.tipo} ${s.categoria}`) });
  }

  // ---- ciclo fechado por campanha ----
  const ciclo_fechado = camps.map((c) => {
    const p = pbByCamp.get(c.nome) || {};
    const m = medByCamp.get(c.nome);
    const fadigaItens = (c.categorias || []).flatMap((cat) => fadigaPorCat.get(cat) || []);
    let rec;
    if (catEmRuptura(c.categorias)) rec = "adiar — repor o estoque da categoria primeiro";
    else if (p.tendencia === "piorando (possível fadiga)" || fadigaItens.length >= 2) rec = fadigaItens.length ? `renovar — trocar ${fadigaItens.length} produto(s) em fadiga e revisar o ângulo` : "renovar — trocar produtos e ângulo antes de repetir";
    else if (m && m.canibalizacao && /deslocou demanda/.test(m.canibalizacao.veredito)) rec = "manter, mas o ganho é pouco incremental — cuidar da canibalização (não descontar a categoria toda)";
    else if (p.melhor_dia && p.por_dia_semana && p.por_dia_semana.length > 1 && p.por_dia_semana[0].lift_medio > p.por_dia_semana[p.por_dia_semana.length - 1].lift_medio * 1.4) rec = `manter e concentrar no ${p.melhor_dia} (rende bem mais que os outros dias)`;
    else rec = "manter — repetir com os produtos do Command Center";
    return {
      campanha: c.nome,
      categorias: c.categorias,
      ultima_medicao: m ? {
        incremento_receita: m.incremental.receita_total,
        pct_sobre_baseline: m.incremental.pct_sobre_baseline,
        ROAS: m.retorno.ROAS,
        retorno_sobre_margem: m.retorno.retorno_sobre_margem,
        canibalizacao: m.canibalizacao.veredito,
        confianca: m.confianca,
      } : null,
      padrao: p.n_ocorrencias ? { melhor_dia: p.melhor_dia, tendencia: p.tendencia, n_ocorrencias: p.n_ocorrencias } : null,
      produtos_em_fadiga: fadigaItens.slice(0, 6),
      recomendacao_proxima: rec,
      como_montar: `/api/marketing/${encodeURIComponent(loja)}/campaign-plan?dias=${(c.dias || []).join(",")}&tema=${encodeURIComponent(c.nome)}`,
    };
  });

  return {
    loja, refDate,
    janela: { inicio, fim, dias },
    ocorrencias,
    slots_sugeridos: slotsFinais,
    semanas,
    ciclo_fechado,
    resumo: [
      `${ocorrencias.length} ocorrência(s) de campanha nos próximos ${dias} dias · ${ocorrencias.filter((o) => o.status !== "OK").length} com ajuste.`,
      slotsFinais.length ? `Slots sugeridos: ${slotsFinais.map((s) => `${s.tipo} ${s.categoria}`).join(", ")}.` : "Nenhum slot extra sugerido.",
    ],
    aviso: "Sugestão determinística a partir do calendário + estoque + concorrência + histórico. Ajuste conforme execução real. Não substitui a decisão do gestor.",
  };
}

module.exports = { calendarioMarketing };
