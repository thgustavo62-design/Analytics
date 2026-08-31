// Motor de insights: regras automáticas sobre os dados já agregados. Sem texto livre de
// LLM — cada card sai de uma função determinística. Limiares em config/insights.json.

const fs = require("fs");
const path = require("path");

const CFG_PATH = path.join(__dirname, "config", "insights.json");
const WEEKDAY_LABEL = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function cfg() {
  return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
}

function brl(v) {
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function weekdayOf(isoDate) {
  return new Date(isoDate + "T12:00:00").getDay();
}

/**
 * @param {object} agg   saída de aggregate()
 * @param {{ diasCampanha?: number[], campanhaNome?: string }} loja
 */
function gerarInsights(agg, loja = {}) {
  const c = cfg();
  const cards = [];
  const diasCompletos = agg.daily.filter((d) => !d.parcial);
  const media = agg.kpis.mediaDiaria;

  // 1 · Dia de pico
  if (diasCompletos.length >= 3 && media > 0) {
    const pico = diasCompletos.reduce((a, b) => (b.v > a.v ? b : a));
    const razao = pico.v / media;
    if (razao >= 1 + c.picoDia.acimaDaMediaPct) {
      const wd = WEEKDAY_LABEL[weekdayOf(pico.data)];
      cards.push({
        icon: "◆",
        title: `Dia ${pico.d} (${wd}) foi o pico do mês`,
        body:
          `${brl(pico.v)} em ${pico.n.toLocaleString("pt-BR")} vendas — ${razao.toFixed(1).replace(".", ",")}x a média diária ` +
          `(${brl(media)}). Vale confirmar se cai em data de pagamento de salário ou benefício na cidade; ` +
          `se for recorrente, é um dia para reforçar equipe e estoque.`,
      });
    }
  }

  // 2 · Dias de campanha vs. resto da semana
  const dc = Array.isArray(loja.diasCampanha) ? loja.diasCampanha : [];
  if (dc.length && diasCompletos.length >= 6) {
    const camp = diasCompletos.filter((d) => dc.includes(weekdayOf(d.data)));
    const resto = diasCompletos.filter((d) => !dc.includes(weekdayOf(d.data)));
    if (camp.length >= 2 && resto.length >= 2) {
      const mCamp = camp.reduce((s, d) => s + d.v, 0) / camp.length;
      const mResto = resto.reduce((s, d) => s + d.v, 0) / resto.length;
      const dif = mResto > 0 ? (mCamp - mResto) / mResto : 0;
      const nome = loja.campanhaNome || "a campanha própria";
      if (Math.abs(dif) < c.campanhaVsResto.diferencaMinimaPct) {
        cards.push({
          icon: "◆",
          title: `${loja.campanhaNome ? loja.campanhaNome.split(" (")[0] : "Campanha própria"} não muda o patamar do dia`,
          body:
            `Média dos dias de ${nome}: ${brl(mCamp)}. Média do resto da semana: ${brl(mResto)} — diferença de ` +
            `${(dif * 100).toFixed(1).replace(".", ",")}%, dentro do ruído. Vale medir se a campanha puxa fluxo ` +
            `incremental ou apenas mantém o ritmo normal da loja (comparar participação da categoria no dia, não o total).`,
        });
      } else if (dif >= c.campanhaVsResto.diferencaMinimaPct) {
        cards.push({
          icon: "◆",
          title: `Dias de ${nome} faturam ${(dif * 100).toFixed(0)}% acima do resto da semana`,
          body:
            `Média nesses dias: ${brl(mCamp)} vs. ${brl(mResto)} nos demais. O sinal é positivo — confirme com a ` +
            `margem incremental da categoria (faturar mais no dia não garante lucro maior se o desconto pega toda a base).`,
        });
      }
    }
  }

  // 3 · Categoria "Diversos" acima do limite
  if (agg.diversos.pct > c.diversos.participacaoMaximaPct) {
    const n = agg.extras.diversos ? agg.extras.diversos.n : null;
    cards.push({
      icon: "◆",
      title: `${brl(agg.diversos.valor)} saíram como "Diversos"`,
      body:
        `${(agg.diversos.pct * 100).toFixed(1).replace(".", ",")}% do faturamento` +
        (n ? ` (${n.toLocaleString("pt-BR")} lançamentos)` : "") +
        ` entraram sem descrição de produto — itens fracionados ou sem cadastro. ` +
        `É dinheiro sem rastro de estoque nem de margem; vale auditar o que está sendo vendido assim.`,
    });
  }

  return cards;
}

module.exports = { gerarInsights };
