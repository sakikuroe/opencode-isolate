// npm プラグインとしてのエントリーポイント。
// OpenCode は opencode.json の plugin 配列に書かれたパッケージを読み込み、
// エクスポートされた Plugin 関数を呼んでツールを登録する。
import type { Plugin } from "@opencode-ai/plugin";
import worktreeStart from "./tools/worktree_start";

export const IsolatePlugin: Plugin = async () => {
  return {
    tool: {
      worktree_start: worktreeStart,
    },
  };
};
