// kb-queue.js — KB 增量更新队列消费者（只在 background SW 里运行）。
// 由 background.js importScripts 装载；依赖 KbShared / KbClient / YTD_SETTINGS。
// settings 读取镜像 background.js getSettings() 的做法（storage.local + normalize），
// 不依赖 background 内部函数，保证本文件可独立装载。
(function (global) {
  "use strict";

  const { KB_QUEUE_ALARM, KB_DAILY_ALARM, compressSegmentsForLlm } = global.KbShared;

  async function _getSettings() {
    const stored = await chrome.storage.local.get(global.YTD_SETTINGS.STORAGE_KEY);
    return global.YTD_SETTINGS.normalize(stored[global.YTD_SETTINGS.STORAGE_KEY]);
  }

  // ---- 调度 ----

  async function reschedule() {
    let settings = {};
    try { settings = await _getSettings(); } catch {}
    const enabled = settings.kbEnabled === true && !!settings.kbRootDir;
    await chrome.alarms.clear(KB_QUEUE_ALARM);
    await chrome.alarms.clear(KB_DAILY_ALARM);
    if (!enabled) return;
    const mode = settings.kbUpdateMode || "realtime";
    if (mode === "realtime") {
      chrome.alarms.create(KB_QUEUE_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    } else if (mode === "daily") {
      const next = new Date();
      next.setHours(1, 0, 0, 0);
      if (next <= new Date()) next.setDate(next.getDate() + 1);
      chrome.alarms.create(KB_DAILY_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
    }
  }

  function bindAlarm() {
    chrome.alarms?.onAlarm?.addListener?.((alarm) => {
      if (alarm?.name === KB_QUEUE_ALARM || alarm?.name === KB_DAILY_ALARM) {
        consumeAllQueues().catch((e) => console.warn("[kb-queue] consume failed:", e));
      }
    });
  }

  // ---- 消费 ----

  async function consumeAllQueues() {
    const settings = await _getSettings();
    if (settings.kbEnabled !== true || !settings.kbRootDir) return { ok: true, consumed: 0 };
    if (!(await global.KbClient.health())) return { ok: false, error: "KB_SERVER_OFFLINE" };
    const kbs = await global.KbClient.list(settings.kbRootDir);
    let consumed = 0;
    for (const kb of kbs) {
      if (kb.archived || !kb.build_method || kb.build_method === "raw") continue;
      const pending = await global.KbClient.queue(settings.kbRootDir, kb.name, "pending");
      for (const item of pending) {
        const ok = await consumeOne(settings, kb, item);
        if (ok) consumed += 1;
      }
    }
    return { ok: true, consumed };
  }

  async function consumeOne(settings, kb, item) {
    const root = settings.kbRootDir;
    const sep = root.includes("/") ? "/" : "\\";
    const kbDir = `${root}${sep}${kb.name}`;
    const pendingPath = `${kbDir}${sep}queue${sep}pending${sep}${item.file}`;
    let task = item.task || {};
    let attempts = Number(task.attempts || 0);
    try {
      const videoDoc = await global.KbClient.read(root, `${kbDir}${sep}videos${sep}${task.video_file}`);
      const wikiIndex = await safeRead(root, `${kbDir}${sep}wiki${sep}index.md`);
      const modelDoc = await safeRead(root, `${kbDir}${sep}nvwa${sep}心智模型.md`);
      const readme = await safeRead(root, `${kbDir}${sep}README.md`);

      const prompt = buildPrompt(kb, task, videoDoc.content, wikiIndex, modelDoc, readme);
      const answer = await kbCallLLM(settings, prompt);
      const patch = JSON.parse(extractJson(answer));

      // 写回校验：index/model 必须是非空 markdown；moc/案例 只允许新增或覆盖已知文件名
      const writes = [];
      if (kb.build_method === "karpathy") {
        if (!patch.index_md || typeof patch.index_md !== "string" || patch.index_md.length < 20) {
          throw new Error("LLM_PATCH_INVALID: index_md");
        }
        writes.push([`${kbDir}${sep}wiki${sep}index.md`, patch.index_md]);
        for (const m of patch.moc_updates || []) {
          if (!m.file || !/^[^\\/]+\.md$/.test(m.file) || !m.content || m.content.length < 20) {
            throw new Error("LLM_PATCH_INVALID: moc " + (m.file || "?"));
          }
          writes.push([`${kbDir}${sep}wiki${sep}moc${sep}${m.file}`, m.content]);
        }
      } else {
        if (!patch.model_md || patch.model_md.length < 20) throw new Error("LLM_PATCH_INVALID: model_md");
        writes.push([`${kbDir}${sep}nvwa${sep}心智模型.md`, patch.model_md]);
        for (const c of patch.case_updates || []) {
          if (!c.file || !/^[^\\/]+\.md$/.test(c.file) || !c.content) throw new Error("LLM_PATCH_INVALID: case");
          writes.push([`${kbDir}${sep}nvwa${sep}案例集${sep}${c.file}`, c.content]);
        }
      }
      for (const [p, content] of writes) await global.KbClient.write(root, p, content);
      await appendBuildLog(root, kbDir, kb.build_method, task, "ok");
      await global.KbClient.move(root, pendingPath, `${kbDir}${sep}queue${sep}done${sep}${item.file}`);
      return true;
    } catch (e) {
      attempts += 1;
      task.attempts = attempts;
      task.last_error = String(e && e.message || e);
      try {
        await global.KbClient.write(root, pendingPath, JSON.stringify(task, null, 2));
        if (attempts >= 3) {
          await global.KbClient.move(root, pendingPath, `${kbDir}${sep}queue${sep}failed${sep}${item.file}`);
        }
      } catch {}
      return false;
    }
  }

  async function safeRead(root, path) {
    try { return (await global.KbClient.read(root, path)).content; } catch { return ""; }
  }

  async function appendBuildLog(root, kbDir, method, task, status) {
    const logPath = method === "karpathy" ? `${kbDir}\\wiki\\_meta\\build_log.md` : `${kbDir}\\nvwa\\_meta\\build_log.md`;
    const stamp = new Date().toISOString();
    const line = `\n- ${stamp} · ${task.video_file} · ${status}\n`;
    const prev = await safeRead(root, logPath);
    await global.KbClient.write(root, logPath, (prev || `# build log\n`) + line);
  }

  function buildPrompt(kb, task, videoMd, wikiIndex, modelMd, readme) {
    const meta = task.meta || {};
    const compressed = compressSegmentsForLlm(splitSegments(videoMd), 50);
    const current = kb.build_method === "karpathy" ? wikiIndex : modelMd;
    return [
      `你是知识库增量更新器。构建方法：${kb.build_method === "karpathy" ? "LLM wiki（索引+主题地图）" : "心智模型（思维框架+案例）"}。`,
      `KB：${kb.name}。README：\n${readme.slice(0, 500)}`,
      `\n当前${kb.build_method === "karpathy" ? "索引" : "心智模型"}：\n${current.slice(0, 6000) || "（空，从零创建）"}`,
      `\n新视频元数据：${JSON.stringify(meta)}`,
      `\n新视频字幕压缩采样：\n${compressed.slice(0, 8000)}`,
      `\n只输出一个 JSON 对象，不要多余文字。karpathy 格式：{"index_md": "完整更新后的 index.md", "moc_updates": [{"file": "主题.md", "content": "..."}]}`,
      `nvwa 格式：{"model_md": "完整更新后的 心智模型.md", "case_updates": [{"file": "案例.md", "content": "..."}]}`,
      `规则：不删除已有文件；moc/案例文件名用主题短名；内容用中文。`,
    ].join("\n");
  }

  // 从 md 正文还原段落数组（`## 段 N  [a → b]` 头 + 正文行），供压缩采样。
  function splitSegments(md) {
    const segs = [];
    const re = /^## 段 (\d+)\s+\[([\d.]+)s → ([\d.]+)s\]$/gm;
    let m, last = null;
    while ((m = re.exec(md)) !== null) {
      if (last) segs.push(last);
      last = { start: parseFloat(m[2]), end: parseFloat(m[3]), text: "" };
    }
    if (last) segs.push(last);
    // 文本填充：按行归属到最近一个段头之后
    const lines = md.split(/\r?\n/);
    let idx = -1;
    for (const line of lines) {
      const h = /^## 段 (\d+)/.exec(line);
      if (h) { idx = Number(h[1]) - 1; continue; }
      if (idx >= 0 && segs[idx] && line.trim() && !line.startsWith("#")) segs[idx].text += line.trim() + " ";
    }
    return segs;
  }

  function extractJson(text) {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    if (!m) throw new Error("LLM_NO_JSON");
    return m[0];
  }

  // OpenAI 兼容调用（与 sidepanel 摘要同源的 settings 字段）。
  async function kbCallLLM(settings, prompt) {
    const url = global.YTD_SETTINGS.chatCompletionsUrl(settings);
    const key = global.YTD_SETTINGS.activeApiKey(settings);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.aiModel,
        messages: [
          { role: "system", content: "你是严谨的知识库维护助手，只按用户要求的 JSON 格式输出。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  global.KbQueue = { reschedule, bindAlarm, consumeAllQueues, _getSettings, _splitSegments: splitSegments, _extractJson: extractJson };
})(typeof self !== "undefined" ? self : globalThis);
