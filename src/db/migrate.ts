import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { db, sql as pool } from "./index";

/**
 * Columns the code reads, with the idempotent DDL that restores each one.
 *
 * Drizzle records a migration as applied in its own ledger and never re-checks the
 * schema, so a migration that failed halfway - or a container that started after the
 * boot retry loop gave up - leaves a database the code cannot read. That shipped once:
 * the deploy reported success while every route touching `tenants` answered 500.
 *
 * `migrate()` can also throw when the ledger itself is inconsistent (a recorded
 * migration whose SQL no longer matches its hash). That is exactly the state worth
 * repairing, so the repair below runs whether or not `migrate()` succeeded.
 */
const REQUIRED_COLUMNS: Array<{
  table: string;
  column: string;
  repair: string;
}> = [
  {
    table: "tenants",
    column: "free_top_ups",
    repair: `alter table "tenants" add column if not exists "free_top_ups" integer default 0 not null`,
  },
  {
    table: "tenants",
    column: "free_top_up_at",
    repair: `alter table "tenants" add column if not exists "free_top_up_at" timestamp with time zone`,
  },
];

async function present(table: string, column: string): Promise<boolean> {
  const rows = await db.execute(
    sql`select 1 from information_schema.columns
        where table_name = ${table} and column_name = ${column} limit 1`,
  );
  return rows.length > 0;
}

/** Applies migrations, repairs a half-migrated schema, then closes the pool. */
async function main() {
  console.log("⏳ Applying migrations...");
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✅ Migrations applied");
  } catch (err) {
    // Keep going: the repair below is idempotent and may be the only thing that can
    // fix this database. If it cannot, the verification at the end fails the boot.
    console.error("⚠️  migrate() failed, will attempt the schema repair anyway:", err);
  }

  const missing: string[] = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    if (!(await present(table, column))) missing.push(`${table}.${column}`);
  }

  if (missing.length) {
    console.warn(
      `⚠️  schema is behind the code: missing ${missing.join(", ")}. Re-applying.`,
    );
    for (const { table, column, repair } of REQUIRED_COLUMNS) {
      if (!missing.includes(`${table}.${column}`)) continue;
      try {
        await db.execute(sql.raw(repair));
        console.warn(`   repaired ${table}.${column}`);
      } catch (err) {
        console.error(`   could not repair ${table}.${column}:`, err);
      }
    }
  }

  // Verify the result rather than trusting the statements that just ran.
  const still: string[] = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    if (!(await present(table, column))) still.push(`${table}.${column}`);
  }
  if (still.length) {
    throw new Error(
      `schema is behind the code and could not be repaired: ${still.join(", ")}. ` +
        `Refusing to serve on a schema the code cannot read.`,
    );
  }

  console.log(`✅ schema verified (${REQUIRED_COLUMNS.length} columns present)`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  await pool.end({ timeout: 5 });
  process.exit(1);
});
