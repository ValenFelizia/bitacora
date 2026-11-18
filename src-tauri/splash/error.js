const reason = new URLSearchParams(window.location.search).get("reason");
if (reason === "connection") {
  const title = "No pude volver a conectar Bitácora";
  document.title = title;
  document.getElementById("error-title").textContent = title;
}
if (reason === "viewer") {
  document.getElementById("retry-help").textContent = "Cerrá Bitácora y volvé a abrirla.";
}
