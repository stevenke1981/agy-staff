# 多 Google Antigravity 帳號｜Codex／Windows

版本：**0.7.3-codex.3**（含 codex.2 帳號路由）· 2026-09-26

程式、離線測試與升級工具已交付。**真實 Windows 11／AGY CLI／Google OAuth／CLIProxyAPI 組合尚未驗證，不應視為已完成生產驗收。** 首次設定腳本會在您的 Windows 上做真實帳號 smoke；失敗不會新啟用 auto。

## 這次切換的是什麼

切換 AGY 工作者的**模型請求使用帳號**，不是替 Antigravity IDE 按「登出／登入」，也不改 Codex 的登入或主模型。

```text
Codex 主 Agent（任務、執行授權與驗收）
  └─ agy-staff 原有 job / wait / cancel / continue
       └─ 每個工作自己的 account-worker + API-mode runtime HOME
            └─ 原生 AGY CLI（仍是原來的工具執行者）
                 └─ 127.0.0.1:隨機埠 Gemini API gateway
                      ├─ Google 帳號 A 的 CLIProxyAPI（私有憑證目錄）
                      └─ Google 帳號 B 的 CLIProxyAPI（私有憑證目錄）
```

參考 `aadishv/pi-agy` 的 OAuth + CLIProxyAPI 架構；該參考版本使用單一 `~/.pi-agy/credentials.json`，不是現成的多帳號池。本版重新實作帳號註冊、隔離、選擇、冷卻、租約與 Codex 適配，沒有複製其硬編碼 OAuth client secret，也不修改 Pi 的 models.json。

## 第一次設定

需要 Node.js 22+、Git、已安裝的原生 AGY CLI，以及可信任的 CLIProxyAPI。離線路由測試已在原生 Windows 執行；PowerShell 設定腳本已通過語法檢查，但下載、登入與真實推論尚未執行。詳見 [驗證紀錄](https://github.com/stevenke1981/agy-staff/blob/codex/windows-native/docs/CODEX-VALIDATION.md)。

在 `.2` 補丁包資料夾中，既有 `.1` 專案先執行：

```powershell
.\Upgrade-Local.ps1 -Repository "$HOME\source\agy-staff" -InstallSkill
```

升級器先驗證所有舊版受管理檔案的雜湊，遇到個人修改或新檔衝突即停止。它不 stash/reset、不推送、不覆蓋憑證。測試失敗後保留本機改造檔案供除錯，不會安裝 Skill 或發布。尚未套用 `.1` 的新安裝則使用本包 `Fork-And-Apply.ps1`；不可直接對上游原版執行 upgrade。

再執行：

```powershell
.\Setup-Accounts.ps1 -Repository "$HOME\source\agy-staff" -Accounts google-1,google-2
```

脚本的動作：下載固定 `CLIProxyAPI v7.3.17` 的 Windows x64 發行檔、驗證 GitHub release 提供的 SHA256、建立本機帳號池、依序讓您完成各帳號的 Google 瀏覽器授權，再對**每個指定帳號**各做一次 `ACCOUNT_OK` 實際推論；全部成功才 `accounts use auto`。首次各帳號仍需要人為選帳號／完成登入，不會繞過 Google 登入或雙重驗證。

已經安裝 CLIProxyAPI 可指定，避免下载：

```powershell
.\Setup-Accounts.ps1 -Repository "$HOME\source\agy-staff" `
  -ProxyBin 'C:\Tools\CLIProxyAPI\cli-proxy-api.exe' -Accounts google-1,google-2
```

已註冊的別名再次 login 是重新授權；選到不同 Google 身分會拒絕並保留原登入。新帳號請用新別名。真實 smoke 的模型可用 `-Model '本機 AGY 與代理均支援的模型 ID'` 指定；不接受自動換成便宜／昂貴／另一家模型。若 AGY 預設型號不在 proxy 的模型列表中，先用下面 `accounts models` 查核。發行檔雜湊檢查是完整性校驗，不是發布者數位簽章。

## 命令列

下列命令在已套用的 repository 執行。也可以使用安裝後 `$HOME\.agents\skills\agy-codex\runtime\companion\codex-staff.mjs` 的完整路徑，其他參數相同。

```powershell
$staff = '.\companion\codex-staff.mjs'
# 手動設定（未使用 Setup-Accounts.ps1 才需要 init/login）
node $staff accounts init --proxy-bin 'C:\Tools\CLIProxyAPI\cli-proxy-api.exe'
node $staff accounts login google-1
node $staff accounts login google-2
node $staff accounts list
node $staff accounts models google-1

# 預設保持原生登入；明確執行此命令才啟用帳號池
node $staff accounts use auto
node $staff accounts strategy sticky

# 單次覆寫，不改全域預設
node $staff ask --account auto --prompt '只回答 OK'
node $staff review --account google-2 --workspace 'C:\Projects\MyApp' --prompt '審查目前修改'
node $staff accounts disable google-1
node $staff accounts enable google-1

# 回到原本原生 AGY 登入，不移除或撤銷 Google 憑證
node $staff accounts use native
```

可選 `accounts strategy round-robin`，每次推論請求優先選最後使用時間最早的可用帳號；`sticky` 盡量維持目前可用帳號，減少不必要的切換。每個 profile 在**本工作仍使用它時**有獨占 lease，不會讓兩個工作同時刷新同一份 OAuth token；獨立工作可選其他空閒帳號。

指定 `--account google-2` 就只用該帳號，不會失敗後偷換另一個。`--account native` 只影響本次新任務。`status/wait/cancel` 不需要 `--account`，仍然使用原工作區和 job id。

## 匯入 pi-agy 登入

只在您明確執行下列命令時讀取來源，不會掃描、蒐集瀏覽器 cookie 或其他程式的帳號：

```powershell
node $staff accounts import google-1 --file "$HOME\.pi-agy\credentials.json"
```

驗證 `type=antigravity`、refresh token、email，僅複製必要欄位，不搬移／刪除來源。相同 Google email 的大小寫變體也視為同帳號，禁止重複註冊以虛增池容量。不要把 credential JSON、refresh token 或 access token 貼到 ChatGPT、Codex 訊息或 GitHub。

## 自動切換規則

| 狀況 | 本版行為 |
|---|---|
| 可用帳號正常 | `sticky` 沿用，或 round-robin 選擇 |
| HTTP 429 | 該模型冷卻，尊重 Retry-After；沒有標頭預設 60 秒；回覆內容開始前才試下一個可用帳號 |
| HTTP 401 | 標記 needs_login，再試其他已授權帳號；OAuth 自動 refresh 由 CLIProxyAPI 處理 |
| HTTP 502／503／504 | 全模型暫時冷卻，再試下一個可用帳號 |
| HTTP 403 | 標記 blocked，**本工作停止路由**，不利用同工作再次請求繼續換帳號；需處理權限／重新授權 |
| HTTP 400／404／不支援模型 | 保留錯誤，不換帳號掩蓋設定問題、不偷偷改模型 |
| 串流已開始或連線中斷 | 不重送已開始的推論、不自動重跑工作／工具 |
| 全部冷卻、需要登入或占用中 | 有界失敗，回傳狀態和可能的 Retry-After，不無限空轉 |

每個請求最多嘗試 3 個不同帳號（registry 的 `maxAttempts` 可設 1–5）。這是本路由層的上限；原生 AGY 可能另有內建 API 重試，整體仍受原有 job timeout 約束。切換重送的是同一份推論請求，不是重播已完成的改檔／commit／shell 工具。CLIProxyAPI 額外 retry rounds、preview-model 備援、project 備援及 Antigravity credits 備援均顯式關閉。

冷卻狀態持久化；disable/enable 或正常重啟不清掉冷卻。OAuth 失效須重新 login；不因授權失效自動刪除其他帳號憑證。

## 續接與取消

`continue --job ID --workspace 原工作區` 讀取原 job 的 `codex_account` 與 `codex_account_session`。即使預設從 auto 改成 native，既有工作仍用原路由及原 runtime HOME 保留會話。禁止在同一 continuation 強制改成另一種路由；需要改用 native 或另一個固定別名時，建立新的明確任務。`auto` 會話內帳號仍可在符合上述條件時切換，但 runtime 及原生 AGY conversation 保留。

AGY worker、gateway、CLIProxyAPI 是有父子關係的程序；正常取消依本工作持有的 ChildProcess 精確清理，不廣域 `taskkill /IM`。原有 upstream PID/creation-time 取消機制保留。異常關閉後，只在原 lease PID 明確不存在時回收鎖；PID 重用、權限不明或無法判斷不強制回收。

## 憑證與本機資料

預設資料位置：`%LOCALAPPDATA%\agy-staff\accounts`。可用 `AGY_STAFF_ACCOUNTS_DIR` 指定其他私有位置；**不要放進 repository、共享或同步資料夾**。

- `registry.json`：別名、Google 身分的 SHA256、選擇規則、冷卻狀態；無 token。SHA256 是去重識別，不是匿名化保證。
- `profiles/<alias>/auth/`：CLIProxyAPI 所管理的 OAuth 憑證。
- `runtime-homes/<session UUID>/`：AGY 的 API-mode 設定與會話；為了明確續接而保留，可能含工作內容，請妥善保護。
- `runs/`：工作期間的臨時代理設定；正常結束清除。異常終止可能留下只對已失效本機服務有效的 key。

Windows 初始帳號根資料夾以 ACL 限制目前使用者和 SYSTEM；POSIX 使用 0700/0600。**本版不是 DPAPI 加密保管庫**；CLIProxyAPI 憑證本身仍是明文 JSON，具有該使用者或管理員權限的程式可能讀取。不要將帳號目錄提交或公開。

每個 gateway 只監聽 127.0.0.1 的隨機埠、使用隨機本機 key、拒絕 browser Origin 與非 Gemini 路徑。代理 management API 與面板關閉；不把完整 proxy log 或 OAuth token 寫進 job。正常背景工作不另開終端視窗；首次授權的設定腳本仍需互動。

原生 AGY OAuth 使用作業系統 keyring，**不能只改 HOME 就宣稱帳號隔離**。本版改用官方 `modelProvider=gemini` + `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL`，再讓私有 proxy 使用您授權的 Google 帳號；傳給 AGY 的 key 是隨機本機 gateway key，不是 Google API key。只有本 gateway 完成推論，worker 才接受 AGY 的 SUCCESS，避免忽略 API-mode 設定卻用到原生帳號時假裝成功。

## 必須在您的 Windows 上驗收

離線假服務不能證明 Google 授權與模型相容性。至少確認：兩個不同帳號各自 smoke 成功、真實 AGY 工具呼叫、相同模型可供各帳號使用、API-mode 的工具批准設定、Codex Desktop 載入、取消後無殘留程序，以及 wait/continue 能保留会話。隔離的 HOME 不會複製原來的全域 Git／AGY 設定，相關命令可能需要在專案層設定。

若請求帶有原帳號專屬 cache ID 或 thought signature，另一個帳號可能拒絕它；本版不偽造／移除簽章、不在錯誤後重播工具。此跨帳號相容性仍需實機測試。帳號使用須符合您的授權與服務適用規則；本功能不是規避停權或權限限制的機制。

## 查核來源

- 參考專案（釘選）：https://github.com/aadishv/pi-agy/tree/32c1fa661b4d6cf8d37c7cc791d936da0ad426b4
- 單檔 OAuth storage：https://github.com/aadishv/pi-agy/blob/32c1fa661b4d6cf8d37c7cc791d936da0ad426b4/src/oauth.ts
- 原生 keyring / API-mode：https://antigravity.google/docs/cli/install
- 原生 stream-json stdin：https://antigravity.google/docs/cli/headless
- CLIProxyAPI 釘選設定：https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.17/config.example.yaml
- CLIProxyAPI 釘選發行：https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.17

本包不含 CLIProxyAPI 二進位，也不含 Google／個人憑證；參考專案未整段複製，原 agy-staff MIT LICENSE 保留。
