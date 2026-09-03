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

### Fase C — Medir o que a campanha realmente fez  ·  pontos 7, 8, 15  ·  ✅ ENTREGUE (2026-09-02)
- ✅ `marketing/campaign-measure.js` + `GET /api/marketing/:loja/campaign-measure` — `medirCampanha(loja, {nome | dias+categorias, janelaDias, investimento})`:
  - **baseline pelo mesmo dia da semana** (fallback "demais dias" quando a campanha ocupa todo o dia-da-semana → `confianca: "baixa"` e caveat explícito)
  - receita / unidades / **lucro incremental** (só com custo) + % sobre baseline
  - **ROAS** e **retorno sobre margem** + break-even (com o campo de investimento)
  - **canibalização** = variação das outras categorias nos dias de campanha → só é medida com baseline do mesmo dia da semana (senão "não medível")
- ✅ Tela: nova aba **Medição** em Marketing — cartão por campanha do calendário com badge de confiança, KPIs de incremento, veredito de canibalização e campo de investimento que recalcula ROAS/retorno.
- ✅ Investimento entra como parâmetro por medição (transiente); persistir em `campanhas.investimento` fica para quando as campanhas viram entidade de verdade.
- ✅ Testes: `test/campaign-measure.test.js` (+9 → 83).
- Nota: para as campanhas recorrentes atuais (ocupam todo o Fri/Sat/Sun ou Seg/Ter) o baseline "mesmo dia da semana" não existe → resultado sai com confiança baixa. Medição de alta confiança precisa de campanhas pontuais (rodadas em algumas semanas só).

### Fase D — Memória de marketing  ·  pontos 9, 10, 14  ·  ✅ ENTREGUE (2026-09-02)
- ✅ `marketing/padroes-mkt.js` + `GET /api/marketing/:loja/playbooks`:
  - `padroesMarketing(loja)` — cada campanha recorrente do calendário, semana a semana: **melhor dia** (Mon vs Ter, comparação relativa → o viés do dia-da-semana se cancela), **tendência do lift** ao longo das ocorrências (melhorando / estável / **piorando = fadiga**, por slope de mínimos quadrados), lift médio (rotulado "indicativo — inclui sazonalidade do dia").
  - `playbooks(loja)` — manual por categoria: melhor dia, dias configurados, tendência, **produtos recomendados** (top por Opportunity, com papel), **ângulo dominante** (Motor de Ângulos), veredito **pela tendência** (não pelo lift absoluto enviesado). Inclui `padroes` e `fadiga`.
  - `fadigaProdutos(loja)` — só produtos **das categorias de campanha**, que **ainda vendem** (`lift_atual > 0` — queda a zero = ruptura/saída de linha, não fadiga), com volume mínimo (≥ 20 un nos dias de campanha) e lift caindo de ≥ 1,25× para < 60 % ao longo de blocos de 30 d → "trocar produto / ângulo / criativo / oferta".
- ✅ Tela: nova aba **Playbooks** em Marketing (cartão por campanha com badge de tendência, barras de lift por dia, veredito, chips de produtos + ângulo; tabela de fadiga).
- ✅ Config: bloco `padroes` em `config/campaign-plan.json`. Testes: `test/padroes-mkt.test.js` (+4 → 87).
- Sem o histórico "faixa de desconto × lift" (as campanhas recorrentes não registram o desconto aplicado por semana) — vem quando as campanhas viram entidade com preço promocional gravado.

### Fase E — Concorrência ofensiva  ·  pontos 11, 12  ·  ✅ ENTREGUE (2026-09-02)
- ✅ `concorrencia-analise` — **`contra_ataque`**: quando um item que a concorrência atacou não dá pra cobrir (margem insuficiente ou quase não vendemos), sugere o melhor produto **da mesma categoria** para promover no lugar (maior Opportunity, margem ≥ piso, cobertura ok, gira). Entra no "onde reagir" e nas ações.
- ✅ **`share_promocoes`** — nossa ação promocional **deliberada** × ofertas do concorrente por categoria → veredito: **subcomunicando** (≥2 ofertas deles abaixo do nosso preço e sem ação nossa), **esforço sem pressão que justifique** (temos campanha, concorrência parada), comunicando forte, equilibrado. Breakdown de ofertas por concorrente. Tabela na aba Concorrentes.
- ✅ Fonte de "nossa ação promocional": a **tabela de planejamento de promoções** (o "tabelão"/encarte — `parsers/promocoes.js`, xlsx/csv na inbox ou no Upload), vigente na data de hoje; fallback = produtos de campanhas cadastradas + calendário recorrente. **Não** usamos a coluna "preço promocional" do feed de estoque (vinha preenchida para o catálogo inteiro — 24 mil "promoções" falsas).
- ✅ Testes: `test/concorrencia-analise.test.js` (+3 → 90).
- Ressalva: o rótulo de categoria da coleta do concorrente ("Bebê") nem sempre bate com o do nosso classificador ("Fraldas") — o cruzamento pode subestimar a cobertura recorrente. Reconciliar rótulos é tarefa de data quality (fase posterior).

### Fase F — Creative Intelligence  ·  pontos 6, 13  ·  **precisa de feed novo**
Bloqueada até existir um **log de publicações**. Duas opções de feed (a decidir):
- planilha/JSON no `inbox/` por post: `data, horário, categoria, produto(s), formato (foto/carrossel/vídeo/stories), layout, cor dominante, headline, oferta, CTA, canal`;
- ou formulário na tela de Upload.
Depois: cruzamento com métricas do Instagram + vendas → Creative Score real (Fase A) + Content Gap (nº de posts por categoria × receita/margem).

### Extra — Precificação de promoção  ·  pontos 1, 2, 3 (aprofundamento)  ·  ✅ ENTREGUE (2026-09-03)
"Qual valor colocar, qual valor testar, quanto de lucro dá, qual produto promover — análise universal pelos dados."
- ✅ `config/elasticidade.json` — elasticidade-preço **em contexto de promoção** por categoria (quantos % as unidades sobem por 1% de desconto), `desconto_teto`, `piso_margem_pct`, `halo_r$_por_unidade`. É **premissa de categoria** enquanto não há histórico de promoções; calibra quando a tabela de promoções tiver janelas passadas.
- ✅ `marketing/promo-pricing.js` + `GET /api/marketing/:loja/promo-pricing`:
  - `precificarProduto(loja, {ean|produto|descricao, dias})` — varre 0..teto, projeta unidades pela elasticidade, devolve **preço recomendado** (maximiza o **lucro incremental do próprio SKU**), **3 preços para testar** (conservador / recomendado / agressivo), **curva lucro×desconto**, **break-even** e desconto máx. sem prejuízo, e compara com a **promoção já planejada** na tabela. O efeito-cesta (`halo`) é exibido mas **não decide** — assim nunca recomenda vender abaixo do que se ganha.
  - `oportunidadesPromo(loja, {n, dias})` — "**o que colocar em promoção**": ranqueia os candidatos A/B pelo lucro incremental da melhor promoção de cada um (horizonte de 30 d para comparação). Produtos sem custo (próprio ou proxy da outra loja) vão para o balde `sem_custo`, ranqueado por receita incremental.
- ✅ Tela: nova aba **Precificação** em Marketing — ranking + busca por produto (curva SVG lucro×desconto, marcadores de recomendado e break-even, tabela dos 3 preços, comparação com a promoção planejada). Testes: `test/promo-pricing.test.js` (+6 → 116).

### Fase G — Calendário e ciclo fechado  ·  pontos 17, 20  ·  ✅ ENTREGUE (2026-09-02)
- ✅ `marketing/calendar.js` + `GET /api/marketing/:loja/calendar?dias=30`:
  - **ocorrências** das campanhas recorrentes nos próximos N dias, cada uma **ajustada**: ruptura na categoria (≥2 produtos ≥ R$300/30d) → `SUSPENDER`; fadiga (≥2 produtos ou Playbooks "piorando") → `RENOVAR` com a lista de SKUs a trocar; esforço sem pressão (Share of Promotions) → `REVISAR`. `papel_do_dia` (CHAMARIZ no melhor dia, HERO/MARGEM o período todo).
  - **slots sugeridos**: `DEFESA` (categoria onde a concorrência está abaixo do nosso preço e não temos campanha) e `OPORTUNIDADE` (categoria forte no Command Center sem campanha).
  - **digest semana a semana** + **ciclo fechado** por campanha: última Medição (C) + padrão (D) + fadiga → `recomendacao_proxima` (manter / concentrar no melhor dia / renovar / adiar) + link `campaign-plan` para montar.
- ✅ Tela: nova aba **Calendário** em Marketing. Config: bloco `calendario` em `config/campaign-plan.json`. Testes: `test/calendar.test.js` (+4 → 94).

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

**Fases A–E e G entregues** (2026-09-02) — 6 das 7. Falta só a **F** (Creative Intelligence +
Content Gap), **bloqueada** até existir o **log de publicações**: um registro por post com
`data, horário, categoria, produto(s), formato (foto/carrossel/vídeo/stories), layout, cor
dominante, headline, oferta, CTA, canal`. Duas formas de alimentar (a decidir): uma
planilha/JSON por post na pasta `inbox/`, ou um formulário na tela de Upload. Com esse feed:
Creative Score real no Command Center + Content Gap (nº de posts por categoria × receita/margem).
