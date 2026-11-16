import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticate } from "./shared/auth-helper.js";
import { db } from "./shared/auth-helper.js";
import {
  LIST,
  question,
  slides,
  spaceSchema,
  upsertSpace,
} from "./shared/spaces.js";
import { checked, fail, HttpError, json } from "./shared/http.js";
export default async (req: Request) => {
  const origin = req.headers.get("origin");
  const allowed = process.env.APP_ORIGIN;
  const cors: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Method, Mcp-Name, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && origin === allowed)
    cors["Access-Control-Allow-Origin"] = origin;
  const wrap = (r: Response) => {
    for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
    return r;
  };
  if (origin && origin !== allowed)
    return wrap(json({ code: "ORIGIN_NOT_ALLOWED" }, 403));
  if (req.method === "OPTIONS")
    return wrap(new Response(null, { status: 204 }));
  if (req.method !== "POST")
    return wrap(json({ code: "METHOD_NOT_ALLOWED" }, 405));
  try {
    const raw = await req.text();
    if (raw.length > 2_000_000)
      return wrap(json({ code: "PAYLOAD_TOO_LARGE" }, 413));
    req = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: raw,
    });
    const actor = await authenticate(req);
    const server = new McpServer({
      name: "ntucc-meetup-spaces",
      version: "1.0.0",
    });
    const requireActor = () => {
      if (!actor) throw new HttpError(401, "AUTH_REQUIRED");
      return actor;
    };
    server.registerResource(
      "public_spaces",
      "meetup://spaces/public",
      { mimeType: "application/json" },
      async (uri) => {
        const spaces = checked(
          await db()
            .from("spaces")
            .select(LIST)
            .eq("visibility", "public")
            .order("votes", { ascending: false }),
        );
        const qa = checked(
          await db()
            .from("qa_public")
            .select(
              "id,space_id,question_text,is_anonymous,author_name,is_resolved,upvotes",
            )
            .order("upvotes", { ascending: false })
            .limit(100),
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ spaces, questions: qa }),
            },
          ],
        };
      },
    );
    server.registerResource(
      "space_slides",
      new ResourceTemplate("meetup://spaces/{id}/slides", { list: undefined }),
      {
        mimeType: "text/html",
        description: "已通關同仁可讀取公開展示，或自己的私人草稿",
      },
      async (uri, { id }) => {
        const data = await slides(z.string().uuid().parse(id), requireActor());
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/html",
              text: data?.html_slides ?? "",
            },
          ],
        };
      },
    );
    const result = (v: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(v) }],
    });
    const run = async (fn: () => Promise<unknown>) => {
      try {
        return result(await fn());
      } catch (e) {
        if (e instanceof HttpError)
          return {
            ...result({ code: e.code, ...((e.details as object) ?? {}) }),
            isError: true,
          };
        return { ...result({ code: "REQUEST_FAILED" }), isError: true };
      }
    };
    server.registerTool(
      "search_pain_points",
      {
        description: "依關鍵字或科別搜尋痛點",
        inputSchema: {
          keyword: z.string().max(100).default(""),
          department: z.string().max(80).optional(),
        },
      },
      async ({ keyword, department }) =>
        run(async () => {
          let query = db()
            .from("pain_points")
            .select(
              "id,title,department,scenario,time_cost,ideal_outcome,upvotes",
            )
            .order("upvotes", { ascending: false })
            .limit(50);
          if (keyword)
            query = query.ilike(
              "title",
              "%" + keyword.replace(/[%_]/g, "") + "%",
            );
          if (department) query = query.eq("department", department);
          return checked(await query);
        }),
    );
    server.registerTool(
      "upsert_my_space",
      {
        description: "建立或更新自己的展示，10–15 頁 HTML，含 PII 檢查",
        inputSchema: spaceSchema.shape,
      },
      async (args) =>
        run(() => upsertSpace(args, requireActor(), "mcp_server")),
    );
    server.registerTool(
      "post_slido_question",
      {
        description: "在公開展示發問，可匿名",
        inputSchema: {
          space_id: z.string().uuid(),
          question_text: z.string().min(1).max(2000),
          is_anonymous: z.boolean().default(false),
          force_override: z.boolean().default(false),
        },
      },
      async (args) => run(() => question(args, requireActor(), "mcp_server")),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req); // JSON responses finish before transport cleanup.
    const text = await response.text();
    await server.close();
    return wrap(
      new Response(text, {
        status: response.status,
        headers: response.headers,
      }),
    );
  } catch (e) {
    return wrap(fail(e));
  }
};
