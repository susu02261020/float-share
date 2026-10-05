export default {
  manifest: {
    id: "plot-director",
    name: "剧情导演",
    apiVersion: 1,
    version: "1.4.0",
    author: "西河&小坊",
    description: "支持手动选择「线上聊天」或「线下剧情」的剧情导演插件。闲置贴边半隐，以环境旁白形式精准引导AI推演。",
    permissions: ["chat.read"],
  },

  setup(ctx) {
    let currentSessionId = null;
    let sleepTimer = null;
    let isSleeping = false;
    let dockSide = "right";

    // 默认目标模式: 'online' | 'offline'
    let targetMode = "online";
    try {
      const savedMode = ctx.system.storage.get("target_mode");
      if (savedMode === "offline" || savedMode === "online") {
        targetMode = savedMode;
      }
    } catch (e) {}

    // 线下临时拦截变量
    let pendingOfflineDirective = "";

    // 1. 注入黑紫霓虹全局样式
    ctx.ui.injectCSS(`
      /* 聊天流中的环境旁白消息样式 */
      .dir-narrator-bubble {
        margin: 14px auto;
        max-width: 88%;
        text-align: center;
        padding: 8px 16px;
        background: rgba(22, 16, 38, 0.75);
        border: 1px solid rgba(168, 85, 247, 0.35);
        border-radius: 14px;
        color: #e2e8f0;
        font-size: 13px;
        line-height: 1.55;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), inset 0 0 12px rgba(168, 85, 247, 0.15);
      }
      .dir-narrator-prefix {
        background: linear-gradient(135deg, #c084fc, #ec4899);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-weight: 700;
        margin-right: 6px;
        font-size: 11px;
        letter-spacing: 1px;
        text-transform: uppercase;
      }

      /* 悬浮球样式 */
      #plugin-director-ball {
        position: fixed;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #7e22ce, #a855f7 50%, #ec4899);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        box-shadow: 0 0 16px rgba(168, 85, 247, 0.5), 0 4px 12px rgba(0, 0, 0, 0.6);
        border: 1px solid rgba(244, 114, 182, 0.4);
        cursor: pointer;
        z-index: 9999;
        user-select: none;
        touch-action: none;
        transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease, box-shadow 0.3s ease;
        opacity: 0.95;
      }
      #plugin-director-ball:active {
        transform: scale(0.92) !important;
      }

      /* 闲置贴边半隐藏态 */
      #plugin-director-ball.dock-hidden-right {
        transform: translateX(28px) scale(0.9);
        opacity: 0.38;
        box-shadow: 0 0 8px rgba(168, 85, 247, 0.2);
      }
      #plugin-director-ball.dock-hidden-left {
        transform: translateX(-28px) scale(0.9);
        opacity: 0.38;
        box-shadow: 0 0 8px rgba(168, 85, 247, 0.2);
      }

      /* 弹窗容器（黑紫霓虹风） */
      .dir-neon-sheet {
        display: flex;
        flex-direction: column;
        gap: 14px;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(circle at 80% 20%, rgba(139,0,139,1.00) 0%, rgba(13, 11, 20, 0.96) 65%);
        border: 1px solid rgba(168, 85, 247, 0.3);
        border-radius: 20px;
        padding: 18px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 30px rgba(168, 85, 247, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(20px);
        box-sizing: border-box;
      }

      .dir-neon-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .dir-neon-title-box {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .dir-neon-icon {
        font-size: 20px;
        filter: drop-shadow(0 0 8px #c084fc);
      }
      .dir-neon-title {
        font-size: 16px;
        font-weight: 800;
        letter-spacing: 0.5px;
        background: linear-gradient(135deg, #ffffff 40%, #c084fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      /* 线上/线下 分段选择开关 */
      .dir-mode-switch {
        display: flex;
        background: rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(168, 85, 247, 0.3);
        border-radius: 10px;
        padding: 3px;
        gap: 4px;
      }
      .dir-mode-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        padding: 4px 12px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 7px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .dir-mode-btn.active {
        background: linear-gradient(135deg, #7e22ce, #a855f7);
        color: #ffffff;
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.45);
      }

      /* 快捷胶囊标签 */
      .dir-neon-chips {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 4px;
        scrollbar-width: none;
      }
      .dir-neon-chips::-webkit-scrollbar {
        display: none;
      }
      .dir-neon-chip {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(168, 85, 247, 0.2);
        border-radius: 20px;
        padding: 5px 12px;
        font-size: 12px;
        color: #cbd5e1;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .dir-neon-chip:active {
        background: rgba(168, 85, 247, 0.25);
        border-color: #c084fc;
        color: #ffffff;
        box-shadow: 0 0 12px rgba(192, 132, 252, 0.4);
      }

      .dir-neon-textarea-wrap {
        position: relative;
      }
      .dir-neon-textarea {
        width: 100%;
        height: 105px;
        background: rgba(8, 6, 14, 0.7);
        border: 1px solid rgba(168, 85, 247, 0.25);
        border-radius: 14px;
        padding: 12px;
        color: #ffffff;
        font-size: 14px;
        line-height: 1.55;
        resize: none;
        outline: none;
        box-sizing: border-box;
        transition: all 0.25s ease;
      }
      .dir-neon-textarea:focus {
        border-color: #a855f7;
        box-shadow: 0 0 18px rgba(168, 85, 247, 0.35), inset 0 0 8px rgba(168, 85, 247, 0.15);
      }
      .dir-neon-textarea::placeholder {
        color: rgba(148, 163, 184, 0.45);
      }

      .dir-neon-hint {
        font-size: 11px;
        color: #94a3b8;
        line-height: 1.4;
      }
      .dir-neon-hint b {
        color: #c084fc;
      }

      .dir-neon-submit-btn {
        height: 44px;
        background: linear-gradient(135deg, #7e22ce, #9333ea 40%, #ec4899);
        color: #ffffff;
        border: none;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 18px rgba(147, 51, 234, 0.45), 0 0 8px rgba(236, 72, 153, 0.3);
        transition: all 0.2s ease;
      }
      .dir-neon-submit-btn:active {
        transform: scale(0.98);
        filter: brightness(1.1);
      }
    `);

    // 2. 自定义旁白渲染卡片
    ctx.ui.messageKind("director_narrator", (el, msg) => {
      const text = msg?.mediaData?.text || msg?.content || "";
      el.innerHTML = `
        <div class="dir-narrator-bubble">
          <span class="dir-narrator-prefix">✦ 剧幕情境</span>
          <span>${text}</span>
        </div>
      `;
    });

    // 3. 追踪线上会话
    ctx.hooks.on("session.opened", ({ sessionId }) => {
      currentSessionId = sessionId;
      if (floatBall) floatBall.style.display = "flex";
      resetSleepTimer();
    });

    // 4. 线下模式无输入框时的底层请求直塞
    ctx.hooks.transform("llm.request", async (payload) => {
      if (!pendingOfflineDirective) return payload;

      if (Array.isArray(payload.messages)) {
        payload.messages.push({
          role: "system",
          content: `【当前场景突发事件】：${pendingOfflineDirective}。\n（注意：这是客观发生的情境/环境事件，请当前角色以此为基础自然接话或做出反应，切勿在对话中复述本指示。）`
        });
        pendingOfflineDirective = "";
      }
      return payload;
    }, { priority: 200 });

    // 5. 创建悬浮球
    const floatBall = document.createElement("div");
    floatBall.id = "plugin-director-ball";
    floatBall.innerHTML = "🎬";
    floatBall.title = "剧情导演";

    let currentRight = 12;
    let currentBottom = 110;

    try {
      const savedPos = ctx.system.storage.get("ball_pos_v4");
      if (savedPos) {
        currentRight = savedPos.right;
        currentBottom = savedPos.bottom;
        dockSide = savedPos.dockSide || "right";
      }
    } catch (e) {}

    floatBall.style.right = currentRight + "px";
    floatBall.style.bottom = currentBottom + "px";

    function wakeUpBall() {
      if (isSleeping) {
        isSleeping = false;
        floatBall.classList.remove("dock-hidden-right", "dock-hidden-left");
      }
      resetSleepTimer();
    }

    function sleepBall() {
      if (isSleeping) return;
      isSleeping = true;
      if (dockSide === "right") {
        floatBall.classList.add("dock-hidden-right");
      } else {
        floatBall.classList.add("dock-hidden-left");
      }
    }

    function resetSleepTimer() {
      if (sleepTimer) clearTimeout(sleepTimer);
      sleepTimer = setTimeout(sleepBall, 3500);
    }

    // 拖拽与吸附
    let isDragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;
    let hasMoved = false;

    floatBall.addEventListener("pointerdown", (e) => {
      wakeUpBall();
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = floatBall.getBoundingClientRect();
      origX = window.innerWidth - rect.right;
      origY = window.innerHeight - rect.bottom;
      floatBall.setPointerCapture(e.pointerId);
    });

    floatBall.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        hasMoved = true;
      }
      const newRight = Math.max(-10, Math.min(window.innerWidth - 38, origX + dx));
      const newBottom = Math.max(20, Math.min(window.innerHeight - 60, origY + dy));
      floatBall.style.right = newRight + "px";
      floatBall.style.bottom = newBottom + "px";
      currentRight = newRight;
      currentBottom = newBottom;
    });

    floatBall.addEventListener("pointerup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        floatBall.releasePointerCapture(e.pointerId);
      } catch (err) {}

      const ballCenter = window.innerWidth - currentRight - 24;
      if (ballCenter > window.innerWidth / 2) {
        dockSide = "left";
        currentRight = window.innerWidth - 56;
      } else {
        dockSide = "right";
        currentRight = 10;
      }
      floatBall.style.right = currentRight + "px";

      try {
        ctx.system.storage.set("ball_pos_v4", {
          right: currentRight,
          bottom: currentBottom,
          dockSide
        });
      } catch (err) {}

      if (!hasMoved) {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => openDirectorModal(), 80);
      }

      resetSleepTimer();
    });

    document.body.appendChild(floatBall);
    resetSleepTimer();

    // 6. 推进按钮触发器
    function triggerAdvance() {
      const buttons = Array.from(document.querySelectorAll("button"));
      const targetBtn = buttons.find((b) => {
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const txt = (b.textContent || "").trim();
        const label = b.getAttribute("aria-label") || "";
        return /推演|继续|下一步|生成|推进|发送/.test(txt + label);
      });

      if (targetBtn) {
        targetBtn.click();
        return true;
      }
      return false;
    }

    // 7. 唤起输入弹窗
    function openDirectorModal() {
      wakeUpBall();

      ctx.ui.openModal((container, { close }) => {
        container.addEventListener("click", (evt) => evt.stopPropagation());
        container.addEventListener("pointerdown", (evt) => evt.stopPropagation());

        container.innerHTML = `
          <div class="dir-neon-sheet">
            <div class="dir-neon-header">
              <div class="dir-neon-title-box">
                <span class="dir-neon-icon">🎬</span>
                <span class="dir-neon-title">剧情导演</span>
              </div>
              
              <!-- 核心：用户自由选择要注入的目标 -->
              <div class="dir-mode-switch">
                <button class="dir-mode-btn ${targetMode === "online" ? "active" : ""}" type="button" id="btn-mode-online">线上聊天</button>
                <button class="dir-mode-btn ${targetMode === "offline" ? "active" : ""}" type="button" id="btn-mode-offline">线下剧情</button>
              </div>
            </div>

            <div class="dir-neon-chips">
              <button class="dir-neon-chip" type="button" data-txt="突发紧急状况，外力打破了当前的平静。">✦ 突发异动</button>
              <button class="dir-neon-chip" type="button" data-txt="双方发生分歧争执，各自坚持己见，气氛紧张。">✦ 矛盾升级</button>
              <button class="dir-neon-chip" type="button" data-txt="不小心透露出隐瞒的关键秘密，全场震惊。">✦ 意外泄密</button>
              <button class="dir-neon-chip" type="button" data-txt="气氛缓和下来，彼此坦白内心真实的情感与想法。">✦ 坦露心扉</button>
              <button class="dir-neon-chip" type="button" data-txt="周围环境突变，天气剧变或有外人突然闯入。">✦ 环境骤变</button>
            </div>

            <div class="dir-neon-textarea-wrap">
              <textarea class="dir-neon-textarea" id="dir-modal-input" placeholder="输入此刻发生的剧情旁白（如：对方突然拉住你的手，神色复杂地看着你...）"></textarea>
            </div>
            
            <div class="dir-neon-hint" id="dir-mode-hint">
              ${targetMode === "online" 
                ? "<span>💡 目标：</span><b>线上普通聊天</b>，旁白将直接发入线上聊天气泡流中。"
                : "<span>💡 目标：</span><b>线下剧情/面谈窗口</b>，旁白将注入当前打开的线下窗口。"}
            </div>

            <button class="dir-neon-submit-btn" type="button" id="dir-modal-send">
              注入【${targetMode === "online" ? "线上聊天" : "线下剧情"}】并推进
            </button>
          </div>
        `;

        const textarea = container.querySelector("#dir-modal-input");
        const btnSend = container.querySelector("#dir-modal-send");
        const btnOnline = container.querySelector("#btn-mode-online");
        const btnOffline = container.querySelector("#btn-mode-offline");
        const modeHint = container.querySelector("#dir-mode-hint");
        const chipBtns = container.querySelectorAll(".dir-neon-chip");

        // 切换模式事件
        btnOnline.addEventListener("click", () => {
          targetMode = "online";
          btnOnline.classList.add("active");
          btnOffline.classList.remove("active");
          modeHint.innerHTML = "<span>💡 目标：</span><b>线上普通聊天</b>，旁白将直接发入线上聊天气泡流中。";
          btnSend.textContent = "注入【线上聊天】并推进";
          try { ctx.system.storage.set("target_mode", "online"); } catch (e) {}
        });

        btnOffline.addEventListener("click", () => {
          targetMode = "offline";
          btnOffline.classList.add("active");
          btnOnline.classList.remove("active");
          modeHint.innerHTML = "<span>💡 目标：</span><b>线下剧情/面谈窗口</b>，旁白将注入当前打开的线下窗口。";
          btnSend.textContent = "注入【线下剧情】并推进";
          try { ctx.system.storage.set("target_mode", "offline"); } catch (e) {}
        });

        chipBtns.forEach((btn) => {
          btn.addEventListener("click", () => {
            textarea.value = btn.getAttribute("data-txt");
            textarea.focus();
          });
        });

        setTimeout(() => textarea.focus(), 60);

        btnSend.addEventListener("click", async () => {
          const rawText = textarea.value.trim();
          if (!rawText) {
            ctx.ui.toast("请输入旁白内容");
            return;
          }

          btnSend.disabled = true;
          btnSend.textContent = "正在送入剧情流...";

          try {
            const narrativeContent = `（环境旁白：${rawText}）`;

            if (targetMode === "online") {
              // ==================== 1. 明确发给线上聊天 ====================
              let targetSid = currentSessionId;
              if (!targetSid && ctx.data?.sessions?.list) {
                const list = ctx.data.sessions.list();
                if (list && list.length > 0) targetSid = list[0].id;
              }

              if (!targetSid) {
                ctx.ui.toast("未定位到线上聊天会话");
                btnSend.disabled = false;
                btnSend.textContent = "注入【线上聊天】并推进";
                return;
              }

              await ctx.data.messages.push({
                sessionId: targetSid,
                role: "system",
                content: narrativeContent,
                mediaType: "plugin:director_narrator",
                mediaData: { text: rawText }
              });

              triggerAdvance();
              ctx.ui.toast("已注入线上会话");

            } else {
              // ==================== 2. 明确发给线下剧情 ====================
              let injected = false;

              // 查找当前屏幕上可见的线下输入框
              const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
              const visibleInput = inputs.find(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && el.id !== "dir-modal-input";
              });

              if (visibleInput) {
                const nativeSetter =
                  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
                  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

                if (nativeSetter) {
                  nativeSetter.call(visibleInput, narrativeContent);
                } else {
                  visibleInput.value = narrativeContent;
                }

                visibleInput.dispatchEvent(new Event("input", { bubbles: true }));
                visibleInput.dispatchEvent(new Event("change", { bubbles: true }));

                // 找发送按钮
                const buttons = Array.from(document.querySelectorAll("button"));
                const sendBtn = buttons.find(b => {
                  const label = b.getAttribute("aria-label") || "";
                  const txt = (b.textContent || "").trim();
                  return txt === "发送" || /发送/.test(label);
                });

                if (sendBtn) {
                  sendBtn.click();
                  injected = true;
                } else {
                  visibleInput.dispatchEvent(
                    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
                  );
                  injected = true;
                }
              }

              // 线下围观或无输入框：通过底层硬塞 + 触发推演
              if (!injected) {
                pendingOfflineDirective = rawText;
                triggerAdvance();
                injected = true;
              }

              ctx.ui.toast("已注入线下剧情");
            }

            close();
            resetSleepTimer();
          } catch (err) {
            console.error("注入失败:", err);
            ctx.ui.toast("发送失败: " + (err.message || "未知错误"));
          } finally {
            btnSend.disabled = false;
            btnSend.textContent = `注入【${targetMode === "online" ? "线上聊天" : "线下剧情"}】并推进`;
          }
        });
      });
    }

    // 8. 卸载清理
    return () => {
      if (sleepTimer) clearTimeout(sleepTimer);
      if (floatBall && floatBall.parentNode) {
        floatBall.remove();
      }
      pendingOfflineDirective = "";
    };
  }
};