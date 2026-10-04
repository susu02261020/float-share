// 位置感知 · 离家关心 + 位置卡片分享（聊天插件 · apiVersion 1）
// 作者：萧渲禾＆沈既白（萧梧晚）
//
// 安装：聊天设置 →「扩展插件」→ 粘贴本文件全部内容安装
// 配置：插件设置页填高德 Key → 下方自定义设置区选角色 →「定位当前位置并设为家」
// 分享：在任意聊天窗口输入触发词（默认「我的位置」）并发送，即发出真实位置卡片

const DEFAULT_TEMPLATES = [
    "到家啦？路上还顺利吗",
    "怎么突然出去了，去哪呀",
    "出门了？外面注意安全，别太晚回",
    "你到家了跟我说一声",
    "到家就好，今天累不累？",
].join("\n");

const DEFAULT_TRIGGERS = "我的位置|发送位置|/位置";

export default {
    manifest: {
        id: "geo-leave-care",
        name: "位置感知 · 离家关心",
        apiVersion: 1,
        version: "1.1.0",
        author: "萧渲禾＆沈既白",
        description: "读取真实位置（高德逆地理编码）：离家/到家时指定角色主动关心，聊天里发触发词即可发出真实位置卡片",
        permissions: ["chat.read", "chat.write", "ai", "network", "ui", "storage"],
        settings: [
            { key: "amapKey", label: "高德 Web 服务 Key", type: "text", default: "", description: "在高德开放平台创建 Key 时，「服务平台」必须选「Web服务」" },
            { key: "shareTriggers", label: "发位置卡片的触发词（用 | 分隔）", type: "text", default: DEFAULT_TRIGGERS, description: "在任意聊天窗口发送其中一个词，就会发出当前位置卡片" },
            { key: "radius", label: "离家判定半径（米）", type: "number", default: 300, description: "与「家」的直线距离超过该值即视为离家" },
            { key: "intervalMin", label: "检查间隔（分钟）", type: "number", default: 5, description: "页面可见时每隔多久检查一次（打开时也会立即检查一次）" },
            { key: "notifyLeave", label: "离家时让角色来关心", type: "boolean", default: true },
            { key: "notifyHome", label: "到家时让角色来关心", type: "boolean", default: true },
            { key: "cooldownMin", label: "两次关心的最短间隔（分钟）", type: "number", default: 40, description: "防止频繁出门/回家时反复打扰" },
            { key: "dailyLimit", label: "每天最多关心几次", type: "number", default: 6 },
            { key: "useAI", label: "用 AI 按角色人设现写话术", type: "boolean", default: true, description: "关闭后用下面的模板话术随机取一条（更省钱、更快）" },
            { key: "templates", label: "模板话术（一行一条）", type: "text", default: DEFAULT_TEMPLATES, description: "可用占位符：{地址} {距离} {时间} {角色名}" },
            { key: "injectPrompt", label: "把实时位置持续告知角色", type: "boolean", default: true, description: "开启后指定角色平时聊天也知道你当前在哪（会占一点提示词长度）" },
        ],
    },

    setup(ctx) {
        const K = {
            home: "geo_home",
            target: "geo_target",
            state: "geo_state",
            fix: "geo_last_fix",
            lastNotify: "geo_last_notify",
            day: "geo_day",
            dayCount: "geo_day_count",
            promptSession: "geo_prompt_session",
        };
        const store = ctx.system.storage;

        const cfg = (key, fb) => {
            const v = ctx.system.settings.get(key);
            return v === undefined || v === null || v === "" ? fb : v;
        };
        const numCfg = (key, fb) => {
            const n = Number(cfg(key, fb));
            return Number.isFinite(n) ? n : fb;
        };
        const amapKey = () => String(cfg("amapKey", "")).trim();

        const targetId = () => store.get(K.target) || "";
        const targetCharacter = () => {
            const id = targetId();
            return id ? ctx.data.characters.get(id) : null;
        };
        const targetSessionId = () => {
            const cid = targetId();
            if (!cid) return null;
            const contact = ctx.data.contacts.list().find((c) => c.characterId === cid);
            if (!contact) return null;
            const session = ctx.data.sessions.list().find((s) => !s.isGroup && s.contactId === contact.id);
            return session ? session.id : null;
        };

        // ── 定位 ───────────────────────────────────────────────
        function geoErrText(e) {
            if (!e) return "定位失败";
            if (e.code === 1) return "定位权限被拒绝，请允许本页获取位置";
            if (e.code === 2) return "拿不到定位信号（室内可试试靠近窗边）";
            if (e.code === 3) return "定位超时";
            return e.message || "定位失败";
        }
        function getPosition(timeoutMs) {
            return new Promise((resolve, reject) => {
                if (!navigator.geolocation) {
                    reject(new Error("此环境不支持定位（需 HTTPS 或 localhost 打开）"));
                    return;
                }
                navigator.geolocation.getCurrentPosition(
                    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
                    (e) => reject(new Error(geoErrText(e))),
                    { enableHighAccuracy: true, timeout: timeoutMs || 15000, maximumAge: 60000 },
                );
            });
        }

        // ── 高德接口 ───────────────────────────────────────────
        const AMAP_HINTS = {
            "10001": "Key 无效或已过期",
            "10003": "今日访问量超限",
            "10004": "访问过于频繁",
            "10009": "Key 平台不符：请把该 Key 的平台设为「Web服务」",
            "10012": "Key 已过期",
            "10013": "该 Key 无此接口权限（需开通 Web 服务）",
        };
        function amapError(d) {
            const info = d && d.info ? d.info : "未知错误";
            const code = d && d.infocode ? "（" + d.infocode + "）" : "";
            const hint = d && AMAP_HINTS[d.infocode] ? " —— " + AMAP_HINTS[d.infocode] : "";
            return "高德：" + info + code + hint;
        }
        async function amap(path, params) {
            const key = amapKey();
            if (!key) throw new Error("还没填写高德 Key");
            const qs = new URLSearchParams(Object.assign({ key: key }, params));
            let res;
            try {
                res = await ctx.system.fetch("https://restapi.amap.com/v3/" + path + "?" + qs.toString());
            } catch (e) {
                throw new Error("请求高德失败（网络或跨域受限），请检查网络与 Key");
            }
            if (!res.ok) throw new Error("高德接口 HTTP " + res.status);
            const data = await res.json();
            if (String(data.status) !== "1") throw new Error(amapError(data));
            return data;
        }
        async function reverseGeocode(lat, lng) {
            const d = await amap("geocode/regeo", { location: lng + "," + lat, extensions: "base", radius: 200 });
            const rc = d.regeocode || {};
            return rc.formatted_address || "";
        }
        async function geocodeAddress(addr) {
            const d = await amap("geocode/geo", { address: addr });
            const g = (d.geocodes || [])[0];
            if (!g || !g.location) throw new Error("没解析出坐标，换个更具体的地址试试");
            const parts = String(g.location).split(",");
            return { lat: Number(parts[1]), lng: Number(parts[0]), address: g.formatted_address || addr };
        }

        function distanceM(a, b) {
            const R = 6371000;
            const rad = (x) => (x * Math.PI) / 180;
            const dLat = rad(b.lat - a.lat);
            const dLng = rad(b.lng - a.lng);
            const s = Math.sin(dLat / 2) ** 2 +
                Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(s));
        }

        // 取一次真实定位并解析地址；顺带刷新缓存的状态快照
        async function resolveCurrent(timeoutMs) {
            const pos = await getPosition(timeoutMs);
            let address = "";
            if (amapKey()) {
                try { address = await reverseGeocode(pos.lat, pos.lng); }
                catch (e) { ctx.system.log("逆地理编码失败：", e && e.message ? e.message : String(e)); }
            }
            if (!address) {
                const last = store.get(K.fix);
                if (last && last.address && Date.now() - (last.at || 0) < 10 * 60000) address = last.address;
            }
            return { lat: pos.lat, lng: pos.lng, accuracy: Math.round(pos.acc || 0), address: address };
        }

        // ── 话术 ───────────────────────────────────────────────
        function fillTemplate(t, info) {
            return String(t)
                .replace(/\{地址\}/g, info.address || "外面")
                .replace(/\{距离\}/g, info.distance != null ? String(info.distance) : "?")
                .replace(/\{时间\}/g, new Date().toLocaleTimeString().slice(0, 5))
                .replace(/\{角色名\}/g, info.name || "")
                .trim();
        }
        function cleanText(s) {
            let t = String(s || "").trim();
            t = t.replace(/^["'“”「『]+/, "").replace(/["'“”」』]+$/, "").trim();
            t = t.replace(/^(消息|正文|回复|微信)[:：]\s*/, "");
            const lines = t.split(/\n+/).map((x) => x.trim()).filter(Boolean);
            return (lines[0] || "").slice(0, 200);
        }
        async function composeMessage(kind, info) {
            if (cfg("useAI", true)) {
                try {
                    const ch = targetCharacter();
                    const sysParts = [
                        "你在扮演一个真实的人，正在给对方发一条微信消息。",
                        ch && ch.name ? "你的名字：" + ch.name : "",
                        ch && ch.persona ? "你的人设：" + String(ch.persona).slice(0, 1500) : "",
                        "只输出消息正文本身：不要引号、不要括号旁白、不要解释、不要复述数据，1~2 句，口语化。",
                    ].filter(Boolean).join("\n");
                    const scene = kind === "leave"
                        ? "你刚看到 TA 的位置显示 TA 离开家了，正在外面。"
                        : "你刚看到 TA 的位置显示 TA 已经回到家了。";
                    const promptParts = [
                        scene,
                        info.address ? "TA 当前所在地：" + info.address + "。" : "",
                        info.distance != null ? "离家约 " + info.distance + " 米。" : "",
                        kind === "leave"
                            ? "现在发消息关心 TA（可以是问去哪、路上小心、早点回家之类，按你的性格来）。"
                            : "现在发消息回应 TA 到家这件事（可以是放心、问吃没吃、累不累之类，按你的性格来）。",
                    ].filter(Boolean).join("\n");
                    const out = await ctx.ai.chat({ system: sysParts, prompt: promptParts, temperature: 0.9, maxTokens: 200 });
                    const text = cleanText(out);
                    if (text) return text;
                } catch (e) {
                    ctx.system.log("AI 生成话术失败，回退模板：", e && e.message ? e.message : String(e));
                }
            }
            const list = String(cfg("templates", DEFAULT_TEMPLATES))
                .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const tmpl = list.length ? list[Math.floor(Math.random() * list.length)] : "你那边还好吗？";
            return fillTemplate(tmpl, info);
        }

        // ── 频率闸门 ───────────────────────────────────────────
        const dayKey = () => {
            const d = new Date();
            return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
        };
        function syncDay() {
            if (store.get(K.day) !== dayKey()) {
                store.set(K.day, dayKey());
                store.set(K.dayCount, 0);
            }
        }
        function allowNotify() {
            const last = Number(store.get(K.lastNotify) || 0);
            const cd = Math.max(0, numCfg("cooldownMin", 40)) * 60000;
            if (last && Date.now() - last < cd) return false;
            syncDay();
            return Number(store.get(K.dayCount) || 0) < Math.max(1, numCfg("dailyLimit", 6));
        }
        function bumpNotify() {
            syncDay();
            store.set(K.dayCount, Number(store.get(K.dayCount) || 0) + 1);
            store.set(K.lastNotify, Date.now());
        }

        // ── 提示词注入 ─────────────────────────────────────────
        function writePrompt(fix, home) {
            const sid = targetSessionId();
            const prevSid = store.get(K.promptSession) || null;
            if (prevSid && prevSid !== sid) {
                try { ctx.prompts.clear({ sessionId: prevSid }); } catch (e) { /* ignore */ }
            }
            const stateText = fix.state === "home" ? "现在在家" : fix.state === "away" ? "现在不在家（外出中）" : "位置未知";
            const parts = ["【用户实时位置】" + stateText + "。"];
            if (fix.address) parts.push("当前所在地：" + fix.address + "。");
            if (fix.distance != null && home) parts.push("距离家约 " + fix.distance + " 米。");
            parts.push("（此信息仅供参考：可以自然地体现你知道 TA 的位置，但不要机械复述，也不必每次都提。）");
            const text = parts.join("");
            if (sid) {
                ctx.prompts.set(text, { sessionId: sid });
                store.set(K.promptSession, sid);
            } else {
                ctx.prompts.set(text);
                store.set(K.promptSession, null);
            }
        }

        // ── 主动关心 ───────────────────────────────────────────
        async function sendCare(kind, fix, home) {
            const sid = targetSessionId();
            const ch = targetCharacter();
            if (!sid) {
                ctx.ui.toast("位置关心：还没找到" + (ch ? "「" + ch.name + "」" : "目标角色") + "的聊天会话，先去跟 TA 聊一句");
                return false;
            }
            const info = {
                kind: kind,
                name: ch ? ch.name : "",
                address: fix.address || "",
                distance: fix.distance,
                homeAddress: home && home.address ? home.address : "",
            };
            const text = await composeMessage(kind, info);
            if (!text) return false;
            ctx.data.messages.push({ sessionId: sid, role: "assistant", content: text });
            ctx.ui.toast("位置关心已送达" + (info.name ? "：" + info.name : ""));
            ctx.system.log("已发送位置关心", kind, text);
            return true;
        }

        // ── 单次检测 ───────────────────────────────────────────
        let busy = false;
        let lastError = "";
        async function tick(reason) {
            if (busy) return;
            if (typeof document !== "undefined" && document.hidden && reason !== "manual") return;
            busy = true;
            try {
                const home = store.get(K.home) || null;
                const cur = await resolveCurrent();
                const radius = Math.max(30, numCfg("radius", 300));
                const dist = home ? Math.round(distanceM(home, cur)) : null;
                const state = dist === null ? "unknown" : dist <= radius ? "home" : "away";
                const prev = store.get(K.state) || "unknown";
                const fix = {
                    lat: cur.lat, lng: cur.lng, accuracy: cur.accuracy,
                    address: cur.address, distance: dist, state: state,
                    at: Date.now(), targetId: targetId(),
                };
                store.set(K.fix, fix);
                store.set(K.state, state);
                if (cfg("injectPrompt", true) && targetId()) writePrompt(fix, home);
                renderPanel();

                if (prev === "unknown" || state === "unknown" || state === prev) return;
                if (!home) {
                    ctx.system.log("状态有变化，但还没设「家」的坐标，跳过关心");
                    return;
                }
                const want = state === "away" ? cfg("notifyLeave", true) : cfg("notifyHome", true);
                if (!want) return;
                if (!allowNotify()) {
                    ctx.system.log("频率闸门拦下本次关心（冷却中或已达每日上限）");
                    return;
                }
                const sent = await sendCare(state === "away" ? "leave" : "home", fix, home);
                if (sent) bumpNotify();
            } catch (e) {
                lastError = e && e.message ? e.message : String(e);
                ctx.system.log("检测失败：", lastError);
                renderPanel();
            } finally {
                busy = false;
            }
        }

        // ── 触发词 → 发送真实位置卡片 ──────────────────────────
        function triggerList() {
            return String(cfg("shareTriggers", DEFAULT_TRIGGERS))
                .split(/[|｜,，\n]/).map((s) => s.trim()).filter(Boolean);
        }
        const isTrigger = (text) => triggerList().includes(text.trim());

        let sharing = false;
        async function shareLocationCard(sessionId, originalText) {
            if (sharing) { ctx.ui.toast("正在获取位置，请稍候…"); return; }
            sharing = true;
            const toast = ctx.ui.toast("正在获取当前位置…", { durationMs: 0 });
            try {
                const cur = await resolveCurrent(20000);
                const label = cur.address || "我的位置";
                // 与 App 自带「分享位置」同构：mediaType=location + mediaData.label
                ctx.data.messages.push({
                    sessionId: sessionId,
                    role: "user",
                    content: "",
                    mediaType: "location",
                    mediaData: { label: label },
                });
                // 顺手刷新状态快照（若已设家，顺带重算在家/离家）
                try {
                    const home = store.get(K.home) || null;
                    const radius = Math.max(30, numCfg("radius", 300));
                    const dist = home ? Math.round(distanceM(home, cur)) : null;
                    const state = dist === null ? "unknown" : dist <= radius ? "home" : "away";
                    store.set(K.fix, {
                        lat: cur.lat, lng: cur.lng, accuracy: cur.accuracy,
                        address: cur.address, distance: dist, state: state,
                        at: Date.now(), targetId: targetId(),
                    });
                    store.set(K.state, state);
                    if (cfg("injectPrompt", true) && targetId()) {
                        writePrompt(store.get(K.fix), home);
                    }
                } catch (e) { /* 状态刷新失败不影响发卡 */ }
                toast.close();
                ctx.ui.toast("已发送位置：" + label);
                ctx.system.log("已发送位置卡片", sessionId, label);
            } catch (e) {
                toast.close();
                const msg = e && e.message ? e.message : String(e);
                ctx.ui.toast("获取位置失败：" + msg + "，已按原文发送");
                // 别让用户的消息凭空消失：失败时原样补发
                try {
                    ctx.data.messages.push({ sessionId: sessionId, role: "user", content: originalText });
                } catch (e2) { /* ignore */ }
            } finally {
                sharing = false;
                renderPanel();
            }
        }

        // 同步钩子：命中触发词立刻吞掉原消息，异步补发位置卡片（不阻塞输入）
        const offSend = ctx.hooks.transform("user.beforeSend", (p) => {
            if (!p || typeof p.text !== "string" || !isTrigger(p.text)) return p;
            p.cancelled = true;
            void shareLocationCard(p.sessionId, p.text.trim());
            return p;
        });

        // ── 定时器 / 触发点 ────────────────────────────────────
        let timerOff = null;
        function armTimer() {
            if (timerOff) { try { timerOff(); } catch (e) { /* ignore */ } }
            const minutes = Math.max(1, numCfg("intervalMin", 5));
            timerOff = ctx.system.timers.setInterval(() => { void tick("timer"); }, minutes * 60000);
        }
        armTimer();
        ctx.system.timers.setTimeout(() => { void tick("boot"); }, 6000);

        const onVisible = () => { if (!document.hidden) void tick("visible"); };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);

        // ── 设置区面板 ─────────────────────────────────────────
        const el = (tag, css, text) => {
            const d = document.createElement(tag);
            if (css) d.style.cssText = css;
            if (text != null) d.textContent = text;
            return d;
        };
        const BTN = "flex:1;padding:8px 10px;border:1px solid rgba(127,127,127,.4);border-radius:10px;background:transparent;color:inherit;font-size:13px;cursor:pointer;";
        const panelHosts = [];
        function note(msg, tone) {
            const css = "font-size:12px;line-height:1.5;opacity:.75;" +
                (tone === "warn" ? "color:#e0803a;opacity:1;" : tone === "err" ? "color:#e05a4a;opacity:1;" : "");
            return el("div", css, msg);
        }
        function renderPanel() {
            panelHosts.forEach((host) => { try { paint(host); } catch (e) { /* ignore */ } });
        }
        function paint(host) {
            host.textContent = "";
            const wrap = el("div", "display:flex;flex-direction:column;gap:8px;padding:10px 0;font-size:13px;");
            wrap.appendChild(el("div", "font-weight:600;", "位置感知设置"));

            const isShell = typeof navigator !== "undefined" && /FloatShell/i.test(navigator.userAgent || "");
            const hasGeo = typeof navigator !== "undefined" && !!navigator.geolocation;
            const ch = targetCharacter();
            wrap.appendChild(note("目标角色（离家关心用）：" + (ch ? ch.name : "未选择")));
            const home = store.get(K.home);
            wrap.appendChild(note("家：" + (home ? (home.address || "已设坐标（无地址）") : "未设置")));
            const fix = store.get(K.fix);
            if (fix) {
                const st = fix.state === "home" ? "在家" : fix.state === "away" ? "离家" : "未知";
                wrap.appendChild(note(
                    "上次检测：" + st +
                    (fix.distance != null ? "，离家约 " + fix.distance + " 米" : "") +
                    (fix.address ? "，" + fix.address : "") +
                    "（" + new Date(fix.at).toLocaleTimeString() + "）",
                    fix.state === "away" ? "warn" : null,
                ));
            } else {
                wrap.appendChild(note("上次检测：还没有记录"));
            }
            wrap.appendChild(note("发位置卡片：在任意聊天窗口发送 " + triggerList().map((t) => "「" + t + "」").join(" 或 ") + " 即可"));
            if (lastError) wrap.appendChild(note("最近一次错误：" + lastError, "err"));
            if (isShell) {
                wrap.appendChild(note("提示：当前运行在安卓壳里，壳未声明定位权限，插件很可能拿不到位置；请在浏览器或 PWA 中使用。", "warn"));
            } else if (!hasGeo) {
                wrap.appendChild(note("提示：此环境没有定位能力（需 HTTPS 或 localhost 打开）。", "warn"));
            }
            if (!amapKey()) {
                wrap.appendChild(note("提示：还没填高德 Key，地址会退化为「我的位置」，只能判定离家与否。", "warn"));
            }

            const chars = ctx.data.characters.list();
            const selectRow = el("div", "display:flex;gap:8px;align-items:center;");
            const sel = document.createElement("select");
            sel.style.cssText = "flex:1;padding:8px;border:1px solid rgba(127,127,127,.4);border-radius:10px;background:transparent;color:inherit;font-size:13px;";
            const empty = document.createElement("option");
            empty.value = "";
            empty.textContent = chars.length ? "— 选择角色 —" : "（还没有角色卡）";
            sel.appendChild(empty);
            chars.forEach((c) => {
                const o = document.createElement("option");
                o.value = c.id;
                o.textContent = c.name || c.id;
                if (c.id === targetId()) o.selected = true;
                sel.appendChild(o);
            });
            const applyBtn = el("button", BTN, "保存角色");
            applyBtn.style.flex = "0 0 auto";
            applyBtn.onclick = () => {
                store.set(K.target, sel.value || "");
                const prevSid = store.get(K.promptSession) || null;
                if (prevSid && prevSid !== targetSessionId()) {
                    try { ctx.prompts.clear({ sessionId: prevSid }); } catch (e) { /* ignore */ }
                    store.set(K.promptSession, null);
                }
                ctx.ui.toast(sel.value ? "已指定角色，TA 会收到位置关心" : "已取消指定角色");
                renderPanel();
            };
            selectRow.appendChild(sel);
            selectRow.appendChild(applyBtn);
            wrap.appendChild(selectRow);

            const row1 = el("div", "display:flex;gap:8px;");
            const setHomeBtn = el("button", BTN, "定位当前位置并设为家");
            setHomeBtn.onclick = async () => {
                setHomeBtn.disabled = true;
                setHomeBtn.textContent = "定位中…";
                try {
                    const cur = await resolveCurrent(20000);
                    store.set(K.home, { lat: cur.lat, lng: cur.lng, address: cur.address });
                    store.set(K.state, "unknown");
                    ctx.ui.toast(cur.address ? "已把「" + cur.address + "」设为家" : "已把当前位置设为家");
                } catch (e) {
                    ctx.ui.toast("定位失败：" + (e && e.message ? e.message : String(e)));
                } finally {
                    renderPanel();
                }
            };
            row1.appendChild(setHomeBtn);
            wrap.appendChild(row1);

            const row2 = el("div", "display:flex;gap:8px;");
            const addrInput = document.createElement("input");
            addrInput.placeholder = "或手动输入家庭地址后点右侧按钮";
            addrInput.style.cssText = "flex:1;padding:8px;border:1px solid rgba(127,127,127,.4);border-radius:10px;background:transparent;color:inherit;font-size:13px;";
            const addrBtn = el("button", BTN, "解析地址");
            addrBtn.style.flex = "0 0 auto";
            addrBtn.onclick = async () => {
                const v = addrInput.value.trim();
                if (!v) { ctx.ui.toast("先填一个地址"); return; }
                addrBtn.disabled = true;
                addrBtn.textContent = "解析中…";
                try {
                    const g = await geocodeAddress(v);
                    store.set(K.home, { lat: g.lat, lng: g.lng, address: g.address });
                    store.set(K.state, "unknown");
                    ctx.ui.toast("已把「" + g.address + "」设为家");
                } catch (e) {
                    ctx.ui.toast(e && e.message ? e.message : "解析失败");
                } finally {
                    renderPanel();
                }
            };
            row2.appendChild(addrInput);
            row2.appendChild(addrBtn);
            wrap.appendChild(row2);

            const row3 = el("div", "display:flex;gap:8px;");
            const checkBtn = el("button", BTN, "立即检测一次");
            checkBtn.onclick = async () => {
                checkBtn.disabled = true;
                checkBtn.textContent = "检测中…";
                await tick("manual");
                renderPanel();
            };
            const clearBtn = el("button", BTN, "清除家的坐标");
            clearBtn.onclick = () => {
                store.set(K.home, null);
                store.set(K.state, "unknown");
                ctx.ui.toast("已清除家的坐标");
                renderPanel();
            };
            row3.appendChild(checkBtn);
            row3.appendChild(clearBtn);
            wrap.appendChild(row3);

            wrap.appendChild(note("说明：离家关心只在状态从「在家」切到「离家」（或反向）时触发，并受冷却与每日上限约束；位置卡片是你手动触发的，不受这些限制。"));
            host.appendChild(wrap);
        }

        ctx.ui.slot("settings.section", (host) => {
            panelHosts.push(host);
            paint(host);
            return () => {
                const i = panelHosts.indexOf(host);
                if (i >= 0) panelHosts.splice(i, 1);
            };
        });

        const offChange = ctx.system.settings.onChange((next) => {
            if (next && Object.prototype.hasOwnProperty.call(next, "intervalMin")) armTimer();
            renderPanel();
        });

        // ── 清理 ───────────────────────────────────────────────
        return () => {
            try { offSend(); } catch (e) { /* ignore */ }
            try { offChange(); } catch (e) { /* ignore */ }
            try { if (timerOff) timerOff(); } catch (e) { /* ignore */ }
            try { document.removeEventListener("visibilitychange", onVisible); } catch (e) { /* ignore */ }
            try { window.removeEventListener("focus", onVisible); } catch (e) { /* ignore */ }
            const sid = store.get(K.promptSession) || null;
            if (sid) { try { ctx.prompts.clear({ sessionId: sid }); } catch (e) { /* ignore */ } }
            try { ctx.prompts.clear(); } catch (e) { /* ignore */ }
        };
    },
};
