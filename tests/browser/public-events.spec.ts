import { test, expect } from "@playwright/test";
const event = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "公開活動 <img src=x onerror=alert(1)>",
  description: "活動介紹\n第二行",
  location: "國際會議廳",
  starts_at: "2099-12-01T06:00:00Z",
  ends_at: "2099-12-01T08:00:00Z",
  registration_closes_at: "2099-11-30T15:59:00Z",
  capacity: 30,
  status: "scheduled",
};
test("public homepage and event details work without membership and escape content", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/events", (r) =>
    r.fulfill({
      json: {
        events: [
          event,
          {
            ...event,
            id: "22222222-2222-4222-8222-222222222222",
            title: "過去活動",
            starts_at: "2020-01-01T06:00:00Z",
            ends_at: "2020-01-01T08:00:00Z",
          },
        ],
        announcements: [
          {
            id: "a",
            title: "公開公告",
            content: "<script>alert(1)</script>",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/events/${event.id}`, (r) =>
    r.fulfill({ json: event }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "即將舉辦" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "公開公告" })).toBeVisible();
  await expect(page.locator(".public-event-card img")).toHaveCount(0);
  await expect(
    page.getByText("<script>alert(1)</script>", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: event.title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: event.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "免登入報名活動" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "下載 .ics" })).toHaveAttribute(
    "href",
    `/api/v1/events/${event.id}/calendar`,
  );
  await expect(
    page.getByRole("link", { name: "Google 行事曆", exact: true }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/calendar.google.com\/calendar\/render\?/,
  );
  await page.goBack();
  await expect(page.getByRole("heading", { name: "即將舉辦" })).toBeVisible();
  await page.getByRole("link", { name: "會員專區", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用 Google 帳號登入" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("public homepage mobile and retry state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let failed = true;
  await page.route("**/api/v1/events", (r) =>
    failed
      ? r.fulfill({ status: 503, json: { code: "SERVER_NOT_CONFIGURED" } })
      : r.fulfill({ json: { events: [event], announcements: [] } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("SERVER_NOT_CONFIGURED");
  failed = false;
  await page.getByRole("button", { name: "重試", exact: true }).click();
  await expect(page.getByRole("heading", { name: "即將舉辦" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "artifacts/public-mobile.png",
    fullPage: true,
  });
});
test("newer event navigation wins over late response", async ({ page }) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>((r) => (release = r));
  await page.route("**/api/v1/events", (r) =>
    r.fulfill({ json: { events: [event], announcements: [] } }),
  );
  await page.route(`**/api/v1/events/${event.id}`, async (r) => {
    await waiting;
    await r.fulfill({ json: event });
  });
  await page.goto("/");
  await page.getByRole("link", { name: event.title, exact: true }).click();
  await page.getByRole("link", { name: "公開活動", exact: true }).click();
  release();
  await expect(page.getByRole("heading", { name: "即將舉辦" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "加入行事曆", exact: true }),
  ).toHaveCount(0);
});

test("public agenda is escaped and local photo framing never uploads", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
  await page.route(`**/api/v1/events/${event.id}`, (r) =>
    r.fulfill({
      json: {
        ...event,
        agenda: [{ time: "18:00", title: "分享 <img src=x>", speaker: "講者" }],
      },
    }),
  );
  await page.goto(`/#event/${event.id}`);
  await expect(page.locator(".public-agenda")).toContainText(
    "分享 <img src=x>",
  );
  await page.getByRole("link", { name: "製作本機活動相框" }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNnsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(
    page.getByRole("link", { name: "下載 PNG", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});
