(() => {
  const key = document.currentScript.dataset.key;
  const slides = [...document.querySelectorAll("section.slide,[data-slide]")];
  let index = 0;
  function show(n) {
    index = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, i) => {
      s.style.setProperty(
        "display",
        i === index ? "block" : "none",
        "important",
      );
    });
    parent.postMessage(
      { type: "slide", index, total: slides.length, key },
      "*",
    );
  }
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") show(index + 1);
    if (e.key === "ArrowLeft") show(index - 1);
  });
  addEventListener("message", (e) => {
    if (e.source === parent && e.data.key === key && e.data.type === "navigate")
      show(index + e.data.delta);
  });
  show(0);
})();
