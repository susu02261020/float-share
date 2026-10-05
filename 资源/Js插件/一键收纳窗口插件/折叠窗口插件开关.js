export default {
  manifest: {
    id: "ui-fold-helper",
    name: "UI 折叠助手（收纳插件按钮）",
    apiVersion: 1,
    version: "1.0.0",
    author: "Float小助手",
    description: "一键折叠聊天头部所有其他插件的按钮，还你清爽界面。",
  },
  setup(ctx) {
    let isFolded = false;
    let observer = null;

    // 折叠/展开的核心逻辑
    function applyFoldState(containerEl) {
      if (!containerEl) return;
      for (let child of containerEl.children) {
        // 跳过我们自己的容器
        if (child.id === "fold-toggle-container") continue;
        
        // 只隐藏按钮，或者包含按钮的div，避免误伤其他排版元素
        if (child.tagName === "BUTTON" || (child.tagName === "DIV" && child.querySelector("button"))) {
          child.style.display = isFolded ? "none" : "";
        }
      }
    }

    ctx.ui.slot("chat.header", (el, props) => {
      el.id = "fold-toggle-container";
      el.style.cssText = "display: inline-flex; align-items: center;";

      const btn = document.createElement("button");
      btn.style.cssText = "font-family:-apple-system,sans-serif; font-size:10px; padding:4px 10px; border-radius:4px; background:#f0f0f0; border:1px solid #ccc; color:#333; cursor:pointer; margin:4px; z-index: 100; position: relative; transition: all 0.2s;";

      const updateBtnText = () => {
         btn.innerHTML = isFolded ? "🔽 展开其他" : "🔼 收起其他";
         btn.style.background = isFolded ? "#e8f5e9" : "#f0f0f0";
         btn.style.borderColor = isFolded ? "#2e7d32" : "#ccc";
         btn.style.color = isFolded ? "#2e7d32" : "#333";
      };
      
      updateBtnText();

      btn.onclick = () => {
        isFolded = !isFolded;
        updateBtnText();
        applyFoldState(el.parentNode);
        ctx.ui.toast(isFolded ? "已收起其他插件按钮" : "已展开所有按钮");
      };

      el.appendChild(btn);

      // 延迟一下，等别的插件加载完
      setTimeout(() => { applyFoldState(el.parentNode); }, 500);

      // 监听 DOM 变化（防止其他插件晚加载或页面刷新导致折叠状态失效）
      try {
         observer = new MutationObserver(() => {
            if (isFolded && el.parentNode) {
               applyFoldState(el.parentNode);
            }
         });
         observer.observe(el.parentNode, { childList: true });
      } catch(e){}

      return () => {
         if (observer) observer.disconnect();
      };
    });
  }
};