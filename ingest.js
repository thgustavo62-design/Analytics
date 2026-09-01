// Ingestão de um arquivo (PDF de vendas ou xlsx de concorrentes) para dentro do banco.
// Mesmo caminho usado pelo watcher da pasta inbox/ e pela tela de upload manual.
//
// Regras de ouro preservadas:
//  - PDF cuja soma não bate com o "Total:" impresso -> parseVendasPdf LANÇA, nada é gravado.
//  - Loja é descoberta pelo CNPJ no cabeçalho do PDF (config/lojas.json). Se não reconhecer,
//    LANÇA em vez de adivinhar.
//  - Minas Farma e Farma e Farma nunca se misturam.

const fs = require("fs");
const path = require("path");

const { parseVendasPdf } = require("./parsers/vendas");
const { parseConcorrentes } = require("./parsers/concorrentes");
const { normalizeInstagram } = require("./parsers/instagram");
const { classificar } = require("./classify");
const { aggregate } = require("./aggregate");
const {
  LOJAS_VALIDAS,
  getOrCreatePeriodo,
  findPeriodo,
  replaceVendas,
  setVendasMeta,
  getVendas,
  replaceInstagram,
  replaceConcorrencia,
} = require("./db");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));

const soDigitos = (s) => String(s || "").replace(/\D/g, "");
const ymSlug = (ano, mes) => `${ano}-${String(mes).padStart(2, "0")}`;

// Descobre a loja pelo cabeçalho do PDF (CNPJ primeiro, razão social como reforço).
function resolveLoja(empresa) {
  const cnpj = soDigitos(empresa && empresa.cnpj);
  if (cnpj) {
    for (const nome of LOJAS_VALIDAS) {
      if (soDigitos(LOJAS_CFG[nome] && LOJAS_CFG[nome].cnpj) === cnpj) return nome;
    }
  }
  const rs = String((empresa && empresa.razaoSocial) || "").toLowerCase();
  if (rs) {
    for (const nome of LOJAS_VALIDAS) {
      const c = LOJAS_CFG[nome] || {};
      if (c.razaoSocial && rs.includes(c.razaoSocial.toLowerCase())) return nome;
      if (rs.includes(nome.toLowerCase())) return nome;
    }
  }
  return null;
}

function agruparPorMes(rows) {
  const m = new Map();
  for (const r of rows) {
    const ym = r.data.slice(0, 7);
    if (!m.has(ym)) m.set(ym, []);
    m.get(ym).push(r);
  }
  return m;
}

// --- PDF de vendas ---------------------------------------------------------

async function ingestVendas(filePath, { lojaForcada = null } = {}) {
  // parse com hora de fechamento padrão; se a loja resolvida tiver outra, o efeito é só
  // no flag de dia parcial — recalculado abaixo por mês.
  const parsed = await parseVendasPdf(filePath, { closingHour: 22 });
  const loja = lojaForcada || resolveLoja(parsed.empresa);
  if (!loja) {
    throw new Error(
      `Não reconheci a loja no cabeçalho do PDF (razão social "${parsed.empresa.razaoSocial || "?"}", ` +
        `CNPJ ${parsed.empresa.cnpj || "?"}). Adicione o CNPJ em config/lojas.json.`
    );
  }

  const rows = parsed.rows.map((r) => ({ ...r, categoria: classificar(r.descricao) }));
  const meses = agruparPorMes(rows);
  const umMesSo = meses.size === 1;
  const atualizados = [];

  for (const [ym, mrows] of meses) {
    const ano = +ym.slice(0, 4);
    const mes = +ym.slice(5, 7);
    const periodoId = getOrCreatePeriodo(loja, ano, mes);
    replaceVendas(periodoId, mrows);

    const contemUltimoDia = mrows.some((r) => r.data === parsed.lastDay);
    const maxData = mrows.reduce((a, r) => (r.data > a ? r.data : a), mrows[0].data);
    setVendasMeta(periodoId, {
      lastDay: contemUltimoDia ? parsed.lastDay : maxData,
      lastDayPartial: contemUltimoDia ? parsed.lastDayPartial : false,
      lastDayMotivo: contemUltimoDia ? parsed.lastDayMotivo : null,
      // o "Total:" impresso é do arquivo inteiro — só serve de auditoria se o arquivo é de 1 mês
      printedTotal: umMesSo ? parsed.printedTotal : null,
      geradoEm: parsed.headerTimestamp,
    });
    // Fase 1: mantém o catálogo (produtos) em dia a partir dos EAN das vendas
    let catalogo = null;
    try {
      catalogo = require("./catalogo").sincronizarProdutosDeVendas(periodoId);
    } catch (e) {
      console.error("[ingest] sincronização de catálogo:", e.message);
    }
    atualizados.push({ loja, periodo: ym, linhas: mrows.length, catalogo });
  }

  // Fase 4: re-materializa a cesta (support/confidence/lift) da loja com a janela nova
  let cesta = null;
  try {
    cesta = require("./basket").calcularCesta(loja);
  } catch (e) {
    console.error("[ingest] cesta:", e.message);
  }

  // Fases 5–12: roda os detectores de sinal com o contexto novo
  let intel = null;
  try {
    intel = require("./intelligence").rodarDeteccao(loja);
  } catch (e) {
    console.error("[ingest] detecção de sinais:", e.message);
  }

  return {
    tipo: "vendas",
    cesta: cesta && !cesta.erro ? { pares: cesta.pares.length, cupons: cesta.total_cupons } : null,
    inteligencia: intel && !intel.erro ? { sinais: intel.total, novos: intel.novos, resolvidos: intel.resolvidos } : null,
    loja,
    empresa: parsed.empresa,
    arquivoTotal: parsed.total,
    printedTotal: parsed.printedTotal,
    meses: atualizados,
  };
}

// --- xlsx de concorrentes ------------------------------------------------

// Concorrentes são compartilhados pelas duas lojas (mesma cidade). Aplica a coleta ao mês
// dela em CADA loja que já tem vendas naquele mês, comparando com o preço de cada uma.
function ingestConcorrentes(filePath) {
  const base = path.basename(filePath);
  const md = base.match(/(\d{4})-(\d{2})-(\d{2})/);
  const hoje = new Date();
  const ano = md ? +md[1] : hoje.getFullYear();
  const mes = md ? +md[2] : hoje.getMonth() + 1;
  const refDate = md ? `${md[1]}-${md[2]}-${md[3]}` : hoje.toISOString().slice(0, 10);

  const aplicadas = [];
  const ignoradas = [];
  for (const loja of LOJAS_VALIDAS) {
    const per = findPeriodo(loja, ano, mes);
    if (!per) {
      ignoradas.push(loja);
      continue;
    }
    const vendas = getVendas(per.id);
    const agg = vendas.length ? aggregate(vendas) : { precoMedioPorProduto: [] };
    const { ofertas } = parseConcorrentes(filePath, agg.precoMedioPorProduto, { referenceDate: refDate });
    replaceConcorrencia(per.id, ofertas);
    aplicadas.push({ loja, periodo: ymSlug(ano, mes), ofertas: ofertas.length });
  }
  if (!aplicadas.length) {
    throw new Error(`Nenhuma loja tem vendas de ${ymSlug(ano, mes)} ainda — suba o relatório de vendas desse mês primeiro.`);
  }
  return { tipo: "concorrentes", refDate, aplicadas, semVendasAinda: ignoradas };
}

// --- json de Instagram (opcional; formato: {loja, periodo:"AAAA-MM", metricas:{...}}) ---

// --- json do Motor de Análise Comercial (Fase 2) ------------------------

function ingestAnaliseComercial(doc) {
  const { validate } = require("./validate-analise");
  const store = require("./analise-store");
  const loja = doc.meta && doc.meta.loja;
  const ym = String((doc.meta && doc.meta.periodo && doc.meta.periodo.inicio) || "").slice(0, 7);
  if (!LOJAS_VALIDAS.includes(loja)) throw new Error(`meta.loja inválida na análise comercial: ${loja}`);
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error("meta.periodo.inicio inválido na análise comercial");
  const { ok, erros } = validate(doc);
  if (!ok) {
    store.saveErro(loja, ym, erros, doc);
    throw new Error("análise comercial não passou na validação: " + erros.slice(0, 3).join("; "));
  }
  store.save(loja, ym, doc);
  return { tipo: "analise-comercial", loja, periodo: ym };
}

// --- json de Instagram (opcional; formato: {loja, periodo:"AAAA-MM", metricas:{...}}) ---

function ingestInstagramJson(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const loja = payload.loja;
  if (!LOJAS_VALIDAS.includes(loja)) throw new Error(`JSON de Instagram sem 'loja' válida (${loja}).`);
  const pm = String(payload.periodo || "").match(/^(\d{4})-(\d{2})$/);
  if (!pm) throw new Error("JSON de Instagram sem 'periodo' no formato AAAA-MM.");
  const ano = +pm[1];
  const mes = +pm[2];
  if (!findPeriodo(loja, ano, mes)) throw new Error(`Período ${payload.periodo} da ${loja} ainda não existe — suba as vendas primeiro.`);
  const periodoId = getOrCreatePeriodo(loja, ano, mes);
  const metricas = normalizeInstagram(payload.metricas || payload);
  replaceInstagram(periodoId, metricas);
  return { tipo: "instagram", loja, periodo: payload.periodo, metricas: metricas.length };
}

// --- dispatcher ---------------------------------------------------------

async function ingestFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (ext === ".pdf") return ingestVendas(filePath);
  if (ext === ".xlsx") {
    if (/concorrente|coleta|varredura|confronto/.test(base)) return ingestConcorrentes(filePath);
    const { detectarTipoPlanilha, ingestPlanilhaProduto } = require("./catalogo");
    if (detectarTipoPlanilha(base)) return ingestPlanilhaProduto(filePath);
    throw new Error("xlsx não reconhecido — esperado Concorrentes_Coleta_*.xlsx, ou Estoque_/Custo_/Precos_*.xlsx.");
  }
  if (ext === ".json") {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (payload && payload.diagnostico_executivo && payload.meta && payload.meta.periodo) {
      return ingestAnaliseComercial(payload);
    }
    if (/instagram|insta/.test(base) || payload.metricas) return ingestInstagramJson(filePath);
    throw new Error("JSON não reconhecido (nem análise comercial, nem Instagram).");
  }
  throw new Error(`tipo de arquivo não suportado (${ext || "sem extensão"}).`);
}

module.exports = { ingestFile, ingestVendas, ingestConcorrentes, ingestInstagramJson, ingestAnaliseComercial, resolveLoja };
