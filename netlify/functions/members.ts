import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  authenticate,
  admin,
  requireInteractive,
  db,
  hashToken,
} from "./shared/auth-helper.js";
import { body, checked, json, fail, HttpError } from "./shared/http.js";
const uuid = z.string().uuid();
function rpcResult(r: any) {
  if (r.error) {
    const error = String(r.error.message);
    const code = [
      "ADMIN_REQUIRED",
      "SELF_ROLE_CHANGE_FORBIDDEN",
      "MEMBER_NOT_VERIFIED",
      "LAST_ADMIN",
      "INVALID_INVITATION",
      "INVITATION_NOT_PENDING",
      "INVITATION_INVALID",
      "INVITE_ACCOUNT_MISMATCH",
      "GOOGLE_LOGIN_REQUIRED",
      "RATE_LIMITED",
    ].find((c) => error.includes(c));
    throw new HttpError(
      code === "RATE_LIMITED" ? 429 : code?.includes("INVITATION") ? 400 : 403,
      code ?? "MEMBER_UPDATE_FAILED",
    );
  }
  return r.data;
}
export default async (req: Request) => {
  try {
    if (!["GET", "POST"].includes(req.method))
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const input =
      req.method === "POST"
        ? z
            .object({ action: z.enum(["accept", "invite", "role", "revoke"]) })
            .passthrough()
            .parse(await body(req))
        : null;
    if (input?.action === "accept") {
      const p = z
        .object({
          action: z.literal("accept"),
          token: z.string().regex(/^ntucc_inv_[a-f0-9]{64}$/),
        })
        .strict()
        .parse(input);
      const token = req.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token) throw new HttpError(401, "AUTH_REQUIRED");
      if (token.startsWith("ntucc_sk_"))
        throw new HttpError(403, "INTERACTIVE_LOGIN_REQUIRED");
      const { data, error } = await db().auth.getUser(token);
      if (error || !data.user) throw new HttpError(401, "INVALID_TOKEN");
      if (
        !checked(
          await db().rpc("consume_quota", {
            p_user: data.user.id,
            p_action: "accept_invitation",
            p_limit: 30,
          }),
        )
      )
        throw new HttpError(429, "RATE_LIMITED");
      return json(
        rpcResult(
          await db().rpc("accept_member_invitation", {
            p_user: data.user.id,
            p_hash: hashToken(p.token),
          }),
        ),
      );
    }
    const actor = (await authenticate(req))!;
    admin(actor);
    requireInteractive(actor);
    if (req.method === "GET") {
      const params = Object.fromEntries(new URL(req.url).searchParams),
        p = z
          .object({
            offset: z.coerce.number().int().min(0).max(100000).default(0),
            query: z.string().max(100).default(""),
          })
          .parse(params);
      let query = db()
        .from("profiles")
        .select(
          "id,email,display_name,department,role,passcode_verified,created_at",
          { count: "exact" },
        );
      if (p.query)
        query = query.ilike("email", "%" + p.query.replace(/[%_]/g, "") + "%");
      const members = await query
        .order("created_at", { ascending: false })
        .order("id")
        .range(p.offset, p.offset + 19);
      const invitations = checked(
        await db()
          .from("member_invitations")
          .select("id,email,role,created_at,expires_at,accepted_at,revoked_at")
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(50),
      );
      return json({
        members: checked(members),
        total: members.count,
        offset: p.offset,
        limit: 20,
        invitations,
      });
    }
    if (input!.action === "role") {
      const p = z
        .object({
          action: z.literal("role"),
          user_id: uuid,
          role: z.enum(["member", "admin"]),
        })
        .strict()
        .parse(input);
      return json(
        rpcResult(
          await db().rpc("set_member_role", {
            p_actor: actor.id,
            p_target: p.user_id,
            p_role: p.role,
          }),
        ),
      );
    }
    if (input!.action === "invite") {
      const p = z
          .object({
            action: z.literal("invite"),
            email: z
              .string()
              .trim()
              .email()
              .max(254)
              .transform((s) => s.toLowerCase()),
            role: z.enum(["member", "admin"]).default("member"),
          })
          .strict()
          .parse(input),
        token = "ntucc_inv_" + randomBytes(32).toString("hex");
      const origin = new URL(process.env.APP_ORIGIN ?? new URL(req.url).origin);
      if (!["https:", "http:"].includes(origin.protocol))
        throw new HttpError(503, "SITE_ORIGIN_REQUIRED");
      const id = rpcResult(
        await db().rpc("create_member_invitation", {
          p_actor: actor.id,
          p_email: p.email,
          p_role: p.role,
          p_hash: hashToken(token),
        }),
      );
      return json(
        {
          id,
          token,
          url: origin.origin + "/#invite=" + token,
          email: p.email,
          role: p.role,
          expires_in_days: 7,
        },
        201,
      );
    }
    if (input!.action === "revoke") {
      const p = z
        .object({ action: z.literal("revoke"), id: uuid })
        .strict()
        .parse(input);
      rpcResult(
        await db().rpc("revoke_member_invitation", {
          p_actor: actor.id,
          p_id: p.id,
        }),
      );
      return json({ ok: true });
    }
    throw new HttpError(400, "UNKNOWN_ACTION");
  } catch (e) {
    if (e instanceof z.ZodError)
      return json({ code: "VALIDATION_ERROR", issues: e.flatten() }, 400);
    return fail(e);
  }
};
