import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { dashboardUser } from "../../lib/server/control.ts";
import Dashboard from "./dashboard";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const jar = await cookies();
  try { await dashboardUser(new Request("https://local.invalid", { headers: { cookie: jar.toString() } })); }
  catch { redirect("/login"); }
  return <Dashboard />;
}
