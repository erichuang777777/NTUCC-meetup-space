import { test, expect } from "@playwright/test";
const id = "11111111-1111-4111-8111-111111111111";
const management = "ntucc_guest_" + "a".repeat(64);
const ticket = "ntucc_ticket_" + "b".repeat(64);
const event = {
  id,
  title: "智慧醫療小聚",
  description: "交流",
  location: "四樓",
  starts_at: "2099-12-23T10:00:00Z",
  ends_at: "2099-12-23T11:00:00Z",
  registration_closes_at: "2099-12-22T10:00:00Z",
  capacity: 30,
  status: "scheduled",
};
test("guest submits without login, retains retry key, privately retrieves and cancels ticket", async ({
  page,
}) => {
  let status = "registered",
    attempts = 0;
  const keys: string[] = [];
  await page.route(`**/api/v1/events/${id}`, (r) => r.fulfill({ json: event }));
  await page.route("**/api/v1/event-photos**", (r) =>
    r.fulfill({ json: { photos: [] } }),
  );
  await page.route(`**/api/v1/events/${id}/guest-registration`, async (r) => {
    const req = r.request();
    if (req.method() === "POST") {
      expect(req.headers().authorization).toBeUndefined();
      expect(req.postDataJSON()).toEqual({
        name: "測試同仁",
        organization: "臺大醫院",
        contact_email: "test@example.org",
        meal_preference: "素食",
      });
      keys.push(req.headers()["idempotency-key"]);
      if (++attempts === 1)
        return r.fulfill({ status: 503, json: { code: "TEMPORARY" } });
      return r.fulfill({ json: { status, management_token: management } });
    }
    expect(req.headers().authorization).toBe(`Bearer ${management}`);
    if (req.method() === "DELETE") status = "cancelled";
    return r.fulfill({ json: { status } });
  });
  await page.route(`**/api/v1/events/${id}/guest-ticket`, (r) =>
    r.fulfill({ json: { token: ticket } }),
  );
  await page.goto(`/#event/${id}`);
  await page.getByLabel("姓名", { exact: true }).fill("測試同仁");
  await page.getByLabel("服務單位", { exact: true }).fill("臺大醫院");
  await page.getByLabel("聯絡信箱", { exact: true }).fill("test@example.org");
  await page.getByLabel("餐盒需求").selectOption("素食");
  await page.getByRole("button", { name: "確認報名", exact: true }).click();
  await expect(page.getByText("無法完成操作（TEMPORARY）。")).toBeVisible();
  await page.getByRole("button", { name: "確認報名", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "個人活動報到 QR 票券" }),
  ).toBeVisible();
  expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(keys[1]).toBe(keys[0]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載私人管理連結" }).click();
  expect((await download).suggestedFilename()).toBe(
    "meetup-private-ticket.txt",
  );
  await page.goto(`/#guest-ticket/${id}/${management}`);
  await expect(page).toHaveURL(new RegExp(`#guest-ticket/${id}$`));
  await expect(
    page.getByRole("img", { name: "個人活動報到 QR 票券" }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "取消我的報名" }).click();
  await expect(page.getByText("報名已取消，原票券已失效。")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "個人活動報到 QR 票券" }),
  ).toHaveCount(0);
});

test("private guest link edits details and meals without rotating QR or logging in", async ({
  page,
}) => {
  let details = {
    status: "registered",
    applicant_name: "原姓名",
    organization: "臺大癌醫",
    contact_email: "old@example.org",
    meal_preference: "不需餐盒",
    can_edit: true,
  };
  let updates = 0;
  await page.route(`**/api/v1/events/${id}/guest-registration`, async (r) => {
    expect(r.request().headers().authorization).toBe(`Bearer ${management}`);
    if (r.request().method() === "PATCH") {
      updates++;
      const data = r.request().postDataJSON();
      expect(data).toEqual({
        name: "新姓名",
        organization: "臺大癌醫",
        contact_email: "new@example.org",
        meal_preference: "素食",
      });
      details = {
        ...details,
        applicant_name: data.name,
        contact_email: data.contact_email,
        meal_preference: data.meal_preference,
      };
    }
    return r.fulfill({ json: details });
  });
  await page.route(`**/api/v1/events/${id}/guest-ticket`, (r) =>
    r.fulfill({ json: { token: ticket } }),
  );
  await page.goto(`/#guest-ticket/${id}/${management}`);
  await expect(
    page.getByRole("img", { name: "個人活動報到 QR 票券" }),
  ).toBeVisible();
  await page.getByText("修改報名資料", { exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("新姓名");
  await page.getByLabel("聯絡信箱", { exact: true }).fill("new@example.org");
  await page.getByLabel("餐盒需求").selectOption("素食");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(
    page.getByText("報名資料已更新。", { exact: true }),
  ).toBeVisible();
  expect(updates).toBe(1);
  await page.getByText("修改報名資料", { exact: true }).click();
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("新姓名");
  await expect(page.getByLabel("餐盒需求")).toHaveValue("素食");
  await expect(page).toHaveURL(new RegExp(`#guest-ticket/${id}$`));
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("public event exposes aggregate availability and keeps attendee data private", async ({
  page,
}) => {
  await page.route(`**/api/v1/events/${id}`, (r) => r.fulfill({ json: event }));
  await page.route(`**/api/v1/events/${id}/availability`, (r) => {
    expect(r.request().headers().authorization).toBeUndefined();
    return r.fulfill({ json: { registered: 12, remaining: 18 } });
  });
  await page.route("**/api/v1/event-photos**", (r) =>
    r.fulfill({ json: { photos: [] } }),
  );
  await page.goto(`/#event/${id}`);
  await expect(
    page.getByText("已報名 12 人 · 剩餘 18 位", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "免登入報名活動" }),
  ).toBeVisible();
  await expect(page.locator(".public-roster")).toHaveCount(0);
});

test("admin roster combines guest and login meal totals and downloads private CSV", async ({
  page,
}) => {
  await page.route(`**/api/v1/events/manage/${id}*`, (r) => {
    expect(r.request().headers().authorization).toBe("Bearer admin-session");
    if (r.request().url().includes("export=registered"))
      return r.fulfill({
        contentType: "text/csv; charset=utf-8",
        body: "姓名,餐盒\r\n測試,素食\r\n",
      });
    return r.fulfill({
      json: {
        registered: 12,
        cancelled: 2,
        pending: 0,
        rejected: 0,
        total: 14,
        page: 1,
        page_size: 50,
        registrations: [],
        summary: {
          checked_in: 4,
          guest: 8,
          member: 4,
          duplicate_emails: 0,
          meals: { 葷食: 6, 素食: 3, 不需餐盒: 3 },
        },
      },
    });
  });
  await page.goto("/#members");
  await page.evaluate(async (eventId) => {
    history.replaceState(null, "", `#event-admin/${eventId}`);
    const { mountPublicEvents } = await import(String("/public-events.ts"));
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data: { role: "admin", passcode_verified: true },
      }),
    };
    mountPublicEvents({
      auth: {
        getSession: async () => ({
          data: {
            session: {
              user: { id: "admin", email: "admin@example.test" },
              access_token: "admin-session",
            },
          },
        }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe() {} } },
        }),
      },
      from: () => query,
    } as any);
  }, id);
  await expect(
    page.getByText("已報到 4 人 · 訪客 8 人 · 登入報名 4 人", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("葷食 6 · 素食 3 · 不需餐盒 3", { exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "匯出已報名名單 CSV" }).click();
  expect((await download).suggestedFilename()).toBe("meetup-registrations.csv");
});
