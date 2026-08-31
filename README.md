# Analytics

Site **autoalimentável** de resultados para **Minas Farma** e **Farma e Farma**,
Baixo Guandu/ES. Você joga os documentos brutos numa pasta (`inbox/`) — relatório de
vendas (PDF), planilha de concorrentes, e (opcional) métricas do Instagram — e o site
percebe sozinho, processa e mostra o painel de vendas + redes sociais + concorrência,
com o **mês corrente ao vivo** e histórico por loja/mês. Nada para baixar, nada para
clicar. Uma vez por mês gera também a **Análise Comercial** (diagnóstico + decisões),
cruzando as vendas com os concorrentes e com o calendário de campanhas de cada loja.

Projeto **independente** do `app_minasfarma/`. Não lê nem escreve nada lá dentro.

## Stack

- **Node.js** (>= 22; testado no 24) + **Express**. Sem Python.
- **SQLite** via `node:sqlite` (módulo nativo — sem build nativo, sem `better-sqlite3`).
  Tudo fica no banco (`data/analytics.db`): vendas, Instagram, concorrência e as
  **análises comerciais** (não se perdem se os arquivos forem mexidos).
- **PDF:** `pdfjs-dist` (JS puro). **Planilhas:** `xlsx` (SheetJS). **Watcher:** `chokidar`.
- **Análise Comercial:** `@anthropic-ai/sdk` (opt-in por `ANTHROPIC_API_KEY`).
- Frontend: HTML/CSS/JS puro (sem framework, sem build). App shell com sidebar + abas.

## Rodar local

```bash
npm install
npm start
# http://localhost:4180  — senha 1234 — deixe rodando; é o servidor "sempre ligado"
```

Depois é só **jogar os arquivos em `C:\Sistema Marketing\inbox`** (veja `inbox/LEIA-ME.txt`).
O painel do mês corrente se atualiza sozinho.

Variáveis de ambiente:

| Var | Default | Uso |
|---|---|---|
| `PORT` | `4180` | porta HTTP |
| `APP_PASSWORD` | `1234` | senha única da ferramenta |
| `SESSION_SECRET` | *(aleatória por boot)* | assina o cookie de sessão; defina em produção |
| `VA_DB_PATH` | `data/analytics.db` | caminho do SQLite |
| `VA_INBOX` | `./inbox` | pasta observada |
| `VA_POLL_MIN` | `5` | de quantos em quantos minutos o navegador recarrega o mês corrente |
| `VA_ANALISES` | `data/analises` | onde ficam os JSONs do Motor de Análise Comercial |
| `ANALISE_UPLOAD_TOKEN` | *(sem token)* | se definido, exige `X-Analise-Token` no `POST /analise-comercial/upload` |
| `ANTHROPIC_API_KEY` | — | se definida, o site **gera a Análise Comercial sozinho** (botão + auto após ingest) |
| `ANALISE_MODEL` | `claude-opus-5` | modelo usado para gerar a análise (ex.: `claude-sonnet-5` p/ gastar menos) |
| `AUTO_ANALISE` | *(ligado se há chave)* | `0` desliga a geração automática (mantém só o botão manual) |
| `VA_NO_AUTH` | — | `1` desliga a autenticação (**só para teste local**) |

`GET /healthz` responde sem login (health check).

## Fluxo — autoalimentação pela pasta `inbox/`

1. Você (ou uma Tarefa Agendada do Windows) salva na pasta `inbox/`:
   - **Relatório de vendas (PDF)** — "Analítico de Vendas". Pode ser o mês inteiro ou o
     mês-até-hoje. **Não precisa dizer a loja**: o site lê o CNPJ do cabeçalho e roteia
     para Minas Farma ou Farma e Farma. Um PDF que cobre vários meses vira um painel por
     mês. Se a soma ≠ "Total:" do rodapé, o arquivo é **recusado** e o painel anterior
     continua no ar (aparece em Configurações → "Últimos arquivos processados").
   - **Concorrentes (xlsx)** — `Concorrentes_Coleta_AAAA-MM-DD.xlsx` (36 colunas). Vale
     para as duas lojas (cada uma comparada com o próprio preço). Mês vem da data do nome.
   - **Instagram (opcional)** — arquivo `*instagram*.json`
     `{ "loja": "...", "periodo": "AAAA-MM", "metricas": { ... } }`. Ou use o formulário
     em **Upload de dados**.
2. O site processa na hora e o painel do mês corrente ("AO VIVO") se atualiza sozinho no
   navegador (a cada `VA_POLL_MIN` minutos e ao focar a aba).
3. **Upload de dados** (na sidebar) é o caminho manual, equivalente — útil pra Instagram e
   pra corrigir um mês.
4. **"Baixar painel (HTML)"** no topo do painel gera um `.html` autocontido daquele mês
   (abre sem servidor, dá pra mandar por e-mail/WhatsApp). Rota: `GET /export/{loja}/{AAAA-MM}`.

## Telas

- **Painel** — 4 cartões de resumo + abas (Visão Geral · Vendas · Redes Sociais ·
  Concorrência · Categorias · Top Produtos · Tendência). Abre no **mês corrente**.
- **Análise Comercial** — a análise profunda mensal (Fase 2): diagnóstico executivo,
  decisão principal, KPIs, baseline semanal, scorecard de campanhas (com selo de decisão),
  canais, riscos, oportunidades, plano de ação, "o que mudou" e a faixa final SIM/NÃO.
- **Upload de dados** — envio manual (loja, mês, PDF, formulário do Instagram, xlsx).
- **Histórico** — todos os meses processados, por loja; clique para abrir.
- **Configurações** — caminho da pasta `inbox/` e log dos últimos arquivos processados.

### Cobertura do parser de vendas

Testado contra os 10 relatórios "Analítico de Vendas" reais em `C:\Users\Admin\Downloads\`
(de 1.391 a 72.480 linhas) — todos reconciliam **exatamente** com o "Total:" impresso.
Trata: coluna `Nº Cx` ausente, valores negativos de `ARREDONDAMENTO`, e detecção de dia
parcial (hora de fechamento por loja em `config/lojas.json` → `horaFechamento`). Rejeita
com mensagem clara PDFs que não são esse relatório (extrato bancário, NF-e, etc.).

### Radar de concorrência

Casa `Produto` + `Marca` da planilha com o que a loja vendeu no mês. A **Marca é filtro
duro**: "Loção Nivea" não casa com "FLETOP LOCAO", "Colgate Tripla Ação" não casa com
"COREGA ... TRIPLA ACAO". Ainda assim é leitura **direcional** (casamento aproximado de
nome) — o painel diz isso e mostra o nível de confiança de cada oferta. Concorrentes sem
coleta no período aparecem como "sem coleta", não somem.

### Calendário de campanhas (`config/lojas.json` → `campanhas`)

Cada loja tem seu calendário próprio; a análise avalia **cada campanha separadamente**,
pelo método intradiário (participação da(s) categoria(s) no faturamento do próprio dia,
campanha vs. 2 baselines — neutraliza o efeito do dia da semana).

| Loja | Campanha | Dias | Categorias |
|---|---|---|---|
| Minas Farma | Fralda e Leite | segunda e terça | Fraldas, Leite Infantil |
| Minas Farma | Limpeza | sexta a domingo | Limpeza |
| Farma e Farma | Fralda e Leite | quarta e quinta | Fraldas, Leite Infantil |
| Farma e Farma | Limpeza | sexta a domingo | Limpeza |

"Limpeza" virou uma categoria própria (`config/categorias.json`), separada de
Perfumaria/Higiene, justamente para essa medição. Ajuste os dias/categorias em
`config/lojas.json` — não precisa mexer no código.

### Como as análises cruzam os dados

`analytics-deep.js` monta (de forma determinística) tudo que a Análise Comercial precisa e
que o painel não mostra: ticket **médio E mediano**, itens por compra, SKUs distintos,
curva de Pareto, baseline semanal **com desvio padrão e N**, participação intradiária de
cada campanha (com 2 baselines), canais **Convênio / Delivery / Balcão** (cruzando `Emp.ID`
com taxa de entrega), concentração por **cliente** e por **convênio**, dispersão por
**operador**, e o **resumo da coleta de concorrentes do mês** (quantas ofertas abaixo do
nosso preço médio, por concorrente, com exemplos). O modelo recebe esse pacote + o
calendário de campanhas e **só interpreta e decide** — nunca faz conta sobre a base.

## Regras não-negociáveis (implementadas)

- Minas Farma e Farma e Farma nunca são somadas juntas — toda agregação passa por
  `periodo_id`, que pertence a uma única loja.
- Painel não é publicado se a soma ≠ `Total:` do PDF — `parsers/vendas.js` lança e o
  endpoint responde erro sem tocar no banco.
- Categoria de produto é **estimada por palavra-chave** (`config/categorias.json`) — o
  painel avisa isso no rodapé e nos gráficos. Não é o cadastro do sistema.
- Dia parcial (relatório extraído no meio do dia/mês) é marcado como tal e **excluído do
  gráfico de tendência**, mantido só na tabela.
- Oferta de concorrente só entra na comparação se `Status validação = Confirmada` e não
  expirada; o nível de confiança aparece como badge.
- Análise Comercial fica **no banco** (`analises_comerciais`) — apagar os arquivos em
  `data/analises/` não perde nada; eles são só espelho/exportação.
- Modelo da análise **nunca faz aritmética sobre a base bruta** — `analytics-deep.js`
  agrega, o LLM interpreta os agregados.

## Estrutura

```
server.js            rotas + auth por senha única + estáticos; buildAnalise() (usado pelo /export)
watcher.js           observa inbox/ (chokidar), serializa a ingestão, mantém data/inbox-log.json
ingest.js            recebe 1 arquivo -> detecta loja pelo CNPJ, split por mês, grava no banco
validate-analise.js  validador (sem dep) do JSON do Motor de Análise Comercial (Fase 2)
analise-store.js     grava a análise no banco (analises_comerciais) + espelho em data/analises/*.json
analytics-deep.js    agregados profundos p/ o Motor (ticket mediano, baseline c/ desvio, incrementalidade
                     intradiária por campanha, canais convênio/delivery, concentração cliente/convênio,
                     operadores, resumo da coleta de concorrentes)
motor.js             gera o JSON via API da Anthropic a partir dos agregados profundos (opt-in por ANTHROPIC_API_KEY)
db.js                node:sqlite — acesso, sempre por loja/período
schema.sql           tabelas
parsers/vendas.js    PDF "Analítico de Vendas" -> transações + empresa (CNPJ) + validação da soma
parsers/instagram.js normaliza o formulário / JSON manual
parsers/concorrentes.js  xlsx 36 col -> ofertas confirmadas x nosso preço médio (marca = filtro duro)
classify.js          classificador de categoria (config/categorias.json)
aggregate.js         transações -> KPIs, série diária, dia da semana, categorias, top produtos
insights.js          3 regras automáticas -> cards (config/insights.json)
match.js             casamento de nome de produto (Jaccard de tokens + marca), portado do app_minasfarma
config/              categorias.json · insights.json · lojas.json (cnpj, dias de campanha, horaFechamento, concorrentes)
public/              index.html (app shell) · app.js · styles.css · upload.html (redireciona p/ #upload)
inbox/               pasta observada (LEIA-ME.txt versionado; o resto é ignorado)
test/                vendas.test.js (soma == Total impresso) · concorrentes.test.js (filtro de marca, datas, preços)
data/                analytics.db · inbox-log.json · uploads/<loja>/<ano-mes>/ (gitignored)
prompts/             motor-analise-comercial.md — system prompt + contrato da Fase 2 (referência p/ a tarefa que gera o JSON)
schemas/             analise-comercial.example.json — exemplo do JSON (fixture dos testes)
docs/integracoes.md  ferramentas que dá para plugar (WhatsApp, Instagram API, Postgres do ERP, túnel, backup…)
```

## Testes

```bash
npm test
```

O teste do parser roda contra os PDFs reais de agosto/2026 em `C:\Users\Admin\Downloads\`
(`vendas agosto farma e farma.pdf` → R$ 196.566,57 / 4.169 vendas / 9.353 itens;
`vendas agosto minas farma.pdf` → R$ 478.723,02, incluindo linhas de ARREDONDAMENTO
negativas). Aponte para outro arquivo com `VENDAS_FIXTURE=<caminho>` /
`VENDAS_FIXTURE_MINAS=<caminho>`, ou copie um PDF para `test/fixtures/`.

## Como manter "sempre ligado" nesta máquina

A autoalimentação depende do servidor rodando. Opções, da mais simples à mais robusta:

- **`npm start` numa janela aberta** (ou um `.bat` com `node server.js`, como o
  `iniciar_servidor.bat` do `app_minasfarma`).
- **Tarefa Agendada do Windows** disparando no logon, ação "Iniciar programa" =
  `node`, argumento `server.js`, "Iniciar em" = `C:\Sistema Marketing`.
- **Serviço do Windows** com [nssm](https://nssm.cc) (`nssm install VermelhinhaAnalytics`).

Para as vendas atualizarem sem você exportar à mão: uma segunda Tarefa Agendada que roda
o export do "Analítico de Vendas" do mês corrente do sistema da farmácia e salva o PDF
direto em `inbox/`.

## Deploy hospedado (futuro)

Render/Railway cobrem o uso, mas aí **não dá para observar uma pasta local** — a
autoalimentação viraria só o upload manual + `POST` de um agente externo. O SQLite
precisa de disco persistente; senão, Postgres gerenciado. Defina `APP_PASSWORD` e
`SESSION_SECRET`.

## Fase 2 — Análise Comercial

Análise profunda mensal (diagnóstico, decisão principal, scorecard de campanhas, riscos,
plano de ação, "o que mudou", faixa SIM/NÃO). Fica **no banco** (`analises_comerciais`),
uma por loja/mês.

Como o JSON chega — três caminhos, do mais automático ao mais manual:

1. **O próprio site gera** (se `ANTHROPIC_API_KEY` estiver no ambiente). `analytics-deep.js`
   monta os agregados profundos (ver "Como as análises cruzam os dados" acima) — incluindo o
   **cruzamento vendas × concorrentes × calendário de campanhas de cada loja** — e `motor.js`
   chama a API passando **só os agregados + o calendário**; o modelo interpreta e decide, no
   contrato da Parte 2 (`prompts/motor-analise-comercial.md`), com uma entrada em `campanhas[]`
   por campanha do calendário. Valida com `validate-analise.js` (1 retry). Dispara: botão
   **"Gerar análise agora" / "Regerar"** na tela; automático após ingest de vendas do mês
   corrente/anterior (`AUTO_ANALISE=0` desliga); verificação diária. Modelo em `ANALISE_MODEL`
   (padrão `claude-opus-5`; `claude-sonnet-5` sai mais barato). Alguns centavos por rodada.
2. **Pela pasta `inbox/`** — salve um `*.json` com o conteúdo da análise (reconhecido pelo
   `meta` + `diagnostico_executivo`). Para quem gera por fora (Cowork/rotina).
3. **Por `POST /analise-comercial/upload`** — para um agente externo. Cabeçalho
   `X-Analise-Token: <ANALISE_UPLOAD_TOKEN>` se a variável estiver definida. Corpo = o JSON.

Em ambos os casos: **valida contra o schema antes de gravar**. Se falhar → responde `422`
(ou registra o erro no log da `inbox`), guarda uma cópia `analise_AAAA-MM.INVALIDO.json`
para inspeção e **mantém a análise anterior no ar**. `loja` vem de `meta.loja`; o mês vem
de `meta.periodo.inicio`.

Ler: `GET /api/analise-comercial/{loja}` (última) · `GET /api/analise-comercial/{loja}/{AAAA-MM}`.
A tela **Análise Comercial** (sidebar) renderiza tudo; "Baixar (HTML)" gera o
`.html` autocontido dessa análise (`GET /export-analise/{loja}/{AAAA-MM}`).
