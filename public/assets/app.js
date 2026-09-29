// 页面交互：筛选 / 无限滚动 / 日历 / 灯箱 / 主题。无构建步骤，改了记得把 layout.tsx 里的 ASSET_VERSION 加一。
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const mobile = matchMedia("(max-width: 760px)");

  /* ── 日期：统一按站点时区（<html data-tz>），日期键为 YYYY-MM-DD ── */
  const TZ = root.dataset.tz || "Asia/Shanghai";
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayKey = () => dayFmt.format(new Date());
  const keyUTC = (k) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const addDays = (k, n) => new Date(keyUTC(k) + n * 864e5).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((keyUTC(a) - keyUTC(b)) / 864e5);
  const fmtMD = (k) => {
    const [, m, d] = k.split("-").map(Number);
    return `${m}月${d}日`;
  };

  // 「今天 / 昨天」由前端算：页面会被缓存，服务端写死的相对日期过了零点就不对了
  function relDays(scope = document) {
    const today = todayKey();
    for (const el of $$("[data-rel-day]", scope)) {
      const n = diffDays(today, el.dataset.relDay);
      el.textContent = n === 0 ? "今天" : n === 1 ? "昨天" : n > 1 && n < 7 ? `${n} 天前` : "";
    }
  }

  function toast(msg) {
    const t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  /* ── 筛选状态 ⇄ URL ── */
  const readState = () => {
    const p = new URLSearchParams(location.search);
    const from = p.get("from");
    return { tag: p.get("tag"), q: p.get("q"), from, to: p.get("to") || from };
  };
  const toQuery = (s) => {
    const p = new URLSearchParams();
    if (s.tag) p.set("tag", s.tag);
    if (s.q) p.set("q", s.q);
    if (s.from) {
      p.set("from", s.from);
      if (s.to && s.to !== s.from) p.set("to", s.to);
    }
    return p.toString();
  };

  let state = readState();
  const timeline = $("#timeline");
  const isHome = !!$("#filter");
  let next = timeline?.dataset.next || "";
  let loading = false;
  let applySeq = 0;

  async function fetchFragment(s, cursor) {
    const p = new URLSearchParams(toQuery(s));
    if (cursor) p.set("cursor", cursor);
    const res = await fetch(`/fragments/timeline?${p}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function updateEnd(empty) {
    const end = $("#end");
    if (end) end.textContent = next ? "加载中…" : empty ? "" : "— 到底啦 —";
  }

  async function applyState(s, { history: mode = "push", scroll = true } = {}) {
    state = s;
    const qs = toQuery(s);
    const url = qs ? `/?${qs}` : "/";
    if (mode === "push") history.pushState(null, "", url);
    else if (mode === "replace") history.replaceState(null, "", url);
    syncChrome();
    const seq = ++applySeq;
    try {
      const data = await fetchFragment(s);
      if (seq !== applySeq) return; // 已经有更新的筛选
      $("#filter").innerHTML = data.filter || "";
      timeline.innerHTML = data.html;
      next = data.next || "";
      updateEnd(data.empty);
      afterRender(timeline);
      if (scroll) scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      toast("加载失败，请稍后再试");
    }
  }

  async function loadMore() {
    if (loading || !next || !timeline) return;
    loading = true;
    const seq = applySeq;
    try {
      const data = await fetchFragment(state, next);
      if (seq !== applySeq) return;
      appendSections(data.html);
      next = data.next || "";
      updateEnd(false);
    } catch {
      const end = $("#end");
      if (end) end.textContent = "加载失败，点击重试";
    } finally {
      loading = false;
    }
  }

  // 追加的第一天如果和页面最后一天相同，合并进去，不重复显示日期标题
  function appendSections(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const sections = $$("section.day", tpl.content);
    const last = $$("section.day", timeline).pop();
    if (last && sections[0] && sections[0].dataset.day === last.dataset.day) {
      const first = sections.shift();
      first.querySelector(".day-head")?.remove();
      last.append(...first.children);
    }
    timeline.append(...sections);
    afterRender(timeline);
  }

  function highlight(scope) {
    const q = state.q?.trim();
    if (!q) return;
    const src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(src, "gi");
    const has = new RegExp(src, "i"); // 不带 g：test 不会推进 lastIndex
    for (const content of $$(".content", scope)) {
      if (content.dataset.hl === q) continue;
      content.dataset.hl = q;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) if (has.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const frag = document.createDocumentFragment();
        let last = 0;
        node.nodeValue.replace(re, (m, i) => {
          frag.append(node.nodeValue.slice(last, i));
          const mark = document.createElement("mark");
          mark.textContent = m;
          frag.append(mark);
          last = i + m.length;
          return m;
        });
        frag.append(node.nodeValue.slice(last));
        node.replaceWith(frag);
      }
    }
  }

  function afterRender(scope) {
    relDays(scope);
    highlight(scope);
  }

  /** 侧栏标签、热力图、日历按钮、搜索框跟随当前筛选 */
  function syncChrome() {
    for (const a of $$("#tags [data-tag]")) a.classList.toggle("active", a.dataset.tag === state.tag);
    for (const i of $$("#heatmap [data-day]")) {
      const d = i.dataset.day;
      i.classList.toggle("sel", !!state.from && d >= state.from && d <= (state.to || state.from));
    }
    $("#cal-btn")?.classList.toggle("on", !!state.from);
    const q = $("#q");
    if (q && document.activeElement !== q) q.value = state.q || "";
  }

  if (isHome) {
    const end = $("#end");
    if (end && "IntersectionObserver" in window) {
      new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "800px 0px" }).observe(end);
    }
    end?.addEventListener("click", loadMore);
    addEventListener("popstate", () => applyState(readState(), { history: "none" }));

    const q = $("#q");
    let timer;
    q?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => applyState({ ...state, q: q.value.trim() || null }, { history: "replace", scroll: false }), 350);
    });
    $("form.search")?.addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      applyState({ ...state, q: q.value.trim() || null });
      q.blur();
    });
  }

  /* ── 日历（桌面：弹层；移动端：底部抽屉） ── */
  const cal = { el: $("#cal"), month: todayKey().slice(0, 8) + "01", pending: false, counts: new Map() };

  async function monthCounts(first) {
    if (cal.counts.has(first)) return cal.counts.get(first);
    const last = addDays(addDays(first, 32).slice(0, 8) + "01", -1);
    const p = fetch(`/api/stats/heatmap?from=${first}&to=${last}`)
      .then((r) => (r.ok ? r.json() : { counts: {} }))
      .then((d) => d.counts)
      .catch(() => ({}));
    cal.counts.set(first, p);
    return p;
  }

  async function renderCal() {
    if (!cal.el) return;
    const first = cal.month;
    const [y, m] = first.split("-").map(Number);
    $("#cal-title").textContent = `${y} 年 ${m} 月`;
    const today = todayKey();
    const start = addDays(first, -new Date(keyUTC(first)).getUTCDay());
    const counts = await monthCounts(first);
    if (first !== cal.month) return;
    const from = state.from;
    const to = state.to || from;
    let html = "";
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const out = Number(d.slice(5, 7)) !== m;
      if (i >= 35 && out) break;
      const cls = [
        out && "out",
        counts[d] && "has",
        d === today && "today",
        from && d >= from && d <= to && "r-in",
        d === from && "r-start",
        d === to && "r-end",
      ].filter(Boolean);
      html += `<button type="button" data-d="${d}" class="${cls.join(" ")}" ${d > today ? "disabled" : ""} title="${counts[d] ? `${counts[d]} 条` : ""}"><span>${Number(d.slice(8))}</span></button>`;
    }
    $("#cal-days").innerHTML = html;
    $("#cal-hint").textContent = cal.pending ? `已选 ${fmtMD(from)}，再点一天组成区间` : "点一下选单日，再点一下选成区间";
  }

  function toggleCal(open = cal.el.hidden) {
    cal.el.hidden = !open;
    document.body.classList.toggle("sheet-open", open && mobile.matches);
    $("#cal-btn").setAttribute("aria-expanded", String(open));
    if (open) {
      if (state.from) cal.month = (state.to || state.from).slice(0, 8) + "01";
      renderCal();
    } else cal.pending = false;
  }

  const setRange = (from, to) => {
    if (from && to && to < from) [from, to] = [to, from];
    return applyState({ ...state, from, to: from ? to || from : null });
  };

  if (cal.el) {
    $("#cal-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCal();
    });
    cal.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const nav = e.target.closest("[data-cal]");
      if (nav) {
        const [y, m] = cal.month.split("-").map(Number);
        const d = new Date(Date.UTC(y, m - 1 + Number(nav.dataset.cal), 1));
        cal.month = d.toISOString().slice(0, 10);
        return renderCal();
      }
      const day = e.target.closest("[data-d]");
      if (day && !day.disabled) {
        const d = day.dataset.d;
        if (cal.pending) {
          cal.pending = false;
          setRange(state.from, d);
          toggleCal(false);
        } else {
          cal.pending = true;
          setRange(d, d);
          renderCal();
        }
        return;
      }
      const pre = e.target.closest("[data-preset]");
      if (pre) {
        const v = pre.dataset.preset;
        const today = todayKey();
        v === "clear" ? setRange(null, null) : setRange(addDays(today, -Number(v)), today);
        toggleCal(false);
      }
    });
    document.addEventListener("click", () => !cal.el.hidden && toggleCal(false));
    document.addEventListener("keydown", (e) => e.key === "Escape" && !cal.el.hidden && toggleCal(false));

    // 移动端抽屉下滑关闭
    let sy = 0;
    cal.el.addEventListener("touchstart", (e) => (sy = e.touches[0].clientY), { passive: true });
    cal.el.addEventListener(
      "touchmove",
      (e) => {
        const dy = e.touches[0].clientY - sy;
        if (mobile.matches && dy > 0 && cal.el.scrollTop <= 0) {
          cal.el.style.transition = "none";
          cal.el.style.transform = `translateY(${dy}px)`;
        }
      },
      { passive: true },
    );
    cal.el.addEventListener("touchend", (e) => {
      const dy = e.changedTouches[0].clientY - sy;
      cal.el.style.transform = cal.el.style.transition = "";
      if (mobile.matches && dy > 80) toggleCal(false);
    });
  }

  /* ── 灯箱 ── */
  const lb = { el: $("#lb"), img: $("#lb-img"), list: [], i: 0 };
  function showLB() {
    lb.img.src = lb.list[lb.i];
    $("#lb-count").textContent = lb.list.length > 1 ? `${lb.i + 1} / ${lb.list.length}` : "";
    for (const b of $$(".lb-prev, .lb-next", lb.el)) b.style.visibility = lb.list.length > 1 ? "visible" : "hidden";
  }
  function openLB(list, i) {
    lb.list = list;
    lb.i = i;
    showLB();
    lb.el.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeLB() {
    lb.el.classList.remove("open");
    lb.img.removeAttribute("src");
    document.body.style.overflow = "";
  }
  const step = (d) => {
    lb.i = (lb.i + d + lb.list.length) % lb.list.length;
    showLB();
  };
  if (lb.el) {
    lb.el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "close" || e.target === lb.el) closeLB();
      else if (act === "prev") step(-1);
      else if (act === "next") step(1);
    });
    document.addEventListener("keydown", (e) => {
      if (!lb.el.classList.contains("open")) return;
      if (e.key === "Escape") closeLB();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });
    // 左右滑切换；下滑跟手，超过阈值关闭
    let tx = 0;
    let ty = 0;
    lb.el.addEventListener(
      "touchstart",
      (e) => {
        tx = e.touches[0].clientX;
        ty = e.touches[0].clientY;
      },
      { passive: true },
    );
    lb.el.addEventListener(
      "touchmove",
      (e) => {
        const dy = e.touches[0].clientY - ty;
        if (dy > 0 && Math.abs(dy) > Math.abs(e.touches[0].clientX - tx)) {
          lb.img.style.transition = "none";
          lb.img.style.transform = `translateY(${dy}px) scale(${1 - Math.min(dy, 300) / 1200})`;
          lb.el.style.background = `rgba(12,10,8,${0.92 - Math.min(dy, 300) / 500})`;
        }
      },
      { passive: true },
    );
    lb.el.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      lb.img.style.transition = lb.img.style.transform = lb.el.style.background = "";
      if (dy > 90 && dy > Math.abs(dx)) closeLB();
      else if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    });
  }

  /* ── 全局点击 ── */
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target;

    const photo = t.closest("a.m[data-full]");
    if (photo && lb.el) {
      e.preventDefault();
      const cells = $$("a.m[data-full]", photo.closest(".grid"));
      return openLB(
        cells.map((c) => c.dataset.full),
        cells.indexOf(photo),
      );
    }

    const video = t.closest(".m.video[data-video]");
    if (video) {
      video.innerHTML = `<video src="${video.dataset.video}" controls autoplay playsinline></video>`;
      video.removeAttribute("data-video");
      video.classList.add("playing");
      return;
    }

    const spoiler = t.closest(".spoiler");
    if (spoiler) return spoiler.classList.toggle("show");

    const quote = t.closest("blockquote.expandable");
    if (quote) return quote.classList.toggle("open");

    const copy = t.closest("[data-copy]");
    if (copy) {
      navigator.clipboard?.writeText(location.origin + copy.dataset.copy).catch(() => {});
      return toast("链接已复制");
    }

    if (!isHome) return;

    const heat = t.closest("#heatmap [data-day]");
    if (heat) {
      const d = heat.dataset.day;
      return state.from === d && state.to === d ? setRange(null, null) : setRange(d, d);
    }

    const clear = t.closest("[data-clear]");
    if (clear) {
      e.preventDefault();
      const k = clear.dataset.clear;
      return applyState({ ...state, ...(k === "date" ? { from: null, to: null } : { [k]: null }) });
    }

    // 侧栏标签、正文里的 #标签：站内切换，不整页刷新
    const tagLink = t.closest("a[data-tag], a.hashtag");
    if (tagLink) {
      const tag = tagLink.dataset.tag ?? new URL(tagLink.href).searchParams.get("tag");
      if (!tag) return;
      e.preventDefault();
      return applyState({ ...state, tag: state.tag === tag && tagLink.dataset.tag ? null : tag });
    }
  });

  /* ── 主题 ── */
  $("#theme")?.addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("theme", root.dataset.theme);
    } catch {}
  });

  /* ── 移动端吸顶栏 / 回到顶部 ── */
  const topbar = $("#topbar");
  const toTop = $("#to-top");
  const syncStick = () => root.style.setProperty("--stick", topbar && mobile.matches ? `${topbar.offsetHeight}px` : "0px");
  if (topbar && "ResizeObserver" in window) new ResizeObserver(syncStick).observe(topbar);
  mobile.addEventListener("change", () => {
    syncStick();
    if (cal.el && !cal.el.hidden) toggleCal(false);
  });
  addEventListener(
    "scroll",
    () => {
      topbar?.classList.toggle("stuck", mobile.matches && topbar.getBoundingClientRect().top <= 0 && scrollY > 0);
      toTop?.classList.toggle("show", scrollY > 900);
    },
    { passive: true },
  );
  toTop?.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));

  syncStick();
  afterRender(document);
})();
