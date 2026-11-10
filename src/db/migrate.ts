import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./index";

/** Applies all pending Drizzle migrations, then closes the pool. */
async function main() {
  console.log("⏳ Applying migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("✅ Migrations applied");
  await sql.end();
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
