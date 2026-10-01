# SQZcinema 配置教程

> 适用版本：1.7.1（manifest id `app.sqzcinema.pro`，作者 萧梧晚）
> 说明：本文按该应用的 manifest.json、presets.json、index.html 实际用到的宿主能力逐条核对而成，不含未使用的功能项。

---

## 0. 这个 APP 到底依赖什么

| 功能 | 用到的能力 | 需要你配什么 |
|-|-|-|
| AI 吐槽 / 纯文本陪看 | `ai.generate`、`characters.read` | ① 一条可用的 LLM API ② 至少一张角色卡 |
| AI 视觉吐槽（看图） | `network.fetch` | APP 内填一个**支持视觉的** OpenAI 兼容接口 |
| 联机观影房 | `online.play` | 站点侧账号模式 + Supabase 联机表 |
| 视频播放 | 无 | 不需要配置，粘贴直链或选本地文件即可 |
| 拉取视觉模型列表 | `network.fetch` | 同上（同一个 Base URL / Key） |
| 昵称、视觉配置的本地保存 | `app.data.read/write` | 无（自动） |

**不需要配置的**：生图 API、Minimax 语音、网易云音乐、Tripo——这个 APP 没有申请也没有调用这些权限。

一句话前置条件：**必须有一条能用的 LLM API + 至少一张角色卡，APP 才会「有人说话」**；联机是额外一步，视觉是可选增强。

---

## 1. 配置 LLM API（必做）

路径：**设置 → API 设置**

1. 新增或检查一条配置，填好三项：**Base URL**、**API Key**、**模型名**。
   - 中转站地址是否以 `/v1` 结尾，按该服务商要求填写。
2. 用页面里的测试功能确认能通，或从工坊的「环境体检 → API 连通性」查看。

**注意避开配额为 0 的渠道**：在作者本机体检时，`cli` 这条返回 **HTTP 429「您的 FLASH 配额不足，总配额 0」**——这类渠道会让 AI 吐槽一直无声失败。把可用的那条绑给这个角色或全局默认。

### 这个 APP 用哪条配置？

`ai.generate` 由宿主按下面顺序解析，APP 自己不选：

1. 生成请求里显式指定的 `apiConfigId`（这个 APP 没传）；
2. 该角色的 **`custom_app:sqzcinema` 专属绑定**；
3. 该角色的**聊天绑定**；
4. **全局默认配置**；
5. 都没有时取**配置列表里的第一条**。

路径：**设置 → 配置绑定**
建议显式配好「全局默认配置」，或给角色绑一条正常渠道，避免落到第 5 条（可能正好是配额为 0 的那条）。

---

## 2. 准备角色卡（必做）

路径：**桌面 → 角色**

- 新建或导入至少一张角色卡。
- 打开 APP 后，在顶部那一排的**角色下拉框**选中要带进影院的角色——没角色时下拉框显示「暂无角色」，点「AI吐槽」不会有任何输出。

角色的**人设、记忆、世界书、日程**由宿主在 `ai.generate` 时自动组装，不需要你额外配置。场景提示词由 APP 自带的 `presets.json` 提供（原理见第 6 节）。

---

## 3. 配置 AI 视觉吐槽（可选增强）

不配也能用：AI 会根据弹幕文本陪你看；配了才能「看见画面」。

路径：**APP 内 → 顶部「AI视觉」按钮**

| 字段 | 填什么 |
|-|-|
| 视觉接口 Base URL | 支持视觉的 OpenAI 兼容接口，**填到 `/v1` 为止**（例：`https://api.openai.com/v1`） |
| API Key | 对应 key（只存本机，不上传） |
| 视觉模型名 | 先填 Base URL + Key → 点「拉取模型」→ 从下拉框选 |
| 启用视觉吐槽 | 勾上并「保存」 |

### 关键细节

1. **Base URL 不要带 `/chat/completions` 或 `/models`**。APP 会自己在后面拼 `/chat/completions`（描述画面）和 `/models`（拉取模型），多填一段就会拼成两遍，报 404。
2. **域名必须落在 manifest 的 `network.allowedDomains` 白名单里**（这是应用自带声明，用户侧改不了；换域名的中转站可能不在名单内）。判定规则：
   - **精确域名**匹配：如 `api.xxx.com` 写在名单里就只放行它；
   - **`*.后缀` 通配**匹配该后缀下的所有域名：名单里的 `*.com` 能匹配 `api.openai.com`，`*.cn` 能匹配任何 `.cn` 域名；
   - **放行名单**：`*.com / *.cn / *.net / *.org / *.io / *.ai / *.cc / *.dev / *.app / *.co / *.top / *.xyz / *.me / *.info / *.site / *.cloud / *.tech / *.online / *.shop / *.club / *.fun / *.plus / *.win / *.eu.org`；
   - **不在名单**的后缀（如 `.vip / .pro / .store / .icu / *.tv / *.gg`）会被拦，报错文案是
     `network.fetch 未在 manifest.network.allowedDomains 声明域名：xxx`；
   - **localhost 和内网地址永远不允许**，`http://192.168.x.x` 的自建中转走不通。
3. 视觉请求走**服务端代理**（APP 里写死了 `proxy: true`），所以不受浏览器跨域限制，但单次最多 120 秒。

### 已知坑：画面较大时视觉会失败

宿主对网络请求体有上限：**131072 字符**（约 128 KB）。APP 抓帧转成 JPEG dataURL 后要 base64 塞进请求体，画质 0.4 的 1080p 帧有可能超限，报错为：

> `network.fetch 请求体不能超过 131072 字符。`

遇到就改抓帧逻辑（附录 B），把帧缩到宽 640 左右再编码。720p 及以下通常没问题。

### 抓帧什么时候不可用（不影响纯文本陪看）

| 视频源 | 能否抓帧 |
|-|-|
| 直链 + 支持 CORS（带 `crossOrigin` 加载成功） | ✅ |
| 直链 + 被 CORS 代理包裹后成功 | ✅ |
| `.m3u8` 流媒体 | ❌ APP 直接跳过代理（分片没法中转） |
| 本地文件（blob URL） | ✅ 同源，必定能抓 |
| 所有代理都失败，退到「无 CORS 直连」 | ❌ 画面能放，但 canvas 被污染，抓帧会被吞掉 |

这时聊天区会提示「当前视频源不支持抓帧，本次无画面上下文」。

---

## 4. 联机观影房（可选，但要先满足站点条件）

### 4.1 APP 侧用法

1. 点「联机房间」→ 填昵称 →「创建新房间」拿到 4 位房号；
2. 朋友点「联机房间」→ 输入房号 →「加入房间」；
3. 房主切视频源会广播给全房；播放进度只有**房主**广播，其他人跟随；
4. 每人可以带自己的角色上桌：各自选角色发弹幕或点「AI吐槽」，**AI 回复会广播给全房**（真人消息 60% 概率触发回复、AI 消息 35%，链式深度超过 3 层自动停）；
5. 退出：房间面板里的「退出当前房间」；房主关 APP 等于关房。

### 4.2 站点侧前提（联机失败基本都是这里）

联机房间**只在登录了联机账号的站点可用**，需要：

1. 部署时**启用账号模式**：`NEXT_PUBLIC_SELF_HOSTED_MODE=false`（单机模式 `true` 没有账号体系，`room.create/join` 会直接抛错，APP 只会提示「创建失败」）；
2. 自建 Supabase 并配置 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`；
3. 在 Supabase SQL Editor 执行仓库里的 **`docs/online-play-supabase.sql`**（联机房间与云端共享的建表脚本）；
4. 配 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`（房间实时同步走这套 anon 通道）。

平台限制（提前知道能少踩坑）：

- 一个 APP 同时只能有一个房间连接；关 APP 自动退房；本版本不支持房主迁移；
- **房主掉线约 50 秒后房间自动结束**（其他人收到「房间已断开」）；
- 限速：每人每秒最多 25 条、单条最多 16000 字符；
- 20 秒内的瞬断不踢人，超时后先消失再重现（重连的同一 userId 会被当作重连，不是新玩家）。

---

## 5. manifest 规范修正（建议做，不影响运行）

当前 manifest 是顶层字段：

```json
"presets": ["presets.json"]
```

按官方《自定义 APP 制作说明》，声明文件的规范位置是 **`resources`**：

```json
"resources": {
  "presets": ["presets.json"]
}
```

**核实结论**：这个写错**不会导致预设失效**——应用包导入时会把 zip 里除 `manifest.json` 和入口文件外的所有文件都收进资源，预设注册是按固定文件名 `presets.json` 读取的，与 `resources` 声明无关；注册后条目会出现在宿主预设管理里，ID 形如 `custom_app_app-sqzcinema-pro_prompt_sqz-cinema-watch-reply`。

所以修不修都能跑，但建议改成规范写法（打包、一致性校验与后续工具都按 `resources` 认）。

- **验证方法**：**设置 → 预设**里应能看到名为「影院观影场景」的条目（tags 带 `sqzcinema`）。看不到才需要重新打包发布。

---

## 6. 预设条目怎么工作（不用改，知道原理即可）

`presets.json` 里的「影院观影场景」tags 为 `["sqzcinema", "watch"]`，APP 调用时传 `appTags: ['sqzcinema','watch']`；规则是「条目 tags ⊆ 本次 appTags」才进入提示词，因此这条能命中。它约束角色：**只说一两句短话、不超过 40 字、不加前缀/标签/引号、不复述剧情、不当解说员**。

角色这段输出会由 APP 直接广播给全房，所以改这条预设就等于改 AI 在电影院里的说话风格（改完需重新发布或换包）。

---

## 7. 报错对照表

| 现象 | 原因 | 处理 |
|-|-|-|
| 点「AI吐槽」无反应 | 没选角色 / 没有角色卡 | 下拉框选中角色 |
| AI 一直不回或回复为空 | LLM 配置不可用（如配额 0 的渠道）、key 错、模型名错 | 换用正常渠道；避开报 429 配额不足的配置 |
| 「创建失败」 | 站点没开账号模式 / 没执行联机 SQL / 未配 Supabase | 见 4.2 |
| 「当前视频源不支持抓帧」 | m3u8，或所有 CORS 代理失败 | 换 mp4 直链或本地文件 |
| 「所有代理均加载失败」 | 直链本身失效或防盗链 | 换源；纯文本陪看仍可用 |
| 拉取模型失败 HTTP 404 | Base URL 多填了 `/chat/completions` 或 `/models` | Base URL 只填到 `/v1` |
| `network.fetch 未在 manifest.network.allowedDomains 声明域名` | 中转域名后缀不在白名单 | 换用白名单内后缀的域名 |
| `network.fetch 请求体不能超过 131072 字符` | 抓帧图太大 | 见附录 B 降低抓帧分辨率 |
| 视觉接口错误 HTTP 4xx | key / 模型名不对，或该模型不支持图片输入 | 用「拉取模型」重新选支持视觉的模型 |

---

## 8. 验收自测（5 步）

1. **设置 → API 设置**：确认有一条可用配置，且不是配额 0 的那条；
2. **设置 → 配置绑定**：给角色或全局默认绑上这条配置；
3. 打开 SQZcinema → 角色下拉框选中角色 → 粘贴一个 mp4 直链「加载直链并广播」→ 房间面板创建房间 → 点「AI吐槽」，确认弹幕区出现角色回复（**到这里纯文本链路已通**）；
4. **APP 内 → AI视觉**：填 Base URL + Key → 拉取模型 → 选模型 → 勾「启用视觉吐槽」→ 保存 → 再点「AI吐槽」，回复前缀应变成「角色名(看图)」；
5. 要联机：换一台设备（或另一个浏览器账号）登录同一站点 → 输入房号加入 → 双方各自「AI吐槽」，确认对方能看到你的 AI 发言。

---

## 附录 A：安全修正（可选，建议做）

APP 把聊天气泡的**发言人名直接塞进 innerHTML**，而它可能是联机同伴的昵称，存在 HTML 注入风险。在 `index.html` 找到：

```js
div.innerHTML = `<b>${s}:</b><span>${t}</span>`;
```

改为（文件里已有 `escapeHtml` 函数）：

```js
div.innerHTML = `<b>${escapeHtml(s)}:</b><span>${escapeHtml(t)}</span>`;
```

另外 `getDisplayName()` 的兜底 `room.selfName` 在 SDK 文档里没有记载（房间对象为 `{ code, isHost, selfUserId, players }`），昵称没存过时可能显示「我」。想更稳可以改用 `room.selfUserId` 截断显示。

## 附录 B：视觉抓帧瘦身（可选，遇 131072 报错时做）

在 `grabFrame()` 里把帧缩到宽 640 再编码，可显著降低请求体体积：

```js
function grabFrame() {
  if (!frameAllowed) return null;
  try {
    const w = player.videoWidth || 0;
    const h = player.videoHeight || 0;
    if (!w || !h) return null;
    const scale = Math.min(1, 640 / w);
    shotCanvas.width = Math.round(w * scale);
    shotCanvas.height = Math.round(h * scale);
    const ctx = shotCanvas.getContext('2d');
    ctx.drawImage(player, 0, 0, shotCanvas.width, shotCanvas.height);
    return shotCanvas.toDataURL('image/jpeg', 0.5);
  } catch (e) {
    return null;
  }
}
```

---

## 附：改完怎么发布

1. 应用市场 → 创作 → 本地测试，找到 SQZcinema 的关联副本（绿标「已上架」）；
2. 「换包」上传改好的 zip（或直接编辑文件保存）；
3. 「发布」提交更新，版本号自动 +1（可手动改）。
   已上架副本被编辑后会显示「有未发布改动」，发布成功后消失。
