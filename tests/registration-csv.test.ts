import test from "node:test";
import assert from "node:assert/strict";
import { registrationCsv } from "../netlify/functions/shared/registration-csv.js";
test("registration CSV preserves Chinese, quotes and protects spreadsheet formulas without exporting credentials", () => {
  const csv = registrationCsv([
    {
      id: "id",
      applicant_name: ' =HYPERLINK("bad")',
      organization: "臺大,醫院",
      contact_email: "test@example.test",
      meal_preference: "素食",
      user_id: null,
      guest_token_hash: "SECRET",
      ticket_token: "SECRET",
    },
  ]);
  assert(csv.startsWith("\uFEFF"));
  assert(csv.includes(`"' =HYPERLINK(""bad"")"`));
  assert(csv.includes('"臺大,醫院"'));
  assert(csv.includes('"免登入報名"'));
  assert(!csv.includes("SECRET"));
});
