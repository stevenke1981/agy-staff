---
name: reviewer
description: Ask AGY for a scoped code or design review; return evidence-backed findings to Codex without automatic approval or integration.
---
# 有界審查
入口是本檔向上兩層的 `companion/codex-staff.mjs`；使用真實安裝路徑與 `node`，不拼接 shell 命令。
只委派一次有明確範圍的審查：指定目標 diff／檔案／決策、已知限制及已跑測試。
執行 `review --workspace "工作區" --prompt-file "UTF-8任務檔"`，需要結構化 findings 時加 `--json`。
預設 restricted；它不是作業系統唯讀保證。不要執行 setup，也不要自行放寬任何 allowlist。
只回報可證明問題、file:line、影響、建議與未驗證項；無問題就說無具體發現，不能捏造改善項目。
收集作業使用 jobs 流程。失敗帶文字仍是失敗。Codex 判斷結論，不讓 AGY 的 approve 直接触發 merge。
