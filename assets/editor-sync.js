/*!
 * EditorImageSync - Typecho Markdown 编辑器「图片一一对照」
 *
 * 左侧图片链接行贴编号缩略图, 右侧预览图打同号角标,
 * 点击右侧图片 -> 左侧跳到对应链接行尾并聚焦, 可直接接着码字。
 *
 * 依赖: jQuery / Typecho 原生 Markdown 编辑器(HyperDown + Pagedown)
 * 配置: window.TypechoEditorSyncConfig (由插件在加载本文件前输出)
 */
(function (window, $) {
    'use strict';

    if (!$ || !$.fn || !$.fn.jquery) {
        return;
    }

    const DEFAULTS = {
        enabled: true,
        sync: true,
        numbering: true,
        clickToLocate: true,
        followCursor: true,
        showTag: true,
        rootUrl: ''
    };

    const CFG = $.extend({}, DEFAULTS, window.TypechoEditorSyncConfig || {});

    // 声明接管: 之前手工改过 editor-js.php 的站点会据此让旧补丁休眠, 避免双实例
    let SELF_MUTATING = false,
        observer = null,
        observerTimer = null,
        reloadTimer = null,
        internalReload = null;

    // 原生 scrollableEditor 是「像素比例」换算, 有图片必然错位, 换成行号同步。
    // 保留原函数引用, 便于其它插件/调试时取回。
    if (CFG.sync && typeof window.scrollableEditor === 'function') {
        window.__typechoNativeScrollableEditor = window.scrollableEditor;
        window.scrollableEditor = function () {
            return function () {};
        };
    }

function editorScrollSync(textarea, preview) {
        const $ta = $(textarea), $pv = $(preview);
        const taEl = $ta[0], pvEl = $pv[0];
        const ROOT = String(CFG.rootUrl || '').replace(/\/+$/, '');
        const state = {
            lines: [], anchors: [], images: [], padTop: 0,
            lastWidth: -1, lastVisible: null
        };

        let progScroll = { editor: null, preview: null },
            refreshTimer = null,
            focusEl = null,
            lanesEl = null,
            peekEl = null,
            flashEl = null,
            tagEl = null,
            peekAnchor = null,
            activeNo = 0,
            flashTimer = null;

        function now() {
            return (window.performance && performance.now) ? performance.now() : Date.now();
        }

        function clamp(v, a, b) {
            return v < a ? a : (v > b ? b : v);
        }

        function visible(el) {
            return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }

        // 程序化滚动: 记下实际落点(可能被浏览器 clamp), 对应那一次 scroll 事件直接忽略。
        // 不依赖 rAF / 计时器, 后台标签页也不会留下残留标记。
        function scrollTo($el, target, key) {
            $el.scrollTop(target);
            progScroll[key] = $el.scrollTop();
        }

        /* ---------- 逐行测量编辑区高度(含自动换行) ---------- */
        function measureLines() {
            const el = taEl,
                cs = window.getComputedStyle(el),
                padT = parseFloat(cs.paddingTop) || 0,
                width = Math.max(40, el.clientWidth
                    - (parseFloat(cs.paddingLeft) || 0)
                    - (parseFloat(cs.paddingRight) || 0));
            const probe = document.createElement('div');

            probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;'
                + 'pointer-events:none;margin:0;padding:0;border:0;box-sizing:content-box;'
                + 'white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;'
                + 'width:' + width + 'px;'
                + 'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';'
                + 'font-weight:' + cs.fontWeight + ';font-style:' + cs.fontStyle + ';'
                + 'line-height:' + cs.lineHeight + ';letter-spacing:' + cs.letterSpacing + ';'
                + 'word-spacing:' + cs.wordSpacing + ';text-align:' + cs.textAlign + ';'
                + 'text-indent:' + cs.textIndent + ';';

            const rows = (el.value || '').split('\n');

            for (let i = 0; i < rows.length; i ++) {
                const d = document.createElement('div');
                // textarea 里的空行同样占一行高度
                d.textContent = rows[i] === '' ? '\u200b' : rows[i];
                probe.appendChild(d);
            }

            document.body.appendChild(probe);

            const kids = probe.childNodes,
                out = new Array(rows.length);

            for (let i = 0; i < rows.length; i ++) {
                out[i] = padT + kids[i].offsetTop + kids[i].offsetHeight;
            }

            document.body.removeChild(probe);

            state.padTop = padT;
            state.lines = out;
        }

        /* ---------- 预览侧每个源码块的真实位置 ---------- */
        function measureAnchors() {
            if (!visible(pvEl)) {
                return;
            }

            const base = pvEl.getBoundingClientRect().top - pvEl.scrollTop,
                nodes = pvEl.querySelectorAll('.line'),
                list = [];
            let prevTop = -1;

            for (let i = 0; i < nodes.length; i ++) {
                const el = nodes[i],
                    start = parseInt(el.getAttribute('data-start'), 10);

                if (isNaN(start)) {
                    continue;
                }

                let end = parseInt(el.getAttribute('data-end'), 10);
                if (isNaN(end) || end < start) {
                    end = start;
                }

                let top = el.getBoundingClientRect().top - base;
                if (top < prevTop) {
                    top = prevTop;
                }
                prevTop = top;

                list.push({start: start, end: end, top: top, height: 0, el: el});
            }

            for (let i = 0; i < list.length; i ++) {
                list[i].height = list[i + 1]
                    ? Math.max(1, list[i + 1].top - list[i].top)
                    : Math.max(1, pvEl.scrollHeight - list[i].top);
            }

            state.anchors = list;
            focusEl = null;
        }

        /* ---------- 正文里的图片: 按顺序编号 ----------
         * 一行可能有多张图, 同一地址也可能重复使用, 所以按「出现顺序」编号,
         * 并记录每张图语法结束的位置, 点图时把光标直接放在它后面。
         */
        function scanImages() {
            const rows = (taEl.value || '').split('\n'),
                // 注意: 这里的正则绝不能出现「小于号紧跟问号」这个字符序列 ——
                // 服务器开启 short_open_tag 时它会变成 PHP 开始标签, 整段 JS 会被当成 PHP
                // 解析并报 ParseError。写成字符类 [<] 加量词, 语义完全等价(可选的尖括号)。
                mdRe = /!\[[^\]]*\]\(\s*[<]?([^)\s>]+)/gi,
                htmlRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi,
                out = [];
            let lineStart = 0;

            for (let i = 0; i < rows.length; i ++) {
                const row = rows[i],
                    hits = [];
                let m;

                mdRe.lastIndex = 0;
                while ((m = mdRe.exec(row)) !== null) {
                    // 找到右括号: 光标落在整段 ![alt](url) 之后
                    const close = row.indexOf(')', m.index + m[0].length - 1),
                        end = close < 0 ? row.length : close + 1;

                    hits.push({pos: m.index, url: m[1], end: lineStart + end});
                }

                htmlRe.lastIndex = 0;
                while ((m = htmlRe.exec(row)) !== null) {
                    const gt = row.indexOf('>', m.index + m[0].length - 1),
                        end = gt < 0 ? row.length : gt + 1;

                    hits.push({pos: m.index, url: m[1], end: lineStart + end});
                }

                hits.sort(function (a, b) {
                    return a.pos - b.pos;
                });

                for (let j = 0; j < hits.length; j ++) {
                    out.push({
                        line: i,
                        url: hits[j].url,
                        caret: hits[j].end,
                        no: out.length + 1
                    });
                }

                lineStart += row.length + 1;
            }

            state.images = out;
        }

        function lineRange(line) {
            const L = state.lines;

            if (!L.length) {
                return {top: state.padTop, bottom: state.padTop + 20};
            }

            const i = clamp(line, 0, L.length - 1),
                top = i === 0 ? state.padTop : L[i - 1];

            return {top: top, bottom: Math.max(L[i], top + 1)};
        }

        function lineOffset(line) {
            const v = taEl.value || '';
            let pos = 0;

            for (let i = 0; i < line; i ++) {
                const n = v.indexOf('\n', pos);

                if (n < 0) {
                    return v.length;
                }

                pos = n + 1;
            }

            return pos;
        }

        function anchorAt(line) {
            const A = state.anchors;

            for (let i = 0; i < A.length; i ++) {
                if (line <= A[i].end) {
                    return A[i];
                }
            }

            return A.length ? A[A.length - 1] : null;
        }

        function imageAtLine(line, tolerance) {
            let best = null,
                bestD = (tolerance || 1) + 1;

            for (let i = 0; i < state.images.length; i ++) {
                const d = Math.abs(state.images[i].line - line);

                if (d < bestD) {
                    bestD = d;
                    best = state.images[i];
                }
            }

            return best;
        }

        /* ---------- 编辑区 → 预览 ---------- */
        function syncFromEditor() {
            if (!visible(pvEl) || !state.anchors.length || !state.lines.length) {
                return;
            }

            const st = $ta.scrollTop(),
                L = state.lines;
            let line = L.length - 1,
                frac = 1;

            for (let i = 0; i < L.length; i ++) {
                if (st < L[i]) {
                    const top = i === 0 ? state.padTop : L[i - 1];

                    line = i;
                    frac = (st - top) / Math.max(1, L[i] - top);
                    break;
                }
            }

            const a = anchorAt(line);

            if (!a) {
                return;
            }

            const span = Math.max(1, a.end - a.start + 1),
                f = clamp((line - a.start + clamp(frac, 0, 1)) / span, 0, 1),
                target = Math.max(0, a.top + a.height * f);

            if (Math.abs($pv.scrollTop() - target) > 2) {
                scrollTo($pv, target, 'preview');
            }

            const img = imageAtLine(line, 1);
            setActive(img ? img.no : 0);
        }

        /* ---------- 预览 → 编辑区 ---------- */
        function syncFromPreview() {
            if (!visible(pvEl) || !state.anchors.length || !state.lines.length) {
                return;
            }

            const st = $pv.scrollTop(),
                A = state.anchors;
            let a = A[0];

            for (let i = 0; i < A.length; i ++) {
                if (A[i].top <= st + 1) {
                    a = A[i];
                } else {
                    break;
                }
            }

            const f = clamp((st - a.top) / Math.max(1, a.height), 0, 1),
                span = Math.max(1, a.end - a.start + 1),
                exact = a.start + f * span,
                line = clamp(Math.floor(exact), a.start, a.end),
                r = lineRange(line),
                y = r.top + (r.bottom - r.top) * clamp(exact - line, 0, 1),
                target = Math.max(0, y - state.padTop);

            if (Math.abs($ta.scrollTop() - target) > 2) {
                scrollTo($ta, target, 'editor');
            }

            // 高亮预览顶部那张图, 让左右编号对得上
            const wraps = pvEl.querySelectorAll('.wmd-img-wrap');
            let no = 0;

            for (let i = 0; i < wraps.length; i ++) {
                const top = wraps[i].getBoundingClientRect().top
                    - pvEl.getBoundingClientRect().top;

                if (top <= 100) {
                    no = parseInt(wraps[i].getAttribute('data-no'), 10) || 0;
                } else {
                    break;
                }
            }

            setActive(no);
        }

        function cursorLine() {
            const v = taEl.value || '',
                pos = taEl.selectionStart || 0;
            let idx = -1,
                line = 0;

            while ((idx = v.indexOf('\n', idx + 1)) !== -1 && idx < pos) {
                line ++;
            }

            return line;
        }

        function blockOf(el) {
            let node = el;

            while (node && node !== pvEl) {
                if (/^(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|hr|figure|section|dl)$/i
                    .test(node.nodeName)) {
                    return node;
                }

                node = node.parentNode;
            }

            return el;
        }

        /* ---------- 光标跟随 ---------- */
        // updateActive=false: 只更新段落高亮, 不改写当前编号。
        // 预览刷新(图片陆续加载、全屏、resize)时会反复调用, 若每次都按光标位置
        // 重设编号, 光标停在文章开头就会把角标一直拽回 #1。
        function followCursor(scroll, updateActive) {
            if (!CFG.followCursor) {
                return;
            }

            if (!state.anchors.length) {
                return;
            }

            const line = cursorLine(),
                a = anchorAt(line);

            if (!a) {
                return;
            }

            const block = blockOf(a.el);

            if (focusEl && focusEl !== block) {
                $(focusEl).removeClass('focus');
            }

            focusEl = block;
            $(block).addClass('focus');

            const img = imageAtLine(line, 1);

            if (updateActive !== false) {
                setActive(img ? img.no : 0);
            }

            if (!scroll || !visible(pvEl)) {
                return;
            }

            const st = $pv.scrollTop(),
                h = $pv.innerHeight();
            let top = a.top,
                height = a.height;

            // 光标在图片行时, 直接以「那张图」为定位目标
            if (img) {
                const wrap = $pv.find('.wmd-img-wrap[data-no="' + img.no + '"]');

                if (wrap.length) {
                    top = wrap[0].getBoundingClientRect().top
                        - pvEl.getBoundingClientRect().top + st;
                    height = wrap[0].getBoundingClientRect().height;
                }
            }

            // 只有当前段落/图片不在可视范围内才滚动, 避免边打字边乱跳
            if (top < st + 8 || top + height > st + h - 8) {
                scrollTo($pv, Math.max(0, top - h * 0.18), 'preview');
            }
        }

        /* ---------- 图片 URL ---------- */
        function resolveUrl(u) {
            u = String(u || '');

            if (/^[a-z][a-z0-9+.\-]*:/i.test(u) || u.charAt(0) === '/' || !ROOT) {
                return u;
            }

            return ROOT + '/' + u.replace(/^\.?\//, '');
        }

        function fileName(u) {
            u = String(u || '').split('?')[0].split('#')[0];
            u = u.substring(u.lastIndexOf('/') + 1);

            try {
                return decodeURIComponent(u) || 'image';
            } catch (e) {
                return u || 'image';
            }
        }

        /* ---------- 高亮同一张图 ---------- */
        function applyActive() {
            if (lanesEl) {
                const lanes = lanesEl[0].querySelectorAll('.wmd-img-lane');

                for (let i = 0; i < lanes.length; i ++) {
                    const no = parseInt(lanes[i].getAttribute('data-no'), 10);
                    lanes[i].classList.toggle('current', no === activeNo);
                }
            }

            const wraps = pvEl.querySelectorAll('.wmd-img-wrap');

            for (let i = 0; i < wraps.length; i ++) {
                const no = parseInt(wraps[i].getAttribute('data-no'), 10);
                wraps[i].classList.toggle('current', no === activeNo);
            }

            if (tagEl) {
                updateTag();
            }
        }

        function setActive(no) {
            no = no || 0;

            if (no === activeNo) {
                return;
            }

            activeNo = no;
            applyActive();
            updateTag();
        }

        /* ---------- 预览右下角常驻「当前第几张图」 ---------- */
        function updateTag() {
            if (!tagEl) {
                tagEl = $('<div class="wmd-preview-tag" />').appendTo(document.body);
            }

            if (!visible(pvEl) || !activeNo || !state.images.length
                || !CFG.numbering || !CFG.showTag) {
                tagEl.removeClass('show');
                return;
            }

            const it = state.images[activeNo - 1],
                r = pvEl.getBoundingClientRect();

            tagEl.text('#' + activeNo + (it ? ' · 第 ' + (it.line + 1) + ' 行' : ''))
                .css({
                    left: Math.max(8, r.right - 150) + 'px',
                    top: Math.max(8, r.bottom - 34) + 'px'
                })
                .addClass('show');
        }

        /* ---------- 左侧: 与图片行对齐的缩略图条 ---------- */
        function ensureLanes() {
            if (!CFG.numbering) {
                return;
            }

            if (!lanesEl) {
                lanesEl = $('<div id="wmd-img-lanes" class="hidden" />').appendTo(document.body);

                lanesEl.on('mouseover', '.wmd-img-lane', function () {
                    const no = parseInt(this.getAttribute('data-no'), 10);
                    showPeek(state.images[no - 1], this);
                }).on('mouseleave', function () {
                    hidePeek();
                }).on('click', '.wmd-img-lane', function () {
                    const no = parseInt(this.getAttribute('data-no'), 10),
                        it = state.images[no - 1];

                    if (it) {
                        jumpToImageInPreview(it);
                    }
                });
            }

            lanesEl.empty();

            for (let i = 0; i < state.images.length; i ++) {
                const it = state.images[i],
                    lane = $('<div class="wmd-img-lane" />')
                        .attr('data-no', it.no)
                        .attr('title', '#' + it.no + ' · 第 ' + (it.line + 1)
                            + ' 行，点击让右侧定位到这张图')
                        .append($('<img alt="" />').attr('src', resolveUrl(it.url)))
                        .append($('<b />').text('#' + it.no));

                lanesEl.append(lane);
                it.laneObj = lane;
            }
        }

        function updateLanes() {
            if (!lanesEl) {
                return;
            }

            if (!visible(taEl) || !state.images.length || !state.lines.length
                || taEl.clientWidth < 520) {
                lanesEl.addClass('hidden');
                return;
            }

            const rect = taEl.getBoundingClientRect(),
                st = $ta.scrollTop(),
                h = $ta.innerHeight();

            lanesEl.removeClass('hidden').css({
                left: (rect.right - 78) + 'px',
                top: rect.top + 'px',
                height: h + 'px'
            });

            for (let i = 0; i < state.images.length; i ++) {
                const it = state.images[i],
                    lane = it.laneObj,
                    y = lineRange(it.line).top - st;

                if (!lane) {
                    continue;
                }

                if (y < -24 || y > h + 4) {
                    lane.css('display', 'none');
                } else {
                    lane.css({display: 'block', top: Math.max(0, y) + 'px'});
                }
            }
        }

        /* ---------- 悬停看大图 ---------- */
        function ensurePeek() {
            if (peekEl) {
                return;
            }

            peekEl = $('<div class="wmd-img-peek" aria-hidden="true">'
                + '<img alt="" /><span class="wmd-img-peek-cap"></span></div>')
                .appendTo(document.body);

            peekEl.children('img')
                .on('load', function () {
                    peekEl.removeClass('wmd-img-peek-err');
                    placePeek();
                })
                .on('error', function () {
                    peekEl.addClass('wmd-img-peek-err').removeClass('show');
                });
        }

        function placePeek() {
            if (!peekEl || !peekAnchor) {
                return;
            }

            const r = peekAnchor.getBoundingClientRect(),
                w = peekEl.outerWidth() || 220,
                h = peekEl.outerHeight() || 220;

            peekEl.css({
                left: Math.max(8, r.left - w - 10) + 'px',
                top: clamp(r.top - 30, 60,
                    Math.max(60, window.innerHeight - h - 12)) + 'px'
            });
        }

        function showPeek(it, anchor) {
            if (!it || !anchor) {
                return;
            }

            ensurePeek();
            peekAnchor = anchor;

            const url = resolveUrl(it.url),
                img = peekEl.children('img');

            if (img.attr('src') !== url) {
                peekEl.removeClass('wmd-img-peek-err');
                img.attr('src', url);
            }

            if (peekEl.hasClass('wmd-img-peek-err')) {
                return;
            }

            peekEl.children('.wmd-img-peek-cap').text(
                '#' + it.no + ' · 第 ' + (it.line + 1) + ' 行 · ' + fileName(it.url));
            peekEl.addClass('show');
            placePeek();
        }

        function hidePeek() {
            if (peekEl) {
                peekEl.removeClass('show');
            }
        }

        /* ---------- 右侧: 给每张图打编号、可点击 ---------- */
        function decoratePreview() {
            if (!CFG.numbering && !CFG.clickToLocate) {
                return;
            }

            if (!visible(pvEl)) {
                return;
            }

            const imgs = pvEl.querySelectorAll('img'),
                used = [];

            for (let i = 0; i < imgs.length; i ++) {
                const img = imgs[i];

                if (img.parentNode
                    && img.parentNode.className === 'wmd-img-wrap') {
                    const oldNo = parseInt(img.parentNode.getAttribute('data-no'), 10);

                    if (oldNo && state.images[oldNo - 1]) {
                        used[oldNo - 1] = true;
                    }

                    continue;
                }

                const src = img.getAttribute('src') || '';
                let it = null,
                    pick = -1;

                // 1) URL 相同的第一张未使用图片
                for (let j = 0; j < state.images.length; j ++) {
                    if (used[j]) {
                        continue;
                    }

                    const u = state.images[j].url;

                    if (u === src || resolveUrl(u) === src || resolveUrl(u) === img.src) {
                        it = state.images[j];
                        pick = j;
                        break;
                    }
                }

                // 2) 兜底: 按文档顺序取下一张未使用的
                if (!it) {
                    for (let j = 0; j < state.images.length; j ++) {
                        if (!used[j]) {
                            it = state.images[j];
                            pick = j;
                            break;
                        }
                    }
                }

                if (!it) {
                    continue;
                }

                used[pick] = true;

                const wrap = document.createElement('span');
                wrap.className = 'wmd-img-wrap';
                wrap.setAttribute('data-no', it.no);
                wrap.setAttribute('data-line', it.line);
                wrap.setAttribute('data-caret', it.caret);
                wrap.setAttribute('title', '#' + it.no
                    + ' · 点击定位到左侧第 ' + (it.line + 1) + ' 行');

                img.parentNode.insertBefore(wrap, img);
                wrap.appendChild(img);

                if (CFG.numbering) {
                    const badge = document.createElement('b');
                    badge.className = 'wmd-img-no';
                    badge.textContent = '#' + it.no;
                    wrap.appendChild(badge);
                }
            }

            applyActive();
        }

        /* ---------- 点击右侧图片 → 左侧跳到图片链接并接着写 ---------- */
        function jumpToLine(line, no, caret) {
            const v = taEl.value || '',
                start = lineOffset(line);
            let end = v.indexOf('\n', start);

            if (end < 0) {
                end = v.length;
            }

            // 优先落在这一张图片语法的末尾; 单图独占一行时就是行尾
            if (typeof caret === 'number' && !isNaN(caret)) {
                end = clamp(caret, 0, v.length);
            }

            // 光标放在图片链接之后, 键盘可以直接接着码字
            taEl.focus();
            taEl.setSelectionRange(end, end);

            // 让这一行落在编辑区上三分之一处, 并抑制一次反向同步
            const y = Math.max(0, lineRange(line).top - state.padTop
                - $ta.innerHeight() * 0.28);
            scrollTo($ta, y, 'editor');
            setActive(no || 0);
            flashLine(line, no);
            followCursor(false);
            updateLanes();
            updateTag();
            return false;
        }

        function flashLine(line, no) {
            const rect = taEl.getBoundingClientRect(),
                r = lineRange(line),
                y = r.top - $ta.scrollTop(),
                h = Math.max(18, r.bottom - r.top);

            if (!flashEl) {
                flashEl = $('<div class="wmd-line-flash" />').appendTo(document.body);
            }

            flashEl.text('第 ' + (line + 1) + ' 行' + (no ? ' · 图片 #' + no : ''))
                .css({
                    left: (rect.left + 12) + 'px',
                    top: clamp(rect.top + y, rect.top, rect.bottom - h) + 'px',
                    width: (rect.width - 24) + 'px',
                    height: h + 'px'
                })
                .removeClass('on');

            // 强制重排, 让动画每次都能重新播放
            void flashEl[0].offsetWidth;
            flashEl.addClass('on');

            clearTimeout(flashTimer);
            flashTimer = setTimeout(function () {
                flashEl.removeClass('on');
            }, 1600);
        }

        /* ---------- 点击左侧缩略图 → 右侧定位到这张图 ---------- */
        function jumpToImageInPreview(it) {
            const wrap = $pv.find('.wmd-img-wrap[data-no="' + it.no + '"]');

            if (wrap.length) {
                const top = wrap[0].getBoundingClientRect().top
                    - pvEl.getBoundingClientRect().top + $pv.scrollTop();

                scrollTo($pv, Math.max(0, top - 8), 'preview');
            }

            setActive(it.no);
            hidePeek();
            return false;
        }

        /* ---------- 统一刷新 ---------- */
        // previewOnly: 只有预览变了(图片加载完等), 编辑区文字没动, 不必逐行重测
        function refresh(previewOnly) {
            SELF_MUTATING = true;

            try {
            const vis = visible(taEl),
                width = taEl.clientWidth;

            // 预览刷新本身不改正文; 但编辑区宽度/可见性变了(进全屏、切标签)必须重新逐行测量
            if (!previewOnly || width !== state.lastWidth || vis !== state.lastVisible) {
                measureLines();
                scanImages();
                ensureLanes();
            }

            state.lastWidth = width;
            state.lastVisible = vis;

            measureAnchors();
            decoratePreview();
            applyActive();
            followCursor(false, false);
            updateLanes();
            updateTag();
            } finally {
                SELF_MUTATING = false;

                if (observer) {
                    observer.takeRecords();
                }
            }
        }

        function scheduleRefresh(delay) {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(function () {
                refresh(false);
            }, delay || 160);
        }

        /* ---------- 事件 ---------- */
        $ta.on('scroll', function () {
            if (!CFG.sync) {
                updateLanes();
                return;
            }

            const mine = progScroll.editor !== null
                && Math.abs($ta.scrollTop() - progScroll.editor) <= 1;

            progScroll.editor = null;

            if (mine) {
                updateLanes();
                return;
            }

            syncFromEditor();
            updateLanes();
            updateTag();
        });

        $pv.on('scroll', function () {
            if (!CFG.sync) {
                return;
            }

            const mine = progScroll.preview !== null
                && Math.abs($pv.scrollTop() - progScroll.preview) <= 1;

            progScroll.preview = null;

            if (mine) {
                return;
            }

            syncFromPreview();
            updateLanes();
            updateTag();
        });

        $ta.on('keyup click select input', function () {
            followCursor(true);
            updateLanes();
            updateTag();
            hidePeek();
        });

        $ta.on('input', function () {
            scheduleRefresh(180);
        });

        pvEl.addEventListener('click', function (e) {
            const img = e.target && e.target.tagName === 'IMG' ? e.target : null;

            if (!img || !pvEl.contains(img) || !CFG.clickToLocate) {
                return;
            }

            const wrap = img.parentNode && img.parentNode.className === 'wmd-img-wrap'
                ? img.parentNode : null;

            if (!wrap) {
                return;
            }

            const line = parseInt(wrap.getAttribute('data-line'), 10),
                no = parseInt(wrap.getAttribute('data-no'), 10) || 0,
                caret = parseInt(wrap.getAttribute('data-caret'), 10);

            if (!isNaN(line)) {
                e.preventDefault();

                // 非全屏(撰写/预览 标签)模式: 先切回撰写, 再定位
                if (!visible(taEl)) {
                    $('.wmd-edittab a[href="#wmd-editarea"]').trigger('click');
                }

                jumpToLine(line, no, caret);
            }
        }, false);

        pvEl.addEventListener('load', function (e) {
            if (e.target && e.target.tagName === 'IMG') {
                clearTimeout(refreshTimer);
                refreshTimer = setTimeout(function () {
                    refresh(true);
                }, 80);
            }
        }, true);

        $(window).on('resize', function () {
            scheduleRefresh(120);
        }).on('scroll', function () {
            updateLanes();
            updateTag();
            hidePeek();
        });

        refresh();

        return function () {
            refresh(true);
        };
    }

    /* ------------------------------------------------------------------ *
     * 对外接口
     * ------------------------------------------------------------------ */
    const API = {
        claimed: true,
        booted: false,
        version: '1.0.1',

        /**
         * 由 admin/editor-js.php 的 markdownEditor 钩子调用。
         * 该钩子与 textarea / preview / editor 处于同一作用域, 因此可直接传入。
         */
        boot: function (ta, pv, opts) {
            opts = opts || {};

            if (API.booted) {
                return API;
            }

            if (!CFG.enabled) {
                return null;
            }

            const $ta = $(ta && ta.length !== undefined ? ta : '#text'),
                $pv = $(pv && pv.length !== undefined ? pv : '#wmd-preview');

            // 富编辑器插件接管 / 非写作页 / DOM 结构不同 -> 静默跳过
            if (!$ta.length || !$pv.length || !$ta.is('textarea')) {
                return null;
            }

            if ($ta.attr('data-eis-booted')) {
                return API;
            }

            $ta.attr('data-eis-booted', '1');
            API.editorEl = $ta[0];
            API.previewEl = $pv[0];

            // 兼容「后台还留着旧手工补丁」的站点: 那份补丁会先于本插件初始化,
            // 给 #text / #wmd-preview 各挂一个 scroll 监听。两套同步互相设置
            // scrollTop, 表现就是往下滑又弹回 #1、点图也弹回。
            // 绑定自己的监听前先清掉这两个元素上已有的 scroll 监听; 只清 scroll
            // 这一个类型, Typecho 自己的 input / change / paste 一律保留。
            // 后台已还原成原版时这里没有监听可清, 属于空操作。
            $ta.off('scroll');
            $pv.off('scroll');

            internalReload = editorScrollSync($ta[0], $pv[0]);
            API.booted = true;

            // 兜底通道(钩子缺失的老版本): 用 DOM 变化代替 onPreviewRefresh
            if (opts.useObserver && window.MutationObserver) {
                observer = new window.MutationObserver(function () {
                    if (SELF_MUTATING) {
                        return;
                    }

                    clearTimeout(observerTimer);
                    observerTimer = setTimeout(function () {
                        API.reload();
                    }, 140);
                });
                observer.observe($pv[0], {childList: true, subtree: true});
            }

            return API;
        },

        /** 预览刷新后重新测量: 立即对齐一次, 图片异步加载完再补一次 */
        reload: function () {
            if (!internalReload) {
                return;
            }

            internalReload(true);
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(function () {
                internalReload(true);
            }, 420);
        },

        destroy: function () {
            if (observer) {
                observer.disconnect();
                observer = null;
            }

            clearTimeout(observerTimer);
            clearTimeout(reloadTimer);
            API.booted = false;
            internalReload = null;

            if (API.editorEl) {
                $(API.editorEl).removeAttr('data-eis-booted');
            }
        }
    };

    window.TypechoEditorSync = API;
})(window, window.jQuery);
