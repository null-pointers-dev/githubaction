import { apiUser, json } from "@/server/session";
import { getRunView } from "@/server/views";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not_found" }, 404);
  const view = await getRunView(id, user);
  if (!view) return json({ error: "not_found" }, 404);
  return json(view);
}
