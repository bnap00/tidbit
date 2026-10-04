import "./style.css";
import { galleryPage } from "./pages/gallery.js";
import { palPage } from "./pages/pal.js";
import { playgroundPage } from "./pages/playground.js";

type Page = (root: HTMLElement) => (() => void) | void;

const routes: Record<string, () => Promise<Page> | Page> = {
  "/gallery": () => galleryPage,
  "/playground": () => playgroundPage,
  "/": () => palPage,
};

const root = document.getElementById("app")!;
let cleanup: (() => void) | void;

async function route(): Promise<void> {
  cleanup?.();
  if (location.pathname === "/compare") history.replaceState(null, "", "/");
  const page = await (routes[location.pathname] ?? routes["/"]!)();
  cleanup = page(root);
}

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[data-link]");
  if (!a) return;
  e.preventDefault();
  history.pushState(null, "", (a as HTMLAnchorElement).href);
  void route();
});
window.addEventListener("popstate", () => void route());
void route();
