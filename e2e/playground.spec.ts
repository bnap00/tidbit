import { expect, test, type Page } from "@playwright/test";
import { ACTIONS, FXS, LOOKS, MOODS, TOUCH_KINDS } from "@tidbit/protocol";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

test("every mood, action, effect, look and touch plays without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/playground?seed=3");
  await expect(page.locator(".stage-canvas")).toBeVisible();
  for (const [key, values] of [
    ["mood", MOODS],
    ["action", ACTIONS],
    ["fx", FXS],
    ["look", LOOKS],
  ] as const) {
    for (const v of values) await page.getByTestId(`${key}-${v}`).click();
  }
  for (const k of TOUCH_KINDS) await page.getByTestId(`touch-${k}`).click();
  // The speech bubble shows the beat's words through the typewriter.
  await page.getByTestId("mood-happy").click();
  await expect(page.getByTestId("bubble")).toContainText("Hi! I'm a pal.", { timeout: 3000 });
  expect(errors).toEqual([]);
});

test("the five named moods, canvas only (visual checklist)", async ({ page }) => {
  await page.goto("/playground?seed=11");
  await page.getByTestId("action-none").click();
  await page.getByTestId("fx-none").click();
  await page.locator(".panel input[type=text]").fill("");
  for (const mood of ["happy", "sad", "angry", "surprised", "sleepy"]) {
    await page.getByTestId(`mood-${mood}`).click();
    await page.waitForTimeout(700);
    await page
      .locator(".stage-canvas")
      .screenshot({ path: `test-results/screens/mood-${mood}.png` });
  }
});

async function measure(page: Page, ms: number) {
  await page.evaluate(() =>
    (window as unknown as { __palPerf: { reset(): void } }).__palPerf.reset(),
  );
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const p = (
      window as unknown as {
        __palPerf: { fps: number; workMs: number; maxWorkMs: number; frames: number };
      }
    ).__palPerf;
    return { fps: p.fps, workMs: p.workMs, maxWorkMs: p.maxWorkMs, frames: p.frames };
  });
}

test("holds 60 fps: one animated stage, and the 24-pal gallery", async ({ page }) => {
  await page.goto("/playground?seed=5");
  await page.getByTestId("action-dance").click();
  await page.getByTestId("fx-hearts").click();
  const stage = await measure(page, 3000);
  console.log("stage", stage);
  expect(stage.fps).toBeGreaterThan(55);
  // Work per frame must leave most of the 16.7 ms budget for the browser.
  expect(stage.workMs).toBeLessThan(4);

  await page.goto("/gallery");
  await expect(page.locator("[data-testid=gallery] canvas")).toHaveCount(24);
  const gallery = await measure(page, 3000);
  console.log("gallery", gallery);
  expect(gallery.fps).toBeGreaterThan(55);
  expect(gallery.workMs).toBeLessThan(10);
});
