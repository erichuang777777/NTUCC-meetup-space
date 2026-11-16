export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details: unknown = null,
  ) {
    super(code);
  }
}
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
export async function body(req: Request) {
  if (Number(req.headers.get("content-length")) > 2_000_000)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE");
  const text = await req.text();
  if (text.length > 2_000_000) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}
export function fail(e: unknown) {
  if (e instanceof HttpError)
    return json({ code: e.code, ...((e.details as object) ?? {}) }, e.status);
  console.error(e instanceof Error ? e.message : "Request failed");
  return json({ code: "INTERNAL_ERROR" }, 500);
}
export function checked<T extends { error: any; data: any }>(r: T): T["data"] {
  if (r.error) throw new HttpError(400, "DATABASE_ERROR");
  return r.data;
}
