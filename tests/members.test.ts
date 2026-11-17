import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/members.js";
import { hashToken } from "../netlify/functions/shared/auth-helper.js";
const U = "00000000-0000-4000-8000-000000000001",
  R = "00000000-0000-4000-8000-000000000002",
  I = "10000000-0000-4000-8000-000000000001";
test("member administration requires an interactive admin; invitation secrets are hashed and claims bind the authenticated user", async () => {
  let role = "member",
    verified = true;
  const calls: { path: string; data: any; method: string }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const data = text ? JSON.parse(text) : null,
      path = req.url ?? "",
      url = new URL(path, "http://mock");
    calls.push({ path, data, method: req.method! });
    res.setHeader("content-type", "application/json");
    res.setHeader("content-range", "0-0/1");
    const send = (v: any, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(v));
    };
    if (path === "/auth/v1/user")
      return send({ id: U, email: "admin@example.test", aud: "authenticated" });
    if (url.pathname === "/rest/v1/user_api_tokens")
      return send(
        req.method === "GET"
          ? {
              id: "token",
              user_id: U,
              scopes: ["projects:read", "projects:write"],
            }
          : {},
      );
    if (url.pathname === "/rest/v1/profiles")
      return send(
        url.searchParams.get("select") === "id,role,passcode_verified"
          ? { id: U, role, passcode_verified: verified }
          : [
              {
                id: U,
                email: "admin@example.test",
                role,
                passcode_verified: verified,
              },
            ],
      );
    if (url.pathname === "/rest/v1/member_invitations")
      return send([{ id: I, email: "invitee@example.test", role: "member" }]);
    if (path === "/rest/v1/rpc/create_member_invitation") return send(I);
    if (path === "/rest/v1/rpc/set_member_role") {
      if (data.p_actor === data.p_target)
        return send({ message: "SELF_ROLE_CHANGE_FORBIDDEN" }, 400);
      return send({ id: data.p_target, role: data.p_role });
    }
    if (path === "/rest/v1/rpc/consume_quota") return send(true);
    if (path === "/rest/v1/rpc/accept_member_invitation")
      return send({ accepted: true, duplicate: false });
    if (path === "/rest/v1/rpc/revoke_member_invitation") return send(null);
    send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    APP_ORIGIN: process.env.APP_ORIGIN,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  process.env.APP_ORIGIN = "https://meetup.example";
  const request = (method: string, body?: any, token = "jwt") =>
    handler(
      new Request("http://localhost/api/members", {
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    assert.equal(
      (await handler(new Request("http://localhost/api/members"))).status,
      401,
    );
    assert.equal(calls.length, 0);
    assert.equal((await request("GET")).status, 403);
    assert.ok(!calls.some((c) => c.path.includes("member_invitations")));
    role = "admin";
    assert.equal(
      (await request("GET", undefined, "ntucc_sk_test")).status,
      403,
    );
    const list = await request("GET");
    assert.equal(list.status, 200);
    assert.ok(
      !calls
        .filter((c) => c.path.startsWith("/rest/v1/member_invitations"))
        .some((c) => c.path.includes("token_hash")),
    );
    const invited = await request("POST", {
      action: "invite",
      email: " Invitee@Example.Test ",
      role: "admin",
    });
    assert.equal(invited.status, 201);
    const invite = await invited.json();
    assert.match(invite.token, /^ntucc_inv_[a-f0-9]{64}$/);
    assert.equal(invite.url, "https://meetup.example/#invite=" + invite.token);
    const created = calls.find(
      (c) => c.path === "/rest/v1/rpc/create_member_invitation",
    );
    assert.equal(created?.data.p_actor, U);
    assert.equal(created?.data.p_email, "invitee@example.test");
    assert.equal(created?.data.p_hash, hashToken(invite.token));
    assert.ok(!JSON.stringify(created?.data).includes(invite.token));
    assert.equal(
      (await request("POST", { action: "role", user_id: U, role: "member" }))
        .status,
      403,
    );
    assert.equal(
      (await request("POST", { action: "role", user_id: R, role: "admin" }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("POST", {
          action: "role",
          user_id: R,
          role: "admin",
          actor_id: R,
        })
      ).status,
      400,
    );
    verified = false;
    assert.equal(
      (await request("POST", { action: "accept", token: invite.token })).status,
      200,
    );
    const accepted = calls.find(
      (c) => c.path === "/rest/v1/rpc/accept_member_invitation",
    );
    assert.equal(accepted?.data.p_user, U);
    assert.equal(accepted?.data.p_hash, hashToken(invite.token));
    assert.equal(
      (
        await request("POST", {
          action: "accept",
          token: invite.token,
          user_id: R,
          role: "admin",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "POST",
          { action: "accept", token: invite.token },
          "ntucc_sk_test",
        )
      ).status,
      403,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((r, j) =>
      server.close((err) => (err ? j(err) : r())),
    );
  }
});
