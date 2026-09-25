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
媒體生成仍使用使用者另行核准的工具路由，不交給 AGY 原生圖片工具。

## 工作收尾
背景工作回傳 job id 只是啟動，不是完成。同一 workspace 使用 wait；exit 2 代表仍在執行，不要重建另一個工作。
續接必須指定 --job，確認原工作已停止；取消後核對 terminal status。
回報格式：完成內容；實際測試和結果；尚未驗證／剩餘阻塞。不可宣稱未建立的 fork、未推送的 commit 或未執行的 CI。
