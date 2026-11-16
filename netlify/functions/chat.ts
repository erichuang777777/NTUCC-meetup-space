import { z } from "zod";
import { db, authenticate } from "./shared/auth-helper.js";
import { guard } from "./shared/pii-guard.js";
import { checked, body, fail, HttpError, json } from "./shared/http.js";
import { slideCount } from "./shared/spaces.js";
export default async (req: Request) => {
  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const actor = (await authenticate(req))!;
    const p = z
      .object({
        outline: z.string().min(10).max(12000),
        force_override: z.boolean().default(false),
      })
      .parse(await body(req));
    await guard(p.outline, p.force_override, actor, "web_ui");
    if (
      !checked(
        await db().rpc("consume_quota", {
          p_user: actor.id,
          p_action: "chat",
          p_limit: 10,
        }),
      )
    )
      throw new HttpError(429, "RATE_LIMITED");
    if (!process.env.CLOUD_LLM_API_KEY)
      throw new HttpError(503, "LLM_NOT_CONFIGURED");
    const base = new URL(
      process.env.CLOUD_LLM_BASE_URL ?? "https://api.openai.com/v1",
    );
    if (base.protocol !== "https:") throw new HttpError(503, "HTTPS_REQUIRED");
    const result = await fetch(
      base.toString().replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CLOUD_LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.CLOUD_LLM_MODEL ?? "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "你是臺大癌醫簡報助手。僅回傳完整、自包含 HTML，不要 Markdown code fence。使用繁體中文，產生 10 至 15 張 section.slide，適合 7 分鐘演示與 3 分鐘問答。內嵌 CSS，不使用外部資源、iframe、表單、fetch、導航或任何網路請求。投影片 16:9，首張可見，其他隱藏由播放器控制。勿包含病患個資。",
            },
            { role: "user", content: p.outline },
          ],
          max_tokens: 12000,
        }),
        signal: AbortSignal.timeout(55000),
      },
    );
    if (!result.ok) throw new HttpError(502, "LLM_UPSTREAM_ERROR");
    const data = await result.json();
    const html = String(data.choices?.[0]?.message?.content ?? "").replace(
      /^```(?:html)?\s*|\s*```$/g,
      "",
    );
    const count = slideCount(html);
    if (count < 10 || count > 15)
      throw new HttpError(422, "LLM_SLIDE_COUNT_INVALID", {
        slide_count: count,
      });
    // Never send newly generated sensitive content to the browser without a review signal.
    return json({ html_slides: html, slide_count: count });
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
};
