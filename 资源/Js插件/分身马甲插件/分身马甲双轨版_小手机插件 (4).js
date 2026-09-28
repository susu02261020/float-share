// 分身马甲与双轨会话 · 小手机聊天扩展插件（二合一合并版）
// 遵循小手机插件契约 apiVersion 1 (lib/chat-plugin-types.ts)
//
// 功能特色：
// 1. 【随时无缝切马甲】：同会话内随时点击马甲卡片秒级换号，动态改写 AI 认知与称呼（适合戏中戏/调戏）；
// 2. 【一键开辟双轨线】：为指定小号一键克隆该角色的平行世界好友，生成独立会话并在微信列表中常驻！

export default {
    manifest: {
        id: "persona-mask-dual-track",
        name: "分身马甲与双轨会话",
        apiVersion: 1,
        version: "1.1.0",
        author: "Antigravity",
        description: "在小手机聊天中随时创建与无缝切换小号马甲，支持一键开辟该角色的平行小号双轨新会话（独立聊天记录与记忆流）。",
        permissions: ["chat.read", "chat.write", "ui", "storage", "ai"],
        settings: [
            {
                key: "insertSystemNotice",
                label: "切号时插入对话提示",
                type: "boolean",
                default: true,
                description: "切换马甲时，在聊天记录中插入一条小灰条提示，帮助 AI 更好识别转折点",
            },
            {
                key: "defaultTrackSuffix",
                label: "双轨默认后缀命名",
                type: "text",
                default: "[小号线]",
                description: "开启双轨时，默认追加在角色名后面的后缀",
            },
            {
                key: "capsuleDisplayMode",
                label: "马甲入口样式",
                type: "select",
                default: "float_ball",
                description: "支持🔮灵动悬浮球（可自由拖拽）与🔼顶栏居中胶囊两种样式",
                options: [
                    { value: "float_ball", label: "🔮 悬浮球 (默认·自由拖拽不挡美化)" },
                    { value: "header_compact", label: "🔼 顶栏居中 (经典紧凑胶囊)" }
                ]
            }
        ]
    },

    setup(ctx) {
        const STORAGE_KEY_MASKS = "user_masks_list_v2";
        const STORAGE_KEY_SESSION_MAP = "session_mask_map_v2";

        // 默认预设萌趣头像，方便用户一键点选
        const PRESET_AVATARS = [
            "🐱", "🐰", "🦊", "🐻", "🐼", "🎭", "🕶️", "🌸", "⭐", "🌙"
        ];

        // 自动激活刚刚创建的双轨会话
        try {
            const pendingSessionId = sessionStorage.getItem("ai_phone_pending_open_session");
            if (pendingSessionId) {
                sessionStorage.removeItem("ai_phone_pending_open_session");
                setTimeout(() => {
                    if (typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("ai-chat-open-session", {
                            detail: { sessionId: pendingSessionId }
                        }));
                    }
                }, 500);
            }
        } catch (e) {}

        // --- 纯前端自治 IndexedDB 操作辅助（100% 零修改宿主源码，自适应已有版本） ---
        function openIDB(dbName) {
            return new Promise((resolve, reject) => {
                if (typeof window === "undefined" || !window.indexedDB) {
                    reject(new Error("当前浏览器环境不支持 IndexedDB"));
                    return;
                }
                // 不传版本号参数，浏览器自动以已有当前版本打开，彻底避免版本不匹配报错
                const req = window.indexedDB.open(dbName);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error || new Error("打开数据库失败"));
            });
        }

        async function getKvStorageValue(key) {
            try {
                const local = localStorage.getItem(key);
                if (local) return local;
            } catch (e) {}

            try {
                const db = await openIDB("AiPhoneKvDB");
                if (!db.objectStoreNames.contains("entries")) return null;
                return new Promise((resolve) => {
                    const tx = db.transaction("entries", "readonly");
                    const store = tx.objectStore("entries");
                    const req = store.get(key);
                    req.onsuccess = () => resolve(req.result ? req.result.value : null);
                    req.onerror = () => resolve(null);
                });
            } catch (e) {
                return null;
            }
        }

        async function setKvStorageValue(key, value) {
            try {
                localStorage.setItem(key, value);
            } catch (e) {}

            try {
                const db = await openIDB("AiPhoneKvDB");
                if (!db.objectStoreNames.contains("entries")) return false;
                return new Promise((resolve, reject) => {
                    const tx = db.transaction("entries", "readwrite");
                    const store = tx.objectStore("entries");
                    const req = store.put({ key, value });
                    req.onsuccess = () => resolve(true);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) {
                return false;
            }
        }

        async function putChatDbRecord(tableName, record) {
            const db = await openIDB("AiPhoneChatDB");
            return new Promise((resolve, reject) => {
                if (!db.objectStoreNames.contains(tableName)) {
                    console.warn(`[DualTrack] 表 ${tableName} 不存在，跳过写入`);
                    resolve(false);
                    return;
                }
                const tx = db.transaction(tableName, "readwrite");
                const store = tx.objectStore(tableName);
                const req = store.put(record);
                req.onsuccess = () => resolve(true);
                req.onerror = () => reject(req.error);
            });
        }

        // --- 严格成对绑定的双轨证书存储 (跨角色绝对隔离) ---
        const STORAGE_KEY_DUAL_PAIRS = "dual_track_pairs_v3";

        function getDualTrackPairs() {
            const raw = ctx.system.storage.get(STORAGE_KEY_DUAL_PAIRS);
            if (Array.isArray(raw)) return raw;
            return [];
        }

        function saveDualTrackPairs(pairs) {
            ctx.system.storage.set(STORAGE_KEY_DUAL_PAIRS, pairs);
        }

        // --- 核心辅助：稳妥通过 sessionId 找到当前 character ---
        function getCharacterBySessionId(sessionId) {
            if (!sessionId) return null;
            const session = ctx.data.sessions.get(sessionId);
            if (!session || session.isGroup) return null;
            // 1. 若 session.contactId 直接就是 characterId
            let char = ctx.data.characters.get(session.contactId);
            if (char) return char;
            // 2. 若 session.contactId 是 contact.id，从 contacts 找 characterId
            const contacts = ctx.data.contacts.list() || [];
            const contact = contacts.find(c => c.id === session.contactId);
            if (contact && contact.characterId) {
                char = ctx.data.characters.get(contact.characterId);
                if (char) return char;
            }
            // 3. 兜底：从 participantIds 找
            if (Array.isArray(session.participantIds) && session.participantIds.length > 0) {
                char = ctx.data.characters.get(session.participantIds[0]);
                if (char) return char;
            }
            return null;
        }

        // --- 核心辅助：稳妥通过 characterId 找到对应单聊 session ---
        function getSessionByCharacterId(characterId) {
            if (!characterId) return null;
            const allSessions = ctx.data.sessions.list() || [];
            const contacts = ctx.data.contacts.list() || [];
            const contact = contacts.find(c => c.characterId === characterId);
            const contactId = contact ? contact.id : null;

            return allSessions.find(s =>
                !s.isGroup && (
                    s.contactId === characterId ||
                    (contactId && s.contactId === contactId) ||
                    (Array.isArray(s.participantIds) && s.participantIds.includes(characterId))
                )
            ) || null;
        }

        // --- 智能双轨配对解析：结合 sessionId、characterId 与名称特征多重自愈识别 ---
        function resolveTrackContext(sessionId, characterId) {
            const pairs = getDualTrackPairs();
            const allChars = ctx.data.characters.list() || [];

            // 确定当前角色
            let currentChar = characterId ? ctx.data.characters.get(characterId) : null;
            if (!currentChar && sessionId) {
                currentChar = getCharacterBySessionId(sessionId);
            }
            if (!currentChar) return null;

            // 1. 先查已有 pairs 中的配对记录
            // 1.1 作为副线小号检查
            for (const p of pairs) {
                if ((sessionId && p.trackSessionId === sessionId) || (currentChar.id && p.trackCharId === currentChar.id)) {
                    return { type: "track", pair: p, currentChar };
                }
            }
            // 1.2 作为母本大号检查
            for (const p of pairs) {
                if ((sessionId && p.mainSessionId === sessionId) || (currentChar.id && p.mainCharId === currentChar.id)) {
                    const allRelated = pairs.filter(item => item.mainCharId === currentChar.id);
                    return { type: "main", pairs: allRelated, currentChar };
                }
            }

            // 2. 启发式智能自愈（名字匹配）：支持用户在通讯录改名、新建或重装插件后自动重连
            if (currentChar.name) {
                const match = currentChar.name.match(/^(.*?)\s*\[(.*?)\]$/);
                if (match) {
                    // 当前是副线角色（例如：凤晏璃 [小号线]）
                    const baseName = match[1].trim();
                    const tag = match[2].trim();
                    const mainChar = allChars.find(c => c.name === baseName && c.id !== currentChar.id);
                    if (mainChar) {
                        const mainSession = getSessionByCharacterId(mainChar.id);
                        const maskName = tag.replace(/线$/, "");
                        const autoPair = {
                            id: "auto_" + currentChar.id,
                            mainSessionId: mainSession ? mainSession.id : "",
                            mainCharId: mainChar.id,
                            mainCharName: mainChar.name,
                            trackSessionId: sessionId || "",
                            trackCharId: currentChar.id,
                            trackCharName: currentChar.name,
                            maskId: "",
                            maskName: maskName,
                            maskBio: "",
                            createdAt: Date.now()
                        };
                        registerDualTrackPair(autoPair);
                        return { type: "track", pair: autoPair, currentChar };
                    }
                } else {
                    // 当前是母本大号，检查是否有属于该母本的副线角色（例如：凤晏璃 [小号线]）
                    const subChars = allChars.filter(c => c.id !== currentChar.id && c.name && c.name.startsWith(currentChar.name + " ["));
                    if (subChars.length > 0) {
                        const autoPairs = subChars.map(subChar => {
                            const subSession = getSessionByCharacterId(subChar.id);
                            const tagMatch = subChar.name.match(/\[(.*?)\]$/);
                            return {
                                id: "auto_" + subChar.id,
                                mainSessionId: sessionId || "",
                                mainCharId: currentChar.id,
                                mainCharName: currentChar.name,
                                trackSessionId: subSession ? subSession.id : "",
                                trackCharId: subChar.id,
                                trackCharName: subChar.name,
                                maskId: "",
                                maskName: tagMatch ? tagMatch[1].replace(/线$/, "") : "小号",
                                maskBio: "",
                                createdAt: Date.now()
                            };
                        });
                        return { type: "main", pairs: autoPairs, currentChar };
                    }
                }
            }

            // 3. 既不是副线，也没有任何属于该母本的副线角色，说明是其他独立角色卡（如顾医生、沈警官）
            // 必须返回 null，严格保证跨角色底层物理隔离！
            return null;
        }

        function registerDualTrackPair(pair) {
            const pairs = getDualTrackPairs().filter(p => p.trackSessionId !== pair.trackSessionId);
            pairs.unshift(pair);
            saveDualTrackPairs(pairs);
        }

        // --- 提取指定会话最近的真实对话记录并整理为台本流 ---
        function getRecentDialogues(targetSessionId, targetCharId, maxCount = 12, userAlias = "对方") {
            let session = null;
            if (targetSessionId) {
                session = ctx.data.sessions.get(targetSessionId);
            }
            if (!session && targetCharId) {
                session = getSessionByCharacterId(targetCharId);
            }
            if (!session || !session.id) return "";

            try {
                const allMsgs = ctx.data.messages.list(session.id) || [];
                const chatMsgs = allMsgs.filter(m => (m.role === "user" || m.role === "assistant") && m.content && String(m.content).trim());
                if (chatMsgs.length === 0) return "";

                const recent = chatMsgs.slice(-maxCount);
                return recent.map(m => {
                    const speaker = m.role === "user" ? userAlias : "你";
                    const text = String(m.content).trim().replace(/\r?\n+/g, ' ');
                    return `${speaker}: "${text}"`;
                }).join("\n");
            } catch (e) {
                return "";
            }
        }

        // --- 读取某角色在数据库中的长期记忆 (只读查询) ---
        async function loadCharacterMemoriesRaw(characterId) {
            if (!characterId) return [];
            try {
                const db = await openIDB("ai_phone_memory_db_v1");
                if (!db.objectStoreNames.contains("memories")) return [];

                return new Promise((resolve) => {
                    const tx = db.transaction("memories", "readonly");
                    const store = tx.objectStore("memories");
                    let req;
                    try {
                        if (store.indexNames.contains("by_character")) {
                            req = store.index("by_character").getAll(characterId);
                        } else {
                            req = store.getAll();
                        }
                    } catch (e) {
                        req = store.getAll();
                    }
                    req.onsuccess = () => {
                        const res = req.result || [];
                        resolve(res.filter(item => item.characterId === characterId));
                    };
                    req.onerror = () => resolve([]);
                });
            } catch (e) {
                return [];
            }
        }

        // --- 深度复制角色记忆库 (ai_phone_memory_db_v1 -> memories) ---
        async function cloneCharacterMemories(sourceCharId, targetCharId) {
            try {
                const db = await openIDB("ai_phone_memory_db_v1");
                if (!db.objectStoreNames.contains("memories")) return 0;

                const entries = await new Promise((resolve) => {
                    const tx = db.transaction("memories", "readonly");
                    const store = tx.objectStore("memories");
                    let req;
                    try {
                        if (store.indexNames.contains("by_character")) {
                            req = store.index("by_character").getAll(sourceCharId);
                        } else {
                            req = store.getAll();
                        }
                    } catch (e) {
                        req = store.getAll();
                    }
                    req.onsuccess = () => {
                        const res = req.result || [];
                        resolve(res.filter(item => item.characterId === sourceCharId));
                    };
                    req.onerror = () => resolve([]);
                });

                if (!Array.isArray(entries) || entries.length === 0) return 0;

                await new Promise((resolve, reject) => {
                    const tx = db.transaction("memories", "readwrite");
                    const store = tx.objectStore("memories");
                    for (const entry of entries) {
                        const clonedEntry = {
                            ...entry,
                            id: "mem_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                            characterId: targetCharId
                        };
                        store.put(clonedEntry);
                    }
                    tx.oncomplete = () => resolve(entries.length);
                    tx.onerror = () => reject(tx.error);
                });

                return entries.length;
            } catch (err) {
                console.warn("[DualTrack] 复制记忆库失败 (可能未生成过记忆):", err);
                return 0;
            }
        }

        // --- 数据读写辅助 ---
        function getMasks() {
            // 兼容性：优先读 v2，若无则尝试迁移旧版已创建的马甲
            let list = ctx.system.storage.get(STORAGE_KEY_MASKS);
            if (Array.isArray(list) && list.length > 0) return list;
            const legacy = ctx.system.storage.get("user_masks_list");
            if (Array.isArray(legacy) && legacy.length > 0) {
                ctx.system.storage.set(STORAGE_KEY_MASKS, legacy);
                return legacy;
            }
            return [];
        }

        function saveMasks(list) {
            ctx.system.storage.set(STORAGE_KEY_MASKS, list);
        }

        function getSessionMaskMap() {
            const raw = ctx.system.storage.get(STORAGE_KEY_SESSION_MAP);
            if (raw && typeof raw === "object") return raw;
            const legacy = ctx.system.storage.get("session_mask_map");
            if (legacy && typeof legacy === "object") {
                ctx.system.storage.set(STORAGE_KEY_SESSION_MAP, legacy);
                return legacy;
            }
            return {};
        }

        function getActiveMaskId(sessionId) {
            if (!sessionId) return null;
            const map = getSessionMaskMap();
            return map[sessionId] || null;
        }

        function setActiveMaskId(sessionId, maskId) {
            if (!sessionId) return;
            const map = getSessionMaskMap();
            if (maskId) {
                map[sessionId] = maskId;
            } else {
                delete map[sessionId];
            }
            ctx.system.storage.set(STORAGE_KEY_SESSION_MAP, map);
        }

        function getActiveMask(sessionId) {
            const maskId = getActiveMaskId(sessionId);
            if (!maskId) return null;
            const masks = getMasks();
            return masks.find(m => m.id === maskId) || null;
        }

        // --- 入口外观样式存储与切换支持 ---
        const STORAGE_KEY_STYLE = "persona_mask_capsule_style_v3";
        const STORAGE_KEY_BALL_POS = "persona_mask_ball_pos_v3";

        function getCapsuleStyle() {
            let style = ctx.system.storage.get(STORAGE_KEY_STYLE);
            if (!style) {
                try {
                    style = ctx.system.settings.get("capsuleDisplayMode");
                } catch (e) {}
            }
            if (style === "header_compact") return "header_compact";
            return "float_ball"; // 默认悬浮球
        }

        function setCapsuleStyle(style) {
            ctx.system.storage.set(STORAGE_KEY_STYLE, style);
            try {
                ctx.system.settings.set("capsuleDisplayMode", style);
            } catch (e) {}
            if (currentHeaderRerender) currentHeaderRerender();
        }

        function getBallPos() {
            try {
                const pos = ctx.system.storage.get(STORAGE_KEY_BALL_POS);
                if (pos && typeof pos === "object" && typeof pos.top === "number") {
                    return pos;
                }
            } catch (e) {}
            return { side: "right", top: 120 };
        }

        function saveBallPos(pos) {
            try {
                ctx.system.storage.set(STORAGE_KEY_BALL_POS, pos);
            } catch (e) {}
        }

        // --- 悬浮球专属自定义图标存储与恢复 ---
        const STORAGE_KEY_CUSTOM_BALL_ICON = "persona_mask_custom_ball_icon_v1";

        function getCustomBallIcon() {
            try {
                return ctx.system.storage.get(STORAGE_KEY_CUSTOM_BALL_ICON) || null;
            } catch (e) {
                return null;
            }
        }

        function setCustomBallIcon(iconDataUrl) {
            try {
                if (iconDataUrl) {
                    ctx.system.storage.set(STORAGE_KEY_CUSTOM_BALL_ICON, iconDataUrl);
                } else {
                    ctx.system.storage.remove(STORAGE_KEY_CUSTOM_BALL_ICON);
                }
            } catch (e) {}
            if (currentHeaderRerender) currentHeaderRerender();
        }

        // --- 通用本地图片选择与等比压缩工具函数 (用于悬浮球与马甲头像) ---
        function pickImageFile(callback, maxWidth = 256) {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.style.display = "none";
            document.body.appendChild(input);

            input.onchange = (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) {
                    input.remove();
                    return;
                }

                const reader = new FileReader();
                reader.onload = (re) => {
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const canvas = document.createElement("canvas");
                            let w = img.width;
                            let h = img.height;
                            if (w > maxWidth || h > maxWidth) {
                                if (w > h) {
                                    h = Math.round((h * maxWidth) / w);
                                    w = maxWidth;
                                } else {
                                    w = Math.round((w * maxWidth) / h);
                                    h = maxWidth;
                                }
                            }
                            canvas.width = w;
                            canvas.height = h;
                            const ctx2d = canvas.getContext("2d");
                            ctx2d.drawImage(img, 0, 0, w, h);
                            const dataUrl = canvas.toDataURL("image/webp", 0.85) || canvas.toDataURL("image/jpeg", 0.85);
                            callback(dataUrl);
                        } catch (err) {
                            callback(re.target.result);
                        }
                        input.remove();
                    };
                    img.onerror = () => {
                        input.remove();
                        ctx.ui.toast("图片读取失败，请换一张试试");
                    };
                    img.src = re.target.result;
                };
                reader.readAsDataURL(file);
            };

            input.click();
        }

        // --- 统一头像 HTML 格式化辅助函数 (彻底解决 base64 文本泄漏为 eY7c 与长串字符的 Bug) ---
        function renderAvatarHtml(avatarStr, defaultSymbol = "🎭", sizePx = 20) {
            if (!avatarStr) {
                return `<span>${defaultSymbol}</span>`;
            }
            const cleanStr = String(avatarStr).trim();
            if (cleanStr.startsWith("data:") || cleanStr.startsWith("http://") || cleanStr.startsWith("https://")) {
                return `<img src="${cleanStr}" style="width:${sizePx}px;height:${sizePx}px;border-radius:50%;object-fit:cover;vertical-align:middle;display:inline-block;" alt="" />`;
            }
            return `<span>${cleanStr}</span>`;
        }

        // --- 动态同步聊天室中用户自己消息右侧的头像 (真正身临其境切马甲) ---
        let dynamicAvatarStyleEl = null;

        function updateDynamicChatUserAvatar(sessionId) {
            if (typeof document === "undefined") return;
            if (!dynamicAvatarStyleEl) {
                dynamicAvatarStyleEl = document.createElement("style");
                dynamicAvatarStyleEl.id = "persona-mask-dynamic-user-avatar";
                document.head.appendChild(dynamicAvatarStyleEl);
            }

            const activeMask = getActiveMask(sessionId);
            if (!activeMask || !activeMask.avatar) {
                dynamicAvatarStyleEl.textContent = "";
                return;
            }

            const av = String(activeMask.avatar).trim();
            if (av.startsWith("data:") || av.startsWith("http://") || av.startsWith("https://")) {
                dynamicAvatarStyleEl.textContent = `
                    .chat-app .chat-msg-wrapper[data-role="user"] .chat-msg-avatar {
                        background-image: url("${av}") !important;
                        background-size: cover !important;
                        background-position: center !important;
                        background-repeat: no-repeat !important;
                        position: relative !important;
                    }
                    .chat-app .chat-msg-wrapper[data-role="user"] .chat-msg-avatar > * {
                        display: none !important;
                        opacity: 0 !important;
                    }
                `;
            } else {
                dynamicAvatarStyleEl.textContent = `
                    .chat-app .chat-msg-wrapper[data-role="user"] .chat-msg-avatar {
                        position: relative !important;
                        background: var(--c-surface, #f0f3f6) !important;
                    }
                    .chat-app .chat-msg-wrapper[data-role="user"] .chat-msg-avatar > * {
                        display: none !important;
                        opacity: 0 !important;
                    }
                    .chat-app .chat-msg-wrapper[data-role="user"] .chat-msg-avatar::after {
                        content: "${av}" !important;
                        font-size: 22px !important;
                        position: absolute;
                        inset: 0;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                `;
            }
        }

        // --- 全局状态更新通知 (让 slot 和 modal 同步) ---
        let currentHeaderRerender = null;

        // --- 样式注入 ---
        const disposeCSS = ctx.ui.injectCSS(`
            /* --- 全局防遮挡强化：垫高首条消息气泡，确保任何美化下文字都不被顶栏遮挡 --- */
            .chat-app .chat-room-wrapper > .page-body > :first-child {
                margin-top: 18px !important;
            }

            /* --- 模式 0：🔮 灵动可拖拽悬浮球 (彻底脱离顶栏，绝不挡美化) --- */
            .chat-app .chat-room-wrapper .chat-plugin-header:has(.mask-float-ball),
            .mask-float-ball-container {
                pointer-events: none !important;
            }
            .mask-float-ball {
                position: absolute;
                width: 44px;
                height: 44px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.88);
                border: 1.5px solid rgba(255, 255, 255, 0.85);
                box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.08);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: grab;
                pointer-events: auto !important;
                user-select: none;
                touch-action: none;
                z-index: 99;
                transition: transform 0.2s cubic-bezier(0.18, 0.89, 0.32, 1.28), box-shadow 0.2s ease;
            }
            .mask-float-ball:hover {
                transform: scale(1.08);
                box-shadow: 0 6px 22px rgba(0, 0, 0, 0.24);
            }
            .mask-float-ball:active,
            .mask-float-ball.dragging {
                cursor: grabbing;
                transform: scale(1.14);
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
                transition: none !important;
            }
            .mask-float-ball.is-mask {
                border-color: rgba(36, 107, 253, 0.6);
                background: rgba(255, 255, 255, 0.94);
                box-shadow: 0 4px 20px rgba(36, 107, 253, 0.28), 0 1px 4px rgba(0, 0, 0, 0.08);
            }
            .mask-ball-inner {
                position: relative;
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .mask-ball-avatar {
                font-size: 21px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .mask-ball-avatar img {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                object-fit: cover;
            }
            .mask-ball-dot {
                position: absolute;
                bottom: 2px;
                right: 2px;
                width: 9px;
                height: 9px;
                border-radius: 50%;
                background: #bbb;
                border: 2px solid #fff;
            }
            .mask-ball-dot.active {
                background: #246bfd;
                box-shadow: 0 0 6px #246bfd;
            }

            /* --- 模式 1：mode-compact (顶栏调高居中微缩胶囊·默认) --- */
            .mask-capsule-wrapper.mode-compact {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 12px 2px;
                margin-top: -6px; /* 向上调高，紧贴顶栏下沿 */
                background: transparent;
                user-select: none;
                z-index: 10;
            }
            .mask-capsule-wrapper.mode-compact .mask-capsule-btn {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                background: var(--c-surface, rgba(255, 255, 255, 0.85));
                border: 1px solid var(--c-border, rgba(0, 0, 0, 0.1));
                padding: 2px 10px;
                height: 22px;
                border-radius: 9999px;
                font-size: 11px;
                color: var(--c-text-sub, #555);
                cursor: pointer;
                transition: all 0.2s ease;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
                max-width: 90%;
            }
            .mask-capsule-wrapper.mode-compact .mask-capsule-btn:hover {
                background: var(--c-surface-hover, rgba(255, 255, 255, 0.98));
                border-color: var(--c-accent, #246bfd);
                color: var(--c-text, #111);
            }
            .mask-capsule-wrapper.mode-compact .mask-capsule-btn.active {
                background: rgba(36, 107, 253, 0.12);
                border-color: rgba(36, 107, 253, 0.4);
                color: #246bfd;
                font-weight: 500;
            }

            /* --- 模式 2：mode-right (嵌入右上角微标·彻底不挡聊天流任何文字) --- */
            .mask-capsule-wrapper.mode-right {
                display: flex;
                justify-content: flex-end;
                align-items: center;
                padding: 0 52px 0 12px; /* 完美避开最右侧三点菜单按钮 */
                margin-top: -38px;       /* 向上调高至原生 Header 标题行同行 */
                background: transparent;
                pointer-events: none;
                user-select: none;
                z-index: 12;
            }
            .mask-capsule-wrapper.mode-right .mask-capsule-btn {
                pointer-events: auto;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                background: var(--c-surface, rgba(255, 255, 255, 0.9));
                border: 1px solid var(--c-border, rgba(0, 0, 0, 0.14));
                padding: 2px 8px;
                height: 24px;
                border-radius: 9999px;
                font-size: 11px;
                color: var(--c-text-sub, #444);
                cursor: pointer;
                transition: all 0.2s ease;
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
            }
            .mask-capsule-wrapper.mode-right .mask-capsule-btn:hover {
                border-color: var(--c-accent, #246bfd);
                color: #246bfd;
            }
            .mask-capsule-wrapper.mode-right .mask-capsule-btn.active {
                background: rgba(36, 107, 253, 0.12);
                border-color: rgba(36, 107, 253, 0.4);
                color: #246bfd;
                font-weight: 500;
            }

            /* --- 模式 3：mode-slim (超薄极简细条) --- */
            .mask-capsule-wrapper.mode-slim {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 18px;
                margin-top: -4px;
                background: transparent;
                user-select: none;
                z-index: 10;
            }
            .mask-capsule-wrapper.mode-slim .mask-capsule-btn {
                background: transparent;
                border: none;
                font-size: 10px;
                color: var(--c-text-sub, #777);
                cursor: pointer;
                padding: 0 8px;
                opacity: 0.85;
            }
            .mask-capsule-wrapper.mode-slim .mask-capsule-btn:hover {
                color: var(--c-accent, #246bfd);
                opacity: 1;
            }

            /* 胶囊内名字防超长换行 */
            .mask-capsule-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 96px;
            }

            /* --- 弹窗内的【🎨 顶栏样式切换控制栏】 --- */
            .mask-style-switch-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                background: var(--c-surface, rgba(0, 0, 0, 0.03));
                border: 1px solid var(--c-border, rgba(0, 0, 0, 0.07));
                border-radius: 8px;
                padding: 6px 10px;
                margin-bottom: 12px;
            }
            .mask-style-options {
                display: flex;
                gap: 4px;
            }
            .mask-style-btn {
                background: transparent;
                border: 1px solid transparent;
                padding: 3px 8px;
                border-radius: 6px;
                font-size: 11px;
                color: var(--c-text-sub, #666);
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .mask-style-btn:hover {
                background: rgba(0, 0, 0, 0.05);
                color: var(--c-text, #111);
            }
            .mask-style-btn.active {
                background: #fff;
                border-color: rgba(36, 107, 253, 0.35);
                color: #246bfd;
                font-weight: 500;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
            }
            .mask-modal-root {
                display: flex;
                flex-direction: column;
                max-height: 80vh;
                width: 100%;
                box-sizing: border-box;
                font-family: inherit;
            }
            .mask-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 18px 10px;
                border-bottom: 1px solid var(--c-border, #eee);
            }
            .mask-modal-title {
                font-size: 16px;
                font-weight: 600;
                color: var(--c-text-title, #111);
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .mask-modal-body {
                padding: 14px 18px;
                overflow-y: auto;
                flex: 1;
            }
            .mask-card {
                position: relative;
                display: flex;
                align-items: flex-start;
                gap: 12px;
                padding: 10px 12px;
                border-radius: 10px;
                border: 1px solid var(--c-border, #eee);
                background: var(--c-card, #fff);
                margin-bottom: 10px;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .mask-card:hover {
                border-color: #246bfd;
                background: rgba(36, 107, 253, 0.02);
            }
            .mask-card.selected {
                border-color: #246bfd;
                background: rgba(36, 107, 253, 0.06);
            }
            .mask-avatar {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                background: #f0f3f6;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                flex-shrink: 0;
                overflow: hidden;
            }
            .mask-avatar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .mask-info {
                flex: 1;
                min-width: 0;
            }
            .mask-info-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 2px;
            }
            .mask-name {
                font-size: 14px;
                font-weight: 600;
                color: var(--c-text-title, #111);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .mask-desc {
                font-size: 12px;
                color: var(--c-text-sub, #666);
                line-height: 1.4;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .mask-actions-bar {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px dashed var(--c-border, #eee);
            }
            .mask-badge {
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 4px;
                background: #246bfd;
                color: #fff;
                font-weight: 500;
            }
            .mask-btn-track {
                display: inline-flex;
                align-items: center;
                gap: 3px;
                font-size: 11px;
                padding: 3px 8px;
                border-radius: 6px;
                background: rgba(16, 185, 129, 0.1);
                color: #059669;
                border: 1px solid rgba(16, 185, 129, 0.25);
                font-weight: 500;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .mask-btn-track:hover {
                background: #059669;
                color: #fff;
            }
            .mask-form-group {
                margin-bottom: 12px;
            }
            .mask-label {
                display: block;
                font-size: 12px;
                font-weight: 500;
                margin-bottom: 4px;
                color: var(--c-text, #333);
            }
            .mask-input, .mask-textarea {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid var(--c-border, #ddd);
                border-radius: 8px;
                padding: 8px 10px;
                font-size: 13px;
                color: var(--c-text, #111);
                background: var(--c-input-bg, #fff);
                outline: none;
                transition: border-color 0.15s;
                font-family: inherit;
            }
            .mask-input:focus, .mask-textarea:focus {
                border-color: #246bfd;
            }
            .mask-textarea {
                min-height: 60px;
                resize: vertical;
            }
            .mask-avatar-picker {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
                margin-top: 6px;
            }
            .mask-avatar-option {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                border: 1px solid var(--c-border, #ddd);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 16px;
                background: #fff;
            }
            .mask-avatar-option.selected {
                border-color: #246bfd;
                background: rgba(36, 107, 253, 0.1);
            }
            .mask-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                padding: 8px 14px;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                border: none;
                transition: all 0.15s;
            }
            .mask-btn-primary {
                background: #246bfd;
                color: #fff;
            }
            .mask-btn-primary:hover {
                background: #1e5ad4;
            }
            .mask-btn-ghost {
                background: transparent;
                color: var(--c-text, #444);
            }
            .mask-btn-ghost:hover {
                background: rgba(0, 0, 0, 0.05);
            }
            .mask-btn-danger-text {
                background: transparent;
                color: #f43f5e;
                font-size: 11px;
                padding: 4px 6px;
                border: none;
                cursor: pointer;
            }
            .mask-btn-danger-text:hover {
                text-decoration: underline;
            }
        `);

        // --- 核心浮层渲染：管理切号与开辟双轨 ---
        function openMaskManagerModal(sessionId) {
            ctx.ui.openModal((container, api) => {
                let currentMode = "list"; // "list" | "create" | "edit" | "track-confirm"
                let editingMask = null;
                let targetTrackMask = null;

                const currentSession = sessionId ? ctx.data.sessions.get(sessionId) : null;
                const isGroupChat = currentSession ? Boolean(currentSession.isGroup) : false;
                const currentChar = (currentSession && !isGroupChat)
                    ? getCharacterBySessionId(sessionId)
                    : null;

                function render() {
                    container.innerHTML = "";
                    const root = document.createElement("div");
                    root.className = "mask-modal-root";

                    if (currentMode === "list") {
                        renderListView(root);
                    } else if (currentMode === "track-confirm") {
                        renderTrackConfirmView(root);
                    } else {
                        renderFormView(root);
                    }

                    container.appendChild(root);
                }

                // 渲染马甲列表视图
                function renderListView(root) {
                    const masks = getMasks();
                    const activeMaskId = getActiveMaskId(sessionId);

                    const curStyle = getCapsuleStyle();
                    const customBallIcon = getCustomBallIcon();
                    const activeMask = getActiveMask(sessionId);

                    root.innerHTML = `
                        <div class="mask-modal-header">
                            <div class="mask-modal-title">🎭 马甲身份与双轨会话</div>
                            <button type="button" class="mask-btn mask-btn-ghost close-btn" style="padding:4px 8px;font-size:16px;">✕</button>
                        </div>
                        <div class="mask-modal-body">
                            <!-- 入口样式实时切换控制栏 (严格精简为两项) -->
                            <div class="mask-style-switch-bar">
                                <div style="font-size:11px;font-weight:600;color:var(--c-text-title,#111);display:flex;align-items:center;gap:4px;">
                                    <span>🎨 入口样式：</span>
                                </div>
                                <div class="mask-style-options">
                                    <button type="button" class="mask-style-btn ${curStyle === 'float_ball' ? 'active' : ''}" data-style="float_ball" title="自由拖拽灵动悬浮球，绝不挡美化">🔮 悬浮球 (默认)</button>
                                    <button type="button" class="mask-style-btn ${curStyle === 'header_compact' ? 'active' : ''}" data-style="header_compact" title="顶栏居中胶囊，紧贴顶栏">🔼 顶栏居中</button>
                                </div>
                            </div>

                            <!-- 悬浮球专属自定义图片选择与恢复跟随 -->
                            <div class="mask-ball-custom-bar" style="display:flex;align-items:center;justify-content:space-between;background:var(--c-surface,rgba(0,0,0,0.03));border:1px solid var(--c-border,rgba(0,0,0,0.06));border-radius:8px;padding:7px 10px;margin-bottom:12px;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <div class="ball-preview-circle" style="width:30px;height:30px;border-radius:50%;background:#fff;border:1.5px solid rgba(0,0,0,0.1);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);flex-shrink:0;">
                                        ${customBallIcon ? `<img src="${customBallIcon}" style="width:100%;height:100%;object-fit:cover;" alt="" />` : ((activeMask && activeMask.avatar && (activeMask.avatar.startsWith("data:") || activeMask.avatar.startsWith("http"))) ? `<img src="${activeMask.avatar}" style="width:100%;height:100%;object-fit:cover;" alt="" />` : `<span style="font-size:16px;">${activeMask?.avatar || "👤"}</span>`)}
                                    </div>
                                    <div style="font-size:11px;color:var(--c-text-sub,#555);">
                                        <div style="font-weight:600;color:var(--c-text-title,#111);">悬浮球专属图标</div>
                                        <div style="font-size:10px;color:var(--c-text-sub,#888);">${customBallIcon ? "已启用自定义专属图片" : "默认跟随当前马甲头像"}</div>
                                    </div>
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <button type="button" class="mask-btn-ghost pick-ball-img-btn" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid #246bfd;color:#246bfd;cursor:pointer;background:transparent;">
                                        📷 选择图片
                                    </button>
                                    ${customBallIcon ? `
                                        <button type="button" class="reset-ball-img-btn" style="font-size:11px;color:#ef4444;border:none;background:none;cursor:pointer;padding:2px 4px;">
                                            恢复跟随
                                        </button>
                                    ` : ""}
                                </div>
                            </div>

                            <div style="font-size:12px;color:var(--c-text-sub,#666);margin-bottom:12px;line-height:1.4;">
                                • <b>点击卡片</b>：在此会话中无缝切号（同一聊天记录，动态改写 AI 认知）<br>
                                • <b>开双轨新线</b>：为当前角色生成该小号的专属独立聊天（微信列表常驻）
                            </div>

                            <!-- 默认大号选项 -->
                            <div class="mask-card default-mask-card ${!activeMaskId ? 'selected' : ''}">
                                <div class="mask-avatar">👤</div>
                                <div class="mask-info">
                                    <div class="mask-info-top">
                                        <div class="mask-name">默认大号身份</div>
                                        ${!activeMaskId ? '<span class="mask-badge">使用中</span>' : ''}
                                    </div>
                                    <div class="mask-desc">使用小手机系统的默认大号资料与设定</div>
                                </div>
                            </div>

                            <div style="font-size:12px;font-weight:600;margin:14px 0 8px;color:var(--c-text-title,#111);display:flex;justify-content:space-between;align-items:center;">
                                <span>我的分身小号 (${masks.length})</span>
                                <button type="button" class="mask-btn mask-btn-primary create-btn" style="padding:4px 10px;font-size:12px;">+ 新建小号</button>
                            </div>

                            <div class="masks-container">
                                ${masks.length === 0 ? `
                                    <div style="text-align:center;padding:24px 0;font-size:12px;color:var(--c-text-sub,#888);">
                                        还没有创建过小号马甲，点击上方「+ 新建小号」立即创建一个吧！
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `;

                    // 事件监听
                    root.querySelector(".close-btn").onclick = () => api.close();

                    // 样式按钮切换事件 (加 300ms 时间锁，彻底阻断移动端打开弹窗瞬间的 Ghost Click 穿透误触！)
                    const modalMountTime = Date.now();
                    const styleButtons = root.querySelectorAll(".mask-style-btn");
                    styleButtons.forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            if (Date.now() - modalMountTime < 280) return; // 拦截 280ms 内的穿透误触！

                            const targetStyle = btn.getAttribute("data-style");
                            setCapsuleStyle(targetStyle);
                            styleButtons.forEach(b => b.classList.toggle("active", b === btn));
                            const labels = {
                                float_ball: "已切换为：🔮 灵动悬浮球 (可自由拖拽吸附·不挡美化)",
                                header_compact: "已切换为：🔼 顶栏居中胶囊"
                            };
                            ctx.ui.toast(labels[targetStyle] || "样式已切换！");
                        };
                    });

                    // 悬浮球专属图片选择与恢复事件绑定
                    const pickBallBtn = root.querySelector(".pick-ball-img-btn");
                    if (pickBallBtn) {
                        pickBallBtn.onclick = (e) => {
                            e.stopPropagation();
                            pickImageFile((dataUrl) => {
                                setCustomBallIcon(dataUrl);
                                ctx.ui.toast("悬浮球专属图片已更新！");
                                render();
                            }, 160);
                        };
                    }
                    const resetBallBtn = root.querySelector(".reset-ball-img-btn");
                    if (resetBallBtn) {
                        resetBallBtn.onclick = (e) => {
                            e.stopPropagation();
                            setCustomBallIcon(null);
                            ctx.ui.toast("悬浮球已恢复跟随当前马甲头像");
                            render();
                        };
                    }

                    root.querySelector(".default-mask-card").onclick = () => {
                        switchMask(null);
                    };

                    root.querySelector(".create-btn").onclick = () => {
                        currentMode = "create";
                        editingMask = {
                            name: "",
                            avatar: "🐱",
                            bio: "",
                            relation: "",
                            personality: ""
                        };
                        render();
                    };

                    // 渲染各个小号卡片
                    const listContainer = root.querySelector(".masks-container");
                    masks.forEach(mask => {
                        const isSelected = mask.id === activeMaskId;
                        const card = document.createElement("div");
                        card.className = `mask-card ${isSelected ? 'selected' : ''}`;

                        const avatarContent = renderAvatarHtml(mask.avatar, "🎭", 38);

                        card.innerHTML = `
                            <div class="mask-avatar">${avatarContent}</div>
                            <div class="mask-info">
                                <div class="mask-info-top">
                                    <div class="mask-name">${mask.name || "未命名马甲"}</div>
                                    <div style="display:flex;align-items:center;gap:6px;">
                                        ${isSelected ? '<span class="mask-badge">使用中</span>' : ''}
                                        <button type="button" class="mask-btn-ghost edit-btn" style="padding:2px 6px;font-size:11px;border-radius:4px;">编辑</button>
                                        <button type="button" class="mask-btn-danger-text delete-btn">删除</button>
                                    </div>
                                </div>
                                <div class="mask-desc">
                                    ${mask.bio || "暂无背景设定"}
                                    ${mask.relation ? ` · 秘密戏码: ${mask.relation}` : ""}
                                </div>
                                <div class="mask-actions-bar">
                                    <button type="button" class="mask-btn-track track-btn" title="为当前角色克隆一个独立的平行小号聊天">
                                        <span>🔀</span> 开双轨新线
                                    </button>
                                    <span style="font-size:10px;color:var(--c-text-sub,#999);margin-left:auto;">点击卡片切马甲</span>
                                </div>
                            </div>
                        `;

                        // 点击卡片直接无缝切号
                        card.onclick = (e) => {
                            if (e.target.closest(".edit-btn") || e.target.closest(".delete-btn") || e.target.closest(".track-btn")) return;
                            switchMask(mask);
                        };

                        // 编辑
                        card.querySelector(".edit-btn").onclick = (e) => {
                            e.stopPropagation();
                            currentMode = "edit";
                            editingMask = { ...mask };
                            render();
                        };

                        // 删除
                        card.querySelector(".delete-btn").onclick = (e) => {
                            e.stopPropagation();
                            if (confirm(`确定删除小号【${mask.name}】吗？`)) {
                                deleteMask(mask.id);
                            }
                        };

                        // 开启双轨独立新线
                        card.querySelector(".track-btn").onclick = (e) => {
                            e.stopPropagation();
                            if (isGroupChat) {
                                ctx.ui.toast("双轨功能仅支持与单人角色开启哦");
                                return;
                            }
                            if (!currentChar) {
                                ctx.ui.toast("未找到当前角色信息");
                                return;
                            }
                            targetTrackMask = mask;
                            currentMode = "track-confirm";
                            render();
                        };

                        listContainer.appendChild(card);
                    });
                }

                // 渲染双轨确认与自定义命名视图
                function renderTrackConfirmView(root) {
                    const charName = currentChar?.name || "该角色";
                    const maskName = targetTrackMask?.name || "小号";
                    const defaultSuffix = String(ctx.system.settings.get("defaultTrackSuffix") || `[${maskName}线]`);
                    const suggestedName = `${charName} ${defaultSuffix}`.trim();

                    root.innerHTML = `
                        <div class="mask-modal-header">
                            <div class="mask-modal-title">
                                <button type="button" class="mask-btn mask-btn-ghost back-btn" style="padding:2px 8px 2px 0;">←</button>
                                🔀 开启双轨独立会话
                            </div>
                            <button type="button" class="mask-btn mask-btn-ghost close-btn" style="padding:4px 8px;font-size:16px;">✕</button>
                        </div>
                        <div class="mask-modal-body">
                            <div style="background:rgba(36,107,253,0.06);border:1px solid rgba(36,107,253,0.2);padding:10px 12px;border-radius:8px;margin-bottom:14px;font-size:12px;color:var(--c-text,#333);line-height:1.5;">
                                将为 <b>${charName}</b> 创建一条专属的平行世界线。<br>
                                • 拥有<b>完全独立的聊天记录</b>，与大号线互不串台；<br>
                                • 在微信消息列表中常驻为独立联系人；<br>
                                • 会话马甲将自动锁定为【<b>${maskName}</b>】。
                            </div>

                            <div class="mask-form-group">
                                <label class="mask-label">新平行角色在列表中的显示名称</label>
                                <input type="text" class="mask-input track-name-input" value="${suggestedName}" />
                            </div>

                            <div style="display:flex;gap:10px;margin-top:18px;">
                                <button type="button" class="mask-btn mask-btn-ghost cancel-btn" style="flex:1;">取消</button>
                                <button type="button" class="mask-btn mask-btn-primary create-track-btn" style="flex:2;background:#059669;">立即创建并前往</button>
                            </div>
                        </div>
                    `;

                    root.querySelector(".back-btn").onclick = () => { currentMode = "list"; render(); };
                    root.querySelector(".cancel-btn").onclick = () => { currentMode = "list"; render(); };
                    root.querySelector(".close-btn").onclick = () => api.close();

                    root.querySelector(".create-track-btn").onclick = () => {
                        const newName = root.querySelector(".track-name-input").value.trim() || suggestedName;
                        createDualTrackSession(targetTrackMask, newName);
                    };
                }

                // 创建平行双轨核心逻辑（100% 纯前端自治模式，无需改动任何小手机源码）
                async function createDualTrackSession(mask, newName) {
                    if (!currentChar || !mask) return;

                    try {
                        ctx.ui.toast("正在开辟平行世界独立会话...", { durationMs: 2500 });

                        // 1. 获取现有角色并克隆新角色
                        let allChars = [];
                        const rawChars = await getKvStorageValue("ai_phone_characters_v1");
                        if (rawChars) {
                            try { allChars = JSON.parse(rawChars); } catch (e) {}
                        }
                        if (!Array.isArray(allChars) || allChars.length === 0) {
                            allChars = ctx.data.characters.list() || [];
                        }

                        const newCharId = "char_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
                        const newWechatId = "138" + Math.floor(Math.random() * 100000000).toString().padStart(8, "0");

                        // 深度复制原角色并赋予新名称与 ID
                        const clonedChar = {
                            ...currentChar,
                            id: newCharId,
                            name: newName,
                            wechatID: newWechatId,
                            createdAt: new Date().toISOString()
                        };

                        allChars.push(clonedChar);
                        await setKvStorageValue("ai_phone_characters_v1", JSON.stringify(allChars));

                        // 2. 建立新通讯录好友 (contacts)
                        const newContact = {
                            id: "contact_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
                            characterId: newCharId,
                            addedAt: new Date().toISOString()
                        };
                        await putChatDbRecord("contacts", newContact);

                        // 3. 建立新会话 (sessions)
                        const newSessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
                        const newSession = {
                            id: newSessionId,
                            contactId: newCharId,
                            unreadCount: 0,
                            updatedAt: new Date().toISOString(),
                            isPinned: false,
                            bilingualTranslationEnabled: true,
                            collapseBilingualTranslation: true
                        };
                        await putChatDbRecord("sessions", newSession);

                        // 4. 深度克隆并共享原角色的长期记忆与核心回忆
                        const copiedMemories = await cloneCharacterMemories(currentChar.id, newCharId);

                        // 5. 提取原角色当前最新的好感度/状态值快照
                        let latestStateValues = undefined;
                        try {
                            const msgs = ctx.data.messages.list(sessionId);
                            for (let i = msgs.length - 1; i >= 0; i--) {
                                if (Array.isArray(msgs[i].stateValues) && msgs[i].stateValues.length > 0) {
                                    latestStateValues = msgs[i].stateValues;
                                    break;
                                }
                            }
                        } catch (e) {}

                        // 6. 写入首条系统引导消息 (messages)，附带好感度
                        const initialNotice = {
                            id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                            sessionId: newSessionId,
                            role: "system",
                            content: `—— 已开启【${newName}】双轨平行线，当前马甲：【${mask.name}】（已共享【${currentChar.name}】的全部羁绊与回忆） ——`,
                            status: "sent",
                            ...(latestStateValues ? { stateValues: latestStateValues } : {}),
                            createdAt: new Date().toISOString()
                        };
                        await putChatDbRecord("messages", initialNotice);

                        // 7. 绑定新会话的马甲与专属双轨配对证书 (确保跨角色物理隔离)
                        setActiveMaskId(newSessionId, mask.id);
                        registerDualTrackPair({
                            id: "pair_" + Date.now(),
                            mainSessionId: sessionId,
                            mainCharId: currentChar.id,
                            mainCharName: currentChar.name || "原角色",
                            trackSessionId: newSessionId,
                            trackCharId: newCharId,
                            trackCharName: newName,
                            maskId: mask.id,
                            maskName: mask.name,
                            maskBio: mask.bio || "",
                            createdAt: Date.now()
                        });

                        // 8. 记录待自动打开的会话 ID
                        try {
                            sessionStorage.setItem("ai_phone_pending_open_session", newSessionId);
                        } catch (e) {}

                        ctx.ui.toast(`已成功开辟双轨【${newName}】！已同步记忆，正在进入...`);
                        api.close();

                        // 9. 轻量重载小手机使数据水合，自动进入全新双轨会话
                        setTimeout(() => {
                            if (typeof window !== "undefined") {
                                window.location.reload();
                            }
                        }, 500);

                    } catch (err) {
                        console.error("[MaskDualTrack] Create dual track failed:", err);
                        ctx.ui.toast("开启双轨出错: " + (err.message || String(err)));
                    }
                }

                // 切换马甲动作
                function switchMask(mask) {
                    const prevMaskId = getActiveMaskId(sessionId);
                    const newMaskId = mask ? mask.id : null;

                    if (prevMaskId === newMaskId) {
                        api.close();
                        return;
                    }

                    setActiveMaskId(sessionId, newMaskId);

                    // 插入切换系统小灰条提示
                    const shouldInsertNotice = ctx.system.settings.get("insertSystemNotice") !== false;
                    if (shouldInsertNotice && sessionId) {
                        const targetName = mask ? mask.name : "默认大号";
                        ctx.data.messages.push({
                            sessionId,
                            role: "system",
                            content: `—— 身份已切换为【${targetName}】 ——`
                        });
                    }

                    ctx.ui.toast(mask ? `已切换至马甲：${mask.name}` : "已切回默认大号身份");
                    updateDynamicChatUserAvatar(sessionId);
                    if (currentHeaderRerender) currentHeaderRerender();
                    api.close();
                }

                // 删除马甲
                function deleteMask(maskId) {
                    let masks = getMasks();
                    masks = masks.filter(m => m.id !== maskId);
                    saveMasks(masks);

                    if (getActiveMaskId(sessionId) === maskId) {
                        setActiveMaskId(sessionId, null);
                        updateDynamicChatUserAvatar(sessionId);
                        if (currentHeaderRerender) currentHeaderRerender();
                    }
                    render();
                }

                // 渲染新增/编辑表单视图
                function renderFormView(root) {
                    const isEdit = currentMode === "edit";
                    root.innerHTML = `
                        <div class="mask-modal-header">
                            <div class="mask-modal-title">
                                <button type="button" class="mask-btn mask-btn-ghost back-btn" style="padding:2px 8px 2px 0;">←</button>
                                ${isEdit ? "编辑分身小号" : "新建分身小号"}
                            </div>
                            <button type="button" class="mask-btn mask-btn-ghost close-btn" style="padding:4px 8px;font-size:16px;">✕</button>
                        </div>
                        <div class="mask-modal-body">
                            <div class="mask-form-group">
                                <label class="mask-label">小号昵称 / 称呼 *</label>
                                <input type="text" class="mask-input name-input" placeholder="例如：匿名小猫、笨蛋学妹、冷面甲方" value="${editingMask.name || ""}" />
                            </div>

                            <div class="mask-form-group">
                                <label class="mask-label">马甲头像（支持相册/本地选图、Emoji或图片URL）</label>
                                <div style="display:flex;align-items:center;gap:12px;margin:8px 0 10px;">
                                    <div class="form-avatar-preview" style="width:46px;height:46px;border-radius:50%;background:#f0f3f6;border:1.5px solid var(--c-border,#ddd);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);flex-shrink:0;">
                                        ${(editingMask.avatar && (editingMask.avatar.startsWith("data:") || editingMask.avatar.startsWith("http"))) ? `<img src="${editingMask.avatar}" style="width:100%;height:100%;object-fit:cover;" alt="" />` : `<span style="font-size:22px;">${editingMask.avatar || "🐱"}</span>`}
                                    </div>
                                    <div style="flex:1;">
                                        <button type="button" class="mask-btn mask-btn-ghost pick-avatar-file-btn" style="font-size:12px;padding:5px 12px;border:1px solid #246bfd;color:#246bfd;border-radius:8px;cursor:pointer;background:transparent;display:inline-flex;align-items:center;gap:4px;">
                                            📷 从相册/本地选择图片
                                        </button>
                                        <div style="font-size:10px;color:var(--c-text-sub,#888);margin-top:4px;">支持任意本地图片，自动裁剪适配圆形</div>
                                    </div>
                                </div>
                                <input type="text" class="mask-input avatar-input" placeholder="或输入图片 URL / Emoji" value="${editingMask.avatar || "🐱"}" />
                                <div class="mask-avatar-picker" style="margin-top:8px;">
                                    ${PRESET_AVATARS.map(emoji => `
                                        <div class="mask-avatar-option ${editingMask.avatar === emoji ? 'selected' : ''}" data-emoji="${emoji}">
                                            ${emoji}
                                        </div>
                                    `).join("")}
                                </div>
                            </div>

                            <div class="mask-form-group">
                                <label class="mask-label">身份背景 / 人设简介</label>
                                <textarea class="mask-textarea bio-input" placeholder="例如：其实是隔壁班的转学生，性格有点内向，喜欢戴着鸭舌帽...">${editingMask.bio || ""}</textarea>
                            </div>

                            <div class="mask-form-group">
                                <label class="mask-label">与当前角色的秘密戏码 / 关系（可选）</label>
                                <textarea class="mask-textarea relation-input" placeholder="例如：假装是不小心输错号码加上的陌生网友；或者是偷偷暗恋他的学妹">${editingMask.relation || ""}</textarea>
                            </div>

                            <div class="mask-form-group">
                                <label class="mask-label">说话口吻 / 性格特质（可选）</label>
                                <input type="text" class="mask-input personality-input" placeholder="例如：说话轻快软萌，喜欢发可爱颜文字" value="${editingMask.personality || ""}" />
                            </div>

                            <div style="display:flex;gap:10px;margin-top:16px;">
                                <button type="button" class="mask-btn mask-btn-ghost cancel-btn" style="flex:1;">取消</button>
                                <button type="button" class="mask-btn mask-btn-primary save-btn" style="flex:2;">保存马甲</button>
                            </div>
                        </div>
                    `;

                    // 事件绑定
                    root.querySelector(".back-btn").onclick = () => { currentMode = "list"; render(); };
                    root.querySelector(".cancel-btn").onclick = () => { currentMode = "list"; render(); };
                    root.querySelector(".close-btn").onclick = () => api.close();

                    const avatarInput = root.querySelector(".avatar-input");
                    const previewBox = root.querySelector(".form-avatar-preview");

                    function updateAvatarPreview(val) {
                        if (val && (val.startsWith("data:") || val.startsWith("http"))) {
                            previewBox.innerHTML = `<img src="${val}" style="width:100%;height:100%;object-fit:cover;" alt="" />`;
                        } else {
                            previewBox.innerHTML = `<span style="font-size:22px;">${val || "🎭"}</span>`;
                        }
                    }

                    const pickAvatarFileBtn = root.querySelector(".pick-avatar-file-btn");
                    if (pickAvatarFileBtn) {
                        pickAvatarFileBtn.onclick = () => {
                            pickImageFile((dataUrl) => {
                                avatarInput.value = dataUrl;
                                updateAvatarPreview(dataUrl);
                                root.querySelectorAll(".mask-avatar-option").forEach(o => o.classList.remove("selected"));
                                ctx.ui.toast("本地头像选择成功！");
                            }, 256);
                        };
                    }

                    avatarInput.oninput = () => {
                        updateAvatarPreview(avatarInput.value.trim());
                    };

                    root.querySelectorAll(".mask-avatar-option").forEach(opt => {
                        opt.onclick = () => {
                            const emoji = opt.getAttribute("data-emoji");
                            avatarInput.value = emoji;
                            updateAvatarPreview(emoji);
                            root.querySelectorAll(".mask-avatar-option").forEach(o => o.classList.remove("selected"));
                            opt.classList.add("selected");
                        };
                    });

                    root.querySelector(".save-btn").onclick = () => {
                        const name = root.querySelector(".name-input").value.trim();
                        if (!name) {
                            ctx.ui.toast("请输入小号昵称");
                            return;
                        }

                        const avatar = avatarInput.value.trim() || "🎭";
                        const bio = root.querySelector(".bio-input").value.trim();
                        const relation = root.querySelector(".relation-input").value.trim();
                        const personality = root.querySelector(".personality-input").value.trim();

                        const masks = getMasks();
                        if (isEdit && editingMask.id) {
                            const idx = masks.findIndex(m => m.id === editingMask.id);
                            if (idx >= 0) {
                                masks[idx] = {
                                    ...masks[idx],
                                    name,
                                    avatar,
                                    bio,
                                    relation,
                                    personality,
                                    updatedAt: Date.now()
                                };
                            }
                        } else {
                            const newMask = {
                                id: `mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                name,
                                avatar,
                                bio,
                                relation,
                                personality,
                                createdAt: Date.now()
                            };
                            masks.unshift(newMask);
                            // 如果当前会话处于默认状态，直接切上新马甲
                            if (!getActiveMaskId(sessionId)) {
                                setActiveMaskId(sessionId, newMask.id);
                            }
                        }

                        saveMasks(masks);
                        ctx.ui.toast(isEdit ? "马甲已更新" : "新小号马甲创建成功！");
                        if (currentHeaderRerender) currentHeaderRerender();
                        currentMode = "list";
                        render();
                    };
                }

                render();
            });
        }

        // --- UI 坑位：chat.header (聊天顶栏挂载马甲胶囊) ---
        const disposeHeaderSlot = ctx.ui.slot("chat.header", (el, props) => {
            const { sessionId } = props;
            if (!sessionId) return;

            function mountFloatBall(parentEl, sessionId) {
                const activeMask = getActiveMask(sessionId);
                const pos = getBallPos();

                const ball = document.createElement("div");
                ball.className = `mask-float-ball ${activeMask ? 'is-mask' : ''}`;
                
                const customBallIcon = getCustomBallIcon();
                let iconContent = "";
                if (customBallIcon) {
                    iconContent = `<img src="${customBallIcon}" alt="" />`;
                } else if (activeMask && activeMask.avatar && (activeMask.avatar.startsWith("data:") || activeMask.avatar.startsWith("http"))) {
                    iconContent = `<img src="${activeMask.avatar}" alt="" />`;
                } else {
                    const symbol = (activeMask && activeMask.avatar) ? activeMask.avatar : (activeMask ? "🎭" : "👤");
                    iconContent = `<span>${symbol}</span>`;
                }
                const label = activeMask ? activeMask.name : "默认身份";

                ball.title = `分身马甲: ${label} (可拖动，点击管理)`;
                ball.innerHTML = `
                    <div class="mask-ball-inner">
                        <span class="mask-ball-avatar">${iconContent}</span>
                        <span class="mask-ball-dot ${activeMask ? 'active' : ''}"></span>
                    </div>
                `;

                // 初始位置设定
                ball.style.top = `${pos.top}px`;
                if (pos.side === "left") {
                    ball.style.left = "10px";
                    ball.style.right = "auto";
                } else {
                    ball.style.right = "10px";
                    ball.style.left = "auto";
                }

                // 阻止原生点击穿透
                ball.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                };

                // 拖拽与点击处理（精细防误触与防穿透算法）
                let isDragging = false;
                let hasMoved = false;
                let startClientX = 0;
                let startClientY = 0;
                let startTop = 0;
                let startLeft = 0;

                ball.onpointerdown = (e) => {
                    if (e.button && e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();

                    try {
                        ball.setPointerCapture(e.pointerId);
                    } catch (err) {}

                    isDragging = true;
                    hasMoved = false;
                    startClientX = e.clientX;
                    startClientY = e.clientY;
                    startTop = parseFloat(ball.style.top) || 120;
                    startLeft = ball.offsetLeft;
                    ball.classList.add("dragging");
                };

                ball.onpointermove = (e) => {
                    if (!isDragging) return;
                    const dx = e.clientX - startClientX;
                    const dy = e.clientY - startClientY;

                    if (!hasMoved && Math.hypot(dx, dy) > 5) {
                        hasMoved = true;
                    }

                    if (hasMoved) {
                        let nextTop = startTop + dy;
                        let nextLeft = startLeft + dx;

                        // 纵向边界限制：不能拖出手机上边界或盖到底部输入栏
                        const maxTop = (window.innerHeight || 800) - 200;
                        nextTop = Math.max(10, Math.min(maxTop, nextTop));

                        ball.style.top = `${nextTop}px`;
                        ball.style.left = `${nextLeft}px`;
                        ball.style.right = "auto";
                    }
                };

                const handlePointerEnd = (e) => {
                    if (!isDragging) return;
                    isDragging = false;
                    ball.classList.remove("dragging");

                    try {
                        ball.releasePointerCapture(e.pointerId);
                    } catch (err) {}

                    if (!hasMoved) {
                        // 彻底解决 Ghost Click：延迟 60ms 打开弹窗，避开浏览器在同一物理坐标合成的 click 穿透到弹窗按钮！
                        setTimeout(() => {
                            openMaskManagerModal(sessionId);
                        }, 60);
                    } else {
                        // 拖动结束：平滑吸附到最近边缘 (左侧或右侧)
                        const currentLeft = parseFloat(ball.style.left) || ball.offsetLeft || 0;
                        const currentTop = parseFloat(ball.style.top) || 120;

                        const parentWidth = parentEl.clientWidth || (ball.parentElement ? ball.parentElement.clientWidth : 360);
                        const isLeftSide = (currentLeft + 22) < (parentWidth / 2);
                        const side = isLeftSide ? "left" : "right";

                        ball.style.transition = "all 0.28s cubic-bezier(0.18, 0.89, 0.32, 1.28)";
                        if (isLeftSide) {
                            ball.style.left = "10px";
                            ball.style.right = "auto";
                        } else {
                            ball.style.right = "10px";
                            ball.style.left = "auto";
                        }

                        saveBallPos({ side, top: currentTop });

                        setTimeout(() => {
                            ball.style.transition = "";
                        }, 300);
                    }
                };

                ball.onpointerup = handlePointerEnd;
                ball.onpointercancel = handlePointerEnd;

                parentEl.appendChild(ball);
            }

            function renderCapsule() {
                el.innerHTML = "";

                // 动态更新聊天室中用户自己发出的消息头像 (真正马甲代入感)
                updateDynamicChatUserAvatar(sessionId);

                const curStyle = getCapsuleStyle();

                // 核心首推模式：🔮 灵动可拖拽悬浮球 (默认)
                if (curStyle !== "header_compact") {
                    mountFloatBall(el, sessionId);
                    return;
                }

                // 模式 2：🔼 顶栏居中胶囊 (解决 base64 文本溢出 Bug)
                const activeMask = getActiveMask(sessionId);

                const wrapper = document.createElement("div");
                wrapper.className = "mask-capsule-wrapper mode-compact";

                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = `mask-capsule-btn ${activeMask ? 'active' : ''}`;
                btn.title = "点击管理分身马甲、切换样式或为该角色开辟独立双轨新会话";

                const avatarHtml = activeMask ? renderAvatarHtml(activeMask.avatar, "🎭", 16) : `<span>👤</span>`;
                const label = activeMask ? activeMask.name : "默认身份";

                btn.innerHTML = `
                    ${avatarHtml}
                    <span class="mask-capsule-name">${label}</span>
                    <span style="font-size:9px;opacity:0.7;">▾</span>
                `;

                btn.onclick = () => {
                    openMaskManagerModal(sessionId);
                };

                wrapper.appendChild(btn);
                el.appendChild(wrapper);
            }

            currentHeaderRerender = renderCapsule;
            renderCapsule();

            return () => {
                if (currentHeaderRerender === renderCapsule) {
                    currentHeaderRerender = null;
                }
            };
        });

        // --- UI 坑位：chat.inputToolbar (输入栏“+”面板内快捷按钮) ---
        const disposeToolbarSlot = ctx.ui.slot("chat.inputToolbar", (el, props) => {
            const { sessionId } = props;
            if (!sessionId) return;

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "chat-plus-item";
            btn.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;background:none;border:none;";
            btn.innerHTML = `
                <div style="width:48px;height:48px;border-radius:12px;background:rgba(36,107,253,0.1);color:#246bfd;display:flex;align-items:center;justify-content:center;font-size:22px;">
                    🎭
                </div>
                <span style="font-size:11px;color:var(--c-text-sub,#666);">马甲双轨</span>
            `;

            btn.onclick = () => {
                openMaskManagerModal(sessionId);
            };

            el.appendChild(btn);
        });

        // --- 核心 Transform 钩子：prompt.system 接管 AI 认知 (严格成对隔离与真实台本互通) ---
        const disposePromptTransform = ctx.hooks.transform("prompt.system", async (payload) => {
            const { sessionId, characterId } = payload;
            if (!sessionId) return payload;

            const activeMask = getActiveMask(sessionId);

            // 解析当前会话的双轨关系上下文
            const trackCtx = resolveTrackContext(sessionId, characterId);

            if (trackCtx) {
                if (trackCtx.type === "track") {
                    // ==========================================
                    // 【情况 1：用户在小号副线聊天室】（如：凤晏璃 [小号线]）
                    // ==========================================
                    const pair = trackCtx.pair;
                    const mask = activeMask || {
                        name: pair.maskName || "小号",
                        bio: pair.maskBio || "",
                        personality: pair.maskPersonality || "",
                        relation: pair.maskRelation || ""
                    };

                    // 1. 读取母本角色在数据库中的长期核心记忆
                    const mainMemories = await loadCharacterMemoriesRaw(pair.mainCharId);
                    const memorySnippets = (mainMemories && mainMemories.length > 0)
                        ? mainMemories.slice(-8).map(m => `- ${m.content}`).join("\n")
                        : "- 记得日常生活中与大号主子经历的诸多点滴与羁绊回忆。";

                    // 2. 提取母本大号线中最近的真实对话台本（凤晏璃与大号主子的真实交流）
                    const mainDialogues = getRecentDialogues(pair.mainSessionId, pair.mainCharId, 10, "大号主子(现实)");

                    const trackPrompt = [
                        `\n[🎭 微信私聊情境设定]`,
                        `你现在正在微信上与通讯录联系人【${mask.name}】进行一对一私聊。`,
                        mask.bio ? `- 【${mask.name}】的身份与人设背景：${mask.bio}` : `- 【${mask.name}】是你的贴身丫鬟/心腹/私密联系人。`,
                        mask.personality ? `- 【${mask.name}】的言行风格：${mask.personality}` : null,
                        mask.relation ? `- 你们之间的特殊关系/戏码设定：${mask.relation}` : null,
                        `\n[🧠 你的现实生活轨迹与核心回忆（母本记忆）]`,
                        `在你的现实生活和朋友圈中，你与大号主子（用户）有着极其深厚的情感羁绊与现实交集。你完整记得生活中的核心记忆：`,
                        memorySnippets,
                        mainDialogues ? `\n【你最近在现实生活中与大号主子刚刚发生过的真实对话】：\n${mainDialogues}` : null,
                        `\n[⚠️ 绝对核心心智与戏剧原则（不拆穿绝不掉马）]`,
                        `1. 【认知边界】：在你的内心认知中，眼前的【${mask.name}】是完全独立的真实人物。你【绝对不知道】眼前这个【${mask.name}】其实就是那个与你有深厚过往的【大号主子】！`,
                        `2. 【坚决不主动识破】：除非对方在对话中极度明确地向你坦白摊牌（例如明确说：“其实我就是你的主子/xxx，绿筠是我开的小号”），否则你【绝对不要】主动猜穿或怀疑对方是大号！必须完全把对方当做【${mask.name}】本人来对待。`,
                        `3. 【自然吩咐与倾诉】：你可以像对待贴身心腹或丫鬟一样，自然向【${mask.name}】吩咐差事、倾诉你在现实生活中与大号主子发生的心事、私密烦恼或密谋，保持角色的性格本色。`,
                        `4. 【掉马反应】：如果对方主动明确向你坦白拆穿（掉马），请根据你的性格展现出真实而戏剧化的反应（如震惊、恍然大悟、又羞又气、假装嗔怪或暗自窃喜），享受这份马甲拆穿的情感张力！`
                    ].filter(Boolean).join("\n");

                    payload.hint = (payload.hint ? payload.hint + "\n" : "") + trackPrompt;
                    return payload;

                } else if (trackCtx.type === "main") {
                    // ==========================================
                    // 【情况 2：用户在大号主线聊天室】（如：凤晏璃）
                    // ==========================================
                    const relatedPairs = trackCtx.pairs || [];
                    const trackIntelList = [];

                    for (const pair of relatedPairs) {
                        const maskName = pair.maskName || "小号";
                        // 提取副线中最近的真实对话台本（凤晏璃与绿筠的真实交流）
                        const subDialogues = getRecentDialogues(pair.trackSessionId, pair.trackCharId, 12, maskName);

                        let intelText = `• 通讯录联系人【${maskName}】（人设: ${pair.maskBio || "你的贴身侍女/私密倾诉对象"}）`;
                        if (subDialogues) {
                            intelText += `\n  你刚才与【${maskName}】私下发生的真实微信对话记录如下：\n` +
                                subDialogues.split("\n").map(l => "    " + l).join("\n");
                        } else {
                            intelText += `（你最近与她偶尔有微信私聊往来）`;
                        }
                        trackIntelList.push(intelText);
                    }

                    const mainPrompt = [
                        `\n[🧠 你的其他社交生活与真实私下交代（绝对已知记忆）]`,
                        `在你的社交圈中，除了眼前的大号主子（用户）之外，你最近在微信上私下吩咐/联络过以下联系人：`,
                        trackIntelList.join("\n\n"),
                        `\n[⚠️ 绝对核心心智与互动原则（至关重要）]`,
                        `1. 【记忆已知】：你心里完全、百分之百清楚记得你刚才在微信上跟上述联系人（如【${relatedPairs[0]?.maskName || "小号"}】）聊过的所有内容与交代细节（包括你吩咐她盯紧谁、请太医、或者倾诉过什么）。`,
                        `2. 【身份防线（不拆穿绝不掉马）】：在你的认知中，这些联系人是完全独立的真实人物。眼前的【用户】是你生活中的主子/伴侣。你【绝对不知道】眼前的【用户】其实就是披着马甲开小号扮演她们的那个人！`,
                        `3. 【应对方式】：如果眼前的【用户】向你打听或提起她们（例如问：“绿筠可有和您说什么？”），你心里清清楚楚知道自己私下吩咐过什么！请根据你的性格（傲娇、护短、掩饰、调侃或如实告知），自然地提及你对她们的真实吩咐或交代，绝不要凭空编造谎话违背你的真实对话事实，但言语间保持主子与角色之间的性格张力，且绝对不要主动识破眼前的用户是开小号扮演绿筠；除非对方极其明确地向你坦白摊牌，你才能触发震惊掉马反应！`
                    ].filter(Boolean).join("\n");

                    payload.hint = (payload.hint ? payload.hint + "\n" : "") + mainPrompt;
                    return payload;
                }
            }

            // ==========================================
            // 【情况 3：普通未开双轨的角色卡，或者常规单会话切马甲】
            // ==========================================
            // 此时其他完全无关的角色卡绝对不包含任何双轨提示词，100% 保持小手机底层原生状态！
            if (activeMask) {
                const regularMaskPrompt = [
                    `\n[🎭 当前对话已启用分身马甲模式]`,
                    `当前正在与你交流的对方用户使用了以下独立身份，请以此身份为准：`,
                    `- 对方称呼/昵称: ${activeMask.name}`,
                    activeMask.bio ? `- 对方身份设定与背景: ${activeMask.bio}` : null,
                    activeMask.personality ? `- 对方性格与言行风格: ${activeMask.personality}` : null,
                    activeMask.relation ? `- 对方与你的特殊关系/秘密戏码: ${activeMask.relation}` : null,
                    `【核心互动原则】:`,
                    `1. 严格在心里与口头上认定对方为【${activeMask.name}】；`,
                    `2. 除非对方主动在对话中明示或掉马，否则你绝对不知道对方有其他身份。`
                ].filter(Boolean).join("\n");
                payload.hint = (payload.hint ? payload.hint + "\n" : "") + regularMaskPrompt;
            }

            return payload;
        }, { priority: 20 });

        // --- 清理函数 (反注册) ---
        return () => {
            if (dynamicAvatarStyleEl) {
                try { dynamicAvatarStyleEl.remove(); } catch (e) {}
                dynamicAvatarStyleEl = null;
            }
            disposeCSS();
            disposeHeaderSlot();
            disposeToolbarSlot();
            disposePromptTransform();
        };
    }
};
