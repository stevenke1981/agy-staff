---
name: lead
description: Delegate a bounded research or second-opinion task to AGY while Codex retains execution, integration, and verification. Use only when the user requests AGY collaboration.
---
# Codex 主控，AGY 協作
從本 SKILL.md 的真實位置向上兩層取得 plugin root。入口為該 root 下 `companion/codex-staff.mjs`。
不要猜快取路徑，不用 `${CLAUDE_PLUGIN_ROOT}`。以 PowerShell 的 `& node "完整入口路徑" ...` 執行。

小任務由 Codex 直接完成；只委派一個清楚且有驗收条件的研究／第二意見。預設一個 worker，不遞迴委派。
先 `doctor --workspace "專案路徑"`；它不驗證登入或可用模型。有環境故障先修正一次，不改全域設定或批准政策。
將目的、相關證據、未知項、禁止修改的檔案和驗收條件寫成 UTF-8 任務檔，避免整份 repo 塞入提示。
用 `research --workspace "專案路徑" --prompt-file "任務檔"`。需要改檔時改用 implementer 流程，不以 staffer 避開 worktree。
取得 job id 後照 jobs 流程收集。Codex 核對證據，再自己整合。沒有 AGY 結果時不空等、不宣稱完成。
不得為了錯誤自動加入 `--allow-worker-tools`。不要用 worker 產圖、影片、音訊、提交或部署。
以繁中簡短回報實際結果與未驗證事項，避免例行多輪審查。
