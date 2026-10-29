import type { Pool } from "pg";

// In-process stand-in for Neon's SQL-over-HTTP endpoint, used only by the
// disposable PostgreSQL fixtures. It lets the production client
// (drizzle-orm/neon-http + @neondatabase/serverless) serialize real requests
// while PostgreSQL executes them: single queries autocommit and `queries`
// batches run in one transaction on one session, as Neon documents. This
// validates the production driver code path, not Neon's hosted service.
const raw = { getTypeParser: () => (v: string) => v };
const errorFields = [
  "severity", "code", "detail", "hint", "position", "internalPosition",
  "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine",
] as const;
const isolation: Record<string, string> = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};
type Query = { query: string; params: unknown[] };

export function neonHttpShim(pool: Pool, searchPath: string) {
  return async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as Query | { queries: Query[] };
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO "${searchPath}"`);
      const run = async (q: Query) => {
        const r = await c.query({ text: q.query, values: q.params, rowMode: "array", types: raw });
        return {
          fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
          rows: r.rows,
          rowCount: r.rowCount,
          command: r.command,
        };
      };
      if (!("queries" in body)) return Response.json(await run(body));
      const level = init.headers["Neon-Batch-Isolation-Level"];
      await c.query(level ? `BEGIN ISOLATION LEVEL ${isolation[level]}` : "BEGIN");
      try {
        const results = [];
        for (const [i, q] of body.queries.entries()) {
          results.push(await run(q));
          if (i === 0) await c.query("SELECT pg_sleep(0.01)"); // encourage overlapping transactions
        }
        await c.query("COMMIT");
        return Response.json({ results });
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    } catch (e: any) {
      const out: Record<string, unknown> = { message: e?.message };
      for (const k of errorFields) out[k] = e?.[k];
      return Response.json(out, { status: 400 });
    } finally {
      c.release();
    }
  };
}
