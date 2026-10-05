export default {
  manifest: {
    id: "online-to-offline-toggle",
    name: "线上转线下（一键切换）",
    apiVersion: 1,
    version: "1.0.0",
    author: "Float小助手",
    description: "在线上聊天框直接一键开启线下模式，注入场景描写指令，让角色立刻变成面对面互动！",
    settings: [
      { 
        key: "offlinePrompt", 
        label: "线下模式自定义指令（可自行修改）", 
        type: "text", 
        default: "【系统指令：线下模式已开启】\n你与用户现在处于现实面对面状态。请完全以线下互动的模式回复。你的回复中必须包含动作描写（用括号（）包裹），描写具体的神态、肢体接触、环境音和周围氛围，像真实的约会一样推进互动。" 
      }
    ],
  },
  setup(ctx) {
    // 注册聊天界面的头部按钮
    ctx.ui.slot("chat.header", (el, props) => {
      const sessionId = props.sessionId;
      if (!sessionId) return;

      // 读取当前会话的线下模式状态
      let isOffline = ctx.system.storage.get(`offline_${sessionId}`) || false;

      // 创建按钮
      const btn = document.createElement("button");
      btn.style.cssText = "font-family:-apple-system,sans-serif; font-size:10px; letter-spacing:0.06em; padding:3px 8px; border-radius:4px; background:transparent; border:1px solid rgba(0,0,0,0.15); color:inherit; cursor:pointer; margin:4px; opacity:0.75; transition: all 0.2s;";
      
      const updateButtonStyle = () => {
        if (isOffline) {
          btn.innerHTML = `🌐 切回线上`;
          btn.style.backgroundColor = "#e8f5e9";
          btn.style.borderColor = "#2e7d32";
          btn.style.color = "#2e7d32";
        } else {
          btn.innerHTML = `🏠 开启线下`;
          btn.style.backgroundColor = "transparent";
          btn.style.borderColor = "rgba(0,0,0,0.15)";
          btn.style.color = "inherit";
        }
      };

      // 初始化按钮状态
      updateButtonStyle();

      // 点击事件
      btn.onclick = () => {
        isOffline = !isOffline;
        ctx.system.storage.set(`offline_${sessionId}`, isOffline); // 保存状态

        if (isOffline) {
          // 开启线下模式
          const customPrompt = ctx.system.settings.get("offlinePrompt");
          ctx.prompts.set(customPrompt, { sessionId: sessionId });
          ctx.ui.toast("已开启线下模式，你可以直接发送动作或对话啦~");
          
          // 发一条系统消息作为视觉提示（可选）
          try {
            ctx.data.messages.push({
              sessionId: sessionId,
              role: "system",
              content: "--- 已进入线下模式 ---"
            });
          } catch (e) {}
        } else {
          // 切回线上模式
          ctx.prompts.set("", { sessionId: sessionId }); // 清除提示词
          ctx.ui.toast("已切回线上模式");
          
          try {
            ctx.data.messages.push({
              sessionId: sessionId,
              role: "system",
              content: "--- 已切回线上模式 ---"
            });
          } catch (e) {}
        }

        updateButtonStyle();
      };

      el.appendChild(btn);
    });
  },
};