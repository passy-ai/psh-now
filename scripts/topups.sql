-- Who took the free +20 top-ups, and how far they got.
--
-- The mechanic is deliberately invisible in the product, so this is the only surface
-- that answers "is anyone actually using it". Run it against whichever database holds
-- the deployment you care about:
--
--   psql "$DATABASE_URL" -f scripts/topups.sql
--
-- `taken` is the workspace's counter, not a count of rows: if a row is missing between
-- 1 and taken, something was deleted from audit_log.

\pset border 2

-- One line per workspace that has ever taken a top-up, most recent first.
select
  t.free_top_ups                                        as taken,
  coalesce(t.email, '(anonymous)')                      as who,
  t.id                                                  as workspace,
  t.claimed_at is not null                              as claimed,
  t.token_balance                                       as balance,
  max(a.created_at)                                     as last_topup,
  date_trunc('day', min(a.created_at))                  as first_topup
from tenants t
join audit_log a
  on a.tenant_id = t.id and a.action = 'tokens.topup'
group by t.id, t.email, t.free_top_ups, t.claimed_at, t.token_balance
order by taken desc, last_topup desc;

-- The number worth watching: how many workspaces stopped at 1 (tried it and left),
-- how many went all the way to the claimed ceiling of 20 (used the product enough to
-- exhaust every free grant), and everything between.
select
  case
    when free_top_ups = 1 then '1 (anonymous only)'
    when free_top_ups >= 20 then '20 (exhausted)'
    else '2-19 (partial)'
  end                       as band,
  count(*)                  as workspaces,
  sum(free_top_ups * 20)    as requests_granted
from tenants
where free_top_ups > 0
group by band
order by min(free_top_ups);

-- Totals across the deployment.
select
  count(*)                  as workspaces_with_topups,
  sum(free_top_ups)         as total_grants,
  sum(free_top_ups * 20)    as total_requests
from tenants
where free_top_ups > 0;
