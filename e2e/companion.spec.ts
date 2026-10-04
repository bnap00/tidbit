import { expect, test, type Page } from "@playwright/test";
import { TestBrain, VOICE_ANSWERED } from "./brain.js";

const activeId = (page: Page, list: string) =>
  page.getByTestId(list).locator('[aria-current="true"]').getAttribute("data-id");
const choose = (page: Page, list: string, id: string) =>
  page.getByTestId(list).locator(`[data-id="${id}"]`).click();
const activeItem = (page: Page, list: string) =>
  page.getByTestId(list).locator('[aria-current="true"]');

test("restores conversations, switches pets, edits memories and keeps personality", async ({
  page,
}) => {
  const brain = new TestBrain();
  await brain.start();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.getByTestId("chat-input").fill("My name is Mira.");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("Nice to meet you, Mira");
    const firstPal = (await activeId(page, "pal-list"))!;
    const firstConversation = (await activeId(page, "conversation-list"))!;
    await page.getByTestId("chat-input").fill("An unfinished thought");
    await page.reload();
    await expect(page.getByTestId("chat-input")).toHaveValue("An unfinished thought");
    await page.getByTestId("chat-input").fill("");
    await expect(page.getByTestId("transcript")).toContainText("My name is Mira.");
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.getByTestId("new-conversation").click();
    await expect(activeItem(page, "conversation-list")).not.toHaveAttribute(
      "data-id",
      firstConversation,
    );
    await expect(page.getByTestId("transcript")).not.toContainText("My name is Mira.");
    // Clicking New again on the still-empty conversation keeps it; no empty duplicates.
    await page.getByTestId("new-conversation").click();
    await expect(page.getByTestId("conversation-list").locator("[data-id]")).toHaveCount(2);
    await choose(page, "conversation-list", firstConversation);
    await expect(page.getByTestId("transcript")).toContainText("My name is Mira.");
    await page.locator("summary").filter({ hasText: "Memories" }).click();
    await page.getByTestId("memory-input").fill("Likes oolong tea");
    await page.getByTestId("remember-memory").click();
    await expect(page.locator(".memory-item textarea").last()).toBeVisible();
    const target = page
      .locator(".memory-item")
      .filter({ has: page.locator("textarea") })
      .first();
    await expect(target.locator("textarea")).toHaveValue("Likes oolong tea");
    await target.locator("textarea").fill("Likes peppermint tea");
    await target.getByRole("button", { name: "Save", exact: true }).click();
    await expect(target.locator("textarea")).toHaveValue("Likes peppermint tea");
    await target.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(page.locator(".memory-item textarea").first()).not.toHaveValue(
      "Likes peppermint tea",
    );
    await page.locator("summary").filter({ hasText: "Personality" }).click();
    await page.getByTestId("personality-likes").fill("moon cakes");
    await page.getByTestId("personality-humor").selectOption("dry");
    await page.getByTestId("save-personality").click();
    await expect(page.locator(".companion-notice")).toContainText("Personality saved");
    await page.getByTestId("chat-input").fill("What do you like?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("moon cakes");
    await page.reload();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.locator("summary").filter({ hasText: "Personality" }).click();
    await expect(page.getByTestId("personality-likes")).toHaveValue("moon cakes");
    await page.getByTestId("new-pal").click();
    await page.getByTestId("create-input").fill("a playful blue robot");
    await page.getByTestId("create").click();
    await expect(page.getByTestId("pal-list").locator("[data-id]")).toHaveCount(2);
    await choose(page, "pal-list", firstPal);
    await expect(page.getByTestId("transcript")).toContainText("My name is Mira.");
    await page
      .locator(".companion-details")
      .evaluateAll((elements) =>
        elements.forEach((element) => ((element as HTMLDetailsElement).open = false)),
      );
    await page.screenshot({ path: "test-results/screens/companion-home.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/screens/companion-mobile.png", fullPage: true });
    // Narrow screens keep pals and conversations in a drawer.
    await expect(page.getByTestId("pal-list")).toBeHidden();
    await page.getByTestId("library-toggle").click();
    await expect(page.getByTestId("pal-list")).toBeVisible();
    await page.screenshot({
      path: "test-results/screens/companion-drawer.png",
      animations: "disabled",
    });
    await choose(page, "pal-list", firstPal);
    await expect(page.getByTestId("pal-list")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await brain.stop();
  }
});

test("queues messages while offline, survives refresh, and sends each once after reconnect", async ({
  page,
}) => {
  const brain = new TestBrain();
  await brain.start();
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    const name = await page.getByTestId("pal-name").textContent();
    await brain.stop();
    await expect(page.getByTestId("status")).toContainText("offline");
    await page.getByTestId("chat-input").fill("A queued hello from offline.");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("Queued for reconnect");
    await page.reload();
    await expect(page.getByTestId("pal-name")).toHaveText(name!);
    await expect(page.getByTestId("transcript")).toContainText("Queued for reconnect");
    await brain.start();
    await expect(page.getByTestId("status")).toHaveText("connected", { timeout: 15000 });
    await expect(page.getByTestId("transcript")).not.toContainText("Queued for reconnect");
    await expect(
      page.locator(".transcript li.you").filter({ hasText: "A queued hello from offline." }),
    ).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(
      page.locator(".transcript li.you").filter({ hasText: "A queued hello from offline." }),
    ).toHaveCount(1);
  } finally {
    await brain.stop();
  }
});

test("pairs browsers across origins while keeping an unpaired visitor separate", async ({
  page,
  browser,
}) => {
  const brain = new TestBrain();
  await brain.start();
  const second = await browser.newContext({ storageState: VOICE_ANSWERED }),
    third = await browser.newContext({ storageState: VOICE_ANSWERED });
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.getByTestId("chat-input").fill("Remember that my cat is Pixel.");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("I'll remember");
    const visitor = await third.newPage();
    await visitor.goto("http://localhost:5199/");
    await expect(visitor.getByTestId("status")).toHaveText("connected");
    await expect(visitor.getByTestId("transcript")).not.toContainText("Pixel");
    await page.locator("summary").filter({ hasText: "Your devices" }).click();
    await page.getByTestId("generate-pair-code").click();
    await expect(page.getByTestId("pair-code")).toHaveText(/^[A-F0-9]{5}-[A-F0-9]{5}$/);
    const code = await page.getByTestId("pair-code").textContent();
    const paired = await second.newPage();
    await paired.goto("http://localhost:5199/");
    await expect(paired.getByTestId("status")).toHaveText("connected");
    await paired.locator("summary").filter({ hasText: "Your devices" }).click();
    await paired.getByTestId("pair-input").fill(code!);
    await paired.getByTestId("redeem-pair-code").click();
    await expect(paired.getByTestId("transcript")).toContainText("Pixel");
    await paired.getByTestId("chat-input").fill("Hello from the other browser!");
    await paired.getByTestId("send").click();
    await expect(page.getByTestId("transcript")).toContainText("Hello from the other browser!");
    await expect(visitor.getByTestId("transcript")).not.toContainText(
      "Hello from the other browser!",
    );
    await paired.reload();
    await expect(paired.getByTestId("transcript")).toContainText("Pixel");
  } finally {
    await second.close();
    await third.close();
    await brain.stop();
  }
});

test("recovers a queued message when another device selected a different conversation", async ({
  page,
}) => {
  const brain = new TestBrain();
  await brain.start();
  try {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("connected");
    // A conversation with something in it, so New starts another.
    await page.getByTestId("chat-input").fill("Hello!");
    await page.getByTestId("send").click();
    await expect(page.locator(".transcript li.you")).toHaveCount(1);
    await expect(page.locator(".transcript .queued")).toHaveCount(0);
    const original = (await activeId(page, "conversation-list"))!;
    await page.evaluate(() => {
      const token = localStorage.getItem("apal.owner")!;
      const state = JSON.parse(localStorage.getItem(`apal.state:${token.slice(-16)}`)!);
      localStorage.setItem(
        `apal.outbox:${token.slice(-16)}`,
        JSON.stringify([
          {
            type: "say",
            requestId: "waiting-in-another-session",
            text: "A hello from my earlier conversation.",
            palId: state.dna.id,
            conversationId: state.conversationId,
          },
        ]),
      );
    });
    await page.getByTestId("new-conversation").click();
    await expect(activeItem(page, "conversation-list")).not.toHaveAttribute("data-id", original);
    await page.reload();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(page.getByTestId("outbox")).toContainText("A hello from my earlier conversation.");
    await page.getByRole("button", { name: "Continue and send" }).click();
    await expect(activeItem(page, "conversation-list")).toHaveAttribute("data-id", original);
    await expect(page.getByTestId("outbox")).toBeHidden();
    await expect(
      page
        .locator(".transcript li.you")
        .filter({ hasText: "A hello from my earlier conversation." }),
    ).toHaveCount(1);
  } finally {
    await brain.stop();
  }
});
