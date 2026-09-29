import { resolvedProfileInfo } from "./lib/profile-info.ts";

resolvedProfileInfo().then((info) => console.log(JSON.stringify(info, null, 2))).catch(() => {
  console.error(JSON.stringify({ success: false, reason: "local Chrome/profile information unavailable" }));
  process.exitCode = 1;
});
