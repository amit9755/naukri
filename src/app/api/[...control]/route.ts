import { handleControl } from "../../../lib/server/control.ts";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
async function handler(request: Request, context: { params: Promise<{ control: string[] }> }) {
  return handleControl(request, (await context.params).control.join("/"));
}
export { handler as GET, handler as POST, handler as PUT };
