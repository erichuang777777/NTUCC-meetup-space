/**
 * Swappable email provider adapter. Generic JSON HTTP POST:
 *   POST EMAIL_PROVIDER_URL   Authorization: Bearer EMAIL_API_KEY
 *   { from: EMAIL_FROM, to, subject, text }
 * This matches Resend's `POST https://api.resend.com/emails` shape (to may be a string).
 * Replace this file to support another provider; callers only use sendEmail().
 */
export type EmailMessage = { to: string; subject: string; text: string };
export type EmailConfig = { url: string; key: string; from: string };
export type SendResult = {
  ok: boolean;
  notConfigured?: boolean;
  error?: string;
};
type Env = Record<string, string | undefined>;

export function emailConfig(env: Env = process.env): EmailConfig | null {
  const url = env.EMAIL_PROVIDER_URL?.trim();
  const key = env.EMAIL_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!url || !key || !from) return null;
  return { url, key, from };
}

/** "alice@example.com" -> "a***@e***.com" (safe for logs). */
export function maskEmail(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  if (!domain) return "***";
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** Removes addresses and credentials, then caps at 500 chars (matches DB last_error limit). */
export function truncateError(
  message: unknown,
  secrets: string[] = [],
): string {
  let s = String(message ?? "");
  for (const secret of secrets)
    if (secret) s = s.split(secret).join("[redacted]");
  s = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
    .replace(/\b(Bearer|Token|Key)\s+\S+/gi, "$1 [redacted]");
  return s.slice(0, 500);
}

export async function sendEmail(
  msg: EmailMessage,
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<SendResult> {
  const cfg = emailConfig(env);
  if (!cfg) return { ok: false, notConfigured: true };
  try {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        from: cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      }),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      error: truncateError(`PROVIDER_HTTP_${res.status} ${detail}`, [cfg.key]),
    };
  } catch (e) {
    return {
      ok: false,
      error: truncateError(
        `PROVIDER_REQUEST_FAILED ${e instanceof Error ? e.message : ""}`,
        [cfg.key],
      ),
    };
  }
}
