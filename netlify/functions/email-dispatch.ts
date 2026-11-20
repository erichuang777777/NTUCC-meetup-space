import { db } from "./shared/auth-helper.js";
import {
  emailConfig,
  maskEmail,
  sendEmail,
  type EmailMessage,
  type SendResult,
} from "./shared/email-provider.js";
import { requireFeature } from "./shared/features.js";
import { fail, json } from "./shared/http.js";

type Client = Parameters<typeof requireFeature>[0];
type Send = (msg: EmailMessage) => Promise<SendResult>;
type Row = {
  id: string;
  subject: string;
  body_text: string;
  link: string | null;
  to_email: string;
};

let warned = false;
export function resetWarned() {
  warned = false;
}

/** APP_ORIGIN + relative link ('#x' becomes '/#x'). */
export function absoluteLink(origin: string, link: string | null): string {
  const base = origin.replace(/\/+$/, "");
  const l = link && /^[/#]/.test(link) ? link : "#notifications";
  return base + (l.startsWith("#") ? "/" + l : l);
}

/** Claims due rows, sends them and records the outcome. Rows stay pending if the provider is not configured. */
export async function runEmailDispatch(
  client: Client,
  send: Send = (m) => sendEmail(m),
  origin = process.env.APP_ORIGIN ?? "",
  configured = emailConfig() !== null,
) {
  await requireFeature(client, "email_notifications");
  if (!configured) {
    if (!warned) {
      warned = true;
      console.warn("email-dispatch: EMAIL_* not configured; rows stay pending");
    }
    return { sent: 0, failed: 0, claimed: 0, configured: false };
  }
  const claimed = await client.rpc("claim_email_batch", { p_limit: 50 });
  if (claimed.error) throw new Error("CLAIM_FAILED");
  const rows = (claimed.data ?? []) as Row[];
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const text = `${r.body_text}\n\n${absoluteLink(origin, r.link)}`;
    const res = await send({ to: r.to_email, subject: r.subject, text });
    if (res.ok) sent++;
    else {
      failed++;
      console.warn(`email-dispatch: send failed for ${maskEmail(r.to_email)}`);
    }
    const done = await client.rpc("complete_email", {
      p_id: r.id,
      p_ok: res.ok,
      p_error: res.ok ? null : (res.error ?? "SEND_FAILED").slice(0, 500),
    });
    if (done.error) console.warn("email-dispatch: complete_email failed");
  }
  return { sent, failed, claimed: rows.length, configured: true };
}

export default async () => {
  try {
    return json(await runEmailDispatch(db()));
  } catch (e) {
    return fail(e);
  }
};

export const config = { schedule: "*/10 * * * *" };
