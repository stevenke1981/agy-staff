# AGY Staff for Codex — 專案工作規則

## 角色與環境
本 fork 優先支援 Codex CLI／Codex 桌面版、Windows 11、PowerShell、Node.js 22 以上。
Codex/GPT 是主 Agent，擁有拆解、執行、整合、取消和最後驗收權。AGY 是有界工作者，不接管整個任務。
Astra／Sol／Luna 是使用者選擇的主機角色；不要假造模型 API ID，也不要為此修改全域 Codex 設定。

## 行動優先
先讀現有程式和 git status，選最小可驗證修正，實際修改、測試、檢查 diff，再回報。
小修改直接做，不為了分工而增加一輪模型。只有可清楚切割的調查、第二意見或實作才交給 AGY。
預設一個 worker；確定彼此獨立且有不同工作區才使用兩個。禁止遞迴委派與重複評審。
回覆繁體中文（臺灣），重點是成果、測試及阻塞；不要長篇計畫、口號或逐步播報。

## 修正與重試
失敗先看 exit code、stderr、實際輸入和工作區變化。修正根因後再測，不原樣重送。
同一故障最多兩次有實質變更的修復重試。耗盡後保留診斷與部分成果，Codex 自己接手或明確交付阻塞。
429／登入問題／沙箱拒絕不是重送或提權理由。不切換模型、不加 --allow-worker-tools 來掩蓋失敗。
失敗後有文字不等於成功；測試未執行就寫「未執行」。保留部分輸出但不標記驗收完成。

## 工作區與授權
使用 companion/codex-staff.mjs，不用舊入口繞過本適配層。
implement／staffer 必須使用 prepare 建立的獨立 Git worktree；dirty 主工作區不得自動 stash、reset、clean 或 commit。
review／research 預設受限，但不是作業系統唯讀保證。有既存 AGY allowlist 時仍可能寫入；必要時使用獨立工作區。
worktree 只隔離 checkout，仍共用 Git metadata；不是檔案權限沙箱。
--allow-worker-tools 只能在使用者明確授權該次執行時使用；維持外層 Codex 沙箱，不改全域批准規則。
不動 ~/.codex/config.toml、全域 AGENTS、其他 Skills/MCP、API key、登入檔或使用者未指名的 repository。
AGY 不負責 commit／push／PR／部署。使用者授權交付時，由 Codex 檢查後執行。
一般coding worker不得自行生成媒體。使用者明確授權的image/video/music工作，依codex-skills/media及docs/MEDIA.zh-TW.md執行；AGY原生只提供image，不虛構原生影片／音樂。其他專案的既定媒體路由不變。

## 工作收尾
背景工作回傳 job id 只是啟動，不是完成。同一 workspace 使用 wait；exit 2 代表仍在執行，不要重建另一個工作。
續接必須指定 --job，確認原工作已停止；取消後核對 terminal status。
回報格式：完成內容；實際測試和結果；尚未驗證／剩餘阻塞。不可宣稱未建立的 fork、未推送的 commit 或未執行的 CI。


## 帳號路由（codex.2）
- 使用 `accounts list` 檢查不含 token 的狀態；`--account auto|native|ALIAS` 只用於新任務／原設定續接。
- 不要求使用者提供密碼／token，不讀取或上傳帳號資料夾。首次 login 留給使用者在瀏覽器操作。
- Codex 主模型、工具權限、媒體 bridge 路由不因換 AGY 帳號而改變。
- 冷卻／需要登入／權限拒絕是不同狀況；不清除冷卻來無限重試，不以換帳號處理 403。
- 不重跑整個有副作用的任務。收集原 job 輸出後修正原因；continue 必須原工作區、原會話。
- 真實 Google 和 Windows 行為未驗證時，明確標記，不能以 fixture SUCCESS 代替真機證據。

## 媒體工作（codex.3）
每asset_id只提交一次；media resume只觀察，不生成新request。音樂預設Gemini Bridge、純音樂與WAV；歌曲需明確指定sung與歌詞。不可把圖片封面、文字、TTS當音樂；下載並解碼才交付。時長／BPM請求值與量測結果分開。media不使用coding帳號池，不因失敗自動切帳號/provider。原生image需hook和真正新artifact證據；未驗證的原生CLI或瀏覽器能力必須明示。
