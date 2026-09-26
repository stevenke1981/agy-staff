---
name: jobs
description: Collect, inspect, cancel, or explicitly continue an existing AGY job in its original workspace; never duplicate an active job.
---
# 作業收集
入口是本檔向上兩層的 `companion/codex-staff.mjs`。
所有指令必須使用啟動作業時的同一 `--workspace`；不要只靠另一專案的同名 job id。

`wait JOB_ID --timeout 100s --workspace "原工作區"` 收集結果。
exit 0：作業成功回覆，仍須 Codex 驗收。exit 2：仍在跑，继续等待同一 job；不要重啟。
exit 3：失敗／崩潰。exit 4：已取消。exit 5：需處理的可續接逾時。exit 1：指令／環境錯誤。
只在使用者問進度或診斷卡住時執行 `observe`，不要頻繁輪詢。
取消：`cancel JOB_ID --workspace "原工作區"`，再用 `status` 核對。
已停止的工作才可 `continue --job JOB_ID --prompt-file "修正任務檔" --workspace "原工作區"`。
遇到同一錯誤先改證據／輸入／程式再續接，最多兩次實質修復；不繞過權限或偷偷换模型。
完成前收集結果與測試證據，不把 job id、部分文字或 background 啟動當成完成。


## 多帳號
在同一 codex-staff 入口使用 `accounts list`；需要設定再讀 `../../docs/ACCOUNTS.zh-TW.md`。
新任務可加 `--account auto|native|ALIAS`，預設只有使用者明確設定才改。
續接固定 `continue --job ID --workspace 原路徑`；不能重設會話或重跑工具來達成切換。
勿讀／要求／提交 Google OAuth token；只顯示別名與必要狀態。
