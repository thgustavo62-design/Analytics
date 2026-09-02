# Marketing Command Center — plano de evolução

> Resposta ao brief de 20 pontos (2026-09-02). Mapeia cada ponto contra o que já existe
> no código, marca esforço e dependência de dado, e propõe uma ordem de construção em 7 fases.
> **Nada aqui reconstrói o que funciona** — tudo é camada nova ou recombinação do que a
> [`SISTEMA.md`](../SISTEMA.md) já descreve.

---

## O princípio

A primeira tela não abre com gráfico. Abre com **"o que o marketing deve fazer hoje"**:
um plano executável (produto → papel → oferta → ângulo → canal → risco), com o "não anunciar"
do lado, cada linha com motivo e evidência. Todo o resto do brief serve a esse ciclo:

```
dados → oportunidade → produto → papel → público → oferta → ângulo → criativo
      → canal → campanha → venda → incrementalidade → margem → aprendizado → próxima campanha
```

Hoje o sistema cobre bem `dados → oportunidade → produto` e parte de `campanha → venda`.
O que falta é o meio (papel/oferta/ângulo/criativo/canal) e o fim (incrementalidade de
campanha inteira → margem → aprendizado de marketing).

---

## Mapa: os 20 pontos × estado atual

| # | Ponto | Já existe | O que falta | Esforço | Depende de |
|---|---|---|---|---|---|
| 1 | **Marketing Command Center** (tela "o que fazer hoje") | `recommended-products`, `do-not-promote`, War Room | tela única + plano do dia consolidado das 2 lojas | M | — |
| 2 | **Scores derivados** (Campaign / Traffic / Profit / Clearance / Creative) | Opportunity Score (7 componentes ponderados) | recombinar os componentes em 4 sub-scores nomeados; Creative Score é novo | S (4) / L (Creative) | Creative → feed de posts |
| 3 | **Papel fixo por produto** (CHAMARIZ/TRÁFEGO/HERO/MARGEM/COMPLEMENTAR/DESOVA/RECORRÊNCIA/IMAGEM) | classes HERO/TRAFEGO/GIRO_URGENTE/COMPLEMENTAR/… (por produto) e papéis de campanha (CHAMARIZ/HERO/MARGEM/…) | unificar: todo produto recebe 1 papel primário + secundários, com regra explícita | M | recorrência precisa de nº de cupons repetidos por cliente |
| 4 | **Campaign Builder 2.0** (campanha inteira: datas, combos, evitar, margem prevista, estoque necessário, potencial, risco, score) | `campaign-builder` (elenco por papel) | objeto campanha completo + score da campanha + lista de evitar + necessidade de estoque | L | #3, #16, #18 |
| 5 | **Motor de Ângulos** (preço/urgência/volume/conveniência/comparação/recorrência) | `editorial.js` (ângulo vem do motor, CTA é template) | biblioteca de ângulos config-driven + escolha por dado (margem→preço, cobertura baixa→urgência, cesta→volume, conc.→comparação) | M | — |
| 6 | **Creative Intelligence** (metadados do post × alcance/salvamento/clique/venda → aprendizado) | detector `CREATIVE_FATIGUE` | módulo inteiro: log de criativo (layout, cor, headline, formato, horário) + cruzamento + padrões | L | **feed novo: log de publicações** |
| 7 | **Marketing → Venda** (ROAS, ROI sobre margem, receita/lucro incremental) | `campaign-efficiency` (DEMAND_LIFT dias-c/-campanha × resto) | investimento preenchido + receita relacionada/incremental + lucro incremental + ROAS + ROI-margem | M | `campanhas.investimento` preenchido; custo |
| 8 | **"Vendeu ou pegou venda que já aconteceria?"** (baseline vs campanha, +N incremental) | incrementalidade intradiária em `analytics-deep` | baseline por produto (mesmo dia da semana) × período de campanha → incremento provável, na frente do usuário | M | — |
| 9 | **Aprendizado por campanha** (dia × desconto × lift, por repetição) | Decision Journal + `padroes.js` (genérico) | motor de padrões **de marketing**: agrega campanhas repetidas do mesmo produto/categoria | M | histórico de ≥3 campanhas comparáveis |
| 10 | **Playbooks por categoria** (melhor dia/duração/tipo/canal/lift médio) | — | tela derivada de #9: manual por categoria | M | #9 |
| 11 | **Concorrência → Campanha** (reagir, mas com produto B) | `concorrencia-analise` (`onde_reagir`, pressão, categorias atacadas) | decisão de contra-ataque: se produto atacado inviabiliza margem, sugerir alternativo da categoria | M | — |
| 12 | **Share of Promotions** (nossas ofertas × concorrência, por categoria) | contagem de ofertas de concorrente por categoria | contabilizar **nossas** promoções (campanha_produtos + preço promocional) e comparar; "subcomunicando Bebê" | M | histórico das nossas promoções |
| 13 | **Content Gap** (nº de posts por categoria × faturamento/margem/estoque) | — | precisa do log de posts; cruza com receita/margem → "genérico é 18% da venda e 3% da comunicação" | M | **feed novo: log de publicações** |
| 14 | **Product Fatigue** (produto anunciado N× com performance decrescente) | `CREATIVE_FATIGUE` (criativo) | fadiga do **produto**: nº de campanhas em 30d + lift decrescente → trocar produto/ângulo | M | #9 |
| 15 | **Canibalização** (A sobe, B da mesma categoria cai, líquido ~0) | — | durante campanha de A: lift de A × delta dos demais SKUs da categoria → incremento líquido | M | — |
| 16 | **Combos inteligentes** (par + lift + margem combinada + estoque + ação) | `basket` (support/confidence/lift, `combos()`) | filtro de margem+estoque, descartar combo óbvio/ruim, moldura de marketing | S | — |
| 17 | **Marketing Calendar inteligente** (próximos 30 dias, ajustável por estoque/conc./venda/sazonalidade) | campanhas recorrentes em `lojas.json` | calendário sugerido dinâmico + regra de suspender (ex.: categoria em ruptura) | L | #3–#11 |
| 18 | **Marketing Forecast** (campanha inteira: conservador/provável/agressivo + estoque depois + margem incremental) | `offer-simulator` (3 cenários por oferta) | elevar de oferta única para campanha inteira + projeção de estoque final | M | #4 |
| 19 | **"O que anunciar hoje?" ranqueado + "o que NÃO"** | `recommended-products` + `do-not-promote` (listas) | apresentação lado a lado, ranqueada, cada linha com motivos + score — é o miolo do #1 | S | #1 |
| 20 | **Ciclo fechado** (…→ aprendizado → próxima campanha) | Decision Journal, Pattern Engine, closed-loop genérico | amarrar campanha → resultado medido → padrão de marketing → sugestão da próxima | M | #7, #9, #17 |

Esforço: **S** ≈ 1 sessão · **M** ≈ 2–3 · **L** ≈ 4+.

---

## Ordem proposta (7 fases)

### Fase A — A tela e a base de decisão  ·  pontos 1, 2, 3, 19
O que entrega valor primeiro e não depende de feed novo.
- `marketing/roles.js` — papel primário + secundários por produto (regra explícita, config em `config/marketing-roles.json`).
- `marketing/scores.js` — Traffic / Profit / Clearance / Campaign Score a partir dos 7 componentes que já existem (Creative Score fica `null` + flag até a Fase F).
- Rota `GET /api/marketing/:loja/command-center` — plano do dia: N recomendados (ranqueados, com motivos + score + papel + ação sugerida) + M "não anunciar" (com motivo: ruptura/margem/cobertura) + alertas.
- Tela **Command Center** como primeira aba de Marketing (ou nova entrada na sidebar acima de Painel), consolidando as 2 lojas.
- Testes: papel é determinístico; score sub-componentes somam coerente; "não anunciar" nunca lista item em ruptura como recomendado.

### Fase B — Da lista ao plano executável  ·  pontos 4, 5, 16, 18
- `marketing/angulos.js` + `config/angulos.json` — biblioteca (preço/urgência/volume/conveniência/comparação/recorrência) e seleção por dado.
- `combos()` ganha filtro de margem+estoque e descarte de combo óbvio/ruim.
- Campaign Builder 2.0: `montarCampanha({loja, dias, tema?})` → objeto completo (elenco por papel com preço sugerido, combos, lista de evitar, estoque necessário, margem/potencial/risco previstos, score da campanha 0–100) + Forecast da campanha inteira (3 cenários + estoque final).
- Tela: "Montar campanha" vira o builder 2.0; resultado exportável.

### Fase C — Medir o que a campanha realmente fez  ·  pontos 7, 8, 15
- Baseline por produto por **mesmo dia da semana**; janela de campanha × baseline → incremento provável (+N).
- `campaign-efficiency` ganha: receita relacionada, receita/lucro incremental, ROAS, **ROI sobre margem**, e canibalização (delta líquido da categoria).
- Exige `campanhas.investimento` preenchido — UI para lançar investimento por campanha.

### Fase D — Memória de marketing  ·  pontos 9, 10, 14
- `marketing/padroes-mkt.js` — agrega campanhas repetidas (produto/categoria) → dia-da-semana × faixa de desconto × lift, com significância mínima.
- Tela **Playbooks** por categoria (melhor dia/duração/tipo/canal/lift médio).
- Product Fatigue: nº de campanhas em 30d + lift decrescente → recomendação de troca.

### Fase E — Concorrência ofensiva  ·  pontos 11, 12
- `concorrencia-analise` ganha decisão de **contra-ataque com produto alternativo** quando o SKU atacado inviabiliza margem.
- **Share of Promotions**: contabiliza nossas promoções (campanha_produtos / preço promocional) × ofertas de concorrente por categoria nos últimos 30d → "subcomunicando Bebê / esforço demais em Beleza".

### Fase F — Creative Intelligence  ·  pontos 6, 13  ·  **precisa de feed novo**
Bloqueada até existir um **log de publicações**. Duas opções de feed (a decidir):
- planilha/JSON no `inbox/` por post: `data, horário, categoria, produto(s), formato (foto/carrossel/vídeo/stories), layout, cor dominante, headline, oferta, CTA, canal`;
- ou formulário na tela de Upload.
Depois: cruzamento com métricas do Instagram + vendas → Creative Score real (Fase A) + Content Gap (nº de posts por categoria × receita/margem).

### Fase G — Calendário e ciclo fechado  ·  pontos 17, 20
- **Marketing Calendar**: próximos 30 dias sugeridos, ajustando por estoque/concorrência/venda/campanhas anteriores/sazonalidade; regra de suspender (categoria em ruptura).
- **Closed loop de marketing**: campanha → resultado medido (Fase C) → padrão (Fase D) → entra como recomendação da próxima campanha e do calendário.

---

## Dependências de dado (o que destrava mais)

| Feed | Destrava | Como |
|---|---|---|
| `campanhas.investimento` preenchido | Fase C inteira (ROAS, ROI-margem) | UI de lançamento por campanha, ou coluna na planilha |
| Custo por produto (já suportado) | Profit Score, lucro incremental, margem de combo | manter a planilha de estoque+custo atualizada |
| **Log de publicações** (não existe) | Fase F inteira + Creative Score + Content Gap + Share of Promotions completo | definir planilha/form (ver Fase F) |
| Histórico de ≥3 campanhas comparáveis | Fases D e G (aprendizado) | acumula com o uso; o registro de campanhas já existe |

---

## Recomendação

Começar pela **Fase A**. Ela entrega a tela que o brief pede como nº 1, usa só dado que já
temos, e vira a moldura onde as fases B–G encaixam. Em paralelo, definir o **log de
publicações** (Fase F) para o dado começar a acumular — é o único gargalo de meses, não de
código.
