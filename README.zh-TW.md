# AGY Staff for Codex

`0.7.3-codex.1`：Codex／Codex 桌面版 Windows 優先適配。

保留 `keli-wen/agy-staff` 的 MIT 授權、工作狀態、取消與續接；新增專用入口，而非重新寫一套 Agent。
流程為 **Codex 判斷與拆解 → 有界 AGY 工作者 → Codex 驗證、整合與交付**。
小任務 Codex 直接做，避免無收益的委派或多輪審查。Astra／Sol／Luna 由主機選擇，不硬寫不確定的模型 ID。

## Windows 使用者 Skill 安裝

需要 Node.js 22 以上、Git，並另外安裝／登入原生 AGY CLI。
在本 repository 執行：

```powershell
node .\scripts\test-codex.mjs
node .\scripts\install-codex-skill.mjs
```

已有此適配版本要更新：`node .\scripts\install-codex-skill.mjs --update`。
舊版會先移至 `.agents/agy-staff-codex-backups`；不改動 Codex 全域設定、其他 Skills 或登入資料。
重新建立 Codex 對話，使用 `$agy-codex`。

也保留 `.codex-plugin/plugin.json` 與 `.agents/plugins/marketplace.json` 的原生 plugin 安裝方式；
此 fork 的 plugin 名稱是 `agy-codex`，marketplace 名稱是 `agy-staff-codex`。
使用當前 Codex 的 plugin 管理介面安裝自己的 fork，不要沿用上游文件的 `agy@agy-staff`。
兩種安裝方式擇一，避免重複。

## 主要差异

長提示經官方 stream-json stdin 傳遞；不是先讀 prompt-file 後又全部塞回 Windows 命令列。
實作／staffer 使用獨立 Git worktree，dirty 來源不自動 stash 或清除。
restricted 預設、明確 job 續接、錯誤帶部分輸出仍記為錯誤。
環境缺失與權限拒絕不自動提權，媒體生成不交给 AGY 原生工具。

完整操作見 [docs/CODEX-WINDOWS.md](docs/CODEX-WINDOWS.md)，開發規則見 [AGENTS.md](AGENTS.md)。
新增測試：`node scripts/test-codex.mjs`；原回歸：`node scripts/test-codex.mjs --legacy`。
CI 定義不等於已通過；Windows 實測與 AGY 登入／實際模型測試以各次執行結果為準。

本 fork 基於上游 commit `f00d14925c2bf63caa5d7cb3488f0e53f5716b13`。
