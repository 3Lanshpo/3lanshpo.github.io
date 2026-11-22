/* 高考化学虚拟实验室 —— 交互引擎
 * 视图：实验图谱 / 实验播放器(SVG+嵌问) / 真题演练 / 错题本 / 看板
 * 进度存 localStorage；测试钩子挂 window.__cl
 */
(function () {
  'use strict';

  var D = window.LAB_DATA;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(function (n) { if (n) node.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); }); return; }
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function showScreen(name) {
    $$('.screen').forEach(function (s) { s.classList.remove('active'); });
    $('#screen-' + name).classList.add('active');
    window.scrollTo(0, 0);
  }

  // ---------------- state ----------------
  var KEY = 'chemlab_v1';
  var state = { name: '', tab: 'map', exp: {}, qz: {}, wrong: [] };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object') {
      state.name = saved.name || '';
      state.exp = saved.exp || {};
      state.qz = saved.qz || {};
      state.wrong = saved.wrong || [];
    }
  } catch (e) { /* corrupted -> fresh */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function expState(id) {
    if (!state.exp[id]) state.exp[id] = { step: 0, asks: {}, finished: false };
    return state.exp[id];
  }

  // ---------------- SVG 装置库 ----------------
  // 简笔风：每种仪器一个绘制函数，返回 <g> 字符串。坐标以 720x360 画布。
  var SVG_PARTS = {
    heater: function (x, y) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M10 46 L26 8 L42 46 Z" fill="#f59e0b" stroke="#b45309" stroke-width="2"/>' +
      '<rect x="0" y="46" width="52" height="8" rx="2" fill="#64748b"/>' +
      '<path d="M26 4 q4 -8 0 -12 q-5 -6 0 -12 q3 6 0 12 q-3 5 0 12z" fill="#fbbf24"/>' +
      '</g>'; },
    flask: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M22 0 L22 22 L4 52 a6 6 0 0 0 5 9 h36 a6 6 0 0 0 5 -9 L32 22 L32 0" fill="rgba(148,233,229,0.45)" stroke="#0f766e" stroke-width="2.2" fill-rule="evenodd"/>' +
      '<rect x="16" y="-6" width="22" height="7" rx="2" fill="#0f766e"/>' +
      (label ? '<text x="26" y="80" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    sepfunnel: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M14 0 h18 l-4 20 h-10 z" fill="rgba(251,191,36,0.4)" stroke="#0f766e" stroke-width="2"/>' +
      '<path d="M20 20 h6 v10 h-6 z M17 30 h12 l-5 14 z" fill="none" stroke="#0f766e" stroke-width="2"/>' +
      '<circle cx="23" cy="46" r="2.4" fill="#0f766e"/>' +
      (label ? '<text x="23" y="72" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    washbottle: function (x, y, fill, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<rect x="0" y="6" width="46" height="40" rx="7" fill="rgba(191,219,254,0.5)" stroke="#0f766e" stroke-width="2.2"/>' +
      '<rect x="0" y="6" width="46" height="24" rx="7" fill="' + (fill || 'rgba(191,219,254,0.85)') + '"/>' +
      '<path d="M4 4 L4 -10 M42 4 L42 -4" stroke="#0f766e" stroke-width="2.4"/>' +
      (label ? '<text x="23" y="66" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    drytube: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M6 -8 h34 l-8 20 a9 9 0 0 1 -18 0 z" transform="rotate(180 23 10)" fill="rgba(254,215,170,0.6)" stroke="#0f766e" stroke-width="2"/>' +
      '<path d="M8 -14 v8 M38 -14 v-2" stroke="#0f766e" stroke-width="2.4"/>' +
      (label ? '<text x="23" y="52" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    gasjar: function (x, y, up, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      (up
        ? '<rect x="0" y="0" width="50" height="56" rx="5" fill="rgba(167,243,208,0.4)" stroke="#0f766e" stroke-width="2.2"/><path d="M8 2 L8 -12 M50 0 h8" stroke="#0f766e" stroke-width="2.4"/>'
        : '<rect x="0" y="0" width="50" height="56" rx="5" fill="rgba(167,243,208,0.4)" stroke="#0f766e" stroke-width="2.2" transform="translate(0,10)"/><path d="M8 44 L8 58 M50 12 h8" stroke="#0f766e" stroke-width="2.4"/>') +
      (label ? '<text x="25" y="82" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    tube: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<rect x="0" y="0" width="26" height="86" rx="4" fill="rgba(148,233,229,0.4)" stroke="#0f766e" stroke-width="2" transform="rotate(-8 13 43)"/>' +
      (label ? '<text x="10" y="106" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    beaker: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M0 0 v44 a5 5 0 0 0 5 5 h36 a5 5 0 0 0 5 -5 v-44" fill="rgba(148,233,229,0.4)" stroke="#0f766e" stroke-width="2.2"/>' +
      '<path d="M0 0 h-6" stroke="#0f766e" stroke-width="2"/>' +
      (label ? '<text x="22" y="72" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    condenser: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<rect x="0" y="10" width="110" height="20" rx="10" fill="rgba(191,219,254,0.6)" stroke="#0f766e" stroke-width="2.2"/>' +
      '<path d="M18 10 v-10 M18 30 v10 M92 10 v-10 M92 30 v10" stroke="#0f766e" stroke-width="2"/>' +
      (label ? '<text x="55" y="66" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    burette: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M12 0 v96 l6 8 l6 -8 v-96" fill="rgba(148,233,229,0.35)" stroke="#0f766e" stroke-width="2"/>' +
      '<path d="M12 0 h12 M14 14 h8 M14 30 h8 M14 46 h8 M14 62 h8 M14 78 h8" stroke="#0f766e" stroke-width="1.4"/>' +
      (label ? '<text x="18" y="126" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; },
    conical: function (x, y, label) { return '<g transform="translate(' + x + ',' + y + ')">' +
      '<path d="M14 0 h18 l14 44 a5 5 0 0 1 -5 7 h-36 a5 5 0 0 1 -5 -7 z" fill="rgba(148,233,229,0.4)" stroke="#0f766e" stroke-width="2.2"/>' +
      '<path d="M18 34 h26" stroke="#f472b6" stroke-width="3" opacity="0.7"/>' +
      (label ? '<text x="24" y="78" font-size="13" text-anchor="middle" fill="#334155">' + label + '</text>' : '') +
      '</g>'; }
  };

  // 每个实验的舞台配置：parts 数组 [{k, x, y, label}] + 高亮步骤 hl: {idx: [partIdx,...]}
  function stageSVG(exp, stepIdx) {
    var cfg = EXP_STAGE[exp.id];
    if (!cfg) return '';
    var body = '';
    cfg.parts.forEach(function (p, i) {
      var dim = cfg.hl && cfg.hl[stepIdx] && cfg.hl[stepIdx].indexOf(i) === -1;
      body += '<g opacity="' + (dim ? '0.28' : '1') + '">' + SVG_PARTS[p.k](p.x, p.y, p.label) + '</g>';
      if (cfg.hl && cfg.hl[stepIdx] && cfg.hl[stepIdx].indexOf(i) !== -1) {
        body += '<circle cx="' + (p.x + 25) + '" cy="' + (p.y + 25) + '" r="34" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="5 4"><animate attributeName="r" values="30;38;30" dur="1.6s" repeatCount="indefinite"/></circle>';
      }
    });
    // 连接导管（简化示意横线）
    if (cfg.flow) body += '<path d="' + cfg.flow + '" fill="none" stroke="#94a3b8" stroke-width="3" stroke-dasharray="7 5"/>';
    return '<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
  }

  var EXP_STAGE = {
    'cl2': {
      parts: [
        { k: 'sepfunnel', x: 90, y: 40, label: '浓盐酸' },
        { k: 'flask', x: 110, y: 90, label: 'MnO₂+浓盐酸' },
        { k: 'heater', x: 118, y: 170 },
        { k: 'washbottle', x: 250, y: 60, fill: 'rgba(147,197,253,0.9)', label: '饱和食盐水' },
        { k: 'washbottle', x: 380, y: 60, fill: 'rgba(254,215,170,0.9)', label: '浓硫酸' },
        { k: 'gasjar', x: 500, y: 40, up: true, label: '向上排空气' },
        { k: 'beaker', x: 620, y: 60, label: 'NaOH 尾气' }
      ],
      hl: { 0: [0, 1], 1: [0, 1], 2: [2], 3: [3], 4: [4], 5: [5], 6: [6] },
      flow: 'M160 60 C200 40 220 50 250 50 M296 50 C330 50 350 50 380 50 M426 50 C460 50 480 45 500 40 M550 40 C580 40 600 55 620 60'
    },
    'nh3': {
      parts: [
        { k: 'tube', x: 120, y: 60, label: 'NH₄Cl+Ca(OH)₂' },
        { k: 'heater', x: 128, y: 165 },
        { k: 'drytube', x: 280, y: 70, label: '碱石灰' },
        { k: 'gasjar', x: 420, y: 40, up: false, label: '向下排空气' },
        { k: 'beaker', x: 570, y: 60, label: '水（防倒吸）' }
      ],
      hl: { 0: [0], 1: [1], 2: [2], 3: [3], 4: [4] },
      flow: 'M150 70 C220 55 250 60 280 55 M330 60 C380 55 400 50 420 45 M470 42 C520 45 550 55 570 62'
    },
    'titration': {
      parts: [
        { k: 'burette', x: 300, y: 20, label: '碱式滴定管' },
        { k: 'conical', x: 330, y: 130, label: '锥形瓶+待测液' }
      ],
      hl: { 0: [0], 1: [1], 2: [1], 3: [1], 4: [0], 5: [] }
    },
    'distill': {
      parts: [
        { k: 'flask', x: 110, y: 80, label: '蒸馏烧瓶' },
        { k: 'heater', x: 118, y: 170 },
        { k: 'condenser', x: 240, y: 60, label: '冷凝管（低进高出）' },
        { k: 'beaker', x: 400, y: 60, label: '锥形瓶接液' }
      ],
      hl: { 0: [0], 1: [1], 2: [2], 3: [3] },
      flow: 'M165 80 L245 55 M350 55 L410 70'
    },
    'extract': {
      parts: [
        { k: 'sepfunnel', x: 300, y: 30, label: '分液漏斗' },
        { k: 'beaker', x: 290, y: 140, label: '烧杯承接' }
      ],
      hl: { 0: [0], 2: [0], 3: [0, 1] }
    },
    'ester': {
      parts: [
        { k: 'flask', x: 130, y: 80, label: '乙醇+浓硫酸+乙酸' },
        { k: 'heater', x: 138, y: 170 },
        { k: 'condenser', x: 250, y: 55, label: '导管' },
        { k: 'beaker', x: 420, y: 60, label: '饱和Na₂CO₃' }
      ],
      hl: { 0: [0], 1: [1], 2: [2], 3: [3] },
      flow: 'M180 85 L255 50 M355 50 L425 65'
    },
    'filter-evo': {
      parts: [
        { k: 'beaker', x: 180, y: 70, label: '烧杯' },
        { k: 'tube', x: 300, y: 60, label: '漏斗+滤纸' },
        { k: 'beaker', x: 420, y: 70, label: '滤液' }
      ],
      hl: { 0: [0], 1: [1], 2: [2] },
      flow: 'M210 90 L305 95'
    },
    'conc-solution': {
      parts: [
        { k: 'beaker', x: 170, y: 80, label: '溶解' },
        { k: 'tube', x: 310, y: 60, label: '玻璃棒引流' },
        { k: 'washbottle', x: 420, y: 55, fill: 'rgba(148,233,229,0.4)', label: '容量瓶' }
      ],
      hl: { 1: [0], 2: [1], 3: [2], 4: [2], 5: [2] },
      flow: 'M205 95 L315 90 M340 85 L430 70'
    },
    'airtight': {
      parts: [
        { k: 'tube', x: 200, y: 60, label: '试管' },
        { k: 'heater', x: 208, y: 165 },
        { k: 'beaker', x: 380, y: 70, label: '水槽' }
      ],
      hl: { 0: [0, 2], 1: [1], 2: [2] },
      flow: 'M230 65 L390 75'
    },
    'ion-test': {
      parts: [{ k: 'tube', x: 300, y: 60, label: '取样检验' }], hl: {}
    },
    'rate-factors': {
      parts: [{ k: 'conical', x: 300, y: 80, label: '计时对比' }], hl: {}
    },
    'fe2-fe3': {
      parts: [{ k: 'tube', x: 300, y: 60, label: 'KSCN 检验' }], hl: {}
    }
  };

  // ---------------- 视图：实验图谱 ----------------
  function renderMap() {
    var page = $('#main-page'); clear(page);
    var done = D.EXPERIMENTS.filter(function (e) { return state.exp[e.id] && state.exp[e.id].finished; }).length;
    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, ['高中化学核心实验 · ' + D.EXPERIMENTS.length + ' 个']),
      el('div', { class: 'pbar' }, [el('i', { style: 'width:' + Math.round(done / D.EXPERIMENTS.length * 100) + '%' })]),
      el('div', { class: 'hint' }, ['已完成 ' + done + ' / ' + D.EXPERIMENTS.length + ' · 覆盖近10年高考实验题七大命题板块'])
    ]));
    var grid = el('div', { class: 'cat-grid' });
    D.CATS.forEach(function (cat) {
      var exps = D.EXPERIMENTS.filter(function (e) { return e.cat === cat.id; });
      var doneN = exps.filter(function (e) { return state.exp[e.id] && state.exp[e.id].finished; }).length;
      grid.appendChild(el('button', { class: 'cat-card', type: 'button', onclick: function () { openCat(cat.id); } }, [
        el('div', { class: 'cat-icon' }, [cat.icon]),
        el('div', { class: 'cat-name' }, [cat.name]),
        el('div', { class: 'cat-desc' }, [cat.desc]),
        el('div', { class: 'cat-count' }, [doneN + '/' + exps.length + ' 已完成'])
      ]));
    });
    page.appendChild(grid);
    page.appendChild(el('div', { class: 'card', style: 'margin-top:12px' }, [
      el('div', { class: 'card-title' }, ['🎯 高考实验题命题规律']),
      el('div', { class: 'hint', style: 'margin-top:8px' }, [
        '实验综合题按「原理→操作→现象→数据→误差」五段命题，分三大模型：',
        el('b', null, ['物质制备']), '（发生→除杂→干燥→收集→尾气全链路）、',
        el('b', null, ['实验探究']), '（控制变量、证据推理、方案评价）、',
        el('b', null, ['定量测定']), '（滴定/热重，误差归因到 V）。所有实验都以此为纲设计嵌问。'
      ])
    ]));
  }

  function openCat(catId) {
    var cat = D.CATS.find(function (c) { return c.id === catId; });
    var page = $('#main-page'); clear(page);
    state.catOpen = catId;
    $('#main-title').textContent = cat.icon + ' ' + cat.name;
    page.appendChild(el('button', { class: 'btn ghost', type: 'button', style: 'width:100%;margin-bottom:12px', onclick: function () { switchTab('map'); } }, ['← 返回图谱']));
    var card = el('div', { class: 'card' });
    D.EXPERIMENTS.filter(function (e) { return e.cat === catId; }).forEach(function (e) {
      var st = expState(e.id);
      var asksTotal = e.steps.filter(function (s) { return s.ask; }).length;
      var right = Object.keys(st.asks).filter(function (k) { return st.asks[k] === true; }).length;
      card.appendChild(el('button', { class: 'exp-row', type: 'button', onclick: function () { openExp(e.id); } }, [
        el('div', { class: 'exp-emoji' }, ['🔬']),
        el('div', { class: 'exp-info' }, [
          el('div', { class: 'exp-name' }, [e.title, ' ', el('span', { class: 'chip diff' + e.diff }, ['难度' + '★'.repeat(e.diff)])]),
          el('div', { class: 'exp-goal' }, [e.goal])
        ]),
        el('div', { class: 'exp-prog' }, [st.finished ? '✅' : (asksTotal ? right + '/' + asksTotal : '')])
      ]));
    });
    page.appendChild(card);
    window.scrollTo(0, 0);
  }

  // ---------------- 实验播放器 ----------------
  var cur = { expId: null };
  function openExp(expId) {
    cur.expId = expId;
    var e = D.EXPERIMENTS.find(function (x) { return x.id === expId; });
    var st = expState(expId);
    if (st.step >= e.steps.length) st.step = 0;
    $('#sub-title').textContent = e.title;
    $('#sub-tag').textContent = e.goal;
    showScreen('sub');
    renderStep();
  }

  function renderStep() {
    var e = D.EXPERIMENTS.find(function (x) { return x.id === cur.expId; });
    var st = expState(e.id);
    var page = $('#sub-page'); clear(page);

    if (st.step >= e.steps.length) { renderExpDone(e, st); return; }
    var step = e.steps[st.step];

    // 舞台
    var svg = stageSVG(e, st.step);
    if (svg) page.appendChild(el('div', { class: 'sim-stage' }, [el('div', { html: svg })]));

    // 步骤
    var card = el('div', { class: 'card' }, [
      el('div', { class: 'step-no' }, ['STEP ' + (st.step + 1) + ' / ' + e.steps.length]),
      el('div', { class: 'step-text' }, [step.t])
    ]);
    if (step.phe) card.appendChild(el('div', { class: 'step-phe', html: '<b>现象：</b>' + step.phe }));
    if (step.point) card.appendChild(el('div', { class: 'point-box', html: '<b>🎯 考点：</b>' + step.point }));
    page.appendChild(card);

    // 嵌问
    if (step.ask) {
      page.appendChild(renderAsk(e, st, step.ask, st.step));
    }

    // 导航
    var answered = !step.ask || st.asks[st.step] !== undefined;
    page.appendChild(el('div', { class: 'step-nav' }, [
      el('button', { class: 'btn ghost', type: 'button', disabled: st.step === 0 ? '' : null, onclick: function () { st.step = Math.max(0, st.step - 1); save(); renderStep(); } }, ['上一步']),
      el('button', { class: 'btn primary', type: 'button', disabled: answered ? null : '', onclick: function () { st.step++; save(); renderStep(); } }, [st.step === e.steps.length - 1 ? '完成实验' : '下一步 →'])
    ]));
    window.scrollTo(0, 0);
  }

  function renderAsk(e, st, ask, stepIdx) {
    var box = el('div', { class: 'ask' }, [el('div', { class: 'ask-q' }, ['💡 ' + ask.q])]);
    var answered = st.asks[stepIdx] !== undefined;
    ask.o.forEach(function (opt, i) {
      var cls = 'opt';
      if (answered) {
        if (i === ask.a) cls += ' right';
        else if (i === st.asks[stepIdx].picked) cls += ' wrong';
      }
      var btn = el('button', { class: cls, type: 'button' }, [(String.fromCharCode(65 + i)) + '. ' + opt]);
      btn.disabled = answered;
      if (!answered) btn.addEventListener('click', function () {
        var right = i === ask.a;
        st.asks[stepIdx] = { picked: i, right: right };
        if (!right) addWrong({ id: e.id + ':' + stepIdx, type: 'exp', stem: e.title + ' —— ' + ask.q, ans: '正确答案：' + String.fromCharCode(65 + ask.a) + '. ' + ask.o[ask.a], e: ask.e, src: '实验嵌问' });
        save();
        toast(right ? '✅ 回答正确' : '❌ 答错了，看看解析');
        renderStep();
      });
      box.appendChild(btn);
    });
    if (answered) box.appendChild(el('div', { class: 'ask-e', html: '<b>解析：</b>' + ask.e }));
    return box;
  }

  function renderExpDone(e, st) {
    var asks = e.steps.filter(function (s) { return s.ask; });
    var right = asks.filter(function (s, i) { return st.asks[e.steps.indexOf(s)] && st.asks[e.steps.indexOf(s)].right; }).length;
    st.finished = true; save();
    var page = $('#sub-page'); clear(page);
    page.appendChild(el('div', { class: 'card done-banner' }, [
      el('div', { class: 'big' }, ['🎉']),
      el('h2', null, ['实验完成！']),
      el('div', { class: 'hint' }, ['嵌问正确 ' + right + ' / ' + asks.length])
    ]));
    var card = el('div', { class: 'card' }, [el('div', { class: 'card-title' }, ['⚠️ 易错警示'])]);
    e.pitfalls.forEach(function (p) { card.appendChild(el('div', { class: 'hint', style: 'margin-top:6px' }, ['· ' + p])); });
    page.appendChild(card);
    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, ['🔗 高考关联']),
      el('div', { class: 'hint', style: 'margin-top:6px' }, [e.gaokao])
    ]));
    page.appendChild(el('div', { class: 'step-nav' }, [
      el('button', { class: 'btn ghost', type: 'button', onclick: function () { st.step = 0; st.finished = true; save(); renderStep(); } }, ['🔄 再做一遍']),
      el('button', { class: 'btn primary', type: 'button', onclick: function () { switchTab(state.catOpen || 'map'); if (state.catOpen) openCat(state.catOpen); } }, ['返回图谱'])
    ]));
  }

  // ---------------- 真题演练 ----------------
  var quizFilter = { year: '全部' };
  function renderQuiz() {
    var page = $('#main-page'); clear(page);
    $('#main-title').textContent = '真题演练';
    var years = ['全部', '2024', '2023', '2022', '经典'];
    var chips = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' });
    years.forEach(function (y) {
      chips.appendChild(el('button', { class: 'chip', type: 'button', style: y === quizFilter.year ? '' : 'background:#eef1f6;color:#64748b', onclick: function () { quizFilter.year = y; renderQuiz(); } }, [y]));
    });
    page.appendChild(chips);

    var list = D.QUESTIONS.filter(function (q) { return quizFilter.year === '全部' || q.year === quizFilter.year; });
    if (!list.length) { page.appendChild(el('div', { class: 'card hint' }, ['该年份暂无题目'])); return; }

    list.forEach(function (q, idx) {
      page.appendChild(renderQuestion(q, 'qz', idx + 1));
    });
  }

  // q: 题目；mode: 'qz' | 'redo'
  function renderQuestion(q, mode, no) {
    var rec = state.qz[q.id];
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'qz-head' }, [
      el('span', { class: 'qz-src' }, [q.src + (mode === 'redo' ? ' · 错题重做' : '')]),
      rec ? el('span', { class: 'chip', style: rec.right ? 'background:var(--ok-soft);color:var(--ok)' : 'background:var(--bad-soft);color:var(--bad)' }, [rec.right ? '✓ 已做对' : '✗ 曾做错']) : el('span', null, [''])
    ]));
    card.appendChild(el('div', { class: 'qz-stem' }, [(no ? no + '. ' : '') + q.stem]));

    var multi = q.type === 'multi';
    var picked = multi ? [] : null;
    var answered = rec && rec.answered;

    var optsBox = el('div');
    q.opts.forEach(function (opt, i) {
      var cls = 'opt';
      var ansArr = Array.isArray(q.a) ? q.a : [q.a];
      if (answered) {
        if (ansArr.indexOf(i) !== -1) cls += ' right';
        else if (rec.picked && rec.picked.indexOf(i) !== -1) cls += ' wrong';
      }
      var b = el('button', { class: cls, type: 'button' }, [(String.fromCharCode(65 + i)) + '. ' + opt]);
      b.disabled = !!answered;
      if (!answered) b.addEventListener('click', function () {
        if (multi) {
          var at = picked.indexOf(i);
          if (at === -1) { picked.push(i); b.style.borderColor = 'var(--brand)'; b.style.background = 'var(--brand-soft)'; }
          else { picked.splice(at, 1); b.style.borderColor = ''; b.style.background = ''; }
          confirmBtn.disabled = picked.length === 0;
        } else {
          submit(i === q.a, [i]);
        }
      });
      optsBox.appendChild(b);
    });
    card.appendChild(optsBox);

    var confirmBtn = null;
    if (multi && !answered) {
      confirmBtn = el('button', { class: 'btn primary', type: 'button', style: 'width:100%', disabled: '', onclick: function () {
        var ansArr = q.a.slice().sort().join(',');
        var ok = picked.slice().sort().join(',') === ansArr;
        submit(ok, picked);
      } }, ['确认提交（多选）']);
      card.appendChild(el('div', { style: 'margin-top:10px' }, [confirmBtn]));
    }

    function submit(ok, pickedArr) {
      state.qz[q.id] = { picked: pickedArr, right: ok, answered: true };
      if (!ok) addWrong({ id: q.id, type: 'qz', stem: q.stem, ans: '正确答案：' + ansText(), e: q.e, src: q.src });
      else {
        state.wrong = state.wrong.filter(function (w) { return w.id !== q.id; });
      }
      save();
      toast(ok ? '✅ 回答正确' : '❌ 错误，已加入错题本');
      renderQuiz();
    }
    function ansText() {
      var ansArr = Array.isArray(q.a) ? q.a : [q.a];
      return ansArr.map(function (i) { return String.fromCharCode(65 + i); }).join('、');
    }

    if (answered) card.appendChild(el('div', { class: 'ask-e', html: '<b>解析：</b>' + q.e + (q.type === 'multi' ? '（答案：' + ansText() + '）' : '') }));
    return card;
  }

  // ---------------- 错题本 ----------------
  function addWrong(item) {
    if (!state.wrong.some(function (w) { return w.id === item.id; })) state.wrong.push(item);
  }
  function renderWrong() {
    var page = $('#main-page'); clear(page);
    $('#main-title').textContent = '错题本';
    if (!state.wrong.length) {
      page.appendChild(el('div', { class: 'card done-banner' }, [
        el('div', { class: 'big' }, ['🌟']), el('h2', null, ['暂无错题']),
        el('div', { class: 'hint' }, ['做错实验嵌问或真题会自动收进这里'])
      ]));
      return;
    }
    var card = el('div', { class: 'card' }, [el('div', { class: 'card-title' }, ['共 ' + state.wrong.length + ' 道错题'])]);
    state.wrong.slice().reverse().forEach(function (w) {
      card.appendChild(el('div', { class: 'wrong-row' }, [
        el('div', { class: 'hint' }, [w.src]),
        el('div', { class: 'q' }, [w.stem]),
        el('div', { class: 'e', html: '<b>' + w.ans + '</b> —— ' + w.e })
      ]));
    });
    page.appendChild(card);
    page.appendChild(el('button', { class: 'btn ghost', type: 'button', style: 'width:100%', onclick: function () {
      state.wrong.forEach(function (w) { if (w.type === 'qz') delete state.qz[w.id]; });
      state.wrong = []; save(); toast('错题已清空'); renderWrong();
    } }, ['清空错题本']));
  }

  // ---------------- 看板 ----------------
  function renderBoard() {
    var page = $('#main-page'); clear(page);
    $('#main-title').textContent = '学习看板';
    var doneExp = D.EXPERIMENTS.filter(function (e) { return state.exp[e.id] && state.exp[e.id].finished; }).length;
    var qzDone = Object.keys(state.qz).length;
    var qzRight = Object.keys(state.qz).filter(function (k) { return state.qz[k].right; }).length;
    var acc = qzDone ? Math.round(qzRight / qzDone * 100) : 0;

    page.appendChild(el('div', { class: 'card' }, [el('div', { class: 'card-title' }, ['👋 ' + (state.name || '同学') + '，高三总复习加油！'])]));
    var stats = el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'v' }, [doneExp + '/' + D.EXPERIMENTS.length]), el('div', { class: 'k' }, ['实验完成'])]),
      el('div', { class: 'stat' }, [el('div', { class: 'v' }, [String(qzDone)]), el('div', { class: 'k' }, ['真题已做'])]),
      el('div', { class: 'stat' }, [el('div', { class: 'v' }, [acc + '%']), el('div', { class: 'k' }, ['真题正确率'])])
    ]);
    page.appendChild(el('div', { style: 'margin:12px 0' }, [stats]));

    // 分类进度
    D.CATS.forEach(function (cat) {
      var exps = D.EXPERIMENTS.filter(function (e) { return e.cat === cat.id; });
      var doneN = exps.filter(function (e) { return state.exp[e.id] && state.exp[e.id].finished; }).length;
      page.appendChild(el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;justify-content:space-between' }, [
          el('div', { class: 'card-title' }, [cat.icon + ' ' + cat.name]),
          el('div', { class: 'hint' }, [doneN + '/' + exps.length])
        ]),
        el('div', { class: 'pbar' }, [el('i', { style: 'width:' + (exps.length ? Math.round(doneN / exps.length * 100) : 0) + '%' })])
      ]));
    });
  }

  // ---------------- 路由与启动 ----------------
  function switchTab(tab) {
    state.tab = tab;
    showScreen('main');
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    if (tab === 'map') { $('#main-title').textContent = '实验图谱'; renderMap(); }
    else if (tab === 'quiz') renderQuiz();
    else if (tab === 'wrong') renderWrong();
    else renderBoard();
    window.scrollTo(0, 0);
  }

  $('#tabbar').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (btn) switchTab(btn.getAttribute('data-tab'));
  });
  $('#btn-back').addEventListener('click', function () {
    switchTab(state.catOpen || 'map');
    if (state.catOpen) openCat(state.catOpen);
  });
  $('#btn-start').addEventListener('click', function () {
    var name = $('#in-name').value.trim() || '同学';
    state.name = name; save();
    showScreen('main'); switchTab('map');
  });

  window.__cl = { state: state, switchTab: switchTab, openExp: openExp, save: save };

  // 已有名字则跳过开场（进度持久化）
  if (state.name) { showScreen('main'); switchTab('map'); }
  else showScreen('auth');
})();
