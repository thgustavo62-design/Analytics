// Lê um PRINT (screenshot) de Instagram / Meta e extrai os números — via Claude com visão.
// Opt-in: só roda se ANTHROPIC_API_KEY estiver no ambiente. Nunca inventa: campo não visível = null.
//
//   ativo()                       -> tem chave configurada?
//   lerPrint(caminhoDaImagem)     -> { tipo, periodo_texto, data_ini, data_fim, conta, trafego_pago, modelo }
//
// tipo: 'conta' (resumo/insights da conta) | 'trafego_pago' (Gerenciador de Anúncios) | 'desconhecido'

const fs = require("fs");
const path = require("path");

const MODEL = process.env.SOCIAL_VISION_MODEL || "claude-sonnet-5";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function ativo() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// "1,2 mil" -> 1200 ; "1.234" -> 1234 ; "12,3 mi" -> 12300000 ; "R$ 1.234,56" -> 1234.56 ; "3,4%" -> 3.4
function numBR(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().toLowerCase().replace(/r\$|\s|%/g, "");
  if (!s || s === "-" || s === "—") return null;
  let mult = 1;
  if (/mil$/.test(s)) { mult = 1e3; s = s.replace(/mil$/, ""); }
  else if (/(mi|milh(o|ões|oes))$/.test(s)) { mult = 1e6; s = s.replace(/(mi|milh(o|ões|oes))$/, ""); }
  else if (/(bi|bilh(o|ões|oes))$/.test(s)) { mult = 1e9; s = s.replace(/(bi|bilh(o|ões|oes))$/, ""); }
  // pt-BR: vírgula = decimal, ponto = milhar. Sem vírgula: "1.234" e "1.234.567" são milhar;
  // só tratamos "N.NN" (1–2 casas) como decimal (ex.: um CPC "0.85" que escapou do formato pt-BR).
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

const PROMPT = `Você extrai dados de um screenshot do Instagram ou do Meta (Gerenciador de Anúncios / Meta Business Suite).
Regras:
- Só reporte o que está VISÍVEL na imagem. Qualquer número que não aparece = null. Nunca estime.
- Números em pt-BR: "1,2 mil" = 1200; "1.234" = 1234; "12,3 mi" = 12300000; "R$ 1.234,56" = 1234.56.
- Percentuais de variação: mantenha o sinal (ex.: "+64,7%" = 64.7, "−12%" = -12).
- Se houver um intervalo de datas ("1–30 de set", "Últimos 30 dias"), preencha data_ini/data_fim em AAAA-MM-DD quando der para inferir o ano; senão deixe null e escreva o texto em periodo_texto.

Responda SÓ com JSON, sem cercas de código, neste formato:
{
  "tipo": "conta" | "trafego_pago" | "desconhecido",
  "periodo_texto": string|null,
  "data_ini": "AAAA-MM-DD"|null,
  "data_fim": "AAAA-MM-DD"|null,
  "conta": {
    "visualizacoes":   {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null},
    "alcance":         {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null},
    "interacoes":      {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null},
    "visitas_perfil":  {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null},
    "cliques_link":    {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null},
    "seguidores":      {"valor": number|null, "valor_texto": string|null, "delta_pct": number|null}
  },
  "trafego_pago": {
    "investimento": number|null, "impressoes": number|null, "alcance": number|null,
    "cliques": number|null, "ctr_pct": number|null, "cpc": number|null, "cpm": number|null,
    "resultados": number|null, "tipo_resultado": string|null, "custo_por_resultado": number|null,
    "campanha": string|null, "plataforma": string|null, "moeda": string|null
  }
}
- "conta": tela de Insights / Visão geral da conta (visualizações, alcance, interações, visitas ao perfil, cliques no link, seguidores).
- "trafego_pago": tela de anúncios com investimento/gasto, impressões, CPC, CPM, CTR, resultados, custo por resultado.
- Preencha só o bloco do tipo identificado; o outro pode vir com tudo null.`;

async function lerPrint(filePath) {
  if (!ativo()) {
    const e = new Error("ANTHROPIC_API_KEY não configurada — não dá para ler prints automaticamente. Ponha a chave no .env, ou use o formulário do Instagram na tela de Upload.");
    e.code = "SEM_CHAVE";
    throw e;
  }
  const ext = path.extname(filePath).toLowerCase();
  const media_type = MIME[ext];
  if (!media_type) throw new Error(`imagem não suportada (${ext}) — use png, jpg ou webp.`);
  const b64 = fs.readFileSync(filePath).toString("base64");

  const AnthropicNS = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicNS.default || AnthropicNS;
  const client = new Anthropic();

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: "Você é um extrator de dados preciso. Só devolve JSON válido, sem comentários.",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data: b64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    });
  } catch (err) {
    const st = err && err.status;
    if (st === 401 || st === 403) { const e = new Error("ANTHROPIC_API_KEY inválida ou sem acesso ao modelo."); e.code = "SEM_CHAVE"; throw e; }
    if (st === 429) throw new Error("a API da Anthropic está limitando (rate limit) — tente de novo em alguns minutos.");
    if (st === 404) throw new Error(`modelo "${MODEL}" não encontrado nesta conta — ajuste SOCIAL_VISION_MODEL.`);
    throw new Error(`falha ao chamar a API de visão: ${err.message}`);
  }

  const txt = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const jsonStr = txt.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let raw;
  try {
    raw = JSON.parse(jsonStr.slice(jsonStr.indexOf("{"), jsonStr.lastIndexOf("}") + 1));
  } catch (e) {
    throw new Error("o motor de visão não devolveu JSON válido: " + txt.slice(0, 200));
  }

  const tipo = ["conta", "trafego_pago", "desconhecido"].includes(raw.tipo) ? raw.tipo : "desconhecido";
  const conta = {};
  for (const k of ["visualizacoes", "alcance", "interacoes", "visitas_perfil", "cliques_link", "seguidores"]) {
    const c = (raw.conta && raw.conta[k]) || {};
    conta[k] = {
      valor: numBR(c.valor != null ? c.valor : c.valor_texto),
      valor_texto: c.valor_texto != null ? String(c.valor_texto) : (c.valor != null ? String(c.valor) : null),
      delta_pct: numBR(c.delta_pct),
    };
  }
  const tp = raw.trafego_pago || {};
  const trafego_pago = {
    investimento: numBR(tp.investimento), impressoes: numBR(tp.impressoes), alcance: numBR(tp.alcance),
    cliques: numBR(tp.cliques), ctr_pct: numBR(tp.ctr_pct), cpc: numBR(tp.cpc), cpm: numBR(tp.cpm),
    resultados: numBR(tp.resultados), tipo_resultado: tp.tipo_resultado || null,
    custo_por_resultado: numBR(tp.custo_por_resultado), campanha: tp.campanha || null,
    plataforma: tp.plataforma || null, moeda: tp.moeda || null,
  };

  return {
    tipo,
    periodo_texto: raw.periodo_texto || null,
    data_ini: raw.data_ini || null,
    data_fim: raw.data_fim || null,
    conta, trafego_pago,
    modelo: MODEL,
    _bruto: raw,
  };
}

module.exports = { ativo, lerPrint, numBR, MODEL };
