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

const zeros = (s) => !s || /^0+$/.test(String(s).trim());

/**
 * @param {object} agg   saída de aggregate()
 * @param {{ diasCampanha?: number[], campanhaNome?: string }} loja
 * @param {Array} vendas  linhas de vendas_transacoes (para concentração por cliente/convênio)
 */
function gerarInsights(agg, loja = {}, vendas = null) {
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

  // 2 · Cada campanha própria vs. resto da semana
  const campanhas = Array.isArray(loja.campanhas) ? loja.campanhas : [];
  if (diasCompletos.length >= 6) {
    for (const camp of campanhas) {
      const dias = Array.isArray(camp.dias) ? camp.dias : [];
      if (!dias.length) continue;
      const emCamp = diasCompletos.filter((d) => dias.includes(weekdayOf(d.data)));
      const resto = diasCompletos.filter((d) => !dias.includes(weekdayOf(d.data)));
      if (emCamp.length < 2 || resto.length < 2) continue;
      const mCamp = emCamp.reduce((s, d) => s + d.v, 0) / emCamp.length;
      const mResto = resto.reduce((s, d) => s + d.v, 0) / resto.length;
      const dif = mResto > 0 ? (mCamp - mResto) / mResto : 0;
      const nome = camp.nome || "campanha própria";
      const curto = nome.split(" (")[0];
      if (Math.abs(dif) < c.campanhaVsResto.diferencaMinimaPct) {
        cards.push({
          icon: "◆",
          title: `${curto} não muda o patamar do dia`,
          body:
            `Média dos dias de ${nome.toLowerCase()}: ${brl(mCamp)}. Resto da semana: ${brl(mResto)} — diferença de ` +
            `${(dif * 100).toFixed(1).replace(".", ",")}%, dentro do ruído. A campanha mantém o ritmo, não puxa fluxo extra ` +
            `mensurável (o que decide é a margem incremental de ${(camp.categorias || []).join("/")}, não o total do dia).`,
        });
      } else if (dif >= c.campanhaVsResto.diferencaMinimaPct) {
        cards.push({
          icon: "◆",
          title: `Dias de ${curto} faturam ${(dif * 100).toFixed(0)}% acima do resto da semana`,
          body:
            `${brl(mCamp)} vs. ${brl(mResto)} nos demais. Sinal positivo — confirme com a margem incremental de ` +
            `${(camp.categorias || []).join("/")} (faturar mais no dia não garante lucro se o desconto pega toda a base).`,
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

  // 4 · Concentração de faturamento numa conta única (cliente ou convênio) > 5%
  if (Array.isArray(vendas) && vendas.length) {
    const total = vendas.reduce((s, r) => s + r.valor_liquido, 0);
    for (const [campo, rotulo] of [["emp_id", "convênio"], ["cli_id", "cliente"]]) {
      const acc = new Map();
      for (const r of vendas) {
        if (zeros(r[campo])) continue;
        acc.set(r[campo], (acc.get(r[campo]) || 0) + r.valor_liquido);
      }
      if (!acc.size) continue;
      const [id, val] = [...acc.entries()].sort((a, b) => b[1] - a[1])[0];
      const pct = val / total;
      if (pct > 0.05) {
        const lancs = new Set(vendas.filter((r) => r[campo] === id).map((r) => r.lancamento)).size;
        cards.push({
          icon: "◆",
          title: `Uma conta de ${rotulo} concentra ${(pct * 100).toFixed(1).replace(".", ",")}% do faturamento`,
          body:
            `A conta ${rotulo} ${id} respondeu por ${brl(val)} em ${lancs.toLocaleString("pt-BR")} cupons no mês. ` +
            `Acima de 5% num único ${rotulo} é risco material — se essa conta some, o mês vira. ` +
            `Confira o mix (centenas de cupons não é uma pessoa: é convênio, rota de entrega ou instituição).`,
        });
        break; // um card de concentração basta
      }
    }
  }

  return cards;
}

module.exports = { gerarInsights };
