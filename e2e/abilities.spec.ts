import { expect, test } from "@playwright/test";
import { TestBrain } from "./brain.js";

test("teaches a skill, lists starter skills, sets and stops a routine", async ({ page }) => {
  const brain = new TestBrain();
  await brain.start();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.locator("summary").filter({ hasText: "Skills & actions" }).click();
    await expect(page.getByTestId("skill-morning-briefing")).toBeVisible();

    await page
      .getByTestId("skill-editor")
      .fill("---\nname: Tea Time\ndescription: Brew tea together.\n---\n\n1. Ask which tea.");
    await page.getByTestId("save-skill").click();
    await expect(page.getByTestId("skill-tea-time")).toContainText("yours");

    await page.getByTestId("chat-input").fill("what skills do you have?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("tea time");

    await page.getByTestId("chat-input").fill("every weekday at 8am remind me to stretch");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("Weekdays at");
    const routine = page.getByTestId("routine-list").locator(".ability-item");
    await expect(routine).toContainText("stretch");
    await expect(routine).toContainText("weekdays");
    await routine.getByRole("button", { name: "Stop routine" }).click();
    await expect(page.getByTestId("routine-list")).not.toContainText("stretch");

    await expect(page.getByTestId("skill-customize-me")).toContainText("starter");
    await page.getByTestId("chat-input").fill("Call yourself Biscuit");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("Biscuit! I love it.");
    await expect(page.getByTestId("pal-name")).toHaveText("Biscuit");
    await page.reload();
    await expect(page.getByTestId("pal-name")).toHaveText("Biscuit");
    await page.locator("summary").filter({ hasText: "Skills & actions" }).click();

    await page.getByTestId("delete-skill-tea-time").click();
    await expect(page.getByTestId("skill-tea-time")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await brain.stop();
  }
});
