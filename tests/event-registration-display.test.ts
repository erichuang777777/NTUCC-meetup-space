import test from "node:test";
import assert from "node:assert/strict";
import { registrationName } from "../public/event-registration-display.js";
test("roster shows submitted applicant name rather than a different Google profile name", () => {
  assert.equal(
    registrationName({
      applicant_name: "報名填寫姓名",
      display_name: "Google 暱稱",
      user_id: "account-id",
    }),
    "報名填寫姓名",
  );
  assert.equal(
    registrationName({
      applicant_name: null,
      display_name: "舊帳號姓名",
      user_id: "account-id",
    }),
    "舊帳號姓名",
  );
  assert.equal(
    registrationName({
      applicant_name: " ",
      display_name: null,
      user_id: "account-id",
    }),
    "account-id",
  );
});
