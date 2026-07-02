import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  getDbPath,
  getSessionInfo,
  updateSessionDirectory,
  ensureProject,
  resolveProjectId,
} from "../lib/session";

// -----------------------------------------------------------------------
// テスト用 DB のセットアップヘルパー
// -----------------------------------------------------------------------

function createSchema(db: Database) {
  db.run(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      sandboxes TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      slug TEXT NOT NULL,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);
}

function insertProject(db: Database, id: string, worktree: string) {
  db.query(
    "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)"
  ).run(id, worktree, Date.now(), Date.now(), "[]");
}

function insertSession(
  db: Database,
  id: string,
  directory: string,
  projectId: string,
  permission: string | null = null
) {
  db.query(
    "INSERT INTO session (id, project_id, directory, title, version, slug, permission, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, projectId, directory, "Test", "1.0", "test", permission, Date.now(), Date.now());
}

// -----------------------------------------------------------------------
// 一時ディレクトリ管理（resolveProjectId の git テスト用）
// -----------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(homedir(), "tmp-opencode-session-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// getDbPath のテスト
// -----------------------------------------------------------------------
describe("getDbPath", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      OPENCODE_DB: process.env.OPENCODE_DB,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL,
    };
    delete process.env.OPENCODE_DB;
    delete process.env.XDG_DATA_HOME;
    delete process.env.OPENCODE_CHANNEL;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key as string];
      else process.env[key as string] = val;
    }
  });

  test("環境変数なしでデフォルトパスが返ること", () => {
    expect(getDbPath()).toContain(".local/share/opencode/opencode.db");
  });

  test("OPENCODE_DB=:memory: のときそのまま返ること", () => {
    process.env.OPENCODE_DB = ":memory:";
    expect(getDbPath()).toBe(":memory:");
  });

  test("XDG_DATA_HOME が設定されているときそのディレクトリを使うこと", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    expect(getDbPath()).toContain("/custom/data/opencode/opencode.db");
  });
});

// -----------------------------------------------------------------------
// getSessionInfo のテスト
// -----------------------------------------------------------------------
describe("getSessionInfo", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); createSchema(db); });
  afterEach(() => { db.close(); });

  test("存在するセッション ID で directory と projectId が取れること", () => {
    insertProject(db, "proj-1", "/repo");
    insertSession(db, "sess-1", "/repo", "proj-1");

    const info = getSessionInfo(db, "sess-1");
    expect(info).not.toBeNull();
    expect(info!.directory).toBe("/repo");
    expect(info!.projectId).toBe("proj-1");
  });

  test("存在しないセッション ID で null が返ること", () => {
    expect(getSessionInfo(db, "nonexistent")).toBeNull();
  });
});

// -----------------------------------------------------------------------
// updateSessionDirectory のテスト
// -----------------------------------------------------------------------
describe("updateSessionDirectory", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); createSchema(db); });
  afterEach(() => { db.close(); });

  test("directory が新しい値に更新されること", () => {
    insertProject(db, "proj-1", "/repo");
    insertProject(db, "proj-2", "/repo/.worktrees/feat-123");
    insertSession(db, "sess-1", "/repo", "proj-1");

    updateSessionDirectory(db, "sess-1", "/repo/.worktrees/feat-123", "proj-2");

    expect(getSessionInfo(db, "sess-1")!.directory).toBe("/repo/.worktrees/feat-123");
  });

  test("permission に external_directory ルールが追加されること", () => {
    insertProject(db, "proj-1", "/repo");
    insertProject(db, "proj-2", "/repo/.worktrees/feat-123");
    insertSession(db, "sess-1", "/repo", "proj-1");

    updateSessionDirectory(db, "sess-1", "/repo/.worktrees/feat-123", "proj-2");

    const row = db.query("SELECT permission FROM session WHERE id = ?").get("sess-1") as {
      permission: string;
    };
    expect(JSON.parse(row.permission)).toContainEqual({
      permission: "external_directory",
      pattern: "/repo/.worktrees/feat-123/*",
      action: "allow",
    });
  });

  test("2回呼んでも permission ルールが重複しないこと（冪等性）", () => {
    insertProject(db, "proj-1", "/repo");
    insertProject(db, "proj-2", "/repo/.worktrees/feat-123");
    insertSession(db, "sess-1", "/repo", "proj-1");

    updateSessionDirectory(db, "sess-1", "/repo/.worktrees/feat-123", "proj-2");
    updateSessionDirectory(db, "sess-1", "/repo/.worktrees/feat-123", "proj-2");

    const row = db.query("SELECT permission FROM session WHERE id = ?").get("sess-1") as {
      permission: string;
    };
    const count = JSON.parse(row.permission).filter(
      (r: any) => r.permission === "external_directory" && r.pattern === "/repo/.worktrees/feat-123/*"
    ).length;
    expect(count).toBe(1);
  });

  test("存在しないセッション ID で 0 が返ること", () => {
    expect(updateSessionDirectory(db, "nonexistent", "/new/dir", "proj-1")).toBe(0);
  });
});

// -----------------------------------------------------------------------
// ensureProject のテスト
// -----------------------------------------------------------------------
describe("ensureProject", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); createSchema(db); });
  afterEach(() => { db.close(); });

  test("新規プロジェクトが作成されること", () => {
    ensureProject(db, "new-proj", "/repo/.worktrees/feat-123");

    const row = db
      .query("SELECT id, worktree FROM project WHERE id = ?")
      .get("new-proj") as { id: string; worktree: string };
    expect(row).not.toBeNull();
    expect(row.worktree).toBe("/repo/.worktrees/feat-123");
  });

  test("既に存在する場合に上書きされないこと", () => {
    insertProject(db, "proj-1", "/original/path");

    ensureProject(db, "proj-1", "/new/path");

    const row = db
      .query("SELECT worktree FROM project WHERE id = ?")
      .get("proj-1") as { worktree: string };
    expect(row.worktree).toBe("/original/path");
  });
});

// -----------------------------------------------------------------------
// resolveProjectId のテスト
// -----------------------------------------------------------------------
describe("resolveProjectId", () => {
  test("git リポジトリで初期コミットハッシュが返ること", () => {
    execSync(`git init "${tmpDir}"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" config user.email "test@example.com"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" config user.name "Test"`, { stdio: "pipe" });
    writeFileSync(join(tmpDir, "README.md"), "# test\n");
    execSync(`git -C "${tmpDir}" add .`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" commit -m "initial commit"`, { stdio: "pipe" });

    expect(resolveProjectId(tmpDir)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("git リポジトリでない場合に 'global' が返ること", () => {
    expect(resolveProjectId(tmpDir)).toBe("global");
  });
});
