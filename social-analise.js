// Análise das métricas de redes sociais de UMA loja — determinística (a IA só leu o print).
//
//   analiseSocial(loja) -> {
//     organico: { series por métrica, ultimo mês, variação, leitura[] },
//     pago:     { série mensal de tráfego pago, totais, tendências, leitura[] },
//     cruzamento:{ tabela mensal alcance/interações/investimento x faturamento, leitura[] },
//     fontes:   prints processados,  aviso
//   }
//
// Nunca soma as duas lojas. Nada é estimado: métrica ausente no print = ausente aqui.

const db = require("./db");
const { numBR } = require("./parsers/social-vision");

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const IG = [
  ["visualizacoes", "Visualizações"], ["alcance", "Alcance"], ["interacoes", "Interações"],
  ["visitas_perfil", "Visitas ao perfil"], ["cliques_link", "Cliques no link"], ["seguidores", "Seguidores"],
];
const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("pt-BR"));
const fmtBRL = (n) => (n == null ? "—" : "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + r2(n) + "%");
const varPct = (novo, velho) => (novo != null && velho != null && velho !== 0 ? r2(((novo - velho) / Math.abs(velho)) * 100) : null);

function analiseSocial(loja) {
  if (!db.LOJAS_VALIDAS.includes(loja)) return { erro: `loja inválida: ${loja}` };
  const periodos = db.listPeriodos(loja).slice().sort((a, b) => a.periodo.localeCompare(b.periodo));
  const fatMensal = new Map((db.faturamentoMensal(loja) || []).map((r) => [r.ym, r]));

  // ---- orgânico (resumo da conta) ----
  const pidDe = (ym) => { const r = db.findPeriodo(loja, ...ym.split("-").map(Number)); return r ? r.id : null; };

  const igPorMes = []; // { ym, metricas: {chave: {valor_num, valor_texto, delta_pct}} }
  for (const p of periodos) {
    const pid = pidDe(p.periodo);
    const rows = pid ? db.getInstagram(pid) : [];
    if (!rows || !rows.length) continue;
    const m = {};
    for (const row of rows) m[row.metrica] = { valor_num: numBR(row.valor_exibicao), valor_texto: row.valor_exibicao, delta_pct: row.delta_pct };
    igPorMes.push({ ym: p.periodo, metricas: m });
  }

  const seriesOrg = IG.map(([chave, rotulo]) => ({
    metrica: chave, rotulo,
    pontos: igPorMes.map((x) => ({ ym: x.ym, valor: x.metricas[chave] ? x.metricas[chave].valor_num : null, valor_texto: x.metricas[chave] ? x.metricas[chave].valor_texto : null, delta_pct: x.metricas[chave] ? x.metricas[chave].delta_pct : null })),
  }));

  const ultimoOrg = igPorMes[igPorMes.length - 1] || null;
  const penultimoOrg = igPorMes[igPorMes.length - 2] || null;
  const variacaoOrg = IG.map(([chave, rotulo]) => {
    const a = ultimoOrg && ultimoOrg.metricas[chave];
    const b = penultimoOrg && penultimoOrg.metricas[chave];
    const delta = a && a.delta_pct != null ? a.delta_pct : (a && b ? varPct(a.valor_num, b.valor_num) : null);
    return { metrica: chave, rotulo, valor_texto: a ? a.valor_texto : null, valor: a ? a.valor_num : null, delta_pct: delta, fonte_delta: a && a.delta_pct != null ? "print" : (a && b ? "calculado mês a mês" : null) };
  });

  const leituraOrg = [];
  if (ultimoOrg) {
    const comDelta = variacaoOrg.filter((v) => v.delta_pct != null);
    const subindo = comDelta.filter((v) => v.delta_pct > 0).sort((a, b) => b.delta_pct - a.delta_pct);
    const caindo = comDelta.filter((v) => v.delta_pct < 0).sort((a, b) => a.delta_pct - b.delta_pct);
    if (subindo[0]) leituraOrg.push({ tom: "bom", texto: `${subindo[0].rotulo} ${fmtPct(subindo[0].delta_pct)} no mês (${ultimoOrg.ym}).`, evidencia: { metrica: subindo[0].metrica, valor: subindo[0].valor_texto, fonte: subindo[0].fonte_delta } });
    if (caindo[0]) leituraOrg.push({ tom: "atencao", texto: `${caindo[0].rotulo} ${fmtPct(caindo[0].delta_pct)} — perdeu força.`, evidencia: { metrica: caindo[0].metrica, valor: caindo[0].valor_texto, fonte: caindo[0].fonte_delta } });
    const alc = ultimoOrg.metricas.alcance && ultimoOrg.metricas.alcance.valor_num;
    const inter = ultimoOrg.metricas.interacoes && ultimoOrg.metricas.interacoes.valor_num;
    if (alc && inter) {
      const taxa = r2((inter / alc) * 100);
      leituraOrg.push({ tom: taxa >= 2 ? "bom" : "neutro", texto: `Taxa de engajamento ~${taxa}% (interações ÷ alcance) em ${ultimoOrg.ym}.`, evidencia: { alcance: fmtInt(alc), interacoes: fmtInt(inter) } });
    }
    const vis = ultimoOrg.metricas.visitas_perfil && ultimoOrg.metricas.visitas_perfil.valor_num;
    const seg = ultimoOrg.metricas.seguidores && ultimoOrg.metricas.seguidores.valor_num;
    if (vis && seg != null) leituraOrg.push({ tom: "neutro", texto: `${fmtInt(vis)} visitas ao perfil geraram ${fmtInt(seg)} seguidores novos (${vis ? r2((seg / vis) * 100) : "—"}% de conversão de visita em seguidor).`, evidencia: {} });
  } else {
    leituraOrg.push({ tom: "neutro", texto: "Ainda não há print de resumo da conta. Jogue o screenshot da tela de Insights na pasta inbox (o nome do arquivo precisa dizer a loja)." });
  }

  // ---- tráfego pago ----
  const pagoPorMes = {};
  for (const p of periodos) {
    const pid = pidDe(p.periodo);
    if (!pid) continue;
    const rows = db.getTrafegoPago(pid);
    if (!rows.length) continue;
    const inv = rows.reduce((s, x) => s + (x.investimento || 0), 0);
    const imp = rows.reduce((s, x) => s + (x.impressoes || 0), 0);
    const clk = rows.reduce((s, x) => s + (x.cliques || 0), 0);
    const res = rows.reduce((s, x) => s + (x.resultados || 0), 0);
    pagoPorMes[p.periodo] = {
      ym: p.periodo, entradas: rows.length,
      investimento: r2(inv) || null,
      impressoes: imp || null, cliques: clk || null, resultados: res || null,
      cpc: clk ? r2(inv / clk) : (rows[0] && rows[0].cpc) || null,
      cpm: imp ? r2((inv / imp) * 1000) : (rows[0] && rows[0].cpm) || null,
      ctr_pct: imp ? r2((clk / imp) * 100) : (rows[0] && rows[0].ctr_pct) || null,
      custo_por_resultado: res ? r2(inv / res) : (rows[0] && rows[0].custo_por_resultado) || null,
      tipo_resultado: (rows.find((x) => x.tipo_resultado) || {}).tipo_resultado || null,
      campanhas: [...new Set(rows.map((x) => x.campanha).filter(Boolean))],
    };
  }
  const pagoSerie = Object.values(pagoPorMes).sort((a, b) => a.ym.localeCompare(b.ym));
  const pagoTot = pagoSerie.reduce((acc, m) => ({
    investimento: r2((acc.investimento || 0) + (m.investimento || 0)),
    cliques: (acc.cliques || 0) + (m.cliques || 0),
    resultados: (acc.resultados || 0) + (m.resultados || 0),
  }), {});
  const leituraPago = [];
  if (pagoSerie.length) {
    const ult = pagoSerie[pagoSerie.length - 1];
    const pen = pagoSerie[pagoSerie.length - 2];
    leituraPago.push({ tom: "neutro", texto: `${ult.ym}: ${fmtBRL(ult.investimento)} investidos${ult.resultados ? `, ${fmtInt(ult.resultados)} ${ult.tipo_resultado || "resultados"} a ${fmtBRL(ult.custo_por_resultado)} cada` : ""}.`, evidencia: { cpc: fmtBRL(ult.cpc), cpm: fmtBRL(ult.cpm), ctr: fmtPct(ult.ctr_pct) } });
    if (pen && ult.custo_por_resultado != null && pen.custo_por_resultado != null) {
      const v = varPct(ult.custo_por_resultado, pen.custo_por_resultado);
      leituraPago.push({ tom: v != null && v < 0 ? "bom" : "atencao", texto: `Custo por resultado ${fmtPct(v)} vs ${pen.ym} (${fmtBRL(pen.custo_por_resultado)} → ${fmtBRL(ult.custo_por_resultado)}).`, evidencia: {} });
    }
    if (pen && ult.cpc != null && pen.cpc != null) {
      const v = varPct(ult.cpc, pen.cpc);
      leituraPago.push({ tom: v != null && v <= 0 ? "bom" : "atencao", texto: `CPC ${fmtPct(v)} vs ${pen.ym}.`, evidencia: { de: fmtBRL(pen.cpc), para: fmtBRL(ult.cpc) } });
    }
    const fat = fatMensal.get(ult.ym);
    if (fat && ult.investimento) {
      leituraPago.push({ tom: "neutro", texto: `Em ${ult.ym}: ${fmtBRL(ult.investimento)} em anúncio para ${fmtBRL(fat.faturamento)} de faturamento na loja — ${r2((ult.investimento / fat.faturamento) * 100)}% da receita foi para tráfego pago.`, evidencia: {}, aviso: "faturamento é da loja inteira, não só do que o anúncio trouxe — não é ROAS." });
    }
  } else {
    leituraPago.push({ tom: "neutro", texto: "Sem print de tráfego pago ainda. Jogue o screenshot da tela de resultados de anúncios na pasta inbox." });
  }

  // ---- cruzamento mensal ----
  const meses = [...new Set([...igPorMes.map((x) => x.ym), ...pagoSerie.map((x) => x.ym), ...fatMensal.keys()])].sort();
  const tabelaMensal = meses.map((ym) => {
    const ig = igPorMes.find((x) => x.ym === ym);
    const pg = pagoPorMes[ym];
    const ft = fatMensal.get(ym);
    return {
      ym,
      faturamento: ft ? ft.faturamento : null,
      alcance: ig && ig.metricas.alcance ? ig.metricas.alcance.valor_num : null,
      interacoes: ig && ig.metricas.interacoes ? ig.metricas.interacoes.valor_num : null,
      seguidores: ig && ig.metricas.seguidores ? ig.metricas.seguidores.valor_num : null,
      investimento_pago: pg ? pg.investimento : null,
    };
  });
  const leituraCruz = [];
  for (let i = 1; i < tabelaMensal.length; i++) {
    const a = tabelaMensal[i], b = tabelaMensal[i - 1];
    const dFat = varPct(a.faturamento, b.faturamento);
    const dAlc = varPct(a.alcance, b.alcance);
    if (dFat != null && dAlc != null && Math.abs(dFat) >= 5 && Math.abs(dAlc) >= 10 && Math.sign(dFat) === Math.sign(dAlc)) {
      leituraCruz.push({ tom: dFat > 0 ? "bom" : "atencao", texto: `${b.ym}→${a.ym}: alcance ${fmtPct(dAlc)} e faturamento ${fmtPct(dFat)} andaram juntos.`, evidencia: {}, aviso: "co-movimento, não prova de causa." });
    }
  }
  if (!leituraCruz.length && tabelaMensal.filter((r) => r.faturamento != null && r.alcance != null).length >= 2) {
    leituraCruz.push({ tom: "neutro", texto: "Sem co-movimento forte entre alcance e faturamento nos meses com dados dos dois lados." });
  }

  const fontes = db.listSocialPrints(loja, 30);

  return {
    loja,
    motor_visao_ativo: require("./parsers/social-vision").ativo(),
    tem_dados: igPorMes.length > 0 || pagoSerie.length > 0,
    organico: { series: seriesOrg, ultimo_mes: ultimoOrg ? ultimoOrg.ym : null, variacao: variacaoOrg, leitura: leituraOrg },
    pago: { serie: pagoSerie, totais: pagoTot, leitura: leituraPago },
    cruzamento: { tabela_mensal: tabelaMensal, leitura: leituraCruz },
    fontes,
    aviso: "Os números vêm de prints lidos por visão (a IA só transcreve o que está na imagem, não estima). Variação sem % no print é calculada mês a mês. Faturamento é da loja inteira — nunca é atribuído só ao anúncio.",
  };
}

module.exports = { analiseSocial };
