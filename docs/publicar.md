# Cópia estática que se regenera (`publicar.js`)

O sistema é **autoalimentável** (observa a `inbox/`, processa, atualiza o banco) — e isso
precisa de um processo rodando. Um `.html` estático puro não observa pasta nem lê PDF.

A ponte é a **cópia estática**: a cada ingestão, o servidor assa **todas** as respostas da
API dentro de um HTML autocontido por loja (Painel + Marketing + Intelligence) e grava em
`VA_PUBLIC_DIR`. Esse HTML abre sem servidor — é o artefato "publicável".

## Como funciona

1. `server.js` chama `regenerarPublicoEmBreve()` (debounce 4 s) depois de cada `/upload/*`
   e detecta ingestões do watcher comparando `getLog().length` a cada 20 s. Também roda no
   boot (12 s depois de subir).
2. `publicar.regenerar()` faz `fetch` na própria API local (`http://localhost:PORT/...`) com
   um cookie de sessão recém-emitido, para cada loja com vendas:
   - `/api/analise/:loja/:ym` (Painel)
   - `/api/marketing/:loja/:ym/{produtos,recommended-products,do-not-promote,stagnant-stock,baskets,combos,campaign-builder}` + `/api/marketing/:loja/campaign-efficiency`
   - `/api/intelligence/:loja/{war-room,signals,investigations,decisions,patterns,editorial-plan}`
   - `/api/catalogo/:loja`
3. Monta `<slug-da-loja>.html` = `public/styles.css` + `public/app.js` + o corpo de
   `public/index.html` + um `<script>` que:
   - define `window.__PUBLICO__ = true` e `window.__EXPORT__ = true`;
   - substitui `window.fetch` por um roteador que devolve os dados assados (casando o path
     da URL, ignorando query string); qualquer `GET` sem dado assado → 404 amigável;
     qualquer `POST` (rodar detecção, simular, perguntar, upload) → 503 "só no site ao vivo".
   - insere uma faixa "📄 Cópia estática · <data>" no topo.
   `body.publico` no CSS esconde os controles que dependem do servidor.
4. Escreve também `index.html` (lista as lojas + data de geração).

## Onde publicar

`VA_PUBLIC_DIR` aponta para onde o HTML deve cair. Exemplos:

| Destino | Como |
|---|---|
| **OneDrive / Google Drive** | `VA_PUBLIC_DIR=C:\Users\...\OneDrive\Analytics`. O Drive sincroniza; você compartilha o link do `index.html`. |
| **GitHub Pages** | `VA_PUBLIC_DIR` = uma pasta de um repo local; um `git commit && git push` no `post` do watcher (ou uma Tarefa Agendada) publica em `usuario.github.io/repo/`. |
| **Netlify drop** | `VA_PUBLIC_DIR` = pasta observada pelo Netlify CLI (`netlify deploy --dir`), ou arraste a pasta no painel do Netlify. |
| **Só local** | valor padrão `./publico`; preview em `http://localhost:4180/publico/` (sem senha). |

## Limitações

- É um **retrato**: reflete o estado do último processamento. Ações ao vivo (rodar
  detecção, simulador de oferta, "Perguntar", upload, "Por quê?") só funcionam no site em
  `localhost` — na cópia elas aparecem desabilitadas ou respondem com um aviso.
- O HTML por loja fica em ~1–4 MB (depende do tamanho do catálogo com feed de estoque).
  Abre bem localmente e em OneDrive/Pages; para e-mail/WhatsApp continue usando o
  `⬇ Baixar painel (HTML)` do Painel, que é só o Painel (bem menor).
- `POST /api/publicar` força a regeneração na hora (logado).
