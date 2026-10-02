import { DatabaseSync } from 'node:sqlite';
export function sqliteBinding(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON');
  function prepared(sql) {
    const statement = database.prepare(sql);
    let values = [];
    const result = {
      bind(...input) {
        values = input;
        return result;
      },
      async first(column) {
        const row = statement.get(...values) || null;
        return column && row ? row[column] : row;
      },
      async all() {
        return { success: true, results: statement.all(...values) };
      },
      async run() {
        const meta = statement.run(...values);
        return { success: true, meta: { changes: meta.changes, last_row_id: Number(meta.lastInsertRowid) } };
      },
    };
    return result;
  }
  return {
    prepare: prepared,
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
    close() {
      database.close();
    },
  };
}
