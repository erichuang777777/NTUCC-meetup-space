// Isolated HTTP + PostgreSQL acceptance. Auth is a deterministic test double, not Supabase OAuth.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
// ZXing is CommonJS: use its default namespace, not Node-version-dependent named exports.
import ZXing from "@zxing/library";
const {
  QRCodeWriter,
  BarcodeFormat,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  DecodeHintType,
} = ZXing;
import handler from "../netlify/functions/events-api.js";
const U = "a0000000-0000-4000-8000-000000000001",
  S = "a0000000-0000-4000-8000-000000000002",
  E = "a1000000-0000-4000-8000-000000000001";
const sql = (q: string) =>
  execFileSync("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", q], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const quote = (v: unknown) =>
  v === null
    ? "null"
    : typeof v === "boolean"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
const read = (q: string) =>
  JSON.parse(
    sql(`select coalesce(json_agg(t),'[]'::json) from (${q}) t`) || "[]",
  );
sql(
  `insert into auth.users(id,email) values('${U}','agent-login@example.test'),('${S}','staff@example.test');update profiles set passcode_verified=true,role='admin' where id='${S}';insert into public_events(id,title,description,location,starts_at,ends_at,registration_closes_at,capacity,is_published,checkin_opens_at,checkin_closes_at) values('${E}','隔離測試小聚','測試\\n內容','測試會議室',now()+interval '1 hour',now()+interval '2 hours',now()+interval '30 minutes',5,true,now()-interval '1 hour',now()+interval '3 hours');`,
);
const backend = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://mock");
    let result: any;
    if (url.pathname === "/auth/v1/user")
      result = {
        id: S,
        email: "staff@example.test",
        email_confirmed_at: "2026-01-01",
      };
    else if (url.pathname === `/auth/v1/admin/users/${U}`)
      result = {
        user: {
          id: U,
          email: "agent-login@example.test",
          email_confirmed_at: "2026-01-01",
          is_anonymous: false,
        },
      };
    else if (url.pathname === "/rest/v1/event_api_tokens")
      result = { user_id: U, expires_at: "2099-01-01" };
    else if (url.pathname === "/rest/v1/profiles")
      result = read(
        `select id,role,passcode_verified from profiles where id='${S}'`,
      )[0];
    else if (url.pathname === "/rest/v1/public_events")
      result = read(
        `select id,title,description,location,starts_at,ends_at,registration_closes_at,capacity,status,updated_at,sequence from public_events where id='${E}' and is_published`,
      )[0];
    else if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop()!;
      const allowed = [
        "submit_event_application_details",
        "register_guest_event_details",
        "access_guest_event",
        "consume_guest_quota",
        "update_event_registration",
        "event_ticket",
        "check_in_public_event",
      ];
      if (fn === "consume_quota") result = true;
      else {
        assert(allowed.includes(fn));
        result = JSON.parse(
          sql(
            `select to_json(${fn}(${Object.entries(body)
              .map(([k, v]) => `${k}=>${quote(v)}`)
              .join(",")}))`,
          ),
        );
      }
    } else throw Error("Unexpected backend request " + url.pathname);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: String(e) }));
  }
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-only";
const api = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const out = await handler(
    new Request("http://127.0.0.1" + req.url, {
      method: req.method,
      headers: req.headers as any,
      ...(raw ? { body: raw } : {}),
    }),
  );
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await out.text());
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(api.address() as any).port}/api/v1/events/${E}`;
const call = async (
  path: string,
  method = "GET",
  body?: unknown,
  token = "ntucc_event_test_authorized",
) =>
  fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
try {
 for (const mode of ["member", "guest"] as const) {
  const payload = {name:"測試參與者", organization:"台大醫院測試單位", contact_email:"personal@example.test"};
  const registration = mode === "member" ? await call("/registration", "POST", payload) : await fetch(base + "/guest-registration", {method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":"a".repeat(64)},body:JSON.stringify({
    name: "測試參與者",
    organization: "台大醫院測試單位",
    contact_email: "personal@example.test",
  })});
  assert.equal(registration.status, 200);
  const receipt = await registration.json();
  assert.equal(receipt.status, "registered");
  const credential = mode === "guest" ? receipt.management_token : "ntucc_event_test_authorized";
  const ticketResponse = await call(mode === "guest" ? "/guest-ticket" : "/ticket", "GET", undefined, credential);
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json();
  assert.match(ticket.token, /^ntucc_ticket_[a-f0-9]{64}$/);
  const editResponse=await call(mode === "guest" ? "/guest-registration" : "/registration", "PATCH",{
    name:"更正後姓名", organization:"臺大醫院測試單位",contact_email:`${mode}@example.test`,meal_preference:"素食",
  },credential);
  assert.equal(editResponse.status,200);
  const editedTicket=await (await call(mode === "guest" ? "/guest-ticket" : "/ticket","GET",undefined,credential)).json();
  assert.equal(editedTicket.token,ticket.token);
  const editedRow=read(`select applicant_name,meal_preference from event_registrations where event_id='${E}' and status='registered'`)[0];
  assert.equal(editedRow.applicant_name,"更正後姓名");assert.equal(editedRow.meal_preference,"素食");
  const matrix = new QRCodeWriter().encode(
      ticket.token,
      BarcodeFormat.QR_CODE,
      320,
      320,
      new Map(),
    ),
    w = matrix.getWidth(),
    h = matrix.getHeight();
  const pixels = new Int32Array(w * h);
  let paths = "";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const black = matrix.get(x, y);
      pixels[y * w + x] = black ? 0xff000000 : 0xffffffff;
      if (black) paths += `M${x},${y}h1v1h-1z`;
    }
  const decoded = new QRCodeReader()
    .decode(
      new BinaryBitmap(
        new HybridBinarizer(new RGBLuminanceSource(pixels, w, h)),
      ),
      // The matrix is a synthetic, unrotated code: PURE_BARCODE avoids flaky finder-pattern detection.
      new Map([[DecodeHintType.PURE_BARCODE, true]]),
    )
    .getText();
  assert.equal(decoded, ticket.token);
  const icsResponse = await call("/calendar");
  assert.equal(icsResponse.status, 200);
  const ics = await icsResponse.text();
  assert(
    ics.includes("BEGIN:VEVENT") &&
      ics.includes("DTSTART:") &&
      ics.includes("DTEND:") &&
      ics.includes("SUMMARY:隔離測試小聚"),
  );
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/isolated-${mode}-ticket.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><path d="${paths}" fill="black"/></svg>`,
  );
  writeFileSync(`artifacts/isolated-${mode}-event.ics`, ics);
  const scan = await call("/check-in", "POST", { token: decoded }, "staff-jwt");
  assert.equal(scan.status, 200);
  assert.equal((await scan.json()).already_checked_in, false);
  const again = await call(
    "/check-in",
    "POST",
    { token: decoded },
    "staff-jwt",
  );
  assert.equal((await again.json()).already_checked_in, true);
  assert.equal((await call(mode === "guest" ? "/guest-registration" : "/registration", "DELETE", undefined, credential)).status, 200);
  const stale = await call(
    "/check-in",
    "POST",
    { token: decoded },
    "staff-jwt",
  );
  assert.equal(stale.status, 409);
  console.log(
    `PASS ${mode}: actual HTTP registration → real SQL → ticket → QR encode/decode → ICS download → staff check-in → duplicate → cancellation invalidates QR. Authentication is mocked; artifacts are isolated, not production tickets.`,
  );
 }
} finally {
  api.close();
  backend.close();
  sql(
    `delete from public_events where id='${E}';delete from profiles where id in('${U}','${S}');delete from auth.users where id in('${U}','${S}');`,
  );
}
