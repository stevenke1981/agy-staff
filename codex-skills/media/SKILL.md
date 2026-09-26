---
name: media
description: Explicit image, video and music tasks with AGY native image generation or installed Gemini/Grok/ChatGPT Web Bridges; persistent jobs and verified local artifacts.
---
# AGY Codex 媒體

以本 SKILL.md 向上兩層作 plugin root，執行該 root/companion/codex-staff.mjs；安裝為單一使用者 Skill 時，以外層主 SKILL 指定的 runtime 路徑為準。
先讀 [媒體操作](../../docs/MEDIA.zh-TW.md)。主 Agent保留決策、內容驗收和最後交付；明確生成授權才提交，不因測試/doctor而試生一張。

圖片 `image` 預設 agy-native；影片 `video` 預設 gemini-bridge，也可明確選 grok-bridge；音樂 `music` 用 gemini-bridge。既有核准素材要求 ChatGPT 就指定 chatgpt-bridge，不覆蓋其他專案路由。不虛構 AGY native video/music。

1. `media doctor --provider ...` 檢查依賴；確認唯一asset_id、已核准提示詞與真實參考檔。缺參考不可假裝讀過另一對話。權限／功能不存在就回傳真實阻塞，不偷換來源。
2. 使用 `--prompt-file` 的UTF-8文字，執行一次 image/video/music，保存本機asset_id與remote job_id。只生成指名數量；不以不同ID重送同一待確認工作。
3. 用 `media wait --asset-id ... --timeout 120s --collect` 收集；exit2繼續等待同ID；needs_attention先status/resume，不重新提交。尚未收集不可宣稱成品已交付。
4. 音樂預設 `--vocals instrumental --audio-format wav`，說書配樂可加 `--preset night-lamp`。有歌詞歌曲必須明確 `--vocals sung --lyrics-file`。片長/BPM是請求目標，不能等同實測。
5. 技術上必須有音軌、實際解碼，不能拿封面/文字/朗讀替代音樂；內容品質仍需聽音驗收。複數候選由主Agent看真實資料選`--candidate-index`，不是重生成。

一般coding帳號池不適用媒體。生成、下載回應遺失只追蹤原ID，禁止自動切帳號/provider/API重送。cancel是盡力停止，不宣稱一定取消服務端生成或返還額度。
