// =========================================================================
// 画中画·全局原生聊天小窗 · 小手机扩展插件
// 版本: 2.1.0
// 契约版本: apiVersion 1 (lib/chat-plugin-types.ts)
//
// 核心特色：
// 1. 【原汁原味官方聊天App端入小窗】：直接调出小手机官方全功能 PhoneChatApp，
//    会话列表、联系人、角色切换、搜索、富文本、表情包、语音等与主App 100% 毫无二致；
// 2. 【灵动贴边悬浮球】：在桌面、剧情App等全页面悬浮，支持手指/鼠标自由拖拽、自动贴边、双击复位；
// 3. 【解决手机端拉伸难痛点】：
//    - 触控热区扩大：右下角拉伸手柄由 16px 扩大至 44px，手机手指轻松按准；
//    - 手机一键调大：小窗顶栏专属增加「📐 切换大小」按钮，点一下直接在紧凑/舒适大窗间秒切！
// 4. 【自带全屏与关闭】：小窗右上角支持一键展开全屏或关闭，右下角可手动随意微调；
// 5. 【零侵入不改源码】：纯标准插件规范，管理页导入即生效，停用无任何残留。
// =========================================================================

export default {
    manifest: {
        id: "pip-mini-chat-plugin",
        name: "画中画·全局原生聊天小窗",
        apiVersion: 1,
        version: "2.1.0",
        author: "Antigravity",
        description: "直接把完整聊天App端入可拖拽悬浮小窗！支持手机一键缩放、44px大触控手柄，在桌面/剧情中随心私聊。",
        permissions: ["chat.read", "chat.write", "ui", "storage"],
        settings: [
            {
                key: "autoSnapEdge",
                label: "拖拽松手自动贴边吸附",
                type: "boolean",
                default: true,
                description: "悬浮球拖拽松手后，自动平滑靠拢至距离最近的左侧或右侧屏幕边缘"
            },
            {
                key: "idleFadeOpacity",
                label: "静止空闲时半透明淡化",
                type: "boolean",
                default: true,
                description: "悬浮球在无操作 3 秒后自动半透明，减少对背景内容（如读剧情、看桌面）的遮挡"
            }
        ]
    },

    setup(ctx) {
        const STORAGE_KEY_BALL_POS = "pip_chat_ball_pos_v3";

        let isDraggingBall = false;
        let idleTimer = null;

        // --- 获取小手机内部屏幕容器 ---
        function getPhoneScreen() {
            return document.querySelector("[data-ui='phone-screen']") ||
                document.querySelector(".phone-shell") ||
                document.body;
        }

        // --- 注入悬浮球与官方小窗优化 CSS ---
        const disposeCSS = ctx.ui.injectCSS(`
            /* 悬浮球容器：绝对定位于小手机屏幕内 */
            #pip-native-trigger-root {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                z-index: 99999;
                pointer-events: none;
                overflow: hidden;
            }

            /* 灵动贴边悬浮球 */
            .pip-native-ball {
                position: absolute;
                width: 46px;
                height: 46px;
                border-radius: 23px;
                background: linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(240, 245, 250, 0.92));
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.1), inset 0 1px 1px rgba(255, 255, 255, 0.95);
                border: 2px solid rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: grab;
                pointer-events: auto;
                touch-action: none;
                transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.3s ease, box-shadow 0.2s ease;
                z-index: 100000;
            }

            .pip-native-ball:active {
                cursor: grabbing;
                transform: scale(0.92);
            }

            .pip-native-ball.pip-ball-faded {
                opacity: 0.42;
            }

            .pip-native-ball.pip-ball-faded:hover {
                opacity: 1;
            }

            .pip-native-ball-icon {
                font-size: 22px;
                line-height: 1;
                filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
                pointer-events: none;
                user-select: none;
            }

            .pip-native-ball-badge {
                position: absolute;
                top: 0px;
                right: 0px;
                width: 11px;
                height: 11px;
                border-radius: 6px;
                background: #ef4444;
                border: 2px solid #ffffff;
                box-shadow: 0 1px 4px rgba(239, 68, 68, 0.5);
                display: none;
                animation: pipNativePulse 1.8s infinite;
            }

            @keyframes pipNativePulse {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
                70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
            }

            /* 官方 MiniAppWindow 像素级贴合调优：消除四角露白、缝隙与双重刘海 */
            .mini-app-window {
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28), 0 4px 12px rgba(0, 0, 0, 0.12) !important;
                border: 1px solid rgba(255, 255, 255, 0.85) !important;
                border-radius: 18px !important;
                background: var(--c-page-body-bg, #ffffff) !important;
                /* 核心关键：将小窗内部全链路安全区变量彻底清零，绝不留出多余刘海 */
                --page-header-safe-top: 0px !important;
                --safe-area-top: 0px !important;
                --status-bar-height: 0px !important;
            }

            .mini-app-titlebar {
                user-select: none;
                font-weight: 600;
                background: var(--c-header-bg, rgba(255, 255, 255, 0.96)) !important;
                border-bottom: 1px solid rgba(0, 0, 0, 0.06) !important;
                height: 26px !important;
                min-height: 26px !important;
            }

            /* 彻底消除小窗内部多余的 48px 手机物理刘海/灵动岛空白条（解决顶部隔太多的问题） */
            .mini-app-window .page-header-safe-area {
                display: none !important;
                height: 0px !important;
                min-height: 0px !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            .mini-app-window .page-header {
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                background: color-mix(in srgb, var(--c-header-bg, var(--c-page-body-bg, #ffffff)) 85%, transparent) !important;
            }

            .mini-app-window .page-header-content {
                min-height: 38px !important;
                height: 38px !important;
                padding: 0 8px !important;
            }

            .mini-app-window .page-shell > .page-body {
                padding-top: 38px !important;
            }

            /* 消除小窗底部输入栏与边框之间的灰白缝隙，实现 100% 严密贴底 */
            .mini-app-window .mini-app-content {
                background: transparent !important;
            }

            .mini-app-window .chat-app,
            .mini-app-window .chat-room-wrapper {
                background: transparent !important;
            }

            /* 核心修复：提升底部输入栏与发送按钮的层级（z-index: 1002），绝不被右下角手柄拦截！ */
            .mini-app-window .chat-input-bar {
                bottom: 0 !important;
                padding-bottom: 8px !important;
                background: color-mix(in srgb, var(--c-input, var(--c-page-body-bg, #ffffff)) 85%, transparent) !important;
                z-index: 1001 !important;
                pointer-events: auto !important;
            }

            .mini-app-window .chat-input-bar * {
                pointer-events: auto !important;
            }

            .mini-app-window .chat-input-actions button {
                position: relative !important;
                z-index: 1002 !important;
                pointer-events: auto !important;
            }

            /* 右下角拉伸手柄收敛至角落边沿（z-index: 999），避免覆盖发送与魔法棒按钮 */
            .mini-app-resize {
                width: 20px !important;
                height: 20px !important;
                touch-action: none !important;
                z-index: 999 !important;
                cursor: nwse-resize !important;
                background: transparent !important;
            }

            .mini-app-resize::after {
                right: 3px !important;
                bottom: 3px !important;
                width: 9px !important;
                height: 9px !important;
                border-right: 2px solid rgba(0, 122, 255, 0.5) !important;
                border-bottom: 2px solid rgba(0, 122, 255, 0.5) !important;
                border-radius: 1px !important;
            }

            .mini-app-resize:hover::after,
            .mini-app-resize:active::after {
                border-color: #007aff !important;
                opacity: 1 !important;
            }

            /* 顶栏手机一键缩放按钮 */
            .pip-quick-size-btn {
                background: transparent;
                border: none;
                padding: 2px 6px;
                margin-right: 4px;
                border-radius: 6px;
                font-size: 13px;
                color: #4b5563;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 2px;
                transition: background 0.15s;
            }
            .pip-quick-size-btn:hover {
                background: rgba(0, 0, 0, 0.08);
                color: #111827;
            }
        `);

        // --- 创建挂载根节点 ---
        let root = document.getElementById("pip-native-trigger-root");
        if (!root) {
            root = document.createElement("div");
            root.id = "pip-native-trigger-root";
        }

        function mountToPhoneScreen() {
            const container = getPhoneScreen();
            if (root.parentElement !== container) {
                container.appendChild(root);
            }
        }
        mountToPhoneScreen();

        // --- 创建悬浮球 DOM ---
        const ball = document.createElement("div");
        ball.className = "pip-native-ball";
        ball.title = "点击打开/收起官方聊天小窗（可拖拽贴边）";
        ball.innerHTML = `
            <span class="pip-native-ball-icon">💬</span>
            <div class="pip-native-ball-badge"></div>
        `;
        root.appendChild(ball);

        const badgeEl = ball.querySelector(".pip-native-ball-badge");

        // --- 坐标计算与边界自适应 ---
        function initBallPosition() {
            mountToPhoneScreen();
            const container = getPhoneScreen();
            const pw = container.clientWidth || 390;
            const ph = container.clientHeight || 844;

            const savedBall = ctx.system.storage.get(STORAGE_KEY_BALL_POS);
            if (savedBall && typeof savedBall.x === "number" && typeof savedBall.y === "number") {
                const clampedX = Math.max(6, Math.min(pw - 52, savedBall.x));
                const clampedY = Math.max(10, Math.min(ph - 58, savedBall.y));
                ball.style.left = `${clampedX}px`;
                ball.style.top = `${clampedY}px`;
            } else {
                ball.style.left = `${Math.max(10, pw - 56)}px`;
                ball.style.top = `${Math.max(50, ph - 210)}px`;
            }
        }

        initBallPosition();

        const onResize = () => {
            initBallPosition();
        };
        window.addEventListener("resize", onResize);

        // 双击一键归位
        ball.addEventListener("dblclick", () => {
            ctx.system.storage.remove(STORAGE_KEY_BALL_POS);
            initBallPosition();
            ctx.ui.toast("悬浮球已归位至小手机右侧");
        });

        // 周期性探测确保常驻手机内 & 注入手机顶栏一键切换大小按钮
        const pollTimer = setInterval(() => {
            mountToPhoneScreen();
            enhanceMiniWindowControls();
        }, 1000);

        // --- 悬浮球空闲淡化 ---
        function resetIdleTimer() {
            ball.classList.remove("pip-ball-faded");
            if (idleTimer) clearTimeout(idleTimer);
            const shouldFade = ctx.system.settings.get("idleFadeOpacity") !== false;
            if (shouldFade) {
                idleTimer = setTimeout(() => {
                    if (!isDraggingBall) {
                        ball.classList.add("pip-ball-faded");
                    }
                }, 3000);
            }
        }
        resetIdleTimer();

        // --- 检查官方小窗是否处于打开状态 ---
        function isNativeMiniChatOpen() {
            const miniWin = document.querySelector(".mini-app-window");
            if (!miniWin) return false;
            return miniWin.style.display !== "none" && !miniWin.hidden;
        }

        // --- 手机专属：模拟拖拽手势触发 React 内部 setSize 缩放 ---
        function triggerReactResize(targetWidth) {
            const resizeHandle = document.querySelector(".mini-app-resize");
            const win = document.querySelector(".mini-app-window");
            if (!resizeHandle || !win) return;

            const curW = parseInt(win.style.width, 10) || 200;
            const dx = targetWidth - curW;
            const dy = Math.round(dx * (844 / 390));

            const rect = resizeHandle.getBoundingClientRect();
            const startX = rect.left + rect.width / 2;
            const startY = rect.top + rect.height / 2;

            try {
                resizeHandle.dispatchEvent(new PointerEvent("pointerdown", {
                    clientX: startX, clientY: startY, pointerId: 1, bubbles: true
                }));
                window.dispatchEvent(new PointerEvent("pointermove", {
                    clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true
                }));
                window.dispatchEvent(new PointerEvent("pointerup", {
                    clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true
                }));
            } catch (err) {
                console.warn("[画中画插件] 模拟缩放手势失败:", err);
            }
        }

        // --- 顶栏植入「一键切换大小」按钮 ---
        function enhanceMiniWindowControls() {
            const btnsWrap = document.querySelector(".mini-app-titlebar-btns");
            if (!btnsWrap || btnsWrap.querySelector(".pip-quick-size-btn")) return;

            const btn = document.createElement("button");
            btn.className = "pip-quick-size-btn";
            btn.title = "手机一键切换大/小窗 (避免手指拉伸困难)";
            btn.innerHTML = `<span>📐</span>`;
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const win = document.querySelector(".mini-app-window");
                const curW = parseInt(win?.style.width || "0", 10) || 200;
                // 如果当前较小（<= 250px），直接秒切为 315px 舒适大窗；否则切回 200px 紧凑窗
                const targetW = curW <= 250 ? 315 : 200;
                triggerReactResize(targetW);
            });

            btnsWrap.insertBefore(btn, btnsWrap.firstChild);
        }

        // --- 优雅切换官方聊天小窗 ---
        function toggleNativeMiniChat() {
            const miniWin = document.querySelector(".mini-app-window");
            const isOpen = isNativeMiniChatOpen();

            if (isOpen) {
                const closeBtn = miniWin?.querySelector(".mini-app-btn[title='关闭']") ||
                    miniWin?.querySelector(".mini-app-titlebar-btns button:last-child");
                if (closeBtn) {
                    closeBtn.click();
                } else {
                    miniWin.style.display = "none";
                }
            } else {
                badgeEl.style.display = "none";
                window.dispatchEvent(new CustomEvent("open-mini-chat"));
                setTimeout(() => enhanceMiniWindowControls(), 80);
            }
        }

        // --- 悬浮球拖拽交互（防误触 + 智能磁吸） ---
        let ballStartX = 0, ballStartY = 0;
        let ballInitLeft = 0, ballInitTop = 0;
        let ballTotalDist = 0;

        function onBallPointerDown(e) {
            if (e.button && e.button !== 0) return;
            mountToPhoneScreen();
            isDraggingBall = true;
            ballStartX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            ballStartY = e.clientY || (e.touches && e.touches[0].clientY) || 0;

            ballInitLeft = ball.offsetLeft;
            ballInitTop = ball.offsetTop;
            ballTotalDist = 0;

            ball.classList.remove("pip-ball-faded");
            ball.style.transition = "none";

            window.addEventListener("pointermove", onBallPointerMove);
            window.addEventListener("pointerup", onBallPointerUp);
            window.addEventListener("pointercancel", onBallPointerUp);
        }

        function onBallPointerMove(e) {
            if (!isDraggingBall) return;
            const cx = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const cy = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            const dx = cx - ballStartX;
            const dy = cy - ballStartY;
            ballTotalDist = Math.hypot(dx, dy);

            let newLeft = ballInitLeft + dx;
            let newTop = ballInitTop + dy;

            const container = getPhoneScreen();
            const pw = container.clientWidth || 390;
            const ph = container.clientHeight || 844;

            newLeft = Math.max(4, Math.min(pw - 50, newLeft));
            newTop = Math.max(10, Math.min(ph - 56, newTop));

            ball.style.left = `${newLeft}px`;
            ball.style.top = `${newTop}px`;
        }

        function onBallPointerUp() {
            if (!isDraggingBall) return;
            isDraggingBall = false;
            window.removeEventListener("pointermove", onBallPointerMove);
            window.removeEventListener("pointerup", onBallPointerUp);
            window.removeEventListener("pointercancel", onBallPointerUp);

            ball.style.transition = "all 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)";

            if (ballTotalDist < 6) {
                toggleNativeMiniChat();
                return;
            }

            const autoSnap = ctx.system.settings.get("autoSnapEdge") !== false;
            const container = getPhoneScreen();
            const pw = container.clientWidth || 390;
            let finalX = ball.offsetLeft;
            let finalY = ball.offsetTop;

            if (autoSnap) {
                if (finalX + 23 < pw / 2) {
                    finalX = 8;
                } else {
                    finalX = pw - 54;
                }
                ball.style.left = `${finalX}px`;
            }

            ctx.system.storage.set(STORAGE_KEY_BALL_POS, { x: finalX, y: finalY });
            resetIdleTimer();
        }

        ball.addEventListener("pointerdown", onBallPointerDown);

        // 监听新消息红点提示
        const offMsg = ctx.hooks.on("message.persisted", ({ message }) => {
            if (!isNativeMiniChatOpen()) {
                badgeEl.style.display = "block";
                ball.classList.remove("pip-ball-faded");
            }
        });

        // --- 卸载清理 ---
        return () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (pollTimer) clearInterval(pollTimer);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("pointermove", onBallPointerMove);
            window.removeEventListener("pointerup", onBallPointerUp);
            window.removeEventListener("pointercancel", onBallPointerUp);
            ball.removeEventListener("pointerdown", onBallPointerDown);
            const sizeBtn = document.querySelector(".pip-quick-size-btn");
            if (sizeBtn) sizeBtn.remove();
            offMsg();
            disposeCSS();
            if (root) {
                root.remove();
            }
        };
    }
};
