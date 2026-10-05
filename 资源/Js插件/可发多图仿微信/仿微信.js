export default {
  manifest: {
    id: "image-carousel",
    name: "图片轮播",
    apiVersion: 1,
    version: "6.3.1",
    author: "你",
    description: "多选发图合并为微信风格轮播，沉浸式全屏大图浏览，支持左右滑动、双指缩放、双击放大、下滑关闭",
    permissions: ["chat.read", "chat.write"],
    settings: [
      { key: "loop", label: "循环滚动（首尾相连）", type: "boolean", default: false },
      {
        key: "indicator",
        label: "页码指示器",
        type: "select",
        default: "dots",
        options: [
          { value: "dots", label: "底部圆点" },
          { value: "counter", label: "右上角 3/9" },
          { value: "none", label: "不显示" },
        ],
      },
      { key: "minImages", label: "触发轮播最少图片数", type: "number", default: 2 },
    ],
  },

  setup(ctx) {
    /* ============================================================
     *  样式注入
     * ============================================================ */
    ctx.ui.injectCSS(`
      /* —— 微信堆叠式多图预览 —— */
      .ic-stack{position:relative;height:220px;user-select:none;-webkit-user-select:none;touch-action:none;display:flex;align-items:center;gap:8px;overflow:visible;}
      .ic-stack-btn{flex-shrink:0;background:rgba(255,255,255,.1);color:rgba(255,255,255,.55);font-size:12px;padding:5px 11px;border-radius:16px;cursor:pointer;backdrop-filter:blur(4px);font-family:system-ui,sans-serif;white-space:nowrap;z-index:5;}
      .ic-stack-btn:active{background:rgba(255,255,255,.18);}
      .ic-stack-cards{position:relative;width:170px;height:220px;flex-shrink:0;z-index:1;}
      .ic-stack-card{position:absolute;top:0;left:0;width:170px;height:220px;border-radius:14px;overflow:hidden;background:#2a2a2a;box-shadow:0 4px 20px rgba(0,0,0,.4);will-change:transform;transform-origin:left center;}
      .ic-stack-card img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;-webkit-user-drag:none;}
      /* 展开模式：竖排一张张来 */
      .ic-stack-cards.expanded{width:170px;height:auto;display:flex;flex-direction:column;gap:8px;align-items:flex-end;touch-action:auto !important;}
      .ic-stack-cards.expanded .ic-stack-card{position:relative;top:auto;right:auto;width:170px;height:220px;flex-shrink:0;transform:none!important;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;border-radius:12px;}
      /* —— 输入栏按钮 —— */
      .ic-toolbar-btn{display:inline-flex;flex-direction:column;align-items:center;gap:5px;padding:8px 14px;border:none;background:transparent;cursor:pointer;border-radius:10px;font-size:11px;color:#555;transition:background .15s;}
      .ic-toolbar-btn:hover{background:rgba(0,0,0,.06);}
      .ic-toolbar-icon{width:36px;height:36px;border-radius:10px;background:#f2f2f2;display:flex;align-items:center;justify-content:center;}
      .ic-toolbar-icon svg{width:20px;height:20px;stroke:#555;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
      .ic-footer-carousel{margin-top:1px;}
      .ic-footer-carousel.user{display:flex;justify-content:flex-end;padding-right:52px;}
      .ic-footer-carousel.assistant{display:flex;justify-content:flex-start;}

      /* —— 微信风格全屏大图浏览器 —— */
      .wx-overlay{position:fixed;inset:0;background:#000;z-index:100000;overflow:hidden;-webkit-tap-highlight-color:transparent;}
      .wx-viewport{position:absolute;inset:0;overflow:hidden;touch-action:none;}
      .wx-track{display:flex;height:100%;will-change:transform;}
      .wx-slide{flex:0 0 100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;}
      .wx-img{max-width:86%;max-height:80%;object-fit:contain;will-change:transform;user-select:none;-webkit-user-drag:none;pointer-events:none;box-shadow:0 8px 40px rgba(0,0,0,.5);}
      .wx-counter{position:absolute;top:18px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.88);font-size:15px;z-index:100001;font-family:system-ui,sans-serif;font-weight:400;letter-spacing:.5px;pointer-events:none;}
      .wx-close{position:absolute;top:14px;right:14px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.12);color:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;z-index:100001;line-height:1;backdrop-filter:blur(8px);}
      .wx-close:active{background:rgba(255,255,255,.25);}
    `);

    /* ============================================================
     *  全局状态
     * ============================================================ */
    let currentSessionId = null;
    let pendingCarousel = null; // { sessionId, images }  绑定会话，防止串台
    const carouselBySession = {}; // sessionId -> { images, timestamp }  footer 兜底用

    ctx.hooks.on("session.opened", ({ sessionId }) => {
      if (sessionId) currentSessionId = sessionId;
    });
    ctx.ui.slot("chat.header", (el, props) => {
      if (props.sessionId) currentSessionId = props.sessionId;
    });

    /* ============================================================
     *  工具函数
     * ============================================================ */
    function readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function compressImage(file, maxSize = 1600, quality = 0.88) {
      return new Promise(async (resolve) => {
        try {
          const dataURL = await readFileAsDataURL(file);
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
            if (width > maxSize || height > maxSize) {
              if (width > height) { height = Math.round((height * maxSize) / width); width = maxSize; }
              else { width = Math.round((width * maxSize) / height); height = maxSize; }
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const c = canvas.getContext("2d");
            c.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          };
          img.onerror = () => resolve(dataURL);
          img.src = dataURL;
        } catch { resolve(readFileAsDataURL(file)); }
      });
    }

    /* ============================================================
     *  DOM 操作：触发聊天输入框发送（严格排除搜索框）
     * ============================================================ */
    function isVisible(el) {
      return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    function isSearchEl(el) {
      if (!el) return false;
      const type = (el.type || "").toLowerCase();
      if (type === "search") return true;
      const ph = (el.placeholder || "").toLowerCase();
      if (/搜索|search|查找|find|筛选|filter|query|搜一搜/i.test(ph)) return true;
      const cls = (el.className || "").toString().toLowerCase();
      if (/search|filter|query|find/i.test(cls)) return true;
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i++) {
        const pcls = (p.className || "").toString().toLowerCase();
        const prole = (p.getAttribute && p.getAttribute("role")) || "";
        if (/search|filter|query|find/i.test(pcls)) return true;
        if (prole === "search") return true;
        p = p.parentElement;
      }
      return false;
    }

    function findChatInput() {
      const vh = window.innerHeight;
      const candidates = [];
      document.querySelectorAll("textarea").forEach((el) => {
        if (isVisible(el) && !isSearchEl(el)) candidates.push({ el, priority: 0 });
      });
      document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
        if (isVisible(el) && !isSearchEl(el)) candidates.push({ el, priority: 1 });
      });
      document.querySelectorAll('input[type="text"], input:not([type])').forEach((el) => {
        if (isVisible(el) && !isSearchEl(el)) candidates.push({ el, priority: 2 });
      });
      if (!candidates.length) return null;
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const ra = a.el.getBoundingClientRect();
        const rb = b.el.getBoundingClientRect();
        return rb.top - ra.top;
      });
      for (const c of candidates) {
        const r = c.el.getBoundingClientRect();
        if (r.top > vh * 0.4) return c.el;
      }
      return candidates[0].el;
    }

    function fillInput(el, text) {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    function findSendButtonNear(input) {
      let container = input.closest('form, [class*="input"], [class*="chat"], [class*="send"], [class*="composer"], [class*="toolbar"]');
      if (container) {
        const btns = container.querySelectorAll("button, [role='button'], [class*='send'], [class*='submit']");
        for (const btn of btns) {
          if (!isVisible(btn) || isSearchEl(btn)) continue;
          const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
          if (/发送|Send|send/i.test(text)) return btn;
        }
      }
      return null;
    }

    function triggerSend(text) {
      const input = findChatInput();
      if (!input) {
        ctx.system.log("carousel: no chat input found");
        return false;
      }
      ctx.system.log("carousel: found input:", input.tagName, "class=", input.className, "ph=", input.placeholder);
      fillInput(input, text);
      const val = input.value || input.textContent || "";
      if (!val.includes(text)) {
        ctx.system.log("carousel: fill failed, value=", val);
        return false;
      }
      const sendBtn = findSendButtonNear(input);
      if (sendBtn) {
        ctx.system.log("carousel: clicking send button");
        sendBtn.click();
        return true;
      }
      ctx.system.log("carousel: no send button, simulating Enter");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      return true;
    }

    /* ============================================================
     *  微信风格全屏大图浏览器
     * ============================================================ */
    function openWechatViewer(images, startIndex, thumbEl) {
      const W = window.innerWidth;
      const H = window.innerHeight;
      let currentIndex = startIndex;
      let trackX = -startIndex * W;
      const slides = [];

      const overlay = document.createElement("div");
      overlay.className = "wx-overlay";

      const viewport = document.createElement("div");
      viewport.className = "wx-viewport";

      const track = document.createElement("div");
      track.className = "wx-track";

      images.forEach((src) => {
        const slide = document.createElement("div");
        slide.className = "wx-slide";
        const img = document.createElement("img");
        img.src = src.dataURL || src;
        img.className = "wx-img";
        img.draggable = false;
        slide.appendChild(img);
        track.appendChild(slide);
        slides.push({ el: slide, img, scale: 1, tx: 0, ty: 0 });
      });

      viewport.appendChild(track);
      overlay.appendChild(viewport);

      const counter = document.createElement("div");
      counter.className = "wx-counter";
      counter.textContent = `${startIndex + 1} / ${images.length}`;
      overlay.appendChild(counter);

      const closeBtn = document.createElement("div");
      closeBtn.className = "wx-close";
      closeBtn.textContent = "×";
      overlay.appendChild(closeBtn);

      document.body.appendChild(overlay);
      track.style.transform = `translateX(${trackX}px)`;

      let fromRect = null;
      if (thumbEl) {
        try { fromRect = thumbEl.getBoundingClientRect(); } catch (_) {}
      }

      if (fromRect && fromRect.width > 0) {
        const s = slides[currentIndex];
        const scale = Math.min(fromRect.width / W, fromRect.height / H, 1);
        const tx = fromRect.left + fromRect.width / 2 - W / 2;
        const ty = fromRect.top + fromRect.height / 2 - H / 2;
        s.scale = scale; s.tx = tx; s.ty = ty;
        s.img.style.transition = "none";
        applySlide(currentIndex);
        overlay.style.background = "rgba(0,0,0,0)";
        void overlay.offsetWidth;
        requestAnimationFrame(() => {
          s.img.style.transition = "transform .28s cubic-bezier(.32,.72,0,1)";
          s.scale = 1; s.tx = 0; s.ty = 0;
          applySlide(currentIndex);
          overlay.style.transition = "background .28s ease";
          overlay.style.background = "#000";
        });
      }

      function applySlide(i) {
        const s = slides[i];
        s.img.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
      }

      function updateCounter() {
        counter.textContent = `${currentIndex + 1} / ${images.length}`;
      }

      function goTo(index, animate = true) {
        currentIndex = Math.max(0, Math.min(images.length - 1, index));
        trackX = -currentIndex * W;
        track.style.transition = animate ? "transform .3s cubic-bezier(.32,.72,0,1)" : "none";
        track.style.transform = `translateX(${trackX}px)`;
        updateCounter();
      }

      function resetSlide(i) {
        const s = slides[i];
        s.scale = 1; s.tx = 0; s.ty = 0;
        s.img.style.transition = "transform .25s ease";
        applySlide(i);
      }

      function close() {
        if (fromRect && fromRect.width > 0) {
          const s = slides[currentIndex];
          s.img.style.transition = "transform .25s cubic-bezier(.32,.72,0,1)";
          const scale = Math.min(fromRect.width / W, fromRect.height / H, 1);
          const tx = fromRect.left + fromRect.width / 2 - W / 2;
          const ty = fromRect.top + fromRect.height / 2 - H / 2;
          s.scale = scale; s.tx = tx; s.ty = ty;
          applySlide(currentIndex);
          overlay.style.transition = "background .25s ease";
          overlay.style.background = "rgba(0,0,0,0)";
          setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 260);
        } else {
          overlay.style.transition = "opacity .2s";
          overlay.style.opacity = "0";
          setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
        }
        window.removeEventListener("keydown", onKey);
      }

      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });

      let mode = null;
      let sx = 0, sy = 0, st = 0;
      let pinchDist = 0, pinchScale = 1;
      let dragTx = 0, dragTy = 0;
      let lastTap = 0, lastTapX = 0, lastTapY = 0;
      let tapTimer = null;

      function dist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

      viewport.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          mode = "pinch";
          pinchDist = dist(e.touches[0], e.touches[1]);
          pinchScale = slides[currentIndex].scale;
        } else if (e.touches.length === 1) {
          sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
          if (slides[currentIndex].scale > 1.01) {
            mode = "drag";
            dragTx = slides[currentIndex].tx;
            dragTy = slides[currentIndex].ty;
          } else {
            mode = null;
          }
        }
      }, { passive: true });

      viewport.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && mode === "pinch") {
          e.preventDefault();
          const d = dist(e.touches[0], e.touches[1]);
          const s = slides[currentIndex];
          s.scale = Math.max(1, Math.min(4, pinchScale * (d / pinchDist)));
          s.img.style.transition = "none";
          applySlide(currentIndex);
        } else if (e.touches.length === 1) {
          const dx = e.touches[0].clientX - sx;
          const dy = e.touches[0].clientY - sy;

          if (mode === null) {
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
              mode = Math.abs(dx) > Math.abs(dy) ? "pan-x" : "pan-y";
            }
          }

          if (mode === "drag") {
            const s = slides[currentIndex];
            const maxX = (s.scale - 1) * W / 2;
            const maxY = (s.scale - 1) * H / 2;
            s.tx = Math.max(-maxX, Math.min(maxX, dragTx + dx));
            s.ty = Math.max(-maxY, Math.min(maxY, dragTy + dy));
            s.img.style.transition = "none";
            applySlide(currentIndex);
          } else if (mode === "pan-x") {
            e.preventDefault();
            let nx = trackX + dx;
            if (currentIndex === 0 && dx < 0) nx = trackX + dx * 0.3;
            if (currentIndex === images.length - 1 && dx > 0) nx = trackX + dx * 0.3;
            track.style.transition = "none";
            track.style.transform = `translateX(${nx}px)`;
          } else if (mode === "pan-y") {
            e.preventDefault();
            const s = slides[currentIndex];
            const progress = Math.min(1, Math.abs(dy) / (H * 0.6));
            s.ty = dy;
            s.scale = Math.max(0.5, 1 - progress * 0.4);
            s.img.style.transition = "none";
            applySlide(currentIndex);
            overlay.style.background = `rgba(0,0,0,${Math.max(0, 1 - progress)})`;
          }
        }
      }, { passive: false });

      viewport.addEventListener("touchend", (e) => {
        const ex = e.changedTouches[0].clientX;
        const ey = e.changedTouches[0].clientY;
        const dx = ex - sx, dy = ey - sy;
        const dt = Date.now() - st;
        const vel = Math.abs(dx) / Math.max(1, dt);

        if (mode === "pan-x") {
          if (Math.abs(dx) > W * 0.22 || vel > 0.5) {
            goTo(currentIndex + (dx < 0 ? 1 : -1));
          } else {
            goTo(currentIndex);
          }
        } else if (mode === "pan-y") {
          if (dy > 80 || (dy > 20 && dt < 250)) {
            close();
          } else {
            resetSlide(currentIndex);
            overlay.style.transition = "background .25s ease";
            overlay.style.background = "#000";
          }
        } else if (mode === "pinch") {
          const s = slides[currentIndex];
          if (s.scale < 1.01) { resetSlide(currentIndex); }
        } else if (mode === null) {
          handleTap(ex, ey);
        }
        mode = null;
      });

      function handleTap(x, y) {
        const now = Date.now();
        if (now - lastTap < 280 && Math.abs(x - lastTapX) < 24 && Math.abs(y - lastTapY) < 24) {
          clearTimeout(tapTimer);
          lastTap = 0;
          const s = slides[currentIndex];
          s.img.style.transition = "transform .25s cubic-bezier(.32,.72,0,1)";
          if (s.scale > 1.01) {
            s.scale = 1; s.tx = 0; s.ty = 0;
          } else {
            s.scale = 2.2;
            s.tx = (W / 2 - x) * 1.2;
            s.ty = (H / 2 - y) * 1.2;
            const maxX = (s.scale - 1) * W / 2;
            const maxY = (s.scale - 1) * H / 2;
            s.tx = Math.max(-maxX, Math.min(maxX, s.tx));
            s.ty = Math.max(-maxY, Math.min(maxY, s.ty));
          }
          applySlide(currentIndex);
        } else {
          lastTap = now; lastTapX = x; lastTapY = y;
          tapTimer = setTimeout(() => { close(); }, 290);
        }
      }

      let mouseDown = false, mouseSX = 0, mouseSY = 0, mouseST = 0, mouseMode = null;
      viewport.addEventListener("mousedown", (e) => {
        mouseDown = true; mouseSX = e.clientX; mouseSY = e.clientY; mouseST = Date.now();
        mouseMode = slides[currentIndex].scale > 1.01 ? "drag" : null;
        if (mouseMode === "drag") { dragTx = slides[currentIndex].tx; dragTy = slides[currentIndex].ty; }
      });
      window.addEventListener("mousemove", (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - mouseSX, dy = e.clientY - mouseSY;
        if (mouseMode === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          mouseMode = Math.abs(dx) > Math.abs(dy) ? "pan-x" : "pan-y";
        }
        if (mouseMode === "drag") {
          const s = slides[currentIndex];
          const maxX = (s.scale - 1) * W / 2, maxY = (s.scale - 1) * H / 2;
          s.tx = Math.max(-maxX, Math.min(maxX, dragTx + dx));
          s.ty = Math.max(-maxY, Math.min(maxY, dragTy + dy));
          s.img.style.transition = "none"; applySlide(currentIndex);
        } else if (mouseMode === "pan-x") {
          let nx = trackX + dx;
          if (currentIndex === 0 && dx > 0) nx = trackX + dx * 0.3;
          if (currentIndex === images.length - 1 && dx < 0) nx = trackX + dx * 0.3;
          track.style.transition = "none";
          track.style.transform = `translateX(${nx}px)`;
        } else if (mouseMode === "pan-y") {
          const s = slides[currentIndex];
          const progress = Math.min(1, Math.abs(dy) / (H * 0.6));
          s.ty = dy; s.scale = Math.max(0.5, 1 - progress * 0.4);
          s.img.style.transition = "none"; applySlide(currentIndex);
          overlay.style.background = `rgba(0,0,0,${Math.max(0, 1 - progress)})`;
        }
      });
      window.addEventListener("mouseup", (e) => {
        if (!mouseDown) return;
        mouseDown = false;
        const dx = e.clientX - mouseSX, dy = e.clientY - mouseSY, dt = Date.now() - mouseST;
        if (mouseMode === "pan-x") {
          if (Math.abs(dx) > W * 0.2 || Math.abs(dx) / Math.max(1, dt) > 0.5) goTo(currentIndex + (dx < 0 ? 1 : -1));
          else goTo(currentIndex);
        } else if (mouseMode === "pan-y") {
          if (dy > 80) close();
          else { resetSlide(currentIndex); overlay.style.transition = "background .25s"; overlay.style.background = "#000"; }
        } else if (mouseMode === null && Math.abs(dx) < 6 && Math.abs(dy) < 6 && dt < 300) {
          handleTap(e.clientX, e.clientY);
        }
        mouseMode = null;
      });
      viewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          goTo(currentIndex + (e.deltaX > 0 ? 1 : -1));
        } else {
          goTo(currentIndex + (e.deltaY > 0 ? 1 : -1));
        }
      }, { passive: false });

      function onKey(e) {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowLeft") goTo(currentIndex - 1);
        else if (e.key === "ArrowRight") goTo(currentIndex + 1);
      }
      window.addEventListener("keydown", onKey);
    }

    /* ============================================================
     *  缩略轮播渲染
     * ============================================================ */
    function renderCarouselToEl(el, images) {
      if (!images || !images.length) { el.innerHTML = ""; return; }
      const CARD_W = 170, CARD_H = 220;
      let idx = 0, dragX = 0, dragging = false, expanded = false;
      let startX = 0, startY = 0, startTime = 0, hasMoved = false;

      el.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "ic-stack";

      const btn = document.createElement("div");
      btn.className = "ic-stack-btn";
      btn.textContent = "展开 " + images.length;

      const cardsBox = document.createElement("div");
      cardsBox.className = "ic-stack-cards";

      let cards = [];

      function buildCards() {
        cardsBox.innerHTML = "";
        cards = images.map((d, i) => {
          const card = document.createElement("div");
          card.className = "ic-stack-card";
          const img = document.createElement("img");
          img.src = d.dataURL || d;
          img.alt = "";
          card.appendChild(img);
          if (expanded) {
            card.addEventListener("click", (e) => {
              e.stopPropagation();
              openWechatViewer(images, i, img);
            });
          }
          cardsBox.appendChild(card);
          return card;
        });
      }

      function updateStack(animate = true, offset = 0) {
        cards.forEach((card, i) => {
          const rel = i - idx;
          let x, scale, z, opacity;
          if (Math.abs(rel) > 2) {
            x = rel > 0 ? CARD_W : -CARD_W;
            scale = 0.82; z = 0; opacity = 0;
          } else {
            x = (rel * 18) + offset;
            scale = 1 - Math.abs(rel) * 0.07;
            z = Math.round(10 - Math.abs(rel) * 2);
            opacity = Math.abs(rel) > 2 ? 0 : 1;
          }
          if (Math.abs(rel) > 2) opacity = 0;
          
          if (animate) {
            card.style.transition = "transform .32s cubic-bezier(.25,.8,.35,1), opacity .32s";
          } else {
            card.style.transition = "none";
          }
          card.style.transform = `translateX(${x}px) scale(${scale})`;
          card.style.zIndex = z;
          card.style.opacity = opacity;
        });
      }

      function render() {
        if (expanded) {
          cardsBox.classList.add("expanded");
          wrap.style.height = "auto";
          wrap.style.touchAction = "auto";
          wrap.style.overflowY = "auto";
          cardsBox.style.touchAction = "auto";
          cardsBox.style.overflowY = "auto";
          btn.textContent = "收起";
        } else {
          cardsBox.classList.remove("expanded");
          wrap.style.height = "220px";
          wrap.style.touchAction = "none";
          wrap.style.overflowY = "visible";
          cardsBox.style.touchAction = "pan-y";
          btn.textContent = "展开 " + images.length;
        }
        buildCards();
        if (!expanded) updateStack(false);
        else {
          setTimeout(() => {
            if (cards[0]) cards[0].scrollIntoView({ block: "nearest" });
          }, 50);
        }
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        expanded = !expanded;
        render();
      });

      function openCurrent() {
        openWechatViewer(images, idx, cards[idx] ? cards[idx].querySelector("img") : null);
      }

      wrap.addEventListener("touchstart", (e) => {
        if (expanded) return;
        if (e.target.closest(".ic-stack-btn")) return;
        
        dragging = true;
        hasMoved = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTime = Date.now();
        dragX = 0;
      }, { passive: false });

      wrap.addEventListener("touchmove", (e) => {
        if (!dragging || expanded) return;
        
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        if (!hasMoved) {
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
          if (Math.abs(dy) > Math.abs(dx)) {
            dragging = false;
            return;
          }
          hasMoved = true;
          e.preventDefault();
        }

        e.preventDefault();
        e.stopPropagation();

        let moveX = dx;
        if (idx === 0 && moveX > 0) moveX = 0;
        if (idx === images.length - 1 && moveX < 0) moveX = 0;

        dragX = moveX;
        updateStack(false, moveX);
      }, { passive: false });

      wrap.addEventListener("touchend", (e) => {
        if (!dragging) return;
        dragging = false;
        
        const duration = Date.now() - startTime;
        const finalDx = e.changedTouches[0].clientX - startX;

        if (!hasMoved) {
          openCurrent();
          updateStack(true);
          return;
        }

        const threshold = CARD_W * 0.25;
        const isQuickSwipe = duration < 250 && Math.abs(finalDx) > 20;
        const isDragEnough = Math.abs(finalDx) > threshold;

        if (isDragEnough || isQuickSwipe) {
          if (finalDx < 0) {
            idx = Math.min(images.length - 1, idx + 1);
          } else {
            idx = Math.max(0, idx - 1);
          }
        }
        updateStack(true);
        e.stopPropagation();
      });

      let mDown = false, mSx = 0, mSt = 0;
      wrap.addEventListener("mousedown", (e) => {
        if (expanded) return;
        if (e.target.closest(".ic-stack-btn")) return;
        e.preventDefault(); 
        mDown = true; mSx = e.clientX; mSt = Date.now();
        dragX = 0;
      });
      window.addEventListener("mousemove", (e) => {
        if (!mDown || expanded) return;
        let dx = e.clientX - mSx;
        if (idx === 0 && dx > 0) dx = 0;
        if (idx === images.length - 1 && dx < 0) dx = 0;
        dragX = dx;
        updateStack(false, dx);
      });
      window.addEventListener("mouseup", (e) => {
        if (!mDown) return;
        mDown = false;
        const dt = Date.now() - mSt;
        const dx = dragX;
        
        if (Math.abs(dx) < 8 && dt < 300) {
          openCurrent();
          updateStack(true);
          return;
        }
        
        if (Math.abs(dx) > CARD_W * 0.18 || (Math.abs(dx) > 20 && dt < 250)) {
          if (dx < 0) {
            idx = Math.min(images.length - 1, idx + 1);
          } else {
            idx = Math.max(0, idx - 1);
          }
        }
        updateStack(true);
      });

      wrap.appendChild(btn);
      wrap.appendChild(cardsBox);
      render();
      el.appendChild(wrap);
    }

    /* ============================================================
     *  把轮播图片注入 LLM 请求，让 AI 真正"看到"图片
     * ============================================================ */
    ctx.hooks.transform("llm.request", (payload) => {
      try {
        const sid = payload.sessionId || currentSessionId;
        if (!sid || !payload.messages || !payload.messages.length) return payload;

        const allMsgs = ctx.data.messages.list(sid) || [];

        // 真实消息里，按先后顺序记录每一条 user 消息是否带轮播图片
        const allUserSeq = [];
        for (const m of allMsgs) {
          if (m.role !== "user") continue;
          let imgs = m._carouselImages;
          if (!imgs || !imgs.length) imgs = ctx.system.storage.get("carousel_msg_" + m.id);
          allUserSeq.push(imgs && imgs.length ? imgs : null);
        }

        // 发给 LLM 的 user 消息数量；payload 一般是最近 N 条，取真实序列尾部对齐
        const payloadUserCount = payload.messages.filter((x) => x.role === "user").length;
        const aligned = allUserSeq.slice(-payloadUserCount);

        let injected = 0, uIdx = 0;
        payload.messages = payload.messages.map((msg) => {
          if (msg.role !== "user") return msg;
          const imgs = aligned[uIdx++];
          if (!imgs || !imgs.length) return msg;
          const parts = [{ type: "text", text: "（用户发送了 " + imgs.length + " 张图片，请查看并理解图片内容）" }];
          imgs.forEach((im) => {
            parts.push({ type: "image_url", image_url: { url: im.dataURL || im } });
          });
          injected++;
          return Object.assign({}, msg, { content: parts });
        });

        ctx.system.log(
          "carousel: llm.request diag payloadUser=" + payloadUserCount +
          " storedCarouselUser=" + allUserSeq.filter(Boolean).length +
          " injected=" + injected
        );
        // 诊断：打印 payload 里每条 user 消息正文前 30 个字符，便于核对
        payload.messages.forEach((mm) => {
          if (mm.role !== "user") return;
          let desc;
          if (Array.isArray(mm.content)) desc = "[多模态 " + mm.content.length + " 段]";
          else desc = JSON.stringify(String(mm.content).slice(0, 30));
          ctx.system.log("carousel:   user msg ->", desc);
        });
      } catch (err) {
        ctx.system.log("carousel: llm.request inject error:", err);
      }
      return payload;
    });

    /* ============================================================
     *  拦截用户发送（绑定 sessionId，防串台）
     * ============================================================ */
    ctx.hooks.transform("user.beforeSend", (payload) => {
      if (pendingCarousel && payload.sessionId === pendingCarousel.sessionId) {
        payload.text = "图片";
      }
      return payload;
    });

    ctx.hooks.transform("message.beforePersist", (payload) => {
      const msg = payload.message;
      ctx.system.log("carousel: beforePersist", "role=", msg.role, "sid=", msg.sessionId, "content=", JSON.stringify(msg.content), "id=", msg.id, "pending=", !!pendingCarousel);
      if (pendingCarousel && msg.role === "user" && msg.content === "图片") {
        msg._carouselImages = pendingCarousel.images;
        carouselBySession[msg.sessionId || "default"] = { images: pendingCarousel.images, timestamp: Date.now() };
        if (msg.id) ctx.system.storage.set("carousel_msg_" + msg.id, pendingCarousel.images);
        ctx.system.log("carousel: beforePersist ATTACHED images, hasId=", !!msg.id, "sid=", msg.sessionId);
        pendingCarousel = null;
      }
      return payload;
    });

    ctx.hooks.on("message.persisted", ({ message }) => {
      if (pendingCarousel && message.role === "user" && message.content === "图片") {
        ctx.system.log("carousel: persisted fallback attach, id=", message.id);
        carouselBySession[message.sessionId || "default"] = { images: pendingCarousel.images, timestamp: Date.now() };
        if (message.id) {
          ctx.system.storage.set("carousel_msg_" + message.id, pendingCarousel.images);
          try { ctx.data.messages.update(message.id, { content: "图片" }); } catch (_) {}
        }
        pendingCarousel = null;
      }
    });

    /* ============================================================
     *  message.footer：渲染轮播
     * ============================================================ */
    ctx.ui.slot("message.footer", (el, props) => {
      if (props.sessionId) currentSessionId = props.sessionId;
      const msg = props.message;
      if (!msg || !msg.id) return;

      let images = msg._carouselImages;
      if (!images || !images.length) {
        images = ctx.system.storage.get("carousel_msg_" + msg.id);
      }
      if ((!images || !images.length) && msg.content === "图片" && msg.role === "user") {
        const cached = carouselBySession[msg.sessionId] || carouselBySession["default"];
        if (cached && cached.images && Date.now() - cached.timestamp < 60000) {
          images = cached.images;
          ctx.system.log("carousel: footer used session-cache for msg", msg.id);
        }
      }
      if (!images || !images.length) return;

      ctx.system.log("carousel: footer RENDER msgId=", msg.id, "images=", images.length);
      el.className = "ic-footer-carousel " + (msg.role === "user" ? "user" : "assistant");
      el.style.display = "flex";
      el.style.justifyContent = msg.role === "user" ? "flex-end" : "flex-start";
      el.style.paddingRight = msg.role === "user" ? "25px" : "0";
      el.style.touchAction = "none";
      renderCarouselToEl(el, images);

      try {
        let node = el.parentElement;
        for (let i = 0; i < 10 && node; i++) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
          let tn;
          while ((tn = walker.nextNode())) {
            if (tn.textContent.trim() === "图片" && !el.contains(tn)) tn.textContent = "";
          }
          node.querySelectorAll("span,p,div").forEach((te) => {
            if (te.children.length === 0 && te.textContent.trim() === "图片" && !el.contains(te)) {
              te.style.display = "none";
            }
          });
          const st = getComputedStyle(node);
          const bg = st.backgroundColor || "";
          const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== "rgba(0,0,0,0)";
          const padL = parseFloat(st.paddingLeft || "0");
          if (hasBg && padL >= 6) {
            node.style.background = "transparent";
            node.style.backgroundColor = "transparent";
            node.style.padding = "0";
            node.style.border = "none";
            node.style.boxShadow = "none";
            node.style.maxWidth = "none";
            node.style.overflow = "visible";
            node.style.borderRadius = "0";
          }
          node = node.parentElement;
        }
      } catch (_) {}

      try {
        let n = el.parentElement;
        for (let i = 0; i < 10 && n; i++) {
          n.style.touchAction = "pan-y";
          n.style.overflowX = "visible";
          n = n.parentElement;
        }
        el.style.touchAction = "pan-y";
        el.style.overflow = "visible";
      } catch (_) {}
    });

    ctx.ui.messageKind("carousel", (el, msg) => {
      const images = (msg && msg.mediaData && msg.mediaData.images) || [];
      if (images.length) renderCarouselToEl(el, images);
    });
    ctx.ui.messageKind("plugin:carousel", (el, msg) => {
      const images = (msg && msg.mediaData && msg.mediaData.images) || [];
      if (images.length) renderCarouselToEl(el, images);
    });

    /* ============================================================
     *  输入栏「多选发图」按钮
     * ============================================================ */
    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      const btn = document.createElement("button");
      btn.className = "ic-toolbar-btn";
      btn.innerHTML = `
        <span class="ic-toolbar-icon">
          <svg viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 15l3-3 2 2 3-4 3 4"/><circle cx="8.5" cy="9.5" r="1.2"/><path d="M17 8v10a2 2 0 0 1-2 2H7"/></svg>
        </span>
        <span>多选发图</span>
      `;
      btn.addEventListener("click", async () => {
        let sid = currentSessionId;
        if (!sid) {
          const sessions = ctx.data.sessions.list();
          if (sessions && sessions.length) { sid = sessions[0].id; currentSessionId = sid; }
        }
        if (!sid) { ctx.ui.toast("请切换一次聊天"); return; }

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.style.cssText = "position:absolute;left:-9999px;top:0;width:1px;height:1px;";
        document.body.appendChild(input);

        input.addEventListener("change", async (e) => {
          const files = Array.from(e.target.files || []);
          if (input.parentNode) document.body.removeChild(input);
          if (!files.length) return;

          const minImages = ctx.system.settings.get("minImages") || 2;
          if (files.length < minImages) { ctx.ui.toast(`请至少选 ${minImages} 张`); return; }

          const toast = ctx.ui.toast("正在处理…", { durationMs: 0 });
          try {
            const images = [];
            for (const file of files) {
              images.push({ dataURL: await compressImage(file), mimeType: "image/jpeg" });
            }
            pendingCarousel = { sessionId: sid, images };
            const sent = triggerSend("图片");
            if (!sent) {
              pendingCarousel = null;
              ctx.ui.toast("未找到聊天输入框，请手动在输入框输入任意文字并发送");
            } else {
              ctx.system.timers.setTimeout(() => {
                if (pendingCarousel && pendingCarousel.sessionId === sid) {
                  pendingCarousel = null;
                  ctx.system.log("carousel: pending timed out, cleared");
                }
              }, 15000);
              ctx.ui.toast("已填入输入框，请点击发送");
            }
          } catch (err) {
            pendingCarousel = null;
            ctx.system.log("carousel send error:", err);
            ctx.ui.toast("发送失败");
          } finally { toast.close(); }
        });
        input.click();
      });
      el.appendChild(btn);
    });

    /* ============================================================
     *  连续图片自动合并（AI 发图）
     * ============================================================ */
    let mergeCancel = null, merging = false;
    async function mergeGroup(messages, anchorId) {
      const ai = messages.findIndex((m) => m.id === anchorId);
      if (ai < 0) return false;
      const role = messages[ai].role;
      let s = ai, e = ai;
      while (s > 0 && messages[s - 1].mediaType === "image" && messages[s - 1].role === role) s--;
      while (e < messages.length - 1 && messages[e + 1].mediaType === "image" && messages[e + 1].role === role) e++;
      const group = messages.slice(s, e + 1);
      const minImages = ctx.system.settings.get("minImages") || 2;
      if (group.length < minImages) return false;

      const images = [];
      for (const m of group) {
        try {
          const media = await ctx.data.messages.resolveMedia(m);
          if (media && media.dataURL) images.push({ dataURL: media.dataURL, mimeType: media.mimeType || "image/jpeg" });
        } catch (_) {}
      }
      if (images.length < minImages) return false;

      const firstId = group[0].id;
      ctx.system.storage.set("carousel_msg_" + firstId, images);
      ctx.data.messages.update(firstId, { mediaType: "", mediaData: null, content: "图片", _carouselImages: images });
      for (let i = 1; i < group.length; i++) {
        ctx.data.messages.update(group[i].id, { mediaType: "", mediaData: null, content: "", deleted: true });
      }
      return true;
    }

    ctx.hooks.on("message.persisted", ({ message }) => {
      if (!message || message.mediaType !== "image" || !message.sessionId) return;
      if (mergeCancel) { mergeCancel(); mergeCancel = null; }
      const sid = message.sessionId;
      mergeCancel = ctx.system.timers.setTimeout(() => {
        mergeCancel = null;
        if (merging) return;
        merging = true;
        (async () => {
          try {
            const msgs = ctx.data.messages.list(sid);
            let e = msgs.length - 1;
            while (e >= 0 && msgs[e].mediaType !== "image") e--;
            if (e >= 0) await mergeGroup(msgs, msgs[e].id);
          } catch (err) { ctx.system.log("merge error:", err); }
          finally { merging = false; }
        })();
      }, 600);
    });

    ctx.ui.messageAction({
      id: "merge-to-carousel",
      label: "合并为轮播",
      filter: (msg) => msg && msg.mediaType === "image",
      onSelect: async (msg, { toast }) => {
        if (!msg.sessionId) return;
        const ok = await mergeGroup(ctx.data.messages.list(msg.sessionId), msg.id);
        toast(ok ? "已合并（切换聊天刷新可见）" : "没有可合并的连续图片");
      },
    });
  },
};
//（注：内容由AI生成）