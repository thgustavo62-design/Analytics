# Auditoria + plano — Analytics → Decision Intelligence

Resposta ao brief de evolução. **Antes de qualquer código**, conforme pedido (§55).

> **TL;DR** — cerca de **70% do brief já existe** (foi construído nas últimas iterações):
> Ontology, knowledge graph, Opportunity Score configurável com breakdown, Alert/Signal
> Engine com severidade, Recommendation Engine, "o que anunciar / não anunciar", Concorrência
> com pressão competitiva, Decision Journal, closed-loop (Pattern Engine), "Por quê?",
> Ask Analytics com funções internas, evidências, data freshness, simulador de oferta.
> **O que falta de verdade:** Forecast Engine, Meta Engine, valor financeiro em risco/potencial
> consolidado, ABC, Data Quality, Benchmark entre lojas, Audit Log completo, e — o maior — a
> **nova Home (Central de Decisão)** e o **acabamento visual "corporativo"**.

---

## 1. Arquitetura atual

```
Ingestão            watcher.js (chokidar em inbox/) + ingest.js (dispatcher por extensão/nome)
                    + rotas /upload/* (upload manual, mesmo caminho)
Parsers             parsers/vendas.js (PDF Analítico), parsers/concorrentes.js (xlsx flexível),
                    parsers/instagram.js ; catalogo.js (planilha estoque+custo+preço)
Banco               db.js (node:sqlite, DatabaseSync) + schema.sql (25 tabelas, migrations
                    idempotentes no boot). Tudo por loja_id / periodo_id — as 2 lojas nunca somam.
Camada determinística
  aggregate.js          KPIs, série diária, dia-da-semana, categorias, top produtos
  analytics-deep.js     ticket mediano, baseline semanal c/ desvio, incrementalidade de campanha,
                        canais convênio/delivery/balcão, concentração cliente/convênio
  classify.js           categoria por palavra-chave (config/categorias.json)
  insights.js           3 regras -> cards
  marketing-product-analytics.js  Fase 2: janelas 7-90d, tendência, days-of-cover, margem,
                        classes (HERO/TRAFEGO/...), Opportunity Score (7 componentes + breakdown
                        + confiança), do-not-promote, substituição, estoque parado
  campanhas.js          eficiência do calendário (DEMAND_LIFT), Campaign Builder, Offer Simulator
  basket.js             cesta (support/confidence/lift), centralidade, combos
  analise-cruzada.js    vendas × estoque × custo × margem -> resultado por produto, matriz
                        (vaca leiteira / isca cara / peso morto / aposta / sumindo / ruptura),
                        lucro estimado, capital parado, custo suspeito
  concorrencia-analise.js  panorama, por concorrente (pressão + categorias atacadas),
                        por categoria (pressão ALTA/MÉDIA/BAIXA), "onde reagir" priorizado
Camada de inteligência (Fases 5-12)
  intelligence/contexto.js    pacote determinístico da loja
  intelligence/detectores.js  11 detectores (COMPETITOR_PRICE_ATTACK, CATEGORY_DECLINE/GROWTH,
                        STOCK_RISK, STAGNANT_STOCK, CAMPAIGN_UNDER/OVERPERFORMANCE, DEMAND_ANOMALY,
                        CROSS_SELL/MARKETING_OPPORTUNITY, CREATIVE_FATIGUE, CONTRADICTION)
  intelligence/priorizacao.js Priority Engine 0..100 (severidade, confiança, impacto, recência,
                        acionabilidade)
  intelligence/index.js       rodarDeteccao (dedupe/reabre/resolve) + warRoom
  intelligence/decisao.js     cruza sinais -> decisões recomendadas (playbooks) + evidências
  intelligence/investigar.js  "Por quê?" — biblioteca de hipóteses por assunto
  intelligence/ontologia2.js  persiste o grafo (nodes/edges com força/confiança/temporalidade)
  intelligence/padroes.js     Pattern Engine — aprende de decisão + resultado
  ontologia.js                grafo da tela Conexões (loja/categoria/canal/campanha/concorrente/sinal)
  ask.js                      Ask Analytics — contexto agregado -> resposta formato analista
  editorial.js                pauta de 7 dias
Camada IA (opt-in ANTHROPIC_API_KEY)   motor.js (Análise Comercial mensal), ask.js (narração)
Publicação          coletar-tudo.js -> publicar.js (analytics.html autocontido) +
                    supabase-sync.js (UPSERT em analytics_snapshots). Sites: Vercel + GitHub
                    Pages (estáticos, leem ao vivo do Supabase via PostgREST, fallback assado).
Frontend            public/ — index.html (app shell) + app.js (~1900 linhas, vanilla, SVG à mão)
                    + styles.css. Telas: Painel, Marketing (9 abas), Concorrentes, Intelligence
                    (8 abas), Conexões, Análise Comercial, Upload, Histórico, Configurações.
```

## 2. Banco atual (`data/analytics.db`, SQLite via `node:sqlite`)

25 tabelas, todas com migration idempotente no boot (`CREATE TABLE IF NOT EXISTS` +
`ALTER TABLE ... ADD COLUMN` em try/catch).

## 3. Tabelas

| Grupo | Tabelas |
|---|---|
| Núcleo | `lojas`, `periodos`, `vendas_transacoes`, `instagram_metricas`, `concorrencia_ofertas` |
| Catálogo (Fase 1) | `produtos` (EAN global), `produto_estoque` (snapshot/dia), `produto_custo`, `produto_preco` (historizados por vigência) |
| Campanhas (Fase 3) | `campanhas`, `campanha_produtos`, `campanha_resultados` |
| Cesta (Fase 4) | `cesta_pares` |
| Inteligência (Fases 5-12) | `intel_eventos`, `intel_sinais` (+evidências), `intel_evidencias`, `intel_investigacoes`, `intel_hipoteses`, `intel_decisoes`, `intel_acoes`, `intel_resultados`, `intel_padroes` |
| Ontologia (Fase 7) | `ontology_nodes`, `ontology_edges` |
| Análise Comercial (Fase 2 antiga) | `analises_comerciais` |
| Hospedado (Supabase) | `analytics_snapshots`, `analytics_publicacao_meta` |

## 4. Rotas (~60)

`/api/lojas`, `/api/periodos/:loja`, `/api/analise/:loja/:periodo` (Painel),
`/api/catalogo/:loja[/produtos]`, `/api/marketing/:loja/:periodo/{resultado, produtos,
recommended-products, do-not-promote, stagnant-stock, baskets, combos, campaign-builder,
products/:ean}` + `/campaign-efficiency` + `offer-simulator` (POST) + `campaigns` CRUD,
`/api/concorrencia/:loja`, `/api/intelligence/:loja/{war-room, recommendations, signals[/:id],
detect(POST), investigate(POST), investigations[/:id], decisions[/:id][/outcomes](POST),
actions/:id(PATCH), patterns, ontology[/sync], ask(POST), editorial-plan}`,
`/api/ontologia/:loja/:periodo`, `/api/analise-comercial/:loja[/:ym]` (+ upload/gerar),
`/api/publicar` (POST), `/upload/{vendas, analise, concorrentes, instagram}` (POST),
`/export[-analise]/...` (HTML autocontido), `/publico/*` (estático sem login).

## 5. Módulos e o que já fazem (mapeado ao brief)

| Brief pede | Já existe? | Onde |
|---|---|---|
| §4 Ontology (entidades) | **Parcial** | `ontology_nodes/edges` + `ontologia.js`/`ontologia2.js`. Entidades hoje: loja, categoria, canal, campanha, concorrente, produto, marca, sinal. Faltam formalizar: Cliente, Fornecedor, **Evento**, e "Recomendação" como nó. |
| §5 Knowledge Graph (relações) | **Sim (SQL)** | `ontology_edges` com `tipo` (vende/promove/pressiona/combina/sobre/pertence/da_marca...), `forca`, `confianca`, `valid_from/to`. Pronto p/ migrar a grafo real depois. |
| §6-8 Nova Home / Resumo inteligente / Prioridades | **Não** | Painel é o dashboard antigo (KPIs + gráficos). `war-room` já tem "prioridade #1" e recomendações — falta ser a Home. |
| §9-10 O que anunciar / Opportunity Score + fórmula configurável + breakdown | **Sim** | `marketing-product-analytics.js` + `config/opportunity-score.json` (7 pesos editáveis) + `recommended-products`. Cada produto traz `opportunity.componentes` com valor/peso/contribuição/fonte. Pesos do brief ≈ os atuais (só nomes diferentes). |
| §11 O que NÃO anunciar | **Sim** | `/do-not-promote` — ruptura, margem baixa, sem giro; com substituto. |
| §12 Alert Engine + níveis | **Parcial** | `intel_sinais` (11 detectores, severidade 0-1, classe AMEACA/OPORTUNIDADE/SINAL/CONTRADICAO). Falta o mapa explícito de níveis INFORMATIVO/ATENÇÃO/ALTO/CRÍTICO e alguns tipos (queda de ticket, loja abaixo da meta, promoção agressiva demais). |
| §13 Forecast Engine | **Não** | — |
| §14 Meta Engine | **Não** (só há `lojas.metas` conceitual no brief; `config/lojas.json` não tem metas ainda) | — |
| §15-16 Potencial financeiro / Dinheiro em risco (consolidado) | **Parcial** | `analise-cruzada.js` já dá lucro estimado, capital parado, receita em risco de ruptura. Falta o card único "R$ X potencial / R$ Y em risco" com composição. |
| §17-18 Campanha × Vendas + histórico que aprende | **Sim** | `campanhas.js eficienciaCalendario` (DEMAND_LIFT antes/durante), `campanha_resultados`, Pattern Engine. Falta ROI/ROAS explícito (precisa de investimento por campanha — coluna existe, não é preenchida). |
| §19-20 Pressão competitiva / Price Position | **Sim (§19)** / **Parcial (§20)** | `concorrencia-analise.js`: pressão por concorrente + categorias atacadas + "onde reagir". Price position por produto existe implícito (diff_pct) — falta a tela "posição de preço" com status OK/ALERTA. |
| §21 Ranking de categorias | **Parcial** | `analytics-deep.js` + `categoriasTendencia`. Falta a tela ranking com faturamento/margem/crescimento/giro/opportunity/risco lado a lado. |
| §22 ABC (produtos/clientes/categorias) | **Não** (só percentis de receita/cupons) | — |
| §23-24 Estoque parado / Risco de ruptura + limites configuráveis | **Sim** | `/stagnant-stock`, `days-of-cover` com limiares em `config/marketing-stock.json` (por categoria). |
| §25 Insight automático em cada gráfico | **Parcial** | `insights.js` (3 regras) + Análise Comercial. Falta insight preso a cada gráfico do Painel. |
| §26 Comparações inteligentes (mesmo dia da semana, etc.) | **Parcial** | `analytics-deep.js` tem baseline por dia-da-semana; a tendência usa 14d×14d. Falta expor "hoje vs. média das últimas 4 ocorrências do mesmo dia". |
| §27 Confidence Score | **Sim** | Opportunity Score tem `confianca` (fração do peso com dado real); sinais têm `confianca`; recomendações idem. Falta o detalhamento "✓ estoque atualizado / ✗ concorrência há 18 dias". |
| §28 Data Freshness | **Parcial** | `freshnessCatalogo()` (estoque/custo/preço). Falta consolidar vendas + Instagram + concorrentes numa visão só + alerta de fonte antiga. |
| §29 "Por quê?" | **Sim** | `intelligence/investigar.js` + botão na UI (Sinais, War Room). |
| §30 Decision Engine (rules) | **Parcial** | `detectores.js` são regras, mas hardcoded em JS. Falta um `config/rules.json` declarativo + engine que o lê. |
| §31 Recommendation Engine (tabela + status) | **Parcial** | `intel_decisoes/acoes/resultados` cobre o ciclo. Falta uma tabela `recommendations` própria com o status NEW/VIEWED/ACCEPTED/REJECTED/EXECUTED/MEASURED (hoje as recomendações são calculadas a cada request, não persistidas). |
| §32-33 Closed-loop + Decision Journal | **Sim** | `padroes.js aprenderComDecisao` + `intel_decisoes` com resultados. Falta a TELA "Histórico de decisões" (dados existem, UI é só a aba Decisões básica). |
| §34 Simulações | **Parcial** | `offer-simulator` (cenários conservador/provável/agressivo). Falta "se investir R$500 nessa campanha" e simulação de desconto genérica na UI. |
| §35-38 Assistente / Tool calling / Evidências / Não alucinar | **Sim** | `ask.js`: roteamento por intenção → funções internas (`recomendados`, `investigar`, `combos`, `eficiencia`, `estoqueParado`, war-room) → resposta formato analista com evidências; IA opcional recebe só o pacote e é proibida de inventar. Falta ampliar o leque de perguntas e o "fontes utilizadas" explícito. |
| §39 UX da Home (ordem) | **Não** | — |
| §40 Sidebar simplificada | **Parcial** | Sidebar tem 9 itens sem agrupamento. Brief quer grupos VISÃO/INTELIGÊNCIA/COMERCIAL/MARKETING/MERCADO/DADOS/SISTEMA. |
| §41-43 Visual premium / componentes / loading states | **Não** | Visual atual é funcional mas "template". Sem skeletons, estados de erro/vazio inconsistentes. |
| §44 Performance | **Parcial** | Memo de 45s no `analisarProdutos`, coleta única para publicar+supabase, índices SQL. Falta lazy-load por seção e paginação. |
| §45 Audit Log | **Parcial** | `intel_eventos` (detecção/sinal/decisão) + `data/inbox-log.json`. Falta log unificado de uploads/config/ações com antes/depois. |
| §46-47 Data Quality + score | **Não** | — |
| §48 Configurações do motor (UI) | **Parcial** | Tudo em `config/*.json` editável (sem restart p/ categorias/classify). Falta a TELA de administração. |
| §49-50 Multiloja / Benchmark entre lojas | **Sim (§49)** / **Não (§50)** | Tudo já é `store_id`/`loja_id`, zero hardcode de loja. Falta a tela de comparação Minas × Farma. |
| §51 Migração segura | **Sim** | Padrão já é esse — `CREATE TABLE IF NOT EXISTS` + `ALTER ... ADD COLUMN` em try/catch. |
| §52 Testes | **Parcial** | 53 testes (`node --test`): parser, catálogo, marketing, cesta, campanhas, intelligence, concorrentes. Faltam: forecast, meta, data-quality, ABC, comparações de período. |

## 6. Funcionalidades já existentes (reaproveitáveis 100%)

Opportunity Score + breakdown + config; do-not-promote + substituição; detectores + Priority
Engine + dedupe/resolução; War Room; recomendações cruzadas (playbooks); "Por quê?"; Pattern
Engine; Ask Analytics + funções internas; ontologia persistida; cesta/combos; eficiência de
campanha; análise cruzada (matriz de resultado); concorrência (pressão + onde reagir);
publicação estática + Supabase; data freshness de catálogo; multiloja por `loja_id`;
migrations idempotentes.

## 7. Problemas encontrados

1. **A Home ainda é o dashboard antigo** — não responde "o que fazer agora?". As peças
   (prioridade #1, recomendações, alertas) existem mas estão só na aba Intelligence.
2. **Recomendações não são persistidas** — recalculadas a cada request; sem ciclo
   NEW→VIEWED→ACCEPTED→EXECUTED→MEASURED nem `recommendations` própria. O `decisao.js` gera,
   mas só vira registro quando o usuário clica "registrar como decisão".
3. **Regras hardcoded em `detectores.js`** — não há `config/rules.json` declarativo (§30, §48).
4. **Sem Forecast / Meta / ABC / Data Quality / Benchmark** (§13-14, §22, §46-47, §50).
5. **Sem metas cadastradas** — `config/lojas.json` não tem `metas`.
6. **Investimento de campanha não é preenchido** → ROI/ROAS ficam sem denominador.
7. **Visual "template"**, sem skeleton loaders, estados de erro/vazio irregulares; sidebar
   sem agrupamento; excesso de emoji para um alvo "corporativo".
8. **`ontologia.js` (tela Conexões) e `ontologia2.js` (persistência) duplicam a montagem do
   grafo** — a v2 chama a v1 e re-deriva; dá pra unificar.
9. **`analytics-deep.js` e `marketing-product-analytics.js`** têm cálculos de categoria/tendência
   parecidos, feitos de formas diferentes (um por `v.categoria` da ingestão, outro por janela
   de EAN). Não é bug, mas convém uma fonte única de "categoria no período".
10. **Comparações de período** ainda usam mês-anterior "cheio" ou 14d×14d — falta a régua
    "mesmo dia da semana / mesma janela do mês anterior" pedida em §26.
11. **`_memo` do `analisarProdutos`** nunca é limpo (cresce ~2 entradas/dia; irrelevante hoje,
    mas anotar).
12. **Painel `/api/analise` recalcula tudo a cada request** sem cache — pesado com catálogo
    de 27k SKUs quando há feed de estoque.

## 8. Funcionalidades duplicadas

- Montagem do grafo (ontologia.js × ontologia2.js) — unificar.
- Resumo de concorrência: `analytics-deep.js resumoConcorrencia`, `parsers/concorrentes.js
  resumir`, `server.js buildAnalise` (bloco concorrencia) e `concorrencia-analise.js` — 4
  lugares calculam "quantas abaixo do nosso". Consolidar em `concorrencia-analise.js`.
- "estoque parado / sem giro": aparece em `marketing-product-analytics.js estoqueParado`,
  `detectores.js stagnantStock` e `analise-cruzada.js` (quadrante PESO_MORTO). Mesma ideia,
  3 limiares diferentes — unificar via `config/marketing-stock.json`.

## 9. Reaproveitável / o que muda pouco

Toda a camada determinística (aggregate, analytics-deep, mpa, campanhas, basket,
analise-cruzada, concorrencia-analise) e a de inteligência (detectores, priorizacao, decisao,
investigar, padroes, ask) ficam. A ingestão, o banco, a publicação e o multiloja ficam.
O que muda: a **Home**, a **sidebar**, o **visual**, e entram os módulos novos (§10).

## 10. Funcionalidades faltantes (o trabalho real)

| # | Módulo | Esforço |
|---|---|---|
| A | **Nova Home / Central de Decisão** (§6-8, §39) — cabeçalho + KPIs (com comparação §26) + Resumo Inteligente (determinístico, cada frase com fonte) + Prioridades do Dia + Alertas + Oportunidades + Riscos consolidados | M |
| B | **Forecast Engine** (§13) — média móvel + sazonalidade dia-da-semana + tendência recente → previsão 7/15/fechamento + probabilidade de meta. Módulo `forecast.js`, rota, testes. | M |
| C | **Meta Engine** (§14) — `config/lojas.json` ganha `metas: {mensal, por_categoria}`; `meta.js` calcula realizado/gap/venda-diária-necessária + recomendação de foco. | S |
| D | **Valor financeiro consolidado** (§15-16) — `potencial.js` junta o que `analise-cruzada` + campanhas + cesta já estimam num card "R$ potencial / R$ em risco" com composição. | S |
| E | **Rules Engine declarativo** (§30, §48) — `config/rules.json` (SE/E/ENTÃO sobre campos de produto/categoria/loja) + engine que lê e emite sinais; migra as regras de `detectores.js` que forem simples. | M |
| F | **Tabela `recommendations` + ciclo de status** (§31-32) — persiste o que `decisao.js` gera; status NEW→...→MEASURED; a Home lê daqui. | M |
| G | **Decision Journal** (§33) — tela "Histórico de decisões" (os dados já existem em `intel_decisoes`). | S |
| H | **ABC** (§22) — `abc.js`: curva A/B/C de produtos e categorias por faturamento e por margem; combina os dois eixos. | S |
| I | **Data Quality** (§46-47) — `data-quality.js`: produto sem categoria/custo, estoque negativo, campanha sem período, concorrente duplicado, valores fora de faixa → score 0-100 + lista. Tela em Configurações. | M |
| J | **Benchmark entre lojas** (§50) — `benchmark.js` compara Minas × Farma (faturamento, margem, crescimento, categorias fortes/fracas) usando **resultados agregados** (nunca junta `vendas_transacoes`). | S |
| K | **Audit Log unificado** (§45) — tabela `audit_log` (timestamp, ação, entidade, antes, depois); hook em uploads/config/ações. | S |
| L | **Configurações do Motor (UI)** (§48) — tela que edita os `config/*.json` (pesos do score, limiares de cobertura, margem mínima, metas, regras). | M |
| M | **Visual "corporativo"** (§41-43) — paleta de status (verde/vermelho/amarelo/azul/neutro), tipografia, densidade; componentes (KpiCard, AlertCard, RecommendationCard, ScoreGauge, ConfidenceBadge, DataFreshness...); skeleton loaders; estados erro/vazio. Sidebar agrupada (§40). Reduzir emoji. | L |
| N | **Insight por gráfico** (§25) + **comparações §26** — cada gráfico do Painel ganha uma frase automática; helper `comparar(hoje, mesmoDiaSemana|mesPassado)`. | M |
| O | **Price Position** (§20) — tela por produto: nosso preço × média concorrência × status OK/ALERTA. Dados já vêm de `concorrencia_ofertas`. | S |
| P | **Ranking de Categorias** (§21) — tela dedicada (dados já existem, falta a visão consolidada). | S |
| Q | **Ampliar Alert Engine** (§12) — níveis INFORMATIVO/ATENÇÃO/ALTO/CRÍTICO explícitos + tipos que faltam (queda de ticket, loja abaixo da meta, promoção agressiva demais). | S |

Legenda de esforço: S ≈ 1 arquivo + rota + teste · M ≈ 2-3 arquivos + tela · L ≈ várias telas/CSS.

## 11. Mudanças no banco (migrations, todas idempotentes)

- `ALTER TABLE lojas ADD COLUMN meta_mensal REAL` (+ `metas_json` p/ metas por categoria) — §14.
- Nova `recommendations` (id, loja_id, entity_type, entity_id, tipo, titulo, descricao, motivo,
  impacto, confianca, prioridade, status, valor_esperado, criado_em, visto_em, aceito_em,
  executado_em, resultado_json) — §31.
- Nova `audit_log` (id, ts, ator, acao, entidade_tipo, entidade_id, antes_json, depois_json) — §45.
- Nova `forecast_snapshots` (loja_id, data, horizonte, valor_previsto, metodo, gerado_em) —
  opcional, p/ acompanhar acerto do forecast — §13/§32.
- Nova `evento` / reuso de `intel_eventos` com `tipo` estendido (PROMOCAO, QUEDA_PRECO_CONC,
  RUPTURA, AUMENTO_DEMANDA...) — §4 entidade Evento.
- `config/lojas.json`: `metas`, `campanhas[].investimento` já aceito no schema (`campanhas.investimento`).
- `config/rules.json` (novo, não é banco).

Nada é destrutivo. `produtos`/`vendas_transacoes`/etc. não mudam.

## 12. Plano de implementação (fases do brief §54, ajustado ao que já existe)

| Fase | Entrega | Itens §10 |
|---|---|---|
| **1 — Fundação** | Formalizar entidades Evento/Recomendação na ontologia; `recommendations` + ciclo de status; `audit_log`; Data Quality (`data-quality.js` + score); `config/rules.json` + rules engine lendo regras simples. | E, F, I, K |
| **2 — Motor** | Forecast Engine; Meta Engine (`config/lojas.json` metas); Valor financeiro consolidado (potencial/risco); ampliar Alert Engine (níveis + tipos novos); ABC. | B, C, D, H, Q |
| **3 — Home** | **Central de Decisão** (nova Home): KPIs c/ comparação §26, Resumo Inteligente, Prioridades, Alertas, Oportunidades, Riscos, Previsão, Meta. Sidebar agrupada. | A, N (parte) |
| **4 — Comercial/Mercado** | Ranking de Categorias; Price Position; Benchmark entre lojas; Decision Journal (tela); insight por gráfico. | G, J, N, O, P |
| **5 — Visual** | Paleta de status + componentes reutilizáveis + skeleton loaders + estados erro/vazio; reduzir emoji; densidade "corporativa". Configurações do Motor (UI). | L, M |
| **6 — Assistente** | Ampliar `ask.js` (mais intenções + "fontes utilizadas" explícito); simulações genéricas (desconto, verba de campanha) na UI. | §34, §35-38 |
| **7 — Closed-loop avançado** | Acompanhamento de acerto do forecast; recomendação → resultado com curva de aprendizado por tipo; simulação preditiva. | §7, §32, §34 |

Ao fim de cada fase: `node --test` (manter os 53 + novos), regenerar `publico/index.html`,
push `main` + `gh-pages`, atualizar este doc e `docs/EVOLUCAO-INTELLIGENCE.md`.

## 13. Arquivos que serão ALTERADOS

`schema.sql` (migrations), `db.js` (helpers das tabelas novas), `server.js` (rotas novas +
Home), `public/app.js` (nova Home, sidebar agrupada, componentes, skeletons), `public/styles.css`
(paleta/densidade/componentes), `public/index.html` (sidebar), `config/lojas.json` (metas),
`coletar-tudo.js` + `supabase-sync.js` + `publicar.js` (novos snapshots), `intelligence/index.js`
(warRoom → alimenta a Home), `ontologia.js`+`ontologia2.js` (unificar), `intelligence/decisao.js`
(persistir em `recommendations`).

## 14. Arquivos NOVOS

`forecast.js`, `meta.js`, `potencial.js`, `abc.js`, `data-quality.js`, `benchmark.js`,
`rules-engine.js`, `config/rules.json`, `intelligence/eventos.js` (detector de eventos),
`docs/decision-intelligence.md`. Testes: `test/forecast.test.js`, `test/meta.test.js`,
`test/abc.test.js`, `test/data-quality.test.js`, `test/rules-engine.test.js`.

## 15. Riscos da alteração

| Risco | Mitigação |
|---|---|
| Quebrar o Painel/telas atuais ao trocar a Home | A Home nova é uma tela nova ("Hoje" / "Central"); o Painel atual continua acessível. Rollout por rota. |
| `recommendations` persistida divergir do `decisao.js` calculado | O `decisao.js` continua sendo a fonte; a persistência é um espelho com dedupe por (loja, tipo, entidade). |
| Rules engine declarativo introduzir regressão vs. `detectores.js` | Migrar só regras triviais primeiro; manter os detectores JS em paralelo; comparar saída nos testes. |
| Forecast dar número "com cara de verdade" sem ser | Sempre com intervalo + `metodo` + `confianca`; nunca esconder que é média móvel/sazonalidade. |
| Visual novo aumentar o tamanho do bundle estático | Componentes em CSS puro (sem framework); o `analytics.html` já é 1.6 MB — meta manter < 2.5 MB. |
| Custo suspeito / dados ruins contaminando forecast e ABC | Data Quality roda antes; itens `custo_suspeito`/estoque negativo entram com flag e ficam fora dos agregados de margem. |
| Supabase: mais snapshots por loja | Já são ~43; +8 chaves × 2 lojas ≈ 60. UPSERT em lote aguenta. |
| Perda de histórico em migration | Só `ADD COLUMN`/`CREATE IF NOT EXISTS`; nenhum `DROP`/`ALTER` destrutivo. Backup do `.db` antes de cada fase. |

---

*Gerado em 2026-09-02. Próximo passo: começar a Fase 1.*
