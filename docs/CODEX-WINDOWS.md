# Codex／Windows 操作與驗收

## 入口

在 clone 內使用 `node .\companion\codex-staff.mjs`。
以使用者 Skill 安裝後，入口是 `$HOME\.agents\skills\agy-codex\runtime\companion\codex-staff.mjs`。
官方 AGY Windows native 安裝位置通常為 `%LOCALAPPDATA%\agy\bin\agy.exe`；不在 PATH 時會先檢查此位置。
可用 `AGY_BIN` 指定實際 executable。拒絕 `.cmd`／`.bat`／`.ps1` wrapper，不透過 shell 插入 prompt。
`AGY_STAFF_MODEL` 只指定 AGY 工作者模型，不會切換主 Agent 的 GPT 模型；值須由實際 `agy models` 確認。

```powershell
$Cli = Join-Path $HOME '.agents\skills\agy-codex\runtime\companion\codex-staff.mjs'
& node $Cli doctor --workspace 'D:\Projects\YourProject'
```

doctor 的成功不包含登入狀態、配額或模型可用性。需要認證時在主機依 AGY 官方流程登入；不要把 token 貼給 Agent。
若 Codex 沙箱不允許必要檔案／localhost，請由使用者決定是否針對本次工具授權；不自動設定 Full access。

## 研究／審查

以 UTF-8 檔案輸入，避免 Windows PowerShell 5.1 的管線編碼差異：

```powershell
$PromptPath = Join-Path $env:TEMP 'agy-review-task.txt'
[IO.File]::WriteAllText($PromptPath, '檢查指定檔案，回報可證明問題與未驗證項。', [Text.UTF8Encoding]::new($false))
& node $Cli review --workspace 'D:\Projects\YourProject' --prompt-file $PromptPath
```

回傳 job id 後，用同一工作區 `wait JOB_ID --timeout 100s --workspace '...'`。
不要同一個問題同時開三個評審；沒有具體變更時，不重跑同一審查。
research／review 的受限權限仍受本機 AGY 現有 allowlist 影響，不構成唯讀隔離。有需要時也可在 prepare 建立的工作區進行。

## 實作

```powershell
$PreparedJson = & node $Cli prepare --workspace 'D:\Projects\YourProject'
if ($LASTEXITCODE -ne 0) { throw 'Worktree preparation failed' }
$Work = ($PreparedJson | ConvertFrom-Json).workspace
& node $Cli implement --workspace $Work --prompt-file $PromptPath
```

prepare 只從乾淨 HEAD 建立新的 detached worktree，不搬移尚未提交的修改、未追蹤檔案或 ignored credentials。
來源 dirty 不等於要使用者放棄成果；改由主 Agent 在原工作區完成，或由使用者先選定基底。
worker 不得自行提交或推送。依使用者對該次工作的明確授權，implement／staffer 可加 `--allow-worker-tools`，
這會允許該次 AGY 不受其內層工具批准限制，**不是**移除 Codex 外層沙箱，也不是解決所有 EPERM 的辦法。
不要用此旗標解決錯誤、429、登入失效或模型不可用。

`git diff` 不包含未追蹤新檔，所以 Codex 收尾還必須檢查 `git status --short`、讀取新檔及實際跑測試。
worktree 共用 Git metadata；禁止將它描述為 OS 安全沙箱。
整合需主 Agent 明確執行，不會自動 cherry-pick、apply patch、commit、push 或刪除 worktree。

## 作業狀態與重試

| Exit code | 含意 |
|---|---|
| 0 | 有成功作業結果；仍須主 Agent 驗收 |
| 1 | 指令／參數／環境錯誤 |
| 2 | 還在執行；wait 自己逾時不會停掉 worker |
| 3 | 作業失敗／崩潰，包括有部分文字的 AGY ERROR |
| 4 | 已取消 |
| 5 | 可續接的逾時／需處理狀態 |

`status`／`wait`／`observe`／`result`／`cancel` 一律帶同一 workspace。
僅在作業停止後使用 `continue --job JOB_ID --prompt-file FILE --workspace ORIGINAL`。
新入口不暴露 blind restart，也不採用不具名的「上一個對話」。
每次 `continue --job` 都重新帶上 Codex 主控規則，並保留原 conversation 和 parent job 關係。
Codex 前景及背景入口只接受單一有效 result；重複結果、格式錯誤或缺少結果會失敗。
背景原始串流仍保留在 job 的 `.events.jsonl`，可用於診斷；不会因此自動重送請求。
每次修復都需改動根因／輸入／測試，最多兩次有意義重試；這是主 Agent 工作規則，不是已實作的全自動重試排程器。
不自動重跑整個工作、切模型、提權或重建job；已明確啟用的coding帳號池僅依ACCOUNTS規則處理尚未交付的推理請求。

## 測試與明確限制

`node scripts/test-codex.mjs` 執行新模組測試與真實 patched companion + fake AGY 整合。
`node scripts/test-codex.mjs --legacy` 執行既有回歸。原 Pi manifest assertion 被修改為明確區分 Codex fork 的名字／版號，而不是刪除檢查。
測試不使用真實 AGY 登入或配額；CI 也不配置任何真實憑證。
整合測試另外安裝到臨時使用者目錄，直接執行安裝後的前景及背景入口。
安裝器要求六個 runtime 檔案都有有效 SHA-256；缺少或不符合時保留現有安裝並停止更新。

尚待實機驗收：Windows 11 中文帳號路徑、桌面版首次載入、沙箱／登入可用性、真實 stream-json schema、
长工作取消的所有子程序、桌面版重新開啟後的 job 續接。
原 Windows CIM 程序掃描和 PID birth identity 保護保留；未貿然改成 taskkill /T。

## 來源

- 上游釘選： https://github.com/keli-wen/agy-staff/tree/f00d14925c2bf63caa5d7cb3488f0e53f5716b13
- Codex Skills： https://developers.openai.com/codex/skills/
- Codex Windows： https://developers.openai.com/codex/windows/
- AGY 官方 stdin stream-json： https://antigravity.google/docs/cli/headless
- AGY Windows 安裝： https://antigravity.google/docs/cli/install

核對日期：2026-09-25。以目前安裝版 help 和實測結果為準，不把來源文件視為本機已驗證。


## 多帳號（codex.2）

完整指令與資料保護見 [ACCOUNTS.zh-TW.md](ACCOUNTS.zh-TW.md)。切換模型帳號不修改 Codex 登入或全域設定；原先的權限、worktree 和 jobs 合約不變。

## 圖片／影片／音樂（codex.3）

詳見 [MEDIA.zh-TW.md](MEDIA.zh-TW.md)。媒體命令有獨立state／exit合約；不經coding staffer／worktree，不使用coding帳號池。先安裝FFmpeg/ffprobe，再執行新增測試；`media doctor`不消耗生成功能額度。
