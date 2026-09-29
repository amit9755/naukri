export function GET() { return Response.json({ error: "Browser execution is local-only" }, { status: 410 }); }
