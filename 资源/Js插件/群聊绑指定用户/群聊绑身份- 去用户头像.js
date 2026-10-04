// 群聊身份绑定 · apiVersion 1
export default {
  manifest: {
    id: "group-user-identity-binding",
    name: "群聊身份绑定",
    apiVersion: 1,
    version: "1.15.0",
    author: "小坊",
    description: "为每个群聊单独绑定一张用户身份卡，覆盖全局身份（人设、界面头像与名字一并生效）",
    permissions: ["chat.read", "ui", "storage"],
  },

  setup(ctx) {
    const STORE_KEY = "bindings";
    const IDENTITY_KV = "ai_phone_user_identities_v1";

    // 没设头像的用户：复刻「设置 → 用户身份」里的灰底人形图标。
    // 用 base64 而不是 URL 编码——# 号在 URL 编码里会被二次转义，
    // 颜色变成无效值后整张图会被浏览器画成纯黑。
    const DEFAULT_USER_AVATAR = (function () {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">'
        + '<rect width="40" height="40" fill="#f2f3f5"/>'
        + '<g transform="translate(11 11) scale(0.75)" fill="none" stroke="#a0a3a8"'
        + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>'
        + '<circle cx="12" cy="7" r="4"/>'
        + "</g></svg>";
      try {
        return "data:image/svg+xml;base64," + btoa(svg);
      } catch (e) {
        return "/images/default-moment-avatar.png";   // 兜底，正常不会走到
      }
    })();
        // 群成员没设头像时，宿主用这张兜底图
    const CHAR_FALLBACK_AVATAR = "/images/default-moment-avatar.png";
    

    // ── 身份卡：读入内存，界面扫描时同步可用 ──
    let identities = [];
    let identitiesReady = false;

    function readHostKv(key) {
      return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open("AiPhoneKvDB"); } catch (e) { return resolve(null); }
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          const done = (v) => { resolve(v); try { db.close(); } catch (e) { /* ignore */ } };
          if (!db.objectStoreNames.contains("entries")) return done(null);
          try {
            const get = db.transaction("entries", "readonly").objectStore("entries").get(key);
            get.onsuccess = () => done(get.result ? get.result.value : null);
            get.onerror = () => done(null);
          } catch (e) { done(null); }
        };
      });
    }

    async function refreshIdentities() {
      const raw = await readHostKv(IDENTITY_KV);
      let next = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) next = parsed;
        } catch (e) { /* 解析失败保留上一次结果 */ }
      }
      identities = next;
      identitiesReady = true;
      return identities;
    }

    // ── 绑定读写 ──
    const getBindings = () => ctx.system.storage.get(STORE_KEY) || {};

    function setBinding(sessionId, identityId) {
      const all = getBindings();
      if (identityId) all[sessionId] = identityId; else delete all[sessionId];
      ctx.system.storage.set(STORE_KEY, all);
    }

    const groupNameOf = (s) => (s ? (s.groupName || s.alias || s.contactId || s.id) : "");

    function resolveAvatarUrl(identity) {
      const url = (identity.avatarUrl || "").trim();
      if (url && /^(data:|https?:|\/)/i.test(url)) return url;
      return DEFAULT_USER_AVATAR;
    }

    // 某个会话生效的绑定身份（同步）
    function boundIdentityOf(sessionId) {
      if (!sessionId || !identitiesReady) return null;
      const session = ctx.data.sessions.get(sessionId);
      if (!session || !session.isGroup) return null;
      const boundId = getBindings()[sessionId];
      if (!boundId) return null;
      return identities.find((i) => i.id === boundId) || null;
    }

    // ── 复刻宿主人设文本格式 ──
    function buildPersonaText(id) {
      const parts = ["The user's name is " + id.name + "."];
      if (id.gender && id.gender !== "保密") parts.push("Gender: " + id.gender);
      if (id.age) parts.push("Age: " + id.age);
      if (id.occupation) parts.push("Occupation: " + id.occupation);
      if (id.bio) parts.push("Bio: " + id.bio);
      if (id.customSettings) parts.push(id.customSettings);
      return parts.join("\n");
    }

    // ── 发给 AI 的内容：替换用户人设段 ──
    ctx.hooks.transform("llm.request", async (p) => {
      if (!p.sessionId) return p;
      const session = ctx.data.sessions.get(p.sessionId);
      if (!session || !session.isGroup) return p;

      const boundId = getBindings()[p.sessionId];
      if (!boundId) return p;

      const list = await refreshIdentities();
      const identity = list.find((i) => i.id === boundId);
      if (!identity) return p;

      const personaText = buildPersonaText(identity);

      // 群成员名字不参与"用户昵称"匹配：身份卡和群里角色重名时不会改错发言人
      const memberNames = new Set(
        (session.participantIds || [])
          .map((cid) => ctx.data.characters.get(cid))
          .filter(Boolean)
          .map((c) => (c.name || "").trim()),
      );
      const userNames = list
        .map((i) => (i.name || "").trim())
        .concat(["用户", "User"])
        .filter((n) => n && !memberNames.has(n));

      let personaHit = false;

      for (const msg of p.messages) {
        if (typeof msg.content !== "string") continue;

        if (msg.content.indexOf("<personaDescription>") >= 0) {
          msg.content = msg.content.replace(
            /<personaDescription>[\s\S]*?<\/personaDescription>/g,
            "<personaDescription>\n" + personaText + "\n</personaDescription>",
          );
          personaHit = true;
        }

        // 群成员名单：宿主用「（用户本人）」标记你那一项
        if (msg.content.indexOf("（用户本人）") >= 0) {
          msg.content = msg.content.replace(
            /[^、：\n]{1,32}（用户本人）/g,
            identity.name + "（用户本人）",
          );
        }

        // 群聊历史每条消息带 [发送者]: 前缀，把属于用户的那部分改成绑定身份的名字
        if (msg.role === "user") {
          msg.content = msg.content.replace(/^\[([^\]\n]{1,32})\]:/gm, (whole, name) =>
            userNames.indexOf(name.trim()) >= 0 ? "[" + identity.name + "]:" : whole);
        }
      }

      ctx.system.log(personaHit
        ? "群「" + groupNameOf(session) + "」使用身份：" + identity.name
        : "群「" + groupNameOf(session) + "」未找到 personaDescription 段，本次未改写人设");
      return p;
    });

    // ── 群管理动作固定用「你」指代用户，避免名字对不上导致动作失效 ──
    ctx.hooks.transform("prompt.system", (p) => {
      if (!p.isGroup || !p.sessionId) return p;
      if (!getBindings()[p.sessionId]) return p;
      p.hint = (p.hint ? p.hint + "\n\n" : "")
        + "【群管理动作的指代规则】输出禁言、移出群聊、转让群主、设置或取消管理员"
        + "这类群管理动作时，如果对象是用户本人，一律写「你」，不要写用户的名字。"
        + "例：[林可将你禁言10分钟]。日常对话里照常称呼用户，不受此规则限制。";
      return p;
    });

    // ══ 界面覆盖：全部走逐元素改写，不用全局 CSS ══════════════
    // 理由：消息列表同时显示多个群，一条全局 CSS 分不清哪一格属于哪个群，
    // 必然互相串；逐行认出所属会话再改，才能做到一群一身份。

    let currentSessionId = "";
    let queued = false;
    let observer = null;
    let staleName = "";

    // 改过的 img 都记住原值，解绑时能还原
    function setImg(img, url) {
      if (!img) return;
      if (img.dataset.gubOrig === undefined) img.dataset.gubOrig = img.getAttribute("src") || "";
      if (img.getAttribute("src") !== url) img.src = url;
    }

    function restoreImg(img) {
      if (!img || img.dataset.gubOrig === undefined) return;
      if (img.getAttribute("src") !== img.dataset.gubOrig) img.src = img.dataset.gubOrig;
      delete img.dataset.gubOrig;
    }

    // ── 消息列表：逐行按该行所属的群处理 ──
    // 行上可用于识别的只有群名；同名群一律跳过，宁可不改也不改错。
    function buildGroupIndexByName() {
      const map = new Map();
      const dup = new Set();
      for (const s of ctx.data.sessions.list()) {
        if (!s.isGroup) continue;
        const name = (s.groupName || "群聊").trim();
        if (map.has(name)) dup.add(name); else map.set(name, s);
      }
      for (const n of dup) map.delete(n);
      return map;
    }

    function patchSessionList() {
      const rows = document.querySelectorAll(".minimal-list-item");
      if (rows.length === 0) return;
      const index = buildGroupIndexByName();

      for (const row of rows) {
        // 四宫格 = 群聊行；宿主把用户本人放在第一格
        const grid = row.querySelector(".minimal-avatar-wrapper.grid");
        if (!grid) continue;
        const cell = grid.firstElementChild;
        const img = cell ? cell.querySelector("img") : null;
        if (!cell) continue;

        const nameEl = row.querySelector(".ts-16");
        const rowName = nameEl ? (nameEl.textContent || "").trim() : "";
        const session = rowName ? index.get(rowName) : null;

        if (!session) {
          if (cell.style.display === "none") cell.style.display = "";
          if (img) restoreImg(img);
          continue;
        }

        // 围观群：你不在群里，四宫格里不该出现你。
        // 宿主渲染的是 [你, 成员1, 成员2, 成员3]，整体错开一格，
        // 改成 [成员1, 成员2, 成员3, 成员4]，即群内前 4 个角色。
        if (session.isSpectator) {
          const ids = session.participantIds || [];
          const cells = Array.from(grid.children).slice(0, 4);
          cells.forEach((c, i) => {
            const ci = c.querySelector("img");
            const ch = ids[i] ? ctx.data.characters.get(ids[i]) : null;
            if (!ch) {                    // 没有第 i+1 个成员，这一格收起
              if (ci) restoreImg(ci);
              c.style.display = "none";
              return;
            }
            if (c.style.display === "none") c.style.display = "";
            const u = (ch.avatar || "").trim();
            if (ci) setImg(ci, u && /^(data:|https?:|\/)/i.test(u) ? u : CHAR_FALLBACK_AVATAR);
          });
          continue;
        }

        if (cell.style.display === "none") cell.style.display = "";

        const identity = boundIdentityOf(session.id);
        if (!identity) { if (img) restoreImg(img); continue; }
        setImg(img, resolveAvatarUrl(identity));
      }
    }

    // ── 聊天室里"我"的气泡头像 ──
    function patchRoomAvatars(identity) {
      const wrappers = document.querySelectorAll('.chat-msg-wrapper[data-role="user"]');
      for (const w of wrappers) {
        const holder = w.querySelector(".chat-msg-avatar");
        if (!holder) continue;
        const img = holder.tagName === "IMG" ? holder : holder.querySelector("img");
        if (!img) continue;
        if (!identity) restoreImg(img);
        else setImg(img, resolveAvatarUrl(identity));
      }
    }

    // ── 聊天信息 / 群成员管理：你自己那一行文字是「名字（我）」──
    function patchPanels(identity) {
      if (!identity) return;
      const name = identity.name || "我";
      const avatar = resolveAvatarUrl(identity);

      for (const el of document.querySelectorAll(".menu-label")) {
        const m = (el.textContent || "").match(/^(.+)（我）$/);
        if (!m || m[1] === name) continue;
        staleName = m[1];                 // 宿主原本显示的名字，弹窗标题要用
        el.textContent = name + "（我）";
        const rowEl = el.closest(".menu-item");
        setImg(rowEl ? rowEl.querySelector("img") : null, avatar);
      }

      // 成员操作弹窗 / 禁言时长弹窗的标题里也带着名字
      if (!staleName) return;
      for (const el of document.querySelectorAll(".modal-header-title")) {
        const text = el.textContent || "";
        if (text.indexOf(staleName) >= 0) el.textContent = text.split(staleName).join(name);
      }
    }

    function sweep() {
      if (!identitiesReady) return;
      const identity = boundIdentityOf(currentSessionId);
      patchSessionList();
      patchRoomAvatars(identity);
      patchPanels(identity);
    }

    function scheduleSweep() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sweep(); });
    }

    ctx.hooks.on("session.opened", (p) => {
      currentSessionId = p.sessionId;
      staleName = "";
      sweep();
    });

    // 界面随时可能被宿主重绘：DOM 变化即刻补一次，另外每 500ms 兜底扫一遍，
    // 保证进群/切群后半秒内一定是对的（扫描只查几个选择器，开销可忽略）
    refreshIdentities().then(() => {
      sweep();
      observer = new MutationObserver(scheduleSweep);
      observer.observe(document.body, { childList: true, subtree: true });
    });
    ctx.system.timers.setInterval(sweep, 500);

    // 身份卡可能在「设置 → 用户身份」被改过：每 5 秒重读一次，回到页面时也重读
    ctx.system.timers.setInterval(() => { refreshIdentities().then(sweep); }, 5000);
    const onFocus = () => { refreshIdentities().then(sweep); };
    window.addEventListener("focus", onFocus);

    // ── UI：插件管理页的自定义设置区 ──
    ctx.ui.slot("settings.section", (el) => {
      el.innerHTML = '<div style="font-size:12px;opacity:.6;padding:4px 0;">正在读取…</div>';

      let disposed = false;

      async function render() {
        if (disposed) return;
        const list = await refreshIdentities();
        if (disposed) return;

        const groups = ctx.data.sessions.list().filter((s) => s.isGroup);
        const bindings = getBindings();
        el.innerHTML = "";

        const tip = document.createElement("div");
        tip.style.cssText = "font-size:11px;opacity:.6;line-height:1.6;margin-bottom:8px;";
        tip.textContent = list.length === 0
          ? "没读到身份卡，请先到「设置 → 用户身份」创建。"
          : "为单个群聊指定用户身份，仅覆盖该群的用户人设，不影响全局绑定。";
        el.appendChild(tip);

        if (groups.length === 0) {
          const empty = document.createElement("div");
          empty.style.cssText = "font-size:12px;opacity:.5;padding:6px 0;";
          empty.textContent = "还没有群聊会话。";
          el.appendChild(empty);
        }

        groups.forEach((s) => {
          const row = document.createElement("div");
          row.style.cssText =
            "display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(128,128,128,.2);";

          const label = document.createElement("span");
          label.style.cssText =
            "flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          label.textContent = groupNameOf(s);
          row.appendChild(label);

          const select = document.createElement("select");
          select.style.cssText =
            "flex:0 0 132px;max-width:132px;font-size:12px;padding:5px 6px;border:1px solid rgba(128,128,128,.35);border-radius:8px;background:transparent;color:inherit;";

          const none = document.createElement("option");
          none.value = "";
          none.textContent = "跟随全局";
          select.appendChild(none);

          list.forEach((i) => {
            const opt = document.createElement("option");
            opt.value = i.id;
            opt.textContent = i.name || "未命名身份";
            select.appendChild(opt);
          });

          select.value = bindings[s.id] || "";
          select.addEventListener("change", () => {
            setBinding(s.id, select.value);
            sweep();
            const picked = list.find((i) => i.id === select.value);
            ctx.ui.toast(picked
              ? groupNameOf(s) + " → " + picked.name
              : groupNameOf(s) + " 已改回跟随全局");
          });
          row.appendChild(select);
          el.appendChild(row);
        });
      }

      render();

      return () => {
        disposed = true;
        el.innerHTML = "";
      };
    });

    // 插件禁用/卸载时收干净
    return () => {
      if (observer) { observer.disconnect(); observer = null; }
      window.removeEventListener("focus", onFocus);
    };
  },
};