# Whisper UI 两层结构验证步骤

## 1. 确认扩展已重新加载

1. 打开 `chrome://extensions/`
2. 找到 bililearn 扩展
3. 点击 🔄 刷新按钮（Reload）
4. 确认版本显示为 `1.0.0`

## 2. 验证默认状态（未勾选）

1. 点击扩展图标 → "设置"
2. 找到 "本地 Whisper（可选）" 卡片
3. **验证点**：
   - 看到 checkbox "启用本地 Whisper 兜底"（默认未勾选）
   - ✅ 下方配置字段（URL、Model、Language、Cache Dir）**应该隐藏**
   - ✅ 界面应该是简洁的，只显示 checkbox

## 3. 验证勾选后的状态（展开）

1. 勾选 "启用本地 Whisper 兜底"
2. **验证点**：
   - ✅ 配置字段**应该展开显示**
   - ✅ 看到 "Whisper server URL" 输入框
   - ✅ 看到 "Whisper 模型" 下拉菜单
   - ✅ 看到 "Whisper 语言" 输入框
   - ✅ 看到 "字幕缓存目录" 输入框
   - ✅ 看到 "测试连接" 按钮

## 4. 验证取消勾选（收起）

1. 取消勾选 "启用本地 Whisper 兜底"
2. **验证点**：
   - ✅ 所有配置字段**应该再次隐藏**
   - ✅ 界面恢复简洁状态

## 5. 测试连接

1. 勾选 Whisper
2. 点击 "测试连接" 按钮
3. **预期结果**：
   - ✅ 显示 "连接成功。faster-whisper xxx，当前模型=xxx，设备=xxx"

## 6. 保存设置

1. 填写 Whisper server URL（默认：`http://127.0.0.1:7860`）
2. 选择模型（建议用 `base` 或 `small`）
3. 选择 AI provider（minimax / DeepSeek / GLM）
4. 填写对应的 API Key
5. 点击 "保存设置" 按钮
6. **预期结果**：
   - ✅ 显示 "设置已保存并验证成功，bililearn 将立即使用新配置。"

## 7. 实际使用验证

1. 打开一个 B 站视频
2. 点击扩展图标 → "获取字幕"
3. 如果 B 站没有原生字幕：
   - ✅ 应该看到 "使用 Whisper 转写中..." 提示
   - ✅ 最终显示转写后的字幕
   - ✅ 字幕上方显示 "🏷️ 本地字幕" 标签

## 故障排查

### 如果配置字段一直展开（不隐藏）

**可能原因**：之前保存的设置里 `whisperEnabled = true`

**解决方法**：
1. 打开 Chrome DevTools (F12)
2. Console 里输入：
```javascript
chrome.storage.local.get('ytd_settings', (data) => {
  console.log(data);
});
```
3. 检查 `ytd_settings.whisperEnabled` 是否为 `true`
4. 如果是，手动清空：
```javascript
chrome.storage.local.set({ 'ytd_settings': { whisperEnabled: false } });
```
5. 刷新设置页面

### 如果无法保存设置

**可能原因**：扩展权限问题或 Chrome 版本不兼容

**解决方法**：
1. 打开 `chrome://extensions/`
2. 点击 "详细信息"
3. 检查权限：
   - ✅ "读取和更改您访问的网站上的数据"
   - ✅ 至少包含 `bilibili.com` 权限
4. 如需，点击 "清除浏览数据" → "缓存的图片和文件"
5. 重新加载扩展

### 如果测试连接失败

**可能原因**：Whisper server 未启动

**解决方法**：
1. 打开 PowerShell
2. 进入 bililearn 目录
3. 运行：
```powershell
python whisper_server.py
```
4. 看到 "Uvicorn running on http://127.0.0.1:7860" 说明启动成功
5. 重新测试连接

## 成功标志

✅ 所有验证点都通过 ✅
✅ Whisper server 运行正常 ✅
✅ 可以成功获取和转写字幕 ✅