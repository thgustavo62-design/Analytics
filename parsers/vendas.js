// Parser do relatório "Analítico de Vendas" (PDF) exportado pelo sistema da farmácia.
//
// Contrato: a soma dos Vl. Líquido de todas as linhas TEM que bater com o "Total:" impresso
// no rodapé do PDF. Se divergir mais que R$ 0,05, o parser LANÇA — nunca devolve um
// resultado silenciosamente errado (regra de ouro do domínio).
//
// Extração de texto: pdfjs-dist (JS puro, roda em qualquer host). Reconstruímos as linhas
// agrupando os fragmentos de texto por coordenada Y e ordenando por X.

const fs = require("fs");

// data hora  lanc  usu  barras           descricao         preco   qtde  vlliq   oper       emp  cli  [cx]
// preco/vlliq podem ser negativos (linhas de ARREDONDAMENTO); qtde pode ser 0.
const LINE_RE =
  /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+(\d+)\s+(\d+)\s+(\d{10,14})\s+(.+?)\s+(-?[\d.,]+)\s+(\d+)\s+(-?[\d.,]+)\s+(A VISTA|A PRAZO)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/;
const TOTAL_RE = /(?:^|\s)Total:\s*([\d.,]+)\s*$/;
const HEADER_TS_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+Pag\.:/;
const PERIODO_RE = /Periodo de:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i;

// "1.234,56" -> 1234.56
function toFloat(s) {
  return parseFloat(String(s).replace(/\./g, "").replace(",", "."));
}

// "dd/mm/aaaa" -> "aaaa-mm-dd"
function isoDate(br) {
  const [d, m, y] = br.split("/");
  return `${y}-${m}-${d}`;
}

async function extractLines(pdfPath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map(); // y arredondado -> fragmentos
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(item);
    }
    const ys = [...rows.keys()].sort((a, b) => b - a); // topo -> base
    for (const y of ys) {
      const text = rows
        .get(y)
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
    }
    page.cleanup();
  }
  await doc.destroy();
  return lines;
}

/**
 * @param {string} pdfPath
 * @returns {Promise<{
 *   rows: Array<object>, total: number, printedTotal: number|null,
 *   headerTimestamp: string|null, periodo: {inicio:string,fim:string}|null,
 *   lastDay: string|null, lastDayPartial: boolean
 * }>}
 */
async function parseVendasPdf(pdfPath) {
  const lines = await extractLines(pdfPath);

  const rows = [];
  let printedTotal = null;
  let headerTimestamp = null;
  let periodo = null;

  for (const line of lines) {
    if (!headerTimestamp) {
      const h = line.match(HEADER_TS_RE);
      if (h) headerTimestamp = `${h[3]}-${h[2]}-${h[1]}T${h[4]}:${h[5]}`;
    }
    if (!periodo) {
      const pr = line.match(PERIODO_RE);
      if (pr) periodo = { inicio: isoDate(pr[1]), fim: isoDate(pr[2]) };
    }

    const m = line.match(LINE_RE);
    if (m) {
      rows.push({
        data: isoDate(m[1]),
        hora: m[2],
        lancamento: m[3],
        usuario: m[4],
        barras: m[5],
        descricao: m[6].trim(),
        preco_unit: toFloat(m[7]),
        quantidade: parseInt(m[8], 10),
        valor_liquido: toFloat(m[9]),
        forma_pagto: m[10],
      });
      continue;
    }
    const t = line.match(TOTAL_RE);
    if (t) printedTotal = toFloat(t[1]);
  }

  if (rows.length === 0) {
    throw new Error("Nenhuma linha de venda reconhecida no PDF — confira se é o relatório 'Analítico de Vendas'.");
  }

  const total = Math.round(rows.reduce((s, r) => s + r.valor_liquido, 0) * 100) / 100;

  if (printedTotal != null && Math.abs(total - printedTotal) > 0.05) {
    throw new Error(
      `Soma calculada (R$ ${total.toFixed(2)}) diverge do Total impresso (R$ ${printedTotal.toFixed(2)}). ` +
        `Diferença de R$ ${(total - printedTotal).toFixed(2)} em ${rows.length} linhas. ` +
        `Revisar o parser antes de gerar o painel — NÃO publicar.`
    );
  }
  if (printedTotal == null) {
    throw new Error("Linha 'Total:' não encontrada no PDF — não dá para validar a soma. NÃO publicar.");
  }

  // Dia parcial: se o relatório foi gerado dentro do período coberto e ainda no horário
  // comercial, o último dia com dados está truncado.
  const datas = [...new Set(rows.map((r) => r.data))].sort();
  const lastDay = datas[datas.length - 1];
  let lastDayPartial = false;
  if (headerTimestamp) {
    const [genDate, genTime] = headerTimestamp.split("T");
    const genHour = parseInt(genTime.slice(0, 2), 10);
    if (genDate <= lastDay || genDate === lastDay) {
      if (genDate === lastDay && genHour < 20) lastDayPartial = true;
    }
    // relatório gerado antes do fim do período declarado => último dia presente é parcial
    if (periodo && genDate < periodo.fim && genDate === lastDay) lastDayPartial = true;
  }

  return { rows, total, printedTotal, headerTimestamp, periodo, lastDay, lastDayPartial };
}

module.exports = { parseVendasPdf, LINE_RE, toFloat, isoDate };
