---
name: implementer
description: Delegate an explicitly bounded change to AGY in a separate Git worktree, then let Codex test and integrate the result.
---
# 獨立工作區實作
入口是本檔向上兩層的 `companion/codex-staff.mjs`，用真實路徑和 Node 呼叫。
先讀使用者目標與 git status，不得覆蓋既有修改。
執行 `prepare --workspace "來源專案"`，保存回傳的 `workspace` 和 `base_commit`。
來源 dirty 時停止自動工作區建立，由 Codex 直接處理或等使用者整理；不自動 stash／reset／commit。
建立 UTF-8 任務檔，列目標、允許修改的檔案、可跑的測試、禁止事項與驗收條件。
執行 `implement --workspace "回傳workspace" --prompt-file "任務檔"`。預設 restricted。
僅當使用者明確授權本次 worker 工具權限時，才可加 `--allow-worker-tools`；不可把它當成失敗重試手段。
worker 不得 commit／push、改全域設定或生成媒體；worktree 不是 OS 沙箱，外層 Codex 邊界保持有效。
以 jobs 流程收集；用回傳工作區檢查 `git diff`、`git status --short` 和測試。Codex 自己驗收與整合，不直接相信口頭 PASS。
整合後保留工作區直到使用者不再需要；不自動丟棄未提交結果。
