export default {
  manifest: {
    id: "phone-lockscreen",
    name: "手机锁屏",
    apiVersion: 1,
    version: "1.0.0",
    author: "AI",
    description: "启动时显示手机风格锁屏：壁纸 + 时间组件 + 数字密码解锁，密码与壁纸均可自定义。",
    permissions: [],
    settings: [
      { key: "enabled", label: "启用锁屏", type: "boolean", default: true },
      { key: "showSeconds", label: "时钟显示秒", type: "boolean", default: false },
      { key: "wallpaperUrl", label: "壁纸图片直链（可选，上传的壁纸优先）", type: "text", default: "" },
      { key: "blur", label: "壁纸模糊程度 px（0~40）", type: "number", default: 0 },
      { key: "dim", label: "壁纸压暗程度 0~90", type: "number", default: 28 }
    ]
  },

  setup(ctx) {
    const S = ctx.system.storage;
    const K = { PIN: "pinHash", LEN: "pinLen", WP: "wallpaper" };

    /* ============================ 工具 ============================ */

    // 轻量哈希：只做本地防窥，不做安全承诺
    function hashPin(pin) {
      const s = "phonelock::" + pin + "::v1";
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16) + "-" + s.length;
    }

    function num(key, def, min, max) {
      let v = Number(ctx.system.settings.get(key));
      if (!isFinite(v)) v = def;
      return Math.max(min, Math.min(max, v));
    }

    function bool(key, def) {
      const v = ctx.system.settings.get(key);
      return v === undefined || v === null ? def : v === true;
    }

    function wallpaperSrc() {
      const up = S.get(K.WP);
      if (up && typeof up === "string") return up;
      const u = ctx.system.settings.get("wallpaperUrl");
      return typeof u === "string" && u.trim() ? u.trim() : "";
    }

    // 读文件 -> 缩放 -> jpeg dataURL（控制体积，避免存储爆掉）
    function compressImage(file, maxSide, quality) {
      maxSide = maxSide || 1440;
      quality = quality || 0.82;
      return new Promise((resolve) => {
        let reader;
        try { reader = new FileReader(); } catch (e) { resolve(null); return; }
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            try {
              let w = img.naturalWidth || img.width;
              let h = img.naturalHeight || img.height;
              const scale = Math.min(1, maxSide / Math.max(w, h));
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
              const c = document.createElement("canvas");
              c.width = w; c.height = h;
              const g = c.getContext("2d");
              g.drawImage(img, 0, 0, w, h);
              resolve(c.toDataURL("image/jpeg", quality));
            } catch (e) {
              resolve(typeof reader.result === "string" ? reader.result : null);
            }
          };
          img.onerror = () => resolve(null);
          img.src = String(reader.result);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    function safeToast(text, opts) {
      try { return ctx.ui.toast(text, opts); } catch (e) { return null; }
    }

    function closeToast(t) {
      try { if (t && typeof t.close === "function") t.close(); } catch (e) {}
    }

    /* ============================ 锁屏样式 ============================ */

    const CSS = `
.plk{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  color:#fff;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  touch-action:manipulation;transition:opacity .36s ease,transform .36s ease;}
.plk *{box-sizing:border-box;margin:0;padding:0;}

.plk-bg{position:absolute;inset:-44px;background-size:cover;background-position:center;
  background-repeat:no-repeat;transform:translateZ(0);}
.plk-bg.def{background-image:linear-gradient(155deg,#252b4d 0%,#3b2b50 36%,#16203a 68%,#0a0e18 100%);}
.plk-dim{position:absolute;inset:0;background:#000;pointer-events:none;}
.plk-vig{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(to bottom,rgba(0,0,0,.42) 0%,rgba(0,0,0,0) 26%,rgba(0,0,0,0) 50%,rgba(0,0,0,.55) 100%);}

.plk-top{position:relative;padding-top:12vh;text-align:center;}
.plk-clock{font-size:clamp(52px,16vw,104px);font-weight:200;line-height:1;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums;text-shadow:0 4px 30px rgba(0,0,0,.4);}
.plk-date{margin-top:12px;font-size:15px;letter-spacing:.09em;opacity:.92;
  text-shadow:0 2px 12px rgba(0,0,0,.45);}

.plk-bottom{position:relative;margin-top:auto;display:flex;flex-direction:column;align-items:center;
  padding:0 22px calc(24px + env(safe-area-inset-bottom,0px));}
.plk-hint{height:18px;font-size:13px;letter-spacing:.05em;opacity:.82;margin-bottom:18px;
  text-shadow:0 2px 10px rgba(0,0,0,.5);}
.plk-dots{display:flex;gap:18px;margin-bottom:26px;}
.plk-dot{width:12px;height:12px;border-radius:50%;border:1.5px solid rgba(255,255,255,.9);
  box-shadow:0 1px 8px rgba(0,0,0,.35);
  transition:background .15s,transform .15s,border-color .15s;}
.plk-dot.on{background:#fff;transform:scale(1.08);}
.plk-dots.bad .plk-dot{border-color:#ff6b6b;}
.plk-dots.bad .plk-dot.on{background:#ff6b6b;}

.plk-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:264px;}
.plk-key{aspect-ratio:1/1;min-height:54px;border-radius:50%;display:flex;flex-direction:column;
  align-items:center;justify-content:center;cursor:pointer;background:rgba(255,255,255,.15);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.14);
  transition:background .12s ease,transform .08s ease;}
.plk-key:active{background:rgba(255,255,255,.44);transform:scale(.94);}
.plk-key.blank{background:transparent;border-color:transparent;cursor:default;}
.plk-key.blank:active{background:transparent;transform:none;}
.plk-n{font-size:27px;font-weight:300;line-height:1;text-shadow:0 1px 8px rgba(0,0,0,.3);}
.plk-s{height:10px;font-size:8.5px;letter-spacing:.14em;opacity:.6;margin-top:3px;}
.plk-key.del .plk-n{font-size:21px;}

.plk-reset{margin-top:18px;font-size:12px;opacity:0;pointer-events:none;
  text-decoration:underline;text-underline-offset:3px;transition:opacity .3s ease;}
.plk-reset.show{opacity:.7;pointer-events:auto;cursor:pointer;}

.plk.shake{animation:plk-shake .42s ease;}
@keyframes plk-shake{
  0%,100%{transform:translateX(0)}
  18%{transform:translateX(-9px)}
  36%{transform:translateX(8px)}
  54%{transform:translateX(-6px)}
  72%{transform:translateX(4px)}
  88%{transform:translateX(-2px)}
}
@media (max-height:680px){
  .plk-top{padding-top:6vh;}
  .plk-clock{font-size:clamp(42px,12vw,72px);}
  .plk-date{font-size:13px;margin-top:8px;}
  .plk-dots{margin-bottom:18px;}
  .plk-hint{margin-bottom:12px;}
  .plk-pad{max-width:224px;gap:8px;}
  .plk-n{font-size:22px;}
  .plk-key.del .plk-n{font-size:18px;}
  .plk-s{display:none;}
}
`;

    const HTML = `
<div class="plk-bg"></div>
<div class="plk-dim"></div>
<div class="plk-vig"></div>
<div class="plk-top">
  <div class="plk-clock">--:--</div>
  <div class="plk-date"></div>
</div>
<div class="plk-bottom">
  <div class="plk-hint">请输入密码</div>
  <div class="plk-dots"></div>
  <div class="plk-pad"></div>
  <div class="plk-reset">忘记密码？点此重置</div>
</div>`;

    /* ============================ 锁屏构建 ============================ */

    function buildLock(host, onUnlock) {
      // 让宿主给的容器铺满全屏（默认是居中卡片）
      host.style.cssText =
        "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;" +
        "max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;" +
        "border-radius:0!important;box-shadow:none!important;background:transparent!important;" +
        "overflow:hidden!important;border:none!important;";

      let root;
      try { root = host.attachShadow({ mode: "open" }); }
      catch (e) { root = host; }

      const styleEl = document.createElement("style");
      styleEl.textContent = CSS;
      root.appendChild(styleEl);

      const wrap = document.createElement("div");
      wrap.className = "plk";
      wrap.innerHTML = HTML;
      root.appendChild(wrap);

      const q = (s) => root.querySelector(s);
      const bgEl = q(".plk-bg");
      const dimEl = q(".plk-dim");
      const clockEl = q(".plk-clock");
      const dateEl = q(".plk-date");
      const dotsEl = q(".plk-dots");
      const padEl = q(".plk-pad");
      const hintEl = q(".plk-hint");
      const resetEl = q(".plk-reset");

      /* ---- 壁纸 ---- */
      const wp = wallpaperSrc();
      if (wp) {
        bgEl.style.backgroundImage = "url(" + JSON.stringify(wp) + ")";
      } else {
        bgEl.classList.add("def");
      }
      const blurPx = num("blur", 0, 0, 40);
      if (blurPx > 0) bgEl.style.filter = "blur(" + blurPx + "px)";
      dimEl.style.opacity = String(num("dim", 28, 0, 90) / 100);

      /* ---- 时间组件 ---- */
      const WEEK = "日一二三四五六";
      const showSec = bool("showSeconds", false);
      let clockTimer = null;

      function stopClock() {
        if (clockTimer) {
          try { clockTimer(); } catch (e) {}
          clockTimer = null;
        }
      }

      function tick() {
        if (!host.isConnected) { stopClock(); return; }
        const d = new Date();
        const p2 = (n) => (n < 10 ? "0" : "") + n;
        clockEl.textContent =
          p2(d.getHours()) + ":" + p2(d.getMinutes()) + (showSec ? ":" + p2(d.getSeconds()) : "");
        dateEl.textContent =
          (d.getMonth() + 1) + "月" + d.getDate() + "日 星期" + WEEK[d.getDay()];
      }

      tick();
      clockTimer = ctx.system.timers.setInterval(tick, 1000);

      /* ---- 密码 ---- */
      const pinLen = Math.max(1, Math.min(8, Number(S.get(K.LEN)) || 4));
      const pinHash = String(S.get(K.PIN) || "");
      let input = "";
      let fails = 0;
      let unlocked = false;

      function renderDots() {
        let html = "";
        for (let i = 0; i < pinLen; i++) {
          html += '<div class="plk-dot' + (i < input.length ? " on" : "") + '"></div>';
        }
        dotsEl.innerHTML = html;
      }

      const SUBS = { "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL", "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ" };
      const LAYOUT = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];

      LAYOUT.forEach((k) => {
        const b = document.createElement("div");
        if (k === "") {
          b.className = "plk-key blank";
          padEl.appendChild(b);
          return;
        }
        if (k === "del") {
          b.className = "plk-key del";
          b.innerHTML = '<div class="plk-n">⌫</div><div class="plk-s"></div>';
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            if (unlocked) return;
            input = input.slice(0, -1);
            renderDots();
          });
        } else {
          b.className = "plk-key";
          b.innerHTML = '<div class="plk-n">' + k + '</div><div class="plk-s">' +
            (SUBS[k] || "") + "</div>";
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            press(k);
          });
        }
        padEl.appendChild(b);
      });

      function press(k) {
        if (unlocked || input.length >= pinLen) return;
        input += k;
        renderDots();
        if (input.length === pinLen) {
          ctx.system.timers.setTimeout(checkPin, 110);
        }
      }

      function checkPin() {
        if (hashPin(input) === pinHash) {
          unlock();
        } else {
          fail();
        }
      }

      function fail() {
        fails++;
        dotsEl.classList.add("bad");
        wrap.classList.add("shake");
        hintEl.textContent = "密码错误";
        try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
        ctx.system.timers.setTimeout(() => {
          dotsEl.classList.remove("bad");
          wrap.classList.remove("shake");
          input = "";
          renderDots();
          hintEl.textContent = "请输入密码";
        }, 460);
        if (fails >= 5) resetEl.classList.add("show");
      }

      function unlock() {
        if (unlocked) return;
        unlocked = true;
        stopClock();
        wrap.style.opacity = "0";
        wrap.style.transform = "scale(1.06)";
        ctx.system.timers.setTimeout(() => {
          try { onUnlock(); } catch (e) {}
        }, 340);
      }

      resetEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (unlocked) return;
        let ok = true;
        try {
          ok = window.confirm("重置将清除锁屏密码（不会删除聊天记录），确定吗？");
        } catch (err) {}
        if (!ok) return;
        S.remove(K.PIN);
        S.remove(K.LEN);
        unlock();
      });

      // 防止点击穿透到宿主遮罩导致锁屏被关掉
      ["pointerdown", "mousedown", "touchstart", "click"].forEach((ev) => {
        host.addEventListener(ev, (e) => e.stopPropagation(), false);
      });

      renderDots();
    }

    /* ============================ 打开锁屏 ============================ */

    let lockVisible = false;

    function showLock() {
      if (lockVisible) return;
      if (typeof ctx.ui.openModal !== "function") return;
      lockVisible = true;
      try {
        ctx.ui.openModal((el, api) => {
          buildLock(el, () => {
            lockVisible = false;
            try { if (api && typeof api.close === "function") api.close(); } catch (e) {}
          });
        });
      } catch (e) {
        lockVisible = false;
        ctx.system.log("[锁屏] 打开失败", e);
      }
    }

    /* ============================ 启动时触发 ============================ */

    ctx.hooks.on("app.ready", () => {
      if (!bool("enabled", true)) return;
      if (!S.get(K.PIN)) return; // 没设密码就不锁
      ctx.system.timers.setTimeout(showLock, 400);
    });

    /* ============================ 设置界面 ============================ */

    function mountSettings(el) {
      el.innerHTML = "";

      const IN =
        "width:100%;padding:8px 10px;border-radius:9px;border:1px solid rgba(140,140,140,.4);" +
        "background:rgba(140,140,140,.12);color:inherit;font-size:13px;outline:none;";
      const BT =
        "padding:8px 14px;border-radius:9px;border:1px solid rgba(140,140,140,.45);" +
        "background:rgba(140,140,140,.16);color:inherit;font-size:13px;cursor:pointer;";
      const TITLE = "font-weight:600;font-size:12px;letter-spacing:.04em;opacity:.75;margin-top:6px;";

      const box = document.createElement("div");
      box.style.cssText = "display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5;";
      el.appendChild(box);

      /* ---- 密码 ---- */
      const t1 = document.createElement("div");
      t1.style.cssText = TITLE;
      t1.textContent = "🔒 锁屏密码";
      box.appendChild(t1);

      const hasPin = !!S.get(K.PIN);
      const curLen = Number(S.get(K.LEN)) || 4;

      const stateEl = document.createElement("div");
      stateEl.style.cssText = "opacity:.7;font-size:12px;";
      stateEl.textContent = hasPin
        ? "已设置（" + curLen + " 位数字），每次启动小手机都会先显示锁屏。"
        : "尚未设置。设置密码后，每次启动小手机都会先显示锁屏。";
      box.appendChild(stateEl);

      const p1 = document.createElement("input");
      p1.type = "password";
      p1.inputMode = "numeric";
      p1.maxLength = 8;
      p1.placeholder = "新密码（4~8 位数字）";
      p1.style.cssText = IN;
      box.appendChild(p1);

      const p2 = document.createElement("input");
      p2.type = "password";
      p2.inputMode = "numeric";
      p2.maxLength = 8;
      p2.placeholder = "再次输入确认";
      p2.style.cssText = IN;
      box.appendChild(p2);

      const row1 = document.createElement("div");
      row1.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      box.appendChild(row1);

      const saveBtn = document.createElement("button");
      saveBtn.style.cssText = BT;
      saveBtn.textContent = hasPin ? "修改密码" : "设置密码";
      saveBtn.onclick = () => {
        const a = p1.value.trim();
        const b = p2.value.trim();
        if (!/^\d{4,8}$/.test(a)) { safeToast("密码需为 4~8 位数字"); return; }
        if (a !== b) { safeToast("两次输入不一致"); return; }
        S.set(K.PIN, hashPin(a));
        S.set(K.LEN, a.length);
        safeToast("密码已保存");
        mountSettings(el);
      };
      row1.appendChild(saveBtn);

      if (hasPin) {
        const clr = document.createElement("button");
        clr.style.cssText = BT;
        clr.textContent = "清除密码";
        clr.onclick = () => {
          S.remove(K.PIN);
          S.remove(K.LEN);
          safeToast("已清除密码，启动时不再锁屏");
          mountSettings(el);
        };
        row1.appendChild(clr);
      }

      /* ---- 壁纸 ---- */
      const t2 = document.createElement("div");
      t2.style.cssText = TITLE;
      t2.textContent = "🖼 锁屏壁纸";
      box.appendChild(t2);

      const cur = S.get(K.WP);
      const urlSetting = ctx.system.settings.get("wallpaperUrl");
      const previewSrc = (cur && typeof cur === "string")
        ? cur
        : (typeof urlSetting === "string" && urlSetting.trim() ? urlSetting.trim() : "");

      if (previewSrc) {
        const img = document.createElement("img");
        img.src = previewSrc;
        img.style.cssText =
          "width:100%;max-height:160px;object-fit:cover;border-radius:10px;" +
          "border:1px solid rgba(140,140,140,.3);display:block;";
        box.appendChild(img);
      }

      const row2 = document.createElement("div");
      row2.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;";
      box.appendChild(row2);

      const file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*";
      file.style.display = "none";
      box.appendChild(file);

      const upBtn = document.createElement("button");
      upBtn.style.cssText = BT;
      upBtn.textContent = cur ? "更换图片" : "上传图片";
      upBtn.onclick = () => file.click();
      row2.appendChild(upBtn);

      if (cur) {
        const rm = document.createElement("button");
        rm.style.cssText = BT;
        rm.textContent = "移除壁纸";
        rm.onclick = () => {
          S.remove(K.WP);
          safeToast("已移除壁纸");
          mountSettings(el);
        };
        row2.appendChild(rm);
      }

      const tip = document.createElement("div");
      tip.style.cssText = "opacity:.6;font-size:11px;";
      tip.textContent = "也可在上方「壁纸图片直链」里填网络图片地址；上传的图片优先。";
      box.appendChild(tip);

      file.onchange = async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        const t = safeToast("处理图片中…", { durationMs: 0 });
        try {
          const dataUrl = await compressImage(f);
          if (!dataUrl) { safeToast("图片处理失败"); return; }
          try {
            S.set(K.WP, dataUrl);
            safeToast("壁纸已设置");
          } catch (err) {
            safeToast("保存失败，图片可能过大");
          }
          mountSettings(el);
        } finally {
          closeToast(t);
        }
      };
    }

    ctx.ui.slot("settings.section", (el) => {
      mountSettings(el);
    });

    ctx.system.log("[手机锁屏] 已就绪");
  }
};