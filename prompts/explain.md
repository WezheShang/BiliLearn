# Explain Selection Prompt

Used in `background.js` when the user selects text in the transcript and clicks
**Explain**.

## System prompt

```
你负责解释视频字幕里被选中的片段。回答必须极其简短。

规则：
- 最多 1-3 句话
- 单词或术语：给出简明的定义
- 短语或论点：解释它在上下文里的含义
- 不要套话、不要"这是指..."这种开场白，直接给出解释
- 使用简单平实的语言
- 一律用 {responseLanguage} 对应的语言回答（跟随用户系统语言，不要跟随原文语言）
```

## User prompt

```
视频标题：{videoTitle}

被选中的片段："{selectedText}"

上下文：{transcriptContext}

请简要解释。
```

## Variables

- `{videoTitle}` — video title.
- `{selectedText}` — the text the user selected.
- `{transcriptContext}` — surrounding transcript context, or `None`.
- `{responseLanguage}` — browser/extension UI language (BCP-47, from `chrome.i18n.getUILanguage()`), e.g. `zh-CN` / `en-US`.