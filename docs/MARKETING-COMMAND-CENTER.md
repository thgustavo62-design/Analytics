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

### Fase A — A tela e a base de decisão  ·  pontos 1, 2, 3, 19  ·  ✅ ENTREGUE (2026-09-02)
O que entrega valor primeiro e não depende de feed novo.
- ✅ `marketing/roles.js` — papel primário + secundários por produto (regra explícita, config `config/marketing-roles.json`): CHAMARIZ / TRÁFEGO / HERO / MARGEM / COMPLEMENTAR / DESOVA / RECORRÊNCIA / IMAGEM / GIRO, com força 0..1, racional e confiança (RECORRÊNCIA e IMAGEM são proxies, confiança 0.45).
- ✅ `marketing/scores.js` — `traffic_score`, `profit_score` (null sem custo), `clearance_score` (null sem estoque), `campaign_score` (Opportunity, cortado se do-not-promote), `creative_score` (**null** até a Fase F) + interpretação em texto.
- ✅ `GET /api/marketing/:loja/command-center` — plano do dia: `anunciar[]` (ranqueado por Opportunity, com papel + ação + 3 motivos com evidência + sub-scores) + `nao_anunciar[]` (motivo curto + motivos + substituto) + `alertas[]` (ruptura com venda relevante ≥ R$ 80/30d, categoria sob ataque, capital parado, feed faltando). Publicado no site (`coletar-tudo` + `supabase-sync`).
- ✅ Tela **Command Center** — nova entrada na sidebar, **virou a tela de abertura** (`#command`); Painel segue no menu. Mobile: cards com mini-barras de sub-score.
- ✅ Testes: `test/command-center.test.js` (+10, total 63) — papel determinístico, sub-scores honestos (null sem feed), plano ranqueado com evidência, pseudo-produtos fora.
- Pendente dentro da fase: visão **consolidada das 2 lojas** numa só tela (hoje é por loja via seletor).

### Fase B — Da lista ao plano executável  ·  pontos 4, 5, 16, 18  ·  ✅ ENTREGUE (2026-09-02)
- ✅ `marketing/angulos.js` + `config/angulos.json` — pontua PREÇO / URGÊNCIA / VOLUME / CONVENIÊNCIA / COMPARAÇÃO / RECORRÊNCIA a partir de dado real (desconto planejado, folga de margem, papel, janela curta, pressão de concorrência) → ângulo primário + ranking + sugestão de copy.
- ✅ `basket.combos()` ganhou `viavel` + `motivo_inviavel` + `qualidade` (piso de margem combinada, perna em ruptura, "dois heroes da mesma categoria" = óbvio) + filtro `apenasViaveis`; `ehLixo` agora pega "TAXA DE ENTREGA …" por prefixo.
- ✅ `marketing/campaign-builder.js` + `config/campaign-plan.json` — `montarCampanha(loja, {dias, tema, categorias})`: janela contígua, elenco por papel (Fase A) com **preço sugerido** (desconto-alvo por papel, reduzido se furar o piso de margem), **ângulo** e **forecast por perna** (baseline vmd × dias × lift da categoria, 3 cenários, estoque necessário/depois), combos viáveis, lista de evitar, **forecast da campanha inteira** e **score 0–100** (cobertura de papéis + margem prevista + estoque + força da âncora, com confiança).
- ✅ Rotas `GET|POST /api/marketing/:loja/campaign-plan`; publicado no site (`coletar-tudo`).
- ✅ Tela: "Montar campanha" virou o builder 2.0 (dias da semana + tema → campanha com score, cards por papel, forecast, combos, briefing).
- ✅ `roles.js` ganhou pisos absolutos de volume (HERO ≥ R$120/30d, TRÁFEGO ≥ 10 cupons, CHAMARIZ ≥ 8) — vale também para a Fase A.
- ✅ Testes: `test/campaign-builder.test.js` (+11 → 74).

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

**Fases A e B entregues** (2026-09-02). Próximo passo: **Fase C** — medir o que a campanha
realmente fez (baseline por mesmo dia da semana → incremento provável, ROAS, ROI-sobre-margem,
canibalização). Precisa de uma UI para lançar o **investimento por campanha**
(`campanhas.investimento`) — é o único dado que falta para o ROAS/ROI. Em paralelo, definir o
**log de publicações** (Fase F), o único gargalo de meses.
