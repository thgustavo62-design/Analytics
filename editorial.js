// Fase 12 — Editorial Intelligence. Pauta dos próximos 7 dias.
//
// O PRODUTO de cada dia vem do motor determinístico (Opportunity Score + calendário de
// campanha + do-not-promote). A IA, se houver chave, só ajuda a lapidar hook/CTA — nunca
// escolhe produto nem inventa número. Sem chave, os CTAs saem de templates.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const mpa = require("./marketing-product-analytics");
const campanhas = require("./campanhas");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "intelligence.json"), "utf8")).editorial;
const WD = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const DIA = 86400000;
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);

const ANGULO = {
  HERO: "autoridade / queridinho da loja — mostra que aqui tem e sai barato",
  TRAFEGO: "preço / chamariz — post de oferta direta pra puxar fluxo",
  OPORTUNIDADE: "novidade em alta — 'chegou / está bombando'",
  GIRO_URGENTE: "queima de estoque — oferta relâmpago, prazo curto",
  COMPLEMENTAR: "combo — 'leva os dois' ao lado de um queridinho",
  DEFESA: "comparação de preço — responde ao concorrente sem citar nome",
  PROTEGIDO: "conteúdo educativo (sem preço) — não force venda",
  GIRO: "conteúdo de variedade — lembra que a loja tem de tudo",
};

function ctaTemplate(p, tema) {
  const base = [
    `Passa aqui e garante o seu de ${p.descricao.split(" ").slice(0, 3).join(" ")}.`,
    `${tema}: chama no direct ou vem na loja.`,
    `Estoque limitado — não deixa pra depois.`,
  ];
  return base[Math.floor(Math.random() * base.length)];
}

function planoSemanal(loja, opts = {}) {
  const cfgLoja = LOJAS_CFG[loja] || {};
  const refDate = db.getUltimaDataVenda(loja);
  const inicio = opts.inicio || (refDate ? addDias(refDate, 1) : new Date().toISOString().slice(0, 10));
  const nDias = opts.dias || CFG.dias_plano || 7;
  const porDia = opts.produtos_por_dia || CFG.produtos_por_dia || 3;

  const analise = mpa.analisarProdutos(loja);
  if (analise.erro) return { erro: analise.erro };
  const promoviveis = analise.produtos.filter((p) => !p.do_not_promote);
  const evitarGlobal = analise.produtos.filter((p) => p.do_not_promote).slice(0, 10)
    .map((p) => ({ descricao: p.descricao, motivos: p.do_not_promote.motivos.map((m) => m.texto) }));

  const usados = new Set();
  const pega = (filtro, n) => {
    const out = [];
    for (const p of promoviveis) {
      if (usados.has(p.produto_id ?? p.ean ?? p.descricao)) continue;
      if (!filtro(p)) continue;
      out.push(p);
      usados.add(p.produto_id ?? p.ean ?? p.descricao);
      if (out.length >= n) break;
    }
    return out;
  };

  const dias = [];
  for (let i = 0; i < nDias; i++) {
    const data = addDias(inicio, i);
    const dow = new Date(data + "T12:00:00").getDay();
    const camp = (cfgLoja.campanhas || []).find((c) => (c.dias || []).includes(dow));
    let tema, categorias, escolhidos;
    if (camp) {
      tema = camp.nome;
      categorias = camp.categorias || [];
      escolhidos = pega((p) => categorias.includes(p.categoria), porDia);
      if (escolhidos.length < porDia) escolhidos = escolhidos.concat(pega((p) => categorias.includes(p.categoria) || p.classe === "HERO", porDia - escolhidos.length));
    } else {
      tema = "Conteúdo de variedade";
      categorias = [];
      escolhidos = pega((p) => ["HERO", "OPORTUNIDADE", "TRAFEGO"].includes(p.classe), porDia);
    }
    if (!escolhidos.length) escolhidos = pega(() => true, porDia);

    dias.push({
      data,
      dia_semana: WD[dow],
      tema,
      campanha: camp ? camp.nome : null,
      categorias,
      produtos: escolhidos.map((p) => ({
        ean: p.ean, descricao: p.descricao, categoria: p.categoria, classe: p.classe,
        opportunity: p.opportunity.score, tendencia: p.tendencia.rotulo,
        preco_ref: p.preco_atual ?? p.preco_praticado,
        angulo: ANGULO[p.classe] || ANGULO.GIRO,
        cta_sugestao: ctaTemplate(p, tema),
        evidencia: { campo: "opportunity.score", valor: p.opportunity.score, fonte: "marketing-product-analytics", periodo: analise.refDate },
      })),
    });
  }

  return {
    loja, inicio, dias_plano: nDias, refDate: analise.refDate,
    feeds: analise.feeds, dados_ausentes_globais: analise.dados_ausentes_globais,
    dias,
    evitar: evitarGlobal,
    observacoes: [
      "Produto e ângulo saem do motor determinístico (Opportunity Score + calendário + do-not-promote).",
      "CTAs são sugestões de template — ajuste o tom da loja.",
      analise.feeds.custo ? null : "Sem custo cadastrado: os posts de 'preço' não têm checagem de margem — confira antes de publicar desconto.",
    ].filter(Boolean),
  };
}

module.exports = { planoSemanal };
