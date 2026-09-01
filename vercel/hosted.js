// Só no site hospedado (Vercel): marca o modo "somente leitura" e mostra uma faixa.
// Localhost NÃO carrega este arquivo (ver index.html), então lá o app roda completo.
(function () {
  try { document.body.classList.add("publico"); } catch (e) {}
  window.__HOSTED__ = true;
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.createElement("div");
    b.id = "hosted-bar";
    b.textContent = "🌐 Versão hospedada (somente leitura) · dados do Supabase, atualizados pelo PC a cada arquivo processado";
    b.style.cssText = "background:#1b1f29;color:#cfd3dc;font:12px/1.5 system-ui,sans-serif;padding:6px 14px;text-align:center";
    document.body.insertBefore(b, document.body.firstChild);
  });
})();
