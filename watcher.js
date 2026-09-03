// Observa a pasta inbox/ — quando aparece um arquivo novo (ou muda), processa e o painel
// se atualiza sozinho. É o que torna o site "autoalimentável": a fonte de dados é a pasta.

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { ingestFile } = require("./ingest");
const { maybeAutoAnalise } = require("./motor");

const LOG_PATH = path.join(__dirname, "data", "inbox-log.json");
const MAX_LOG = 200;

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
} catch {
  log = [];
}
// assinatura (caminho+tamanho+mtime) dos arquivos já processados — evita reprocessar no boot
const processados = new Set(log.filter((e) => e.sig).map((e) => e.sig));

function persist() {
  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(log.slice(-MAX_LOG), null, 1));
  } catch (e) {
    console.error("[inbox] não consegui gravar o log:", e.message);
  }
}

function registrar(entry) {
  log.push({ ts: new Date().toISOString(), ...entry });
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  persist();
}

function getLog() {
  return log.slice().reverse();
}

let processando = Promise.resolve(); // serializa (parser de PDF é pesado)

function enfileirar(filePath) {
  processando = processando.then(() => processar(filePath)).catch(() => {});
  return processando;
}

async function processar(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return; // sumiu antes de processar
  }
  if (!st.isFile()) return;
  const nome = path.basename(filePath);
  if (nome.startsWith("~$") || nome.startsWith(".")) return;
  if (!/\.(pdf|xlsx|csv|json|png|jpe?g|webp)$/i.test(nome)) return; // ignora LEIA-ME.txt e afins, sem barulho
  const sig = `${nome}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (processados.has(sig)) return;

  const t0 = Date.now();
  try {
    const resultado = await ingestFile(filePath);
    processados.add(sig);
    registrar({ arquivo: nome, sig, ok: true, ms: Date.now() - t0, resultado });
    console.log(`[inbox] ${nome} -> ok (${Date.now() - t0}ms)`, JSON.stringify(resultado));
    try {
      maybeAutoAnalise(resultado, (m) => registrar({ arquivo: nome, sig: null, ok: true, auto: true, msg: m }));
    } catch (e) {
      console.error("[inbox] auto-análise:", e.message);
    }
  } catch (e) {
    processados.add(sig); // não reprocessa arquivo quebrado a cada boot; corrigir o arquivo muda a assinatura
    registrar({ arquivo: nome, sig, ok: false, ms: Date.now() - t0, erro: e.message });
    console.error(`[inbox] ${nome} -> ERRO: ${e.message}`);
  }
}

function startWatcher(inboxDir) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const watcher = chokidar.watch(inboxDir, {
    depth: 0,
    ignoreInitial: false, // processa o que já estiver lá no boot (a assinatura evita repetição)
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 300 },
  });
  watcher.on("add", enfileirar);
  watcher.on("change", enfileirar);
  watcher.on("error", (e) => console.error("[inbox] watcher:", e.message));
  console.log(`[inbox] observando ${inboxDir}`);
  return watcher;
}

module.exports = { startWatcher, getLog };
