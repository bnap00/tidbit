import { expect, test } from "@playwright/test";
import { TestBrain } from "./brain.js";

test("captures file themselves, notes answer questions, briefings and offline capture", async ({
  page,
}) => {
  const brain = new TestBrain();
  await brain.start();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    const today = page.getByTestId("today");
    await expect(today).toContainText("Nothing to do");

    // The capture button: one thought becomes a task due today.
    await page
      .getByTestId("capture-input")
      .fill("Uh, I need to order the display for the newest project. I need to do this today.");
    await page.getByTestId("capture-submit").click();
    await expect(page.getByTestId("capture-result")).toHaveText(
      "Task: Order the display for the newest project (today)",
    );
    await expect(page.getByTestId("task-list")).toContainText(
      "Order the display for the newest project",
    );

    // A thought kept as a note, from the chat box, is found again later.
    await page
      .getByTestId("chat-input")
      .fill("/keep The watering tank should be see-through so I can watch the water level.");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("capture-result")).toHaveText("Saved as a note.");
    await page
      .getByTestId("chat-input")
      .fill("What was it I wanted to change about the watering system?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText(
      "watering tank should be see-through",
    );

    await page.getByTestId("brief-day").click();
    await expect(page.getByTestId("transcript")).toContainText(
      "Due: Order the display for the newest project",
    );

    // Tasks are ticked off by hand, and added with a date.
    await page.getByTestId("task-input").fill("Print the enclosure");
    await page.getByTestId("task-add").click();
    await expect(page.getByTestId("task-list")).toContainText("Print the enclosure");
    await page.locator(".task", { hasText: "Order the display" }).locator("input").check();
    await expect(page.getByTestId("task-list")).not.toContainText("Order the display");
    await expect(today).toContainText("1 done today");

    await page.locator("summary").filter({ hasText: "Notes" }).click();
    await expect(page.getByTestId("note-list").locator(".note-item")).toHaveCount(2);
    await page.getByTestId("note-search").fill("watering");
    await expect(page.getByTestId("note-list").locator(".note-item")).toHaveCount(1);

    // Captured with the brain down, filed once it is back.
    await brain.stop();
    await expect(page.getByTestId("status")).not.toHaveText("connected");
    await page.getByTestId("capture-input").fill("Buy filament tomorrow");
    await page.getByTestId("capture-submit").click();
    await expect(page.getByTestId("capture-queue")).toContainText("Buy filament tomorrow");
    await page.reload();
    await expect(page.getByTestId("capture-queue")).toContainText("Buy filament tomorrow");
    await brain.start();
    await expect(page.getByTestId("status")).toHaveText("connected", { timeout: 20_000 });
    await expect(page.getByTestId("task-list")).toContainText("Buy filament", { timeout: 15_000 });
    await expect(page.getByTestId("capture-queue")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await brain.stop();
  }
});
