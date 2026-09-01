// Coleta, batendo na própria API local (com cookie de sessão), TODAS as respostas de todas
// as telas, das duas lojas e de todos os períodos. É a fonte comum de:
//   - publicar.js        (assa tudo num analytics.html)
//   - supabase-sync.js   (faz UPSERT de cada pedaço em analytics_snapshots)

const MK_MARKETING = {
  "produtos": "produtos", "recommended-products": "recommended", "do-not-promote": "dnp",
  "stagnant-stock": "parado", "baskets": "baskets", "combos": "combos",
  "campaign-efficiency": "eficiencia", "campaign-builder": "builder",
};
const MK_INTEL = {
  "war-room": "warRoom", "signals": "signals", "investigations": "investigations",
  "decisions": "decisions", "patterns": "patterns", "editorial-plan": "editorial",
  "recommendations": "recommendations",
};

function fazGet(port, cookie) {
  const H = { headers: cookie ? { Cookie: `va_session=${cookie}` } : {} };
  return async (p) => {
    try {
      const r = await fetch(`http://localhost:${port}${p}`, H);
      return r.ok ? await r.json() : { __erro: r.status };
    } catch (e) {
      return { __erro: e.message };
    }
  };
}

async function coletarLoja(get, nome) {
  const L = encodeURIComponent(nome);
  const periodos = (await get(`/api/periodos/${L}`)) || [];
  const comVendas = Array.isArray(periodos) ? periodos.filter((p) => p.temVendas) : [];
  const analise = {};
  const ontologia = {};
  for (const p of comVendas) {
    analise[`${nome}|${p.periodo}`] = await get(`/api/analise/${L}/${p.periodo}`);
    ontologia[`${nome}|${p.periodo}`] = await get(`/api/ontologia/${L}/${p.periodo}`);
  }
  const ultimo = comVendas.length ? (comVendas.find((p) => p.atual) || comVendas[0]).periodo : null;

  const analiseComercial = {};
  const acLatest = await get(`/api/analise-comercial/${L}`);
  analiseComercial[nome] = acLatest;
  if (acLatest && !acLatest.__erro && !acLatest.erro) {
    for (const ym of acLatest.meses || []) analiseComercial[`${nome}|${ym}`] = await get(`/api/analise-comercial/${L}/${ym}`);
  }

  let marketing = null;
  let intelligence = null;
  if (ultimo) {
    marketing = {
      produtos: await get(`/api/marketing/${L}/${ultimo}/produtos?limite=90`),
      recommended: await get(`/api/marketing/${L}/${ultimo}/recommended-products`),
      dnp: await get(`/api/marketing/${L}/${ultimo}/do-not-promote`),
      parado: await get(`/api/marketing/${L}/${ultimo}/stagnant-stock`),
      baskets: await get(`/api/marketing/${L}/${ultimo}/baskets`),
      combos: await get(`/api/marketing/${L}/${ultimo}/combos`),
      eficiencia: await get(`/api/marketing/${L}/campaign-efficiency`),
      builder: await get(`/api/marketing/${L}/${ultimo}/campaign-builder`),
    };
    intelligence = {
      warRoom: await get(`/api/intelligence/${L}/war-room`),
      signals: await get(`/api/intelligence/${L}/signals?limite=120`),
      recommendations: await get(`/api/intelligence/${L}/recommendations`),
      investigations: await get(`/api/intelligence/${L}/investigations`),
      decisions: await get(`/api/intelligence/${L}/decisions`),
      patterns: await get(`/api/intelligence/${L}/patterns`),
      editorial: await get(`/api/intelligence/${L}/editorial-plan`),
    };
  }

  return {
    ultimo,
    periodos: { [nome]: periodos },
    analise, ontologia,
    ontologiaUlt: { [nome]: ultimo ? ontologia[`${nome}|${ultimo}`] : null },
    analiseComercial,
    marketing: { [nome]: marketing },
    intelligence: { [nome]: intelligence },
    concorrencia: { [nome]: await get(`/api/concorrencia/${L}`) },
    catalogo: { [nome]: await get(`/api/catalogo/${L}`) },
  };
}

// devolve o "pacote" B inteiro (o mesmo objeto que o stub do analytics.html usa).
async function coletarTudo({ port, cookie }) {
  const get = fazGet(port, cookie);
  const lojas = (await get("/api/lojas")) || [];
  const B = {
    geradoEm: new Date().toISOString(),
    lojas,
    periodos: {}, analise: {}, ontologia: {}, ontologiaUlt: {},
    analiseComercial: {}, marketing: {}, intelligence: {}, concorrencia: {}, catalogo: {},
  };
  const porLoja = {};
  for (const l of lojas) {
    const parte = await coletarLoja(get, l.nome);
    porLoja[l.nome] = parte;
    Object.assign(B.periodos, parte.periodos);
    Object.assign(B.analise, parte.analise);
    Object.assign(B.ontologia, parte.ontologia);
    Object.assign(B.ontologiaUlt, parte.ontologiaUlt);
    Object.assign(B.analiseComercial, parte.analiseComercial);
    Object.assign(B.marketing, parte.marketing);
    Object.assign(B.intelligence, parte.intelligence);
    Object.assign(B.concorrencia, parte.concorrencia);
    Object.assign(B.catalogo, parte.catalogo);
  }
  return { B, porLoja };
}

module.exports = { coletarTudo, coletarLoja, fazGet, MK_MARKETING, MK_INTEL };
