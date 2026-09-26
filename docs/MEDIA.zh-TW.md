# 圖片・影片・音樂｜AGY Staff for Codex

**0.7.3-codex.3 · Windows 11／Codex Desktop 優先。**

本版新增可執行的媒體提交、狀態追蹤、恢復、下載、實檔驗證與命名流程。離線整合測試已在原生 Windows 執行，包含真正的子程序、FFmpeg 解碼及產物驗證；**真實 AGY 生圖、登入網站生圖／影片／音樂仍未驗收**。Bridge 的頁面選取器亦須以實際帳號介面核對。沒有在本次交付中消耗 Google 或其他模型額度。詳見 [驗證紀錄](https://github.com/stevenke1981/agy-staff/blob/codex/windows-native/docs/CODEX-VALIDATION.md)。

## 路由與邊界

| 命令 | 預設 provider | 可明確選用 | 實際來源 |
|---|---|---|---|
| `image` | `agy-native` | `gemini-bridge`、`grok-bridge`、`chatgpt-bridge` | AGY `generate_image`，或對應網站生圖工具 |
| `video` | `gemini-bridge` | `grok-bridge` | Gemini／Grok 網頁影片功能 |
| `music` | `gemini-bridge` | 無其他預設 | Gemini 網頁音樂功能 |

AGY 官方文件確認的是 `generate_image`；本包**不宣稱 AGY 內建影片或音樂工具**。音樂不是把文字交給 TTS，也不是 Fish Audio 旁白。統一的是本機命令和工作管理，並非把所有模型變成 AGY 原生工具。

明確使用本模組的 image 才預設 AGY native；不修改其他專案、夜燈說書工作流程包或已核准 ChatGPT 生圖路由。特定素材要走原 ChatGPT 路由時明寫 `--provider chatgpt-bridge`。不使用 OpenAI Images API 或 Codex 原生生圖工具。

## Windows 設定

需求：Node.js 22+、FFmpeg 與 ffprobe。`image --provider agy-native` 另需已安裝／登入的原生 AGY CLI；網頁路由需要已安裝的對應 Bridge、Chrome 開啟、該 Bridge 啟用的 Profile 已登入，而且該帳號具有目標生成功能。

本 ZIP **不含 AGY、FFmpeg、Bridge 的二進位或瀏覽器擴充套件**。既有 Bridge 不必重裝；不要把其他 MCP 或 config.toml 整份覆蓋。

在 `.3` 補丁包內升級既有 `.1` 或 `.2`：

```powershell
.\Upgrade-Local.ps1 -Repository "$HOME\source\agy-staff" -InstallSkill
.\Setup-Media.ps1 -Repository "$HOME\source\agy-staff"
```

升級前 FFmpeg／ffprobe 應已在 PATH，因為回歸會實際解碼合成測試媒體。若只有音樂／影片需求，不必為了設定 Gemini Bridge 先登入 AGY 或建立多帳號池。

Setup-Media 只讀既有 Bridge config 的 `install_root`、設定本模組路徑、檢查 MCP schema 與連線；**不生成、不登入、不切帳號、不改主模型／全域 MCP**。預設检查 Gemini；原生圖另用 `-CheckProvider agy-native`。自動定位失敗時指定：

```powershell
.\Setup-Media.ps1 -Repository "$HOME\source\agy-staff" `
  -GeminiBridge 'C:\Tools\gemini-web-bridge-v1.0.0\gwb.exe' `
  -GrokBridge 'C:\Tools\grok-web-bridge-v1.0.0\grwb.exe' `
  -ChatGPTBridge 'C:\Tools\chatgpt-web-bridge-v2.0.0\cwb.exe' `
  -FFmpeg 'C:\Tools\ffmpeg\bin\ffmpeg.exe' `
  -FFprobe 'C:\Tools\ffmpeg\bin\ffprobe.exe'
```

也可從已安裝 Skill 使用，不受 clone 目前工作目錄影響：

```powershell
$Staff = Join-Path $HOME '.agents\skills\agy-codex\runtime\companion\codex-staff.mjs'
node $Staff media configure --auto-detect
node $Staff media doctor --provider gemini-bridge
```

MCP 工具由本程式直接與現有 `gwb.exe mcp`／`grwb.exe mcp`／`cwb.exe mcp` 溝通；不需要再讓 Codex 猜出一套工具名稱。執行期先讀取真實 `tools/list` 並驗證工具參數，不會把不支援的欄位硬塞給 Bridge。

## 音樂：直接可用範例

以下範例會在您的帳號上提交一次生成，可能使用網站額度。先建立 UTF-8 提示詞檔，避免 PowerShell 5.1 管線編碼問題：

```powershell
$Staff = Join-Path $HOME '.agents\skills\agy-codex\runtime\companion\codex-staff.mjs'
$Prompt = Join-Path $env:TEMP 'night-lamp-music.txt'
[IO.File]::WriteAllText($Prompt, '古琴與簫的夜間古風配樂，溫柔而略帶神祕，適合說書旁白，旋律稀疏，收尾自然。', [Text.UTF8Encoding]::new($false))
node $Staff music --asset-id NL-MUSIC-001 --prompt-file $Prompt `
  --duration 30s --bpm 70 --vocals instrumental --preset night-lamp `
  --output-dir 'D:\NightLamp\assets'
node $Staff media wait --asset-id NL-MUSIC-001 --timeout 10m --collect
```

`--duration`、`--bpm`、曲風、樂器、人聲是**生成目標**，不是保證模型精確符合的硬參數。網站實際可用模型、片長與配額以登入帳號顯示為準；本程式不擅自換模型、訂閱、切帳號或編造固定限制。交付 metadata 保留請求值與實測音軌長度，BPM、人聲與藝術品質需主 Agent／人類聽音驗收。

有歌詞歌曲需明確指定：

```powershell
node $Staff music --asset-id SONG-001 --prompt-file '.\song-style.txt' `
  --vocals sung --lyrics-file '.\lyrics.txt' --output-dir '.\assets'
node $Staff media wait --asset-id SONG-001 --timeout 10m --collect
```

請提供自己創作或有權使用的歌詞。`--lyrics-file` 只接受 `--vocals sung`，不默認模仿指定歌手、克隆聲線或從現有歌曲拆出分軌。

預設交付 WAV；`--audio-format original` 保留原容器作主檔，當網站只提供封面影片時該主檔仍是影片，不能改副檔名假裝 MP3。需要可剪輯音軌應用預設 WAV。

## 圖片與影片

```powershell
# 一次原生 AGY 生圖；必要參考圖必須由操作者提供真實檔案
node $Staff image --asset-id NL-IMAGE-001 --provider agy-native `
  --prompt-file '.\image-prompt.txt' --reference '.\approved-reference.png' --output-dir '.\assets'
node $Staff media wait --asset-id NL-IMAGE-001 --timeout 10m --collect

# Gemini 影片；片長是目標，以實測結果為準
node $Staff video --asset-id NL-VIDEO-001 --provider gemini-bridge `
  --prompt-file '.\video-prompt.txt' --duration 10s --output-dir '.\assets'

# 明確選 Grok；不是前項失敗後自動再生一份
node $Staff video --asset-id NL-VIDEO-002 --provider grok-bridge `
  --prompt-file '.\video-prompt.txt' --output-dir '.\assets'
```

這些是彼此獨立的範例，不應一次全部執行。指定 `--tab-id` 可沿用 Bridge 列出的真實既有分頁；省略時 Bridge 建立新分頁。圖片上傳依已查核 schema：AGY／Gemini 最多5張、Grok1張、ChatGPT4張。本版**不支援音訊或影片參考檔上傳**，不把 `--reference` 誤稱音樂風格音訊輸入。

長提示走 stdin/MCP JSON，不經 shell 拼接。只看參數而不生成用 `--dry-run`；dry-run 不檢查帳號配額或實際模型。

## 持久化、防重複與收集

每個 asset_id 為唯一鍵，限定 Windows 可用的 ASCII 檔名；同一 ID／同參數再呼叫只回原狀態，**不重新生成**；參數變更則拒絕。帳號、provider、prompt、輸出位置、參考圖雜湊隨工作固定。ID 不分大小寫，不接受路徑穿越或 Windows 裝置名稱。

```powershell
node $Staff media status --asset-id NL-MUSIC-001
node $Staff media resume --asset-id NL-MUSIC-001
node $Staff media collect --asset-id NL-MUSIC-001
node $Staff media cancel --asset-id NL-MUSIC-001
```

`resume` 只接回原工作；提交回應遺失時按同一 request_id 查回至多100個最近 Bridge 工作，不開新 request。下載已發起後只查原 download_id；下載回應遺失時需查看瀏覽器下載，不自動再點一次。多個可用成品時，status 回傳候選清單，使用 `media collect --candidate-index 0` 明確選取，不自行加張或覆蓋。候選索引從0起。

`wait` 到期只停止這次等待，不取消遠端生成。`cancel` 是盡力停止本工作；網頁可能已提交到服務端，只有 Bridge 明確回傳停止證據才標 website_stop_confirmed。取消不代表退還額度。Native 工作只操控本次持有的子程序，不廣域 taskkill；Windows 所有後代程序清理尚待真機驗證。

工作狀態有 `submitting/submitted/running/ready/downloading/collected/needs_attention/failed/canceled` 等。只有 `collected` 表示本機產出已完成檔案驗證；`ready` 還不等於下載成功。退出碼0只是該命令處理成功，須讀 state；2=wait到期；3=needs_attention／failed；4=canceled／cancel_requested；1=參數／環境錯誤。

## 成果檔案

音樂的常見輸出：

```text
assets/NL-MUSIC-001/
  NL-MUSIC-001.source.mp4   # 或網站下載的原 WAV／MP3，保留原格式
  NL-MUSIC-001.wav          # 本機抽音／轉檔，並非第二次生成
  metadata.json            # provider、request 指紋、實測長度／音軌、SHA256
  prompt.txt               # 完整生成要求
```

Bridge 必須提供綁定本回合的完成證據；音樂必須含 `is_music=true` 的 ready audio/video。縮圖、歌詞、朗讀鈕音訊不算。下載完成後，再以 ffprobe 檢查音軌／長度並用 FFmpeg 全檔解碼；錯格式、空檔、破損檔拒收。技術上可解碼不代表已聽過、不代表一定符合音樂要求；metadata 明示仍需內容驗收。

保留原檔，再另建編輯用 WAV；不覆蓋同 ID 已有資料夾。若完成檔案發布後工作紀錄寫入中斷，只有同指紋及檔案雜湊全符合才接回既有成果。

## 原生 AGY 生圖的限制

Native 工作建立自己的媒體目錄，不要求 Git worktree，也不修改程式專案。只在該目錄建立 `.agents/hooks.json`；按照官方 hook 格式，先核對 `ImageName`／`ImagePaths`，以持久化 claim 限定一次 `generate_image`，禁止其餘工具。不寫全域 allowlist，不加 unrestricted。

成功需要 AGY terminal SUCCESS／exit0、PreToolUse與PostToolUse證據，以及該次 artifact directory 的新圖片。若當前 CLI 沒載入 hook、權限拒絕、API-mode無此工具，便回 needs_attention；不能用「已生成」文字、手繪SVG或假圖片兌現。

**Hook是应用層限制，不是 OS 沙箱**。尚未以真實 AGY 版本驗證啟用和產物命名；沒有證據不當成功。推理模型的 `--model` 不等於生圖模型選擇器。

Native 明確使用現有登入，不借 `.2` 的 API-mode 帳號池。Google 模型推理多帳號可用不代表內建媒體工具也能由該代理換帳號；本版不作此保證。Gemini、Grok、ChatGPT 使用各自已啟用 Chrome Profile，亦不受程式工作者 auto account 控制。

## 本機資料與外部服務

預設 `%LOCALAPPDATA%\agy-staff\media`；可由 `AGY_STAFF_MEDIA_DIR` 指定。含 config、提示詞、job、下載與artifact紀錄，不含複製來的 Google 憑證；不是加密保管庫，不應放進公開Git／共享資料夾。本版不新增媒體資料的專用 Windows ACL／DPAPI；安全性依目前使用者資料夾權限。參考圖只在明確提交時複製至工作目錄／Bridge輸入目錄。

使用需遵守各服務授權與適用規則。遇登入、403、額度、未知狀態就保留原工作，不靠帳號輪換或新的 asset_id 自動重試。不自動轉用計費API，不保證免費或無額度消耗。

## 來源與介面版本

查核日期：2026-09-26。
- AGY 原生工具、workspace hooks及Pre/PostToolUse格式：https://antigravity.google/docs/hooks
- AGY 圖片用額外模型（非主推理模型選擇器）：https://antigravity.google/docs/models
- Gemini 網頁音樂說明：https://support.google.com/gemini/answer/16901237?hl=en
- MCP stdio：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Codex Skills：https://developers.openai.com/codex/skills/
- 使用者既有 Bridge 原始包：Gemini v1.0.0、Grok v1.0.0、ChatGPT v2.0.0。

`codex-tests/fixtures/media/bridge-tools.json` 是本次實際啟動三個 Linux Bridge binary 後取得的 tools/list；不是在測試中自行杜撰的 schema。模型／網站回應仍由合成 fixture 模擬，不能用來證明真實帳號生成通過。
