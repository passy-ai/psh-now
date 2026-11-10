import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/psh.now");
const em = "wesly+test1@absolum.nl";
const u = await sql`select id, tenant_id, created_at from auth_user where email = ${em}`;
if (!u.length) { console.log("no user for email, trying claims"); 
  const c = await sql`select tenant_id, min(created_at) first_seen from claims where email = ${em} group by tenant_id`;
  console.log(JSON.stringify(c.map(r=>({...r}))), null, 1); process.exit(0); }
const tid = u[0].tenant_id;
console.log("tenant:", tid, "| account since:", u[0].created_at);
const rows = await sql`
  select min(created_at) first_prompt,
         max(created_at) last_prompt,
         count(*) total_prompts,
         count(*) filter (where created_at > now() - interval '1 day') last_24h,
         count(*) filter (where created_at > now() - interval '7 days') last_7d,
         count(*) filter (where created_at > now() - interval '30 days') last_30d
  from prompts where tenant_id = ${tid}`;
const r = rows[0];
const span_days = (new Date(r.last_prompt) - new Date(r.first_prompt)) / 86400000 || 0.001;
console.log(JSON.stringify({
  ...r,
  span_days: +span_days.toFixed(2),
  avg_prompts_per_day_alltime: +(r.total_prompts / span_days).toFixed(1),
  avg_prompts_per_day_7d: +(r.last_7d / 7).toFixed(1),
}, null, 1));
// per-day profile for the last 14 days
const days = await sql`
  select to_char(date_trunc('day', created_at), 'MM-DD') d, count(*) n
  from prompts where tenant_id = ${tid} and created_at > now() - interval '14 days'
  group by 1 order by 1`;
console.log("daily:", days.map(x=>`${x.d}:${x.n}`).join(" "));
await sql.end();
