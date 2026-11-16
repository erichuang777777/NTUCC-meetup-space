import runtimeURL from "./slide-runtime.js?url";
export const SLIDE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src data: blob:";
// Re-serialize the whole document so a presenter cannot precede the CSP with active content.
export function sandboxDocument(html: string, nonce: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll(
      "meta[http-equiv],base,iframe,object,embed,form,audio,video",
    )
    .forEach((n) => n.remove());
  doc.querySelectorAll("a").forEach((n) => {
    n.removeAttribute("href");
    n.removeAttribute("target");
  });
  doc.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes])
      if (a.name.startsWith("on")) n.removeAttribute(a.name);
  });
  doc.querySelectorAll("script").forEach((n) => n.remove());
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = SLIDE_CSP.replace(
    "script-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  );
  doc.head.prepend(csp);
  const style = doc.createElement("style");
  style.textContent =
    "html,body{margin:0;width:100%;height:100%;overflow:hidden}section.slide,[data-slide]{box-sizing:border-box;width:100%;height:100vh}";
  doc.head.append(style);
  const script = doc.createElement("script");
  script.setAttribute("nonce", nonce);
  script.dataset.key = nonce;
  script.src = new URL(runtimeURL, location.origin).href;
  doc.body.append(script);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
