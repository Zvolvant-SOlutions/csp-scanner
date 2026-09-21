/* Lightweight client-side password gate for the CSP scanner (all pages).
 * NOTE: this is a privacy curtain, not real security — the underlying
 * data.json files are still served publicly by GitHub Pages, and the
 * check runs in the browser. It keeps casual visitors and search engines
 * out. For true access control, host behind a server (Cloudflare Worker).
 * The plaintext password is NOT in source — only its SHA-256 hash. */
(function () {
  var HASH = "bd4fb6f3704394498e59f26450f883b698faf5341cd43f90528021d64c28a413";
  var KEY = "csp_gate_ok";
  try { if (localStorage.getItem(KEY) === HASH) return; } catch (e) {}

  function mount() {
    if (document.getElementById("csp-gate")) return;
    var ov = document.createElement("div");
    ov.id = "csp-gate";
    ov.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#0b1220;" +
      "display:flex;align-items:center;justify-content:center;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
    ov.innerHTML =
      '<div style="background:#fff;padding:34px 30px;border-radius:14px;width:330px;max-width:90vw;box-shadow:0 24px 70px rgba(0,0,0,.45);text-align:center;">' +
      '<div style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:.3px;">CSP Scanner</div>' +
      '<div style="font-size:13px;color:#64748b;margin:6px 0 20px;">Enter password to continue</div>' +
      '<input id="csp-pw" type="password" autocomplete="current-password" placeholder="Password" ' +
      'style="width:100%;padding:11px 13px;border:1.5px solid #cbd5e1;border-radius:9px;font-size:15px;outline:none;box-sizing:border-box;">' +
      '<div id="csp-err" style="color:#dc2626;font-size:12px;min-height:17px;margin:8px 0;"></div>' +
      '<button id="csp-go" style="width:100%;padding:11px;background:#0a6b63;color:#fff;border:none;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;">Unlock</button>' +
      "</div>";
    document.body.appendChild(ov);
    var pw = document.getElementById("csp-pw");
    if (pw) pw.focus();
  }

  async function sha256(s) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function tryUnlock() {
    var el = document.getElementById("csp-pw");
    if (!el) return;
    var h = await sha256(el.value);
    if (h === HASH) {
      try { localStorage.setItem(KEY, HASH); } catch (e) {}
      var ov = document.getElementById("csp-gate");
      if (ov) ov.remove();
    } else {
      var err = document.getElementById("csp-err");
      if (err) err.textContent = "Incorrect password";
      el.value = "";
      el.focus();
    }
  }

  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "csp-go") tryUnlock();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && document.getElementById("csp-pw")) tryUnlock();
  });

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
