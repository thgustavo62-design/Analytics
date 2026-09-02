// Fase D — Memória de marketing.
//
// Aprende com as campanhas recorrentes do calendário (config/lojas.json), semana a semana:
//   - qual DIA da campanha rende mais (Mon vs Ter) — comparação relativa, o viés do
//     dia-da-semana se cancela porque os dois usam o mesmo baseline
//   - TENDÊNCIA do lift ao longo das ocorrências → melhorando / estável / FADIGA
//   - lift médio (indicativo — mistura sazonalidade do próprio dia-da-semana)
//
//   playbooks(loja)        → manual por categoria (melhor dia, produtos, ângulo dominante)
//   fadigaProdutos(loja)   → produtos anunciados repetidamente com lift decrescente
//
// Determinístico. Sem histórico suficiente → "sem base" (nunca inventa).

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { papelDeProduto } = require("./roles");
const { angulosDeProduto } = require("./angulos");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "campaign-plan.json"), "utf8")).padroes;
const DIA = 86400000;
const NOMES_DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + "T12:00:00").getDay();
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const mediana = (a) => { const b = [...a].sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function desvio(a) { if (a.length < 2) return 0; const m = media(a); return Math.sqrt(media(a.map((x) => (x - m) ** 2))); }
// chave da semana (segunda-feira daquela semana)
function semanaKey(iso) { const d = new Date(iso + "T12:00:00"); const off = (d.getDay() + 6) % 7; return addDias(iso, -off); }
// slope simples (mínimos quadrados) de y vs índice 0..n-1, normalizado pela média de y
function tendenciaSlope(ys) {
  const n = ys.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2, my = media(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  const slope = den ? num / den : 0;
  return my ? slope / my : slope;
}

// ---------- padrões por campanha do calendário ----------
function padroesMarketing(loja, opts = {}) {
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja" };
  const janelaDias = +opts.janelaDias || CFG.janela_dias;
  const ini = addDias(refDate, -(janelaDias - 1));
  const camps = (LOJAS_CFG[loja] && LOJAS_CFG[loja].campanhas) || [];
  if (!camps.length) return { loja, refDate, janela: { inicio: ini, fim: refDate }, por_campanha: [], aviso: "nenhuma campanha no calendário desta loja" };

  const rows = db.vendasCategoriaPorData(loja, ini, refDate);

  const porCampanha = camps.map((c) => {
    const setDows = new Set(c.dias || []);
    const setCats = new Set(c.categorias || []);
    // receita da categoria da campanha por dia
    const recPorDia = new Map();
    for (const rr of rows) if (setCats.has(rr.categoria)) recPorDia.set(rr.data, (recPorDia.get(rr.data) || 0) + rr.receita);
    // agrupa por semana
    const semanas = new Map(); // semanaKey -> { camp:{dow->[rec]}, base:[rec] }
    for (let k = 0; k < janelaDias; k++) {
      const data = addDias(ini, k);
      if (data > refDate) break;
      const sk = semanaKey(data);
      if (!semanas.has(sk)) semanas.set(sk, { camp: new Map(), base: [] });
      const rec = recPorDia.get(data) || 0;
      const d = dow(data);
      if (setDows.has(d)) {
        if (!semanas.get(sk).camp.has(d)) semanas.get(sk).camp.set(d, []);
        semanas.get(sk).camp.get(d).push(rec);
      } else {
        semanas.get(sk).base.push(rec);
      }
    }
    // uma ocorrência por semana que teve dia de campanha E baseline
    const ocorrencias = [];
    const liftPorDow = new Map(); // dow -> [lift]
    for (const [sk, v] of [...semanas.entries()].sort()) {
      const baseDia = media(v.base);
      const campVals = [...v.camp.values()].flat();
      if (!campVals.length || baseDia <= 0) continue;
      const campDia = media(campVals);
      const lift = campDia / baseDia;
      ocorrencias.push({ semana: sk, lift: r2(lift), receita_dia_campanha: r2(campDia), receita_dia_base: r2(baseDia) });
      for (const [d, arr] of v.camp) {
        const l = media(arr) / baseDia;
        if (!liftPorDow.has(d)) liftPorDow.set(d, []);
        liftPorDow.get(d).push(l);
      }
    }

    const lifts = ocorrencias.map((o) => o.lift);
    const suficiente = ocorrencias.length >= CFG.min_ocorrencias;
    const slope = tendenciaSlope(lifts);
    let tendencia = "sem base";
    if (slope != null) {
      tendencia = slope <= -CFG.tendencia_slope_relevante ? "piorando (possível fadiga)"
        : slope >= CFG.tendencia_slope_relevante ? "melhorando" : "estável";
    }
    const porDia = [...liftPorDow.entries()]
      .map(([d, arr]) => ({ dia: d, dia_nome: NOMES_DOW[d], lift_medio: r2(media(arr)), n: arr.length }))
      .sort((a, b) => b.lift_medio - a.lift_medio);

    return {
      campanha: c.nome,
      categorias: c.categorias,
      dias_semana: c.dias,
      n_ocorrencias: ocorrencias.length,
      suficiente,
      lift_medio: lifts.length ? r2(media(lifts)) : null,
      lift_mediano: lifts.length ? r2(mediana(lifts)) : null,
      desvio: lifts.length ? r2(desvio(lifts)) : null,
      tendencia,
      tendencia_slope: slope == null ? null : r2(slope),
      melhor_dia: porDia[0] || null,
      por_dia_semana: porDia,
      ocorrencias,
      nota: suficiente ? null : `só ${ocorrencias.length} ocorrência(s) na janela — precisa de ${CFG.min_ocorrencias}+ para um padrão confiável`,
    };
  });

  return {
    loja, refDate,
    janela: { inicio: ini, fim: refDate, dias: janelaDias },
    por_campanha: porCampanha,
    aviso: "O lift médio é indicativo (mistura a sazonalidade do próprio dia-da-semana). As leituras confiáveis são as RELATIVAS: qual dia da campanha rende mais e se o lift está subindo ou caindo ao longo das semanas.",
  };
}

// ---------- playbook por categoria de campanha ----------
function playbooks(loja, opts = {}) {
  const pad = padroesMarketing(loja, opts);
  if (pad.erro) return pad;
  const analise = mpa.analisarProdutos(loja, opts);
  const produtos = analise.erro ? [] : analise.produtos;

  const lista = pad.por_campanha.map((pc) => {
    const setCats = new Set(pc.categorias || []);
    const doCat = produtos.filter((p) => setCats.has(p.categoria) && !p.do_not_promote);
    const top = doCat
      .sort((a, b) => b.opportunity.score - a.opportunity.score)
      .slice(0, CFG.produtos_por_categoria)
      .map((p) => {
        const pap = papelDeProduto(p);
        return { descricao: p.descricao, ean: p.ean, categoria: p.categoria, papel: pap.papel_primario, opportunity: p.opportunity.score, cobertura: p.cobertura_rotulo, margem_pct: p.margem_pct };
      });
    // ângulo dominante entre os top produtos
    const contAng = {};
    for (const p of doCat.slice(0, 8)) {
      const ang = angulosDeProduto(p, { duracaoDias: (pc.dias_semana || []).length, concorrenciaCategorias: opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias : new Set(), descontoPct: 12 });
      contAng[ang.primario] = (contAng[ang.primario] || 0) + 1;
    }
    const anguloDominante = Object.keys(contAng).sort((a, b) => contAng[b] - contAng[a])[0] || null;

    // veredito pela TENDÊNCIA (leitura não enviesada) + amostra — não pelo lift absoluto
    let veredito;
    if (!pc.suficiente) veredito = "sem histórico suficiente — rodar mais algumas semanas";
    else if (pc.tendencia === "piorando (possível fadiga)") veredito = "campanha perdendo força ao longo das semanas — renovar produtos/ângulo";
    else if (pc.tendencia === "melhorando") veredito = "campanha ganhando força — manter e reforçar";
    else if (pc.melhor_dia && pc.por_dia_semana.length > 1 && pc.melhor_dia.lift_medio > pc.por_dia_semana[pc.por_dia_semana.length - 1].lift_medio * 1.4) veredito = `manter, mas ${pc.por_dia_semana[pc.por_dia_semana.length - 1].dia_nome} rende bem menos — concentrar em ${pc.melhor_dia.dia_nome}`;
    else veredito = "campanha estável — manter";

    return {
      campanha: pc.campanha,
      categorias: pc.categorias,
      melhor_dia: pc.melhor_dia ? pc.melhor_dia.dia_nome : null,
      por_dia_semana: pc.por_dia_semana,
      dias_configurados: (pc.dias_semana || []).map((d) => NOMES_DOW[d]),
      duracao_dias: (pc.dias_semana || []).length,
      lift_medio: pc.lift_medio,
      lift_medio_nota: "indicativo — inclui a sazonalidade do próprio dia-da-semana; use as leituras relativas (melhor dia, tendência)",
      tendencia: pc.tendencia,
      n_ocorrencias: pc.n_ocorrencias,
      angulo_dominante: anguloDominante,
      produtos_recomendados: top,
      veredito,
    };
  });

  return {
    loja, refDate: pad.refDate, janela: pad.janela,
    playbooks: lista,
    padroes: pad.por_campanha,
    fadiga: fadigaProdutos(loja, opts),
    aviso: pad.aviso,
  };
}

// ---------- fadiga de produto ----------
function fadigaProdutos(loja, opts = {}) {
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja" };
  const camps = (LOJAS_CFG[loja] && LOJAS_CFG[loja].campanhas) || [];
  const catsCamp = new Set(camps.flatMap((c) => c.categorias || []));
  const dowsCamp = new Set(camps.flatMap((c) => c.dias || []));
  if (!catsCamp.size) return { loja, refDate, produtos: [], aviso: "nenhuma campanha no calendário" };

  // mapa chave→categoria, para só olhar produtos DAS categorias de campanha
  const catByEan = new Map(), catByNorm = new Map();
  for (const p of db.todosProdutos()) {
    if (p.ean) catByEan.set(String(p.ean).replace(/\D/g, ""), p.categoria);
    else if (p.descricao_normalizada) catByNorm.set(p.descricao_normalizada, p.categoria);
  }
  const catDe = (barras, descricao) => {
    const e = String(barras || "").replace(/\D/g, "");
    if (e && catByEan.has(e)) return catByEan.get(e);
    return catByNorm.get(String(descricao || "").toLowerCase().trim()) || null;
  };

  const blocoDias = CFG.bloco_dias;
  const nBlocos = Math.max(CFG.min_blocos, Math.min(4, Math.floor(CFG.janela_dias / blocoDias)));
  // do mais antigo ao mais recente
  const blocos = [];
  for (let i = nBlocos - 1; i >= 0; i--) {
    blocos.push({ ini: addDias(refDate, -((i + 1) * blocoDias - 1)), fim: addDias(refDate, -(i * blocoDias)) });
  }

  // por bloco: unid por produto nos dias de campanha vs demais dias -> lift
  const porProduto = new Map(); // ean|desc -> { descricao, categoria, lifts:[] }
  for (const b of blocos) {
    const rowsCamp = [], rowsBase = [];
    // consulta janela do bloco e separa por dia-da-semana
    const linhas = db.linhasCestaJanela(loja, b.ini, b.fim); // {data, lancamento, barras, descricao, quantidade, valor_liquido}
    const acc = new Map(); // key -> { camp:0, base:0, diasCamp:Set, diasBase:Set, descricao, categoria? }
    for (const l of linhas) {
      const cat = catDe(l.barras, l.descricao);
      if (!catsCamp.has(cat)) continue; // só produtos das categorias de campanha
      const key = (l.barras || "").replace(/\D/g, "") || ("d:" + String(l.descricao || "").toLowerCase().trim());
      if (!acc.has(key)) acc.set(key, { camp: 0, base: 0, descricao: l.descricao, categoria: cat });
      const a = acc.get(key);
      if (dowsCamp.has(dow(l.data))) a.camp += l.quantidade || 0;
      else a.base += l.quantidade || 0;
    }
    // nº de dias de campanha e não-campanha no bloco (p/ média diária)
    let dCamp = 0, dBase = 0;
    for (let k = 0; ; k++) {
      const d = addDias(b.ini, k);
      if (d > b.fim) break;
      (dowsCamp.has(dow(d)) ? (dCamp++) : (dBase++));
    }
    for (const [key, a] of acc) {
      if (dCamp === 0 || dBase === 0) continue;
      const campDia = a.camp / dCamp, baseDia = a.base / dBase;
      if (baseDia <= 0) continue;
      const lift = campDia / baseDia;
      if (!porProduto.has(key)) porProduto.set(key, { descricao: a.descricao, categoria: a.categoria, lifts: [], unidCamp: [] });
      porProduto.get(key).lifts.push(r2(lift));
      porProduto.get(key).unidCamp.push(a.camp);
    }
  }

  const MIN_UNID_CAMP = 20; // volume mínimo (unid nos dias de campanha, blocos iniciais)
  const out = [];
  for (const [key, v] of porProduto) {
    if (v.lifts.length < CFG.min_blocos) continue;
    const inicio = media(v.lifts.slice(0, Math.max(1, v.lifts.length - 1)));
    const ultimo = v.lifts[v.lifts.length - 1];
    const unidInicio = v.unidCamp.slice(0, Math.max(1, v.unidCamp.length - 1)).reduce((s, x) => s + x, 0);
    // fadiga = ainda vende (ultimo > 0) mas rende bem menos; queda a 0 = ruptura/saiu de linha, não fadiga
    if (unidInicio >= MIN_UNID_CAMP && inicio >= CFG.fadiga_lift_inicial_min && ultimo > 0 && ultimo < inicio * CFG.fadiga_queda) {
      out.push({
        descricao: v.descricao,
        categoria: v.categoria,
        lift_por_bloco: v.lifts,
        lift_inicial: r2(inicio),
        lift_atual: r2(ultimo),
        queda_pct: r2((1 - ultimo / inicio) * 100),
        unidades_dias_campanha: Math.round(v.unidCamp.reduce((s, x) => s + x, 0)),
        veredito: "público possivelmente saturado — trocar produto, ângulo, criativo ou oferta",
      });
    }
  }
  out.sort((a, b) => b.queda_pct - a.queda_pct);
  const totalFadiga = out.length;

  return {
    loja, refDate,
    blocos: blocos.map((b) => `${b.ini}..${b.fim}`),
    total: totalFadiga,
    produtos: out.slice(0, 20),
    aviso: totalFadiga ? `${totalFadiga} produto(s) das categorias de campanha rendiam nos dias de campanha e perderam força ao longo dos blocos de ${CFG.bloco_dias} dias.` : `Sem fadiga detectada (ou histórico curto: precisa de ${CFG.min_blocos}+ blocos de ${CFG.bloco_dias} dias com venda).`,
  };
}

module.exports = { padroesMarketing, playbooks, fadigaProdutos };
