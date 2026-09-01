# Marketing Opportunity Score — referência

Camada 100% determinística (`marketing-product-analytics.js`). A IA nunca calcula nada aqui —
ela só lê o resultado pronto quando precisa explicar uma decisão.

## Janelas

Por produto (chave = EAN normalizado; sem EAN, descrição), a partir de `vendas_transacoes`
cruzando `periodos.loja_id` (uma loja nunca mistura com a outra):

- **unidades / receita / cupons**: 7, 14, 30, 60, 90 dias, terminando na última data com venda
  da loja (`refDate`).
- **venda média diária**: `unidades_30d / 30` (e `unidades_7d / 7`).
- **tendência**: unidades/dia dos últimos 14d vs. os 14 anteriores (não 30x30 — cabe dentro de
  um único mês de upload). Rótulo SUBINDO/ESTÁVEL/CAINDO/SEM_BASE; percentual sempre limitado a
  ±300% para a UI não estourar com produto de baixíssimo volume.

## Days-of-cover

`dias_cobertura = estoque_disponível / venda_média_diária_30d`. Limiares em
`config/marketing-stock.json`, com override por categoria (Fraldas/Leite Infantil aguentam mais
dias parados que Medicamentos). Rótulo: RUPTURA / ATENCAO / NORMAL / OPORTUNIDADE / PARADO.
**Sem feed de estoque, fica `null` e `cobertura_rotulo: "SEM_ESTOQUE"` — nunca estimado.**

## Margem

`margem_unitaria = preço − custo`, `margem_pct = margem_unitaria / preço`. Só calculada quando
há custo cadastrado (produto_custo, historizado por vigência). Sem custo: `null` (§60 do brief:
"se custo não existe, não calcule margem").

## Opportunity Score (0–100)

7 componentes, cada um calculado em `[0,1]`, pesos em `config/opportunity-score.json`:

| Componente | O que mede | Sem dado → |
|---|---|---|
| `demanda` | percentil da venda média diária 30d | sempre tem dado (vem de vendas) |
| `tendencia` | SUBINDO/ESTÁVEL/CAINDO dos últimos 14d | neutro 0.5 se base curta (<4 unidades nos 28d) |
| `margem` | `margem_pct` normalizada entre piso e teto configurados | neutro 0.5 sem custo |
| `estoque` | cobertura em relação aos limiares da categoria | neutro 0.5 sem feed de estoque |
| `campanha_historica` | lift real de receita da categoria nos dias de campanha do calendário vs. os demais (90d) | neutro 0.5 se a categoria não está em nenhuma campanha do calendário |
| `concorrencia` | concorrente com oferta abaixo do nosso na categoria, no período | neutro-baixo 0.4 sem coleta de concorrência no período |
| `cesta` | centralidade do produto nos pares de maior lift (Fase 4) | neutro 0.5 sem par relevante |

`score = Σ(valor × peso) / Σ(peso) × 100`. `confianca = Σ(peso dos componentes com dado real) /
Σ(peso total)` — cai automaticamente quando faltam feeds, nunca é maquiada. Cada componente
carrega `fonte` (frase com o número exato e o período) — é a evidência que sustenta o score.

Rótulo: `score ≥ 68` → ALTA · `≥ 45` → MEDIA · abaixo → BAIXA (limiares em `rotulos` no config).

## Classes de marketing

Regras determinísticas (não a IA) sobre percentil de receita/cupons, cobertura e concorrência:

- **PROTEGIDO** — cobertura em RUPTURA, ou margem abaixo do piso mínimo para anunciar.
- **GIRO_URGENTE** — estoque parado/sobrando (cobertura > limiar "parado" da categoria).
- **DEFESA** — categoria sob pressão de concorrência e o produto está entre os de maior receita.
- **HERO** — top percentil de receita 30d com cobertura saudável.
- **TRAFEGO** — top percentil de cupons (penetração) com cobertura saudável — puxa fluxo.
- **OPORTUNIDADE** — tendência subindo forte, ainda não é HERO/TRAFEGO.
- **COMPLEMENTAR** — baixo percentil de receita mas com giro mínimo — bom para combo.
- **GIRO** — default, sem sinal forte em nenhuma direção.

## Do-not-promote

Um produto entra na lista quando qualquer motivo dispara (todos com evidência
campo/valor/fonte/período):

1. **RUPTURA** — cobertura abaixo do mínimo de dias que uma campanha precisa
   (`campanha_dias_min`) e a tendência não está caindo (ou seja, anunciar aceleraria a falta).
2. **MARGEM** — `margem_pct` abaixo do piso (`margem_pct_minima_para_anunciar`).
3. **SEM_GIRO** — nenhuma venda em 90d e mais de `sem_giro_dias` dias desde a última venda.

Cada bloqueado ganha um **substituto sugerido**: mesma categoria, cobertura ok, margem igual ou
melhor, maior Opportunity Score.

## Endpoints

`GET /api/marketing/:loja/:periodo/produtos` (lista completa, filtros `classe`/`categoria`/`limite`),
`/recommended-products`, `/do-not-promote`, `/stagnant-stock`, `/products/:ean`.

Ver também [`campaign-engine.md`](./campaign-engine.md) (Fase 3) e a seção 7 de
[`EVOLUCAO-INTELLIGENCE.md`](./EVOLUCAO-INTELLIGENCE.md) para o registro completo da fase.
