// 页面交互：筛选 / 搜索 / 无限滚动 / 日历 / 灯箱 / 主题。纯静态站点，数据来自构建生成的 /data：
//   /data/index.json        每条帖子的 id、时间、日期、标签、纯文本（筛选、搜索、热力图用）
//   /data/month/YYYY-MM.json  该月每条帖子渲染好的 HTML
// 无构建步骤，改了记得把 layout.tsx 里的 ASSET_VERSION 加一。
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const mobile = matchMedia("(max-width: 760px)");
  const BUILD = root.dataset.build || "";
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const PRELOAD_PX = 800;

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
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // 「今天 / 昨天」由前端算：静态页面构建时写死的相对日期过了零点就不对了
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

  /* ── 数据 ── */
  let indexPromise = null;
  const loadIndex = () => {
    indexPromise ??= fetch(`/data/index.json?v=${BUILD}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((e) => {
        indexPromise = null; // 下次再试
        throw e;
      });
    return indexPromise;
  };
  const months = new Map();
  const loadMonth = (m) => {
    if (!months.has(m)) {
      months.set(
        m,
        fetch(`/data/month/${m}.json?v=${BUILD}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .catch((e) => {
            months.delete(m);
            throw e;
          }),
      );
    }
    return months.get(m);
  };

  /* ── 筛选状态 ⇄ URL ── */
  const readState = () => {
    const p = new URLSearchParams(location.search);
    const valid = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    let from = valid(p.get("from"));
    let to = valid(p.get("to")) || from;
    if (from && to && to < from) [from, to] = [to, from];
    return { tag: p.get("tag") || null, q: p.get("q")?.trim() || null, from, to: from ? to : null };
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
  const hasFilters = (s) => !!(s.tag || s.q || s.from);
  const matches = (p, s) =>
    (!s.tag || p.g.includes(s.tag)) &&
    (!s.from || (p.d >= s.from && p.d <= (s.to || s.from))) &&
    (!s.q || p.s.toLowerCase().includes(s.q.toLowerCase()));

  let state = readState();
  const timeline = $("#timeline");
  const isHome = !!$("#filter");

  /**
   * 当前列表：list 是匹配的索引条目（按时间倒序），shown 是已渲染的条数。
   * seq 每次切换筛选 +1，异步结果回来时对不上就丢弃，避免新旧筛选的结果混在一起。
   */
  const view = { list: null, shown: 0, seq: 0, loading: -1, pageSize: 20 };

  function renderFilterBar(count) {
    const bar = $("#filter");
    if (!bar) return;
    if (!hasFilters(state)) return (bar.innerHTML = "");
    const date = state.from ? (state.from === state.to ? fmtMD(state.from) : `${fmtMD(state.from)} – ${fmtMD(state.to)}`) : null;
    bar.innerHTML =
      (count == null ? "" : `<span>${count} 条结果</span>`) +
      (date ? `<a class="tag-chip" href="#" data-clear="date">${date} ✕</a>` : "") +
      (state.tag ? `<a class="tag-chip" href="#" data-clear="tag">#${esc(state.tag)} ✕</a>` : "") +
      (state.q ? `<a class="tag-chip" href="#" data-clear="q">“${esc(state.q)}” ✕</a>` : "");
  }

  function updateEnd() {
    const end = $("#end");
    if (!end || !view.list) return;
    end.textContent = view.shown < view.list.length ? "加载中…" : view.list.length ? "— 到底啦 —" : "";
  }

  const dayHead = (d) => {
    const [, m, dd] = d.split("-").map(Number);
    return `<div class="day-head"><span class="day-num">${dd}</span><span class="day-meta">${m} 月 · ${WEEK[new Date(keyUTC(d)).getUTCDay()]}<em data-rel-day="${d}"></em></span></div>`;
  };

  /** 按天分组追加；和页面上最后一天相同的并进去，不重复显示日期 */
  function appendPosts(items) {
    let section = $$("section.day", timeline).pop();
    for (const { entry, html } of items) {
      if (!html) continue;
      if (section?.dataset.day !== entry.d) {
        section = document.createElement("section");
        section.className = "day";
        section.dataset.day = entry.d;
        section.innerHTML = dayHead(entry.d);
        timeline.append(section);
      }
      section.insertAdjacentHTML("beforeend", html);
    }
    afterRender(timeline);
  }

  async function renderMore() {
    const seq = view.seq;
    if (!view.list || view.loading === seq || view.shown >= view.list.length) return;
    view.loading = seq;
    try {
      const batch = view.list.slice(view.shown, view.shown + view.pageSize);
      const needed = [...new Set(batch.map((p) => p.d.slice(0, 7)))];
      const chunks = Object.fromEntries(await Promise.all(needed.map(async (m) => [m, await loadMonth(m)])));
      if (seq !== view.seq) return;
      appendPosts(batch.map((entry) => ({ entry, html: chunks[entry.d.slice(0, 7)]?.[entry.id] })));
      view.shown += batch.length;
      updateEnd();
    } catch {
      if (seq === view.seq) $("#end").textContent = "加载失败，点击重试";
      return;
    } finally {
      if (view.loading === seq) view.loading = -1;
    }
    // 追加后底部仍在预加载范围内（大屏 / 帖子很短）时继续加载，不依赖 IntersectionObserver 再次触发
    requestAnimationFrame(checkEnd);
  }

  function checkEnd() {
    const end = $("#end");
    if (end && view.list && view.shown < view.list.length && end.getBoundingClientRect().top < innerHeight + PRELOAD_PX) {
      renderMore();
    }
  }

  /** 首次滚动到底：首屏是构建时渲染的，接上完整列表继续往下 */
  async function ensureList() {
    if (view.list) return;
    const seq = view.seq;
    const idx = await loadIndex();
    if (seq !== view.seq || view.list) return;
    view.pageSize = idx.pageSize || view.pageSize;
    view.list = idx.posts.filter((p) => matches(p, state));
    view.shown = $$("#timeline .post").length;
    updateEnd();
  }

  async function applyState(s, { history: mode = "push", scroll = true } = {}) {
    state = s;
    const qs = toQuery(s);
    const url = qs ? `/?${qs}` : "/";
    if (mode === "push") history.pushState(null, "", url);
    else if (mode === "replace") history.replaceState(null, "", url);
    const seq = ++view.seq;
    syncChrome();
    renderFilterBar(null);
    try {
      const idx = await loadIndex();
      if (seq !== view.seq) return;
      view.pageSize = idx.pageSize || view.pageSize;
      view.list = idx.posts.filter((p) => matches(p, s));
      view.shown = 0;
      timeline.innerHTML = view.list.length ? "" : `<div class="empty">${hasFilters(s) ? "什么也没找到 ¯\\_(ツ)_/¯" : "还没有碎碎念，去频道里发一条吧。"}</div>`;
      renderFilterBar(hasFilters(s) ? view.list.length : null);
      updateEnd();
      if (scroll) scrollTo({ top: 0, behavior: "smooth" });
      await renderMore();
    } catch {
      if (seq === view.seq) toast("加载失败，请稍后再试");
    }
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

  /* ── 热力图：按当前日期重画（构建之后可能过了好几天），数据来自索引 ── */
  const HEAT_WEEKS = 20;
  function dayCounts(idx) {
    const counts = {};
    for (const p of idx.posts) counts[p.d] = (counts[p.d] || 0) + 1;
    return counts;
  }
  async function renderHeatmap() {
    const el = $("#heatmap");
    if (!el) return;
    const counts = dayCounts(await loadIndex());
    const today = todayKey();
    const start = addDays(today, -((HEAT_WEEKS - 1) * 7 + new Date(keyUTC(today)).getUTCDay()));
    let html = "";
    for (let d = start; d <= today; d = addDays(d, 1)) {
      const c = counts[d] || 0;
      html += `<i data-l="${Math.min(c, 4)}" data-day="${d}" title="${fmtMD(d)} · ${c ? `${c} 条` : "没有碎碎念"}"></i>`;
    }
    el.innerHTML = html;
    syncChrome();
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
      new IntersectionObserver(
        async (es) => {
          if (!es.some((e) => e.isIntersecting)) return;
          await ensureList().catch(() => {});
          renderMore();
        },
        { rootMargin: `${PRELOAD_PX}px 0px` },
      ).observe(end);
    }
    end?.addEventListener("click", () => ensureList().then(renderMore).catch(() => {}));
    addEventListener("popstate", () => applyState(readState(), { history: "none", scroll: false }));

    const q = $("#q");
    let timer;
    q?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => applyState({ ...state, q: q.value.trim() || null }, { history: "replace", scroll: false }), 250);
    });
    $("form.search")?.addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      applyState({ ...state, q: q.value.trim() || null });
      q.blur();
    });

    // 打开带筛选条件的链接（例如详情页里点了 #标签）
    if (hasFilters(state)) applyState(state, { history: "none", scroll: false });
    renderHeatmap().catch(() => {});
  }

  /* ── 日历（桌面：弹层；移动端：底部抽屉） ── */
  const cal = { el: $("#cal"), month: todayKey().slice(0, 8) + "01", pending: false };

  async function renderCal() {
    if (!cal.el) return;
    const first = cal.month;
    const [y, m] = first.split("-").map(Number);
    $("#cal-title").textContent = `${y} 年 ${m} 月`;
    const today = todayKey();
    const start = addDays(first, -new Date(keyUTC(first)).getUTCDay());
    const counts = await loadIndex()
      .then(dayCounts)
      .catch(() => ({}));
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
        cal.month = new Date(Date.UTC(y, m - 1 + Number(nav.dataset.cal), 1)).toISOString().slice(0, 10);
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
      video.innerHTML = `<video src="${esc(video.dataset.video)}" controls autoplay playsinline></video>`;
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
  syncChrome();
  afterRender(document);
})();
