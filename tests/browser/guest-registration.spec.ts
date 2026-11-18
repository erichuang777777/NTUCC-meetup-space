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
