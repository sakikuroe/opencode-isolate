import { Database } from "bun:sqlite";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// -----------------------------------------------------------------------
// getDbPath: OpenCode の SQLite DB ファイルパスを解決する
//
// 優先順位:
//   1. OPENCODE_DB 環境変数（:memory: や絶対パスに対応）
//   2. OPENCODE_CHANNEL に応じてファイル名が変わる
//      - latest / beta / prod / 未設定 → opencode.db
//      - それ以外（例: nightly） → opencode-nightly.db
//   3. ベースディレクトリは XDG_DATA_HOME または ~/.local/share
// -----------------------------------------------------------------------
export function getDbPath(): string {
  const dbOverride = process.env.OPENCODE_DB;
  if (dbOverride) return dbOverride;

  const dataDir = resolve(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode"
  );

  const channel = process.env.OPENCODE_CHANNEL ?? "latest";
  const dbName = ["latest", "beta", "prod"].includes(channel) ? "opencode.db" : `opencode-${channel}.db`;
  return resolve(dataDir, dbName);
}

// -----------------------------------------------------------------------
// getSessionInfo: セッションの現在の directory と project_id を取得する
//
// 戻り値: 見つかれば { directory, projectId }、見つからなければ null
// -----------------------------------------------------------------------
export function getSessionInfo(
  db: Database,
  sessionId: string
): { directory: string; projectId: string } | null {
  const row = db
    .query("SELECT directory, project_id FROM session WHERE id = ?")
    .get(sessionId) as { directory: string; project_id: string } | null;

  return row ? { directory: row.directory, projectId: row.project_id } : null;
}

// permission フィールドに格納される個々のルールの型
interface PermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

// -----------------------------------------------------------------------
// updateSessionDirectory: セッションの作業ディレクトリを切り替える
//
// - directory を newDir に更新する
// - project_id を newProjectId に更新する
// - permission の JSON 配列に external_directory ルールを追加する
//   （同じルールが既にあれば追加しない）
// - 戻り値は更新した行数（セッションが存在しない場合は 0）
// -----------------------------------------------------------------------
export function updateSessionDirectory(
  db: Database,
  sessionId: string,
  newDir: string,
  newProjectId: string
): number {
  const row = db
    .query("SELECT permission FROM session WHERE id = ?")
    .get(sessionId) as { permission: string | null } | null;

  if (!row) return 0;

  const rules: PermissionRule[] = row.permission ? JSON.parse(row.permission) : [];
  const newRule: PermissionRule = {
    permission: "external_directory",
    pattern: `${newDir}/*`,
    action: "allow",
  };

  // 同じルールがなければ追加する（冪等にするための重複チェック）
  if (!rules.some((r) => r.permission === newRule.permission && r.pattern === newRule.pattern)) {
    rules.push(newRule);
  }

  const result = db
    .query(
      "UPDATE session SET directory = ?, project_id = ?, permission = ?, time_updated = ? WHERE id = ?"
    )
    .run(newDir, newProjectId, JSON.stringify(rules), Date.now(), sessionId);

  return result.changes;
}

// -----------------------------------------------------------------------
// ensureProject: project テーブルに行がなければ作成する
//
// INSERT OR IGNORE で存在確認と挿入を1つのクエリにまとめている（冪等）。
// -----------------------------------------------------------------------
export function ensureProject(
  db: Database,
  projectId: string,
  worktree: string
): void {
  const now = Date.now();
  db.query(
    "INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)"
  ).run(projectId, worktree, now, now, "[]");
}

// -----------------------------------------------------------------------
// resolveProjectId: ディレクトリから OpenCode のプロジェクト ID を解決する
//
// 解決順序:
//   1. <dir>/.git/opencode ファイルがあればその内容を使う
//   2. git の初期コミットハッシュを取得して使う
//   3. git リポジトリでなければ "global" を返す
// -----------------------------------------------------------------------
export function resolveProjectId(dir: string): string {
  const gitDir = join(dir, ".git");

  // キャッシュファイルが読めればそれを使う（存在しない場合は catch で素通り）
  try {
    const cached = readFileSync(join(gitDir, "opencode"), "utf8").trim();
    if (cached) return cached;
  } catch {}

  // git コマンドで初期コミットハッシュを取得する
  try {
    const id = execFileSync("git", ["rev-list", "--max-parents=0", "--all"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (id) return id;
  } catch {}

  return "global";
}
