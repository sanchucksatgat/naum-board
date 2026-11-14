/**
 * Registry DO SQLite 스키마 마이그레이션.
 * 규칙: 이미 배포된 항목은 절대 고치지 말고, 배열 끝에 새 항목을 추가한다 (태스크2: boards/classes/students).
 * 각 항목은 한 번만, 순서대로, 하나의 트랜잭션 안에서 실행된다.
 */
export const REGISTRY_MIGRATIONS: readonly string[] = [
  // 1: 기본 키-값 + 소유자
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS owner (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     sub TEXT NOT NULL,
     email TEXT NOT NULL,
     refresh_token TEXT,
     scope TEXT NOT NULL DEFAULT '',
     needs_reconnect INTEGER NOT NULL DEFAULT 0,
     drive_root_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
];

/** ctx.storage.sql 에 아직 적용되지 않은 마이그레이션을 적용한다. */
export function applyMigrations(storage: DurableObjectStorage, migrations: readonly string[]): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations").one();
  const current = row.v ?? 0;
  for (let i = current; i < migrations.length; i++) {
    storage.transactionSync(() => {
      sql.exec(migrations[i]!);
      sql.exec("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", i + 1, Date.now());
    });
  }
}
