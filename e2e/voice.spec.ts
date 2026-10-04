import { expect, test } from "@playwright/test";

test.describe("first visit", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("asks which voice to use and remembers the answer", async ({ page }) => {
    await page.goto("/");
    const dialog = page.getByTestId("voice-choice");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("188 MB");
    await expect(page.getByTestId("voice-choice-kokoro")).toBeVisible();
    await page.getByTestId("voice-choice-browser").click();
    await expect(dialog).toBeHidden();
    // Keeping the browser voice doesn't switch voice on or start a download.
    await expect(page.getByTestId("voice-toggle")).toHaveText("Voice: off");
    expect(await page.evaluate(() => localStorage.getItem("a-pal:voice-engine"))).toBe("browser");
    await page.reload();
    await expect(page.getByTestId("pal-name")).toBeVisible();
    await expect(dialog).toBeHidden();
  });
});

test("the voice question is not asked again once answered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pal-name")).toBeVisible();
  await expect(page.getByTestId("voice-choice")).toBeHidden();
});
