// Day, Auto or Night before the page is first drawn, so it never flashes the wrong colors (app.js
// keeps it right after that). The choice is kept in this browser. Auto is day from 7 AM to 7 PM by
// this computer's clock.
(function () {
  var t = "auto";
  try { var v = JSON.parse(localStorage.getItem("leanfare.theme") || '"auto"'); if (v === "light" || v === "dark") t = v; } catch (e) {}
  var h = new Date().getHours();
  document.documentElement.setAttribute("data-theme", t === "auto" ? (h >= 7 && h < 19 ? "light" : "dark") : t);
})();
