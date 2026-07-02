import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// -----------------------------------------------------------------------
// createWorktree: git worktree を作成してそのパスを返す
//
// 引数:
//   repoRoot ... git リポジトリのルートディレクトリの絶対パス
//   branch   ... 作成するブランチ名（例: "feat-123"）
// 戻り値:
//   作成されたワークツリーのフルパス（例: "/home/user/repo/.worktrees/feat-123"）
// -----------------------------------------------------------------------
export async function createWorktree(repoRoot: string, branch: string): Promise<string> {
  const worktreesDir = join(repoRoot, ".worktrees");
  const worktreePath = join(worktreesDir, branch);

  // recursive: true は親ディレクトリが既に存在しても静かに成功するので事前チェック不要
  mkdirSync(worktreesDir, { recursive: true });

  // ワークツリーのディレクトリが既に存在する場合は作成をスキップする
  if (existsSync(worktreePath)) {
    // `git worktree list` に登録されているか確認する。
    // 登録済みなら正常なワークツリーなのでそのまま返す。
    // ディレクトリだけ残っていて登録されていない場合は壊れた状態なのでエラーにする。
    const list = execSync(`git -C "${repoRoot}" worktree list`, { encoding: "utf8" });
    if (!list.split("\n").some((line) => line.startsWith(worktreePath)))
      throw new Error(`${worktreePath} exists as a directory but is not registered as a git worktree.`);
    return worktreePath;
  }

  // 指定されたブランチが既にローカルに存在するか調べる
  const branchExists = execSync(`git -C "${repoRoot}" branch --list "${branch}"`, {
    encoding: "utf8",
  }).trim().length > 0;

  // 既存ブランチはそのままチェックアウト、新規ブランチは -b で作りながら作成
  execSync(
    branchExists
      ? `git -C "${repoRoot}" worktree add "${worktreePath}" "${branch}"`
      : `git -C "${repoRoot}" worktree add -b "${branch}" "${worktreePath}"`,
    { encoding: "utf8" }
  );

  return worktreePath;
}

// -----------------------------------------------------------------------
// ensureExclude: .git/info/exclude に ".worktrees/" を追記する
//
// .gitignore はチームで共有されるが、exclude はローカル専用の無視リスト。
// ワークツリー用ディレクトリを git の追跡対象から外しつつ、
// チームの .gitignore を汚さないためにこちらに書く。
//
// 何度呼んでも結果が同じになるよう（冪等に）設計している。
// -----------------------------------------------------------------------
export function ensureExclude(repoRoot: string): void {
  const gitInfoDir = join(repoRoot, ".git", "info");
  const excludeFile = join(gitInfoDir, "exclude");
  const entry = ".worktrees/";

  mkdirSync(gitInfoDir, { recursive: true });

  // ファイルが存在しない場合は空文字列として扱う
  let content: string;
  try {
    content = readFileSync(excludeFile, "utf8");
  } catch {
    content = "";
  }

  // ".worktrees/" が既に書かれていれば何もしない（重複防止）
  if (content.split("\n").some((line) => line.trim() === entry)) {
    return;
  }

  // 末尾が改行で終わっていなければ改行を挟んでから追記する
  const newContent = content + (content && !content.endsWith("\n") ? "\n" : "") + entry + "\n";
  writeFileSync(excludeFile, newContent, "utf8");
}
