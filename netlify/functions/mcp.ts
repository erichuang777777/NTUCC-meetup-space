import * as agent from "./shared/agent-service.js";
import { discussionAction } from "./shared/discussions.js";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticate, requireScope } from "./shared/auth-helper.js";
import { db } from "./shared/auth-helper.js";
import { filterHidden } from "./shared/moderation.js";
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
        requireScope(requireActor(), "projects:read");
        requireScope(requireActor(), "discussions:read");
        const actorId = requireActor().id;
        const spaces = await filterHidden(
          db(),
          actorId,
          "space",
          checked(
            await db()
              .from("spaces")
              .select(LIST)
              .eq("visibility", "public")
              .order("votes", { ascending: false }),
          ),
        );
        const qa = await filterHidden(
          db(),
          actorId,
          "qa",
          checked(
            await db()
              .from("qa_public")
              .select(
                "id,space_id,question_text,is_anonymous,author_name,is_resolved,upvotes",
              )
              .order("upvotes", { ascending: false })
              .limit(100),
          ),
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
          requireScope(requireActor(), "projects:read");
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
          return filterHidden(
            db(),
            requireActor().id,
            "pain_point",
            checked(await query),
          );
        }),
    );
    server.registerTool(
      "upsert_my_space",
      {
        description: "建立或更新自己的展示，10–15 頁 HTML，含 PII 檢查",
        inputSchema: spaceSchema.shape,
      },
      async (args: any) =>
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
      async (args: any) =>
        run(() => question(args, requireActor(), "mcp_server")),
    );
    const pageShape = {
      offset: z.number().int().min(0).max(100000).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    };
    const register = (
      name: string,
      description: string,
      inputSchema: any,
      fn: (args: any) => Promise<any>,
    ) =>
      server.registerTool(
        name,
        { description, inputSchema },
        async (args: any) => run(() => fn(args)),
      );
    register(
      "list_projects",
      "搜尋院內公開專案；mine=true 只看自己的專案與草稿",
      {
        ...pageShape,
        query: z.string().max(100).default(""),
        mine: z.boolean().default(false),
      },
      (p) => agent.listProjects(requireActor(), p),
    );
    register(
      "get_project",
      "讀取專案介紹與參考連結；不得讀取他人私人草稿",
      { project_id: z.string().uuid() },
      (p) => agent.getProject(requireActor(), p.project_id),
    );
    register(
      "list_project_discussions",
      "分頁查看指定專案的討論主題",
      {
        ...pageShape,
        project_id: z.string().uuid(),
        kind: z.enum(["question", "experience", "resource"]).optional(),
      },
      (p) => agent.listDiscussions(requireActor(), p.project_id, p),
    );
    register(
      "read_discussion",
      "讀取討論主題與分頁回覆",
      { ...pageShape, thread_id: z.string().uuid() },
      (p) => agent.readDiscussion(requireActor(), p.thread_id, p),
    );
    register(
      "create_discussion",
      "以 Token 所屬同仁身分在公開專案開啟討論，執行 PII Guard",
      {
        space_id: z.string().uuid(),
        title: z.string().min(1).max(160),
        body: z.string().min(1).max(6000),
        kind: z.enum(["question", "experience", "resource"]),
        force_override: z.boolean().default(false),
      },
      (p) =>
        discussionAction(
          "thread_create",
          p,
          p.force_override,
          requireActor(),
          "mcp_server",
        ),
    );
    register(
      "reply_to_discussion",
      "以自己的身分回覆公開專案討論，執行 PII Guard",
      {
        thread_id: z.string().uuid(),
        body: z.string().min(1).max(6000),
        force_override: z.boolean().default(false),
      },
      (p) =>
        discussionAction(
          "thread_reply",
          p,
          p.force_override,
          requireActor(),
          "mcp_server",
        ),
    );
    register(
      "get_member_profile",
      "取得同仁顯示名稱、部門與站內聯絡設定；不提供 Email",
      { user_id: z.string().uuid() },
      (p) => agent.memberProfile(requireActor(), p.user_id),
    );
    register(
      "list_my_inbox",
      "讀取自己參與的站內私訊對話；需 messages:read 權限",
      pageShape,
      (p) => agent.inbox(requireActor(), p),
    );
    register(
      "read_my_conversation",
      "分頁讀取自己參與的私訊；管理員沒有他人對話的讀取權",
      { ...pageShape, conversation_id: z.string().uuid() },
      (p) => agent.conversationMessages(requireActor(), p.conversation_id, p),
    );
    register(
      "send_private_message",
      "以自己身分發送站內私訊，需 messages:write。recipient_id 為同仁 UUID，不寄送 Email；client_request_id 可防止重試重複發送",
      agent.messageSchema.shape,
      (p) => agent.sendMessage(requireActor(), p, "mcp_server"),
    );
    register(
      "get_contact_settings",
      "查看自己的站內聯絡偏好與封鎖名單",
      {},
      () => agent.contactSettings(requireActor()),
    );
    register(
      "set_contact_preference",
      "設定自己是否接受站內私訊",
      { accepts_messages: z.boolean() },
      (p) => agent.setPreference(requireActor(), p),
    );
    register(
      "set_contact_block",
      "封鎖或解除封鎖指定同仁的站內私訊",
      { user_id: z.string().uuid(), blocked: z.boolean() },
      (p) => agent.blockMember(requireActor(), p),
    );
    server.registerResource(
      "project_introduction",
      new ResourceTemplate("meetup://projects/{id}", { list: undefined }),
      { mimeType: "application/json" },
      async (uri, { id }) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              await agent.getProject(
                requireActor(),
                z.string().uuid().parse(id),
              ),
            ),
          },
        ],
      }),
    );
    server.registerResource(
      "project_discussions",
      new ResourceTemplate("meetup://projects/{id}/discussions", {
        list: undefined,
      }),
      { mimeType: "application/json" },
      async (uri, { id }) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              await agent.listDiscussions(
                requireActor(),
                z.string().uuid().parse(id),
                {},
              ),
            ),
          },
        ],
      }),
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
