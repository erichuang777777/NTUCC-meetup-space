import { test, expect } from "@playwright/test";
test("desktop demo navigation, filtering, source gate and safe rendering", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#members");
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await expect(
    page.getByRole("heading", { name: "公布欄", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "專案探索", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "專案探索", exact: true }),
  ).toBeVisible();
  await page.locator("#space-filter").selectOption("踩坑避雷");
  await expect(page.locator("article.card")).toHaveCount(1);
  await page.locator(".project-cover").first().click();
  await expect(page.locator(".topic-list")).toBeVisible();
  await page.locator("#project-qa > summary").click();
  await expect(page.locator("#questions")).toBeVisible();
  await page.locator(".project-heading .action-menu > summary").click();
  await page.getByRole("button", { name: "▶ 全螢幕投影" }).click();
  await expect(page.locator("#toast")).toContainText("登入");
  await page
    .getByRole("button", { name: "← 返回專案探索", exact: true })
    .click();
  await page.getByRole("button", { name: "痛點許願池", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "痛點許願池", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
});
test("mobile layout fits viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#members");
  await expect(
    page.getByRole("button", { name: "使用 Google 帳號登入" }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/login-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await expect(
    page.getByRole("heading", { name: "公布欄", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".bottom-nav button[data-nav] svg")).toHaveCount(6);
  // Demo preview enables every feature flag, so feature navs collapse into "更多".
  await expect(page.locator(".bottom-nav #nav-more")).toBeVisible();
  await page.getByRole("button", { name: "專案探索", exact: true }).click();
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
  await page.goto("/#members");
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

test("image discovery opens an isolated project forum, topics and replies stay in that project", async ({
  page,
}) => {
  await page.goto("/#members");
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await page.getByRole("button", { name: "專案探索", exact: true }).click();
  await expect(page.locator(".project-cover img")).toHaveCount(3);
  await expect
    .poll(() =>
      page
        .locator(".project-cover img")
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.locator(".project-cover").first().click();
  await expect(page.locator(".topic-list")).toBeVisible();
  expect(page.url()).toContain("#project/demo1");
  await page.screenshot({
    path: "artifacts/minimal-forum.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "新增討論" }).click();
  await page
    .locator("#compose-topic input[name=title]")
    .fill("測試：如何比較處理時間");
  await page
    .locator("#compose-topic textarea")
    .fill("想使用合成資料測量前後的處理時間。");
  await page.getByRole("button", { name: "發布討論", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "測試：如何比較處理時間" }),
  ).toBeVisible();
  expect(page.url()).toContain("/thread/");
  await page
    .locator("#reply-form textarea")
    .fill("可以先記錄人工流程，再比較結果。");
  await page.getByRole("button", { name: "送出回覆" }).click();
  await expect(page.locator(".replies")).toContainText("可以先記錄人工流程");
  await page.getByRole("button", { name: "← 返回這個專案的討論" }).click();
  await expect(page.locator(".topic-list")).toContainText(
    "測試：如何比較處理時間",
  );
  await page.getByRole("button", { name: "← 返回專案探索" }).click();
  await page.locator(".project-cover").nth(1).click();
  await expect(page.locator(".topic-list")).not.toContainText(
    "測試：如何比較處理時間",
  );
});
test("PII confirmation runs before a forum topic is posted", async ({
  page,
}) => {
  await page.goto("/#members");
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await page.getByRole("button", { name: "專案探索", exact: true }).click();
  await page.locator(".project-cover").first().click();
  await page.getByRole("button", { name: "新增討論" }).click();
  await page.locator("#compose-topic input[name=title]").fill("測試資料檢查");
  await page.locator("#compose-topic textarea").fill("MRN: 12345678");
  await page.getByRole("button", { name: "發布討論", exact: true }).click();
  await expect(page.locator("#pii")).toBeVisible();
  await page.getByRole("button", { name: "一鍵遮罩並送出" }).click();
  await expect(page.locator(".thread-opening")).toContainText("[病歷號已遮罩]");
  await expect(page.locator(".thread-opening")).not.toContainText("12345678");
});

test("project contact opens a private inbox preview, guards PII and supports blocking", async ({
  page,
}) => {
  await page.goto("/#members");
  await page.getByRole("button", { name: "預覽介面（示例資料） →" }).click();
  await page.getByRole("button", { name: "專案探索", exact: true }).click();
  await page.locator(".project-cover").first().click();
  await page.locator(".project-heading .action-menu > summary").click();
  await page.getByRole("button", { name: "聯絡分享者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "訊息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "專案分享者", exact: true }),
  ).toBeVisible();
  await page.locator("#send-message textarea").fill("MRN: 12345678");
  await page.getByRole("button", { name: "傳送站內私訊", exact: true }).click();
  await expect(page.locator("#pii")).toBeVisible();
  await page.getByRole("button", { name: "一鍵遮罩並送出" }).click();
  await expect(page.locator(".message-history")).toContainText(
    "[病歷號已遮罩]",
  );
  await expect(page.locator(".message-history")).not.toContainText("12345678");
  await page.locator(".message-panel header .action-menu > summary").click();
  await page.getByRole("button", { name: "封鎖對方", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "傳送站內私訊", exact: true }),
  ).toBeDisabled();
  await page.locator(".message-panel header .action-menu > summary").click();
  await page
    .getByRole("button", { name: "解除封鎖", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "傳送站內私訊", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "artifacts/minimal-inbox.png",
    fullPage: true,
  });
});

test("member management supports role updates and invitation creation/revocation in a compact UI", async ({
  page,
}) => {
  await page.goto("/#members");
  await page.evaluate(async () => {
    const { mountMemberAdmin } = await import(String("/member-admin.ts"));
    const own = "00000000-0000-4000-8000-000000000001",
      other = "00000000-0000-4000-8000-000000000002";
    const members = [
      {
        id: own,
        email: "admin@example.test",
        display_name: "管理員",
        department: "資訊",
        role: "admin",
        passcode_verified: true,
      },
      {
        id: other,
        email: "member@example.test",
        display_name: "同仁",
        department: "行政",
        role: "member",
        passcode_verified: true,
      },
    ];
    let invitations: any[] = [];
    await mountMemberAdmin(document.querySelector("#app"), {
      ownId: own,
      toast: (message: string) => ((window as any).testToast = message),
      back: () => {},
      request: async (method: string, p: any) => {
        if (method === "GET")
          return { members, total: members.length, invitations };
        if (p.action === "role") {
          members.find((v) => v.id === p.user_id)!.role = p.role;
          return {};
        }
        if (p.action === "invite") {
          invitations.push({
            id: "invite",
            email: p.email,
            role: p.role,
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          });
          return {
            email: p.email,
            role: p.role,
            token: "ntucc_inv_" + "a".repeat(64),
          };
        }
        if (p.action === "revoke") {
          invitations = [];
          return { ok: true };
        }
      },
    });
  });
  await expect(page.getByLabel("管理員的權限", { exact: true })).toBeDisabled();
  await page.getByLabel("同仁的權限", { exact: true }).selectOption("admin");
  await expect(page.getByLabel("同仁的權限", { exact: true })).toHaveValue(
    "admin",
  );
  await page.getByRole("button", { name: "邀請同仁", exact: true }).click();
  await page.getByLabel("Google 帳號信箱").fill("newperson@example.test");
  await page.getByRole("button", { name: "產生邀請連結" }).click();
  await expect(page.locator("#invitation-link")).toHaveValue(
    /#invite=ntucc_inv_/,
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page
    .locator("details")
    .filter({ hasText: "待接受的邀請" })
    .locator("summary")
    .click();
  await expect(
    page.getByText("newperson@example.test", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤銷", exact: true }).click();
  await page
    .locator("details")
    .filter({ hasText: "待接受的邀請" })
    .locator("summary")
    .click();
  await expect(page.getByText("沒有待接受的邀請")).toBeVisible();
});
test("an invitation fragment is retained for OAuth without exposing its secret in the address bar", async ({
  page,
}) => {
  const token = "ntucc_inv_" + "b".repeat(64);
  await page.goto("/#invite=" + token);
  await expect(page.getByText("請使用受邀的 Google 帳號登入。")).toBeVisible();
  expect(page.url()).not.toContain("#invite=");
  expect(
    await page.evaluate(() => sessionStorage.getItem("ntucc-member-invite")),
  ).toBe(token);
  await expect(page.locator(".bottom-nav")).toHaveCount(0);
});
