/* 图库管家 · 小手机聊天插件（apiVersion 1）v2.1.4
   - 全 SVG 图标，无 emoji
   - 列表条目信息精简，预览信息左对齐
   - 表情包只读保护（可关）
   - 未登记库不硬塞「其它」；大二进制库只扫 key；孤儿置顶固定开启
   - v2.1.1 修复：媒体库主键假设、内嵌 Blob 图、KV 非字符串值、
     聊天扫描阻塞、空库误建、删除计数、ZIP 时间戳、缩略图透明、大字符串哈希
   - v2.1.2 修复：资产库不再把 ttf/otf/woff 等字体误当图片
   - v2.1.3 修复：文件类型细分为 9 类（图片/字体/语音/视频/文档/数据/压缩包/代码/其他）
     并做 UI 重构：第一行纯文字 tab + 右侧「文件类型」按钮（点击展开类型选择面板）、
     右上「更多」菜单（重新扫描 / 批量管理）、批量模式、底部信息栏
   - v2.1.4 修复：
     · shortId 白名单清洗，杜绝 zip 路径遍历
     · extFromMime 拆分 audio/video mpeg、audio/mp4 → m4a，补 x-zip
     · classifyMedia 补 x-zip
     · dataUrlToBytes 放宽 base64 判定（允许 ;base64 后跟参数）
     · makeThumbDataUrl webp 失败回退 png，避免黑块
     · SKIP_DBS 加入 KV_DB_NAME，避免重复全库扫描
     · scanAllChatMessages 循环外一次性取联系人表
     · 扫描失败时顶部状态栏不再立刻隐藏错误信息
     · 移除死代码 openIdbAtLeast */

const MEDIA_DB_NAME = "AiPhoneMediaCacheDB";
const MEDIA_STORE_NAME = "entries";
const ASSET_DB_NAME = "ai_phone_theme_db_v1";
const ASSET_STORE_NAME = "assets";
const MEDIA_REF_RE = /media-?store:\/\/([A-Za-z0-9_.%-]+)/g;
const ASSET_REF_RE = /asset:\/\/([A-Za-z0-9_.%-]+)/g;

const KV_DB_NAME = "AiPhoneKvDB";
const KV_STORE_NAME = "entries";
const CHAT_DB_NAME = "AiPhoneChatDB";
const MEDIA_ID_RE = /\bmc_\d+_[A-Za-z0-9]{3,}/g;
const ASSET_ID_RE = /\b(?:chat_bg_|icon_skin_|dock_skin_|vn_scene_|vn_sprite_|wallpaper_|sticker_|font_|bg_)[A-Za-z0-9_-]{6,}/g;
const DATA_URL_RE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}(?=[^A-Za-z0-9+/=]|$)/g;

// ── 媒体类型分类（v2.1.3） ──────────────────────────
// 统一的 9 个 category。前端筛选按钮、图标、标签、导出目录全部按这套走。

const CATEGORY_LABEL = {
  image: "图片", font: "字体", audio: "语音", video: "视频",
  document: "文档", data: "数据", archive: "压缩包", code: "代码", file: "文件",
};
// 状态栏汇总、导出目录顺序
const CATEGORY_ORDER = ["image", "font", "audio", "video", "document", "data", "archive", "code", "file"];

/**
 * 统一媒体类型判定。
 * 入参 MIME 可能是完整类型（image/png）也可能是含扩展名的宽松串（application/x-font-ttf）。
 * 顺序很关键：具体类型放在大类之前，woff2 必须早于 woff，text/* 的细分先命中。
 */
function classifyMedia(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (!m) return "file";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("font/") || /ttf|otf|woff2?|truetype|opentype/.test(m)) return "font";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  // gzip 要先于 zip 命中，否则 application/gzip 里 indexOf("zip") 会误判；
  // x-zip 覆盖 application/x-zip-compressed（不含 /zip，必须显式列出）
  if (/gzip|x-gzip|x-bzip|x-7z|x-rar|x-tar|x-zip|\/zip|\/rar|\/7z|\/tar/.test(m)) return "archive";
  if (/json|xml|yaml|toml|csv/.test(m)) return "data";
  if (/html|xhtml|\/css|javascript|ecmascript|typescript|x-sh|x-python/.test(m)) return "code";
  if (/pdf|msword|wordprocessingml|spreadsheetml|presentationml|rtf|epub|markdown/.test(m)) return "document";
  if (m.startsWith("text/")) return "document";
  return "file";
}

/** 便捷判断：是不是字体 */
function isFontLike(mime) {
  return classifyMedia(mime) === "font";
}

// ── 资产类型 ────────────────────────────────────────

const ASSET_TYPES = ["chat_bg", "icon_skin", "dock_skin", "vn_scene", "vn_sprite", "wallpaper", "sticker", "font", "bg"];
const ASSET_TYPE_LABEL = { wallpaper: "壁纸", icon_skin: "图标皮肤", dock_skin: "DOCK 皮肤", font: "字体",
  bg: "桌面素材", chat_bg: "聊天背景", sticker: "表情包", vn_scene: "漫卷背景", vn_sprite: "漫卷立绘" };

function assetTypeKey(id) {
  const s = String(id || "");
  for (const t of ASSET_TYPES) if (s.indexOf(t + "_") === 0) return t;
  return "";
}

const USES = {
  chat: { label: "聊天消息", cat: "chat" },        chat_bg: { label: "聊天背景", cat: "chat" },
  moments: { label: "朋友圈", cat: "social" },      xiaohongshu: { label: "小红书", cat: "social" },
  character: { label: "角色卡", cat: "character" }, sticker: { label: "表情包", cat: "character" },
  wallpaper: { label: "壁纸", cat: "theme" },       icon: { label: "图标皮肤", cat: "theme" },
  dock: { label: "DOCK 皮肤", cat: "theme" },       font: { label: "字体", cat: "theme" },
  theme_other: { label: "桌面素材", cat: "theme" },  vn: { label: "漫卷", cat: "creative" },
  story: { label: "剧情玩法", cat: "creative" },     world: { label: "世界构建", cat: "creative" },
  app: { label: "应用素材", cat: "app" },           mascot: { label: "桌宠", cat: "app" },
  plugin: { label: "插件数据", cat: "other" },       other: { label: "其它", cat: "other" },
};
const USE_PRIORITY = ["chat", "chat_bg", "moments", "xiaohongshu", "character", "sticker",
  "wallpaper", "icon", "dock", "font", "theme_other", "vn", "story", "world", "app", "mascot", "plugin", "other"];
const CATS = [
  { id: "all", label: "全部" }, { id: "orphan", label: "未引用" }, { id: "chat", label: "聊天" },
  { id: "social", label: "社交" }, { id: "character", label: "角色" }, { id: "theme", label: "桌面" },
  { id: "creative", label: "剧情" }, { id: "app", label: "应用" }, { id: "other", label: "其它" },
];
const CAT_LABEL = { orphan: "未被引用（孤儿数据）", chat: "聊天", social: "社交内容",
  character: "角色与表情", theme: "桌面与主题", creative: "剧情与创作", app: "应用素材", other: "其它引用" };

const KV_USE_EXACT = {
  ai_phone_characters_v1: "character", ai_phone_character_versions_v1: "character",
  ai_phone_bg_items_v1: "character", ai_phone_sticker_packs_v1: "sticker",
  ai_phone_sticker_assign_v1: "sticker", "ai_phone_theme_profile_v1": "wallpaper",
  "ai_phone_icon_layout_v1": "icon", "ai_phone_icon_layout_v2": "icon",
  "ai_phone_desktop_folders_v1": "icon", "ai_phone_dock_layout_v1": "dock",
  "ai_phone_canvas_pan_v2": "theme_other", "ai_phone_widgets_v1": "theme_other",
  "ai_phone_diy_templates_v1": "theme_other", "css-schemes-v1": "theme_other",
  "chat-app-custom-css": "theme_other", "music-custom-css": "theme_other",
  "calendar-custom-css": "theme_other", "ai_phone_css_assets_v1": "theme_other",
  "music-custom-bg-v1": "theme_other", "ai_phone_mascot_settings_v1": "mascot",
  "moments_cover_asset_v1": "moments", "moments_cover_asset_id": "moments",
  "moments_signature": "moments", "ai_phone_moments_config_v1": "moments",
  "ai_phone_xiaohongshu_state_v1": "xiaohongshu",
  "ai_phone_character_worlds_v1": "world", "ai_phone_character_world_layout_v1": "world",
  "ai_phone_vn_scenes_v1": "vn", "ai_phone_vn_sprites_v1": "vn",
  "ai_phone_story_extra_presets_v1": "story", "ai_phone_cocreate_library_v1": "story",
  "checkphone-settings": "story", "ai_phone_diary_entries_v1": "app",
  "ai_phone_diary_entry_font_asset_v1": "font", "ai_phone_reading_appearance_v1": "app",
  "ai_phone_reading_profile_v1": "app", "ai_phone_shopping_state_v1": "app",
  "ai_phone_wallet_state_v1": "app", "ai_phone_custom_apps_v1": "app",
  "ai_phone_custom_app_icon_styles_v1": "app", "ai_phone_game_state_v1": "app",
  "ai_phone_black_market_state_v1": "app", "ai_phone_resource_hub_profile_v1": "other",
  "chat_plugins_v3": "plugin", "chat_plugin_vars_v2": "plugin",
  "chat_plugin_fragments_v2": "plugin", "chat_plugin_errors_v1": "plugin",
};
const KV_USE_PREFIX = [
  ["chat_plugin_data_v1:", "plugin"], ["checkphone:xiaohongshu", "xiaohongshu"],
  ["xiaohongshu_", "xiaohongshu"], ["ai_phone_xiaohongshu_events_", "xiaohongshu"],
  ["map_world_theme_", "story"], ["music-", "app"], ["ai_phone_custom_app_", "app"],
  ["note_wall_events_", "app"], ["ai_phone_followup", "chat"], ["pending_reply_", "chat"],
];
function useForKvKey(key) {
  const k = String(key || "");
  if (KV_USE_EXACT[k]) return KV_USE_EXACT[k];
  for (const p of KV_USE_PREFIX) if (k.indexOf(p[0]) === 0) return p[1];
  if (/character|avatar/i.test(k)) return "character";
  if (/sticker|emoji/i.test(k)) return "sticker";
  if (/xiaohongshu/i.test(k)) return "xiaohongshu";
  if (/moment/i.test(k)) return "moments";
  if (/vn_|story|map|dwelling|checkphone|interview|cocreate/i.test(k)) return "story";
  if (/world/i.test(k)) return "world";
  if (/mascot/i.test(k)) return "mascot";
  if (/theme|icon|wallpaper|dock|font|css|widget|desktop|diy/i.test(k)) return "theme_other";
  if (/music|reading|diary|calendar|shopping|wallet|menstrual|custom_app/i.test(k)) return "app";
  if (/chat|weixin/i.test(k)) return "chat";
  return "";
}
const DB_USE = {
  "AiPhoneMomentsDB": "moments", "ai_phone_memory_db_v1": "other", "AiPhoneMascotDB": "mascot",
  "reading-db": "app", "reading-raw-files": "app", "reading-appearance-assets": "app",
  "ai_phone_music_db_v1": "app", "AiPhoneStoryDB": "story", "AiPhoneVnDB": "vn",
  "AiPhoneMapDB": "story", "AiPhoneDwellingDB": "story", "AiPhoneCheckPhoneDB": "story",
  "world-builder-scenes": "world", "world-builder-models": "world",
};
const DB_LABEL = { "fmmi_assets_db_v1": "外部资产库（非官方存储）" };
// KV_DB_NAME 已通过 readKvEntries() 精细扫过一遍（useForKvKey），
// 全库遍历时应当跳过，避免重复工作与无意义的 use="" 扫描。
const SKIP_DBS = [MEDIA_DB_NAME, ASSET_DB_NAME, CHAT_DB_NAME, KV_DB_NAME];
const KEY_ONLY_DBS = ["reading-raw-files", "ai_phone_music_db_v1", "world-builder-models"];

// ── SVG 图标 ────────────────────────────────────────

const ICON_PATHS = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5a2 2 0 0 0-2.83 0L6 18"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  video: '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="m22 8-6 4 6 4V8Z"/>',
  file: '<path d="M14.5 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V7.5L14.5 2.5Z"/><path d="M14 2.5V8h5.5"/>',
  font: '<path d="M5 7V4h14v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  document: '<path d="M14.5 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V7.5L14.5 2.5Z"/><path d="M14 2.5V8h5.5"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  data: '<path d="M14.5 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V7.5L14.5 2.5Z"/><path d="M14 2.5V8h5.5"/><path d="m9.5 13.5-2 2 2 2"/><path d="m14.5 13.5 2 2-2 2"/>',
  archive: '<path d="M3.5 6.5h17v3.5h-17z"/><path d="M5 10v8.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/><path d="M10 14.5h4"/>',
  code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 6-3 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  gallery: '<rect x="6" y="2.5" width="15.5" height="15.5" rx="2.5"/><circle cx="12" cy="8.5" r="1.8"/><path d="m20 12.5-2.5-2.5a2.2 2.2 0 0 0-3.1 0L8 16.5"/><path d="M18 22H5a2.5 2.5 0 0 1-2.5-2.5V7"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/>',
  // v2.1.3：筛选按钮图标，三条线左对齐、宽度从上往下递减
  filter: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h5"/>',
};

function svgMarkup(name, size) {
  const s = size || 24;
  const body = ICON_PATHS[name] || "";
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:0 0 auto">' + body + '</svg>';
}
function svgNode(name, size) {
  const tpl = document.createElement("template");
  tpl.innerHTML = svgMarkup(name, size);
  return tpl.content.firstChild;
}
// category 值域已经覆盖所有图标 key，直接查表即可。
function mediaIconName(category) {
  return ICON_PATHS[category] ? category : "file";
}

// ── 只读原因（表情包 / 内嵌图） ──────────────────────

function readonlyKindOf(item) {
  return item && item.readonly ? (item.readonlyKind || "inline") : "";
}
function readonlyLabelOf(item) {
  return readonlyKindOf(item) === "sticker" ? "表情包" : "内嵌图片";
}
function readonlyHintOf(item) {
  const k = readonlyKindOf(item);
  if (k === "sticker") return "表情包请到应用内的表情管理里修改或删除，这里不提供删除。";
  if (k === "inline") return "内嵌图片，需要到原位置修改或删除。";
  return "";
}

// ── 样式 ────────────────────────────────────────────

const CSS = `
.mg-entry{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;
  border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.10);color:inherit;
  font-size:12px;line-height:1.2;cursor:pointer}
.mg-entry:active{opacity:.55}

.mg-root{--mg-bg:#f2f2f7;--mg-card:#fff;--mg-text:#000;--mg-sub:#8a8a8e;
  --mg-sep:rgba(60,60,67,.13);--mg-blue:#007aff;--mg-red:#ff3b30;--mg-orphan:#ff9500;
  position:relative;display:flex;flex-direction:column;max-height:86vh;background:var(--mg-bg);
  color:var(--mg-text);border-radius:18px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif}
.mg-root.mg-dark{--mg-bg:#1c1c1e;--mg-card:#2c2c2e;--mg-text:#fff;--mg-sub:#98989d;
  --mg-sep:rgba(84,84,88,.5);--mg-blue:#0a84ff;--mg-red:#ff453a;--mg-orphan:#ff9f0a}

/* 导航栏（含右上「更多」下拉菜单） */
.mg-nav{position:relative;display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:.5px solid var(--mg-sep)}
.mg-navtitle{flex:1;text-align:center;font-size:16px;font-weight:600}
.mg-navbtn{border:0;background:transparent;color:var(--mg-blue);font-size:14px;padding:4px 2px;cursor:pointer}
.mg-navbtn:active{opacity:.5}
.mg-menu{position:absolute;top:calc(100% + 4px);right:12px;background:var(--mg-card);
  border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.20);
  overflow:hidden;z-index:10;min-width:150px}
.mg-menu[hidden]{display:none}
.mg-menu button{display:block;width:100%;border:0;background:transparent;color:var(--mg-text);
  font-size:14px;text-align:left;padding:12px 18px;cursor:pointer}
.mg-menu button + button{border-top:.5px solid var(--mg-sep)}
.mg-menu button:active{background:rgba(127,127,127,.12)}

/* 顶部状态栏（仅扫描时显示） */
.mg-status{padding:8px 16px 2px;font-size:12px;color:var(--mg-sub);line-height:1.55;white-space:pre-line}
.mg-status[hidden]{display:none}

/* 第一行：模块分类纯文字 tab（选中变蓝 + 下划线）+ 右侧「文件类型」筛选按钮 */
.mg-tabsrow{position:relative;display:flex;align-items:stretch;
  padding:0 12px;border-bottom:.5px solid var(--mg-sep)}
.mg-tabs{flex:1;min-width:0;display:flex;overflow-x:auto;scrollbar-width:none;
  -webkit-overflow-scrolling:touch}
.mg-tabs::-webkit-scrollbar{display:none}
.mg-tab{flex:0 0 auto;border:0;background:transparent;color:var(--mg-sub);
  font-size:13.5px;padding:11px 10px;cursor:pointer;position:relative;white-space:nowrap}
.mg-tab.mg-on{color:var(--mg-blue);font-weight:600}
.mg-tab.mg-on::after{content:"";position:absolute;left:10px;right:10px;bottom:-.5px;
  height:2px;background:var(--mg-blue);border-radius:1px}
.mg-tab:active{opacity:.7}

.mg-kindpick{flex:0 0 auto;border:0;background:transparent;color:var(--mg-sub);
  font-size:12.5px;padding:0 0 0 12px;cursor:pointer;align-self:center;
  display:inline-flex;align-items:center;gap:5px}
.mg-kindpick.mg-on{color:var(--mg-blue)}
.mg-kindpick:active{opacity:.7}

.mg-kindpicker{position:absolute;top:calc(100% + 6px);right:12px;background:var(--mg-card);
  border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.20);padding:10px;z-index:10;
  display:grid;grid-template-columns:repeat(3,1fr);gap:6px;width:min(300px, 90vw)}
.mg-kindpicker[hidden]{display:none}
.mg-kindpicker button{border:0;background:rgba(127,127,127,.10);color:var(--mg-text);
  font-size:12.5px;padding:10px 6px;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;white-space:nowrap}
.mg-kindpicker button.mg-on{background:var(--mg-blue);color:#fff}
.mg-kindpicker button:active{opacity:.7}

/* 列表 */
.mg-list{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:0 12px 12px;min-height:160px}
.mg-grouptitle{padding:12px 4px 6px;font-size:12.5px;color:var(--mg-sub)}
.mg-card{background:var(--mg-card);border-radius:12px;overflow:hidden}
.mg-item{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
.mg-item+.mg-item{border-top:.5px solid var(--mg-sep)}
.mg-item.mg-on{background:rgba(0,122,255,.10)}
.mg-item.mg-orphan .mg-name{color:var(--mg-orphan)}
.mg-thumb{width:var(--mg-thumb,56px);height:var(--mg-thumb,56px);flex:0 0 auto;border-radius:9px;
  background:rgba(127,127,127,.16);display:flex;align-items:center;justify-content:center;
  overflow:hidden;color:var(--mg-sub)}
.mg-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.mg-info{flex:1;min-width:0}
.mg-name{font-size:14.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mg-sub{font-size:12px;color:var(--mg-sub);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mg-check{width:22px;height:22px;flex:0 0 auto;border-radius:50%;border:1.5px solid rgba(127,127,127,.5);
  display:flex;align-items:center;justify-content:center;color:transparent}
.mg-item.mg-on .mg-check{background:var(--mg-blue);border-color:var(--mg-blue);color:#fff}
.mg-item.mg-readonly .mg-check{border-style:dashed}
/* v2.1.3：勾选圈只在批量模式显示 */
.mg-root:not(.mg-batch) .mg-check{display:none}
.mg-badge{font-size:11px;padding:2px 7px;border-radius:999px;flex:0 0 auto;margin-left:6px;
  background:rgba(255,149,0,.16);color:var(--mg-orphan);border:.5px solid rgba(255,149,0,.35)}
.mg-badge.mg-badge-inline{background:rgba(127,127,127,.14);color:var(--mg-sub);border-color:transparent}
.mg-empty{padding:36px 12px;text-align:center;font-size:13px;color:var(--mg-sub)}
.mg-empty svg{margin:0 auto;opacity:.5}
.mg-empty .mg-empty-msg{margin-top:8px}
.mg-more{padding:14px 0 4px;text-align:center;font-size:12px;color:var(--mg-sub)}

/* 底部栏：默认统计（居中），批量模式切换为操作栏 */
.mg-footer{border-top:.5px solid var(--mg-sep);padding:10px 12px;min-height:44px;
  display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.mg-footer-status{font-size:11.5px;color:var(--mg-sub);text-align:center;line-height:1.55;
  white-space:pre-line;width:100%}
.mg-footer-status[hidden]{display:none}
.mg-footer-actions{display:flex;align-items:center;gap:6px;width:100%}
.mg-footer-actions[hidden]{display:none}
.mg-footer-info{flex:1;min-width:0;font-size:12px;color:var(--mg-sub);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mg-footer button{border:0;background:rgba(127,127,127,.14);color:var(--mg-blue);font-size:12.5px;
  padding:7px 10px;border-radius:9px;cursor:pointer;flex:0 0 auto}
.mg-footer button:disabled{opacity:.4;color:var(--mg-sub)}
.mg-footer button.mg-danger{color:var(--mg-red)}

/* 弹窗 & 预览 */
.mg-overlay{position:absolute;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;
  justify-content:center;padding:24px;z-index:5}
.mg-dialog{width:min(320px,100%);background:var(--mg-card);border-radius:14px;padding:18px 16px 14px;color:var(--mg-text)}
.mg-dialog h4{margin:0 0 8px;font-size:16px;font-weight:600;text-align:center}
.mg-dialog p{margin:0 0 14px;font-size:12.5px;color:var(--mg-sub);line-height:1.65;white-space:pre-line}
.mg-dialog-actions{display:flex;gap:8px}
.mg-dialog-actions button{flex:1;border:0;background:rgba(127,127,127,.14);color:var(--mg-blue);
  font-size:14px;padding:9px 0;border-radius:10px;cursor:pointer}
.mg-dialog-actions button.mg-danger{color:#fff;background:var(--mg-red)}

.mg-preview{position:absolute;inset:0;background:rgba(0,0,0,.88);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:14px;z-index:6;padding:20px}
.mg-preview img{max-width:100%;max-height:56%;object-fit:contain;border-radius:10px;background:rgba(255,255,255,.06)}
.mg-preview .mg-pv-holder{max-width:100%;min-height:80px;display:flex;align-items:center;
  justify-content:center;color:#fff;opacity:.7}
.mg-pv-meta{width:100%;max-width:420px;color:#fff;font-size:12px;line-height:1.75;
  background:rgba(255,255,255,.06);border-radius:12px;padding:10px 14px;
  max-height:34vh;overflow:auto;-webkit-overflow-scrolling:touch}
.mg-pv-row{display:flex;gap:10px;align-items:flex-start}
.mg-pv-row + .mg-pv-row{margin-top:2px}
.mg-pv-key{flex:0 0 auto;min-width:64px;opacity:.55}
.mg-pv-val{flex:1;min-width:0;word-break:break-all;opacity:.95}
.mg-pv-note{margin-top:6px;font-size:11.5px;opacity:.6;line-height:1.6}
.mg-preview .mg-pv-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.mg-preview button{border:0;background:rgba(255,255,255,.16);color:#fff;font-size:13px;
  padding:8px 16px;border-radius:999px;cursor:pointer}
.mg-preview button.mg-danger{background:rgba(255,69,58,.85)}
.mg-preview button:disabled{opacity:.45;background:rgba(255,255,255,.08);cursor:not-allowed}

/* 设置页入口 */
.mg-setwrap{padding:2px 0}
.mg-setrow{display:flex;align-items:center;gap:12px;padding:12px 4px}
.mg-settitle{font-size:15px;font-weight:500}
.mg-setsub{font-size:12px;opacity:.6;margin-top:4px;line-height:1.5}
.mg-setbtn{display:inline-flex;align-items:center;gap:6px;border:0;background:rgba(0,122,255,.14);
  color:#007aff;font-size:13px;padding:8px 14px;border-radius:10px;cursor:pointer;flex:0 0 auto}
`;

// v2.1.3：类型筛选候选（点击「文件类型」按钮后展开面板）
const KIND_ORDER = ["all", "image", "audio", "video", "font", "document", "data", "archive", "code", "file"];
const KIND_LABEL = { all: "全部类型", image: "图片", audio: "语音", video: "视频",
  font: "字体", document: "文档", data: "数据", archive: "压缩包", code: "代码", file: "其他" };

const SHELL_HTML = [
  '<div class="mg-nav">',
  '<button type="button" class="mg-navbtn" data-act="close">关闭</button>',
  '<div class="mg-navtitle">图库管家</div>',
  '<button type="button" class="mg-navbtn mg-navbtn-more" data-el="moreBtn" data-act="more">更多</button>',
  '<div class="mg-menu" data-el="menu" hidden>',
  '<button type="button" data-act="rescan">重新扫描</button>',
  '<button type="button" data-act="batch">批量管理</button>',
  '</div>',
  '</div>',
  '<div class="mg-status" data-el="status" hidden></div>',
  // 第一行：模块分类 tab + 右侧「文件类型」筛选按钮
  '<div class="mg-tabsrow">',
  '<div class="mg-tabs" data-el="seg">',
  CATS.map(c => `<button type="button" class="mg-tab" data-filter="${c.id}">${c.label}</button>`).join(""),
  '</div>',
  '<button type="button" class="mg-kindpick" data-act="kindpick">',
  '<span data-el="kindCur">文件类型</span>',
  svgMarkup("filter", 12),
  '</button>',
  '<div class="mg-kindpicker" data-el="kindpicker" hidden>',
  KIND_ORDER.map(k => `<button type="button" data-kindpick="${k}">${KIND_LABEL[k]}</button>`).join(""),
  '</div>',
  '</div>',
  '<div class="mg-list" data-el="list"></div>',
  '<div class="mg-footer" data-el="footer">',
  '<div class="mg-footer-status" data-el="footerStatus">准备中…</div>',
  '<div class="mg-footer-actions" data-el="footerActions" hidden>',
  '<span class="mg-footer-info" data-el="barinfo"></span>',
  '<button type="button" data-act="all">全选</button>',
  '<button type="button" data-act="invert">反选</button>',
  '<button type="button" data-act="zip">导出</button>',
  '<button type="button" class="mg-danger" data-act="del">删除</button>',
  '</div>',
  '</div>',
].join("");

// ── 通用工具 ────────────────────────────────────────

function detectDark() {
  try {
    const html = document.documentElement;
    const body = document.body;
    const attr = [
      html.getAttribute("data-theme") || "",
      html.className || "",
      body ? body.className || "" : "",
    ].join(" ").toLowerCase();
    if (attr.indexOf("dark") >= 0) return true;
    if (attr.indexOf("light") >= 0) return false;
    const bg = getComputedStyle(body || html).backgroundColor || "";
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (m) {
      const parts = m[1].split(",").map(v => parseFloat(v.trim()));
      if (parts.length >= 3 && parts.slice(0, 3).every(v => Number.isFinite(v))) {
        const lum = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
        return lum < 0.5;
      }
    }
  } catch (e) { /* ignore */ }
  try { return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches; }
  catch (e) { return false; }
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  const t = Number(ms) || 0;
  if (!t) return "时间未知";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "时间未知";
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// v2.1.4：白名单清洗，防止 id 里含 / .. 等字符污染 ZIP 条目名（Zip Slip）。
// 注意：替换是 1:1 的，不会改变长度，所以放在 slice 前后都可以。
function shortId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(-6);
}

// 修复 #14：超大字符串（内嵌 base64）不再全量遍历，改为「长度 + 头尾采样」
function hashStr(s) {
  const str = String(s || "");
  const len = str.length;
  let h = 5381;
  const headEnd = Math.min(len, 256);
  for (let i = 0; i < headEnd; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  if (len > 512) {
    const tailStart = len - 256;
    for (let i = tailStart; i < len; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  } else if (len > 256) {
    for (let i = headEnd; i < len; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36) + "_" + len.toString(36);
}

function mediaLabel(item) {
  if (item.isImage) return "图片";
  return CATEGORY_LABEL[item.category] || "文件";
}

function sourceLabel(item) {
  return item.source === "asset" ? "素材资产库" : item.source === "media" ? "媒体库"
    : item.source === "inline" ? "内嵌图片" : "库内图片";
}

// v2.1.3：补齐常见扩展名。顺序要点：
//   - woff2 先于 woff
//   - audio/* 与 video/* 特定类型先于通用后缀（audio/mpeg → mp3、video/mpeg → mpg、
//     audio/mp4 → m4a、video/mp4 → mp4）
//   - x-zip / x-rar / x-7z / x-tar / gzip 先于 zip（x-zip-compressed 不含 "/zip"）
//   - wordprocessingml / spreadsheetml / presentationml 先于 msword
//   - html 先于 text
function extFromMime(mime, category) {
  const m = String(mime || "").toLowerCase();
  const table = [
    // 图片
    ["png", "png"], ["jpeg", "jpg"], ["jpg", "jpg"], ["webp", "webp"], ["gif", "gif"],
    ["bmp", "bmp"], ["svg", "svg"], ["heic", "heic"], ["avif", "avif"],
    // 字体（woff2 先于 woff）
    ["woff2", "woff2"], ["woff", "woff"], ["ttf", "ttf"], ["otf", "otf"],
    // 音频（特定 MIME 先于通用后缀，避免 video/mpeg 被当 mp3）
    ["audio/mpeg", "mp3"], ["audio/mp3", "mp3"], ["audio/mp4", "m4a"],
    ["audio/wav", "wav"], ["audio/ogg", "ogg"], ["audio/flac", "flac"],
    ["audio/aac", "aac"], ["audio/webm", "weba"],
    ["mp3", "mp3"], ["wav", "wav"], ["ogg", "ogg"], ["flac", "flac"], ["m4a", "m4a"], ["aac", "aac"],
    // 视频（特定 MIME 先于通用后缀）
    ["video/mp4", "mp4"], ["video/mpeg", "mpg"], ["video/quicktime", "mov"], ["video/webm", "webm"],
    ["mp4", "mp4"], ["webm", "webm"], ["quicktime", "mov"], ["mpeg", "mpg"],
    // 压缩包（gzip 先于 zip；x-zip 先于 /zip）
    ["gzip", "gz"], ["x-gzip", "gz"], ["x-bzip", "bz2"], ["x-7z", "7z"], ["x-rar", "rar"], ["x-tar", "tar"],
    ["x-zip", "zip"], ["/zip", "zip"], ["/rar", "rar"], ["/7z", "7z"], ["/tar", "tar"],
    // 数据
    ["json", "json"], ["xml", "xml"], ["yaml", "yaml"], ["toml", "toml"], ["csv", "csv"],
    // 代码
    ["html", "html"], ["xhtml", "xhtml"], ["css", "css"], ["typescript", "ts"], ["javascript", "js"],
    // 文档（wordprocessingml 先于 msword）
    ["pdf", "pdf"], ["rtf", "rtf"], ["epub", "epub"], ["markdown", "md"],
    ["wordprocessingml", "docx"], ["spreadsheetml", "xlsx"], ["presentationml", "pptx"], ["msword", "doc"],
    ["plain", "txt"], ["text", "txt"],
  ];
  for (const [needle, ext] of table) { if (m.indexOf(needle) >= 0) return ext; }
  if (category === "image") return "png";
  if (category === "font") return "ttf";
  if (category === "audio") return "mp3";
  if (category === "video") return "mp4";
  if (category === "document") return "txt";
  if (category === "data") return "json";
  if (category === "archive") return "zip";
  if (category === "code") return "txt";
  return "bin";
}

function uniqueName(item, used) {
  const d = new Date(Number(item.createdAt) || Date.now());
  const p = (v) => String(v).padStart(2, "0");
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${shortId(item.id)}`;
  const ext = extFromMime(item.mimeType, item.category);
  let name = `${base}.${ext}`;
  let n = 2;
  while (used.has(name)) { name = `${base}_${n}.${ext}`; n += 1; }
  used.add(name);
  return name;
}

function triggerDownload(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      try { a.remove(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
    }, 15000);
    return true;
  } catch (e) {
    return false;
  }
}

function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return 0;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1);
  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return new Uint8Array(0);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new Uint8Array(0);
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  // v2.1.4：放宽 base64 判定，允许 ";base64" 后面还有 ";charset=xxx" 等参数
  if (/;base64(;|$)/i.test(meta)) {
    try {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (e) { return new Uint8Array(0); }
  }
  try {
    const decoded = decodeURIComponent(payload);
    return new TextEncoder().encode(decoded);
  } catch (e) { return new Uint8Array(0); }
}

// 从 dataUrl 前缀解析真实 MIME（font/ttf、application/json 等）
function parseDataUrlMime(dataUrl) {
  if (typeof dataUrl !== "string") return "";
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m ? m[1].toLowerCase() : "";
}

function makeThumbDataUrl(dataUrl, maxSize) {
  const size = maxSize || 96;
  return new Promise(resolve => {
    if (typeof dataUrl !== "string" || !dataUrl) { resolve(""); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(dataUrl); return; }
        const scale = Math.min(1, size / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const c = canvas.getContext("2d");
        if (!c) { resolve(dataUrl); return; }
        c.drawImage(img, 0, 0, cw, ch);
        // v2.1.4：优先 webp 保留透明通道；若浏览器不支持，toDataURL 会静默回落到 PNG
        // （此时 data: 前缀不是 image/webp），我们再显式取一次 PNG。
        let out = "";
        try { out = canvas.toDataURL("image/webp", 0.7); } catch (e) { out = ""; }
        if (!out || out.indexOf("data:image/webp") !== 0) {
          try { out = canvas.toDataURL("image/png"); } catch (e) { out = dataUrl; }
        }
        resolve(out || dataUrl);
      } catch (e) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// 修复 #1：把 Blob 内嵌图转为 dataURL，供缩略图/预览/导出共用。
function blobToDataUrl(blob) {
  return new Promise(resolve => {
    if (!blob) { resolve(""); return; }
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    } catch (e) { resolve(""); }
  });
}

// ── ZIP 打包 ─────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  // ZIP 时间戳不支持 1980 年之前，clamp 到 1980/1/1
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
  const day = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralParts = [];
  let offset = 0;
  const dt = dosDateTime(new Date());

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dt.time, true);
    lv.setUint16(12, dt.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dt.time, true);
    cv.setUint16(14, dt.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    chunks.push(local, data);
    centralParts.push(cd);
    offset += local.length + size;
  }

  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...chunks, ...centralParts, eocd], { type: "application/zip" });
}

// ── IndexedDB 访问 ──────────────────────────────────

async function tryOpenExisting(name) {
  const names = await existingDbNames();
  if (names && names.indexOf(name) < 0) return null;
  return new Promise((resolve, reject) => {
    let created = false;
    let req;
    try { req = indexedDB.open(name); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { created = true; };
    req.onsuccess = () => {
      const db = req.result;
      if (created) {
        // 修复 #4：库原本不存在被我们意外创建，立刻关闭并删掉，不留空库。
        try { db.close(); } catch (e) { /* ignore */ }
        try { indexedDB.deleteDatabase(name); } catch (e) { /* ignore */ }
        resolve(null);
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
    req.onblocked = () => reject(new Error("IndexedDB 被占用"));
  });
}

async function existingDbNames() {
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      const list = await indexedDB.databases();
      if (Array.isArray(list)) return list.map(d => (d && d.name) || "").filter(Boolean);
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function readKvEntries() {
  const db = await tryOpenExisting(KV_DB_NAME).catch(() => null);
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains(KV_STORE_NAME)) return [];
    const rows = [];
    const tx = db.transaction(KV_STORE_NAME, "readonly");
    const req = tx.objectStore(KV_STORE_NAME).openCursor();
    await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        const v = c.value || {};
        // 修复 #5：不再对 value 做 String()，否则对象会被压成 "[object Object]"，
        // 导致里面的 media-store:// / asset:// 引用全部漏扫、图片被误判为孤儿。
        if (typeof v.key === "string") rows.push({ key: v.key, value: v.value });
        c.continue();
      };
      req.onerror = () => reject(req.error || new Error("读取 KV 库失败"));
    });
    return rows;
  } finally { db.close(); }
}

async function readMediaEntries() {
  const db = await tryOpenExisting(MEDIA_DB_NAME).catch(() => null);
  if (!db) return { entries: [], missing: true };
  try {
    if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) return { entries: [], missing: true };
    const entries = [];
    const tx = db.transaction(MEDIA_STORE_NAME, "readonly");
    const req = tx.objectStore(MEDIA_STORE_NAME).openCursor();
    await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const value = cursor.value || {};
        const blob = value.blob;
        const mime = String(value.mimeType || (blob && blob.type) || "");
        // 修复 #2：IDB 的 get/delete 只认主键，value.id 只是记录内部字段
        const storeKey = cursor.primaryKey;
        const id = (typeof value.id === "string" && value.id) ? value.id : String(storeKey);
        // v2.1.3：宿主明确给出非 file 的 mediaCategory 就尊重它；
        // 否则（空或 "file"）用 classifyMedia 按 MIME 细分到具体类型。
        const hostCategory = String(value.mediaCategory || "").trim().toLowerCase();
        const detailed = classifyMedia(mime);
        const category = (hostCategory && hostCategory !== "file") ? hostCategory : detailed;
        entries.push({
          id,
          storeKey,
          mimeType: mime,
          category,
          createdAt: Number(value.createdAt) || 0,
          size: blob && typeof blob.size === "number" ? blob.size : 0,
        });
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error("读取媒体库失败"));
    });
    return { entries, missing: false };
  } finally { db.close(); }
}

// 修复 #2：按 storeKey（真实主键）读取，而不是按 value.id。
async function loadMediaBlobById(storeKey) {
  const db = await tryOpenExisting(MEDIA_DB_NAME).catch(() => null);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) return null;
    const tx = db.transaction(MEDIA_STORE_NAME, "readonly");
    const req = tx.objectStore(MEDIA_STORE_NAME).get(storeKey);
    const value = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("读取失败"));
    });
    return value && value.blob ? value.blob : null;
  } finally { db.close(); }
}

// 修复 #2 / 安全 B：按真实主键删除，并返回「真实删除条数」
// 用 get + onsuccess 的方式精确判断存在性，避免 IDB delete 对不存在 key 也返回成功导致计数虚高。
async function deleteMediaByIds(storeKeys) {
  if (!storeKeys || !storeKeys.length) return 0;
  const db = await tryOpenExisting(MEDIA_DB_NAME).catch(() => null);
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) return 0;
    let deleted = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE_NAME, "readwrite");
      const store = tx.objectStore(MEDIA_STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("删除失败"));
      tx.onabort = () => reject(tx.error || new Error("删除被中止"));
      for (const k of storeKeys) {
        const g = store.get(k);
        g.onsuccess = () => {
          if (g.result !== undefined) {
            const d = store.delete(k);
            d.onsuccess = () => { deleted += 1; };
          }
        };
      }
    });
    return deleted;
  } finally { db.close(); }
}

// ── 素材资产库 ──────────────────────────────────────

async function readAssetEntries() {
  const db = await tryOpenExisting(ASSET_DB_NAME);
  if (!db) return { entries: [], missing: true };
  try {
    if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) return { entries: [], missing: true };
    const entries = [];
    const tx = db.transaction(ASSET_STORE_NAME, "readonly");
    const req = tx.objectStore(ASSET_STORE_NAME).openCursor();
    await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const value = cursor.value || {};
        const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : "";
        if (dataUrl) {
          // 修复 #2：保留真实主键 storeKey
          const storeKey = cursor.primaryKey;
          const id = (typeof value.id === "string" && value.id) ? value.id : String(storeKey);
          // v2.1.2：从 dataUrl 解析真实 MIME（font/ttf、application/json 等），
          // 不再默认 image/jpeg——否则字体会被一路当图片。
          const inlineMime = parseDataUrlMime(dataUrl);
          const mimeType = inlineMime || String(value.mimeType || "");
          entries.push({
            id,
            storeKey,
            mimeType,
            type: String(value.type || ""),
            createdAt: Date.parse(value.updatedAt || "") || 0,
            size: estimateDataUrlBytes(dataUrl),
          });
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error("读取素材资产库失败"));
    });
    return { entries, missing: false };
  } finally { db.close(); }
}

async function loadAssetDataUrlById(storeKey) {
  const db = await tryOpenExisting(ASSET_DB_NAME);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) return null;
    const tx = db.transaction(ASSET_STORE_NAME, "readonly");
    const req = tx.objectStore(ASSET_STORE_NAME).get(storeKey);
    const value = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("读取失败"));
    });
    return value && typeof value.dataUrl === "string" ? value.dataUrl : null;
  } finally { db.close(); }
}

// 与 deleteMediaByIds 同理：get + delete 精确计数。
async function deleteAssetByIds(storeKeys) {
  if (!storeKeys || !storeKeys.length) return 0;
  const db = await tryOpenExisting(ASSET_DB_NAME);
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) return 0;
    let deleted = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
      const store = tx.objectStore(ASSET_STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("删除失败"));
      tx.onabort = () => reject(tx.error || new Error("删除被中止"));
      for (const k of storeKeys) {
        const g = store.get(k);
        g.onsuccess = () => {
          if (g.result !== undefined) {
            const d = store.delete(k);
            d.onsuccess = () => { deleted += 1; };
          }
        };
      }
    });
    return deleted;
  } finally { db.close(); }
}

// ── 引用扫描 ────────────────────────────────────────

function collectRefsFromString(value, into, use, loc) {
  if (typeof value !== "string" || !value) return;
  const scan = (re) => {
    re.lastIndex = 0;
    let m = re.exec(value);
    while (m) { addRef(into, m[1] || m[0], use, loc); m = re.exec(value); }
  };
  if (value.indexOf("store://") >= 0) scan(MEDIA_REF_RE);
  if (value.indexOf("asset://") >= 0) scan(ASSET_REF_RE);
  if (value.indexOf("mc_") >= 0) scan(MEDIA_ID_RE);
  if (value.indexOf("_") >= 0) scan(ASSET_ID_RE);
}
function addRef(into, id, use, loc) {
  const key = String(id || "");
  if (!key) return;
  let rec = into.get(key);
  if (!rec) { rec = { uses: new Set(), locs: [] }; into.set(key, rec); }
  if (use) rec.uses.add(use);
  if (loc && rec.locs.length < 6 && rec.locs.indexOf(loc) < 0) rec.locs.push(loc);
}

function scanValueDeep(value, depth, into, use, inlineSink, loc) {
  // 修复 #13：深度上限由 7 提到 10
  if (value == null || depth > 10) return;
  if (typeof value === "string") {
    collectRefsFromString(value, into, use, loc);
    if (value.length > 64 && value.indexOf("data:image/") >= 0) {
      DATA_URL_RE.lastIndex = 0;
      let m = DATA_URL_RE.exec(value);
      while (m) {
        if (inlineSink) inlineSink.push({ dataUrl: m[0], use, loc });
        m = DATA_URL_RE.exec(value);
      }
    }
    return;
  }
  if (typeof value !== "object") return;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if ((value.type || "").startsWith("image/")) {
      // 修复 #1：Blob 内嵌图也记录 mimeType
      if (inlineSink) inlineSink.push({ blob: value, mimeType: value.type, use, loc });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanValueDeep(value[i], depth + 1, into, use, inlineSink, loc);
    return;
  }
  let keys; try { keys = Object.keys(value); } catch (e) { return; }
  for (const k of keys) {
    scanValueDeep(k, depth + 1, into, use, inlineSink, loc);
    try { scanValueDeep(value[k], depth + 1, into, use, inlineSink, loc); } catch (e) { /* ignore */ }
  }
}

async function scanStorageForRefs(onProgress) {
  const refs = new Map();
  const inline = [];
  const stats = { storeFailures: 0 };

  const kvRows = await readKvEntries().catch(() => []);
  for (let i = 0; i < kvRows.length; i += 1) {
    const row = kvRows[i];
    if (i > 0 && i % 40 === 0) await new Promise(r => window.setTimeout(r, 0));
    const use = useForKvKey(row.key);
    // 修复 #5：只有字符串才尝试 JSON.parse；对象直接透传
    let parsed = row.value;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch (e) { /* 非 JSON 字符串，保留原样 */ }
    }
    scanValueDeep(parsed, 0, refs, use, inline, `设置项 ${row.key}`);
  }

  let names = await existingDbNames();
  if (!names) {
    // 修复 #16：某些 WebView / 隐私模式没有 indexedDB.databases()，
    // 退化为扫描已知库名单，保证功能可用。
    names = Object.keys(DB_USE).concat([KV_DB_NAME, ASSET_DB_NAME, MEDIA_DB_NAME]);
  }
  for (const name of names) {
    // SKIP_DBS 里已包含 KV_DB_NAME，避免重复扫描
    if (SKIP_DBS.indexOf(name) >= 0) continue;
    if (typeof onProgress === "function") { try { onProgress(name); } catch (e) { /* ignore */ } }
    await scanDbDeep(name, refs, inline, stats).catch(() => { stats.storeFailures += 1; });
  }
  return { refs, inline, stats };
}

async function scanDbDeep(name, refs, inline, stats) {
  // 修复 #4：改用 tryOpenExisting，库不存在时直接跳过
  let db;
  try { db = await tryOpenExisting(name); } catch (e) { return; }
  if (!db) return;
  const fallbackUse = DB_USE[name] || "";
  const keyOnly = KEY_ONLY_DBS.indexOf(name) >= 0;
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      await new Promise(r => window.setTimeout(r, 0));
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = keyOnly ? store.openKeyCursor() : store.openCursor();
        await new Promise((resolve, reject) => {
          req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(); return; }
            const loc = `${name} · ${storeName}`;
            let use = fallbackUse;
            const v = c.value;
            if (name === "AiPhoneMomentsDB" && v && typeof v === "object") {
              use = v.photoUrl ? "moments" : fallbackUse;
            }
            scanValueDeep(v, 0, refs, use, inline, loc);
            scanValueDeep(c.primaryKey, 0, refs, use, inline, loc);
            c.continue();
          };
          req.onerror = () => reject(req.error || new Error("扫描失败"));
        });
      } catch (e) {
        if (stats) stats.storeFailures = (stats.storeFailures || 0) + 1;
      }
    }
  } finally { db.close(); }
}

// 修复 #3：改为 async，并定期让出主线程
// v2.1.4：联系人表在循环外取一次，避免每个无 groupName 的会话都重新拉取。
async function scanAllChatMessages(ctx, inlineSink) {
  const refs = new Map();
  let sessions = [];
  try { sessions = ctx.data.sessions.list() || []; } catch (e) { sessions = []; }

  const contactsById = new Map();
  try {
    const list = ctx.data.contacts.list() || [];
    for (const c of list) { if (c && c.id) contactsById.set(c.id, c); }
  } catch (e) { /* ignore */ }

  let tick = 0;
  for (const session of sessions) {
    let name = session.groupName || session.alias || "";
    if (!name) {
      try {
        const c = contactsById.get(session.contactId);
        const ch = c ? ctx.data.characters.get(c.characterId) : null;
        name = (ch && ch.name) || (c && c.nickname) || "未命名会话";
      } catch (e) { name = "未命名会话"; }
    }
    let msgs = [];
    try { msgs = ctx.data.messages.list(session.id) || []; } catch (e) { msgs = []; }
    for (const msg of msgs) {
      tick += 1;
      if (tick % 200 === 0) await new Promise(r => window.setTimeout(r, 0));
      scanValueDeep(msg, 0, refs, "chat", inlineSink, `聊天 · ${name}`);
    }
  }
  return { refs };
}

// ── 界面 ────────────────────────────────────────────

let cache = { entries: null, refs: null };
let scanRunCounter = 0;

function entryKey(item) {
  return `${item.source || "media"}:${item.id}`;
}

/** 防止同时打开多个图库弹窗 */
let activeGalleryClose = null;

// 安全 E：预览/导出里展示的引用位置可能含会话昵称，做一次轻量脱敏。
// v2.1.4：改为「聊天 · 到行尾」整段吞掉——之前 [^、]+ 遇到昵称本身含「、」时会
// 在第一个顿号处截断，泄露昵称后半段。loc 是原子字符串，直接吞到行尾最安全。
function sanitizeLoc(loc) {
  return String(loc || "").replace(/聊天\s*·.*$/g, "聊天");
}

function openGallery(ctx) {
  if (activeGalleryClose) { try { activeGalleryClose(); } catch (e) { /* ignore */ } }
  return ctx.ui.openModal((el, api) => {
    // 修复 #9：用闭包本地的 myClose 做身份标记，只有自己仍是当前活跃弹窗时才清空。
    const myClose = () => { try { api.close(); } catch (e) { /* ignore */ } };
    activeGalleryClose = myClose;

    const root = el;
    root.classList.add("mg-root");
    if (detectDark()) root.classList.add("mg-dark");
    Object.assign(root.style, {
      width: "min(560px, 100%)",
      height: "min(760px, 88vh)",
      maxHeight: "88vh",
      overflow: "hidden",
      borderRadius: "18px",
      padding: "0",
      boxShadow: "0 18px 50px rgba(0,0,0,.35)",
    });
    root.innerHTML = SHELL_HTML;

    const statusEl = root.querySelector('[data-el="status"]');
    const segEl = root.querySelector('[data-el="seg"]');
    const listEl = root.querySelector('[data-el="list"]');
    const barInfoEl = root.querySelector('[data-el="barinfo"]');
    const moreBtn = root.querySelector('[data-el="moreBtn"]');
    const menuEl = root.querySelector('[data-el="menu"]');
    // v2.1.3：单按钮筛选 —— 只关心当前类型文字 + 弹出面板
    const kindCurEl = root.querySelector('[data-el="kindCur"]');
    const kindPickBtn = root.querySelector('[data-act="kindpick"]');
    const kindPickerEl = root.querySelector('[data-el="kindpicker"]');
    const footerStatusEl = root.querySelector('[data-el="footerStatus"]');
    const footerActionsEl = root.querySelector('[data-el="footerActions"]');

    // 修复 #9：state 从模块级移到闭包内，避免多次打开时旧闭包读到新数据。
    const state = {
      entries: Array.isArray(cache.entries) ? cache.entries : [],
      refs: cache.refs instanceof Map ? cache.refs : null,
      byKey: new Map(),
      filter: "all",
      kind: "all",          // v2.1.3：默认不筛类型，按钮显示「文件类型」
      selected: new Set(),
      limit: 80,
      thumbs: new Map(),
      loadingThumbs: new Set(),
      busy: false,
      scanNote: "",
      // v2.1.3 UI 新增状态
      batchMode: false,
      menuOpen: false,
      kindPickerOpen: false,
    };
    let previewEl = null;

    // v2.1.4：观察器改为「每次重建列表时重置」。
    // 之前只在 isIntersecting 时 unobserve，列表整体重建后，
    // 从未进入视口的旧 holder 会一直被 observer 持有（内存泄漏）。
    // 现在 renderList 开头会 disconnect 并重建，保证 observer 只观察当前 DOM。
    let observer = null;
    function resetObserver() {
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      if (typeof IntersectionObserver !== "function") return;
      observer = new IntersectionObserver((records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const holder = record.target;
          try { observer.unobserve(holder); } catch (e) { /* ignore */ }
          const key = holder.getAttribute("data-thumb-key");
          const item = key ? state.byKey.get(key) : null;
          if (item) loadThumb(item, holder);
        }
      }, { root: listEl, rootMargin: "240px" });
    }

    function itemUses(item) {
      const rec = state.refs ? state.refs.get(item.id) : null;
      if (rec && rec.uses && rec.uses.size) return Array.from(rec.uses);
      if (item.readonly && item.use) return [item.use];
      return [];
    }

    /**
     * 孤儿判定：
     *  - 内嵌图字面嵌在别处，没有独立引用关系 → 一律不算孤儿
     *  - 表情包这类只读资产，仍按引用关系判断
     */
    function isOrphan(item) {
      if (item.readonly && readonlyKindOf(item) === "inline") return false;
      return !(state.refs && state.refs.has(item.id));
    }

    function itemCat(item) {
      if (isOrphan(item)) return "orphan";
      const uses = itemUses(item);
      if (!uses.length) return "other";
      for (const u of USE_PRIORITY) if (uses.indexOf(u) >= 0) return (USES[u] || {}).cat || "other";
      return "other";
    }

    function mainUseLabel(item) {
      const uses = itemUses(item);
      if (!uses.length) {
        if (item.readonly) return readonlyLabelOf(item);
        return isOrphan(item) ? "" : "已被引用";
      }
      for (const u of USE_PRIORITY) if (uses.indexOf(u) >= 0) return (USES[u] || {}).label || u;
      return uses[0];
    }

    function indexEntries() {
      state.byKey = new Map();
      for (const item of state.entries) state.byKey.set(entryKey(item), item);
    }
    indexEntries();

    function paintThumb(holder, url) {
      if (!holder.isConnected) return;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      holder.textContent = "";
      holder.appendChild(img);
    }

    async function loadThumb(item, holder) {
      // v2.1.2：非图片不生成缩略图，保留占位图标
      if (!item.isImage) return;
      const key = entryKey(item);
      if (state.thumbs.has(key)) {
        const cached = state.thumbs.get(key);
        if (cached && !holder.querySelector("img")) paintThumb(holder, cached);
        return;
      }
      if (state.loadingThumbs.has(key)) return;
      state.loadingThumbs.add(key);
      try {
        if (item.source === "inline" && item.dataUrl) {
          const thumb = await makeThumbDataUrl(item.dataUrl, 96);
          if (thumb) state.thumbs.set(key, thumb);
          if (thumb) paintThumb(holder, thumb);
          return;
        }
        if (item.source === "asset") {
          const dataUrl = item.dataUrl || await loadAssetDataUrlById(item.storeKey).catch(() => null);
          if (!dataUrl) return;
          const thumb = await makeThumbDataUrl(dataUrl, 96);
          if (!thumb) return;
          state.thumbs.set(key, thumb);
          paintThumb(holder, thumb);
          return;
        }
        let blob = null;
        try { blob = await loadMediaBlobById(item.storeKey); } catch (e) { blob = null; }
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        state.thumbs.set(key, url);
        paintThumb(holder, url);
      } finally {
        state.loadingThumbs.delete(key);
      }
    }

    function visibleEntries() {
      // v2.1.3：kind === "all" 时不筛类型
      let list = state.entries.filter(e => state.kind === "all" || e.category === state.kind);
      if (state.filter !== "all") list = list.filter(e => itemCat(e) === state.filter);
      const bySize = ctx.system.settings.get("sortBy") === "size";
      list.sort((a, b) => {
        // 孤儿始终置顶
        const ao = isOrphan(a) ? 0 : 1;
        const bo = isOrphan(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        if (bySize) return (b.size || 0) - (a.size || 0);
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return list;
    }

    // v2.1.3：状态信息精简，按类型汇总一行；居中放到 footerStatus。
    function renderStatus() {
      const total = state.entries.length;
      const byCat = {};
      for (const e of state.entries) byCat[e.category] = (byCat[e.category] || 0) + 1;
      const typeParts = [];
      for (const k of CATEGORY_ORDER) {
        if (byCat[k]) typeParts.push(`${CATEGORY_LABEL[k]} ${byCat[k]}`);
      }
      const totalBytes = state.entries.reduce((sum, e) => sum + (e.size || 0), 0);
      const orphans = state.entries.filter(e => isOrphan(e));
      // "可释放"只算可删的孤儿（表情包这类只读孤儿不能算进来）
      const orphanBytes = orphans.filter(e => !e.readonly).reduce((sum, e) => sum + (e.size || 0), 0);
      const protectedCount = state.entries.filter(e => e.readonly).length;

      let text = `共 ${total} 项`;
      if (typeParts.length) text += ` · ${typeParts.join(" · ")}`;
      text += `\n总占用 ${fmtBytes(totalBytes)} · 未被引用 ${orphans.length} 项（可释放 ${fmtBytes(orphanBytes)}）`;
      if (protectedCount) text += ` · 只读 ${protectedCount} 项`;
      if (state.scanNote) text += `\n${state.scanNote}`;
      footerStatusEl.textContent = text;
    }

    function renderSeg() {
      // v2.1.3：第一行是纯文字 tab，用 .mg-tab 类
      segEl.querySelectorAll("[data-filter]").forEach(btn =>
        btn.classList.toggle("mg-on", btn.getAttribute("data-filter") === state.filter));
      // 第二行右侧「文件类型」按钮：文字随当前类型变化，默认「文件类型」
      kindCurEl.textContent = state.kind === "all"
        ? "文件类型"
        : (KIND_LABEL[state.kind] || "文件类型");
      // 选中具体类型时按钮变蓝，暗示正在筛选
      if (kindPickBtn) kindPickBtn.classList.toggle("mg-on", state.kind !== "all");
      kindPickerEl.querySelectorAll("[data-kindpick]").forEach(btn =>
        btn.classList.toggle("mg-on", btn.getAttribute("data-kindpick") === state.kind));
    }

    // v2.1.3：底部栏双模式。默认显示统计信息（居中）；批量模式显示操作栏。
    // 修复 #6：把「已选总数」与「当前筛选下可见的选中数」分开显示。
    function renderFooter() {
      if (!state.batchMode) {
        footerStatusEl.hidden = false;
        footerActionsEl.hidden = true;
        return;
      }
      footerStatusEl.hidden = true;
      footerActionsEl.hidden = false;

      const visKeys = new Set(visibleEntries().map(entryKey));
      let bytes = 0, count = 0, ro = 0, visibleSelected = 0;
      for (const item of state.entries) {
        const k = entryKey(item);
        if (!state.selected.has(k)) continue;
        count += 1;
        bytes += item.size || 0;
        if (item.readonly) ro += 1;
        if (visKeys.has(k)) visibleSelected += 1;
      }
      let text = `已选 ${count} 项${ro ? `（可删 ${count - ro}）` : ""} · ${fmtBytes(bytes)}`;
      if (count > visibleSelected) text += `（当前页 ${visibleSelected}）`;
      text += `　共 ${visKeys.size} 项`;
      barInfoEl.textContent = text;
    }

    function renderNav() {
      // 批量模式时右上按钮变成「完成」，点击直接退出
      moreBtn.textContent = state.batchMode ? "完成" : "更多";
      menuEl.hidden = !state.menuOpen;
      kindPickerEl.hidden = !state.kindPickerOpen;
      root.classList.toggle("mg-batch", state.batchMode);
    }

    function renderList() {
      // v2.1.4：先重置观察器，丢弃对旧 DOM 的引用，再重建新列表。
      resetObserver();

      const list = visibleEntries();
      const slice = list.slice(0, state.limit);
      listEl.innerHTML = "";
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "mg-empty";
        if (state.filter === "orphan") {
          empty.appendChild(svgNode("sparkles", 30));
          const msg = document.createElement("div");
          msg.className = "mg-empty-msg";
          msg.textContent = "没有发现未被引用的项目";
          empty.appendChild(msg);
        } else {
          empty.textContent = state.entries.length ? "这个筛选下没有内容" : "还没有可管理的素材";
        }
        listEl.appendChild(empty);
        return;
      }

      const appendGroup = (title, items) => {
        if (!items.length) return;
        const titleEl = document.createElement("div");
        titleEl.className = "mg-grouptitle";
        titleEl.textContent = title;
        listEl.appendChild(titleEl);
        const card = document.createElement("div");
        card.className = "mg-card";
        for (const item of items) {
          const key = entryKey(item);
          const row = document.createElement("div");
          row.className = "mg-item" + (state.batchMode && state.selected.has(key) ? " mg-on" : "")
            + (isOrphan(item) ? " mg-orphan" : "") + (item.readonly ? " mg-readonly" : "");
          row.setAttribute("data-id", item.id);
          row.setAttribute("data-key", key);

          const thumb = document.createElement("div");
          thumb.className = "mg-thumb";
          thumb.setAttribute("data-thumb-key", key);
          thumb.appendChild(svgNode(mediaIconName(item.category), 22));

          const info = document.createElement("div");
          info.className = "mg-info";
          const name = document.createElement("div");
          name.className = "mg-name";
          name.textContent = fmtDate(item.createdAt);

          const sub = document.createElement("div");
          sub.className = "mg-sub";
          const useText = mainUseLabel(item);
          const sizeText = fmtBytes(item.size);
          // 非图片类型附带类型标签，例如「聊天消息 · 数据 · 2.1 KB」
          const catText = item.isImage ? "" : (CATEGORY_LABEL[item.category] || "");
          const parts = [useText, catText, sizeText].filter(Boolean);
          sub.textContent = parts.join(" · ");
          info.appendChild(name);
          info.appendChild(sub);

          row.appendChild(thumb);
          row.appendChild(info);

          const badge = document.createElement("span");
          if (isOrphan(item)) {
            badge.className = "mg-badge";
            badge.textContent = "未引用";
          } else if (item.readonly) {
            badge.className = "mg-badge mg-badge-inline";
            badge.textContent = readonlyLabelOf(item);
          }
          if (badge.className) row.appendChild(badge);

          const check = document.createElement("div");
          check.className = "mg-check";
          check.appendChild(svgNode("check", 13));
          row.appendChild(check);

          card.appendChild(row);
        }
        listEl.appendChild(card);
      };

      const buckets = new Map();
      for (const item of slice) {
        const cat = itemCat(item);
        if (!buckets.has(cat)) buckets.set(cat, []);
        buckets.get(cat).push(item);
      }
      const order = ["orphan", "chat", "social", "character", "theme", "creative", "app", "other"];
      for (const cat of order) {
        const items = buckets.get(cat);
        if (!items || !items.length) continue;
        appendGroup(`${CAT_LABEL[cat] || cat} · ${items.length} 项`, items);
      }

      if (list.length > slice.length) {
        const more = document.createElement("div");
        more.className = "mg-more";
        more.textContent = `已显示 ${slice.length}/${list.length}，继续下滑加载更多`;
        listEl.appendChild(more);
      }

      const holders = listEl.querySelectorAll("[data-thumb-key]");
      for (const holder of holders) {
        const key = holder.getAttribute("data-thumb-key");
        const item = state.byKey.get(key);
        if (!item) continue;
        if (observer) observer.observe(holder);
        else loadThumb(item, holder);
      }
    }

    function renderAll() {
      renderStatus();
      renderSeg();
      renderList();
      renderFooter();
      renderNav();
    }

    function confirmDialog(title, body, okLabel, danger) {
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "mg-overlay";
        const dialog = document.createElement("div");
        dialog.className = "mg-dialog";
        const h = document.createElement("h4");
        h.textContent = title;
        const p = document.createElement("p");
        p.textContent = body;
        const actions = document.createElement("div");
        actions.className = "mg-dialog-actions";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.textContent = "取消";
        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = danger ? "mg-danger" : "";
        okBtn.textContent = okLabel || "确定";
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        dialog.appendChild(h);
        dialog.appendChild(p);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        const done = (value) => { try { overlay.remove(); } catch (e) { /* ignore */ } resolve(value); };
        cancelBtn.addEventListener("click", () => done(false));
        okBtn.addEventListener("click", () => done(true));
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) done(false); });
        root.appendChild(overlay);
      });
    }

    function skippedKindsText(items) {
      const kinds = [];
      let hasSticker = false;
      let hasInline = false;
      for (const it of items) {
        const k = readonlyKindOf(it);
        if (k === "sticker") hasSticker = true;
        else hasInline = true;
      }
      if (hasSticker) kinds.push("表情包");
      if (hasInline) kinds.push("内嵌图片");
      return kinds.join("、");
    }

    async function scanAll() {
      if (state.busy) return;
      const myRun = ++scanRunCounter;
      state.busy = true;
      state.scanNote = "";
      // 顶部状态栏：扫描时才显示
      statusEl.hidden = false;
      const t = ctx.ui.toast("正在建立全局素材索引…", { durationMs: 0 });
      // v2.1.4：跟踪扫描是否失败，失败时不要立刻隐藏错误信息
      let failed = false;
      try {
        statusEl.textContent = "① 读取媒体库…";
        const mediaRes = await readMediaEntries().catch(() => ({ entries: [] }));
        if (myRun !== scanRunCounter) return;

        statusEl.textContent = "② 读取素材资产库…";
        const assetRes = await readAssetEntries().catch(() => ({ entries: [] }));
        if (myRun !== scanRunCounter) return;

        statusEl.textContent = "③ 扫描设置与其它数据库…";
        const scanned = await scanStorageForRefs((dbName) => {
          statusEl.textContent = "③ 正在扫描 " + dbName + " …";
        });
        if (myRun !== scanRunCounter) return;

        statusEl.textContent = "④ 扫描全部聊天会话…";
        const chat = await scanAllChatMessages(ctx, scanned.inline);
        if (myRun !== scanRunCounter) return;

        const refs = scanned.refs;
        for (const [id, rec] of chat.refs) {
          const cur = refs.get(id);
          if (!cur) { refs.set(id, rec); continue; }
          for (const u of rec.uses) cur.uses.add(u);
          for (const l of rec.locs) {
            if (cur.locs.length < 6 && cur.locs.indexOf(l) < 0) cur.locs.push(l);
          }
        }

        const protectStickers = ctx.system.settings.get("protectStickers") !== false;

        const merged = [];
        for (const item of mediaRes.entries) {
          merged.push({
            ...item,
            source: "media",
            isImage: item.category === "image",
          });
        }
        for (const item of assetRes.entries) {
          const isSticker = assetTypeKey(item.id) === "sticker";
          const ro = protectStickers && isSticker;

          // v2.1.3：按 MIME 统一分类。资产库不止图片（还有 font_ 字体）。
          // MIME 缺失时看资产前缀，font_ 一律按字体处理。
          const assetKind = assetTypeKey(item.id);
          let category = classifyMedia(item.mimeType);
          if (!item.mimeType && assetKind === "font") category = "font";
          const isImage = category === "image";

          merged.push({
            ...item,
            source: "asset",
            category,
            isImage,
            readonly: ro,
            readonlyKind: ro ? "sticker" : "",
          });
        }

        const scanInline = ctx.system.settings.get("scanInline") !== false;
        if (scanInline) {
          const seenInline = new Set();
          let inlineTick = 0;
          for (const raw of scanned.inline) {
            inlineTick += 1;
            if (inlineTick % 20 === 0) await new Promise(r => window.setTimeout(r, 0));
            if (myRun !== scanRunCounter) return;
            // 修复 #1：Blob 来源的内嵌图统一转成 dataURL
            let dataUrl = raw.dataUrl || "";
            if (!dataUrl && raw.blob) {
              dataUrl = await blobToDataUrl(raw.blob).catch(() => "");
            }
            const key = dataUrl
              ? "inline:url:" + dataUrl.length + ":" + hashStr(dataUrl)
              : "inline:blob:" + (raw.loc || "") + ":" + (raw.blob ? raw.blob.size : 0) + ":" + hashStr(String(raw.loc || ""));
            if (seenInline.has(key)) continue;
            seenInline.add(key);
            merged.push({
              id: key.slice(7), source: "inline", key,
              use: raw.use || "",
              mimeType: raw.mimeType || (dataUrl ? parseDataUrlMime(dataUrl) : "") || "image/*",
              category: "image", isImage: true, createdAt: 0,
              size: dataUrl ? estimateDataUrlBytes(dataUrl) : (raw.blob ? raw.blob.size : 0),
              dataUrl,
              loc: raw.loc || "",
              readonly: true, readonlyKind: "inline",
            });
          }
        }

        if (myRun !== scanRunCounter) return;

        state.entries = merged;
        state.refs = refs;
        if (scanned.stats && scanned.stats.storeFailures) {
          state.scanNote = `注意：有 ${scanned.stats.storeFailures} 个数据区读取失败已跳过（不影响其他内容）`;
        }
        indexEntries();
        cache = { entries: state.entries, refs: state.refs };
      } catch (e) {
        failed = true;
        if (myRun === scanRunCounter) {
          statusEl.textContent = "读取失败：" + (e && e.message ? e.message : String(e));
        }
        ctx.system.log("扫描失败", e);
      } finally {
        t.close();
        if (myRun === scanRunCounter) {
          state.busy = false;
          // v2.1.4：成功时隐藏顶部状态栏（统计信息在底部栏常驻）；
          // 失败时保留顶部状态栏，让用户能看到失败原因。
          if (!failed) statusEl.hidden = true;
          renderAll();
        }
      }
    }

    async function deleteSelected(keys) {
      const targetKeys = (keys || []).slice();
      if (!targetKeys.length) { ctx.ui.toast("还没有选中任何项目"); return; }
      const items = targetKeys.map(k => state.byKey.get(k)).filter(Boolean);
      if (!items.length) return;

      const readonlyItems = items.filter(it => it.readonly);
      const deletable = items.filter(it => !it.readonly);
      if (!deletable.length) {
        const kinds = skippedKindsText(readonlyItems);
        ctx.ui.toast(`${kinds}受只读保护，不能在这里删除`);
        return;
      }

      let bytes = 0;
      let stillUsed = 0;
      for (const item of deletable) {
        bytes += item.size || 0;
        if (state.refs && state.refs.has(item.id)) stillUsed += 1;
      }
      const warn = stillUsed
        ? `\n其中 ${stillUsed} 项仍被聊天记录、朋友圈或主题等引用，删除后对应位置会变成空白。`
        : "";
      const skippedMsg = readonlyItems.length
        ? `\n另有 ${readonlyItems.length} 项（${skippedKindsText(readonlyItems)}）受只读保护，不会被删除。`
        : "";
      const ok = await confirmDialog(
        "删除",
        `确定删除选中的 ${deletable.length} 项吗？预计释放 ${fmtBytes(bytes)}。${warn}${skippedMsg}\n\n此操作不可撤销。`,
        "删除",
        true,
      );
      if (!ok) return;

      const t = ctx.ui.toast("正在删除…", { durationMs: 0 });
      try {
        // 修复 #2 / 安全 B：用真实主键删除，并用返回的真实删除条数提示用户。
        const mediaKeys = deletable.filter(it => it.source === "media").map(it => it.storeKey);
        const assetKeys = deletable.filter(it => it.source === "asset").map(it => it.storeKey);
        let deleted = 0;
        if (mediaKeys.length) {
          try { deleted += await deleteMediaByIds(mediaKeys); }
          catch (e) { ctx.system.log("媒体库删除失败", e); }
        }
        if (assetKeys.length) {
          try { deleted += await deleteAssetByIds(assetKeys); }
          catch (e) { ctx.system.log("资产库删除失败", e); }
        }

        if (deleted === 0 && deletable.length > 0) {
          ctx.ui.toast("删除失败：数据库未接受本次操作");
          return;
        }

        const gone = new Set(deletable.map(entryKey));
        for (const item of deletable) {
          const key = entryKey(item);
          const url = state.thumbs.get(key);
          if (url && url.startsWith("blob:")) {
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
          }
          state.thumbs.delete(key);
          state.loadingThumbs.delete(key);
        }
        for (const k of targetKeys) state.selected.delete(k);

        if (previewEl && gone.has(previewEl.getAttribute("data-preview-key"))) {
          closePreview();
        }
        state.entries = state.entries.filter(item => !gone.has(entryKey(item)));
        // 修复 #15：删除后重置分页
        state.limit = 80;
        indexEntries();
        cache = { entries: state.entries, refs: state.refs };

        const partial = deleted < deletable.length ? `（部分失败 ${deletable.length - deleted} 项）` : "";
        ctx.ui.toast(`已删除 ${deleted} 项${partial}`
          + (readonlyItems.length ? `（跳过 ${readonlyItems.length} 项只读）` : ""));
      } catch (e) {
        ctx.ui.toast("删除失败：" + (e && e.message ? e.message : String(e)));
        ctx.system.log("删除失败", e);
      } finally {
        t.close();
        renderAll();
      }
    }

    // ── 大图预览 ──
    function closePreview() {
      if (!previewEl) return;
      try { previewEl.remove(); } catch (e) { /* ignore */ }
      previewEl = null;
    }

    function makeMetaRow(label, value) {
      const row = document.createElement("div");
      row.className = "mg-pv-row";
      const k = document.createElement("span");
      k.className = "mg-pv-key";
      k.textContent = label + "：";
      const v = document.createElement("span");
      v.className = "mg-pv-val";
      v.textContent = value;
      row.appendChild(k);
      row.appendChild(v);
      return row;
    }

    async function openPreview(item) {
      closePreview();
      const key = entryKey(item);
      const box = document.createElement("div");
      box.className = "mg-preview";
      box.setAttribute("data-preview-key", key);

      const holder = document.createElement("div");
      holder.className = "mg-pv-holder";
      holder.appendChild(svgNode(mediaIconName(item.category), 48));

      const meta = document.createElement("div");
      meta.className = "mg-pv-meta";

      const usesLabel = itemUses(item).map(u => (USES[u] || {}).label || u).join("、")
        || (item.readonly ? readonlyLabelOf(item) : (isOrphan(item) ? "未被引用" : "已被引用"));
      const rec = state.refs && state.refs.get(item.id);
      const locs = rec && rec.locs;

      meta.appendChild(makeMetaRow("类型", mediaLabel(item) + "（" + sourceLabel(item) + "）"));
      meta.appendChild(makeMetaRow("用途", usesLabel));
      meta.appendChild(makeMetaRow("大小", fmtBytes(item.size)));
      meta.appendChild(makeMetaRow("创建时间", fmtDate(item.createdAt)));
      if (readonlyKindOf(item) === "inline") {
        const raw = item.loc || "未知";
        const dbName = raw.split(" · ")[0];
        meta.appendChild(makeMetaRow("所在位置",
          (DB_LABEL[dbName] ? DB_LABEL[dbName] + " · " : "") + sanitizeLoc(raw)));
      } else {
        meta.appendChild(makeMetaRow("格式", item.mimeType || "未知类型"));
      }
      if (item.readonly) {
        meta.appendChild(makeMetaRow("删除方式", readonlyLabelOf(item) === "表情包" ? "应用内表情管理" : "原位置修改"));
      }
      if (locs && locs.length) {
        // 安全 E：位置里可能含会话昵称，做脱敏处理再展示
        const safe = locs.slice(0, 3).map(sanitizeLoc);
        meta.appendChild(makeMetaRow("引用位置", safe.join("、") + (locs.length > 3 ? "…" : "")));
      }
      meta.appendChild(makeMetaRow("ID", item.id));

      const noteText = readonlyHintOf(item);
      if (noteText) {
        const note = document.createElement("div");
        note.className = "mg-pv-note";
        note.textContent = noteText;
        meta.appendChild(note);
      }

      const actions = document.createElement("div");
      actions.className = "mg-pv-actions";
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.textContent = "保存这一项";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mg-danger";
      if (item.readonly) {
        delBtn.textContent = readonlyLabelOf(item) === "表情包" ? "表情包（不可删）" : "只读（不可删）";
        delBtn.disabled = true;
      } else {
        delBtn.textContent = "删除这一项";
      }
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "关闭";
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);
      actions.appendChild(closeBtn);

      box.appendChild(holder);
      box.appendChild(meta);
      box.appendChild(actions);
      box.addEventListener("click", (ev) => { if (ev.target === box) closePreview(); });
      closeBtn.addEventListener("click", () => closePreview());

      dlBtn.addEventListener("click", async () => {
        try {
          const bytes = await loadItemBytes(item);
          if (!bytes) { ctx.ui.toast("读取失败"); return; }
          const blob = new Blob([bytes], { type: item.mimeType || "application/octet-stream" });
          triggerDownload(blob, uniqueName(item, new Set()));
          ctx.ui.toast("已开始下载");
        } catch (e) { ctx.ui.toast("下载失败"); }
      });
      delBtn.addEventListener("click", async () => {
        if (item.readonly) {
          ctx.ui.toast(readonlyLabelOf(item) === "表情包"
            ? "表情包请到应用内的表情管理里删除"
            : "内嵌图片需在原位置处理");
          return;
        }
        closePreview();
        await deleteSelected([key]);
      });

      root.appendChild(box);
      previewEl = box;

      // 非图片（字体/数据/文档等）只展示元数据
      if (!item.isImage) return;

      let url = state.thumbs.get(key) || null;
      if (!url || !url.startsWith("blob:")) {
        if (item.source === "inline" && item.dataUrl) {
          url = item.dataUrl;
        } else if (item.source === "asset") {
          const dataUrl = item.dataUrl || await loadAssetDataUrlById(item.storeKey).catch(() => null);
          if (dataUrl) url = dataUrl;
        } else {
          try {
            const blob = await loadMediaBlobById(item.storeKey);
            if (blob) {
              url = URL.createObjectURL(blob);
              const prevUrl = state.thumbs.get(key);
              if (prevUrl && prevUrl.startsWith("blob:") && prevUrl !== url) {
                try { URL.revokeObjectURL(prevUrl); } catch (e) { /* ignore */ }
              }
              state.thumbs.set(key, url);
            }
          } catch (e) { url = null; }
        }
      }
      if (previewEl !== box) return;
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        holder.textContent = "";
        holder.appendChild(img);
      } else {
        holder.textContent = "";
        const msg = document.createElement("div");
        msg.style.fontSize = "13px";
        msg.textContent = "图片读取失败";
        holder.appendChild(msg);
      }
    }

    async function loadItemBytes(item) {
      if (item.source === "inline" && item.dataUrl) {
        const bytes = dataUrlToBytes(item.dataUrl);
        return bytes.length ? bytes : null;
      }
      if (item.source === "asset") {
        const dataUrl = item.dataUrl || await loadAssetDataUrlById(item.storeKey).catch(() => null);
        if (!dataUrl) return null;
        const bytes = dataUrlToBytes(dataUrl);
        return bytes.length ? bytes : null;
      }
      const blob = await loadMediaBlobById(item.storeKey).catch(() => null);
      if (!blob) return null;
      const buf = await blob.arrayBuffer();
      return new Uint8Array(buf);
    }

    // v2.1.3：非图片类型对应的导出子目录
    function categoryFolder(category) {
      switch (category) {
        case "font": return "fonts";
        case "audio": return "audio";
        case "video": return "video";
        case "document": return "documents";
        case "data": return "data";
        case "archive": return "archives";
        case "code": return "code";
        default: return "files";
      }
    }

    async function exportZip(items) {
      const encoder = new TextEncoder();
      const used = new Set();
      const files = [];
      let failed = 0;
      const MAX_EXPORT_BYTES = 192 * 1024 * 1024;
      let exportedBytes = 0;
      let overflowed = 0;

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        statusEl.hidden = false;
        statusEl.textContent = `正在打包 ${i + 1}/${items.length} …`;
        if (i > 0 && i % 5 === 0) await new Promise(r => window.setTimeout(r, 0));
        // 修复 #11：先用 item.size 做快速预估（可能是估算值），跳过明显超限的项
        if (item.size && exportedBytes + item.size > MAX_EXPORT_BYTES) {
          overflowed += 1;
          continue;
        }
        let bytes = null;
        try { bytes = await loadItemBytes(item); } catch (e) { bytes = null; }
        if (!bytes) { failed += 1; continue; }
        // 修复 #11：拿到真实字节后再精确校验一次
        if (exportedBytes + bytes.length > MAX_EXPORT_BYTES) {
          overflowed += 1;
          continue;
        }
        exportedBytes += bytes.length;
        const cat = itemCat(item);
        // v2.1.3：图片按用途分类目录，其它类型按 categoryFolder 落目录
        const folder = item.isImage ? `images/${CAT_LABEL[cat] || cat}`
          : categoryFolder(item.category);
        files.push({
          name: `${folder}/${uniqueName(item, used)}`,
          data: bytes,
          item,
        });
      }
      statusEl.hidden = true;

      if (!files.length) {
        ctx.ui.toast("没有可导出的内容（读取全部失败）");
        return;
      }

      const lines = [
        "# 图库管家导出清单",
        `导出时间\t${new Date().toISOString()}`,
        `本次导出\t${files.length}`,
        failed ? `读取失败\t${failed}` : "读取失败\t0",
        overflowed ? `超限跳过\t${overflowed}（> ${fmtBytes(MAX_EXPORT_BYTES)}）` : "超限跳过\t0",
        "说明\t文件名格式为 时间_短ID.扩展名；「是否被引用」为否即为未被引用的孤儿数据，「内嵌」表示只读内嵌图，「表情包」表示受保护的表情包资产",
        "",
        ["文件名", "来源/用途", "类型", "是否被引用", "大小(字节)", "创建时间", "原ID"].join("\t"),
      ];
      for (const file of files) {
        let refState;
        if (readonlyKindOf(file.item) === "inline") refState = "内嵌";
        else if (readonlyKindOf(file.item) === "sticker") refState = "表情包";
        else refState = (state.refs && state.refs.has(file.item.id)) ? "是" : "否";
        lines.push([
          file.name,
          `${sourceLabel(file.item)}/${itemUses(file.item).join("|") || "未引用"}`,
          mediaLabel(file.item),
          refState,
          String(file.item.size || 0),
          fmtDate(file.item.createdAt),
          file.item.id,
        ].join("\t"));
      }
      files.push({ name: "manifest.txt", data: encoder.encode(lines.join("\n")) });

      const zip = buildZip(files);
      const name = `float-media_${stamp()}.zip`;
      if (!triggerDownload(zip, name)) {
        ctx.ui.toast("打包完成，但浏览器拦截了下载");
        return;
      }
      ctx.ui.toast(
        `已导出 ${files.length - 1} 项（${fmtBytes(zip.size)}）`
        + (failed ? `，${failed} 项读取失败被跳过` : "")
        + (overflowed ? `，${overflowed} 项超出体积上限被跳过` : ""),
      );
    }

    root.addEventListener("click", async (ev) => {
      const target = ev.target;
      if (!target || typeof target.closest !== "function") return;

      // 点击菜单/选择面板外部时收起它们
      if (state.menuOpen && !target.closest(".mg-menu") && !target.closest('[data-act="more"]')) {
        state.menuOpen = false;
        menuEl.hidden = true;
      }
      if (state.kindPickerOpen && !target.closest(".mg-kindpicker") && !target.closest('[data-act="kindpick"]')) {
        state.kindPickerOpen = false;
        kindPickerEl.hidden = true;
      }

      // 第一行：模块分类 tab
      const filterEl = target.closest("[data-filter]");
      if (filterEl && root.contains(filterEl)) {
        state.filter = filterEl.getAttribute("data-filter") || "all";
        state.limit = 80;
        renderSeg();
        renderList();
        renderFooter();
        return;
      }

      // v2.1.3：类型选择面板内的按钮（点后切换类型并收起面板）
      const kindPickerItem = target.closest("[data-kindpick]");
      if (kindPickerItem && root.contains(kindPickerItem)) {
        state.kind = kindPickerItem.getAttribute("data-kindpick") || "all";
        state.kindPickerOpen = false;
        kindPickerEl.hidden = true;
        state.limit = 80;
        renderSeg();
        renderList();
        renderFooter();
        return;
      }

      const actEl = target.closest("[data-act]");
      if (actEl && root.contains(actEl)) {
        const act = actEl.getAttribute("data-act");

        if (act === "close") { api.close(); return; }

        // v2.1.3：右上「更多 / 完成」按钮
        if (act === "more") {
          if (state.batchMode) {
            // 退出批量模式
            state.batchMode = false;
            state.selected.clear();
            renderNav();
            renderList();
            renderFooter();
            return;
          }
          state.menuOpen = !state.menuOpen;
          state.kindPickerOpen = false;
          kindPickerEl.hidden = true;
          menuEl.hidden = !state.menuOpen;
          return;
        }

        if (act === "rescan") {
          state.menuOpen = false;
          menuEl.hidden = true;
          if (state.busy) return;
          state.limit = 80;
          await scanAll();
          return;
        }

        if (act === "batch") {
          state.menuOpen = false;
          menuEl.hidden = true;
          state.batchMode = true;
          state.selected.clear();
          renderNav();
          renderList();
          renderFooter();
          return;
        }

        // v2.1.3：点「文件类型」按钮，展开/收起类型面板
        if (act === "kindpick") {
          state.kindPickerOpen = !state.kindPickerOpen;
          state.menuOpen = false;
          menuEl.hidden = true;
          kindPickerEl.hidden = !state.kindPickerOpen;
          return;
        }

        if (act === "all") {
          // 只读项也参与全选（用于导出），删除时会自动跳过
          const list = visibleEntries();
          const allSelected = list.length > 0 && list.every(item => state.selected.has(entryKey(item)));
          for (const item of list) {
            const key = entryKey(item);
            if (allSelected) state.selected.delete(key);
            else state.selected.add(key);
          }
          renderList();
          renderFooter();
          return;
        }
        if (act === "invert") {
          for (const item of visibleEntries()) {
            const key = entryKey(item);
            if (state.selected.has(key)) state.selected.delete(key);
            else state.selected.add(key);
          }
          renderList();
          renderFooter();
          return;
        }
        if (act === "zip") {
          if (state.busy) return;
          const items = state.entries.filter(item => state.selected.has(entryKey(item)));
          if (!items.length) { ctx.ui.toast("请先选择要导出的项目"); return; }
          state.busy = true;
          try { await exportZip(items); } catch (e) {
            ctx.ui.toast("导出失败：" + (e && e.message ? e.message : String(e)));
            ctx.system.log("导出失败", e);
          } finally {
            state.busy = false;
            statusEl.hidden = true;
            renderAll();
          }
          return;
        }
        if (act === "del") {
          if (state.busy) return;
          const keys = state.entries.filter(item => state.selected.has(entryKey(item))).map(entryKey);
          await deleteSelected(keys);
          return;
        }
        return;
      }

      // 缩略图：始终预览
      const thumbEl = target.closest("[data-thumb-key]");
      if (thumbEl && root.contains(thumbEl)) {
        const key = thumbEl.getAttribute("data-thumb-key");
        const item = state.byKey.get(key);
        if (item) await openPreview(item);
        return;
      }

      // 行点击：批量模式勾选，普通模式预览
      const rowEl = target.closest(".mg-item");
      if (rowEl && root.contains(rowEl)) {
        const key = rowEl.getAttribute("data-key");
        if (!key) return;
        if (state.batchMode) {
          if (state.selected.has(key)) state.selected.delete(key);
          else state.selected.add(key);
          rowEl.classList.toggle("mg-on", state.selected.has(key));
          renderFooter();
        } else {
          const item = state.byKey.get(key);
          if (item) await openPreview(item);
        }
        return;
      }
    });

    let scrollTick = 0;
    listEl.addEventListener("scroll", () => {
      if (scrollTick) return;
      scrollTick = window.setTimeout(() => {
        scrollTick = 0;
        const list = visibleEntries();
        if (state.limit >= list.length) return;
        if (listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 200) return;
        state.limit = Math.min(state.limit + 80, 2000);
        renderList();
      }, 160);
    });

    renderAll();
    scanAll();

    return () => {
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      for (const url of state.thumbs.values()) {
        if (url && url.startsWith("blob:")) {
          try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        }
      }
      state.thumbs.clear();
      state.loadingThumbs.clear();
      closePreview();
      // 内嵌图自带完整 base64，长期驻留很占内存；下次打开重新扫描补齐
      cache = { entries: (cache.entries || []).filter(e => e.source !== "inline"), refs: cache.refs };
      // 修复 #9：只有自己仍是当前活跃弹窗时才清空
      if (activeGalleryClose === myClose) activeGalleryClose = null;
    };
  });
}

export default {
  manifest: {
    id: "float-media-manager",
    name: "图库管家",
    apiVersion: 1,
    version: "2.1.4",
    author: "小坊",
    description: "全局素材索引：按聊天/社交/角色/桌面/剧情/应用分类，区分图片/字体/文档/数据等类型，多选删除、导出 ZIP，孤儿数据置顶",
    permissions: ["chat.read", "ui", "storage"],
    settings: [
      { key: "scanInline", label: "扫描内嵌图片（朋友圈/角色头像/表情包）", type: "boolean", default: true },
      { key: "protectStickers", label: "保护表情包（只读，防止误删）", type: "boolean", default: true },
      { key: "sortBy", label: "列表排序", type: "select", default: "time",
        options: [{ value: "time", label: "按时间（新→旧）" }, { value: "size", label: "按体积（大→小）" }] },
      { key: "entryLabel", label: "设置页入口按钮文字", type: "text", default: "图库" },
    ],
  },
  setup(ctx) {
    ctx.ui.injectCSS(CSS);

    const buttons = new Set();
    const label = () => String(ctx.system.settings.get("entryLabel") || "图库").trim() || "图库";

    function paintButton(btn) {
      btn.innerHTML = "";
      btn.appendChild(svgNode("gallery", 15));
      const span = document.createElement("span");
      span.textContent = label();
      btn.appendChild(span);
    }
    const paint = () => { for (const btn of buttons) { try { paintButton(btn); } catch (e) { /* ignore */ } } };

    ctx.ui.slot("settings.section", (host) => {
      host.innerHTML = "";
      host.style.padding = "0";

      const wrap = document.createElement("div");
      wrap.className = "mg-setwrap";

      const row = document.createElement("div");
      row.className = "mg-setrow";

      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0";

      const title = document.createElement("div");
      title.className = "mg-settitle";
      title.textContent = "图库管家";

      const sub = document.createElement("div");
      sub.className = "mg-setsub";
      sub.textContent = "全局素材索引：浏览媒体库、素材资产（图片/字体/文档/数据等）、内嵌图片与聊天消息，按用途分类，多选删除、导出 ZIP。表情包默认只读保护。";

      info.appendChild(title);
      info.appendChild(sub);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mg-setbtn";
      paintButton(btn);
      btn.addEventListener("click", () => openGallery(ctx));

      row.appendChild(info);
      row.appendChild(btn);
      wrap.appendChild(row);
      host.appendChild(wrap);

      buttons.add(btn);

      return () => {
        buttons.delete(btn);
        host.innerHTML = "";
      };
    });

    ctx.ui.messageAction({
      id: "float-media-open",
      label: "在图库中查看",
      filter: (msg) => !!(msg && (msg.mediaUrl
        || (msg.mediaData && msg.mediaData.imageGenerationMediaRef))),
      onSelect: () => { openGallery(ctx); },
    });

    // 修复 #17：settings.onChange 未在文档中承诺会自动反注册，
    // 保存返回值并在 setup 清理函数里主动调用。
    const offSettings = ctx.system.settings.onChange(paint);
    ctx.system.log("图库管家 v2.1.4 已启用");

    return () => {
      if (typeof offSettings === "function") {
        try { offSettings(); } catch (e) { /* ignore */ }
      }
    };
  },
};
