import { encodeDnaCode, randomDna } from "@tidbit/protocol";
import { h, nav } from "../dom.js";
import { PalView } from "../pal-view.js";

export function galleryPage(root: HTMLElement): () => void {
  const params = new URLSearchParams(location.search);
  let batch = Number(params.get("seed") ?? 1) || 1;
  let views: PalView[] = [];
  const grid = h("div", { class: "gallery-grid", "data-testid": "gallery" });
  const label = h("span", { class: "muted" });

  function render(): void {
    for (const v of views) v.dispose();
    views = [];
    grid.replaceChildren();
    for (let i = 0; i < 24; i++) {
      const dna = randomDna(batch * 1000 + i);
      const view = new PalView(dna, 176);
      if (params.has("still")) view.frozenAt = 2000;
      views.push(view.start());
      grid.append(
        h(
          "a",
          {
            class: "card",
            href: `/playground?dna=${encodeDnaCode(dna)}`,
            "data-link": true,
            title: "Open in playground",
          },
          view.canvas,
          h(
            "div",
            { class: "caption" },
            h("strong", { text: dna.name }),
            h("span", { class: "muted", text: ` ${dna.look.body} · ${dna.look.eyes}` }),
          ),
        ),
      );
    }
    label.textContent = `batch ${batch}`;
  }

  root.replaceChildren(
    nav("/gallery"),
    h(
      "main",
      { class: "page" },
      h(
        "header",
        { class: "page-head" },
        h("h1", {}, "Gallery"),
        h(
          "p",
          { class: "muted" },
          "24 pals generated from seeds. Every one is a few hundred bytes of DNA.",
        ),
        h(
          "div",
          { class: "row" },
          h("button", {
            text: "Reseed",
            "data-testid": "reseed",
            onclick: () => {
              batch++;
              render();
            },
          }),
          label,
        ),
      ),
      grid,
    ),
  );
  render();
  return () => views.forEach((v) => v.dispose());
}
