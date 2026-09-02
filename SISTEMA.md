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
estoque+custo+preço, coleta de concorrentes, métricas de Instagram) jogados numa pasta,
processa sozinho e entrega:

- **Painel** de resultados (faturamento, ticket, categorias, top produtos, Instagram, concorrência)
- **Marketing Product Intelligence** — por produto: giro 7–90d, tendência, dias de cobertura,
  margem, classe (HERO/TRÁFEGO/…), **Opportunity Score 0–100** com breakdown, do-not-promote
- **Resultado** — cruzamento vendas × estoque × custo × margem: lucro estimado por produto,
  matriz (vaca leiteira / isca cara / peso morto / aposta / sumindo / ruptura), capital parado
- **Campanhas** — eficiência (DEMAND_LIFT), Campaign Builder, Offer Simulator
- **Cesta** — market basket (support/confidence/lift), combos
- **Concorrentes** — pressão competitiva, "onde reagir" priorizado, registro por formulário /
  colar encarte / planilha
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
     .xlsx  -> concorrente?  parsers/concorrentes.js (36 col OU planilha simples, config-driven)
             -> estoque/custo/preço?  catalogo.ingestPlanilhaProduto (1 arquivo alimenta os 3)
             -> em ambos: rodarDeteccao das lojas tocadas
     .json  -> análise comercial (validate-analise.js) OU instagram
                                 v
   db.js  (node:sqlite / DatabaseSync)  —  data/analytics.db  —  27 tabelas
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
   │ 9 telas                   │   │      lê Supabase ao vivo + fallback)   │
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
| `parsers/instagram.js` | normaliza o formulário / JSON de métricas do Instagram |
| `catalogo.js` | `sincronizarProdutosDeVendas()` popula `produtos` pelos EAN das vendas; `ingestPlanilhaProduto()` lê planilha de estoque — **um arquivo alimenta estoque + preço de venda + preço de promoção + custo** ("Últ. Prc. Entrada"); nome com `geral`/`rede` aplica nas 2 lojas |
| `classify.js` | categoria por palavra-chave (`config/categorias.json`) |
| `match.js` | casamento de nome de produto (Jaccard de tokens + marca como filtro duro) |

### Camada determinística (nenhuma IA — só soma e conta)
| Arquivo | Papel |
|---|---|
| `aggregate.js` | KPIs, série diária, dia-da-semana, categorias, top produtos, preço médio por produto |
| `analytics-deep.js` | ticket médio E mediano, baseline semanal c/ desvio, incrementalidade intradiária por campanha, canais Convênio/Delivery/Balcão, concentração cliente/convênio, operadores, resumo de concorrência |
| `insights.js` | 3 regras automáticas → cards (`config/insights.json`) |
| `marketing-product-analytics.js` | **Fase 2** — por produto: unidades/receita/cupons 7/14/30/60/90d, venda média diária, tendência (14d×14d, clamp ±300%), `dias_cobertura` por categoria (`config/marketing-stock.json`), margem (só com custo), classes, **Opportunity Score** (7 componentes + peso + contribuição + fonte + confiança, `config/opportunity-score.json`), `do-not-promote` + substituto, estoque parado. Memo de 45s. |
| `analise-cruzada.js` | vendas × estoque × custo × margem → `resultado_30d` (lucro estimado por produto), `capital_parado`, `giro_mensal`, **matriz** VACA_LEITEIRA/ISCA_CARA/PESO_MORTO/APOSTA/SUMINDO/RUPTURA/NORMAL, `custo_suspeito` (custo > 1,3× preço = erro de ERP, balde separado) |
| `concorrencia-analise.js` | panorama, por concorrente (pressão + categorias atacadas + exemplos), por categoria (ALTA/MÉDIA/BAIXA), **"onde reagir"** priorizado por relevância × quão abaixo × dá pra cobrir (margem real), resumo + ações |
| `campanhas.js` | **Fase 3** — `eficienciaCalendario` (DEMAND_LIFT dias-de-campanha vs. demais, veredito EXCELENTE→DESTRUTIVA; nunca DESTRUTIVA sem custo), **Campaign Builder** (elenco por papel), **Offer Simulator** (cenários conservador/provável/agressivo, nunca promete venda) |
| `basket.js` | **Fase 4** — cesta por cupom (`data+lancamento`): support/confidence/lift; corte de ruído (mínimo por produto isolado); `centralidade()`; `combos()` |

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

27 tabelas. Migrations **idempotentes** no boot: `schema.sql` roda `CREATE TABLE IF NOT EXISTS`
+ bloco de `ALTER TABLE … ADD COLUMN` em try/catch (engole "duplicate column name"). Nada é
destrutivo.

| Grupo | Tabela | Chave / notas |
|---|---|---|
| **Núcleo** | `lojas` | `id`, `nome` (Minas Farma / Farma e Farma) |
| | `periodos` | `(loja_id, ano, mes)`; guarda `vendas_ultimo_dia[_parcial/_motivo]`, `vendas_total_impresso` |
| | `vendas_transacoes` | `periodo_id`, `data`, `lancamento` (cupom), `barras` (EAN), `descricao`, `categoria`, `quantidade`, `valor_liquido`, `forma_pagto`, `emp_id`, `cli_id` |
| | `instagram_metricas` | `periodo_id`, `metrica`, `valor_exibicao`, `delta_pct` |
| | `concorrencia_ofertas` | `periodo_id`, `concorrente`, `produto`, `preco_normal/promo`, `validade`, `nivel_confianca`, `status_validacao`, `nosso_preco_medio`, `abaixo_do_nosso`, **`data_coleta`**, **`fonte`** (`coleta`/`manual`) |
| **Catálogo (Fase 1)** | `produtos` | `ean` UNIQUE (nullable), `descricao[_normalizada]`, `categoria`, `*_manual` (override vence), `fonte` (`vendas`/`catalogo`/`manual`) |
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

**Marketing** — `GET /api/marketing/:loja/:periodo/`{`resultado`, `produtos`, `recommended-products`,
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

**Upload / publicação** — `POST /upload/`{`vendas`, `analise`, `concorrentes`, `instagram`} ·
`POST /api/publicar` (força regenerar + Supabase) · `POST /api/catalogo/produtos/:id` (correção manual).

**Export** — `GET /export/:loja/:periodo` e `/export-analise/:loja/:ym` (HTML autocontido de 1 tela) ·
`GET /publico/*` (o site estático, sem login).

---

## 6. Telas (frontend `public/app.js` — vanilla JS, SVG à mão, sem framework)

| Tela (sidebar) | Conteúdo |
|---|---|
| **Painel** | 4 cartões de resumo + abas: Visão Geral · Vendas · Redes Sociais · Concorrência · Categorias · Top Produtos · Tendência. Gráficos SVG (combo barras+linha, donut, dia-da-semana, tendência). |
| **Marketing** (9 abas) | **Resultado** (KPIs de lucro/capital parado/risco + matriz visual + tabelas top-lucro / vende-e-não-lucra / custo-a-conferir / peso-morto / ruptura / sumindo) · Produtos · Recomendados · Não anunciar · Estoque parado · Cestas & Combos · Eficiência · Montar campanha · Simulador de oferta |
| **Concorrentes** | Botão **➕ Registrar oferta** (formulário rápido **ou** "colar encarte/post" → preview → salvar em lote) · KPIs (ofertas, abaixo do nosso, desconto médio) · Leitura automática + ações · **Onde reagir** (priorizado, com veredito) · Por concorrente (pressão + categorias atacadas) · Pressão por categoria |
| **Intelligence** (7 abas) | **War Room** (bloco escuro: prioridade #1, decisões recomendadas, Threat/Opportunity Map, contradições, situação por categoria) · **Recomendações** (decisões cruzadas + "Registrar como decisão") · Sinais (com "Por quê?", Observando, Resolver, Virar decisão) · Investigações · Decisões · Padrões · Pauta 7 dias · Perguntar |
| **Conexões** | grafo radial SVG — nós (loja/categoria/canal/campanha/concorrente/sinal/…) ligados por arestas com significado; clique → foco + painel lateral navegável |
| **Análise Comercial** | diagnóstico executivo, decisão principal, KPIs, baseline semanal, scorecard de campanhas, canais, riscos, ações, "o que mudou", faixa SIM/NÃO (só se houver JSON do Motor) |
| **Upload de dados** | envio manual (loja, mês, PDF, form do Instagram, xlsx) |
| **Histórico** | todos os meses processados por loja |
| **Configurações** | pasta `inbox/` + log dos últimos arquivos + card "Catálogo (EAN)" com freshness de estoque/custo/preço |

**Mobile** — barra de navegação **fixa embaixo** (ícone + label), topbar compacta (marca +
seletores lado a lado), tabelas viram cartões (rótulo por linha) ou rolam dentro do card,
KPIs/matriz em 2 colunas.

---

## 7. Configuração (`config/*.json` — editável sem tocar no código)

| Arquivo | O que controla |
|---|---|
| `lojas.json` | por loja: `cnpj` (roteia o PDF), `razaoSocial`, `horaFechamento`, `concorrentes[]`, **`campanhas[{nome, dias, categorias}]`** (calendário recorrente) |
| `categorias.json` | dicionário do classificador de categoria (regras `contem`/`igual`/`exceto`, ordenadas) |
| `insights.json` | limiares das 3 regras de insight do Painel |
| `catalogo.json` | como reconhecer/ler as planilhas de estoque/custo/preço (nome do arquivo + sinônimos de coluna); `nome_todas_as_lojas` |
| `concorrentes.json` | pistas de nome de arquivo + sinônimos de coluna da coleta de concorrente |
| `marketing-stock.json` | limiares de dias de cobertura (ruptura/atenção/normal/oportunidade/parado) por categoria; `margem_pct_minima_para_anunciar`, `margem_pct_lucrativo` |
| `opportunity-score.json` | **pesos dos 7 componentes** do Opportunity Score + limiares de rótulo e de classe |
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
  `config/usuarios.json`; sucesso salva em `localStorage`. ⚠️ É um portão **leve** (o HTML é
  estático) — segura link compartilhado casual, **não** é segurança forte. Segurança real
  exigiria a função serverless.

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
6. Feed ausente (sem custo/estoque/concorrência) → campo `null` + flag em `dados_ausentes` — **nunca estimado**.
7. Categoria de produto é **estimada por palavra-chave** — a UI avisa; não é o cadastro oficial.
8. Dia parcial (relatório do meio do dia) é marcado e **excluído dos gráficos de tendência**.
9. Custo cadastrado > 1,3× preço → `custo_suspeito` (erro provável de ERP), fora dos agregados de margem.
10. Migrations só `ADD COLUMN` / `CREATE IF NOT EXISTS` — nenhum `DROP`/`ALTER` destrutivo.

---

## 11. Testes

`npm test` (`node --test`) — **53 testes**, arquivos em separado (`process.env.VA_DB_PATH`
isola um banco temporário). Fixtures = PDFs reais de agosto/2026 em `C:\Users\Admin\Downloads\`.

| Arquivo | Cobre |
|---|---|
| `vendas.test.js` | soma == "Total:" impresso (agosto das 2 lojas), ARREDONDAMENTO negativo, aborta quando não bate |
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

Ver [`docs/AUDITORIA.md`](docs/AUDITORIA.md) para o gap analysis completo vs. o brief de
"Decision Intelligence" e o plano em 7 fases. Faltam, principalmente:

- **Nova Home / Central de Decisão** (hoje o Painel é o dashboard antigo)
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
