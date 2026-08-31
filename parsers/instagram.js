// Normaliza o payload do formulário manual do Instagram (Meta Business Suite).
// Sem OCR nesta versão — o usuário digita olhando o print. OCR fica como melhoria futura
// (pytesseract/tesseract.js com confirmação humana antes de salvar).

const CAMPOS = [
  { metrica: "visualizacoes", rotulo: "Visualizações" },
  { metrica: "alcance", rotulo: "Alcance" },
  { metrica: "interacoes", rotulo: "Interações" },
  { metrica: "cliques_link", rotulo: "Cliques no link" },
  { metrica: "visitas_perfil", rotulo: "Visitas ao perfil" },
  { metrica: "seguidores", rotulo: "Seguidores novos" },
];

function parseDelta(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/%/g, "").replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Aceita { visualizacoes: { valor, delta, obs } } ou { visualizacoes_valor, visualizacoes_delta }.
function normalizeInstagram(payload = {}) {
  const out = [];
  for (const c of CAMPOS) {
    const bloco = payload[c.metrica] || {};
    const valor =
      bloco.valor_exibicao ?? bloco.valor ?? payload[`${c.metrica}_valor`] ?? payload[`${c.metrica}`];
    const delta = bloco.delta_pct ?? bloco.delta ?? payload[`${c.metrica}_delta`];
    const obs = bloco.observacao ?? bloco.obs ?? payload[`${c.metrica}_obs`] ?? null;

    if (valor == null || String(valor).trim() === "") continue; // campo vazio: ignora, permite parcial

    out.push({
      metrica: c.metrica,
      rotulo: c.rotulo,
      valor_exibicao: String(valor).trim(),
      delta_pct: parseDelta(delta),
      observacao: obs ? String(obs).trim() : null,
    });
  }
  return out;
}

module.exports = { normalizeInstagram, CAMPOS };
