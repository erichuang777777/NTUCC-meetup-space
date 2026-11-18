import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { photoListPath } from "../public/event-photo-submissions";

test("owner photo listing does not depend on a public event id", () => {
  const params = new URLSearchParams(photoListPath(null, 2));
  assert.equal(params.get("scope"), "mine");
  assert.equal(params.get("page"), "2");
  assert.equal(params.has("event_id"), false);
});
test("hidden event fallback scopes to both own identity and event", () => {
  const params = new URLSearchParams(photoListPath("hidden-event", 1, true));
  assert.equal(params.get("scope"), "mine");
  assert.equal(params.get("event_id"), "hidden-event");
});
test("normal event administration retains server-authorized event listing", () => {
  const params = new URLSearchParams(photoListPath("public-event", 1));
  assert.equal(params.has("scope"), false);
  assert.equal(params.get("event_id"), "public-event");
});
test("my photos route fetches public metadata only for event-specific route", () => {
  const source = readFileSync(
    new URL("../public/public-events.ts", import.meta.url),
    "utf8",
  );
  const route = source.slice(
    source.indexOf("const photoRoute ="),
    source.indexOf(
      "const match = path.match",
      source.indexOf("const photoRoute ="),
    ),
  );
  assert.match(route, /photoRoute \|\| path === "#my-photos"/);
  assert.match(route, /if \(photoRoute\) \{\s*try \{\s*event = await api/);
  assert.match(route, /manageOnly: !event, mineOnly: !event/);
  assert.match(source, /href="#my-photos"/);
});
