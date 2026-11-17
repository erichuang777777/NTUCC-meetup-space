import { z } from "zod";
import { authenticate } from "./shared/auth-helper.js";
import { body, json, fail, HttpError } from "./shared/http.js";
import { upsertSpace } from "./shared/spaces.js";
import { discussionAction } from "./shared/discussions.js";
import * as service from "./shared/agent-service.js";
export default async (req: Request) => {
  try {
    if (!["GET", "POST"].includes(req.method))
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const actor = (await authenticate(req))!;
    const url = new URL(req.url);
    const route = url.pathname
      .replace(/^.*\/(?:agent-api|agent)\/?/, "")
      .split("/")
      .filter(Boolean);
    const [name, id, child] = route;
    const input = Object.fromEntries(url.searchParams);
    const channel = req.headers
      .get("authorization")
      ?.startsWith("Bearer ntucc_sk_")
      ? "rest_api"
      : "web_ui";
    if (req.method === "GET") {
      if (name === "projects" && !id)
        return json(
          await service.listProjects(actor, {
            ...input,
            mine: input.mine === "true",
          }),
        );
      if (name === "projects" && id && child === "discussions")
        return json(await service.listDiscussions(actor, id, input));
      if (name === "projects" && id && !child)
        return json(await service.getProject(actor, id));
      if (name === "discussions" && id)
        return json(await service.readDiscussion(actor, id, input));
      if (name === "members" && id)
        return json(await service.memberProfile(actor, id));
      if (name === "inbox" && !id)
        return json(await service.inbox(actor, input));
      if (name === "inbox" && id)
        return json(await service.conversationMessages(actor, id, input));
      if (name === "contact-settings")
        return json(await service.contactSettings(actor));
    } else {
      const p = await body(req);
      if (name === "projects" && !id)
        return json({ id: await upsertSpace(p, actor, channel) }, 201);
      if (name === "discussions" && !id) {
        const { force_override = false, ...payload } = p;
        z.boolean().parse(force_override);
        return json(
          await discussionAction(
            "thread_create",
            payload,
            force_override,
            actor,
            channel,
          ),
          201,
        );
      }
      if (name === "discussions" && id && child === "replies") {
        const { force_override = false, ...payload } = p;
        z.boolean().parse(force_override);
        return json(
          await discussionAction(
            "thread_reply",
            { ...payload, thread_id: id },
            force_override,
            actor,
            channel,
          ),
          201,
        );
      }
      if (name === "messages")
        return json(await service.sendMessage(actor, p, channel), 201);
      if (name === "contact-settings")
        return json(await service.setPreference(actor, p));
      if (name === "contact-blocks")
        return json(await service.blockMember(actor, p));
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (e) {
    if (e instanceof z.ZodError)
      return json({ code: "VALIDATION_ERROR", issues: e.flatten() }, 400);
    return fail(e);
  }
};
