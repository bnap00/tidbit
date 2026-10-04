import { expect, test } from "@playwright/test";

test("gallery renders 24 pals and reseeds", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/gallery?still");
  await expect(page.locator("[data-testid=gallery] canvas")).toHaveCount(24);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/gallery.png", fullPage: true });
  const first = await page.locator(".card strong").first().textContent();
  await page.getByTestId("reseed").click();
  await expect(page.locator(".card strong").first()).not.toHaveText(first ?? "");
  expect(errors).toEqual([]);
});
