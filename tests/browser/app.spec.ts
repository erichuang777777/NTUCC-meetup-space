import { test, expect } from "@playwright/test";
test("desktop demo navigation, filtering, source gate and safe rendering", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await expect(
    page.getByRole("heading", { name: "重要的事，在這裡知道。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展示舞台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "把日常的小突破，變成大家的靈感。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "💣 踩坑避雷", exact: true }).click();
  await expect(page.locator("article.card")).toHaveCount(1);
  await page.getByRole("button", { name: "進入空間 ↗" }).click();
  await expect(
    page.getByRole("heading", { name: "Slido 問答牆" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "▶ 全螢幕投影" }).click();
  await expect(page.locator("#toast")).toContainText("登入");
  await page.getByRole("button", { name: "關閉 ×", exact: true }).click();
  await page.getByRole("button", { name: "痛點許願池", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "這個困擾，你也有嗎？" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
});
test("mobile layout fits viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "使用 Google 帳號登入" }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/login-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await expect(
    page.getByRole("heading", { name: "重要的事，在這裡知道。" }),
  ).toBeVisible();
  await expect(page.locator(".bottom-nav button svg")).toHaveCount(5);
  await page.getByRole("button", { name: "展示舞台", exact: true }).click();
  await expect(page.locator("article.card")).toHaveCount(3);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
});
test("sandbox strips presenter scripts, enforces CSP and supports isolated navigation", async ({
  page,
}) => {
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    if (route.request().isNavigationRequest())
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'",
        },
      });
    else await route.fulfill({ response });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { sandboxDocument } = await import(String("/player.ts"));
    const html =
      '<script>parent.document.body.dataset.hacked="yes"</script>' +
      Array.from(
        { length: 10 },
        (_, i) => `<section class="slide">Slide ${i + 1}</section>`,
      ).join("");
    const frame = document.querySelector<HTMLIFrameElement>("#slide-frame")!;
    frame.srcdoc = sandboxDocument(html, "test-nonce");
    (document.querySelector("#player") as HTMLDialogElement).showModal();
  });
  const frame = page.frameLocator("#slide-frame");
  await expect(frame.locator("section").first()).toBeVisible();
  await expect(frame.locator("section").nth(1)).toBeHidden();
  await page.evaluate(() =>
    document
      .querySelector<HTMLIFrameElement>("#slide-frame")!
      .contentWindow!.postMessage(
        { type: "navigate", delta: 1, key: "test-nonce" },
        "*",
      ),
  );
  await expect(frame.locator("section").nth(1)).toBeVisible();
  expect(await page.locator("body").getAttribute("data-hacked")).toBeNull();
  await expect(page.locator("#slide-frame")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
});

test("login is the entry point even for deep links; returning to login hides navigation", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/rest/v1/")) requests.push(req.url());
  });
  await page.goto("/#workspace");
  await expect(
    page.getByRole("button", { name: "使用 Google 帳號登入" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要功能" })).toHaveCount(
    0,
  );
  expect(requests).toEqual([]);
  await page.screenshot({
    path: "artifacts/login-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await expect(
    page.getByRole("button", { name: "公布欄", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "回登入頁" }).click();
  await expect(
    page.getByRole("button", { name: "使用 Google 帳號登入" }),
  ).toBeVisible();
  await expect(page.locator(".bottom-nav")).toHaveCount(0);
});
