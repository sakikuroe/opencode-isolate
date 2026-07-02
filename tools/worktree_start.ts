import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { createWorktree, ensureExclude } from "../lib/git";
import {
  getDbPath,
  resolveProjectId,
  ensureProject,
  updateSessionDirectory,
} from "../lib/session";

export default tool({
  description:
    "Create a git worktree for an issue and switch the current session's working directory to it. Use this when the user wants to start working on an issue or task in an isolated branch.",
  args: {
    branch: tool.schema.string().describe("Branch name for the worktree, e.g. '123-fix-login-bug'"),
  },
  async execute(args, context) {
    const repoRoot = context.directory;
    const { branch } = args;

    // 1. git worktree を作成する
    let worktreePath: string;
    try {
      worktreePath = await createWorktree(repoRoot, branch);
    } catch (err) {
      return `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 2. .git/info/exclude に .worktrees/ を追記する
    ensureExclude(repoRoot);

    // 3. ワークツリーのプロジェクト ID を取得する
    const projectId = resolveProjectId(worktreePath);

    // 4. OpenCode の SQLite DB を開く
    let db: Database;
    try {
      db = new Database(getDbPath());
    } catch (err) {
      return `Worktree created at ${worktreePath}, but failed to open DB: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      // 5. project テーブルに行がなければ作成する
      ensureProject(db, projectId, worktreePath);

      // 6. セッションの作業ディレクトリを切り替える
      const updated = updateSessionDirectory(db, context.sessionID, worktreePath, projectId);
      if (updated === 0) {
        return `Worktree created at ${worktreePath}, but session was not updated (session not found).`;
      }
    } catch (err) {
      return `Worktree created at ${worktreePath}, but failed to update session: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      db.close();
    }

    return `Worktree created and session switched.\nBranch: ${branch}\nPath: ${worktreePath}`;
  },
});
