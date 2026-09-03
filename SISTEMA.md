# ANALYTICS — documentação do sistema inteiro

> Auditoria técnica e funcional completa. Estado em **2026-09-02** (commit `3874959`).
> Duas farmácias: **Minas Farma** e **Farma e Farma** (Baixo Guandu/ES). As duas lojas
> **nunca são somadas** — toda agregação passa por `loja_id` / `periodo_id`.

Documentos irmãos: [`docs/AUDITORIA.md`](docs/AUDITORIA.md) (gap analysis vs. o brief de
Decision Intelligence + plano em 7 fases), [`docs/EVOLUCAO-INTELLIGENCE.md`](docs/EVOLUCAO-INTELLIGENCE.md),
[`docs/intelligence.md`](docs/intelligence.md), [`docs/marketing-opportunity.md`](docs/marketing-opportunity.md),
[`docs/campaign-engine.md`](docs/campaign-engine.md), [`docs/publicar.md`](docs/publicar.md),
[`docs/supabase-vercel.md`](docs/supabase-vercel.md), [`docs/integracoes.md`](docs/integracoes.md).

---

## 1. O que o sistema faz

Recebe documentos brutos das farmácias (relatório de vendas em PDF, planilha de
estoque+custo+preço, coleta de concorrentes, **tabela de planejamento de promoções**,
métricas de Instagram) jogados numa pasta, processa sozinho e entrega:

- **Command Center** (Fase A) — tela de abertura: "o que anunciar hoje" (ranqueado, com papel
  de marketing + ação + motivos e evidência) × "o que NÃO anunciar" (ruptura / margem / sem
  giro + substituto) + alertas. Papel automático por produto (CHAMARIZ / TRÁFEGO / HERO /
  MARGEM / COMPLEMENTAR / DESOVA / RECORRÊNCIA / IMAGEM) e sub-scores Tráfego / Lucro / Desova /
  Campanha derivados do Opportunity Score (Criativo pendente da Fase F)
- **Painel** de resultados (faturamento, ticket, categorias, top produtos, Instagram, concorrência)
- **Marketing Product Intelligence** — por produto: giro 7–90d, tendência, dias de cobertura,
  margem, classe (HERO/TRÁFEGO/…), **Opportunity Score 0–100** com breakdown, do-not-promote
- **Resultado** — cruzamento vendas × estoque × custo × margem: lucro estimado por produto,
  matriz (vaca leiteira / isca cara / peso morto / aposta / sumindo / ruptura), capital parado
- **Campanhas** — eficiência (DEMAND_LIFT), Campaign Builder, Offer Simulator; **Campaign
  Builder 2.0** (Fase B): campanha inteira — elenco por papel com preço sugerido + ângulo de
  venda + forecast por perna, combos viáveis, score da campanha 0–100, forecast em 3 cenários;
  **Medição** (Fase C): o que a campanha fez de fato — baseline pelo mesmo dia da semana,
  receita/unidades/lucro incremental, ROAS, retorno sobre margem, canibalização;
  **Playbooks** (Fase D): memória de marketing — o que cada campanha recorrente aprendeu
  (melhor dia, tendência do lift, produtos, ângulo dominante) + fadiga de produto;
  **Calendário** (Fase G): próximos 30 dias do calendário recorrente ajustados por
  ruptura / fadiga / concorrência + slots de defesa + ciclo fechado (medição → padrão → próxima)
- **Cesta** — market basket (support/confidence/lift), combos
- **Concorrentes** — pressão competitiva, "onde reagir" priorizado, **contra-ataque com produto
  alternativo** quando não vale cobrir o SKU atacado (Fase E), **Share of Promotions** (nossa
  ação promocional × ofertas do concorrente por categoria — "subcomunicando Bebê" / "esforço sem
  pressão"), registro por formulário / colar encarte / planilha
- **Intelligence** — detectores → sinais priorizados (com evidência), War Room, **decisões
  recomendadas cruzando sinais** ("modelo Palantir"), "Por quê?", Decision Journal, Pattern
  Engine (aprende de decisão→resultado), Ontologia persistida, Pauta editorial de 7 dias,
  "Pergunte ao Analytics"
- **Análise Comercial** mensal via LLM (opt-in) — o modelo só interpreta agregados, nunca faz conta

Tudo funciona **local** (`localhost:4180`) e é publicado como **site estático** que lê ao vivo
do Supabase (Vercel + GitHub Pages).

---

## 2. Arquitetura e fluxo de dados

```
                 ┌──────────── inbox/ (chokidar) ────────────┐
   arquivos ────>│ PDF vendas · xlsx estoque · xlsx conc.    │
                 │ · JSON instagram · JSON análise comercial │
                 └───────────────┬──────────────────────────┘
                     watcher.js  │  (ou /upload/* manual, mesmo caminho)
                                 v
   ingest.js (dispatcher por extensão + nome)
     .pdf   -> parsers/vendas.js  (regra de ouro: Σ == "Total:" impresso, senão LANÇA)
             -> resolve loja pelo CNPJ do cabeçalho · split por mês
             -> replaceVendas + catalogo.sincronizarProdutosDeVendas + basket.calcularCesta
             -> intelligence.rodarDeteccao
 .xlsx/.csv -> concorrente?   parsers/concorrentes.js (36 col OU planilha simples)
             -> promoção?     parsers/promocoes.js -> promocoes_planejadas (o "tabelão")
             -> estoque/custo/preço?  catalogo.ingestPlanilhaProduto (1 arquivo alimenta os 3)
             -> rodarDeteccao das lojas tocadas
     .json  -> análise comercial (validate-analise.js) OU instagram
                                 v
   db.js  (node:sqlite / DatabaseSync)  —  data/analytics.db  —  28 tabelas
                                 v
   ┌─ camada determinística ──────────────────────────────────────────────┐
   │ aggregate · analytics-deep · classify · insights · match             │
   │ marketing-product-analytics (Opportunity Score, classes, cobertura)  │
   │ analise-cruzada (resultado/matriz) · concorrencia-analise            │
   │ campanhas (eficiência, builder, simulador) · basket (cesta, combos)  │
   └─────────────────────────────────────────────────────────────────────┘
                                 v
   ┌─ camada de inteligência (intelligence/) ────────────────────────────┐
   │ contexto -> detectores (11) -> priorizacao (0..100)                 │
   │ index.rodarDeteccao (dedupe/reabre/resolve) -> intel_sinais         │
   │ decisao (cruza sinais -> recomendações) · investigar ("Por quê?")   │
   │ padroes (closed-loop) · ontologia2 (grafo persistido)               │
   │ ask (Pergunte ao Analytics) · editorial (pauta 7 dias)              │
   └─────────────────────────────────────────────────────────────────────┘
                                 v
   server.js (Express) — ~66 rotas — auth por usuário+senha (cookie)
                                 v
   ┌─ frontend local ─────────┐   ┌─ publicação (a cada ingestão) ─────────┐
   │ public/ (vanilla JS,     │   │ coletar-tudo.js -> publicar.js         │
   │ SVG à mão, sem framework) │   │   -> publico/index.html (autocontido,  │
   │ 10 telas                  │   │      lê Supabase ao vivo + fallback)   │
   └──────────────────────────┘   │ supabase-sync.js -> analytics_snapshots │
                                  └───────────┬───────────────────────────┘
                                              v
                            Supabase (Postgres/PostgREST) — leitura pública (chave publishable)
                                              v
                     Vercel (sdawd-sage.vercel.app) + GitHub Pages (thgustavo62-design.github.io/Analytics)
                     — estáticos, com portão de login no navegador
```

---

## 3. Módulos (arquivo → o que faz)

### Ingestão e parsing
| Arquivo | Papel |
|---|---|
| `watcher.js` | observa `inbox/` com chokidar, serializa a ingestão, grava `data/inbox-log.json` |
| `ingest.js` | dispatcher: extensão + nome do arquivo → função de ingestão; resolve loja pelo **CNPJ** do cabeçalho do PDF; split de PDF multi-mês; roda detecção pós-ingestão |
| `parsers/vendas.js` | PDF "Analítico de Vendas" via `pdfjs-dist` → transações + empresa (CNPJ/razão social) + **validação da soma vs. "Total:"** (não bate → lança, nada é gravado) + detecção de dia parcial |
| `parsers/concorrentes.js` | xlsx de concorrente — formato de 36 colunas **ou** planilha simples (Concorrente+Produto+Preço); colunas mapeadas por `config/concorrentes.json`; sem status = tudo confirmado |
| `parsers/promocoes.js` | **tabela de planejamento de promoções** (o "tabelão"/encarte) — xlsx **ou csv**; acha o cabeçalho, mapeia colunas por `config/promocoes.json` (produto/EAN, preço de/por ou desconto, início, fim, campanha, loja), lê datas `DD/MM` sem "adivinhação US" (`raw:true`), deriva preço↔desconto quando falta um. `data/promocoes_planejadas` (via `db.substituirPromocoesPlanejadas`, dedupe por `chave` no re-upload). Alimenta o **Share of Promotions** e o Calendário. |
| `parsers/instagram.js` | normaliza o formulário / JSON de métricas do Instagram |
| `catalogo.js` | `sincronizarProdutosDeVendas()` popula `produtos` pelos EAN das vendas; `ingestPlanilhaProduto()` lê planilha de estoque — **um arquivo alimenta estoque + preço de venda + preço de promoção + custo + a categoria REAL do ERP** ("Nome Grupo" → `mapGrupoErp`) + `Princípio Ativo` + `Registro MS`; nome com `geral`/`rede` aplica nas 2 lojas |
| `classify.js` | categoria por palavra-chave (`config/categorias.json`) — **fallback**, só quando o ERP não deu grupo |
| `categorias.js` | **vocabulário canônico** de categoria. `categoriaCanonica(rotulo)` resolve qualquer rótulo de fora (grupo de ERP, coleta de concorrente, classificador) para o mesmo conjunto (`config/categorias-sinonimos.json`); `mapGrupoErp(grupo)` → `{categoria, subcategoria, classe_comercial}` (`config/grupos-erp.json`, regras `prefixo` separam Genérico/Similar/Ético/OTC); `expandirSuperGrupo("Bebê")` → `[Bebê, Fraldas, Leite Infantil]` |
| `scripts/recategorizar.js` | one-shot: canoniza toda categoria não-manual + reaplica o grupo do ERP das planilhas de estoque da inbox. Idempotente. Antes: 8 categorias (79% "Medicamentos/Outros"); depois: 11 canônicas + subcategorias |
| `match.js` | casamento de nome de produto (Jaccard de tokens + marca como filtro duro) |

### Camada determinística (nenhuma IA — só soma e conta)
| Arquivo | Papel |
|---|---|
| `aggregate.js` | KPIs, série diária, dia-da-semana, categorias, top produtos, preço médio por produto |
| `analytics-deep.js` | ticket médio E mediano, baseline semanal c/ desvio, incrementalidade intradiária por campanha, canais Convênio/Delivery/Balcão, concentração cliente/convênio, operadores, resumo de concorrência |
| `insights.js` | 3 regras automáticas → cards (`config/insights.json`) |
| `marketing-product-analytics.js` | **Fase 2** — por produto: unidades/receita/cupons 7/14/30/60/90d, venda média diária, tendência (14d×14d, clamp ±300%), `dias_cobertura` por categoria (`config/marketing-stock.json`), margem, classes, **Opportunity Score** (7 componentes + peso + contribuição + fonte + confiança, `config/opportunity-score.json`), **curva ABC** (`.abc`), `do-not-promote` + substituto, estoque parado. **Custo proxy entre lojas**: se a loja não tem custo do EAN mas a outra tem, usa esse (`custo_proxy: true`, `custo_proxy_origem`, tudo marcado como aproximado; toggle `custo_proxy_entre_lojas`). Memo de 45s. |
| `analise-cruzada.js` | vendas × estoque × custo × margem → `resultado_30d` (lucro estimado por produto), `capital_parado`, `giro_mensal`, **matriz** VACA_LEITEIRA/ISCA_CARA/PESO_MORTO/APOSTA/SUMINDO/RUPTURA/NORMAL, `custo_suspeito` (custo > 1,3× preço = erro de ERP, balde separado) |
| `concorrencia-analise.js` | panorama, por concorrente (pressão + categorias atacadas + exemplos), por categoria (ALTA/MÉDIA/BAIXA), **"onde reagir"** priorizado por relevância × quão abaixo × dá pra cobrir (margem real) — com **`contra_ataque`** (Fase E: melhor produto da mesma categoria para promover no lugar quando o SKU atacado não dá pra cobrir), **`share_promocoes`** (Fase E: nossa ação promocional [**tabela de planejamento de promoções** vigente na data → fallback campanhas cadastradas] + calendário recorrente × ofertas do concorrente por categoria → subcomunicando / esforço-sem-pressão / equilibrado; promoções são forward-looking, usa a data de hoje), resumo + ações |
| `campanhas.js` | **Fase 3** — `eficienciaCalendario` (DEMAND_LIFT dias-de-campanha vs. demais, veredito EXCELENTE→DESTRUTIVA; nunca DESTRUTIVA sem custo), **Campaign Builder** (elenco por papel), **Offer Simulator** (cenários conservador/provável/agressivo, nunca promete venda) |
| `basket.js` | **Fase 4** — cesta por cupom (`data+lancamento`): support/confidence/lift; corte de ruído (mínimo por produto isolado); `centralidade()`; `combos()` |
| `marketing/roles.js` | **Fase A** — papel de marketing por produto: 1 primário + secundários (CHAMARIZ / TRÁFEGO / HERO / MARGEM / COMPLEMENTAR / DESOVA / RECORRÊNCIA / IMAGEM / GIRO), com força 0..1, racional e confiança. Regras em `config/marketing-roles.json`. RECORRÊNCIA/IMAGEM são proxies (confiança baixa). |
| `marketing/scores.js` | **Fase A** — sub-scores: `traffic_score`, `profit_score` (null sem custo), `clearance_score` (null sem estoque), `campaign_score` (Opportunity, penalizado se do-not-promote), `creative_score` (**sempre null** até a Fase F) + interpretação (ex.: "bom para atração, fraco em rentabilidade") |
| `marketing/command-center.js` | **Fase A** — `commandCenter(loja)`: plano do dia de uma loja — `anunciar[]` (ranqueado, com papel + ação + 3 motivos com evidência + sub-scores), `nao_anunciar[]` (motivo curto + motivos + substituto), `alertas[]` (ruptura com venda relevante, categoria sob ataque, capital parado, feed faltando) |
| `marketing/angulos.js` | **Fase B** — Motor de Ângulos: pontua PREÇO / URGÊNCIA / VOLUME / CONVENIÊNCIA / COMPARAÇÃO / RECORRÊNCIA a partir de dado real (desconto planejado, margem, papel, janela, pressão de concorrência) → ângulo primário + ranking + sugestão de copy (template). `config/angulos.json`. |
| `marketing/campaign-builder.js` | **Fase B** — `montarCampanha(loja, {dias, tema, categorias})`: janela contígua, elenco por papel (Fase A) com preço sugerido (respeita piso de margem) + ângulo + forecast por perna, combos viáveis do elenco, lista de evitar, **forecast da campanha inteira** (3 cenários + margem incremental + estoque necessário) e **score da campanha 0–100** (cobertura de papéis + margem prevista + estoque + força da âncora). `config/campaign-plan.json`. |
| `marketing/campaign-measure.js` | **Fase C** — `medirCampanha(loja, {nome \| dias+categorias, janelaDias, investimento})`: **baseline pelo mesmo dia da semana** (fallback "demais dias" com `confianca: baixa`), receita/unidades/lucro incremental, % sobre baseline, **ROAS** e **retorno sobre margem** (com investimento), **canibalização** (variação das outras categorias — só medida com baseline do mesmo dia da semana). Leitura observacional, com aviso. |
| `marketing/padroes-mkt.js` | **Fase D** — `padroesMarketing(loja)`: cada campanha recorrente do calendário, semana a semana — **melhor dia** (comparação relativa, sem viés), **tendência do lift** (melhorando / estável / piorando = fadiga), lift médio (indicativo). `playbooks(loja)`: manual por categoria (melhor dia, produtos recomendados, ângulo dominante, veredito pela tendência) + `padroes` + `fadiga`. `fadigaProdutos(loja)`: produtos das categorias de campanha que rendiam nos dias de campanha e perderam força ao longo de blocos de 30 d (ainda vendendo — queda a zero = ruptura, não fadiga). |
| `marketing/data-quality.js` | **Data Quality** — `dataQuality(loja)`: score 0–100 + lista de problemas com severidade (ALTO/MÉDIO/BAIXO), quantidade, **R$ de impacto** e **como corrigir**: custo > preço, categoria só do chute, vende sem custo, estoque negativo, promoção não casada / sem desconto, vendas sem EAN, cliente não identificado, feed desatualizado/ausente. + `freshness` consolidado dos 6 feeds. |
| `marketing/abc.js` | **Curva ABC** por receita 90d. `classificarProdutosABC(produtos)` marca cada produto com `.abc` (A = até 80% da receita acumulada, B = 80–95%, C = cauda). Chamado dentro de `analisarProdutos` → todo produto carrega `.abc`. `curvaABC(loja)` = resumo: produtos, categorias e clientes (concentração por `cli_id`). Recomendados / Command Center / Campaign Builder usam **só A+B** (`opts.incluirC` traz tudo). `config/abc.json`. |
| `marketing/promo-pricing.js` | **Precificação de promoção** — `precificarProduto(loja, {ean\|produto_id\|descricao, duracaoDias})`: varre descontos 0..teto, projeta unidades pela **elasticidade-preço da categoria em contexto de promoção** (`config/elasticidade.json`, premissa enquanto não há histórico), devolve `recomendado` (maximiza o **lucro incremental do próprio SKU** — o efeito-cesta é exibido em `efeito_cesta_estimado` mas **não decide**, para nunca recomendar vender abaixo do que se ganha), `testar` (conservador / recomendado / agressivo), `curva` lucro×desconto, `limites` (break-even, desconto máx. sem prejuízo, teto pelo piso de margem) e comparação com a `promocao_planejada` da tabela. `oportunidadesPromo(loja, {n, duracaoDias})`: "**o que colocar em promoção**" — ranqueia os candidatos A/B pelo lucro incremental da melhor promoção de cada um, horizonte de 30 d para comparação; produtos sem custo (próprio ou proxy) vão para o balde `sem_custo` (ranqueado por receita incremental). Custo pode ser proxy da outra loja (marcado). Todo resultado leva o aviso da premissa. |
| `marketing/calendar.js` | **Fase G** — `calendarioMarketing(loja, {dias})`: monta as ocorrências das campanhas recorrentes nos próximos N dias e **ajusta** cada uma: ruptura na categoria → `SUSPENDER`, fadiga (≥2 produtos ou tendência piorando) → `RENOVAR`, esforço sem pressão → `REVISAR`. Sugere **slots de DEFESA** (concorrência subcomunicada, sem campanha nossa) e **OPORTUNIDADE** (categoria forte no Command Center, sem campanha). `ciclo_fechado`: por campanha, junta a última Medição (C) + o padrão (D) + a fadiga numa **recomendação para a próxima rodada** + link para montar (`campaign-plan`). |

### Camada de inteligência (`intelligence/`)
| Arquivo | Papel |
|---|---|
| `contexto.js` | monta o "pacote" determinístico da loja (Fase 2/3/4 + concorrência + Instagram + histórico + momentum de categoria 14d×14d; recua 1 dia se o último dia é parcial) |
| `detectores.js` | **11 detectores**: COMPETITOR_PRICE_ATTACK, CATEGORY_DECLINE/GROWTH, STOCK_RISK (+ rollup), STAGNANT_STOCK, CAMPAIGN_UNDER/OVERPERFORMANCE, DEMAND_ANOMALY, CROSS_SELL/MARKETING_OPPORTUNITY, CREATIVE_FATIGUE, CONTRADICTION. Sem o feed necessário, não dispara e reporta em `indisponivel[]`. Limiares em `config/intelligence.json`. |
| `priorizacao.js` | **Priority Engine** `prioridade 0..100` = média ponderada de severidade, confiança, impacto financeiro, recência (meia-vida), acionabilidade |
| `index.js` | `rodarDeteccao` (dedupe por `dedupe_key`, reabre o que voltou, resolve o que sumiu) + `warRoom` (KPIs, prioridade #1, threat/opportunity map, contradições, situação por categoria, recomendações) |
| `decisao.js` | **cruza os sinais abertos entre si** → decisões recomendadas (playbooks: DEFENDER_CATEGORIA = queda + ataque de preço; CAMPANHA_SEM_ESTOQUE; APROVEITAR_ALTA; DESOVAR_COMBO; REVISAR_DADO) — cada uma com ação, efeito esperado, confiança, cadeia de evidências, códigos dos sinais |
| `investigar.js` | **"Por quê?"** — biblioteca de hipóteses por assunto (categoria/campanha/produto); cada hipótese vira `suportada`/`refutada`/`inconclusiva` com evidência |
| `ontologia2.js` | persiste o grafo de `ontologia.js` em `ontology_nodes`/`ontology_edges` (força, confiança, `valid_from`) + enriquece com PRODUTO/MARCA + arestas `combina` (cesta) e `sobre` (sinal) |
| `padroes.js` | **closed-loop** — quando uma decisão ganha resultado, deriva `chave = "(tipos de sinal) => (tipo de decisão)"` e atualiza `intel_padroes` (amostra, taxa de sucesso); `semelhantes()` |
| `ontologia.js` (raiz) | grafo da tela **Conexões** (loja/categoria/canal/campanha/concorrente/sinal + achados da Análise Comercial), arestas com significado + cruzamentos |
| `ask.js` (raiz) | **Pergunte ao Analytics** — roteia a pergunta por intenção → funções internas (`recomendados`, `investigar`, `combos`, `eficiencia`, `estoqueParado`, war-room) → resposta formato analista (conclusão/evidências/hipóteses/confiança/ação/monitorar); IA opcional recebe **só** o pacote agregado e é proibida de inventar |
| `editorial.js` (raiz) | pauta de 7 dias — produto e ângulo saem do motor; CTA de template |

### IA (opt-in `ANTHROPIC_API_KEY`)
| Arquivo | Papel |
|---|---|
| `motor.js` | gera o JSON da **Análise Comercial mensal** via API da Anthropic a partir dos agregados de `analytics-deep.js` (o modelo interpreta, não calcula). `claude-opus-5`, thinking adaptive. |
| `validate-analise.js` | validador sem dependência do JSON do Motor (chaves obrigatórias + tipos) |
| `analise-store.js` | grava a análise no banco (`analises_comerciais`) + espelho em `data/analises/*.json` |

### Publicação
| Arquivo | Papel |
|---|---|
| `coletar-tudo.js` | bate na própria API local (cookie de sessão) e junta **todas** as respostas de todas as telas das 2 lojas num pacote `B` |
| `publicar.js` | assa `B` + `app.js` + `styles.css` num `publico/index.html` autocontido; o stub troca `window.fetch` para ler **ao vivo do Supabase** (chave publishable) com fallback assado; embute o **portão de login** (SHA-256 de `usuario:senha`) |
| `supabase-sync.js` | UPSERT em lote de cada pedaço de `B` em `analytics_snapshots` (Postgres); opt-in por `SUPABASE_DB_URL` |
| `scripts/build-vercel.js` | copia `public/` → `vercel/` para o deploy do Vercel (fallback alternativo, hoje não usado) |

---

## 4. Banco de dados (`data/analytics.db`, SQLite via `node:sqlite`)

28 tabelas. Migrations **idempotentes** no boot: `schema.sql` roda `CREATE TABLE IF NOT EXISTS`
+ bloco de `ALTER TABLE … ADD COLUMN` em try/catch (engole "duplicate column name"). Nada é
destrutivo.

| Grupo | Tabela | Chave / notas |
|---|---|---|
| **Núcleo** | `lojas` | `id`, `nome` (Minas Farma / Farma e Farma) |
| | `periodos` | `(loja_id, ano, mes)`; guarda `vendas_ultimo_dia[_parcial/_motivo]`, `vendas_total_impresso` |
| | `vendas_transacoes` | `periodo_id`, `data`, `lancamento` (cupom), `barras` (EAN), `descricao`, `categoria`, `quantidade`, `valor_liquido`, `forma_pagto`, `emp_id`, `cli_id` |
| | `instagram_metricas` | `periodo_id`, `metrica`, `valor_exibicao`, `delta_pct` |
| | `concorrencia_ofertas` | `periodo_id`, `concorrente`, `produto`, `preco_normal/promo`, `validade`, `nivel_confianca`, `status_validacao`, `nosso_preco_medio`, `abaixo_do_nosso`, **`data_coleta`**, **`fonte`** (`coleta`/`manual`) |
| | `promocoes_planejadas` | tabela do "tabelão"/encarte: `loja_id` (NULL = todas), `produto_id` (resolvido, pode ser NULL), `ean`, `descricao`, `categoria`, `preco_normal/promo`, `desconto_pct`, `data_inicio/fim`, `campanha`, `fonte_arquivo`, `chave` UNIQUE |
| **Catálogo (Fase 1)** | `produtos` | `ean` UNIQUE (nullable), `descricao[_normalizada]`, `categoria` + **`categoria_fonte`** (`vendas`=palavra-chave < `erp` < `manual` — rank de sobrescrita), `subcategoria`, **`classe_comercial`** (Genérico/Similar/Ético/OTC), **`principio_ativo_cod`**, **`registro_ms`**, `*_manual` (override vence), `fonte` |
| | `produto_estoque` | snapshot por `(loja_id, produto_id, data_referencia)` |
| | `produto_custo` | historizado — `data_inicio`/`data_fim` (vigência; nunca sobrescreve) |
| | `produto_preco` | idem + `tipo_preco` (normal/promocional/planejado) |
| **Campanhas (Fase 3)** | `campanhas` | `loja_id`, `nome`, `objetivo`, `data_inicio/fim`, `status`, `investimento`, `origem` |
| | `campanha_produtos` | `papel` (CHAMARIZ/HERO/MARGEM/…), `preco_promocional` |
| | `campanha_resultados` | `metricas_json`, `resultado` (EXCELENTE→DESTRUTIVA), `score` |
| **Cesta (Fase 4)** | `cesta_pares` | `(loja_id, janela, produto_a, produto_b)`, `support`, `confidence`, `lift` |
| **Inteligência (Fases 5–12)** | `intel_eventos` | log append-only (DETECCAO_RODOU, SINAL_ABERTO/REABERTO/RESOLVIDO, DECISAO_REGISTRADA) |
| | `intel_sinais` | `classe` (SINAL/AMEACA/OPORTUNIDADE/CONTRADICAO), `tipo`, `severidade`, `confianca`, `impacto_estimado`, `prioridade` 0–100, `entidade_tipo/ref`, `status`, `dedupe_key` UNIQUE, `ocorrencias`. Código legível: `SIG-/THR-/OPP-/CON-000000` |
| | `intel_evidencias` | `sinal_id` → `campo`, `valor`, `fonte`, `periodo` |
| | `intel_investigacoes` / `intel_hipoteses` | "Por quê?" — hipóteses com `veredito` + `evidencias_json` |
| | `intel_decisoes` / `intel_acoes` / `intel_resultados` | Decision Journal — decisão → ações → resultado medido (`antes`/`depois`/`veredito`) |
| | `intel_padroes` | `(loja_id, chave)`, `amostra_n`, `sucessos`, `taxa_sucesso` |
| **Ontologia (Fase 7)** | `ontology_nodes` | `(loja_id, chave)`, `tipo`, `rotulo`, `atributos_json` |
| | `ontology_edges` | `(loja_id, de_chave, para_chave, tipo)`, `forca`, `confianca`, `valid_from/to` |
| **Análise Comercial** | `analises_comerciais` | `(loja_id, ano, mes)`, `json` (documento inteiro) |
| **Hospedado (Supabase)** | `analytics_snapshots` | `chave` = `"<loja>\|<endpoint>\|<periodo>"`, `payload` jsonb — o site lê daqui |
| | `analytics_publicacao_meta` | carimbo `gerado_em` da última publicação |

---

## 5. Rotas HTTP (`server.js`, ~66)

Todas atrás de sessão (cookie `va_session`), exceto `/healthz`, `/login`, `/publico/*` e o
POST `/analise-comercial/upload` (token próprio). `VA_NO_AUTH=1` desliga (só local).

**Auth** — `GET/POST /login` (usuário + senha), `POST /logout`.

**Leitura base** — `GET /api/lojas`, `/api/periodos/:loja`, `/api/analise/:loja/:periodo` (Painel),
`/api/catalogo/:loja[/produtos]`, `/api/ingest-log`.

**Marketing** — `GET /api/marketing/:loja/command-center` (Fase A — plano do dia) ·
`GET|POST /api/marketing/:loja/campaign-plan` (Fase B — Campaign Builder 2.0: `dias`, `tema`, `categorias`) ·
`GET /api/marketing/:loja/campaign-measure` (Fase C — `nome` ou `dias`+`categorias`, `investimento`; sem params = todas as campanhas do calendário) ·
`GET /api/marketing/:loja/playbooks` (Fase D — playbooks + padrões + fadiga) ·
`GET /api/marketing/:loja/calendar` (Fase G — `dias`; ocorrências ajustadas + slots + ciclo fechado) ·
`GET /api/marketing/:loja/abc` (curva ABC — produtos / categorias / clientes) ·
`GET /api/marketing/:loja/promo-pricing` (precificação de promoção — sem params: ranking "o que colocar em promoção"; com `ean` / `produto` / `descricao` + `dias`: preço recomendado, 3 preços para testar, curva lucro×desconto, break-even) ·
`GET /api/data-quality/:loja` (score + problemas com R$ de impacto e como corrigir) ·
`GET /api/marketing/:loja/:periodo/`{`resultado`, `produtos`, `recommended-products`,
`do-not-promote`, `stagnant-stock`, `baskets`, `combos`, `campaign-builder`, `products/:ean`} ·
`GET /api/marketing/:loja/campaign-efficiency` · `POST /api/marketing/:loja/offer-simulator` ·
CRUD `GET/POST/PATCH/DELETE /api/marketing/:loja/campaigns[/:id]`.

**Concorrentes** — `GET /api/concorrencia/:loja` (análise completa) ·
`POST /api/concorrencia/:loja/ofertas` (registrar 1 ou N, vale p/ as 2 lojas) ·
`POST /api/concorrencia/:loja/colar` (interpreta texto de encarte, não salva).

**Intelligence** — `GET /api/intelligence/:loja/`{`war-room`, `recommendations`, `signals[/:id]`,
`patterns`, `investigations[/:id]`, `decisions[/:id]`, `ontology`, `editorial-plan`} ·
`POST …/detect`, `…/investigate`, `…/decisions`, `…/decisions/:id/outcomes`, `…/ontology/sync`,
`…/ask` · `PATCH …/signals/:id`, `…/actions/:id`.

**Conexões / Análise Comercial** — `GET /api/ontologia/:loja/:periodo` ·
`GET /api/analise-comercial/:loja[/:ym]` · `POST /analise-comercial/upload` (token) ·
`POST /analise-comercial/gerar/:loja/:ym` (usa a API da Anthropic).

**Upload / publicação** — `POST /upload/`{`vendas`, `analise`, `concorrentes`, `instagram`, `promocoes`} ·
`GET /api/promocoes/:loja` (promoções planejadas vigentes) ·
`POST /api/publicar` (força regenerar + Supabase) · `POST /api/catalogo/produtos/:id` (correção manual).

**Export** — `GET /export/:loja/:periodo` e `/export-analise/:loja/:ym` (HTML autocontido de 1 tela) ·
`GET /publico/*` (o site estático, sem login).

---

## 6. Telas (frontend `public/app.js` — vanilla JS, SVG à mão, sem framework)

| Tela (sidebar) | Conteúdo |
|---|---|
| **Command Center** (Fase A · tela de abertura) | Alertas (ruptura com venda relevante / concorrência atacando / capital parado / feed faltando) · linha de resumo (analisados · anunciáveis · bloqueados · mix de papéis) · **🔥 O que anunciar hoje** — cards ranqueados por Opportunity: papel + ação sugerida, mini-barras dos sub-scores (Opport./Tráfego/Lucro/Desova/Campanha/Criativo), interpretação, 3 motivos com evidência, chips de tendência/cobertura/margem · **⛔ O que NÃO anunciar** — motivo curto + motivos com evidência + substituto |
| **Painel** | 4 cartões de resumo + abas: Visão Geral · Vendas · Redes Sociais · Concorrência · Categorias · Top Produtos · Tendência. Gráficos SVG (combo barras+linha, donut, dia-da-semana, tendência). |
| **Marketing** (14 abas) | **Resultado** (KPIs de lucro/capital parado/risco + matriz visual + tabelas top-lucro / vende-e-não-lucra / custo-a-conferir / peso-morto / ruptura / sumindo) · Produtos · Recomendados · Não anunciar · Estoque parado · Cestas & Combos · Eficiência · **Precificação** (ranking "o que colocar em promoção" pelo lucro incremental + busca por produto → preço recomendado, 3 preços para testar, curva lucro×desconto em SVG, break-even, comparação com a promoção planejada) · **Curva ABC** (produtos A/B/C em barra + tabela, categorias, concentração de cliente) · **Medição** (por campanha do calendário: baseline mesmo dia da semana, incremental, canibalização + campo de investimento → ROAS e retorno sobre margem) · **Playbooks** (por campanha recorrente: badge de tendência, melhor dia, barras de lift por dia, veredito, produtos + ângulo dominante; seção de fadiga de produto) · **Calendário** (semana a semana + ocorrências com status OK/SUSPENDER/RENOVAR/REVISAR + slots sugeridos + ciclo fechado) · **Montar campanha** (Campaign Builder 2.0: escolhe dias + tema → campanha inteira com score, elenco por papel, preço/ângulo/forecast por item, combos e forecast em 3 cenários) · Simulador de oferta |
| **Concorrentes** | Botão **➕ Registrar oferta** (formulário rápido **ou** "colar encarte/post" → preview → salvar em lote) · KPIs (ofertas, abaixo do nosso, desconto médio) · Leitura automática + ações · **Onde reagir** (priorizado, com veredito, + "promover no lugar") · **Share of Promotions** (nossa ação promocional da tabela de promoções × ofertas do concorrente, por categoria) · Por concorrente (pressão + categorias atacadas) · Pressão por categoria |
| **Intelligence** (7 abas) | **War Room** (bloco escuro: prioridade #1, decisões recomendadas, Threat/Opportunity Map, contradições, situação por categoria) · **Recomendações** (decisões cruzadas + "Registrar como decisão") · Sinais (com "Por quê?", Observando, Resolver, Virar decisão) · Investigações · Decisões · Padrões · Pauta 7 dias · Perguntar |
| **Conexões** | grafo radial SVG — nós (loja/categoria/canal/campanha/concorrente/sinal/…) ligados por arestas com significado; clique → foco + painel lateral navegável |
| **Análise Comercial** | diagnóstico executivo, decisão principal, KPIs, baseline semanal, scorecard de campanhas, canais, riscos, ações, "o que mudou", faixa SIM/NÃO (só se houver JSON do Motor) |
| **Upload de dados** | envio manual (loja, mês, PDF, form do Instagram, xlsx de concorrentes) + card separado **tabela de promoções** (xlsx/csv, sem loja/mês — o parser descobre) |
| **Histórico** | todos os meses processados por loja |
| **Configurações** | card **Qualidade dos dados** (score 0–100 + problemas com severidade / R$ / como corrigir + freshness dos feeds) · pasta `inbox/` + log dos últimos arquivos · card "Catálogo (EAN)" com freshness de estoque/custo/preço |

A tela de abertura passou a ser o **Command Center** (`#command`); Painel segue no menu.

**Mobile** — barra de navegação **fixa embaixo** (ícone + label), topbar compacta (marca +
seletores lado a lado), tabelas viram cartões (rótulo por linha) ou rolam dentro do card,
KPIs/matriz em 2 colunas.

---

## 7. Configuração (`config/*.json` — editável sem tocar no código)

| Arquivo | O que controla |
|---|---|
| `lojas.json` | por loja: `cnpj` (roteia o PDF), `razaoSocial`, `horaFechamento`, `concorrentes[]`, **`campanhas[{nome, dias, categorias}]`** (calendário recorrente) |
| `categorias.json` | dicionário do classificador de categoria por palavra-chave (regras `contem`/`igual`/`exceto`, ordenadas) — usado só quando o ERP não classificou |
| `abc.json` | cortes da curva ABC (`corte_a` 0.80, `corte_b` 0.95) + janela (90d) |
| `elasticidade.json` | precificação de promoção: elasticidade-preço **em contexto de promoção** por categoria (% de unidades por 1% de desconto), `default`, `uplift_max`, `passo_desconto`, `desconto_teto`, `piso_margem_pct`, `duracao_dias_padrao`, `halo_r$_por_unidade` (efeito-cesta exibido, não entra na recomendação). Premissa até haver histórico de promoções para calibrar. |
| `grupos-erp.json` | "Nome Grupo" do ERP → `{categoria, subcategoria, classe_comercial}`; regras `prefixo:true` casam com o grupo (antes do " - ") para separar Genérico/Similar/Ético/OTC |
| `categorias-sinonimos.json` | vocabulário **canônico** (~11 categorias) + `aliases` (rótulo → canônico) + `super_grupos` (`Bebê` ⊇ Fraldas + Leite Infantil, para comparar com a concorrência) |
| `insights.json` | limiares das 3 regras de insight do Painel |
| `catalogo.json` | como reconhecer/ler as planilhas de estoque/custo/preço (nome do arquivo + sinônimos de coluna); `nome_todas_as_lojas` |
| `concorrentes.json` | pistas de nome de arquivo + sinônimos de coluna da coleta de concorrente |
| `promocoes.json` | pistas de nome de arquivo + sinônimos de coluna da **tabela de planejamento de promoções** — produto/EAN, preço de, **preço promo (inclui "Valor Aproximado")**, desconto, início, fim, campanha, loja |
| `marketing-stock.json` | limiares de dias de cobertura (ruptura/atenção/normal/oportunidade/parado) por categoria; `margem_pct_minima_para_anunciar`, `margem_pct_lucrativo`, `custo_proxy_entre_lojas` |
| `opportunity-score.json` | **pesos dos 7 componentes** do Opportunity Score + limiares de rótulo e de classe |
| `marketing-roles.json` | **Fase A** — limiares das regras de papel por produto (percentil + piso absoluto de volume) + categorias de recorrência/imagem + rótulo/ação/ícone de cada papel |
| `angulos.json` | **Fase B** — rótulo/ícone/template de copy de cada ângulo + pesos da seleção (desconto planejado, folga de margem, janela curta, concorrência) |
| `campaign-plan.json` | **Fase B/C/D/G** — desconto-alvo por papel + forecast + pesos do score (B); bloco `medicao` (C); bloco `padroes` — ocorrências mínimas, limiares de fadiga (D); bloco `calendario` — dias padrão, limiares de ruptura, dias de fluxo alto, nº de slots (G) |
| `basket-analysis.json` | mínimos de amostra/support/confidence/lift da cesta |
| `intelligence.json` | pesos do Priority Engine + limiares dos 11 detectores + prefixos de código |
| `usuarios.json` | `{ "Gustavo": "100603" }` — login do site (local + portão do site estático) |

---

## 8. Autenticação

- **Local** (`server.js`): `POST /login` com **usuário + senha**. `autentica()` aceita um
  usuário de `config/usuarios.json` **ou** o `APP_PASSWORD` do ambiente (mestre, default `1234`).
  Cookie `va_session` assinado (HMAC-SHA256, `SESSION_SECRET`), 30 dias.
- **Site estático** (Vercel/Pages): `publicar.js` embute um **portão** — overlay de login que
  compara `SHA-256("usuario:senha")` (via `crypto.subtle` no navegador) contra os hashes de
  `config/usuarios.json`. O acesso fica lembrado em `localStorage` (`analytics_gate_v2`) por
  **até 12 h** e depois volta a pedir; o botão **Sair** limpa (`window.__gateLogout__`). ⚠️ É
  um portão **leve** (o HTML é estático) — segura link compartilhado casual, **não** é
  segurança forte. Segurança real exigiria a função serverless.

---

## 9. Deploy e integrações

### Local (o "cérebro")
`node server.js` na porta 4180 (`iniciar.bat`). Precisa ficar ligado — é ele que observa a
`inbox/`, processa, roda a detecção e publica. Lê `.env` no boot (loader próprio, sem
dependência).

### Supabase (Postgres) — o "correio"
`.env`: `SUPABASE_DB_URL` (connection string, pooler porta 5432 p/ o PC) + `SUPABASE_URL` +
`SUPABASE_ANON_KEY` (chave **publishable** `sb_publishable_…`). Rode `sql/supabase.sql` uma vez
(cria `analytics_snapshots` + `analytics_publicacao_meta`, prefixo `analytics_` porque o projeto
já tem tabelas de outro sistema). A cada ingestão o PC faz UPSERT de ~43 snapshots. RLS:
leitura pública nas 2 tabelas + `GRANT SELECT to anon`.

### Sites estáticos — a "vitrine"
- `publico/index.html` (≈1,6 MB) = o app inteiro assado, lê o Supabase ao vivo via PostgREST,
  fallback nos dados embutidos.
- **Vercel**: `https://sdawd-sage.vercel.app/` — `vercel.json` na raiz (`framework:null`,
  `outputDirectory:publico`) + `.vercelignore` (bloqueia `server.js`) fazem o deploy ser 100%
  estático independente do "Root Directory" do painel.
- **GitHub Pages**: `https://thgustavo62-design.github.io/Analytics/` — branch `gh-pages`
  (worktree), `index.html` + `.nojekyll`.
- **Atualizar o código do site**: regenerar `publico/index.html` (`POST /api/publicar`), depois
  `git push` na `main` (Vercel redeploya) e re-push do `gh-pages`. **Dados** não precisam de
  push — são ao vivo pelo Supabase.

### GitHub
`github.com/thgustavo62-design/Analytics` (público). `main` + `gh-pages`.

---

## 10. Regras não-negociáveis (implementadas)

1. Minas Farma e Farma e Farma **nunca** são somadas — tudo por `loja_id`/`periodo_id`.
2. Painel não é publicado se `Σ vendas ≠ "Total:"` do PDF — `parsers/vendas.js` **lança**, nada grava.
3. Loja do PDF vem do **CNPJ** do cabeçalho; não reconheceu → lança em vez de adivinhar.
4. **A IA nunca faz aritmética** sobre a base — a camada determinística agrega, o LLM interpreta.
5. Toda conclusão de sinal/recomendação carrega **evidência** (campo, valor, fonte, período) e **confiança**.
6. Feed ausente (sem custo/estoque/concorrência) → campo `null` + flag em `dados_ausentes` — **nunca estimado**. Exceção declarada: custo do EAN pode ser tomado da outra loja como **proxy** (marcado `custo_proxy`, nunca soma resultados das duas).
7. Categoria de produto: **"Nome Grupo" do ERP** (planilha de estoque) quando existe, senão **palavra-chave** (fallback). Correção manual vence tudo. Todo rótulo — nosso, do ERP, da coleta de concorrente — passa pelo **vocabulário canônico** (`categorias.js`) antes de ser comparado/agregado.
8. Dia parcial (relatório do meio do dia) é marcado e **excluído dos gráficos de tendência**.
9. Custo cadastrado > 1,3× preço → `custo_suspeito` (erro provável de ERP), fora dos agregados de margem.
10. Migrations só `ADD COLUMN` / `CREATE IF NOT EXISTS` — nenhum `DROP`/`ALTER` destrutivo.

---

## 11. Testes

`npm test` (`node --test`) — **116 testes**, arquivos em separado (`process.env.VA_DB_PATH`
isola um banco temporário). Fixtures = PDFs reais de agosto/2026 em `C:\Users\Admin\Downloads\`.

| Arquivo | Cobre |
|---|---|
| `vendas.test.js` | soma == "Total:" impresso (agosto das 2 lojas), ARREDONDAMENTO negativo, aborta quando não bate |
| `command-center.test.js` | **Fase A** — papel por produto (HERO / DESOVA / GIRO fallback / supressão por do-not-promote), sub-scores (profit null sem custo, clearance null sem estoque, creative sempre null, campaign cortado se bloqueado), plano do dia ranqueado com evidência e papel válido |
| `campaign-builder.test.js` | **Fase B** — ângulo segue o desconto planejado / o papel / a concorrência; preço sugerido respeita o piso de margem; `parseDias`; combos com flag `viavel` + filtro `apenasViaveis`; `montarCampanha` — janela contígua, elenco por papel, forecast em 3 cenários monotônicos, score 0–100, margem null sem custo |
| `campaign-measure.test.js` | **Fase C** — erro claro fora do calendário; exige nome ou dias+categorias; incremento total ≈ (média − baseline) × dias; canibalização só com baseline do mesmo dia da semana; ROAS/retorno só com investimento; lucro null sem custo; `medirTodasDoCalendario`; medição ad-hoc por dias+categorias |
| `padroes-mkt.test.js` | **Fase D** — uma entrada por campanha; `por_dia_semana` ordenado por lift; `tendencia` em conjunto válido; lift da ocorrência ≈ receita campanha / baseline; veredito coerente com a tendência; fadiga só de categoria de campanha, ainda vendendo (`lift_atual > 0`), com queda real e volume mínimo |
| `concorrencia-analise.test.js` | **Fase E** — `share_promocoes`: estrutura, `nossas_promocoes_total` 0 sem campanhas cadastradas, linha "nós" em `por_concorrente`, categoria do calendário marcada recorrente, "subcomunicando" só com ≥2 ofertas abaixo do nosso preço e sem ação nossa; `contra_ataque` nunca aponta o próprio produto e só surge quando não vale cobrir |
| `calendar.test.js` | **Fase G** — janela começa depois do último dia de dados; ocorrências caem no dia-da-semana da campanha e dentro da janela; `status` em conjunto válido, ajuste com motivo + evidência; slots só de categoria sem campanha; ciclo fechado com uma entrada por campanha, recomendação e link de montagem |
| `promocoes.test.js` | **tabela de promoções** — parser (colunas, datas `DD/MM` lidas certo, desconto↔preço derivado, resolução de loja); `promocoesVigentes` filtra por data (vigente/futura/expirada/sem-prazo); re-upload não duplica (`chave`); Share of Promotions passa a citar a fonte "tabela de planejamento" |
| `categorias.test.js` | **vocabulário canônico** — `categoriaCanonica` (aliases antigos e da coleta, desconhecido em title-case); `mapGrupoErp` (prefixo separa OTC de Ético; subgrupo vira subcategoria; grupo sem regra → null); `expandirSuperGrupo`; `upsertProduto` não deixa a categoria de vendas sobrescrever a do ERP |
| `abc.test.js` | **curva ABC** — corte cumulativo A/B/C (classe do % acumulado ANTES do item; receita 0 → C; pct soma ~100); `curvaABC` (produtos + categorias ordenadas com classe + clientes); `analisarProdutos` marca `.abc` e `recomendados` esconde a classe C (`incluirC` traz de volta) |
| `promo-pricing.test.js` | **precificação de promoção** — `elasticidadeDe` (categoria configurada / default / canonicalização); `oportunidadesPromo` ranqueia desc por lucro incremental, exclui classe C, só entra com desconto e lucro > 0, soma bate com o agregado, balde `sem_custo` sem lucro projetado; `precificarProduto` (curva ≥2, `recomendado` = ponto de maior lucro incremental, preço = normal×(1−desc), nunca abaixo do piso de margem, monotonia demanda×desconto, efeito-cesta presente mas fora do ranqueamento); produto inexistente → erro |
| `data-quality.test.js` | **Data Quality** — score 0–100; `por_severidade` soma = nº de problemas; cada problema com severidade válida + `titulo`/`n`/`como_corrigir`; problemas ordenados ALTO→BAIXO; `freshness` dos feeds; detecta `custo_maior_que_preco` num produto inserido com custo acima do preço; custo proxy entre lojas (produto sem custo próprio usa o da outra loja, marcado) |
| `concorrentes.test.js` | filtro de marca, parse de validade/preço, resolução de loja por CNPJ |
| `catalogo.test.js` | `normalizarEan`, `sincronizarProdutosDeVendas`, histórico de custo, planilha combinada estoque+custo+preço |
| `marketing-product.test.js` | janelas monotônicas, clamp de tendência, 7 componentes do score somando ao score, confiança < 1 sem feed, classes, do-not-promote |
| `basket.test.js` | support/confidence/lift dentro dos limites, materialização, sem pseudo-produto |
| `campanhas.test.js` | DEMAND_LIFT, nunca DESTRUTIVA sem custo, Campaign Builder por categoria, Offer Simulator (3 cenários), import idempotente do calendário, CRUD |
| `intelligence.test.js` | Priority Engine monotônico, dedupe (2ª rodada 0 novos), evidência em todo sinal, sinal que some é resolvido, War Room, investigação, decisão→resultado→padrão, ontologia idempotente, Ask formato analista, Editorial 7 dias |
| `analytics-deep.test.js` | números de agosto (faturamento, cupons), baseline semanal, incrementalidade |
| `ingest.test.js` | `resolveLoja` por CNPJ / razão social |
| `validate-analise.test.js` | contrato do JSON do Motor (chaves, tipos, campos null) |

---

## 12. Limitações conhecidas / próximos passos

Ver [`docs/AUDITORIA.md`](docs/AUDITORIA.md) (Decision Intelligence, 7 fases) e
[`docs/MARKETING-COMMAND-CENTER.md`](docs/MARKETING-COMMAND-CENTER.md) (brief de marketing,
7 fases — **A–E e G entregues; só a F falta**). Faltam, principalmente:

- **Creative Intelligence** + Content Gap — travado no feed de log de publicações (Fase F)
- **Refinamento de dados** (em curso): ✅ categoria real do ERP + vocabulário canônico +
  reconciliação com a concorrência; ✅ **curva ABC** (listas de recomendação e Campaign Builder
  usam só A+B; ~2.800 SKUs de cauda fora). ✅ **curva ABC**; ✅ **tela Data Quality** (score + problemas com R$ e como corrigir); ✅ **custo proxy entre lojas** (loja sem custo para um EAN usa o da outra, marcado); ✅ **Precificação de promoção** (`marketing/promo-pricing.js` — preço recomendado pelo lucro incremental, 3 preços para testar, curva lucro×desconto, ranking "o que promover"). Falta: **momentum por subcategoria**; **calibrar a elasticidade** pelo histórico real quando as promoções da tabela tiverem janelas passadas (hoje é premissa de categoria em `config/elasticidade.json`).
- **Forecast Engine** (previsão 7/15/fechamento + probabilidade de meta)
- **Meta Engine** (metas em `config/lojas.json` → realizado/gap/venda-diária-necessária)
- Card único **R$ potencial identificado / R$ em risco** consolidado
- **Curva ABC** (produtos / categorias / clientes)
- **Data Quality** + score (produto sem categoria/custo, estoque negativo, campanha sem período…)
- **Benchmark Minas × Farma** (com resultados agregados, nunca juntando `vendas_transacoes`)
- **Rules Engine declarativo** (`config/rules.json`) no lugar das regras hardcoded em `detectores.js`
- Tabela `recommendations` própria + ciclo NEW→VIEWED→ACCEPTED→EXECUTED→MEASURED
- **Audit Log** unificado (uploads/config/ações com antes/depois)
- Acabamento visual "corporativo" (paleta de status, componentes reutilizáveis, skeleton loaders)

Pendências operacionais:
- Trocar a senha do Postgres (`asdasdawdawdfawf` é fraca e passou por texto; repo público).
- `publico/index.html` e `analytics/index.html` são regerados a cada ingestão → aparecem
  sempre como *modified* no working tree (esperado; commitar quando quiser refrescar o fallback).
- Instagram só entra por formulário/JSON manual (sem OCR).
- Análise Comercial via IA precisa de `ANTHROPIC_API_KEY` no ambiente; sem ela, só por JSON.
