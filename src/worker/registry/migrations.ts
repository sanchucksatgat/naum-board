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
  // 2 (태스크2): 반·명단·보드·로그인 시도 제한
  `CREATE TABLE IF NOT EXISTS classes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS students (
     id TEXT PRIMARY KEY,
     class_id TEXT NOT NULL,
     number TEXT NOT NULL,
     name TEXT NOT NULL,
     nickname TEXT NOT NULL DEFAULT '',
     group_name TEXT NOT NULL DEFAULT '',
     pin_salt TEXT NOT NULL,
     pin_hash TEXT,
     initial_pin TEXT,
     pin_version INTEGER NOT NULL DEFAULT 0,
     pin_failed INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (class_id, number)
   );
   CREATE TABLE IF NOT EXISTS boards (
     id TEXT PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     type TEXT NOT NULL,
     column_mode TEXT NOT NULL,
     entry_mode TEXT NOT NULL,
     class_id TEXT,
     locked INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     drive_folder_id TEXT,
     post_count INTEGER NOT NULL DEFAULT 0,
     last_post_at INTEGER,
     recent_json TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX IF NOT EXISTS boards_class ON boards (class_id);
   CREATE TABLE IF NOT EXISTS login_throttle (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   );`,
  // 3: 명단 입장에서 PIN 을 묻는지 (기존 보드는 그대로 PIN 입장)
  `ALTER TABLE boards ADD COLUMN require_pin INTEGER NOT NULL DEFAULT 1;`,
  // 4: 처음 PIN 을 모두 같은 '1234' 로. 아직 나만의 PIN 으로 바꾸지 않은 학생(pin_hash 없음)의 예전 무작위 처음 PIN 을 바꾼다.
  //    예전 데이터에는 무작위로 만든 것과 교사가 CSV 로 적은 것을 구별할 표시가 없어 모두 '1234' 가 된다.
  //    나만의 PIN 을 정한 학생(pin_hash 있음)은 건드리지 않는다. 그런 학생만 토큰이 있었으므로 끊기는 연결도 없다.
  `UPDATE students SET initial_pin = '1234' WHERE pin_hash IS NULL;`,
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
