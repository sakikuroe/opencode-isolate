// bun:test は Bun 組み込みのテストフレームワーク。
// describe でテストをグループ化し、test で個々のケースを定義する。
// beforeEach/afterEach は各テストの直前・直後に自動で実行されるフック。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { createWorktree, ensureExclude } from "../lib/git";

// テストごとに使う一時ディレクトリのパスを保持する変数
let tmpDir: string;

// -----------------------------------------------------------------------
// テスト用 git リポジトリの初期化ヘルパー関数。
// 毎回クリーンな状態から始めるため、一時ディレクトリに git init し、
// 最低1つコミットを打っておく（worktree はコミットがないと使えない）。
// -----------------------------------------------------------------------
function initRepo(dir: string) {
  execSync(`git init "${dir}"`, { stdio: "pipe" });
  execSync(`git -C "${dir}" config user.email "test@example.com"`, { stdio: "pipe" });
  execSync(`git -C "${dir}" config user.name "Test"`, { stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync(`git -C "${dir}" add .`, { stdio: "pipe" });
  execSync(`git -C "${dir}" commit -m "initial commit"`, { stdio: "pipe" });
}

// 各テストの前に: /tmp 以下に一意な一時ディレクトリを作り、
// そこに git リポジトリを初期化する。
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-worktree-test-"));
  initRepo(tmpDir);
});

// 各テストの後に: 一時ディレクトリをまるごと削除してクリーンアップ。
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// createWorktree のテスト群
// -----------------------------------------------------------------------
describe("createWorktree", () => {

  // 戻り値のパスが期待通りで、かつそのディレクトリが実際に存在するか確認
  test("creates worktree directory at .worktrees/<branch>", async () => {
    const path = await createWorktree(tmpDir, "feat-123");
    expect(path).toBe(join(tmpDir, ".worktrees", "feat-123"));
    expect(existsSync(path)).toBe(true);
  });

  // `git worktree list` の出力に新しいワークツリーが含まれるか確認
  test("worktree appears in git worktree list", async () => {
    await createWorktree(tmpDir, "feat-123");
    const list = execSync(`git -C "${tmpDir}" worktree list`, { encoding: "utf8" });
    expect(list).toContain(".worktrees/feat-123");
  });

  // .worktrees/ 親ディレクトリが存在しない状態から呼んでも自動作成されるか確認
  test("creates .worktrees parent directory automatically", async () => {
    expect(existsSync(join(tmpDir, ".worktrees"))).toBe(false);
    await createWorktree(tmpDir, "feat-123");
    expect(existsSync(join(tmpDir, ".worktrees"))).toBe(true);
  });

  // 既存ブランチを指定した場合にエラーなく動作するか確認
  // （あらかじめ手動で作ったブランチを createWorktree に渡すケース）
  test("uses existing branch when it already exists", async () => {
    execSync(`git -C "${tmpDir}" branch existing-branch`, { stdio: "pipe" });
    const path = await createWorktree(tmpDir, "existing-branch");
    expect(existsSync(path)).toBe(true);
  });

  // 同じブランチで2回呼んでもエラーにならないことを確認
  test("does not throw when called twice with the same branch", async () => {
    await createWorktree(tmpDir, "feat-123");
    await expect(createWorktree(tmpDir, "feat-123")).resolves.toBeDefined();
  });

  // 2回目の戻り値が1回目と同じパスであることを確認
  test("returns the same path on second call", async () => {
    const first = await createWorktree(tmpDir, "feat-123");
    const second = await createWorktree(tmpDir, "feat-123");
    expect(second).toBe(first);
  });
});

// -----------------------------------------------------------------------
// ensureExclude のテスト群
// -----------------------------------------------------------------------
describe("ensureExclude", () => {

  // 呼び出し後に exclude ファイルへ ".worktrees/" が書かれているか確認
  test("adds .worktrees/ entry to exclude file", () => {
    ensureExclude(tmpDir);
    const content = readFileSync(join(tmpDir, ".git", "info", "exclude"), "utf8");
    expect(content).toContain(".worktrees/");
  });

  // 2回呼んでもエントリが1つしかないことを確認（冪等性の検証）
  test("is idempotent: calling twice does not duplicate the entry", () => {
    ensureExclude(tmpDir);
    ensureExclude(tmpDir);
    const content = readFileSync(join(tmpDir, ".git", "info", "exclude"), "utf8");
    // ".worktrees/" という行が何行あるかを数える
    const count = content.split("\n").filter((line) => line.trim() === ".worktrees/").length;
    expect(count).toBe(1);
  });

  // .git/info/ ディレクトリを意図的に削除した状態で呼んでも壊れないか確認
  test("creates .git/info directory if it does not exist", () => {
    const gitInfoDir = join(tmpDir, ".git", "info");
    rmSync(gitInfoDir, { recursive: true, force: true });
    expect(existsSync(gitInfoDir)).toBe(false);
    ensureExclude(tmpDir);
    expect(existsSync(join(gitInfoDir, "exclude"))).toBe(true);
  });

  // 既存の exclude に別のルールが書いてある場合に、それが消えないことを確認
  test("preserves existing exclude content", () => {
    const excludeFile = join(tmpDir, ".git", "info", "exclude");
    const existing = "# existing rule\n*.log\n";
    writeFileSync(excludeFile, existing, "utf8");
    ensureExclude(tmpDir);
    const content = readFileSync(excludeFile, "utf8");
    expect(content).toContain("*.log");
    expect(content).toContain(".worktrees/");
  });
});
