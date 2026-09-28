// =========================================================================
// 角色成长手帐 (Char Growth Planner) · 小手机聊天扩展插件
// 版本: 1.7.0
// 契约版本: apiVersion 1 (适用于 float / AI Virtual Phone)
// 核心理念:
// 1. 【只能人工打勾】：彻底取消任何自动打勾与自愈打勾，目标达成判定权 100% 交由用户！
// 2. 【大跨度宏观目标】：杜绝碎屑琐事，支持细水长流、宏观沉淀与目标自由修改
// 3. 【真实小手机聊天】：严禁小说式中二括号动作戏，像真人发微信一样自然聊天
// 4. 【尊重用户控制权】：严禁擅自自动发消息，保持纯正生活感与目标感
// =========================================================================

export default {
  manifest: {
    id: "char-growth-planner",
    name: "角色成长手帐",
    apiVersion: 1,
    version: "1.7.0",
    author: "Antigravity",
    description: "为角色制定长期生活目标。角色在聊天中带着大跨度目标生活，严格人工打勾（杜绝系统自动打勾），支持陪伴打卡与目标自由编辑。",
    permissions: ["chat.read", "chat.write", "ai", "ui", "storage"],
    settings: [
      { key: "injectPrompt", label: "角色聊天时参考成长规划与生活近况", type: "boolean", default: true },
      { key: "autoAdvance", label: "日常聊天时记录陪伴印记（任务仅限人工手动打勾）", type: "boolean", default: true },
      { key: "showBadge", label: "在聊天顶栏显示目标胶囊", type: "boolean", default: true },
      { key: "advanceStep", label: "手动陪伴打卡每次增加进度(%)", type: "number", default: 10 },
    ],
  },

  setup(ctx) {
    // -------------------------------------------------------------
    // 1. 全局样式注入 (现代化卡片设计，支持亮暗色主题自适应)
    // -------------------------------------------------------------
    const css = `
      .cgp-header-wrap {
        padding: 4px 12px 6px;
        background: transparent;
      }
      .cgp-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 14px;
        border-radius: 9999px;
        background: var(--c-card-bg, #ffffff);
        border: 1px solid rgba(16, 185, 129, 0.35);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
        cursor: pointer;
        user-select: none;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        font-size: 12px;
      }
      .cgp-pill:hover {
        transform: translateY(-1px);
        border-color: #10b981;
        box-shadow: 0 4px 14px rgba(16, 185, 129, 0.2);
      }
      .cgp-pill-icon {
        font-size: 14px;
        line-height: 1;
      }
      .cgp-pill-title {
        font-weight: 700;
        color: var(--c-text, #0f172a);
        max-width: 130px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cgp-pill-stage {
        color: var(--c-subtext, #475569);
        font-size: 11px;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cgp-pill-bar-box {
        width: 44px;
        height: 6px;
        background: rgba(0, 0, 0, 0.08);
        border-radius: 999px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .cgp-pill-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #10b981, #06b6d4);
        border-radius: 999px;
        transition: width 0.3s ease;
      }
      .cgp-pill-pct {
        font-size: 11px;
        font-weight: 700;
        color: #059669;
        flex-shrink: 0;
      }

      .cgp-toolbar-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 12px;
        background: var(--c-card-bg, #ffffff);
        border: 1px solid var(--c-border, rgba(0,0,0,0.1));
        font-size: 12px;
        font-weight: 600;
        color: var(--c-text, #0f172a);
        cursor: pointer;
        transition: all 0.15s ease;
        margin: 6px 0;
      }
      .cgp-toolbar-item:hover {
        background: rgba(16, 185, 129, 0.08);
        border-color: #10b981;
        color: #059669;
      }

      .cgp-modal {
        padding: 20px;
        max-width: 520px;
        width: 100%;
        box-sizing: border-box;
        font-family: inherit;
      }
      .cgp-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 16px;
      }
      .cgp-title-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .cgp-main-title {
        font-size: 18px;
        font-weight: 700;
        margin: 0;
        color: var(--c-text, #0f172a);
      }
      .cgp-tag {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        background: rgba(16, 185, 129, 0.15);
        color: #059669;
        font-weight: 600;
      }
      .cgp-close-btn {
        background: none;
        border: none;
        font-size: 20px;
        color: var(--c-subtext, #94a3b8);
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        line-height: 1;
      }
      .cgp-close-btn:hover {
        background: rgba(0,0,0,0.05);
        color: var(--c-text, #0f172a);
      }
      
      .cgp-vision-card {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(168, 85, 247, 0.08));
        border: 1px solid rgba(99, 102, 241, 0.2);
        border-radius: 12px;
        padding: 14px 16px;
        margin-bottom: 16px;
      }
      .cgp-vision-label {
        font-size: 11px;
        text-transform: uppercase;
        font-weight: 700;
        color: #6366f1;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .cgp-vision-text {
        font-size: 15px;
        font-weight: 600;
        color: var(--c-text, #1e1b4b);
        line-height: 1.4;
      }

      .cgp-stage-card {
        background: var(--c-surface, rgba(0,0,0,0.02));
        border: 1px solid var(--c-border, rgba(0,0,0,0.08));
        border-radius: 14px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .cgp-stage-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .cgp-stage-badge {
        font-size: 12px;
        font-weight: 700;
        color: #0284c7;
      }
      .cgp-stage-pct {
        font-size: 14px;
        font-weight: 800;
        color: #059669;
      }
      .cgp-progress-track {
        height: 8px;
        background: rgba(0,0,0,0.06);
        border-radius: 999px;
        overflow: hidden;
        margin-bottom: 12px;
      }
      .cgp-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #10b981, #06b6d4);
        border-radius: 999px;
        transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .cgp-stage-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--c-text, #0f172a);
        margin-bottom: 6px;
      }
      .cgp-stage-desc {
        font-size: 13px;
        color: var(--c-subtext, #475569);
        line-height: 1.45;
        margin-bottom: 12px;
      }

      .cgp-tasks-box {
        margin: 10px 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .cgp-task-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 13px;
        color: var(--c-text, #1e293b);
        background: var(--c-card-bg, #fff);
        padding: 9px 11px;
        border-radius: 8px;
        border: 1px solid var(--c-border, rgba(0,0,0,0.06));
        cursor: pointer;
        transition: background 0.15s;
        line-height: 1.4;
      }
      .cgp-task-item:hover {
        background: rgba(0,0,0,0.02);
      }
      .cgp-task-item.done {
        text-decoration: line-through;
        opacity: 0.6;
      }
      .cgp-task-checkbox {
        accent-color: #10b981;
        cursor: pointer;
        margin-top: 3px;
        flex-shrink: 0;
      }
      .cgp-task-text {
        flex: 1;
        word-break: break-word;
      }
      .cgp-task-edit-btn {
        opacity: 0.35;
        cursor: pointer;
        padding: 0 4px;
        font-size: 13px;
        user-select: none;
        transition: opacity 0.15s;
        flex-shrink: 0;
      }
      .cgp-task-edit-btn:hover {
        opacity: 1;
      }
      .cgp-add-task-btn {
        padding: 7px 12px;
        border-radius: 8px;
        background: transparent;
        border: 1px dashed var(--c-border, rgba(0,0,0,0.18));
        font-size: 12px;
        font-weight: 600;
        color: var(--c-subtext, #64748b);
        cursor: pointer;
        text-align: center;
        margin-top: 4px;
        transition: all 0.15s ease;
      }
      .cgp-add-task-btn:hover {
        border-color: #10b981;
        color: #059669;
        background: rgba(16, 185, 129, 0.06);
      }

      .cgp-mindset-box {
        margin: 12px 0;
        padding: 10px 12px;
        background: rgba(245, 158, 11, 0.08);
        border-left: 3px solid #f59e0b;
        border-radius: 0 8px 8px 0;
        font-size: 12px;
        color: var(--c-text, #78350f);
        line-height: 1.45;
      }

      .cgp-actions-row {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        flex-wrap: wrap;
      }
      .cgp-btn {
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        border: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.2s ease;
      }
      .cgp-btn-primary {
        background: #10b981;
        color: #fff;
      }
      .cgp-btn-primary:hover {
        background: #059669;
        transform: translateY(-1px);
      }
      .cgp-btn-msg {
        background: linear-gradient(135deg, #0ea5e9, #6366f1);
        color: #fff;
        box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25);
      }
      .cgp-btn-msg:hover {
        opacity: 0.95;
        transform: translateY(-1px);
      }
      .cgp-btn-secondary {
        background: rgba(0,0,0,0.06);
        color: var(--c-text, #334155);
      }
      .cgp-btn-secondary:hover {
        background: rgba(0,0,0,0.1);
      }
      .cgp-btn-warning {
        background: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fca5a5;
      }
      .cgp-btn-warning:hover {
        background: #fecaca;
      }
      .cgp-btn-ghost {
        background: transparent;
        color: var(--c-subtext, #64748b);
      }
      .cgp-btn-ghost:hover {
        background: rgba(0,0,0,0.05);
        color: var(--c-text, #0f172a);
      }

      .cgp-timeline {
        margin-top: 16px;
      }
      .cgp-section-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--c-subtext, #64748b);
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cgp-log-list {
        max-height: 130px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-right: 4px;
      }
      .cgp-log-item {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 6px;
        background: rgba(0,0,0,0.02);
        color: var(--c-text, #334155);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .cgp-log-time {
        font-size: 10px;
        color: var(--c-subtext, #94a3b8);
        white-space: nowrap;
        margin-left: 8px;
      }

      .cgp-empty-view {
        text-align: center;
        padding: 24px 12px;
      }
      .cgp-empty-icon {
        font-size: 40px;
        margin-bottom: 12px;
      }
      .cgp-empty-title {
        font-size: 16px;
        font-weight: 700;
        color: var(--c-text, #0f172a);
        margin-bottom: 6px;
      }
      .cgp-empty-desc {
        font-size: 13px;
        color: var(--c-subtext, #64748b);
        line-height: 1.5;
        margin-bottom: 16px;
      }
    `;
    ctx.ui.injectCSS(css);

    // -------------------------------------------------------------
    // 2. 超健壮的角色解析方法
    // -------------------------------------------------------------
    function getCharacterForSession(sessionId) {
      if (!sessionId) return null;
      try {
        const session = ctx.data.sessions.get(sessionId);
        const allChars = ctx.data.characters.list() || [];

        if (session && session.contactId) {
          const direct = ctx.data.characters.get(session.contactId) || allChars.find((c) => c.id === session.contactId);
          if (direct) return direct;

          const contacts = ctx.data.contacts.list() || [];
          const matchedContact = contacts.find((c) => c.id === session.contactId || c.characterId === session.contactId);
          if (matchedContact && matchedContact.characterId) {
            const char = ctx.data.characters.get(matchedContact.characterId) || allChars.find((c) => c.id === matchedContact.characterId);
            if (char) return char;
          }
        }

        if (session && session.alias) {
          const char = allChars.find((c) => c.name === session.alias);
          if (char) return char;
        }

        const msgs = ctx.data.messages.list(sessionId) || [];
        for (const m of msgs) {
          if (m.senderCharacterId) {
            const char = ctx.data.characters.get(m.senderCharacterId) || allChars.find((c) => c.id === m.senderCharacterId);
            if (char) return char;
          }
        }

        if (allChars.length === 1) return allChars[0];
        return null;
      } catch (e) {
        ctx.system.log("解析角色发生异常:", e);
        return null;
      }
    }

    function getPlan(charId) {
      if (!charId) return null;
      return ctx.system.storage.get(`plan:${charId}`);
    }

    function savePlan(charId, plan) {
      if (!charId) return;
      plan.updatedAt = new Date().toISOString();
      ctx.system.storage.set(`plan:${charId}`, plan);
      refreshMountedViews();
    }

    function notifyChatRoomMessagesUpdated(sessionId) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
      }
    }

    // -------------------------------------------------------------
    // 3. 推进与陪伴记录（严格人工打勾模式，绝不自动打勾任何任务）
    // -------------------------------------------------------------
    function advancePlanProgress(charId, plan, gain, reason, type = "manual") {
      if (!plan || !plan.stages || plan.stages.length === 0) return;
      const curIdx = plan.currentStageIndex || 0;
      const stage = plan.stages[curIdx];
      if (!stage) return;

      const now = new Date();
      const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      if (!plan.growthLogs) plan.growthLogs = [];

      let newProgress = (plan.currentStageProgress || 0) + gain;

      if (newProgress >= 100) {
        stage.status = "completed";

        plan.growthLogs.unshift({
          time: timeStr,
          text: `🎉 里程碑达成：完成【${stage.title}】`,
          type: "stage_up",
        });

        if (curIdx + 1 < plan.stages.length) {
          plan.currentStageIndex = curIdx + 1;
          plan.currentStageProgress = 0;
          const nextStage = plan.stages[curIdx + 1];
          nextStage.status = "in_progress";
          plan.currentMindset = `已顺利完成上一阶段！现在开始专注于【${nextStage.title}】。`;

          plan.growthLogs.unshift({
            time: timeStr,
            text: `🚀 解锁新阶段：${nextStage.title}`,
            type: "stage_up",
          });
          ctx.ui.toast(`🎉 ${plan.charName || "角色"} 达成了【${stage.title}】，已开启新阶段！`);
        } else {
          plan.currentStageProgress = 100;
          plan.growthLogs.unshift({
            time: timeStr,
            text: `🏆 终极愿景【${plan.coreVision}】圆满实现！`,
            type: "stage_up",
          });
          ctx.ui.toast(`🏆 太棒了！${plan.charName || "角色"} 的核心目标【${plan.coreVision}】已全部达成！`);
        }
      } else {
        plan.currentStageProgress = Math.max(0, Math.min(99, newProgress));
        stage.status = "in_progress";
        plan.growthLogs.unshift({
          time: timeStr,
          text: `${reason} (+${gain}%)`,
          type,
        });

        if (type === "auto") {
          ctx.ui.toast(`🌱 陪伴推进：${reason} (+${gain}%)`);
        }
      }

      if (plan.growthLogs.length > 60) plan.growthLogs.length = 60;
      savePlan(charId, plan);
    }

    // -------------------------------------------------------------
    // 4. AI 规划生成推演引擎 (只做规划保存，绝不擅自自动发消息)
    // -------------------------------------------------------------
    async function generatePlanWithAI(char) {
      const toastHolder = ctx.ui.toast(`🧠 正在为 ${char.name} 量身推演生活规划...`, { durationMs: 0 });
      try {
        const prompt = `请仔细阅读下列角色的身份、背景与性格，为TA制定一个切合人设、真实且具有生活目标感的长期规划。

角色信息：
- 姓名：${char.name}
- 性格：${char.personality || "自然"}
- 人设与背景设定：
${char.persona || "暂无特别人设说明"}

【规划要求（极其重要）】：
1. 核心愿景 (coreVision)：提炼一个最切合角色当前身份的大跨度人生愿景（例如大四考研攻坚、商业帝国与情感攻防、专业驯宠与深度陪伴、财富自由积累等）；
2. 规划类别 (category)：2~4个汉字（如“情感谋夺”、“学业深造”、“职场问鼎”、“生活爱宠”等）；
3. 初始心境与近况 (initialMindset)：描述角色当前在这一愿景下的真实生活状态、日常琐碎与心中打算；
4. 阶段路线 (stages)：3 到 4 个递进阶段。每个阶段包含：
   - title：阶段名称（简短清晰）
   - desc：该阶段的核心打算
   - tasks：该阶段的 3 个【具有大跨度、需要经历长期沉淀才能达成的关键里程碑大目标】！

【大跨度任务设计原则（必须严格遵守）】：
❌ 严禁写微观碎小的琐事（严禁写“约一次私密午餐”、“送个小礼物”、“深夜接送一次”、“发一条撤回消息”等随口一两句就能做完的事，这样一下子就全勾完了，毫无成长感）！
✅ 必须是大跨度、需要经历数周甚至数月深入相处与关键考验才能攻克的实质成果！
例如：
- 商业/情感类大跨度示范：
  - 任务1：【以导师与长辈身份深度介入其关键职业决策，使其形成首要心理依赖】
  - 任务2：【全面渗透其私人生活圈与隐秘习惯，无声瓦解其原本的情感防线与警惕心】
  - 任务3：【在关键利益关头施展绝对权威与雷霆手段，为其扫清外部障碍并树立不可动摇的保护者形象】
- 学业考研类大跨度示范：
  - 任务1：【夯实高数与专业课核心考点，建立完整的知识体系框架】
  - 任务2：【突破英语长难句与真题研读，形成稳定的做题手感与时间把控】
  - 任务3：【完成全真模拟冲刺与心态调适，达成全科目模考达标】
- 宠物生活类大跨度示范：
  - 任务1：【建立幼宠对主人的信任与指令服从反射基础】
  - 任务2：【完成社会化脱敏与户外随行防冲训导】
  - 任务3：【形成稳定生活作息与高阶互动技能默契】

【输出格式】
必须严格输出纯 JSON 对象，不要包含 markdown 代码块反引号，不要有闲聊：
{
  "coreVision": "...",
  "category": "...",
  "initialMindset": "...",
  "stages": [
    {
      "title": "...",
      "desc": "...",
      "tasks": ["...", "..."]
    }
  ]
}`;

        const rawReply = await ctx.ai.chat({
          prompt,
          system: "你是一个专业的角色规划生成引擎。必须且只能输出严格合法的 JSON 格式字符串。",
          temperature: 0.7,
        });

        let cleanJson = rawReply.trim();
        const codeBlockMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) cleanJson = codeBlockMatch[1].trim();

        const data = JSON.parse(cleanJson);
        if (!data.coreVision || !Array.isArray(data.stages) || data.stages.length === 0) {
          throw new Error("模型返回的规划结构不完整");
        }

        const now = new Date();
        const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        const formattedPlan = {
          characterId: char.id,
          charName: char.name,
          coreVision: data.coreVision,
          category: data.category || "人生目标",
          currentMindset: data.initialMindset || "正暗自按既定计划步步推进。",
          currentStageIndex: 0,
          currentStageProgress: 0,
          stages: data.stages.map((stg, idx) => ({
            title: stg.title || `阶段 ${idx + 1}`,
            desc: stg.desc || "",
            tasks: (stg.tasks || []).map((t) => ({ text: String(t), done: false })),
            status: idx === 0 ? "in_progress" : "pending",
          })),
          growthLogs: [
            {
              time: timeStr,
              text: `🌱 开启了新规划：【${data.coreVision}】`,
              type: "manual",
            },
          ],
        };

        savePlan(char.id, formattedPlan);
        ctx.ui.toast(`✨ 已成功为 ${char.name} 生成新规划！`);
        return formattedPlan;
      } catch (err) {
        ctx.system.log("生成规划失败:", err);
        ctx.ui.toast(`❌ 生成失败：${err instanceof Error ? err.message : "模型调用或解析异常"}`);
        return null;
      } finally {
        toastHolder.close();
      }
    }

    // -------------------------------------------------------------
    // 5. 让TA主动发一条手机消息（纯真人微信口吻，严禁小说括号动作！）
    // -------------------------------------------------------------
    async function sendProactiveChatMessage(sessionId, char, plan) {
      if (!sessionId) {
        ctx.ui.toast("未能定位当前会话");
        return;
      }

      const curIdx = plan.currentStageIndex || 0;
      const stage = plan.stages[curIdx];
      if (!stage) return;

      const unDoneTask = (stage.tasks || []).find((t) => !t.done) || (stage.tasks || [])[0];
      const taskDesc = unDoneTask ? unDoneTask.text : stage.desc;

      const toastHolder = ctx.ui.toast(`💬 ${char.name} 正在给你发消息...`, { durationMs: 0 });
      try {
        const recentMsgs = (ctx.data.messages.list(sessionId) || []).slice(-6);
        const historyText = recentMsgs
          .map((m) => `${m.role === "assistant" ? char.name : "对方"}: ${m.content}`)
          .join("\n");

        const prompt = `你是【${char.name}】。你正在手机聊天软件（像发微信一样）给对方发一条即时消息。

【你的生活近况与当前心中打算】：
- 你的目标规划：【${plan.coreVision}】
- 当前阶段生活重心：【${stage.title}】
- 你此刻想在聊天中落实或聊起的事：【${taskDesc}】
- 你的当下心绪：${plan.currentMindset}

【近期对话上下文】：
${historyText || "（双方目前在手机聊天列表中）"}

【发言核心规范（必须严格遵守）】：
1. 【这是手机发信息，不是小说跑团！】：严禁写任何括号动作描写（严禁写“（斜倚在榻上）”、“（眼神深沉）”、“（声音低哑）”等中二小说旁白）！
2. 【真人发微信口吻】：只输出发在手机聊天气泡里的纯台词！文字要像真人发微信一样自然、口语化，符合你的角色身份。
3. 【精简自然】：字数控制在 25~60 字以内，说一两句自然的话，把话题抛给对方！
4. 结尾可带隐式标记：[成长推进:+8:主动聊起${taskDesc.slice(0, 10)}]。`;

        const reply = await ctx.ai.chat({
          prompt,
          system: `你正在通过手机聊天软件与人交流。你必须只输出直接发送出去的手机消息文本，绝对严禁任何括号动作描写，绝不要任何小说描写。`,
          temperature: 0.8,
        });

        // 彻底清理所有括号动作描写（防止模型偶尔抽风带括号）
        let cleanText = reply.trim()
          .replace(/（[^）]*）/g, "")
          .replace(/\([^\)]*\)/g, "")
          .trim();

        const match = cleanText.match(/\[成长推进[:：]\+?(\d+)[:：]?([^\]]*)\]/);
        cleanText = cleanText.replace(/\[成长推进[:：]\+?\d+[:：]?[^\]]*\]/g, "").trim();

        if (!cleanText) cleanText = "在忙什么呢？";

        ctx.data.messages.push({
          sessionId,
          role: "assistant",
          content: cleanText,
        });

        notifyChatRoomMessagesUpdated(sessionId);

        const gain = match ? Math.max(3, parseInt(match[1], 10) || 5) : 5;
        const reason = (match && match[2]?.trim()) || `主动联系与生活问询`;
        advancePlanProgress(char.id, plan, gain, reason, "auto");
      } catch (e) {
        ctx.system.log("发消息失败:", e);
        ctx.ui.toast(`❌ 发送失败：${e instanceof Error ? e.message : "网络异常"}`);
      } finally {
        toastHolder.close();
      }
    }

    // -------------------------------------------------------------
    // 6. 提示词动态注入：小手机真实生活聊天（去剧本化）
    // -------------------------------------------------------------
    ctx.hooks.transform("prompt.system", (payload) => {
      if (ctx.system.settings.get("injectPrompt") === false) return payload;
      if (payload.isGroup) return payload;

      const char = getCharacterForSession(payload.sessionId);
      if (!char) return payload;

      const plan = getPlan(char.id);
      if (!plan || !plan.stages || plan.stages.length === 0) return payload;

      const curIdx = plan.currentStageIndex || 0;
      const curStage = plan.stages[curIdx];
      if (!curStage) return payload;

      const tasksList = (curStage.tasks || [])
        .map((t, idx) => `  ${idx + 1}. [${t.done ? "已做完" : "近期打算"}] ${t.text}`)
        .join("\n");

      const autoAdvanceRule = ctx.system.settings.get("autoAdvance") !== false
        ? `\n- 【成长标记】：如果你在本次聊天中聊到了上述近况并有所推进，请在回复最末尾隐秘附带：[成长推进:+数值:简述]（如 [成长推进:+5:聊了日常打算]）。`
        : "";

      const injectText = `
【角色当下生活重心与心智（小手机真实聊天模式）】
你现在正在通过手机与对方发微信/短信聊天。
你是一个有真实生活目标的人，心底记挂着你当下的生活规划：
- 长期目标：${plan.coreVision}
- 当前阶段（第 ${curIdx + 1}/${plan.stages.length} 阶段）：【${curStage.title}】
- 近期生活打算：${curStage.desc}
${tasksList}
- 近期真实心境：${plan.currentMindset || "踏实生活中"}

【小手机聊天核心规范（务必严格遵守）】：
1. 【这是手机发信息，不是演舞台剧！】：绝对禁止输出（冷笑）（眼神微暗）（抚弄扳指）（身体前倾）这类脱离手机聊天场景的小说动作描写！你是在手机屏幕前打字或语音，请直接输出符合人设口吻的纯聊天文字！
2. 【生活感融入】：在聊天回复时，自然代入你当前阶段的生活状态（例如顺口提一句今天在忙的打算、给对方安排的事、复习背书的日常或宠物的近况），像一个真人聊天一样自然生活。
3. 【精简真实】：保持普通手机聊天的节奏，每条消息 30~80 字左右即可，不要发大篇长文！${autoAdvanceRule}
`.trim();

      payload.hint = (payload.hint ? payload.hint + "\n\n" : "") + injectText;
      return payload;
    });

    // -------------------------------------------------------------
    // 7. 回复拦截与 AI 自主感知推进 (llm.response transform)
    // -------------------------------------------------------------
    ctx.hooks.transform("llm.response", (payload) => {
      if (!payload.text) return payload;

      // 1. 如果模型带了隐式标记，优先提取并清除
      const match = payload.text.match(/\[成长推进[:：]\+?(\d+)[:：]?([^\]]*)\]/);
      if (match) {
        payload.text = payload.text.replace(/\[成长推进[:：]\+?\d+[:：]?[^\]]*\]/g, "").trim();
      }

      if (ctx.system.settings.get("autoAdvance") !== false && payload.sessionId) {
        const char = getCharacterForSession(payload.sessionId);
        if (char) {
          const plan = getPlan(char.id);
          if (plan && plan.stages && plan.stages.length > 0) {
            // 普通日常交流陪伴：稳步累加 1% 陪伴感（任务仅限人工手动打勾）
            advancePlanProgress(char.id, plan, 1, "日常聊天与陪伴", "auto");
          }
        }
      }
      return payload;
    });

    // -------------------------------------------------------------
    // 8. 快捷指令入口
    // -------------------------------------------------------------
    ctx.hooks.transform("user.beforeSend", (payload) => {
      const text = (payload.text || "").trim();
      if (["/成长", "/手帐", "/手账", "/规划", "/plan", "成长手帐"].includes(text)) {
        payload.cancelled = true;
        const char = getCharacterForSession(payload.sessionId);
        if (char) {
          openGrowthModal(payload.sessionId, char);
        } else {
          ctx.ui.toast("未能定位到当前角色");
        }
      }
      return payload;
    });

    // -------------------------------------------------------------
    // 9. 消息长按菜单入口
    // -------------------------------------------------------------
    ctx.ui.messageAction({
      id: "open-growth-ledger",
      label: "🌱 打开角色成长手帐",
      onSelect: (msg, helpers) => {
        const char = getCharacterForSession(msg.sessionId);
        if (char) {
          openGrowthModal(msg.sessionId, char);
        } else {
          helpers.toast("未能定位当前角色");
        }
      },
    });

    // -------------------------------------------------------------
    // 10. 模态手帐看板 UI 构建 (openModal)
    // -------------------------------------------------------------
    function openGrowthModal(sessionId, char, initialPlan) {
      if (!char) {
        ctx.ui.toast("未选择有效角色");
        return;
      }

      ctx.ui.openModal((container, { close }) => {
        let currentPlan = initialPlan || getPlan(char.id);
        let confirmRegen = false;

        function render() {
          container.innerHTML = "";
          const modalEl = document.createElement("div");
          modalEl.className = "cgp-modal";

          if (!currentPlan) {
            modalEl.innerHTML = `
              <div class="cgp-header">
                <div class="cgp-title-wrap">
                  <h3 class="cgp-main-title">🌱 ${escapeHtml(char.name)} 的成长手帐</h3>
                </div>
                <button class="cgp-close-btn" id="cgp-btn-close">✕</button>
              </div>
              <div class="cgp-empty-view">
                <div class="cgp-empty-icon">📖</div>
                <div class="cgp-empty-title">尚未制定生活规划</div>
                <div class="cgp-empty-desc">
                  为 ${escapeHtml(char.name)} 制定生活规划与目标，TA 在日常手机聊天中会自然带着这些目标与你交流。
                </div>
                <button class="cgp-btn cgp-btn-primary" id="cgp-btn-generate">
                  ✨ 让 AI 结合人设制定规划
                </button>
              </div>
            `;

            modalEl.querySelector("#cgp-btn-close").onclick = close;
            modalEl.querySelector("#cgp-btn-generate").onclick = async () => {
              const newPlan = await generatePlanWithAI(char);
              if (newPlan) {
                currentPlan = newPlan;
                render(); // 只刷新手帐展示新规划，绝不自动乱发消息！
              }
            };
          } else {
            const curIdx = currentPlan.currentStageIndex || 0;
            const curStage = currentPlan.stages[curIdx] || { title: "已达成", desc: "", tasks: [] };
            const progress = currentPlan.currentStageProgress || 0;

            modalEl.innerHTML = `
              <div class="cgp-header">
                <div class="cgp-title-wrap">
                  <h3 class="cgp-main-title">🌱 ${escapeHtml(char.name)} 的成长手帐</h3>
                  <span class="cgp-tag">${escapeHtml(currentPlan.category || "生活目标")}</span>
                </div>
                <button class="cgp-close-btn" id="cgp-btn-close">✕</button>
              </div>

              <!-- 核心愿景卡 -->
              <div class="cgp-vision-card">
                <div class="cgp-vision-label">Core Vision · 核心长期愿景</div>
                <div class="cgp-vision-text">${escapeHtml(currentPlan.coreVision)}</div>
              </div>

              <!-- 阶段核心卡片 -->
              <div class="cgp-stage-card">
                <div class="cgp-stage-top">
                  <span class="cgp-stage-badge">阶段 ${curIdx + 1} / ${currentPlan.stages.length}</span>
                  <span class="cgp-stage-pct">${progress}%</span>
                </div>
                <div class="cgp-progress-track">
                  <div class="cgp-progress-fill" style="width: ${progress}%;"></div>
                </div>
                <div class="cgp-stage-title">${escapeHtml(curStage.title)}</div>
                <div class="cgp-stage-desc">${escapeHtml(curStage.desc)}</div>

                <!-- 待执行行动清单 -->
                <div class="cgp-tasks-box" id="cgp-tasks-container"></div>

                <!-- 当前近况与心绪 -->
                <div class="cgp-mindset-box">
                  <strong>💬 当前生活近况：</strong>${escapeHtml(currentPlan.currentMindset || "正在踏实进行中")}
                </div>

                <!-- 交互动作栏 -->
                <div class="cgp-actions-row">
                  <button class="cgp-btn cgp-btn-msg" id="cgp-btn-send-msg" title="让角色用手机发一条消息找你">
                    💬 让TA主动发条消息
                  </button>
                  <button class="cgp-btn cgp-btn-primary" id="cgp-btn-advance">
                    💪 陪伴打卡 (+${ctx.system.settings.get("advanceStep") || 10}%)
                  </button>
                  <button class="cgp-btn cgp-btn-secondary" id="cgp-btn-stage-done">
                    🎉 本阶段完成
                  </button>
                </div>
              </div>

              <!-- 成长时光印记 -->
              <div class="cgp-timeline">
                <div class="cgp-section-title">
                  <span>⏳ 成长时光印记 (${(currentPlan.growthLogs || []).length})</span>
                </div>
                <div class="cgp-log-list" id="cgp-log-list"></div>
              </div>

              <!-- 底部操作栏 -->
              <div class="cgp-actions-row" style="margin-top: 18px; justify-content: space-between;">
                <button class="cgp-btn ${confirmRegen ? "cgp-btn-warning" : "cgp-btn-ghost"}" id="cgp-btn-regenerate">
                  ${confirmRegen ? "⚠️ 确定覆盖？点此开始推演" : "🔄 重新推演规划"}
                </button>
                <button class="cgp-btn cgp-btn-secondary" id="cgp-btn-close-bottom">
                  完成并返回
                </button>
              </div>
            `;

            modalEl.querySelector("#cgp-btn-close").onclick = close;
            modalEl.querySelector("#cgp-btn-close-bottom").onclick = close;

            // 让TA发条消息（纯真人微信消息，绝无多余动作描写）
            modalEl.querySelector("#cgp-btn-send-msg").onclick = async () => {
              close();
              await sendProactiveChatMessage(sessionId, char, currentPlan);
            };

            // 渲染子任务列表（支持点击打勾、✏️修改目标、添加大跨度目标）
            const tasksBox = modalEl.querySelector("#cgp-tasks-container");
            tasksBox.innerHTML = "";
            if (!curStage.tasks) curStage.tasks = [];

            curStage.tasks.forEach((task) => {
              const item = document.createElement("div");
              item.className = `cgp-task-item ${task.done ? "done" : ""}`;
              item.innerHTML = `
                <input type="checkbox" class="cgp-task-checkbox" ${task.done ? "checked" : ""} />
                <span class="cgp-task-text" title="点击勾选或取消">${escapeHtml(task.text)}</span>
                <span class="cgp-task-edit-btn" title="修改此目标">✏️</span>
              `;

              const toggleAction = () => {
                task.done = !task.done;
                const totalCount = curStage.tasks.length || 1;
                const doneCount = curStage.tasks.filter((t) => t.done).length;
                const targetPct = Math.round((doneCount / totalCount) * 100);

                // 进度与用户人工打勾强绑定
                currentPlan.currentStageProgress = targetPct;

                const now = new Date();
                const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                if (!currentPlan.growthLogs) currentPlan.growthLogs = [];

                if (task.done) {
                  currentPlan.growthLogs.unshift({
                    time: timeStr,
                    text: `✅ 手动确认达成目标：${task.text.slice(0, 16)}`,
                    type: "manual",
                  });
                  ctx.ui.toast(`✅ 已确认达成：${task.text.slice(0, 12)}`);
                } else {
                  currentPlan.growthLogs.unshift({
                    time: timeStr,
                    text: `↩️ 取消目标达成：${task.text.slice(0, 16)}`,
                    type: "manual",
                  });
                  ctx.ui.toast(`↩️ 已取消达成：${task.text.slice(0, 12)}`);
                }

                if (doneCount === totalCount && totalCount > 0) {
                  ctx.ui.toast(`🎉 本阶段所有大目标已由您手动确认全部达成！`);
                }

                savePlan(char.id, currentPlan);
                render();
              };

              item.querySelector(".cgp-task-checkbox").onclick = (e) => {
                e.stopPropagation();
                toggleAction();
              };
              item.querySelector(".cgp-task-text").onclick = (e) => {
                e.stopPropagation();
                toggleAction();
              };

              item.querySelector(".cgp-task-edit-btn").onclick = (e) => {
                e.stopPropagation();
                const newText = prompt("修改该大跨度目标：", task.text);
                if (newText && newText.trim() && newText.trim() !== task.text) {
                  task.text = newText.trim();
                  savePlan(char.id, currentPlan);
                  render();
                }
              };

              tasksBox.appendChild(item);
            });

            // 添加新目标按钮
            const addBtn = document.createElement("button");
            addBtn.className = "cgp-add-task-btn";
            addBtn.textContent = "＋ 添加大跨度目标";
            addBtn.onclick = () => {
              const text = prompt("请输入新的大跨度目标：");
              if (text && text.trim()) {
                curStage.tasks.push({ text: text.trim(), done: false });
                savePlan(char.id, currentPlan);
                render();
              }
            };
            tasksBox.appendChild(addBtn);

            // 渲染时光轴
            const logBox = modalEl.querySelector("#cgp-log-list");
            const logs = currentPlan.growthLogs || [];
            if (logs.length === 0) {
              logBox.innerHTML = `<div style="font-size:12px;color:#94a3b8;padding:8px;">暂无记录，和TA聊聊天吧~</div>`;
            } else {
              logs.forEach((log) => {
                const item = document.createElement("div");
                item.className = "cgp-log-item";
                item.innerHTML = `
                  <span>${escapeHtml(log.text)}</span>
                  <span class="cgp-log-time">${escapeHtml(log.time)}</span>
                `;
                logBox.appendChild(item);
              });
            }

            modalEl.querySelector("#cgp-btn-advance").onclick = () => {
              const step = Number(ctx.system.settings.get("advanceStep")) || 10;
              advancePlanProgress(char.id, currentPlan, step, "陪伴打卡与日常鼓励", "manual");
              render();
            };

            modalEl.querySelector("#cgp-btn-stage-done").onclick = () => {
              advancePlanProgress(char.id, currentPlan, 100, "手动达成阶段目标", "manual");
              render();
            };

            const regenBtn = modalEl.querySelector("#cgp-btn-regenerate");
            regenBtn.onclick = async () => {
              if (!confirmRegen) {
                confirmRegen = true;
                render();
                setTimeout(() => {
                  if (confirmRegen) {
                    confirmRegen = false;
                    render();
                  }
                }, 5000);
              } else {
                regenBtn.disabled = true;
                regenBtn.textContent = "⏳ 正在推演新规划...";
                const newPlan = await generatePlanWithAI(char);
                if (newPlan) {
                  currentPlan = newPlan;
                  confirmRegen = false;
                  render(); // 仅刷新手帐展示新规划，绝不自动偷发消息！
                } else {
                  confirmRegen = false;
                  render();
                }
              }
            };
          }

          container.appendChild(modalEl);
        }

        render();
      });
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // -------------------------------------------------------------
    // 11. UI 槽位挂载
    // -------------------------------------------------------------
    const activeHeaderMounts = new Set();

    function refreshMountedViews() {
      activeHeaderMounts.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          /* ignore */
        }
      });
    }

    ctx.ui.slot("chat.header", (el, props) => {
      if (props.isGroup || !props.sessionId) {
        el.innerHTML = "";
        return;
      }
      if (ctx.system.settings.get("showBadge") === false) {
        el.innerHTML = "";
        return;
      }

      function renderBadge() {
        el.innerHTML = "";
        const char = getCharacterForSession(props.sessionId);
        const plan = char ? getPlan(char.id) : null;

        const wrap = document.createElement("div");
        wrap.className = "cgp-header-wrap";

        const pill = document.createElement("div");
        pill.className = "cgp-pill";

        if (!plan) {
          pill.innerHTML = `
            <span class="cgp-pill-icon">🌱</span>
            <span class="cgp-pill-title">${char ? escapeHtml(char.name) : "角色"}成长手帐</span>
            <span class="cgp-pill-stage">点击一键开启人生规划</span>
            <span style="opacity:0.6;font-size:11px;">›</span>
          `;
        } else {
          const curIdx = plan.currentStageIndex || 0;
          const stage = plan.stages[curIdx] || { title: "已圆满" };
          const pct = plan.currentStageProgress || 0;

          pill.innerHTML = `
            <span class="cgp-pill-icon">🌱</span>
            <span class="cgp-pill-title">${escapeHtml(plan.category || "规划")}</span>
            <span class="cgp-pill-stage">${escapeHtml(stage.title)}</span>
            <div class="cgp-pill-bar-box">
              <div class="cgp-pill-bar-fill" style="width: ${pct}%;"></div>
            </div>
            <span class="cgp-pill-pct">${pct}%</span>
            <span style="opacity:0.6;font-size:11px;">›</span>
          `;
        }

        pill.onclick = () => {
          const targetChar = char || getCharacterForSession(props.sessionId);
          if (targetChar) {
            openGrowthModal(props.sessionId, targetChar, plan);
          } else {
            ctx.ui.toast("未能定位角色，请从聊天列表中重新进入。");
          }
        };

        wrap.appendChild(pill);
        el.appendChild(wrap);
      }

      renderBadge();
      activeHeaderMounts.add(renderBadge);

      return () => {
        activeHeaderMounts.delete(renderBadge);
        el.innerHTML = "";
      };
    });

    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      el.innerHTML = "";
      const item = document.createElement("div");
      item.className = "cgp-toolbar-item";
      item.innerHTML = `<span>🌱</span><span>角色成长手帐</span>`;
      item.onclick = () => {
        const char = getCharacterForSession(props.sessionId);
        if (char) {
          openGrowthModal(props.sessionId, char);
        } else {
          const chars = ctx.data.characters.list() || [];
          if (chars.length > 0) openGrowthModal(props.sessionId, chars[0]);
          else ctx.ui.toast("请先创建一个角色");
        }
      };
      el.appendChild(item);
      return () => {
        el.innerHTML = "";
      };
    });
  },
};
