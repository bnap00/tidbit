import { expect, test } from "@playwright/test";
import { encodeDnaCode, randomDna } from "@tidbit/protocol";
import { TestBrain } from "./brain.js";

test("gallery card opens that pal in the playground, with a shareable URL", async ({ page }) => {
  await page.goto("/gallery?seed=4");
  const name = await page.locator(".card strong").first().textContent();
  await page.locator(".card").first().click();
  await expect(page).toHaveURL(/\/playground\?dna=[A-Za-z0-9_-]+$/);
  await expect(page.locator("pre.json")).toContainText(`"name": "${name}"`);
  // Reloading the URL shows the same pal.
  await page.reload();
  await expect(page.locator("pre.json")).toContainText(`"name": "${name}"`);
});

test("opening a share link offers to adopt that pal", async ({ page }) => {
  const brain = new TestBrain();
  await brain.start();
  try {
    const shared = { ...randomDna(777), name: "Postcard", persona: "A pal who arrived by link." };
    await page.goto(`/?pal=${encodeDnaCode(shared, { persona: true })}`);
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(page.getByTestId("adopt-bar")).toContainText("Adopt Postcard?");
    await page.getByTestId("adopt").click();
    await expect(page.getByTestId("pal-name")).toHaveText("Postcard");
    await expect(page.getByTestId("transcript")).toContainText("A pal who arrived by link.");
    await expect(page).toHaveURL(/\/$/);
    // Voice is optional and off by default.
    await expect(page.getByTestId("voice-toggle")).toHaveText("Voice: off");
  } finally {
    await brain.stop();
  }
});
