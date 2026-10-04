import { expect, test } from "@playwright/test";
import { TestBrain } from "./brain.js";

test("talk to a pal end to end with ScriptedBrain, survive a brain restart", async ({ page }) => {
  const brain = new TestBrain();
  await brain.start();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    // A fresh brain greets us once for the day (proactive turn, PLAN 5.7).
    await expect(page.locator(".transcript li.pal")).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator(".transcript li.pal").first()).toContainText(
      /Good (morning|afternoon|evening)/,
    );

    // Create from a prompt.
    await page.getByTestId("new-pal").click();
    await page.getByTestId("create-input").fill("a grumpy cactus cat");
    await page.getByTestId("create").click();
    await expect(page.getByTestId("transcript")).toContainText("Meet ");

    // Three messages, three replies.
    for (const text of ["Hello there!", "It's my birthday!", "Do you like music?"]) {
      await page.getByTestId("chat-input").fill(text);
      await page.getByTestId("send").click();
    }
    await expect(page.locator(".transcript li.pal")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.getByTestId("bubble")).toBeVisible();
    await page.screenshot({ path: "test-results/screens/chat.png" });

    // Kill the brain mid-conversation: the UI says so and the pal keeps animating.
    await brain.stop();
    await expect(page.getByTestId("status")).toContainText("offline");
    const frames = await page.evaluate(async () => {
      const p = (window as unknown as { __palPerf: { frames: number } }).__palPerf;
      const a = p.frames;
      await new Promise((r) => setTimeout(r, 500));
      return p.frames - a;
    });
    expect(frames).toBeGreaterThan(20);

    // Bring it back: the page reconnects on its own and the conversation continues.
    await brain.start();
    await expect(page.getByTestId("status")).toHaveText("connected", { timeout: 15_000 });
    await page.getByTestId("chat-input").fill("I'm back!");
    await page.getByTestId("send").click();
    // Same day, same data: no second greeting after the restart, just the reply.
    await expect(page.locator(".transcript li.pal")).toHaveCount(4, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator(".transcript li.pal")).toHaveCount(4);
    expect(errors).toEqual([]);
  } finally {
    await brain.stop();
  }
});
