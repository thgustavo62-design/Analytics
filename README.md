# Vermelhinha Analytics

Site **autoalimentável** de resultados para **Minas Farma** e **Farma e Farma**
("A Vermelhinha"), Baixo Guandu/ES. Você joga os documentos brutos numa pasta
(`inbox/`) — relatório de vendas (PDF), planilha de concorrentes, e (opcional)
métricas do Instagram — e o site percebe sozinho, processa e mostra o painel de
vendas + redes sociais + concorrência, com o **mês corrente ao vivo** e histórico por
loja/mês. Nada para baixar, nada para clicar.

Projeto **independente** do `app_minasfarma/`. Não lê nem escreve nada lá dentro.

## Stack

- **Node.js** (>= 22; testado no 24) + **Express**. Sem Python.
- **SQLite** via `node:sqlite` (módulo nativo — sem build nativo, sem `better-sqlite3`).
- **PDF:** `pdfjs-dist` (JS puro). **Planilhas:** `xlsx` (SheetJS). **Watcher:** `chokidar`.
- Frontend: HTML/CSS/JS puro (sem framework, sem build). App shell com sidebar + abas.

## Rodar local

```bash
npm install
APP_PASSWORD=suasenha npm start
# http://localhost:4180  — deixe rodando; é o servidor "sempre ligado"
```

Depois é só **jogar os arquivos em `C:\Sistema Marketing\inbox`** (veja `inbox/LEIA-ME.txt`).
O painel do mês corrente se atualiza sozinho.

Variáveis de ambiente:

| Var | Default | Uso |
|---|---|---|
| `PORT` | `4180` | porta HTTP |
| `APP_PASSWORD` | *(gera uma temporária e mostra no console)* | senha única da ferramenta |
| `SESSION_SECRET` | *(aleatória por boot)* | assina o cookie de sessão; defina em produção |
| `VA_DB_PATH` | `data/analytics.db` | caminho do SQLite |
| `VA_INBOX` | `./inbox` | pasta observada |
| `VA_POLL_MIN` | `5` | de quantos em quantos minutos o navegador recarrega o mês corrente |
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

## Estrutura

```
server.js            rotas + auth por senha única + estáticos; buildAnalise() (usado pelo /export)
watcher.js           observa inbox/ (chokidar), serializa a ingestão, mantém data/inbox-log.json
ingest.js            recebe 1 arquivo -> detecta loja pelo CNPJ, split por mês, grava no banco
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
prompts/, schemas/   material de referência da Fase 2 (Motor de Análise Comercial) — ainda não implementada
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

## Fase 2 — Motor de Análise Comercial (não implementada)

Camada de análise profunda mensal gerada por LLM (ver `prompts/motor-analise-comercial.md`).
O plano é: uma tarefa agendada externa aplica o prompt, valida contra o schema e faz
`POST /analise-comercial/upload` (com token); o backend só recebe, guarda e serve o JSON
em telas de scorecard. Nada disso existe ainda no código.
