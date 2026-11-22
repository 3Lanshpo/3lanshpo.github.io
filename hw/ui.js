// 硬件工程师导学系统 —— 界面与业务逻辑（纯前端，进度存 localStorage）
window.__app = (function () {
  'use strict';

  var LS_KEY = 'hw_guide_v1';
  var state = {
    book: null, byCode: {}, chapterOf: {},
    tab: 'map',
    openChapters: {},
    mastery: {},   // code -> {correct, total, last}
    wrong: [],     // {code, stem, options, answer, analysis, user, at}
    activity: {},  // 'YYYY-MM-DD' -> 次数
    learn: null
  };

  // ---------- 小工具 ----------
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function fail(err) { toast(API.describeError(err)); }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadPersisted() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      ['mastery', 'wrong', 'activity', 'openChapters'].forEach(function (k) {
        if (saved[k]) state[k] = saved[k];
      });
    } catch (e) { /* 损坏则重置 */ }
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        mastery: state.mastery, wrong: state.wrong, activity: state.activity, openChapters: state.openChapters
      }));
    } catch (e) { /* 存储满则忽略 */ }
  }

  function touchActivity() {
    var d = todayKey();
    state.activity[d] = (state.activity[d] || 0) + 1;
    save();
  }

  function streakDays() {
    var keys = Object.keys(state.activity).sort();
    if (!keys.length) return 0;
    var set = {};
    keys.forEach(function (k) { set[k] = true; });
    var d = new Date();
    if (!set[todayKey()]) d.setDate(d.getDate() - 1); // 今天还没学，从昨天起算
    var n = 0;
    while (true) {
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!set[key]) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  function secLevel(code) {
    var m = state.mastery[code];
    if (!m || !m.total) return 0;
    var rate = m.correct / m.total;
    if (m.total >= 3 && rate >= 0.8) return 3;
    if (rate >= 0.6) return 2;
    return 1;
  }

  var LEVEL_LABEL = ['未学', '学习中', '学习中', '已掌握'];
  var LEVEL_CLASS = ['tag new', 'tag learn', 'tag learn', 'tag ok'];

  function masteryTag(code) {
    var lv = secLevel(code);
    return el('span', { class: LEVEL_CLASS[lv], text: LEVEL_LABEL[lv] });
  }

  // ---------- 题库生成 ----------
  var QUIZ_COUNT = 4;

  function quizSystem() {
    return '你是一位资深硬件工程师导师，正在为电子工程学习者出练习题。'
      + '严格只依据给定的教材原文出题，不编造原文之外的技术参数。'
      + '严格只输出一个 JSON 对象，不要输出解释，不要用代码块包裹。';
  }

  function quizInstruction(title, text, count) {
    return '请根据下面的教材原文，出 ' + count + ' 道单选题，考查对本节关键内容的理解。'
      + '要求：每题 4 个选项（选项文本前加 A. B. C. D.），只有一个正确答案；覆盖本节最重要的概念；题干清晰无歧义；解析一到两句话。'
      + '输出格式：{"questions":[{"stem":"题干","options":["A. …","B. …","C. …","D. …"],"answer":"A","analysis":"解析"}]}'
      + '\n\n本节标题：' + title + '\n\n教材原文：\n' + text.slice(0, 4200);
  }

  function parseQuestions(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var s = text.indexOf('{');
    var e = text.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('AI 返回格式异常');
    var data = JSON.parse(text.slice(s, e + 1));
    var qs = (data.questions || []).filter(function (q) {
      return q && q.stem && Array.isArray(q.options) && q.options.length >= 2 && q.answer;
    });
    if (!qs.length) throw new Error('AI 没有返回有效题目');
    return qs.slice(0, QUIZ_COUNT).map(function (q) {
      return { stem: q.stem, options: q.options, answer: String(q.answer).trim().charAt(0).toUpperCase(), analysis: q.analysis || '' };
    });
  }

  function recordAnswer(code, isCorrect) {
    var m = state.mastery[code] || { correct: 0, total: 0 };
    m.total += 1;
    if (isCorrect) m.correct += 1;
    m.last = todayKey();
    state.mastery[code] = m;
    touchActivity();
  }

  function fileWrong(item) {
    // 同一题干只留一条
    state.wrong = state.wrong.filter(function (w) { return w.stem !== item.stem; });
    state.wrong.unshift({
      code: item.code, stem: item.stem, options: item.options,
      answer: item.answer, analysis: item.analysis, user: item.user, at: todayKey()
    });
    if (state.wrong.length > 200) state.wrong.length = 200;
    save();
  }

  // ---------- 导航 ----------
  function showScreen(id) {
    $$('.screen').forEach(function (s) { s.classList.remove('active'); });
    $(id).classList.add('active');
  }

  function switchTab(tab) {
    state.tab = tab;
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    var titles = { map: '知识图谱', wrong: '错题本', board: '学习看板' };
    $('#main-title').textContent = titles[tab];
    if (tab === 'map') renderMap();
    else if (tab === 'wrong') renderWrong();
    else renderBoard();
  }

  // ---------- 图谱 ----------
  function renderMap() {
    var wrap = el('div', {});
    var secs = state.book.chapters.reduce(function (n, c) { return n + c.sections.length; }, 0);
    var mastered = 0;
    Object.keys(state.mastery).forEach(function (c) { if (secLevel(c) === 3) mastered++; });
    $('#main-sub').textContent = state.book.book.title + ' · ' + secs + ' 节 · 已掌握 ' + mastered;

    state.book.chapters.forEach(function (ch) {
      var done = ch.sections.filter(function (s) { return secLevel(s.code) === 3; }).length;
      var open = !!state.openChapters['C' + ch.no];
      var card = el('div', { class: 'card' });

      card.appendChild(el('button', {
        class: 'chap-head', type: 'button',
        onclick: function () {
          state.openChapters['C' + ch.no] = !open;
          save();
          renderMap();
        }
      }, [
        el('div', { class: 'chap-no', text: 'Ch' + ch.no }),
        el('div', { class: 'chap-body' }, [
          el('div', { class: 'chap-name', text: ch.title }),
          el('div', { class: 'chap-sub', text: ch.sections.length + ' 节 · 已掌握 ' + done }),
          el('div', { class: 'progressbar' }, [
            el('div', { style: 'width:' + (done / ch.sections.length * 100) + '%' })
          ])
        ]),
        el('div', { class: 'chap-arrow', text: open ? '▲' : '▼' })
      ]));

      if (open) {
        var box = el('div', { style: 'margin-top:6px' });
        ch.sections.forEach(function (s) {
          box.appendChild(el('button', {
            class: 'sec-row', type: 'button',
            onclick: function () { openLearn(s.code); }
          }, [
            el('div', { class: 'sec-name', text: s.code + '　' + s.title }),
            el('div', { class: 'sec-pages', text: 'P' + s.pageFrom }),
            masteryTag(s.code)
          ]));
        });
        card.appendChild(box);
      }
      wrap.appendChild(card);
    });

    var page = $('#main-page');
    page.innerHTML = '';
    page.appendChild(wrap);
  }

  // ---------- 学习 ----------
  function openLearn(code) {
    var sec = state.byCode[code];
    if (!sec) return;
    state.learn = { code: code, sec: sec, phase: 'content', lesson: null, quiz: null, busy: false };
    showScreen('#screen-learn');
    touchActivity();
    renderLearn();
  }

  function renderLearn() {
    var L = state.learn;
    var ch = state.book.chapters[state.chapterOf[L.code]];
    $('#learn-title').textContent = L.sec.title;
    $('#learn-sub').textContent = '第' + (ch ? ch.no : '') + '章 ' + (ch ? ch.title : '') + ' · ' + L.sec.code + ' · 教材 P' + L.sec.pageFrom + '-' + L.sec.pageTo;

    var page = $('#learn-page');
    page.innerHTML = '';

    if (L.lesson) {
      var lessonCard = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: 'AI 导师讲解' })]);
      if (L.lesson.loading) {
        lessonCard.appendChild(el('div', { class: 'lesson-thinking' }, [
          el('span', { class: 'spinner' }), el('span', { text: '正在结合教材原文生成讲解…' })
        ]));
      } else {
        lessonCard.appendChild(el('div', { class: 'lesson-block lesson', text: L.lesson.text }));
      }
      page.appendChild(lessonCard);
    }

    if (L.phase === 'content') {
      var src = el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('div', { class: 'card-title', text: '教材原文' }),
          masteryTag(L.code)
        ]),
        el('div', { class: 'book-text', text: L.sec.text }),
        el('div', { class: 'book-src', text: '来源：《' + state.book.book.title + '》' + L.sec.code + ' 节 · P' + L.sec.pageFrom + '-' + L.sec.pageTo + ' · 已入库知识库分块' })
      ]);
      page.appendChild(src);
      page.appendChild(el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn ghost', type: 'button', text: L.lesson && !L.lesson.loading ? '重新讲解' : 'AI 导师讲解',
          onclick: function () { genLesson(); }
        }),
        el('button', {
          class: 'btn', type: 'button', text: '出题练习',
          onclick: function () { genQuiz(); }
        })
      ]));
    } else if (L.phase === 'quiz') {
      renderQuizPage(page);
    } else if (L.phase === 'result') {
      renderQuizResult(page);
    }

    page.scrollTop = 0;
  }

  function genLesson() {
    var L = state.learn;
    if (L.busy) return;
    L.busy = true;
    L.lesson = { loading: true, text: '' };
    renderLearn();
    API.llm.chat(
      '你是一位资深硬件工程师导师，为电子工程学习者讲解知识点。只依据提供的教材原文讲解，不得编造原文之外的技术参数；用中文，条理清晰。',
      '请按「一句话概述 → 关键要点（3-5 条）→ 工程实践提示或常见误区」三段结构讲解下面的内容，精炼但要有信息量，不要整段复述原文。\n\n'
      + '本节标题：' + L.sec.title + '\n\n教材原文：\n' + L.sec.text.slice(0, 5200),
      {
        temperature: 0.4,
        onDelta: function (delta) {
          L.lesson.text += delta;
          var block = $('#learn-page .lesson-block');
          if (block) block.textContent = L.lesson.text;
        }
      }
    ).then(function (text) {
      L.lesson = { loading: false, text: text || L.lesson.text };
      L.busy = false;
      renderLearn();
    }).catch(function (err) {
      L.busy = false;
      if (!L.lesson.text) L.lesson = null;
      renderLearn();
      fail(err);
    });
  }

  // ---------- 出题 ----------
  function genQuiz() {
    var L = state.learn;
    if (L.busy) return;
    L.busy = true;
    L.phase = 'quiz';
    L.quiz = { loading: true, qs: [], i: 0, answers: [] };
    renderLearn();
    API.llm.chat(quizSystem(), quizInstruction(L.sec.title, L.sec.text, QUIZ_COUNT), { json: true, temperature: 0.5 })
      .then(function (raw) {
        L.quiz = { loading: false, qs: parseQuestions(raw), i: 0, answers: [] };
        L.busy = false;
        renderLearn();
      })
      .catch(function (err) {
        L.busy = false;
        L.phase = 'content';
        L.quiz = null;
        renderLearn();
        fail(err);
      });
  }

  function renderQuizPage(page) {
    var L = state.learn, quiz = L.quiz;
    var card = el('div', { class: 'card' });
    if (quiz.loading) {
      card.appendChild(el('div', { style: 'text-align:center;padding:20px 0' }, [
        el('span', { class: 'spinner' }),
        el('span', { class: 'card-meta', text: 'AI 正在根据本节原文出题…' })
      ]));
      page.appendChild(card);
      return;
    }
    var q = quiz.qs[quiz.i];
    card.appendChild(el('div', { class: 'quiz-idx', text: '第 ' + (quiz.i + 1) + ' / ' + quiz.qs.length + ' 题 · ' + L.sec.code + ' ' + L.sec.title }));
    card.appendChild(el('div', { class: 'question', text: q.stem }));

    var answered = quiz.answers[quiz.i] != null;
    q.options.forEach(function (opt, idx) {
      var letter = String.fromCharCode(65 + idx);
      var cls = 'option';
      if (answered) {
        if (letter === q.answer) cls += ' picked-ok';
        else if (quiz.answers[quiz.i] === letter) cls += ' picked-no';
      }
      var btn = el('button', { class: cls, type: 'button', text: opt, disabled: answered ? 'disabled' : null });
      if (!answered) {
        btn.addEventListener('click', function () { answerQuiz(letter); });
      }
      card.appendChild(btn);
    });

    if (answered) {
      var chosen = quiz.answers[quiz.i];
      var ok = chosen === q.answer;
      var box = el('div', { class: 'answer-box' }, [
        el('div', { class: 'verdict ' + (ok ? 'ok' : 'no'), text: ok ? '答对了' : '答错了' }),
        el('div', { class: 'line', text: '正确答案：' + q.answer }),
        q.analysis ? el('div', { class: 'line', text: '解析：' + q.analysis }) : null,
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn', type: 'button',
            text: quiz.i === quiz.qs.length - 1 ? '查看结果' : '下一题',
            onclick: function () {
              if (quiz.i === quiz.qs.length - 1) { L.phase = 'result'; renderLearn(); }
              else { quiz.i += 1; renderLearn(); }
            }
          })
        ])
      ]);
      card.appendChild(box);
    }
    page.appendChild(card);
  }

  function answerQuiz(letter) {
    var L = state.learn, quiz = L.quiz;
    if (quiz.answers[quiz.i] != null) return;
    var q = quiz.qs[quiz.i];
    var ok = letter === q.answer;
    quiz.answers[quiz.i] = letter;
    recordAnswer(L.code, ok);
    if (!ok) fileWrong({ code: L.code, stem: q.stem, options: q.options, answer: q.answer, analysis: q.analysis, user: letter });
    else {
      // 答对了就从错题本移除同题干
      state.wrong = state.wrong.filter(function (w) { return w.stem !== q.stem; });
      save();
    }
    renderLearn();
  }

  function renderQuizResult(page) {
    var L = state.learn, quiz = L.quiz;
    var correct = 0;
    quiz.qs.forEach(function (q, i) { if (quiz.answers[i] === q.answer) correct++; });
    var lv = secLevel(L.code);
    var card = el('div', { class: 'card', style: 'text-align:center;padding:24px 14px' }, [
      el('div', { class: 'stat-num', text: correct + ' / ' + quiz.qs.length }),
      el('div', { class: 'stat-label', style: 'margin:6px 0 12px', text: '本轮正确率 · 当前状态：' + LEVEL_LABEL[lv] }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '再练一轮', onclick: function () { genQuiz(); } }),
        el('button', { class: 'btn', type: 'button', text: '返回图谱', onclick: function () { showScreen('#screen-main'); switchTab('map'); } })
      ])
    ]);
    page.appendChild(card);
  }

  // ---------- 错题本 ----------
  function renderWrong() {
    var page = $('#main-page');
    page.innerHTML = '';
    $('#main-sub').textContent = '待攻克 ' + state.wrong.length + ' 题';

    if (!state.wrong.length) {
      page.appendChild(el('div', { class: 'card', style: 'text-align:center;padding:30px 14px' }, [
        el('div', { class: 'stat-num', text: '🎉' }),
        el('div', { class: 'stat-label', style: 'margin-top:6px', text: '错题本是空的，去图谱里学一节并出题练习吧' })
      ]));
      return;
    }

    var wrap = el('div', {});
    state.wrong.forEach(function (w) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('span', { class: 'tag learn', text: w.code }),
          el('span', { class: 'card-meta', text: w.at })
        ]),
        el('div', { class: 'wrong-stem', text: w.stem }),
        el('div', { class: 'card-meta', text: '你的答案：' + (w.user || '—') + ' · 正确答案：' + w.answer }),
        w.analysis ? el('div', { class: 'card-meta', text: w.analysis }) : null
      ]));
    });
    page.appendChild(wrap);
    page.appendChild(el('button', {
      class: 'btn red block', type: 'button', text: '重做全部错题（' + state.wrong.length + ' 题）',
      onclick: startRedo
    }));
  }

  function startRedo() {
    var items = state.wrong.slice(0, 10).map(function (w) {
      return { stem: w.stem, options: w.options, answer: w.answer, analysis: w.analysis, code: w.code };
    });
    if (!items.length) return;
    state.learn = {
      code: items[0].code, sec: state.byCode[items[0].code] || { title: '错题重做', code: items[0].code },
      phase: 'quiz', lesson: null,
      quiz: { loading: false, qs: items, i: 0, answers: [], redo: true },
      busy: false
    };
    showScreen('#screen-learn');
    renderLearn();
  }

  // ---------- 看板 ----------
  function weakestSections(n) {
    var all = [];
    state.book.chapters.forEach(function (ch) {
      ch.sections.forEach(function (s) {
        all.push({ code: s.code, title: s.title, level: secLevel(s.code), total: (state.mastery[s.code] || {}).total || 0 });
      });
    });
    all.sort(function (a, b) {
      if (a.level !== b.level) return a.level - b.level;
      if (a.total !== b.total) return a.total - b.total;
      return parseFloat(a.code) - parseFloat(b.code);
    });
    return all.slice(0, n);
  }

  function renderBoard() {
    var page = $('#main-page');
    page.innerHTML = '';

    var secs = 0, mastered = 0, started = 0;
    var qTotal = 0, qCorrect = 0;
    Object.keys(state.mastery).forEach(function (c) {
      var m = state.mastery[c];
      qTotal += m.total; qCorrect += m.correct;
      if (secLevel(c) === 3) mastered++;
      if (m.total) started++;
    });
    state.book.chapters.forEach(function (ch) { secs += ch.sections.length; });

    $('#main-sub').textContent = '连续学习 ' + streakDays() + ' 天';

    page.appendChild(el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat-cell' }, [el('div', { class: 'stat-num', text: mastered + '/' + secs }), el('div', { class: 'stat-label', text: '已掌握章节' })]),
      el('div', { class: 'stat-cell' }, [el('div', { class: 'stat-num', text: qTotal }), el('div', { class: 'stat-label', text: '累计答题' })]),
      el('div', { class: 'stat-cell' }, [el('div', { class: 'stat-num', text: qTotal ? Math.round(qCorrect / qTotal * 100) + '%' : '—' }), el('div', { class: 'stat-label', text: '总正确率' })]),
      el('div', { class: 'stat-cell' }, [el('div', { class: 'stat-num', text: streakDays() }), el('div', { class: 'stat-label', text: '连续天数' })])
    ]));

    page.appendChild(el('div', { class: 'section-title', text: '今日推荐 · 优先攻克薄弱节' }));
    var rec = el('div', { class: 'card' });
    weakestSections(5).forEach(function (s) {
      rec.appendChild(el('button', {
        class: 'sec-row', type: 'button',
        onclick: function () { openLearn(s.code); }
      }, [
        el('div', { class: 'sec-name', text: s.code + '　' + s.title }),
        masteryTag(s.code)
      ]));
    });
    page.appendChild(rec);

    page.appendChild(el('div', { class: 'section-title', text: '各章进度' }));
    var chCard = el('div', { class: 'card' });
    state.book.chapters.forEach(function (ch) {
      var done = ch.sections.filter(function (s) { return secLevel(s.code) === 3; }).length;
      chCard.appendChild(el('div', { style: 'margin-bottom:12px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;font-size:13px' }, [
          el('span', { text: 'Ch' + ch.no + ' ' + ch.title }),
          el('span', { class: 'card-meta', text: done + '/' + ch.sections.length })
        ]),
        el('div', { class: 'progressbar' }, [el('div', { style: 'width:' + (done / ch.sections.length * 100) + '%' })])
      ]));
    });
    page.appendChild(chCard);
  }

  // ---------- 启动 ----------
  async function boot() {
    loadPersisted();
    $$('#tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    $('#learn-back').addEventListener('click', function () {
      state.learn = null;
      showScreen('#screen-main');
      switchTab(state.tab);
    });

    try {
      var res = await fetch('data/book.json?v=20261029a');
      state.book = await res.json();
    } catch (e) {
      $('#boot-hint').textContent = '知识库加载失败：' + e.message;
      return;
    }

    state.book.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (s) {
        state.byCode[s.code] = s;
        state.chapterOf[s.code] = ci;
      });
    });

    // 首次进入默认展开第 1 章
    if (Object.keys(state.openChapters).length === 0) state.openChapters.C1 = true;

    showScreen('#screen-main');
    switchTab('map');
  }

  // ---------- 测试钩子 ----------
  var __test = {
    bootDone: function () { return !!state.book; },
    tabs: function () { return $$('#tabbar button').map(function (b) { return b.textContent; }); },
    openChapter: function (no) {
      state.openChapters['C' + no] = true;
      renderMap();
      var rows = $$('#main-page .sec-row');
      return { openRows: rows.length };
    },
    mapRows: function () {
      return $$('#main-page .sec-row').slice(0, 12).map(function (r) { return r.textContent.trim().slice(0, 40); });
    },
    openSection: function (code) {
      openLearn(code);
      return {
        title: $('#learn-title').textContent,
        sub: $('#learn-sub').textContent,
        hasText: !!$('#learn-page .book-text'),
        textLen: ($('#learn-page .book-text') || {}).textContent ? $('#learn-page .book-text').textContent.length : 0
      };
    },
    lesson: async function () {
      genLesson();
      await new Promise(function (r) { setTimeout(r, 3000); });
      var block = $('#learn-page .lesson-block');
      return { hasLesson: !!block, len: block ? block.textContent.length : 0, head: block ? block.textContent.slice(0, 60) : '' };
    },
    quiz: async function () {
      genQuiz();
      await new Promise(function (r) { setTimeout(r, 9000); });
      return {
        loading: state.learn.quiz && state.learn.quiz.loading,
        nQs: state.learn.quiz ? state.learn.quiz.qs.length : 0,
        firstStem: state.learn.quiz && state.learn.quiz.qs[0] ? state.learn.quiz.qs[0].stem.slice(0, 50) : '',
        nOpts: state.learn.quiz && state.learn.quiz.qs[0] ? state.learn.quiz.qs[0].options.length : 0
      };
    },
    answer: function (idx) {
      var q = state.learn.quiz.qs[state.learn.quiz.i];
      answerQuiz(String.fromCharCode(65 + (idx || 0)));
      var box = $('#learn-page .answer-box');
      return {
        verdict: (box && box.querySelector('.verdict') || {}).textContent || '',
        hasAnalysis: box ? box.textContent.indexOf('解析') >= 0 : false
      };
    },
    next: function () {
      var L = state.learn;
      var btn = $$('#learn-page .answer-box .btn')[0];
      if (btn) btn.click();
      return { i: L.quiz.i, phase: L.phase };
    },
    result: function () {
      var L = state.learn;
      L.phase = 'result';
      renderLearn();
      return { text: $('#learn-page').textContent.slice(0, 120) };
    },
    wrong: function () { return state.wrong.map(function (w) { return w.stem.slice(0, 30); }); },
    redo: function () {
      startRedo();
      return { nQs: state.learn.quiz.qs.length, redo: !!state.learn.quiz.redo };
    },
    board: function () {
      switchTab('board');
      return {
        sub: $('#main-sub').textContent,
        stats: $$('#main-page .stat-cell').map(function (c) { return c.textContent.trim(); }),
        recs: $$('#main-page .card .sec-row').length,
        chapters: $$('#main-page .progressbar').length
      };
    },
    snap: function () {
      return { mastery: state.mastery, wrongN: state.wrong.length, activity: state.activity };
    }
  };
  window.__test = __test;

  boot();
  return { state: state, switchTab: switchTab };
})();
