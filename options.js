const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "bilidownPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "bilidown Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile. Audio is sent to Alibaba Bailian for ASR, while transcripts and context are sent to minimax for AI features.",
      transcriptProvider: "Transcript provider",
      supadataApiKeyLabel: "Supadata API key",
      supadataHelp: "Used to fetch timestamped Bilibili subtitles. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiProvider: "AI provider",
      aiProviderSelectLabel: "Choose a model",
      providerOptionMinimax: "minimax (MiniMax-M3)",
      providerOptionDeepseek: "DeepSeek",
      providerOptionGlm: "GLM (Zhipu)",
      providerOptionOther: "Other model",
      providerOptionNone: "No AI model",
      disableAiDialogTitle: "Disable AI model",
      disableAiDialogBody:
        "Without an AI model you will not be able to use summaries or the overview. Disable it anyway?",
      disableAiConfirmBtn: "Disable",
      disableAiCancelBtn: "Cancel",
      providerNeedsKey: ({ provider }) =>
        `${provider} is selected but no API key was filled in — nothing was saved. Fill in the key, or pick ‘No AI model’.`,
      switchKeyDialogTitle: "Switch model",
      switchKeyDialogBody: ({ provider }) =>
        `An API key for ${provider} is saved. Keep it — switching back to this model later restores the key automatically, no re-entry needed. Clear it to remove the saved key now.`,
      switchKeyKeepBtn: "Keep",
      switchKeyClearBtn: "Clear",
      minimaxApiKeyLabel: "minimax API key",
      deepseekApiKeyLabel: "DeepSeek API key",
      glmApiKeyLabel: "GLM API key",
      glmApiTypeLabel: "API type",
      glmApiTypeCoding: "Coding Plan (subscription)",
      glmApiTypeStandard: "Standard API (pay-as-you-go)",
      minimaxHelp:
        "bilidown uses minimax for overviews, explanations, translation, and note polishing. ",
      deepseekHelp:
        "bilidown uses DeepSeek for overviews, explanations, translation, and note polishing. ",
      glmHelp:
        "bilidown uses GLM (Zhipu / Z.AI) for overviews, explanations, translation, and note polishing. Default model: glm-4.6. ",
      minimaxLink: "Create a minimax API key",
      deepseekLink: "Create a DeepSeek API key",
      glmLink: "Create a Zhipu API key",
      minimaxHelpSuffix: ".",
      deepseekHelpSuffix: ".",
      glmHelpSuffix: ".",
      privacyNote:
        "When you use AI features, the selected provider receives the video transcript and relevant video context. Review the active provider's terms and pricing before saving.",
      whisperHeading: "Local Whisper (optional)",
      whisperHelp:
        "After starting start_whisper_server.bat, bilidown downloads the audio when Bilibili has no usable subtitles, transcribes it locally, and then asks the AI to fix proper-noun errors.",
      whisperEnabledLabel: "Enable local Whisper fallback",
      whisperUrlLabel: "Whisper server URL",
      whisperModelLabel: "Whisper model",
      whisperLanguageLabel: "Whisper language (blank = auto-detect)",
      whisperSetupTitle: "Local setup (transparent, nothing is auto-installed)",
      whisperSetupStep1: "Python 3.10+ installed on this machine (bilidown bundles no Python and never installs one)",
      whisperSetupStep2: "Install the Whisper dependencies into YOUR Python — after the check, the exact command for this machine is shown; whether to run it is your call",
      whisperSetupStep3: "Double-click start_whisper_server.bat in the extension folder and keep the window open",
      whisperSetupStep4: "Click “Check system” — all ✓ means ready",
      // 2026-08-31: browsers never let a page execute a local .bat, and the
      // extension sandbox cannot see its own on-disk folder — so the closest
      // real action is a deep link to this extension's chrome://extensions
      // entry, where Chrome shows (and lets you copy) the folder path.
      whisperExtFolderLink: "Open the extensions page to copy the folder path",
      whisperExtFolderTitle:
        "A web page is not allowed to run a local .bat by clicking a link, and the extension cannot see its own install folder. The extensions page shows it under “path” — click to copy, paste into File Explorer's address bar, then double-click start_whisper_server.bat there.",
      whisperCheckBtn: "Check system",
      whisperCopyCmdBtn: "Copy install command",
      whisperSetupDownloadBtn: "Download setup script",
      subtitlesDirLabel: "Subtitle cache directory",
      subtitlesDirHelp:
        "Whisper transcripts (and AI-corrected versions) are stored here, indexed by BV id. Re-opening the same video reads the cache instead of re-transcribing.",
      subtitlesDirRequired:
        "Subtitle cache directory is empty — nothing was saved. Whisper needs a writable folder on this computer for its transcript cache. Fill in the field above and save again.",

      saveSettings: "Save settings",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted bilidown project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local bilidown workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is bilidown. If verification fails, stop and ask me to open the extracted bilidown project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep minimax-only request fields and retry behavior isolated to minimax. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real Bilibili video.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Summaries, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached summaries",
      deleteNotes: "Delete all notes",
      resetData: "Reset content data (keep keys)",
      footer:
        'Read <a href="PRIVACY.md" target="_blank">PRIVACY.md</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your Supadata key was kept, but the AI key was cleared. Enter a minimax API key to continue.",
      saving: "Saving…",
      addSupadataKey: "Add a Supadata API key.",
      addMiniMaxKey: "Add a minimax API key.",
      saved: "Settings saved and verified. bilidown will use them immediately.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedSummaries: ({ count }) =>
        `Cleared ${count} cached summar${count === 1 ? "y" : "ies"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm:
        "Delete cached summaries, translations, and saved notes? Your API keys will be kept.",
      allDataDeleted:
        "Content data was reset. Your API keys were kept.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",

      // ---- 2026-08-31 i18n completion: static hooks + dynamic flows ----
      // Every key below used to exist only as hardcoded zh text (options.html
      // had no data-i18n hook, or options.js rendered the string inline).
      dirtyBanner: "Click “Save settings” — otherwise your changes will not be saved.",
      asrSectionTitle: "Speech recognition",
      asrSectionHelp:
        "When a Bilibili video has no native subtitles, bilidown uses the engine selected below to generate timestamped subtitles.",
      asrSelectAriaLabel: "Speech recognition service",
      asrOptionNone: "Off (Bilibili native subtitles only)",
      asrOptionWhisper: "Local Whisper",
      asrBailianKeyLabel: "Bailian API key",
      asrBailianHelp:
        "bilidown downloads the Bilibili audio track, uploads it to Bailian's 48-hour temporary storage, and uses Fun-ASR to generate timestamped subtitles ",
      asrBailianLink: "Get a Bailian API key",
      asrBailianHelpSuffix: ".",
      whisperSetupDownloadTitle:
        "Download a self-contained setup script: find Python → pip install faster-whisper + zhconv → verify imports. Exactly what gets installed, and into which Python, is written in the script — review it before running.",
      whisperModelOptionTiny: "tiny (~75 MB, fastest)",
      whisperModelOptionBase: "base (~150 MB, default)",
      whisperModelOptionSmall: "small (~500 MB, better)",
      whisperModelOptionMedium: "medium (~1.5 GB, accurate)",
      whisperModelOptionLargeV3: "large-v3 (~3 GB, most accurate)",
      whisperModelOptionTurbo: "turbo (~1.5 GB, fast large)",
      whisperCheckRunning: "Checking…",
      whisperBatHintFallback:
        "start_whisper_server.bat in the extension folder (use the “Open the extensions page” link in step 3 to copy the folder path, then paste it into File Explorer's address bar)",
      whisperOfflineDetail: ({ batHint }) =>
        `Not running — do step 3 first: double-click ${batHint} and keep the window open`,
      whisperOfflineStatus: "Server not running (this check is read-only and changes nothing)",
      whisperOldServerDetail: ({ batHint }) =>
        `Online, but running an old build — diagnostics are incomplete. Close the console window, double-click ${batHint} again, then click “Check system” once more`,
      whisperDepsLabel: "Dependency details",
      whisperOldServerDepsNote:
        "Old server builds do not report Python / dependency versions (visible after restarting the bat)",
      whisperOldServerStatus: "Old server build — restart the bat and check again",
      whisperLimitedDetail: "Online but in limited mode (transcription unavailable)",
      whisperMissingRequired: "Missing — required for local transcription",
      whisperZhconvLabel: "zhconv — Traditional→Simplified conversion",
      whisperZhconvMissingLimited:
        "Not installed → subtitles stay Traditional; transcription is unaffected",
      whisperLimitedStatus: ({ cmd }) =>
        `Missing dependencies. Install command (running it is your call): ${cmd}; afterwards close the console window and relaunch the bat`,
      whisperOnlineReady: ({ batPath }) =>
        `Online · transcription ready${batPath ? " · " + batPath : ""}`,
      whisperInstalled: "installed",
      whisperZhconvMissingHint: ({ pyExe }) =>
        `Not installed → subtitles may be Traditional; transcription is unaffected. To install: ${pyExe} -m pip install zhconv (relaunch the bat afterwards)`,
      whisperReadyBarCore:
        "Environment ready. The first transcription with a model downloads and caches that model's weights (base ≈ 150 MB); transcripts are cached by BV id in the subtitle cache directory above — the same video is never transcribed twice.",
      whisperReadyBarZhconvSuffix:
        " (zhconv optional, not installed: subtitles may be Traditional; transcription is unaffected — install command in the zhconv row above, relaunch the bat afterwards)",
      whisperReadyStatus: "Ready",
      whisperCopied: ({ cmd }) => `Copied: ${cmd}`,
      whisperCopyFail: "Copy failed — select the command text and copy it manually",
      optionalBadge: "optional",
      installRowTitle: "Download setup script",
      installDownloadedStatus:
        "Downloaded bilidown_whisper_setup.bat (plain text — open it to review before running). It will: find Python → download and install faster-whisper + zhconv from the official PyPI (pypi.org) → verify imports. Click “Run” in the Windows prompt.",
      installDownloadFailStatus:
        "Download failed. Alternative: click “Check system” for the exact install command for this machine and paste it into a terminal yourself.",
      installRowOk:
        "Script is transparent: finds Python → pip install faster-whisper zhconv (packages come from the official PyPI, printed while the script runs) → verifies imports; which Python it installed into is printed by the script",
      installRowFail:
        "Go manual instead: click “Check system”, copy the install command, run it yourself",
      diagnosticsTitle: "Diagnostics",
      diagnosticsHelp:
        "One click checks the key dependencies, so you don't have to dig through the README for commands.",
      diagnosticsRunBtn: "Run diagnostics",
      diagRunning: "Checking…",
      diagDone: "Done",
      diagVersionLabel: "Extension version",
      diagVersionFail: "manifest not readable",
      diagStorageLabel: "Extension local storage",
      diagStorageOk: ({ count }) => `${count} setting${count === 1 ? "" : "s"} saved`,
      diagUnknownError: "unknown error",
      diagWhisperLabel: "Local Whisper server",
      pingLimitedPrefix: "online but missing deps: ",
      diagWhisperLimitedSuffix:
        "(the exact install command for this machine is in “Check system” above)",
      diagWhisperNotEnabledSuffix: "(local Whisper is not enabled — no impact)",
      diagWhisperDownSuffix:
        "(not running? double-click start_whisper_server.bat in the extension folder)",
      diagAsrLabel: "ASR provider",
      diagAsrNone: "None / Bilibili native subtitles only",
      diagAsrBailian: "Aliyun Bailian Fun-ASR",
      diagAsrWhisper: "Local Whisper",
      diagAiKeyLabel: "AI provider key",
      diagAiKeyNone:
        "No AI model enabled (summaries/overviews unavailable; subtitles unaffected)",
      diagAiKeyConfigured: "configured",
      diagAiKeyMissing:
        "not configured (needed for overviews/summaries; subtitles unaffected)",
      diagAiKeyCustom: "Custom model: configure the key in the matching field",
    },
    "zh-CN": {
      pageTitle: "bilidown 设置",
      languageGroupLabel: "界面语言",
      heading: "bilidown 设置",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中。音频会发送给阿里云百炼进行语音识别，字幕和视频上下文会发送给 minimax 生成概览等内容。",
      transcriptProvider: "字幕服务",
      supadataApiKeyLabel: "Supadata API 密钥",
      supadataHelp: "用于获取带时间戳的 Bilibili 字幕。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiProvider: "AI 服务",
      aiProviderSelectLabel: "选择模型",
      providerOptionMinimax: "minimax（MiniMax-M3）",
      providerOptionDeepseek: "DeepSeek",
      providerOptionGlm: "GLM（智谱）",
      providerOptionOther: "其他模型",
      providerOptionNone: "不使用 AI 模型",
      disableAiDialogTitle: "不使用 AI 模型",
      disableAiDialogBody:
        "不选择模型的话您将无法使用总结和概览的功能。是否确认？",
      disableAiConfirmBtn: "确认",
      disableAiCancelBtn: "取消",
      providerNeedsKey: ({ provider }) =>
        `已选择 ${provider}，但未填写 API Key，无法保存。请填写密钥，或选择「不使用 AI 模型」。`,
      switchKeyDialogTitle: "切换模型",
      switchKeyDialogBody: ({ provider }) =>
        `已填写 ${provider} 的 API Key。保留：下次切换回该模型时密钥会自动出现，无需再次输入；清空：立即删除已保存的这把密钥。`,
      switchKeyKeepBtn: "保留",
      switchKeyClearBtn: "清空",
      minimaxApiKeyLabel: "minimax API 密钥",
      deepseekApiKeyLabel: "DeepSeek API 密钥",
      glmApiKeyLabel: "GLM API 密钥",
      glmApiTypeLabel: "API 类型",
      glmApiTypeCoding: "Coding Plan（订阅）",
      glmApiTypeStandard: "Standard API（按量计费）",
      minimaxHelp:
        "bilidown 使用 minimax 生成概览、解释内容、翻译字幕和润色笔记。",
      deepseekHelp:
        "bilidown 使用 DeepSeek 生成概览、解释内容、翻译字幕和润色笔记。",
      glmHelp:
        "bilidown 使用 GLM（智谱 / Z.AI）生成概览、解释内容、翻译字幕和润色笔记。默认模型 glm-4.6。",
      minimaxLink: "创建 minimax API 密钥",
      deepseekLink: "创建 DeepSeek API 密钥",
      glmLink: "创建智谱 API 密钥",
      minimaxHelpSuffix: "。",
      deepseekHelpSuffix: "。",
      glmHelpSuffix: "。",
      privacyNote:
        "使用 AI 功能时，当前选择的服务会收到视频字幕及相关视频上下文。保存前请查看对应服务的条款和价格。",
      whisperHeading: "本地 Whisper（可选）",
      whisperHelp:
        "启动 start_whisper_server.bat 后，B 站没有可用字幕时会下载音轨让本地 Whisper 转写，再让 AI 校正专有名词。",
      whisperEnabledLabel: "启用本地 Whisper 兜底",
      whisperUrlLabel: "Whisper server URL",
      whisperModelLabel: "Whisper 模型",
      whisperLanguageLabel: "Whisper 语言（留空自动检测）",
      whisperSetupTitle: "本地环境准备（透明流程，不会自动装任何东西）",
      whisperSetupStep1: "本机装有 Python 3.10+（bilidown 不自带 Python，也不会替你安装）",
      whisperSetupStep2: "安装 Whisper 依赖到你的 Python——检查后这里会给出针对本机的确切命令，装不装由你决定",
      whisperSetupStep3: "双击扩展文件夹里的 start_whisper_server.bat，保持窗口开着",
      whisperSetupStep4: "点「检查系统」，全部 ✓ 即就绪",
      whisperExtFolderLink: "打开扩展管理页，查看文件夹路径",
      whisperExtFolderTitle:
        "浏览器不允许网页直接运行本地 bat，扩展也看不到自己的安装位置。扩展管理页会显示本扩展在磁盘上的文件夹（「路径」一栏）：点击复制 → 粘贴到资源管理器地址栏回车 → 在打开的文件夹里双击 start_whisper_server.bat。",
      whisperCheckBtn: "检查系统",
      whisperCopyCmdBtn: "复制安装命令",
      whisperSetupDownloadBtn: "下载安装脚本",
      subtitlesDirLabel: "字幕缓存目录",
      subtitlesDirHelp:
        "Whisper 转写 + AI 校正后的字幕会保存到这里（按 BV 号缓存）。再次打开同一视频会直接读缓存，不再跑 Whisper。",
      subtitlesDirRequired:
        "字幕缓存目录为空，无法保存。Whisper 需要本机一个可写目录来缓存转写结果。请填写上方目录后再保存。",

      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 bilidown 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 bilidown 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 bilidown。如果验证失败，请停止，并让我在编程 Agent 中打开 bilidown 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。minimax 专用的请求参数和重试逻辑继续只用于 minimax。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 Bilibili 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置内容数据（保留密钥）",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。Supadata 密钥已保留，AI 密钥已清除。请在所选 AI 服务中填入 API 密钥以继续使用。",
      saving: "正在保存…",
      addSupadataKey: "请添加 Supadata API 密钥。",
      addMiniMaxKey: "请添加所选 AI 服务的 API 密钥。",
      saved: "设置已保存并验证成功，bilidown 将立即使用新配置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedSummaries: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要删除缓存摘要、翻译和已保存的笔记吗？AI 与百炼 API 密钥会保留。",
      allDataDeleted: "已重置内容数据，API 密钥已保留。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",

      // ---- 2026-08-31 i18n completion：与 en 块一一对应 ----
      // 值与改造前写死渲染的中文逐字节一致（测试断言依赖原文）。
      dirtyBanner: "请点击保存设置，否则您的修改将不被保存。",
      asrSectionTitle: "语音识别",
      asrSectionHelp: "B 站没有原生字幕时，bilidown 会用下面选择的引擎给视频生成带时间戳的字幕。",
      asrSelectAriaLabel: "语音识别服务",
      asrOptionNone: "不使用（仅用 B 站原生字幕）",
      asrOptionWhisper: "本地 Whisper",
      asrBailianKeyLabel: "百炼 API Key",
      asrBailianHelp:
        "bilidown 会下载当前B站音轨，上传到百炼48小时临时空间，并使用 Fun-ASR 生成带时间戳字幕。",
      asrBailianLink: "获取百炼 API Key",
      asrBailianHelpSuffix: "。",
      whisperSetupDownloadTitle:
        "下载一个自包含安装脚本：找 Python → pip 安装 faster-whisper + zhconv → 验证导入。装什么、装到哪个 Python 全写在脚本里，运行前可先查看内容",
      whisperModelOptionTiny: "tiny（~75 MB，极快）",
      whisperModelOptionBase: "base（~150 MB，默认）",
      whisperModelOptionSmall: "small（~500 MB，较好）",
      whisperModelOptionMedium: "medium（~1.5 GB，精确）",
      whisperModelOptionLargeV3: "large-v3（~3 GB，最精确）",
      whisperModelOptionTurbo: "turbo（~1.5 GB，快速 large）",
      whisperCheckRunning: "检查中…",
      whisperBatHintFallback: "扩展文件夹里的 start_whisper_server.bat（用步骤 3 的「打开扩展管理页」链接复制文件夹路径，粘贴到资源管理器地址栏即可直达）",
      whisperOfflineDetail: ({ batHint }) =>
        `未启动——先做步骤 3：双击 ${batHint} 并保持窗口开着`,
      whisperOfflineStatus: "server 未启动（检查只读，不会改动系统）",
      whisperOldServerDetail: ({ batHint }) =>
        `在线，但跑的是旧版本——诊断信息不全。请关闭黑窗口，重新双击 ${batHint}，然后再点一次「检查系统」`,
      whisperDepsLabel: "依赖详情",
      whisperOldServerDepsNote: "旧版 server 不上报 Python / 依赖版本（重启 bat 后可见）",
      whisperOldServerStatus: "server 是旧版本——重启 bat 后重新检查",
      whisperLimitedDetail: "在线但处于受限模式（转写不可用）",
      whisperMissingRequired: "缺失——本地转写必需",
      whisperZhconvLabel: "zhconv — 繁体字幕转简体",
      whisperZhconvMissingLimited: "未安装 → 字幕将保留繁体；转写功能不受影响",
      whisperLimitedStatus: ({ cmd }) =>
        `缺依赖，安装命令（是否执行由你决定）：${cmd}；装完关闭黑窗口重开一次 bat`,
      whisperOnlineReady: ({ batPath }) =>
        `在线 · 转写可用${batPath ? " · " + batPath : ""}`,
      whisperInstalled: "已安装",
      whisperZhconvMissingHint: ({ pyExe }) =>
        `未安装 → 字幕可能是繁体，转写不受影响。想装：${pyExe} -m pip install zhconv（装完重开 bat）`,
      whisperReadyBarCore:
        "环境就绪。首次用某个模型转写时会自动下载该模型权重并缓存（base 约 150MB）；" +
        "转写结果按 BV 号缓存在上方「字幕缓存目录」，同一视频不会重复转写。",
      whisperReadyBarZhconvSuffix:
        "（zhconv 可选未装：字幕可能是繁体，不影响转写；安装命令见上方 zhconv 行，装完重开 bat）",
      whisperReadyStatus: "环境就绪",
      whisperCopied: ({ cmd }) => `已复制：${cmd}`,
      whisperCopyFail: "复制失败——手动选中文本里的命令复制",
      optionalBadge: "可选",
      installRowTitle: "下载安装脚本",
      installDownloadedStatus:
        "已下载 bilidown_whisper_setup.bat（内容是纯文本，运行前可先打开看）。它会：找 Python → 从官方源 PyPI（pypi.org）下载并安装 faster-whisper + zhconv → 验证导入。Windows 确认框里点“运行”即可。",
      installDownloadFailStatus: "下载失败。备选：点「检查系统」拿针对本机的安装命令，自己粘贴到终端执行。",
      installRowOk:
        "脚本内容透明：自动找 Python → pip install faster-whisper zhconv（包从官方源 pypi.org 下载，来源会在脚本运行时打印）→ 验证导入；装到哪个 Python 会在脚本里打印",
      installRowFail: "改为手动：点「检查系统」复制安装命令自行执行",
      diagnosticsTitle: "诊断",
      diagnosticsHelp: "一键检查关键依赖是否就位。不用反复看 README 找命令。",
      diagnosticsRunBtn: "运行诊断",
      diagRunning: "检查中…",
      diagDone: "完成",
      diagVersionLabel: "扩展版本",
      diagVersionFail: "无法读取 manifest",
      diagStorageLabel: "扩展本地存储",
      diagStorageOk: ({ count }) => `${count} 项设置已保存`,
      diagUnknownError: "未知错误",
      diagWhisperLabel: "本地 Whisper server",
      pingLimitedPrefix: "在线但缺依赖: ",
      diagWhisperLimitedSuffix: "（上方「检查系统」里有针对本机的安装命令）",
      diagWhisperNotEnabledSuffix: "（当前未启用本地 Whisper，无影响）",
      diagWhisperDownSuffix: "（未运行？双击扩展目录里的 start_whisper_server.bat）",
      diagAsrLabel: "ASR 提供方",
      diagAsrNone: "不使用 / 仅 B 站原生字幕",
      diagAsrBailian: "阿里云百炼 Fun-ASR",
      diagAsrWhisper: "本地 Whisper",
      diagAiKeyLabel: "AI 提供方 Key",
      diagAiKeyNone: "未启用 AI 模型（总结/概览不可用；字幕功能不受影响）",
      diagAiKeyConfigured: "已配置",
      diagAiKeyMissing: "未配置（概览/总结需要；字幕功能不受影响）",
      diagAiKeyCustom: "自定义模型：请在对应字段配置 Key",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  // Self-contained Windows setup script for the Whisper dependencies,
  // generated on demand and downloaded by the options page ("下载安装
  // Whisper 依赖"). Replaces the old copy-a-PowerShell-command flow:
  // the user no longer needs PowerShell or the right working directory —
  // pip installs into the Python environment, not into any folder.
  // English-only messages (avoids codepage garbling in cmd.exe) and
  // CRLF endings so cmd.exe parses it reliably.
  function buildWhisperSetupBat() {
    const lines = [
      "@echo off",
      "REM bilidown Whisper dependency one-click installer.",
      "REM Generated by the bilidown options page. Safe to run from any",
      "REM directory - pip installs into Python itself, not a folder.",
      "title bilidown Whisper setup",
      "setlocal",
      "",
      "set \"PYTHON_EXE=\"",
      "",
      "if defined BILIDOWN_PYTHON (",
      "  if exist \"%BILIDOWN_PYTHON%\" set \"PYTHON_EXE=%BILIDOWN_PYTHON%\"",
      ")",
      "",
      "if not defined PYTHON_EXE (",
      "  for /f \"delims=\" %%i in ('where python 2^>nul') do (",
      "    if not defined PYTHON_EXE set \"PYTHON_EXE=%%i\"",
      "  )",
      ")",
      "",
      "if not defined PYTHON_EXE (",
      "  for %%P in (",
      "    \"%USERPROFILE%\\miniconda3\\python.exe\"",
      "    \"%USERPROFILE%\\anaconda3\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python313\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python311\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python310\\python.exe\"",
      "    \"C:\\Python313\\python.exe\"",
      "    \"C:\\Python312\\python.exe\"",
      "    \"C:\\Python311\\python.exe\"",
      "    \"C:\\Python310\\python.exe\"",
      "  ) do (",
      "    if not defined PYTHON_EXE if exist %%~P set \"PYTHON_EXE=%%~P\"",
      "  )",
      ")",
      "",
      "if not defined PYTHON_EXE (",
      "  echo [ERROR] Python not found on this machine.",
      "  echo Install Python 3.10+ from https://www.python.org/downloads/",
      "  echo ^(check \"Add Python to PATH\" during install^), then run this file again.",
      "  pause",
      "  exit /b 1",
      ")",
      "",
      "echo Found Python: %PYTHON_EXE%",
      "echo.",
      // 2026-08-31, real-world failure on a fresh PC: pip installed both
      // packages fine, but `import faster_whisper` died inside ctranslate2
      // with "Could not find module ...ctranslate2.dll (or one of its
      // dependencies)" — the machine had no Visual C++ runtime, which the
      // CTranslate2 Windows wheels require. Pre-warn when the canonical
      // marker DLL is absent so the user is not surprised by the verify
      // step; the definitive verdict is still the import test below.
      "if not exist \"%SystemRoot%\\System32\\msvcp140.dll\" (",
      "  echo [NOTE] The Visual C++ runtime msvcp140.dll is missing. Windows",
      "  echo        needs it to load faster-whisper. If the verification at",
      "  echo        the end fails, install the x64 redistributable from:",
      "  echo        https://aka.ms/vs/17/release/vc_redist.x64.exe",
      "  echo.",
      ")",
      "echo This script installs 2 packages into that Python:",
      "echo   faster-whisper  - speech recognition engine",
      "echo   zhconv          - Traditional/Simplified Chinese conversion",
      "echo.",
      "echo Download source: PyPI - the official Python Package Index",
      "echo   package index : https://pypi.org",
      "echo   package files : https://files.pythonhosted.org",
      "echo No other files are downloaded and nothing else is changed.",
      "echo.",
      "echo Running:",
      "echo   \"%PYTHON_EXE%\" -m pip install --upgrade faster-whisper zhconv",
      "echo pip prints every Downloading URL below - all from files.pythonhosted.org",
      "echo This may take a few minutes depending on your network.",
      "echo.",
      "",
      "\"%PYTHON_EXE%\" -m pip install --upgrade faster-whisper zhconv",
      "if errorlevel 1 (",
      "  echo.",
      "  echo [ERROR] pip install failed. Check the messages above.",
      "  pause",
      "  exit /b 1",
      ")",
      "",
      "echo.",
      "echo Verifying imports...",
      // Capture the interpreter output so a failing traceback can be
      // re-printed AND pattern-matched for the ctranslate2 DLL failure,
      // which gets its own fix hint (missing VC++ runtime, fresh PCs).
      "set \"VERIFY_LOG=%TEMP%\\bilidown_whisper_verify.log\"",
      "\"%PYTHON_EXE%\" -c \"import faster_whisper, zhconv; print('OK: dependencies are ready')\" > \"%VERIFY_LOG%\" 2>&1",
      "if errorlevel 1 (",
      "  type \"%VERIFY_LOG%\"",
      "  echo.",
      "  findstr /i /c:\"ctranslate2\" \"%VERIFY_LOG%\" >nul 2>&1",
      "  if not errorlevel 1 (",
      "    echo [HINT] ctranslate2 could not load. On a fresh Windows PC this",
      "    echo        almost always means the Microsoft Visual C++ 2015-2022",
      "    echo        runtime is missing. Download and install the x64",
      "    echo        redistributable from:",
      "    echo        https://aka.ms/vs/17/release/vc_redist.x64.exe",
      "    echo        then run this script again - it is safe to re-run.",
      "    echo.",
      "  )",
      "  echo [ERROR] Packages installed but not importable. See messages above.",
      "  pause",
      "  exit /b 1",
      ")",
      "",
      "echo.",
      "echo All dependencies installed.",
      "echo Next: double-click start_whisper_server.bat to launch the server.",
      "pause",
      "",
    ];
    return lines.join("\r\n");
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  async function resetContentData(storage, settingsKey, language) {
    const stored = await storage.get(settingsKey);
    const savedSettings = stored[settingsKey];

    await storage.clear();

    const restored = {
      [LANGUAGE_STORAGE_KEY]: normalizeLanguage(language),
    };
    if (savedSettings && typeof savedSettings === "object") {
      restored[settingsKey] = savedSettings;
    }
    await storage.set(restored);

    return savedSettings || null;
  }

  async function persistAndVerifySettings(storage, settingsKey, settings) {
    await storage.set({ [settingsKey]: settings });
    const stored = await storage.get(settingsKey);
    const verified = stored[settingsKey];
    if (
      !verified ||
      verified.aiApiKey !== settings.aiApiKey ||
      verified.asrApiKey !== settings.asrApiKey
    ) {
      throw new Error("SETTINGS_WRITE_VERIFICATION_FAILED");
    }
    return verified;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiProviderSelect = doc.getElementById("aiProvider");
    const minimaxApiKeyInput = doc.getElementById("minimaxApiKey");
    const deepseekApiKeyInput = doc.getElementById("deepseekApiKey");
    const glmApiKeyInput = doc.getElementById("glmApiKey");
    const glmApiTypeSelect = doc.getElementById("glmApiType");
    const providerFieldEls = [
      ...doc.querySelectorAll("[data-provider-field]"),
    ];
    const asrApiKeyInput = doc.getElementById("asrApiKey");
    const asrProviderSelect = doc.getElementById("asrProvider");
    const asrFieldEls = [...doc.querySelectorAll("[data-asr-field]")];
    const whisperUrlText = doc.getElementById("whisperUrlText");
    const switchKeyDialog = doc.getElementById("switchKeyDialog");
    const switchKeyDialogBody = doc.getElementById("switchKeyDialogBody");
    const switchKeyKeepBtn = doc.getElementById("switchKeyKeepBtn");
    const switchKeyClearBtn = doc.getElementById("switchKeyClearBtn");
    const disableAiDialog = doc.getElementById("disableAiDialog");
    const disableAiConfirmBtn = doc.getElementById("disableAiConfirmBtn");
    const disableAiCancelBtn = doc.getElementById("disableAiCancelBtn");
    const whisperModelSelect = doc.getElementById("whisperModel");
    const whisperLanguageInput = doc.getElementById("whisperLanguage");
    const subtitlesDirInput = doc.getElementById("subtitlesDir");
    const whisperCheckBtn = doc.getElementById("whisperCheckBtn");
    // Setup-panel step 3 link: jumps to this extension's entry on
    // chrome://extensions so the user can copy the on-disk folder path
    // (works before the server has ever run; a page may not run the .bat
    // itself — see the whisperExtFolderTitle copy for the full flow).
    const extFolderLink = doc.getElementById("extFolderLink");
    const whisperCheckResults = doc.getElementById("whisperCheckResults");
    const whisperCopyCmdBtn = doc.getElementById("whisperCopyCmdBtn");
    const whisperReadyBar = doc.getElementById("whisperReadyBar");
    const whisperTestStatus = doc.getElementById("whisperTestStatus");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const dirtyBanner = doc.getElementById("dirtyBanner");

    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";

    // 2026-08-31 i18n completion: results rendered by the whisper check and
    // diagnostics flows are rebuilt from their last data when the language
    // switches, so a half-Chinese page can never persist after a switch.
    let lastWhisperRenderKind = null; // "check" | "download" | null
    let lastWhisperHealthData = null;
    let diagnosticsHasRun = false;

    function markDirty() {
      if (dirtyBanner) dirtyBanner.classList.remove("is-hidden");
    }

    function clearDirty() {
      if (dirtyBanner) dirtyBanner.classList.add("is-hidden");
    }

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function applyProviderVisibility(provider) {
      const active = settingsApi.normalizeProvider(provider);
      for (const el of providerFieldEls) {
        const isActive = el.dataset.providerField === active;
        el.hidden = !isActive;
      }
    }

    // ------------------------------------------------------------ 
    // Switch-model key dialog (2026-08-29): when the user switches away
    // from a provider whose key field holds a value, ask Keep / Clear.
    // Keep — the key stays stored, so switching back later auto-restores
    // it with no re-entry. Clear — wipe the key from the field AND from
    // storage immediately (key hygiene).
    // ------------------------------------------------------------
    const providerKeyInputs = {
      minimax: minimaxApiKeyInput,
      deepseek: deepseekApiKeyInput,
      glm: glmApiKeyInput,
    };
    const providerDisplayNames = {
      minimax: "minimax",
      deepseek: "DeepSeek",
      glm: "GLM",
    };
    let currentProvider = null;
    let switchKeyResolve = null;

    function closeSwitchKeyDialog(choice) {
      if (!switchKeyDialog) return;
      switchKeyDialog.classList.add("is-hidden");
      const resolve = switchKeyResolve;
      switchKeyResolve = null;
      if (resolve) resolve(choice);
    }

    function promptSwitchKeyChoice(provider) {
      return new Promise((resolve) => {
        if (!switchKeyDialog || !switchKeyDialogBody) {
          resolve("keep");
          return;
        }
        // A dialog left open by rapid provider switching settles as
        // "keep" so its await chain can finish cleanly.
        if (switchKeyResolve) switchKeyResolve("keep");
        switchKeyDialogBody.textContent = translate(
          currentLanguage,
          "switchKeyDialogBody",
          { provider: providerDisplayNames[provider] || provider },
        );
        switchKeyDialog.classList.remove("is-hidden");
        if (switchKeyKeepBtn) switchKeyKeepBtn.focus();
        switchKeyResolve = resolve;
      });
    }

    async function clearProviderKey(provider) {
      const input = providerKeyInputs[provider];
      if (input) input.value = "";
      try {
        const previous = await storage.get(settingsApi.STORAGE_KEY);
        const previousSettings =
          previous[settingsApi.STORAGE_KEY] || settingsApi.DEFAULTS;
        const field = `${provider}ApiKey`;
        if (!previousSettings[field]) return;
        await storage.set({
          [settingsApi.STORAGE_KEY]: settingsApi.normalize({
            ...previousSettings,
            [field]: "",
          }),
        });
      } catch (_error) {
        // The visible field is already empty; submitting the form later
        // also persists the removal. Nothing else to do offline.
      }
    }

    // ------------------------------------------------------------
    // Disable-AI confirmation dialog (2026-08-30): switching the AI
    // provider to "none" asks for explicit confirmation because the
    // summary / overview features stop working. Confirm — stay on
    // "none"; stored keys are kept so switching back auto-restores
    // them (same semantics as the Keep branch above). Cancel — revert
    // the select to the previous provider.
    // ------------------------------------------------------------
    let disableAiResolve = null;

    function closeDisableAiDialog(confirmed) {
      if (!disableAiDialog) return;
      disableAiDialog.classList.add("is-hidden");
      const resolve = disableAiResolve;
      disableAiResolve = null;
      if (resolve) resolve(confirmed);
    }

    function promptDisableAi() {
      return new Promise((resolve) => {
        // Markup missing (test HTML regressed) — fail open so provider
        // switching never deadlocks; the switch itself was explicit.
        if (!disableAiDialog) {
          resolve(true);
          return;
        }
        // A dialog left open by rapid switching settles as "cancel" so
        // its await chain finishes and the safe state (keep AI) wins.
        if (disableAiResolve) disableAiResolve(false);
        disableAiDialog.classList.remove("is-hidden");
        if (disableAiCancelBtn) disableAiCancelBtn.focus();
        disableAiResolve = resolve;
      });
    }

    function applyAsrProviderVisibility(provider) {
      // Fallback is "whisper", NOT "bailian": bailian's <option> is
      // hidden in options.html, so an unknown/missing provider must
      // never light up the bailian block — that showed Alibaba content
      // under a blank dropdown on fresh installs (2026-08-31 report).
      const active = ["bailian", "whisper", "none"].includes(provider)
        ? provider
        : "whisper";
      for (const el of asrFieldEls) {
        el.classList.toggle("is-hidden", el.dataset.asrField !== active);
      }
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        // If the element has child elements, only translate the *last*
        // <span> child (label text). Setting textContent on a parent
        // would destroy child inputs / nested markup.
        if (element.firstElementChild) {
          const target = element.querySelector(
            "span:not([data-i18n-skip])",
          );
          if (target) {
            target.textContent = translate(
              currentLanguage,
              element.dataset.i18n,
            );
          }
          continue;
        }
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-title]")) {
        element.setAttribute(
          "title",
          translate(currentLanguage, element.dataset.i18nTitle),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);

      // Re-render flow results that are already on screen so they follow
      // the new language (check results + diagnostics). The transient
      // download-status row is intentionally NOT re-rendered.
      if (lastWhisperRenderKind === "check") {
        renderWhisperCheckResults(lastWhisperHealthData);
      }
      if (diagnosticsHasRun) void runDiagnostics();
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiProviderSelect.value = settings.provider;
        currentProvider = settings.provider;
        applyProviderVisibility(settings.provider);
        minimaxApiKeyInput.value = settings.minimaxApiKey;
        deepseekApiKeyInput.value = settings.deepseekApiKey;
        if (glmApiKeyInput) glmApiKeyInput.value = settings.glmApiKey;
        if (glmApiTypeSelect) glmApiTypeSelect.value = settings.glmApiType;
        asrApiKeyInput.value = settings.asrApiKey;
        if (asrProviderSelect) {
          // A stored provider with no matching <option> (e.g. legacy
          // "bailian" while the option is hidden) renders a BLANK select
          // — assigning it is a no-op. Snap to the offered default
          // engine so the dropdown always shows a real choice on fresh
          // and legacy profiles alike.
          const offered = Array.from(asrProviderSelect.options).some(
            (option) => option.value === settings.asrProvider,
          );
          const asrValue = offered ? settings.asrProvider : "whisper";
          asrProviderSelect.value = asrValue;
          applyAsrProviderVisibility(asrValue);
        }
        if (whisperUrlText) {
          // 2026-08-29: the URL is fixed (start_whisper_server.bat binds
          // 127.0.0.1:7860) — read-only text, not an editable input.
          whisperUrlText.textContent = settings.whisperUrl || "http://127.0.0.1:7860";
        }
        if (whisperModelSelect) whisperModelSelect.value = settings.whisperModel;
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage;
        if (subtitlesDirInput) subtitlesDirInput.value = settings.subtitlesDir;
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      await loadSettings();
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      // Preserve any custom baseUrl/model the user might have hand-edited in
      // chrome.storage.local by round-tripping it through normalize first.
      const previous = await storage.get(settingsApi.STORAGE_KEY);
      const previousSettings =
        previous[settingsApi.STORAGE_KEY] || settingsApi.DEFAULTS;

      const settings = settingsApi.normalize({
        ...previousSettings,
        provider: aiProviderSelect.value,
        minimaxApiKey: minimaxApiKeyInput.value,
        deepseekApiKey: deepseekApiKeyInput.value,
        glmApiKey: glmApiKeyInput ? glmApiKeyInput.value : "",
        glmApiType: glmApiTypeSelect ? glmApiTypeSelect.value : "",
        asrApiKey: asrApiKeyInput.value,
        asrProvider: asrProviderSelect ? asrProviderSelect.value : "whisper",
        whisperUrl: whisperUrlText ? whisperUrlText.textContent.trim() : "",
        whisperModel: whisperModelSelect ? whisperModelSelect.value : "",
        whisperLanguage: whisperLanguageInput ? whisperLanguageInput.value : "",
        subtitlesDir: subtitlesDirInput ? subtitlesDirInput.value : "",
      });

      const activeKey = settingsApi.activeApiKey(settings);
      // "none" = the user explicitly opted out of AI models (summary
      // and overview stop working; subtitle features unaffected).
      // "other" is a UI-only provider where the user wires their own
      // service via the local-remix prompt. Both save without a key.
      // Every built-in provider (minimax / deepseek / glm) must have
      // its key filled before saving — an empty key would make
      // summary/overview calls fail silently later. A blocked save
      // explains what is missing and reverts the form to the "none"
      // state so what you see is what gets stored.
      if (
        settings.provider !== "none" &&
        settings.provider !== "other" &&
        !activeKey
      ) {
        setStatus(saveStatus, "providerNeedsKey", {
          provider:
            providerDisplayNames[settings.provider] || settings.provider,
        });
        aiProviderSelect.value = "none";
        currentProvider = "none";
        applyProviderVisibility("none");
        return;
      }

      // 2026-08-31: the subtitle cache directory has NO default — a hardcoded
      // fallback would leak the build machine's layout onto other installs
      // (user-reported on a second computer: the field pre-filled with
      // someone else's C:/Users/... path). Fresh installs start empty, and a
      // Whisper user must pick their own directory before anything saves.
      // Scoped to asrProvider === "whisper" because the field lives inside
      // the Whisper settings block: blocking saves for "none"/"bailian"
      // users would surface an error whose input is hidden.
      if (settings.asrProvider === "whisper" && !settings.subtitlesDir) {
        setStatus(saveStatus, "subtitlesDirRequired");
        return;
      }

      try {
        await persistAndVerifySettings(
          storage,
          settingsApi.STORAGE_KEY,
          settings,
        );
        applyProviderVisibility(settings.provider);
        if (asrProviderSelect) applyAsrProviderVisibility(settings.asrProvider);
        clearDirty();
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    // -----------------------------------------------------------------
    // 检查系统 (2026-08-30 transparency rework): READ-ONLY system check.
    // Fetches /health and renders an itemized report:
    //   - server offline -> red, points at setup step 3 (the start bat)
    //   - limited mode   -> python ✓ + each missing dep ✗ + the EXACT
    //                        install command for this machine's python;
    //                        copy / download-script buttons are revealed.
    //                        The check itself installs NOTHING.
    //   - fully ready    -> all ✓ + ready bar with follow-up info.
    // -----------------------------------------------------------------
    async function runWhisperCheck() {
      if (!whisperTestStatus) return;
      whisperTestStatus.textContent = translate(currentLanguage, "whisperCheckRunning");
      if (whisperCheckResults) {
        whisperCheckResults.innerHTML = "";
        whisperCheckResults.hidden = false;
      }
      if (whisperReadyBar) whisperReadyBar.hidden = true;
      if (whisperCopyCmdBtn) whisperCopyCmdBtn.hidden = true;
      if (installDepsBtn) installDepsBtn.hidden = true;
      const r = await pingWhisper(
        whisperUrlText
          ? whisperUrlText.textContent.trim()
          : "http://127.0.0.1:7860",
      );
      renderWhisperCheckResults((r && r.data) || null);
    }

    // Pure renderer for the check flow (2026-08-31 i18n rework): called by
    // runWhisperCheck after a fetch AND by applyLanguage when the UI
    // language changes, so the rendered report always follows the selected
    // language. `health` is the /health body, or null when offline.
    function renderWhisperCheckResults(health) {
      const list = whisperCheckResults;
      if (!list) return;
      lastWhisperRenderKind = "check";
      lastWhisperHealthData = health;
      list.innerHTML = "";
      list.hidden = false;
      if (whisperReadyBar) whisperReadyBar.hidden = true;
      if (whisperCopyCmdBtn) whisperCopyCmdBtn.hidden = true;
      if (installDepsBtn) installDepsBtn.hidden = true;
      const d = health || {};

      // Full path of the launcher, when the NEW server reports its own
      // script location; otherwise guide the user through the extensions
      // page (the sandbox can't see the on-disk install path).
      const batPath = d.server_script
        ? String(d.server_script).replace(/whisper_server\.py$/i, "start_whisper_server.bat")
        : "";
      const batHint = batPath || translate(currentLanguage, "whisperBatHintFallback");

      // Case 1: server not reachable at all.
      if (!health) {
        renderCheckItem(
          list,
          "Whisper server",
          false,
          translate(currentLanguage, "whisperOfflineDetail", { batHint }),
        );
        whisperTestStatus.textContent = translate(currentLanguage, "whisperOfflineStatus");
        return;
      }

      const py = d.python || {};
      const pyExe = py.executable || "";
      // 2026-08-31 PowerShell paste fix (user screenshot report): a line
      // STARTING with a quoted path parses as a string expression in
      // PowerShell and dies on the next token ("unexpected token -m").
      // A BARE space-free path pastes cleanly into BOTH cmd.exe and
      // PowerShell; quotes return only when the path actually needs them
      // (spaces) — where the copyable command stays cmd.exe-flavored and
      // the download-script button remains the shell-proof route.
      const pyCmdRef = /\s/.test(pyExe) ? '"' + pyExe + '"' : pyExe;

      // Case 2: OLD server (pre-2026-08-30 /health) — online, maybe even
      // ok:true, but it reports no python block, so the diagnostics here
      // are incomplete. NEVER call this "ready"; the fix is a restart.
      if (!pyExe) {
        renderCheckItem(
          list,
          "Whisper server",
          false,
          translate(currentLanguage, "whisperOldServerDetail", { batHint }),
        );
        renderCheckItem(
          list,
          translate(currentLanguage, "whisperDepsLabel"),
          null,
          translate(currentLanguage, "whisperOldServerDepsNote"),
        );
        whisperTestStatus.textContent = translate(currentLanguage, "whisperOldServerStatus");
        return;
      }

      renderCheckItem(list, "Python", true, (py.version || "?") + " · " + pyExe);
      const deps = d.deps || {};
      const zhconvOk = deps.zhconv != null;

      // Case 3: limited mode — required deps missing. The command targets
      // the DETECTED python; installing is the user's call.
      if (d.ok === false) {
        renderCheckItem(list, "Whisper server", false, translate(currentLanguage, "whisperLimitedDetail"));
        if (deps.faster_whisper == null) {
          renderCheckItem(list, "faster-whisper", false, translate(currentLanguage, "whisperMissingRequired"));
        }
        renderCheckItem(
          list,
          translate(currentLanguage, "whisperZhconvLabel"),
          zhconvOk,
          zhconvOk ? deps.zhconv : translate(currentLanguage, "whisperZhconvMissingLimited"),
          { optional: true },
        );
        // quoting rule: see pyCmdRef above (PowerShell paste fix).
        const cmd = pyCmdRef + " -m pip install faster-whisper zhconv";
        whisperTestStatus.textContent = translate(currentLanguage, "whisperLimitedStatus", { cmd });
        if (whisperCopyCmdBtn) {
          whisperCopyCmdBtn.hidden = false;
          whisperCopyCmdBtn.dataset.cmd = cmd;
        }
        if (installDepsBtn) installDepsBtn.hidden = false;
        return;
      }

      // Case 4: fully ready (new server + all required deps reported).
      renderCheckItem(
        list,
        "Whisper server",
        true,
        translate(currentLanguage, "whisperOnlineReady", { batPath }),
      );
      renderCheckItem(
        list,
        "faster-whisper",
        true,
        deps.faster_whisper || d.version || translate(currentLanguage, "whisperInstalled"),
      );
      renderCheckItem(
        list,
        translate(currentLanguage, "whisperZhconvLabel"),
        zhconvOk,
        zhconvOk
          ? deps.zhconv
          : translate(currentLanguage, "whisperZhconvMissingHint", { pyExe: pyCmdRef }),
        { optional: true },
      );
      if (whisperReadyBar) {
        whisperReadyBar.hidden = false;
        whisperReadyBar.textContent =
          translate(currentLanguage, "whisperReadyBarCore") +
          (zhconvOk ? "" : translate(currentLanguage, "whisperReadyBarZhconvSuffix"));
      }
      whisperTestStatus.textContent = translate(currentLanguage, "whisperReadyStatus");
    }

    async function copyWhisperInstallCmd() {
      const cmd = (whisperCopyCmdBtn && whisperCopyCmdBtn.dataset.cmd) || "";
      if (!cmd) return;
      try {
        await copyPromptValue(root.navigator.clipboard, cmd);
        if (whisperTestStatus) {
          whisperTestStatus.textContent = translate(currentLanguage, "whisperCopied", { cmd });
        }
      } catch (_error) {
        if (whisperTestStatus) {
          whisperTestStatus.textContent = translate(currentLanguage, "whisperCopyFail");
        }
      }
    }

    async function clearCachedSummaries() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("bilidown_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedSummaries", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await resetContentData(
        storage,
        settingsApi.STORAGE_KEY,
        currentLanguage,
      );
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    form.addEventListener("submit", saveSettings);
    // Any user edit anywhere in the form flips the dirty flag so the red
    // banner reminds them to save. We listen on the form so it covers
    // every current and future field (input, select, textarea).
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    // If the user tries to navigate / close the tab with unsaved changes,
    // ask for confirmation. Browsers show a generic message and ignore the
    // return value, but the side effect of attaching the handler is enough.
    root.addEventListener("beforeunload", (e) => {
      if (dirtyBanner && !dirtyBanner.classList.contains("is-hidden")) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
      return undefined;
    });
    aiProviderSelect.addEventListener("change", async () => {
      const nextProvider = aiProviderSelect.value;
      const previousProvider = currentProvider;
      // Switching to "none" is a one-way feature downgrade — confirm
      // first. Keys are NOT cleared (switch back auto-restores them),
      // so the Keep/Clear dialog intentionally does not stack here.
      if (
        nextProvider === "none" &&
        previousProvider &&
        previousProvider !== "none"
      ) {
        const confirmed = await promptDisableAi();
        if (!confirmed) {
          aiProviderSelect.value = previousProvider;
          applyProviderVisibility(previousProvider);
          return;
        }
        currentProvider = "none";
        applyProviderVisibility("none");
        return;
      }
      currentProvider = nextProvider;
      applyProviderVisibility(nextProvider);
      if (!previousProvider || previousProvider === nextProvider) return;
      const keyInput = providerKeyInputs[previousProvider];
      if (!keyInput || !keyInput.value.trim()) return;
      const choice = await promptSwitchKeyChoice(previousProvider);
      if (choice === "clear") await clearProviderKey(previousProvider);
    });
    if (switchKeyKeepBtn) {
      switchKeyKeepBtn.addEventListener("click", () =>
        closeSwitchKeyDialog("keep"),
      );
    }
    if (switchKeyClearBtn) {
      switchKeyClearBtn.addEventListener("click", () =>
        closeSwitchKeyDialog("clear"),
      );
    }
    if (switchKeyDialog) {
      // Escape and backdrop clicks settle the dialog as "keep" — the
      // safe default (the key stays until explicitly cleared).
      doc.addEventListener("keydown", (event) => {
        if (
          event.key === "Escape" &&
          !switchKeyDialog.classList.contains("is-hidden")
        ) {
          closeSwitchKeyDialog("keep");
        }
      });
      switchKeyDialog.addEventListener("click", (event) => {
        if (event.target === switchKeyDialog) closeSwitchKeyDialog("keep");
      });
    }
    if (disableAiConfirmBtn) {
      disableAiConfirmBtn.addEventListener("click", () =>
        closeDisableAiDialog(true),
      );
    }
    if (disableAiCancelBtn) {
      disableAiCancelBtn.addEventListener("click", () =>
        closeDisableAiDialog(false),
      );
    }
    if (disableAiDialog) {
      // Escape and backdrop clicks settle as "cancel" — the safe
      // default keeps the previously configured AI provider.
      doc.addEventListener("keydown", (event) => {
        if (
          event.key === "Escape" &&
          !disableAiDialog.classList.contains("is-hidden")
        ) {
          closeDisableAiDialog(false);
        }
      });
      disableAiDialog.addEventListener("click", (event) => {
        if (event.target === disableAiDialog) closeDisableAiDialog(false);
      });
    }
    if (asrProviderSelect) {
      asrProviderSelect.addEventListener("change", () => {
        applyAsrProviderVisibility(asrProviderSelect.value);
      });
    }
    if (extFolderLink) {
      extFolderLink.addEventListener("click", (event) => {
        event.preventDefault();
        const extensionId = (chrome.runtime && chrome.runtime.id) || "";
        const targetUrl = "chrome://extensions/?id=" + extensionId;
        // chrome:// URLs cannot be opened by a plain <a href> navigation —
        // the tabs API is the sanctioned route. window.open is only a
        // non-Chrome fallback (tests / non-extension hosts).
        if (chrome.tabs && typeof chrome.tabs.create === "function") {
          chrome.tabs.create({ url: targetUrl });
        } else {
          window.open(targetUrl, "_blank");
        }
      });
    }
    if (whisperCheckBtn) {
      whisperCheckBtn.addEventListener("click", () => {
        void runWhisperCheck();
      });
    }
    if (whisperCopyCmdBtn) {
      whisperCopyCmdBtn.addEventListener("click", () => {
        void copyWhisperInstallCmd();
      });
    }
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedSummaries);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    // ------------------------------------------------------------
    // Diagnostics panel: run health checks on the configured
    // whisper server, B 站 API, and other dependencies. Results
    // rendered as a list of ✓/✗ items.
    // ------------------------------------------------------------
    const runDiagnosticsBtn = doc.getElementById("runDiagnosticsBtn");
    const diagnosticsStatus = doc.getElementById("diagnosticsStatus");
    const diagnosticsResults = doc.getElementById("diagnosticsResults");

    function renderDiagnosticsItem(label, ok, detail) {
      // Default target: the bottom diagnostics card. The whisper setup
      // panel passes its own list via renderCheckItem below.
      renderDiagnosticsItemTo(diagnosticsResults, label, ok, detail);
    }

    function renderCheckItem(listEl, label, ok, detail, opts) {
      renderDiagnosticsItemTo(listEl, label, ok, detail, opts);
    }

    function renderDiagnosticsItemTo(listEl, label, ok, detail, opts) {
      if (!listEl) return;
      // Four states: true = green ✓, false = red ✗, false + opts.optional =
      // amber "!" (optional enhancement not installed — the feature degrades
      // but nothing is broken), null/undefined = neutral grey dash (checked,
      // but not applicable / no action needed).
      const optional = !!(opts && opts.optional);
      const state =
        ok === true ? "ok" : ok === false ? (optional ? "warn" : "fail") : "";
      const li = doc.createElement("li");
      li.className = "diagnostics-item" + (state ? " " + state : "");
      const mark = doc.createElement("span");
      mark.className = "diagnostics-mark";
      mark.textContent =
        state === "ok" ? "✓" : state === "fail" ? "✗" : state === "warn" ? "!" : "–";
      const text = doc.createElement("span");
      text.className = "diagnostics-text";
      const strong = doc.createElement("strong");
      strong.textContent = label;
      text.appendChild(strong);
      if (optional) {
        // Every optional row carries a visible 「可选」 chip, installed or
        // not, so first-time users can tell enhancement from requirement at
        // a glance instead of reading the detail text.
        const badge = doc.createElement("span");
        badge.className = "diagnostics-optional-badge";
        badge.textContent = translate(currentLanguage, "optionalBadge");
        text.appendChild(badge);
      }
      if (detail) {
        const small = doc.createElement("span");
        small.className = "diagnostics-detail";
        small.textContent = " — " + detail;
        text.appendChild(small);
      }
      li.appendChild(mark);
      li.appendChild(text);
      listEl.appendChild(li);
    }

    async function pingWhisper(url) {
      const target = (url || "").replace(/\/+$/, "") + "/health";
      const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
      try {
        const res = await fetch(target, {
          method: "GET",
          signal: ctl ? ctl.signal : undefined,
        });
        if (!res.ok) {
          return { ok: false, detail: "HTTP " + res.status };
        }
        const body = await res.json().catch(() => ({}));
        const missing = (body && Array.isArray(body.missing)) ? body.missing : [];
        return {
          ok: body && body.ok === true,
          detail: body && body.ok === false && missing.length
            ? translate(currentLanguage, "pingLimitedPrefix") + missing.join(", ")
            : body && body.version
              ? "version " + body.version + " · models: " + (body.available_models || []).join(", ")
              : "no JSON body",
          // Full /health body: python {executable, version}, deps {...},
          // missing [...], install_hint — the setup panel renders these.
          data: body || null,
        };
      } catch (e) {
        const msg = e && e.name === "AbortError" ? "5s timeout" : (e && e.message ? e.message : "fetch failed");
        return { ok: false, detail: msg };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function runDiagnostics() {
      if (!diagnosticsResults || !runDiagnosticsBtn) return;
      diagnosticsResults.innerHTML = "";
      diagnosticsResults.hidden = false;
      runDiagnosticsBtn.disabled = true;
      if (diagnosticsStatus) diagnosticsStatus.textContent = translate(currentLanguage, "diagRunning");

      // 1. Extension version
      const manifest = root.chrome && root.chrome.runtime && root.chrome.runtime.getManifest
        ? root.chrome.runtime.getManifest()
        : null;
      renderDiagnosticsItem(
        translate(currentLanguage, "diagVersionLabel"),
        Boolean(manifest && manifest.version),
        manifest ? "v" + manifest.version : translate(currentLanguage, "diagVersionFail"),
      );

      // 2. Saved settings via the SAME adapter loadSettings uses. The old
      // code read window.localStorage directly — real settings live in
      // chrome.storage.local, so every check below saw an empty store and
      // reported 未配置 even on a fully set-up machine (user report
      // 2026-08-29: whisper server running, diagnostics still red ✗).
      let saved = {};
      try {
        const raw = await storage.get(settingsApi.STORAGE_KEY);
        saved = (raw && raw[settingsApi.STORAGE_KEY]) || {};
        renderDiagnosticsItem(
          translate(currentLanguage, "diagStorageLabel"),
          true,
          translate(currentLanguage, "diagStorageOk", { count: Object.keys(saved).length }),
        );
      } catch (e) {
        renderDiagnosticsItem(translate(currentLanguage, "diagStorageLabel"), false, e && e.message ? e.message : translate(currentLanguage, "diagUnknownError"));
      }

      // 3. Whisper server. The URL is a fixed read-only address, so ping it
      // directly — never trust a stored copy. Red only when 本地 Whisper is
      // actually selected; otherwise a down server is a neutral note (the
      // machine is fine, the feature is just not enabled).
      const whisperUrl = "http://127.0.0.1:7860";
      const asrNow = (asrProviderSelect && asrProviderSelect.value) || saved.asrProvider || "none";
      const r = await pingWhisper(whisperUrl);
      const limited = Boolean(r.data && r.data.ok === false);
      if (r.ok) {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagWhisperLabel"),
          true,
          whisperUrl + " — " + r.detail,
        );
      } else if (limited && asrNow === "whisper") {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagWhisperLabel"),
          false,
          whisperUrl + " — " + r.detail + translate(currentLanguage, "diagWhisperLimitedSuffix"),
        );
      } else if (limited) {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagWhisperLabel"),
          null,
          whisperUrl + " — " + r.detail + translate(currentLanguage, "diagWhisperNotEnabledSuffix"),
        );
      } else if (asrNow === "whisper") {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagWhisperLabel"),
          false,
          whisperUrl + " — " + r.detail + translate(currentLanguage, "diagWhisperDownSuffix"),
        );
      } else {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagWhisperLabel"),
          null,
          whisperUrl + " — " + r.detail + translate(currentLanguage, "diagWhisperNotEnabledSuffix"),
        );
      }

      // 4. ASR provider awareness (live form value, seeded by loadSettings)
      const asrMap = {
        none: translate(currentLanguage, "diagAsrNone"),
        bailian: translate(currentLanguage, "diagAsrBailian"),
        whisper: translate(currentLanguage, "diagAsrWhisper"),
      };
      const asrLabel = asrMap[asrNow] || asrNow;
      renderDiagnosticsItem(translate(currentLanguage, "diagAsrLabel"), true, asrLabel);

      // 5. AI provider key presence (live form value; key never displayed)
      const providerNow = (aiProviderSelect && aiProviderSelect.value) || saved.provider || "minimax";
      const keyInput = providerNow === "minimax" ? minimaxApiKeyInput
        : providerNow === "deepseek" ? deepseekApiKeyInput
        : providerNow === "glm" ? glmApiKeyInput
        : null;
      if (providerNow === "none") {
        renderDiagnosticsItem(
          translate(currentLanguage, "diagAiKeyLabel"),
          null,
          translate(currentLanguage, "diagAiKeyNone"),
        );
      } else if (keyInput) {
        const hasKey = Boolean(String(keyInput.value || "").trim());
        renderDiagnosticsItem(
          translate(currentLanguage, "diagAiKeyLabel"),
          hasKey,
          // NOTE: keep inner quotes single/curly — an unescaped ASCII double
          // quote here broke the whole options.js parse (shipped in 79148a3,
          // caught 2026-08-29: options page JS fully dead, whisper fields
          // never appeared when selecting 本地 Whisper).
          hasKey ? translate(currentLanguage, "diagAiKeyConfigured") : translate(currentLanguage, "diagAiKeyMissing"),
        );
      } else {
        renderDiagnosticsItem(translate(currentLanguage, "diagAiKeyLabel"), null, translate(currentLanguage, "diagAiKeyCustom"));
      }

      if (diagnosticsStatus) diagnosticsStatus.textContent = translate(currentLanguage, "diagDone");
      runDiagnosticsBtn.disabled = false;
      diagnosticsHasRun = true;
    }

    if (runDiagnosticsBtn) {
      runDiagnosticsBtn.addEventListener("click", () => {
        void runDiagnostics();
      });
    }

    // ------------------------------------------------------------
    // "Install Whisper deps" button (2026-08-29 rework): Chrome MV3
    // can't start processes, and the old copy-paste command relied on
    // the user opening PowerShell AND being in the right folder
    // (`.\install_whisper_deps.ps1`). Instead we download a fully
    // self-contained setup .bat via chrome.downloads and auto-open it
    // once the download lands — the user just clicks "Run" in the
    // Windows confirmation. The bat is directory-independent and its
    // whole content (what gets pip-installed into which python) is
    // plain text the user can read before running.
    // Fallbacks: plain anchor download, then the copyable command.
    // ------------------------------------------------------------
    const installDepsBtn = doc.getElementById("installDepsBtn");
    if (installDepsBtn) {
      installDepsBtn.addEventListener("click", async () => {
        const filename = "bilidown_whisper_setup.bat";
        const batSource = buildWhisperSetupBat();
        let delivered = false;

        function showStatus(ok) {
          // Transient row — deliberately NOT re-rendered on language switch.
          lastWhisperRenderKind = "download";
          lastWhisperHealthData = null;
          if (whisperTestStatus) {
            whisperTestStatus.textContent = ok
              ? translate(currentLanguage, "installDownloadedStatus")
              : translate(currentLanguage, "installDownloadFailStatus");
          }
          if (whisperCheckResults) {
            whisperCheckResults.hidden = false;
            whisperCheckResults.innerHTML = "";
            renderCheckItem(
              whisperCheckResults,
              translate(currentLanguage, "installRowTitle"),
              ok,
              ok
                ? translate(currentLanguage, "installRowOk")
                : translate(currentLanguage, "installRowFail"),
            );
          }
        }

        // Preferred channel: chrome.downloads + auto-open on complete.
        try {
          const downloadsApi = root.chrome && root.chrome.downloads;
          if (downloadsApi && typeof downloadsApi.download === "function") {
            const blob = new Blob([batSource], {
              type: "application/octet-stream",
            });
            const url = URL.createObjectURL(blob);
            downloadsApi.download(
              { url, filename, saveAs: false },
              (downloadId) => {
                if (
                  root.chrome.runtime.lastError ||
                  downloadId === undefined ||
                  downloadId === null
                ) {
                  return;
                }
                // Auto-open when the download completes so the only
                // remaining click is "Run" in the Windows prompt.
                try {
                  const onChanged = downloadsApi.onChanged;
                  if (!onChanged || typeof onChanged.addListener !== "function") {
                    return;
                  }
                  const listener = (delta) => {
                    if (delta.id !== downloadId) return;
                    if (!delta.state || delta.state.current !== "complete") return;
                    try {
                      onChanged.removeListener(listener);
                    } catch (_e) {}
                    try {
                      downloadsApi.open(delta.id);
                    } catch (_e) {}
                  };
                  onChanged.addListener(listener);
                } catch (_e) {}
              },
            );
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            delivered = true;
          }
        } catch (_e) {
          // Fall through to the anchor download below.
        }

        // Fallback: plain anchor download (http(s)/file contexts).
        if (!delivered) {
          try {
            const blob = new Blob([batSource], {
              type: "application/octet-stream",
            });
            const url = URL.createObjectURL(blob);
            const anchor = doc.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            doc.body.appendChild(anchor);
            anchor.click();
            doc.body.removeChild(anchor);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            delivered = true;
          } catch (_e) {
            // JSDOM / exotic environments: no download channel at all.
          }
        }

        showStatus(delivered);
      });
    }

    // ------------------------------------------------------------
    // Anchor landing (2026-08-29): deep links like
    // options.html#aiProviderCard scroll to and flash the target
    // section (side-panel wizard buttons). Chrome sometimes skips
    // the initial hash scroll on extension pages, so re-scroll on
    // load and on hashchange; :target CSS does the highlight.
    // ------------------------------------------------------------
    const anchorWin = doc.defaultView || root;
    const scrollToAnchorTarget = () => {
      const hash = String(
        (anchorWin && anchorWin.location && anchorWin.location.hash) || "",
      );
      const id = decodeURIComponent(hash.slice(1));
      if (!id) return;
      const el = doc.getElementById(id);
      if (!el || typeof el.scrollIntoView !== "function") return;
      try {
        el.scrollIntoView({ block: "start", behavior: "instant" });
      } catch (e) {
        el.scrollIntoView();
      }
    };
    if (anchorWin && typeof anchorWin.addEventListener === "function") {
      anchorWin.addEventListener("load", scrollToAnchorTarget);
      anchorWin.addEventListener("hashchange", scrollToAnchorTarget);
    }
    scrollToAnchorTarget();

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    buildWhisperSetupBat,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    persistAndVerifySettings,
    readPreferredLanguage,
    resetContentData,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
