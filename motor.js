// Motor de Análise Comercial — geração do JSON pela API da Anthropic.
//
// Opcional / opt-in: só funciona se ANTHROPIC_API_KEY (ou ANTHROPIC_AUTH_TOKEN) estiver
// no ambiente. Sem isso, o site continua recebendo o JSON pela pasta inbox ou pelo POST.
//
// "Python agrega, LLM interpreta": analytics-deep.js faz toda a conta; aqui o modelo só
// interpreta os agregados e decide, no contrato da Parte 2.

const fs = require("fs");
const path = require("path");

const { getVendas, getConcorrencia, findPeriodo } = require("./db");
const { analiseProfunda } = require("./analytics-deep");
const { validate } = require("./validate-analise");
const analiseStore = require("./analise-store");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));
const MODEL = process.env.ANALISE_MODEL || "claude-opus-5";
const ymSlug = (ano, mes) => `${ano}-${String(mes).padStart(2, "0")}`;

function podeGerar() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// system prompt = o documento de referência, sem a nota de status do topo e sem a PARTE 3
// (que são instruções de integração, não para o modelo).
let SYSTEM_CACHE = null;
function systemPrompt() {
  if (SYSTEM_CACHE) return SYSTEM_CACHE;
  let md = fs.readFileSync(path.join(__dirname, "prompts", "motor-analise-comercial.md"), "utf8");
  md = md.replace(/^[\s\S]*?\n## PARTE 1/, "## PARTE 1"); // corta cabeçalho + blockquote de status
  md = md.replace(/\n## PARTE 3[\s\S]*$/, "\n"); // corta as notas de integração
  SYSTEM_CACHE =
    md.trim() +
    "\n\n---\n\nResponda **exclusivamente** com um objeto JSON válido no schema da PARTE 2. " +
    "Sem texto antes ou depois, sem blocos de código markdown. Campos sem dado recebem null.";
  return SYSTEM_CACHE;
}

function extrairJSON(texto) {
  let t = String(texto).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i === -1 || j === -1) throw new Error("resposta do modelo não contém JSON");
  return JSON.parse(t.slice(i, j + 1));
}

function normalizar(doc, loja, ano, mes, periodo) {
  doc.meta = doc.meta || {};
  doc.meta.loja = loja;
  doc.meta.periodo = doc.meta.periodo || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.meta.periodo.inicio || "")) doc.meta.periodo.inicio = `${periodo}-01`;
  if (!doc.meta.periodo.fim) doc.meta.periodo.fim = `${periodo}-${String(new Date(ano, mes, 0).getDate()).padStart(2, "0")}`;
  doc.meta.gerado_em = new Date().toISOString();
  doc.meta.gerado_por = `motor.js · ${MODEL}`;
  return doc;
}

/**
 * Gera (ou regenera) a análise comercial de uma loja/mês e grava no store.
 * @returns {Promise<{ok:true, loja, periodo, model, tentativas, usage}>}
 */
async function gerarAnalise(loja, ano, mes, opts = {}) {
  if (!podeGerar()) {
    const e = new Error("ANTHROPIC_API_KEY não configurada — não dá para gerar a análise pela API. Configure a chave, ou entregue o JSON pela pasta inbox / POST /analise-comercial/upload.");
    e.code = "SEM_CHAVE";
    throw e;
  }
  if (!LOJAS_CFG[loja]) throw new Error(`loja desconhecida: ${loja}`);
  const periodo = findPeriodo(loja, ano, mes);
  if (!periodo) throw new Error(`sem vendas de ${ymSlug(ano, mes)} para ${loja}`);
  const rows = getVendas(periodo.id);
  if (!rows.length) throw new Error(`período ${ymSlug(ano, mes)} sem linhas de venda`);

  // mês anterior (para variação), se existir
  const pMes = mes === 1 ? 12 : mes - 1;
  const pAno = mes === 1 ? ano - 1 : ano;
  const perAnt = findPeriodo(loja, pAno, pMes);
  const rowsAnt = perAnt ? getVendas(perAnt.id) : null;
  const concRows = getConcorrencia(periodo.id);

  const deep = analiseProfunda(rows, { lojaCfg: LOJAS_CFG[loja], rowsMesAnterior: rowsAnt, concorrencia: concRows });
  const anterior = opts.anterior || analiseStore.read(loja, ymSlug(pAno, pMes)) || null;

  const AnthropicNS = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicNS.default || AnthropicNS;
  const client = new Anthropic();

  const cal = (LOJAS_CFG[loja].campanhas || [])
    .map((c) => `- ${c.nome}: dias ${JSON.stringify(c.dias)} (0=dom..6=sáb), categorias ${JSON.stringify(c.categorias)}`)
    .join("\n") || "(sem campanha própria configurada)";

  const baseUser =
    `Loja: ${loja}\n` +
    `Período: ${ymSlug(ano, mes)} (${deep.operacao.cupons} cupons, ${rows.length} linhas de venda). ` +
    `Cobertura de custo: não disponível (não há tabela de custo) — trate margem como não medida.\n\n` +
    `CALENDÁRIO PROMOCIONAL PRÓPRIO (avalie CADA campanha, uma por uma, pelo método intradiário):\n${cal}\n\n` +
    `Os agregados já trazem, por campanha, a participação da(s) categoria(s) no faturamento do próprio dia ` +
    `(campanha x 2 baselines) e o faturamento médio dos dias de campanha vs. fora. Também trazem a coleta de ` +
    `concorrentes do mês (ofertas confirmadas, quantas abaixo do nosso preço médio, exemplos). Cruze: se um ` +
    `concorrente está sistematicamente abaixo numa categoria que a gente promove, isso muda a leitura da campanha.\n\n` +
    `DADOS AGREGADOS (já calculados — não refaça a conta, interprete e decida):\n` +
    JSON.stringify(deep, null, 1) +
    `\n\n` +
    (anterior ? `ANÁLISE ANTERIOR (compare conclusão por conclusão; registre o que mudou em 'correcoes'):\n${JSON.stringify(anterior)}\n\n` : `Não há análise anterior.\n\n`) +
    `Gere a análise de ${loja} para ${ymSlug(ano, mes)} no schema da PARTE 2. Em 'campanhas[]' deve haver uma entrada por campanha do calendário acima.`;

  const messages = [{ role: "user", content: baseUser }];
  let doc = null;
  let tentativas = 0;
  let usage = null;
  let ultimoErro = null;

  for (tentativas = 1; tentativas <= 2; tentativas++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: systemPrompt(),
        messages,
      });
    } catch (err) {
      const st = err && err.status;
      if (st === 401 || st === 403) {
        const e = new Error("ANTHROPIC_API_KEY inválida ou sem acesso ao modelo.");
        e.code = "SEM_CHAVE";
        throw e;
      }
      if (st === 429) throw new Error("a API da Anthropic está limitando (rate limit) — tente de novo em alguns minutos.");
      if (st === 404) throw new Error(`modelo "${MODEL}" não encontrado nesta conta — ajuste ANALISE_MODEL.`);
      throw new Error(`falha ao chamar a API: ${err.message}`);
    }
    usage = resp.usage;
    if (resp.stop_reason === "refusal") throw new Error("modelo recusou a requisição (stop_reason: refusal)");
    const txt = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    try {
      const cand = normalizar(extrairJSON(txt), loja, ano, mes, ymSlug(ano, mes));
      const v = validate(cand);
      if (v.ok) {
        doc = cand;
        break;
      }
      ultimoErro = v.erros;
      messages.push({ role: "assistant", content: txt });
      messages.push({ role: "user", content: `O JSON não passou na validação:\n- ${v.erros.join("\n- ")}\nCorrija e responda de novo, só com o JSON.` });
    } catch (e) {
      ultimoErro = [e.message];
      messages.push({ role: "assistant", content: txt });
      messages.push({ role: "user", content: `Não consegui ler o JSON (${e.message}). Responda só com o objeto JSON, sem markdown.` });
    }
  }

  if (!doc) {
    const e = new Error("a análise gerada não passou na validação: " + (ultimoErro || []).slice(0, 4).join("; "));
    e.code = "INVALIDA";
    throw e;
  }

  analiseStore.save(loja, ymSlug(ano, mes), doc);
  return { ok: true, loja, periodo: ymSlug(ano, mes), model: MODEL, tentativas, usage };
}

// --- auto: depois de um ingest de vendas, (re)gera a análise do mês se fizer sentido ---
// Ligado por padrão quando há chave. Desligue com AUTO_ANALISE=0.

const autoLock = new Set();

function maybeAutoAnalise(resultado, log) {
  const say = log || ((m) => console.log("[motor:auto]", m));
  if (process.env.AUTO_ANALISE === "0") return;
  if (!podeGerar()) return;
  if (!resultado || resultado.tipo !== "vendas" || !Array.isArray(resultado.meses)) return;

  const agora = new Date();
  const mesCorrente = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
  const d = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const mesAnterior = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  for (const { loja, periodo } of resultado.meses) {
    if (periodo !== mesCorrente && periodo !== mesAnterior) continue; // não regera histórico antigo
    const existente = analiseStore.read(loja, periodo);
    if (existente && existente.meta && existente.meta.gerado_em) {
      const idadeDias = (Date.now() - new Date(existente.meta.gerado_em).getTime()) / 86400000;
      if (idadeDias < 20) continue; // já tem uma recente
    }
    const key = `${loja}/${periodo}`;
    if (autoLock.has(key)) continue;
    autoLock.add(key);
    const [a, mm] = periodo.split("-").map(Number);
    say(`gerando análise de ${loja} / ${periodo}…`);
    gerarAnalise(loja, a, mm)
      .then((r) => say(`ok ${loja}/${periodo} (${r.tentativas} tentativa(s), modelo ${r.model})`))
      .catch((e) => say(`falhou ${loja}/${periodo}: ${e.message}`))
      .finally(() => autoLock.delete(key));
  }
}

module.exports = { gerarAnalise, podeGerar, maybeAutoAnalise, MODEL, analiseProfunda };
