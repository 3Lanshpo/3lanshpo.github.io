// 全科导学系统 — interface and learning loop
(function () {
  'use strict';

  // ---------------- dom helpers ----------------

  function $(sel) { return document.querySelector(sel); }

  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined) return;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), val);
        else node.setAttribute(key, val);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      // map() results are a natural way to build lists, so accept one level
      // of nested arrays instead of forcing callers to spread them.
      if (Array.isArray(child)) {
        child.forEach(function (nested) {
          if (nested === null || nested === undefined || nested === false) return;
          node.appendChild(typeof nested === 'string' ? document.createTextNode(nested) : nested);
        });
        return;
      }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(message) {
    var node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, 2600);
  }

  function showScreen(name) {
    $$('.screen').forEach(function (s) { s.classList.remove('active'); });
    $('#screen-' + name).classList.add('active');
    window.scrollTo(0, 0);
  }

  function fail(error) {
    toast(API.describeError(error));
    if (window.console && error) console.error(error);
  }

  // ---------------- state ----------------

  var SUBJECTS = ['语文', '数学', '英语', '奥数', '信息学'];

  var state = {
    session: null,
    member: null,
    isAdmin: false,
    student: null,
    catalog: [],
    mySubjects: [],
    members: [],
    myQuestions: [],
    practiceLogs: [],
    bank: { loaded: false, loading: false, meta: [], sel: null, session: null, busy: false },
    rewards: { loaded: false, loading: false, wallet: null, taskLogs: [], shop: [], redeems: [], manage: false },
    activities: [],
    knowledge: [],
    mastery: {},
    wrongList: [],
    logs: [],
    tab: 'today',
    subject: '全部',
    mapTextbook: '', // 知识图谱的教材筛选，空串表示全部教材
    authMode: 'password',
    authPending: null,
    authTimer: null,
    learn: null,
    subStack: [],
    importing: null,
    reading: {
      sentences: [],
      logs: [],
      recording: false,
      recordingCode: null,
      mediaRecorder: null,
      stream: null,
      chunks: [],
      startedAt: 0,
      clipUrl: null,
      clipCode: null,
      clipDuration: 0,
      // Speech recognition (system scoring). MediaRecorder keeps the clip for
      // playback; recognition runs alongside it and turns what the learner said
      // into text we can compare with the target sentence.
      recognition: null,
      recognizing: false,
      asrCode: null,
      asrText: '',
      asrFailed: false,
      asrResolver: null,
      scoring: null,
      lastScore: null
    }
  };

  // ---------------- textbook scope ----------------

  // The catalog holds every textbook the system knows about; the profile rows
  // hold this account's own picks. A profile with no rows yet (an account that
  // never opened 课程设置) inherits the whole active catalog.
  function activeTextbooks() {
    return state.catalog.filter(function (row) { return row.is_active !== false; });
  }

  function myTextbookCodes() {
    if (!state.mySubjects.length) {
      return activeTextbooks().map(function (row) { return row.code; });
    }
    var picked = state.mySubjects.filter(function (row) { return row.enabled !== false; });
    if (!picked.length) {
      return activeTextbooks().map(function (row) { return row.code; });
    }
    return picked.map(function (row) { return row.textbook_code; });
  }

  function subjectEnabled(subject) {
    var codes = myTextbookCodes();
    return activeTextbooks().some(function (row) {
      return row.subject === subject && codes.indexOf(row.code) >= 0;
    });
  }

  function enabledSubjects() {
    var list = SUBJECTS.filter(subjectEnabled);
    return list.length ? list : SUBJECTS.slice();
  }

  // Ordering used by every knowledge list: school terms first, then the GESP
  // levels in increasing difficulty, then CSP. Unknown labels sort last, and
  // ties fall back to the authored order_no.
  var TERM_RANK = { '上册': 1, '下册': 2, '全册': 3 };
  function termRank(term) {
    if (TERM_RANK[term]) return TERM_RANK[term];
    var gesp = /^GESP\s*(\d+)\s*级$/.exec(term || '');
    if (gesp) return 10 + Number(gesp[1]);
    if (/CSP/i.test(term || '')) return 30;
    return 50;
  }

  function byLayout(a, b) {
    var diff = termRank(a.term) - termRank(b.term);
    if (diff) return diff;
    return (a.order_no || 0) - (b.order_no || 0);
  }

  function visibleKnowledge() {
    var codes = myTextbookCodes();
    return state.knowledge.filter(function (item) {
      if (!item.textbook_code) return true;
      return codes.indexOf(item.textbook_code) >= 0;
    }).slice().sort(byLayout);
  }

  function textbookName(code) {
    for (var i = 0; i < state.catalog.length; i += 1) {
      if (state.catalog[i].code === code) return state.catalog[i].name;
    }
    return '其他来源';
  }

  // 教材完整显示名：年级 + 学科 + 版本名，例如「六年级语文人教版」。
  // 缺年级时退化为「学科 + 版本名」，避免出现开头的连接号。
  function textbookFullName(code) {
    for (var i = 0; i < state.catalog.length; i += 1) {
      var row = state.catalog[i];
      if (row.code === code) {
        var parts = [];
        if (row.grade_scope) parts.push(row.grade_scope);
        if (row.subject) parts.push(row.subject);
        parts.push(row.name);
        return parts.join('');
      }
    }
    return textbookName(code);
  }

  function knowledgeByCode(code) {
    for (var i = 0; i < state.knowledge.length; i++) {
      if (state.knowledge[i].code === code) return state.knowledge[i];
    }
    return null;
  }

  // ---------------- sub-page stack ----------------

  var SUB_TITLES = {
    me: '我的',
    subjects: '课程设置',
    admin: '管理中心',
    import: '导入错题',
    review: '错题重做'
  };

  function pushSub(name, arg) {
    state.subStack.push({ name: name, arg: arg || null });
    renderSub();
    showScreen('sub');
  }

  function popSub() {
    state.subStack.pop();
    if (!state.subStack.length) {
      showScreen('main');
      switchTab(state.tab);
      return;
    }
    renderSub();
  }

  function renderSub() {
    var top = state.subStack[state.subStack.length - 1];
    if (!top) return;
    $('#sub-title').textContent = SUB_TITLES[top.name] || '详情';
    if (top.name === 'me') renderMePage();
    else if (top.name === 'subjects') renderSubjectsPage();
    else if (top.name === 'admin') renderAdminPage();
    else if (top.name === 'import') renderImportPage();
    else if (top.name === 'review') renderReviewPage();
  }

  // ---------------- study plan ----------------

  function statusOf(code) {
    var record = state.mastery[code];
    if (!record) return 'new';
    return record.status || 'learning';
  }

  function byOrder(a, b) {
    return byLayout(a.knowledge, b.knowledge);
  }

  // The core of the "noise reduction": mastered knowledge never enters the plan.
  function buildPlan() {
    var grouped = {};
    visibleKnowledge().forEach(function (item) {
      var status = statusOf(item.code);
      if (status === 'mastered') return;
      if (!grouped[item.subject]) grouped[item.subject] = { review: [], fresh: [] };
      var record = state.mastery[item.code] || null;
      var entry = { knowledge: item, record: record, status: status };
      if (record && record.total_count > 0) grouped[item.subject].review.push(entry);
      else grouped[item.subject].fresh.push(entry);
    });

    var review = [];
    var fresh = [];
    Object.keys(grouped).forEach(function (subject) {
      grouped[subject].review.sort(byOrder);
      grouped[subject].fresh.sort(byOrder);
      review = review.concat(grouped[subject].review.slice(0, 2));
      fresh = fresh.concat(grouped[subject].fresh.slice(0, 2));
    });
    return review.concat(fresh);
  }

  function progressStats() {
    var scoped = visibleKnowledge();
    var total = scoped.length;
    var mastered = 0;
    var learning = 0;
    scoped.forEach(function (item) {
      var status = statusOf(item.code);
      if (status === 'mastered') mastered += 1;
      else if (status === 'learning') learning += 1;
    });
    return { total: total, mastered: mastered, learning: learning };
  }

  // ---------------- subject chips ----------------

  function subjectChips(onPick) {
    var wrap = el('div', { class: 'chips' });
    ['全部'].concat(enabledSubjects()).forEach(function (name) {
      wrap.appendChild(
        el('button', {
          class: 'chip' + (state.subject === name ? ' on' : ''),
          type: 'button',
          text: name,
          onclick: function () {
            state.subject = name;
            onPick();
          }
        })
      );
    });
    return wrap;
  }

  // ---------------- knowledge row ----------------

  function knowledgeRow(item, onClick, opts) {
    var status = statusOf(item.code);
    var label = status === 'mastered' ? '已掌握' : status === 'learning' ? '待巩固' : '未学';
    var hideSubject = !!(opts && opts.hideSubject);
    return el('button', { class: 'row', type: 'button', onclick: onClick }, [
      el('span', { class: 'dot ' + (status === 'mastered' ? 'mastered' : status === 'learning' ? 'learning' : '') }),
      el('span', { class: 'body' }, [
        el('div', { class: 'name', text: item.name }),
        el('div', { class: 'sub', text: item.chapter + (item.unit_name ? ' · ' + item.unit_name : '') })
      ]),
      el('span', { class: 'tail' }, [
        hideSubject ? null : el('span', { class: 'tag subject', text: item.subject }),
        status !== 'new' ? el('span', { class: 'tag ' + status, text: label }) : null
      ])
    ]);
  }

  // ---------------- main screens ----------------

  function renderToday() {
    var page = $('#main-page');
    clear(page);

    page.appendChild(subjectChips(renderToday));

    var plan = buildPlan().filter(function (entry) {
      return state.subject === '全部' || entry.knowledge.subject === state.subject;
    });

    var stats = progressStats();
    var done = stats.mastered;
    var percent = stats.total ? Math.round((done / stats.total) * 100) : 0;

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '整体进度' }),
          el('span', { class: 'card-meta', text: done + ' / ' + stats.total + ' 个知识点已掌握' })
        ]),
        el('div', { class: 'bar' }, [el('i', { style: 'width:' + percent + '%' })]),
        el('div', { class: 'card-summary', text: '掌握度越高，今日清单越短 —— 已掌握的知识点会自动从清单里消失。' })
      ])
    );

    var readingToday = todaySentences();
    var readingDone = readingToday.filter(function (item) { return !!readingLog(item.code); }).length;
    var readingPercent = readingToday.length
      ? Math.round((readingDone / readingToday.length) * 100)
      : 0;
    if (readingToday.length) {
      page.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h2', { class: 'card-title', text: '英语跟读' }),
            el('span', { class: 'card-meta', text: readingDone + ' / ' + readingToday.length + ' 句' })
          ]),
          el('div', { class: 'bar' }, [el('i', { style: 'width:' + readingPercent + '%' })]),
          el('div', { class: 'actions' }, [
            el('button', {
              class: readingDone >= readingToday.length ? 'btn secondary' : 'btn',
              type: 'button',
              text: readingDone >= readingToday.length ? '今天的已完成，再看一遍' : '去跟读今天的 3 句',
              onclick: function () { switchTab('reading'); }
            })
          ])
        ])
      );
    }

    page.appendChild(
      el('div', { class: 'section-title' }, [
        '今日该学',
        el('span', { class: 'count', text: plan.length + ' 项' })
      ])
    );

    if (!plan.length) {
      page.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '这个范围已经全部掌握' }),
          el('div', { text: '换个学科看看，或者去知识图谱里挑一个知识点复习' })
        ])
      );
      return;
    }

    plan.forEach(function (entry) {
      page.appendChild(knowledgeRow(entry.knowledge, function () { enterLearn(entry.knowledge); }));
    });
  }

  // 知识图谱顶部的分类下拉：学科 + 教材，各一个下拉框。
  // 用下拉替代原来的横向 chips，知识点变多时不会把筛选栏挤爆。
  function mapFilters(onPick) {
    var bar = el('div', { class: 'filter-bar' });

    // 学科下拉：全部 + 已启用学科
    var subjectSel = el('select', { class: 'field filter-select' });
    ['全部'].concat(enabledSubjects()).forEach(function (name) {
      subjectSel.appendChild(
        el('option', { value: name, text: name === '全部' ? '全部学科' : name })
      );
    });
    subjectSel.value = state.subject || '全部';
    subjectSel.addEventListener('change', function () {
      state.subject = subjectSel.value;
      onPick();
    });
    bar.appendChild(subjectSel);

    // 教材下拉：全部教材 + 当前可见知识点涉及的教材
    var codes = [];
    var seen = {};
    visibleKnowledge().forEach(function (item) {
      var code = item.textbook_code || 'other';
      if (!seen[code]) {
        seen[code] = true;
        codes.push(code);
      }
    });
    var bookSel = el('select', { class: 'field filter-select' });
    bookSel.appendChild(el('option', { value: '', text: '全部教材' }));
    codes.forEach(function (code) {
      bookSel.appendChild(el('option', { value: code, text: textbookFullName(code) }));
    });
    var current = state.mapTextbook || '';
    if (current && codes.indexOf(current) < 0) {
      // 选中的教材在新筛选条件下没有知识点，补一个选项避免回落到“全部教材”。
      bookSel.appendChild(el('option', { value: current, text: textbookFullName(current) }));
    }
    bookSel.value = current;
    bookSel.addEventListener('change', function () {
      state.mapTextbook = bookSel.value;
      onPick();
    });
    bar.appendChild(bookSel);

    return bar;
  }

  function renderMap() {
    var page = $('#main-page');
    clear(page);
    page.appendChild(mapFilters(renderMap));

    var list = visibleKnowledge().filter(function (item) {
      if (state.subject !== '全部' && item.subject !== state.subject) return false;
      if (state.mapTextbook) {
        var source = item.textbook_code || 'other';
        if (source !== state.mapTextbook) return false;
      }
      return true;
    });

    if (!list.length) {
      page.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '这里还没有知识点' }),
          el('div', { text: '换个筛选条件，或到管理中心用「AI 生成知识点」导入教材内容' })
        ])
      );
      return;
    }

    // Grouping order: textbook first (labeled with the full name, e.g.
    // 六年级语文人教版), then the school term / GESP level, so a parent can
    // see exactly which book and which semester a knowledge point belongs to.
    var sources = [];
    var bySource = {};
    list.forEach(function (item) {
      var code = item.textbook_code || 'other';
      if (!bySource[code]) {
        bySource[code] = { name: textbookFullName(code), items: [] };
        sources.push(code);
      }
      bySource[code].items.push(item);
    });

    sources.forEach(function (code) {
      var source = bySource[code];
      var mastered = source.items.filter(function (i) { return statusOf(i.code) === 'mastered'; }).length;
      page.appendChild(
        el('div', { class: 'map-source' }, [
          el('span', { class: 'map-source-name', text: source.name }),
          el('span', { class: 'count', text: mastered + ' / ' + source.items.length + ' 已掌握' })
        ])
      );

      var terms = [];
      var byTerm = {};
      source.items.forEach(function (item) {
        var term = item.term || '未分册';
        if (!byTerm[term]) {
          byTerm[term] = [];
          terms.push(term);
        }
        byTerm[term].push(item);
      });

      terms.forEach(function (term) {
        var group = byTerm[term];
        var groupMastered = group.filter(function (i) { return statusOf(i.code) === 'mastered'; }).length;
        page.appendChild(
          el('div', { class: 'group-title' }, [
            term,
            el('span', { class: 'count', text: groupMastered + ' / ' + group.length })
          ])
        );
        group.forEach(function (item) {
          page.appendChild(knowledgeRow(item, function () { enterLearn(item); }, { hideSubject: true }));
        });
      });
    });
  }

  function renderWrong() {
    var page = $('#main-page');
    clear(page);

    page.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: '重做错题（随机组卷）',
          onclick: function () { pushSub('review'); }
        }),
        el('button', {
          class: 'btn ghost',
          type: 'button',
          text: '导入一批错题',
          onclick: function () { pushSub('import'); }
        })
      ])
    );

    if (!state.wrongList.length) {
      page.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '错题本是空的' }),
          el('div', { text: '答错的题会自动收录到这里，也可以拍照导入纸面上的错题' })
        ])
      );
      return;
    }

    page.appendChild(
      el('div', { class: 'section-title' }, [
        '待消灭',
        el('span', { class: 'count', text: state.wrongList.length + ' 道' })
      ])
    );

    state.wrongList.forEach(function (item) {
      var knowledge = state.knowledge.filter(function (k) { return k.code === item.knowledge_code; })[0];
      page.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h3', { class: 'card-title', text: knowledge ? knowledge.name : item.knowledge_code }),
            el('span', { class: 'card-meta', text: '错 ' + (item.wrong_count || 1) + ' 次' })
          ]),
          el('p', { class: 'card-summary', text: item.stem }),
          el('div', { class: 'line', text: '正确答案：' + item.correct_answer }),
          item.analysis ? el('p', { class: 'card-summary', text: '解析：' + item.analysis }) : null,
          el('div', { class: 'actions' }, [
            el('button', {
              class: 'btn secondary',
              type: 'button',
              text: '再练一遍',
              onclick: function () {
                if (knowledge) enterLearn(knowledge);
                else toast('找不到对应的知识点');
              }
            }),
            el('button', {
              class: 'btn',
              type: 'button',
              text: '已消灭',
              onclick: function () {
                API.study.resolveWrong(item.id)
                  .then(function () {
                    state.wrongList = state.wrongList.filter(function (w) { return w.id !== item.id; });
                    renderWrong();
                    toast('已从错题本移除');
                  })
                  .catch(fail);
              }
            })
          ])
        ])
      );
    });
  }

  function renderMePage() {
    var page = $('#sub-page');
    clear(page);

    var stats = progressStats();
    var total = stats.total || 1;

    page.appendChild(
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat' }, [
          el('div', { class: 'num', text: String(stats.total) }),
          el('div', { class: 'label', text: '知识点总数' })
        ]),
        el('div', { class: 'stat' }, [
          el('div', { class: 'num', style: 'color:#1d9e75', text: String(stats.mastered) }),
          el('div', { class: 'label', text: '已掌握' })
        ]),
        el('div', { class: 'stat' }, [
          el('div', { class: 'num', style: 'color:#ba7517', text: String(stats.learning) }),
          el('div', { class: 'label', text: '待巩固' })
        ])
      ])
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '分科掌握情况' })]),
        enabledSubjects().map(function (subject) {
          var items = state.knowledge.filter(function (i) { return i.subject === subject; });
          var done = items.filter(function (i) { return statusOf(i.code) === 'mastered'; }).length;
          var percent = items.length ? Math.round((done / items.length) * 100) : 0;
          return el('div', { style: 'margin-top:14px' }, [
            el('div', { class: 'card-head' }, [
              el('span', { class: 'card-title', style: 'font-size:14px', text: subject }),
              el('span', { class: 'card-meta', text: done + ' / ' + items.length })
            ]),
            el('div', { class: 'bar' }, [el('i', { style: 'width:' + percent + '%' })])
          ]);
        })
      ])
    );

    var readingToday = todaySentences();
    var readingDone = readingToday.filter(function (item) { return !!readingLog(item.code); }).length;
    var readingTotal = readingTotals();
    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '英语跟读' }),
          el('span', { class: 'card-meta', text: '今日 ' + readingDone + ' / ' + readingToday.length + ' 句' })
        ]),
        el('div', { class: 'read-stats' }, [
          el('div', { class: 'read-stat' }, [
            el('b', { text: String(readingStreak()) }),
            el('span', { text: '连续打卡 · 天' })
          ]),
          el('div', { class: 'read-stat' }, [
            el('b', { text: String(readingTotal.attempts) }),
            el('span', { text: '累计朗读 · 次' })
          ]),
          el('div', { class: 'read-stat' }, [
            el('b', { text: String(readingTotal.days) }),
            el('span', { text: '已练习 · 天' })
          ])
        ])
      ])
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '学习档案' })]),
        el('p', {
          class: 'card-summary',
          text: '学生：' + (state.student ? state.student.student_name : '未建立') + ' · 六年级'
        }),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '修改学生姓名',
            onclick: function () {
              var name = window.prompt('请输入学生姓名', state.student ? state.student.student_name : '');
              if (!name || !name.trim()) return;
              API.student.rename(state.student.id, name.trim())
                .then(function (updated) {
                  state.student = updated;
                  renderMePage();
                  toast('已保存');
                })
                .catch(fail);
            }
          })
        ])
      ])
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '账号' }),
          el('span', { class: 'tag subject', text: roleLabel(state.isAdmin ? (state.member && state.member.role) : 'member') })
        ]),
        el('p', {
          class: 'card-summary',
          text: state.session && state.session.user ? (state.session.user.email || '已登录') : '已登录'
        }),
        el('p', {
          class: 'card-summary',
          text: '已加入的账号 ' + (state.members.length || 1) + ' 个。每个账号的学科选择、掌握度和错题都是各自独立的一份。'
        })
      ])
    );

    var entries = [
      { name: 'subjects', title: '我的课程', desc: subjectScopeText() },
      { name: 'import', title: '导入错题', desc: '拍照上传错题，AI 识别成题目和解析' },
      { name: 'review', title: '错题重做', desc: '随机抽题组卷，做完立刻判分' }
    ];
    if (state.isAdmin) {
      entries.push({ name: 'admin', title: '管理中心', desc: '教材版本、账号角色、知识点导入' });
    }

    page.appendChild(
      el('div', { class: 'list-card' }, entries.map(function (entry) {
        return el('button', {
          class: 'list-row',
          type: 'button',
          onclick: function () { pushSub(entry.name); }
        }, [
          el('span', { class: 'body' }, [
            el('div', { class: 'name', text: entry.title }),
            el('div', { class: 'sub', text: entry.desc })
          ]),
          el('span', { class: 'chev' })
        ]);
      }))
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '退出登录',
            onclick: function () {
              API.auth.signOut().then(function () {
                state.session = null;
                state.learn = null;
                state.subStack = [];
                showScreen('auth');
              });
            }
          })
        ])
      ])
    );
  }

  function roleLabel(role) {
    if (role === 'owner') return '创建者';
    if (role === 'admin') return '管理员';
    return '成员';
  }

  function subjectScopeText() {
    var subjects = enabledSubjects();
    if (!state.mySubjects.length) {
      return '当前使用全部 ' + state.catalog.length + ' 套教材，点进去可以只保留要学的';
    }
    return subjects.length + ' 个学科 · ' + myTextbookCodes().length + ' 套教材';
  }

  // ================= 学习看板 =================

  function localDateKey(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return dateKey(value);
    return localKey(date);
  }

  function lastDays(count) {
    var out = [];
    var base = new Date(todayKey() + 'T00:00:00');
    for (var i = count - 1; i >= 0; i--) {
      var date = new Date(base.getTime());
      date.setDate(date.getDate() - i);
      out.push(localKey(date));
    }
    return out;
  }

  function practiceByDay() {
    var map = {};
    state.practiceLogs.forEach(function (row) {
      var key = localDateKey(row.created_at);
      if (!key) return;
      if (!map[key]) map[key] = { total: 0, correct: 0 };
      map[key].total += 1;
      if (row.is_correct) map[key].correct += 1;
    });
    return map;
  }

  function activeDays() {
    var days = {};
    state.practiceLogs.forEach(function (row) {
      var key = localDateKey(row.created_at);
      if (key) days[key] = true;
    });
    state.reading.logs.forEach(function (row) {
      var key = dateKey(row.read_date);
      if (key) days[key] = true;
    });
    state.activities.forEach(function (row) {
      var key = localDateKey(row.occurred_on);
      if (key) days[key] = true;
    });
    return days;
  }

  function activeStreak() {
    var days = activeDays();
    var streak = 0;
    var cursor = new Date(todayKey() + 'T00:00:00');
    // An unfinished today must not look like a broken streak.
    if (!days[todayKey()]) cursor.setDate(cursor.getDate() - 1);
    for (var guard = 0; guard < 400; guard++) {
      if (!days[localKey(cursor)]) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function weakList() {
    var scoped = {};
    visibleKnowledge().forEach(function (item) { scoped[item.code] = item; });
    var out = [];
    Object.keys(state.mastery).forEach(function (code) {
      var record = state.mastery[code];
      var knowledge = scoped[code];
      if (!record || !knowledge || !record.total_count) return;
      out.push({
        knowledge: knowledge,
        record: record,
        rate: (record.correct_count || 0) / record.total_count
      });
    });
    out.sort(function (a, b) {
      return a.rate - b.rate || (b.record.total_count - a.record.total_count);
    });
    return out.slice(0, 10);
  }

  function statCell(value, label, color) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'num', style: 'color:' + color, text: value }),
      el('div', { class: 'label', text: label })
    ]);
  }

  function timelineSvg(days) {
    var keys = lastDays(30);
    var maxCount = 1;
    keys.forEach(function (key) {
      var row = days[key];
      if (row && row.total > maxCount) maxCount = row.total;
    });

    var width = 600;
    var height = 132;
    var left = 6;
    var right = width - 6;
    var baseY = 104;
    var topY = 14;
    var step = (right - left) / keys.length;
    var barWidth = Math.max(4, step - 4);
    var bars = '';
    var points = [];

    keys.forEach(function (key, i) {
      var row = days[key] || { total: 0, correct: 0 };
      var x = left + i * step + (step - barWidth) / 2;
      if (!row.total) return;
      var barHeight = Math.max(4, Math.round((row.total / maxCount) * (baseY - topY)));
      bars += '<rect x="' + x.toFixed(1) + '" y="' + (baseY - barHeight).toFixed(1)
        + '" width="' + barWidth.toFixed(1) + '" height="' + barHeight.toFixed(1)
        + '" rx="2" fill="#B5D4F4"/>';
      points.push([x + barWidth / 2, baseY - (row.correct / row.total) * (baseY - topY)]);
    });

    var grid = '';
    [0, 0.5, 1].forEach(function (factor) {
      var y = baseY - factor * (baseY - topY);
      grid += '<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + right + '" y2="'
        + y.toFixed(1) + '" stroke="#EEF1F5" stroke-width="1"/>';
    });

    var line = '';
    if (points.length > 1) {
      line = '<polyline fill="none" stroke="#1D9E75" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round" points="'
        + points.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
    }
    line += points.map(function (p) {
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.4" fill="#1D9E75"/>';
    }).join('');

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="img">'
      + '<title>近 30 天练习量与正确率</title>'
      + grid
      + '<line x1="' + left + '" y1="' + baseY + '" x2="' + right + '" y2="' + baseY
      + '" stroke="#E3E8EF" stroke-width="1"/>'
      + bars + line
      + '<text x="' + left + '" y="' + (height - 8) + '" font-size="11" fill="#8B95A5">'
      + keys[0].slice(5) + '</text>'
      + '<text x="' + (right - 24) + '" y="' + (height - 8) + '" font-size="11" fill="#8B95A5">今天</text>'
      + '</svg>';
  }

  function subjectMasteryCard() {
    var scoped = visibleKnowledge();
    var blocks = enabledSubjects().map(function (subject) {
      var items = scoped.filter(function (item) { return item.subject === subject; });
      if (!items.length) return null;
      var mastered = 0;
      var learning = 0;
      items.forEach(function (item) {
        var status = statusOf(item.code);
        if (status === 'mastered') mastered += 1;
        else if (status === 'learning') learning += 1;
      });
      var fresh = items.length - mastered - learning;
      var pct = function (n) { return ((n / items.length) * 100).toFixed(1) + '%'; };
      return el('div', { class: 'msub' }, [
        el('div', { class: 'msub-head' }, [
          el('span', { class: 'msub-name', text: subject }),
          el('span', { class: 'card-meta', text: mastered + ' / ' + items.length + ' 已掌握' })
        ]),
        el('div', { class: 'tri' }, [
          el('i', { class: 'seg mastered', style: 'width:' + pct(mastered) }),
          el('i', { class: 'seg learning', style: 'width:' + pct(learning) }),
          el('i', { class: 'seg fresh', style: 'width:' + pct(fresh) })
        ])
      ]);
    }).filter(Boolean);

    if (!blocks.length) return el('div');
    return el('div', { class: 'card' },
      [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '学科掌握度' }),
          el('span', { class: 'card-meta', text: '绿 已掌握 · 橙 待巩固 · 灰 未学' })
        ])
      ].concat(blocks));
  }

  function weakCard() {
    var rows = weakList();
    var head = [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '短板榜' }),
        el('span', { class: 'card-meta', text: rows.length ? '正确率最低 ' + rows.length + ' 个' : '' })
      ])
    ];
    if (!rows.length) {
      head.push(el('p', { class: 'card-summary', text: '练过之后这里会列出正确率最低的知识点，点一下直接重练。' }));
      return el('div', { class: 'card' }, head);
    }
    return el('div', { class: 'card' }, head.concat(rows.map(function (row) {
      return el('button', {
        class: 'weak-row',
        type: 'button',
        onclick: function () { enterLearn(row.knowledge); }
      }, [
        el('span', { class: 'body' }, [
          el('div', { class: 'name', text: row.knowledge.name }),
          el('div', { class: 'sub', text: row.knowledge.subject + ' · 练过 ' + row.record.total_count + ' 题' })
        ]),
        el('span', { class: 'weak-rate', text: Math.round(row.rate * 100) + '%' })
      ]);
    })));
  }

  function activityCard() {
    var groups = {};
    state.activities.forEach(function (row) {
      var key = localDateKey(row.occurred_on);
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });
    var keys = Object.keys(groups).sort().reverse().slice(0, 10);
    var kids = [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '学习流水' }),
        el('span', { class: 'card-meta', text: keys.length ? '最近 ' + keys.length + ' 天' : '' })
      ])
    ];

    if (!keys.length) {
      kids.push(el('p', { class: 'card-summary', text: '学一个知识点、做一次练习、跟读打卡，都会记在这里。' }));
      return el('div', { class: 'card' }, kids);
    }

    keys.forEach(function (key) {
      var day = el('div', { class: 'flow-day' }, [
        el('div', { class: 'flow-date', text: key.slice(5, 7) + '月' + key.slice(8, 10) + '日' })
      ]);
      groups[key].forEach(function (row) {
        day.appendChild(el('div', { class: 'flow-item' }, [
          el('span', { class: 'flow-dot ' + (row.kind || '') }),
          el('span', { class: 'flow-body' }, [
            el('div', { class: 'name', text: row.title || '学习' }),
            el('div', { class: 'sub', text: row.detail || '' })
          ])
        ]));
      });
      kids.push(day);
    });
    return el('div', { class: 'card' }, kids);
  }

  function renderBoard() {
    var page = $('#main-page');
    clear(page);

    var totalQ = state.practiceLogs.length;
    var correctQ = state.practiceLogs.filter(function (row) { return row.is_correct; }).length;
    var stats = progressStats();
    var days = practiceByDay();
    var last30 = 0;
    var keys = lastDays(30);
    keys.forEach(function (key) { last30 += (days[key] || {}).total || 0; });

    page.appendChild(
      el('div', { class: 'stat-grid four' }, [
        statCell(String(activeStreak()), '连续学习 · 天', '#185FA5'),
        statCell(String(totalQ), '累计练习 · 题', '#185FA5'),
        statCell(totalQ ? Math.round((correctQ / totalQ) * 100) + '%' : '—', '平均正确率', '#1D9E75'),
        statCell(String(stats.mastered), '已掌握 · 点', '#1D9E75')
      ])
    );

    page.appendChild(rewardCard());

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '近 30 天时间线' }),
          el('span', { class: 'card-meta', text: '柱 练习量 · 线 正确率' })
        ]),
        el('div', { class: 'chart', html: timelineSvg(days) }),
        el('p', {
          class: 'card-summary',
          text: totalQ
            ? '最近 30 天练了 ' + last30 + ' 题，累计 ' + totalQ + ' 题。'
            : '还没有练习记录，做完一次练习这里就会有数据。'
        })
      ])
    );

    page.appendChild(subjectMasteryCard());
    page.appendChild(weakCard());
    page.appendChild(activityCard());
  }

  // ================= 我的 · 课程设置 =================

  function renderSubjectsPage() {
    var page = $('#sub-page');
    clear(page);

    var catalog = activeTextbooks();
    if (!catalog.length) {
      page.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '教材目录是空的' }),
        el('div', { text: '请先到管理中心启用或添加教材版本' })
      ]));
      return;
    }

    var chosen = {};
    if (state.mySubjects.length) {
      state.mySubjects.forEach(function (row) { chosen[row.textbook_code] = row.enabled !== false; });
    } else {
      catalog.forEach(function (row) { chosen[row.code] = true; });
    }

    var subjects = [];
    catalog.forEach(function (row) {
      if (subjects.indexOf(row.subject) < 0) subjects.push(row.subject);
    });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '选择要学的内容' })]),
        el('p', {
          class: 'card-summary',
          text: '勾选后，今日任务和知识图谱只显示这些内容。每个账号各选各的，互不影响。'
        })
      ])
    );

    var card = el('div', { class: 'card' });
    subjects.forEach(function (subject) {
      card.appendChild(el('div', { class: 'group-title', text: subject }));
      catalog.filter(function (row) { return row.subject === subject; }).forEach(function (row) {
        var count = state.knowledge.filter(function (k) { return k.textbook_code === row.code; }).length;
        var box = el('input', { type: 'checkbox' });
        box.checked = !!chosen[row.code];
        box.addEventListener('change', function () { chosen[row.code] = box.checked; });
        card.appendChild(
          el('label', { class: 'check-row' }, [
            box,
            el('span', { class: 'body' }, [
              el('div', { class: 'name', text: row.name }),
              el('div', {
                class: 'sub',
                text: (row.publisher ? row.publisher + ' · ' : '') + count + ' 个知识点'
              })
            ])
          ])
        );
      });
    });
    page.appendChild(card);

    page.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: '保存',
          onclick: function () {
            var items = catalog.map(function (row) {
              return {
                subject: row.subject,
                textbookCode: row.code,
                enabled: !!chosen[row.code]
              };
            });
            API.profile.save(items)
              .then(function (saved) {
                state.mySubjects = saved;
                state.subject = '全部';
                toast('已保存');
                renderSubjectsPage();
              })
              .catch(fail);
          }
        })
      ])
    );
  }

  // ================= 管理中心 =================

  function renderAdminPage() {
    var page = $('#sub-page');
    clear(page);

    if (!state.isAdmin) {
      page.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '需要管理员权限' }),
        el('div', { text: '请让创建者把你的账号设为管理员' })
      ]));
      return;
    }

    // --- 教材版本 ---
    var catalogCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '教材版本' })]),
      el('p', { class: 'card-summary', text: '停用后，所有账号的课程设置里都不再提供这个版本。' })
    ]);
    state.catalog.forEach(function (row) {
      var count = state.knowledge.filter(function (k) { return k.textbook_code === row.code; }).length;
      var off = row.is_active === false;
      catalogCard.appendChild(
        el('div', { class: 'admin-row' }, [
          el('span', { class: 'body' }, [
            el('div', { class: 'name', text: row.subject + ' · ' + row.name }),
            el('div', { class: 'sub', text: (row.publisher || '—') + ' · ' + count + ' 个知识点' })
          ]),
          el('button', {
            class: 'btn ' + (off ? 'ghost' : 'secondary'),
            type: 'button',
            text: off ? '已停用' : '使用中',
            onclick: function () {
              API.textbook.setActive(row.code, off)
                .then(function () { return loadData(); })
                .then(function () { renderAdminPage(); toast(off ? '已启用' : '已停用'); })
                .catch(fail);
            }
          })
        ])
      );
    });
    page.appendChild(catalogCard);

    // --- 新增教材版本 ---
    var newSubject = el('select', { class: 'field' });
    SUBJECTS.forEach(function (name) {
      newSubject.appendChild(el('option', { value: name, text: name }));
    });
    var newName = el('input', { class: 'field', placeholder: '版本名称，例如 粤教版' });
    var newPub = el('input', { class: 'field', placeholder: '出版社（可留空）' });
    var newCode = el('input', { class: 'field', placeholder: '版本代码，例如 YJ-EN' });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '新增教材版本' })]),
        el('p', {
          class: 'card-summary',
          text: '先建版本，再用下面的「知识点导入」按目录逐条补进去，或者把目录发我批量灌。'
        }),
        el('div', { class: 'form-col' }, [newSubject, newName, newPub, newCode]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: '添加版本',
            onclick: function () {
              var code = newCode.value.trim().toUpperCase();
              var name = newName.value.trim();
              if (!code || !name) return toast('请填写版本代码和名称');
              API.textbook.add({
                code: code,
                subject: newSubject.value,
                name: name,
                publisher: newPub.value.trim()
              })
                .then(function () { return loadData(); })
                .then(function () { renderAdminPage(); toast('已添加'); })
                .catch(fail);
            }
          })
        ])
      ])
    );

    // --- 账号与角色 ---
    var memberCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '账号与角色' })]),
      el('p', {
        class: 'card-summary',
        text: '第一个注册的账号自动成为创建者。管理员可以改教材版本、导入知识点。'
      })
    ]);
    state.members.forEach(function (row) {
      var isSelf = state.session && state.session.user && row.user_id === state.session.user.id;
      var actions = row.role === 'owner'
        ? el('span', { class: 'tag mastered', text: '创建者' })
        : el('button', {
          class: 'btn ghost',
          type: 'button',
          text: row.role === 'admin' ? '取消管理员' : '设为管理员',
          onclick: function () {
            API.member.setRole(row.user_id, row.role === 'admin' ? 'member' : 'admin')
              .then(function () { return API.member.list(); })
              .then(function (list) {
                state.members = list;
                renderAdminPage();
                toast('已更新');
              })
              .catch(fail);
          }
        });
      memberCard.appendChild(
        el('div', { class: 'admin-row' }, [
          el('span', { class: 'body' }, [
            el('div', { class: 'name', text: (row.display_name || '未命名') + (isSelf ? '（我）' : '') }),
            el('div', { class: 'sub', text: roleLabel(row.role) + ' · ' + dateKey(row.joined_at) + ' 加入' })
          ]),
          actions
        ])
      );
    });
    page.appendChild(memberCard);

    // --- 知识点导入 ---
    var target = el('select', { class: 'field' });
    state.catalog.forEach(function (row) {
      target.appendChild(el('option', { value: row.code, text: row.subject + ' · ' + row.name }));
    });
    var lines = el('textarea', {
      class: 'field mini',
      rows: '6',
      placeholder: '每行一个，用竖线分隔：\n知识点名称 | 章节 | 一句话说明\n\n例如：\n圆的面积 | 第五单元 圆 | 把圆剪拼成近似长方形推导出公式'
    });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '知识点导入' })]),
        el('p', {
          class: 'card-summary',
          text: '把教材目录整理成上面的格式粘进来，就能补进对应版本的知识图谱。导入的知识点编号自动生成。'
        }),
        el('div', { class: 'form-col' }, [target, lines]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: '导入知识点',
            onclick: function () { importKnowledge(target.value, lines.value, lines); }
          })
        ])
      ])
    );

    // --- AI 生成知识点 ---
    var aiTarget = el('select', { class: 'field' });
    aiTarget.appendChild(el('option', { value: '__new__', text: '➕ 新建教材版本…' }));
    state.catalog.forEach(function (row) {
      aiTarget.appendChild(el('option', { value: row.code, text: textbookFullName(row.code) }));
    });

    var aiSubject = el('select', { class: 'field' });
    SUBJECTS.forEach(function (name) {
      aiSubject.appendChild(el('option', { value: name, text: name }));
    });
    var aiGrade = el('select', { class: 'field' });
    ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].forEach(function (g) {
      aiGrade.appendChild(el('option', { value: g, text: g }));
    });
    aiGrade.value = '六年级';

    var aiName = el('input', { class: 'field', placeholder: '版本名称，例如 人教版' });
    var aiPublisher = el('input', { class: 'field', placeholder: '出版社（可留空）' });
    var aiCode = el('input', { class: 'field', placeholder: '版本代码，例如 YW5-AI' });
    var aiCodeTouched = false;
    aiCode.addEventListener('input', function () { aiCodeTouched = !!aiCode.value.trim(); });

    function suggestCode() {
      if (aiCodeTouched) return;
      var sub = SUBJECT_CODES[aiSubject.value] || 'TB';
      var num = GRADE_NUMBERS[aiGrade.value] || 0;
      aiCode.value = sub + num + '-AI';
    }
    aiSubject.addEventListener('change', suggestCode);
    aiGrade.addEventListener('change', suggestCode);
    suggestCode();

    var aiNewWrap = el('div', { class: 'form-col' }, [aiSubject, aiGrade, aiName, aiPublisher, aiCode]);

    var aiDesc = el('textarea', {
      class: 'field mini',
      rows: '6',
      placeholder: '描述教材内容或粘贴目录，例如：\n五年级语文人教版上册：第一单元《白鹭》《落花生》…第二单元…'
    });
    var aiFile = el('input', { class: 'field', type: 'file', accept: '.pdf,application/pdf' });
    var aiStatus = el('div', { class: 'hint-line', text: '' });
    var aiRun = el('button', { class: 'btn', type: 'button', text: 'AI 生成知识点' });

    aiTarget.addEventListener('change', function () {
      aiNewWrap.style.display = aiTarget.value === '__new__' ? '' : 'none';
    });

    aiRun.addEventListener('click', function () {
      if (aiRun.disabled) return;
      var isNew = aiTarget.value === '__new__';
      var material = String(aiDesc.value || '').trim();
      var file = aiFile.files && aiFile.files[0];

      aiRun.disabled = true;
      aiRun.textContent = file ? '正在读取 PDF…' : 'AI 生成中…';

      var pre = file
        ? readPdfText(file).then(function (pdfText) {
          if (!pdfText.trim()) {
            throw new Error('这份 PDF 提取不到文字（可能是扫描件），请直接粘贴教材目录');
          }
          material = (material + '\n' + pdfText).trim();
          return material;
        })
        : Promise.resolve(material);

      pre.then(function (finalMaterial) {
        if (!finalMaterial) throw new Error('请先填写教材说明或导入 PDF');
        if (isNew) {
          var code = aiCode.value.trim().toUpperCase();
          var name = aiName.value.trim();
          if (!name) throw new Error('请填写版本名称');
          if (!code) throw new Error('请填写版本代码');
          if (state.catalog.some(function (row) { return row.code === code; })) {
            throw new Error('版本代码 ' + code + ' 已存在，换一个');
          }
          aiStatus.textContent = '正在创建教材版本…';
          return API.textbook.add({
            code: code,
            subject: aiSubject.value,
            name: name,
            publisher: aiPublisher.value.trim(),
            gradeScope: aiGrade.value,
            sortNo: 90
          }).then(function (created) {
            if (!created) throw new Error('教材版本创建失败');
            return loadData().then(function () {
              return aiGenerateKnowledge({
                code: code,
                subject: aiSubject.value,
                name: name,
                publisher: aiPublisher.value.trim(),
                gradeScope: aiGrade.value,
                material: finalMaterial,
                status: aiStatus
              });
            });
          });
        }
        var row = state.catalog.filter(function (item) { return item.code === aiTarget.value; })[0];
        if (!row) throw new Error('请选择教材版本');
        return aiGenerateKnowledge({
          code: row.code,
          subject: row.subject,
          name: row.name,
          publisher: row.publisher || '',
          gradeScope: row.grade_scope || '',
          material: finalMaterial,
          status: aiStatus
        });
      })
        .then(function (added) {
          if (!added) return null;
          aiStatus.textContent = '';
          aiDesc.value = '';
          aiFile.value = '';
          toast('AI 已生成 ' + added + ' 个知识点');
          return loadData().then(renderAdminPage);
        })
        .catch(function (error) {
          aiStatus.textContent = '';
          fail(error);
        })
        .finally(function () {
          aiRun.disabled = false;
          aiRun.textContent = 'AI 生成知识点';
        });
    });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: 'AI 生成知识点' })]),
        el('p', {
          class: 'card-summary',
          text: '选择已有教材或新建一个版本（例如五年级语文人教版），粘贴教材说明/目录或导入教材 PDF，AI 会自动整理出知识点并加进知识图谱。'
        }),
        aiTarget,
        aiNewWrap,
        el('div', { class: 'form-col' }, [
          el('div', { class: 'field-label', text: '教材说明 / 目录（可直接粘贴，也可用下面的 PDF 导入）' }),
          aiDesc,
          el('div', { class: 'field-label', text: '导入教材 PDF（可选，自动提取文字，扫描件不支持）' }),
          aiFile
        ]),
        aiStatus,
        el('div', { class: 'actions' }, [aiRun])
      ])
    );
  }

  async function importKnowledge(textbookCode, text, textarea) {
    var catalogRow = state.catalog.filter(function (row) { return row.code === textbookCode; })[0];
    if (!catalogRow) return toast('请选择教材版本');

    var parsed = [];
    String(text || '').split('\n').forEach(function (line) {
      var raw = line.trim();
      if (!raw) return;
      var parts = raw.split(/[|｜\t]/).map(function (part) { return part.trim(); });
      if (!parts[0]) return;
      parsed.push({ name: parts[0], chapter: parts[1] || '自定义', summary: parts[2] || '' });
    });
    if (!parsed.length) return toast('没有解析出内容，检查分隔符');

    var existing = state.knowledge.filter(function (k) { return k.textbook_code === textbookCode; });
    var base = existing.length;
    var used = {};
    existing.forEach(function (k) { used[k.code] = true; });

    try {
      var added = 0;
      for (var i = 0; i < parsed.length; i++) {
        var seq = base + i + 1;
        var code = textbookCode + '-C' + seq;
        while (used[code]) {
          seq += 1;
          code = textbookCode + '-C' + seq;
        }
        used[code] = true;
        await API.cloud.database.from('ee_knowledge').insert({
          code: code,
          subject: catalogRow.subject,
          textbook: catalogRow.name,
          textbook_code: textbookCode,
          grade: catalogRow.grade_scope || '六年级',
          term: '自定义',
          chapter: parsed[i].chapter,
          name: parsed[i].name,
          summary: parsed[i].summary,
          difficulty: 3,
          order_no: seq
        }).select();
        added += 1;
      }
      if (textarea) textarea.value = '';
      await loadData();
      renderAdminPage();
      toast('已导入 ' + added + ' 个知识点');
    } catch (error) {
      fail(error);
    }
  }

  // ================= AI 生成知识点 =================

  var AI_KNOWLEDGE_SYSTEM = '你是小学教研专家，负责把教材目录整理成知识点清单。' +
    '严格只输出一个 JSON 对象，不要解释，不要用代码块包裹。';

  var AI_TERMS = ['上册', '下册', '全册', '自定义'];

  var SUBJECT_CODES = { '语文': 'YW', '数学': 'SX', '英语': 'YY', '奥数': 'AS', '信息学': 'XX' };
  var GRADE_NUMBERS = {
    '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6
  };

  function aiKnowledgePrompt(meta, material, part, parts) {
    return '教材信息：' + meta +
      '\n\n教材内容/目录（第 ' + part + '/' + parts + ' 部分）：\n' + material + '\n\n' +
      '请根据上面的教材内容整理知识点，输出 JSON：' +
      '{"items":[{"name":"知识点名称，简短","chapter":"所属单元或章节，例如 第一单元",' +
      '"term":"上册|下册|全册|自定义 之一","summary":"一句话说明，讲给小学生家长听","difficulty":1}]}。' +
      '要求：按教材内容出现顺序整理；知识点粒度适中（一册教材 20~60 个）；' +
      'difficulty 是 1~5 的整数；材料里没有的信息不要编造。';
  }

  function parseAiItems(text) {
    var raw = String(text || '').trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    var data = JSON.parse(raw);
    return Array.isArray(data.items) ? data.items : [];
  }

  // Extracts text client-side so the description and the PDF share one AI
  // pipeline. Scanned PDFs without a text layer yield little or nothing.
  async function readPdfText(file) {
    if (!window.pdfjsLib) {
      throw new Error('PDF 组件没有加载成功，请检查网络后刷新页面');
    }
    if (!window.pdfjsLib.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    var buffer = await file.arrayBuffer();
    var pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    var maxPages = Math.min(pdf.numPages, 40);
    var text = '';
    for (var p = 1; p <= maxPages; p++) {
      var page = await pdf.getPage(p);
      var content = await page.getTextContent();
      text += content.items.map(function (piece) { return piece.str; }).join('') + '\n';
      if (text.length > 16000) break;
    }
    return text;
  }

  // Asks the AI to turn a textbook description / catalog / PDF text into
  // knowledge rows and inserts them into the target textbook. Long material
  // is split into capped chunks so one call never overflows the context.
  async function aiGenerateKnowledge(options) {
    var status = options.status;
    var material = String(options.material || '').replace(/\s+/g, ' ').trim();
    if (material.length > 16000) material = material.slice(0, 16000);

    var chunks = [];
    for (var i = 0; i < material.length; i += 9000) chunks.push(material.slice(i, i + 9000));
    if (chunks.length > 4) chunks = chunks.slice(0, 4);

    var meta = (options.gradeScope || '') + (options.subject || '') + (options.name || '') +
      (options.publisher ? '（' + options.publisher + '）' : '');

    var collected = [];
    for (var c = 0; c < chunks.length; c++) {
      if (status) status.textContent = 'AI 正在阅读教材（第 ' + (c + 1) + '/' + chunks.length + ' 部分）…';
      var text = await API.llm.stream(
        AI_KNOWLEDGE_SYSTEM,
        aiKnowledgePrompt(meta, chunks[c], c + 1, chunks.length),
        null,
        { json: true, temperature: 0.2, firstTokenTimeout: 120000 }
      );
      collected = collected.concat(parseAiItems(text));
    }

    var seen = {};
    collected = collected.filter(function (item) {
      var name = String(item && item.name || '').trim();
      if (!name || seen[name]) return false;
      seen[name] = true;
      return true;
    });
    if (!collected.length) {
      throw new Error('AI 没有整理出知识点，换个更具体的教材描述试试');
    }

    var existing = state.knowledge.filter(function (k) { return k.textbook_code === options.code; });
    var used = {};
    existing.forEach(function (k) { used[k.code] = true; });
    var seq = existing.length;
    var added = 0;

    for (var n = 0; n < collected.length; n++) {
      var item = collected[n];
      var term = AI_TERMS.indexOf(item.term) >= 0 ? item.term : '自定义';
      var difficulty = Math.max(1, Math.min(5, Math.round(Number(item.difficulty) || 3)));
      seq += 1;
      var kcode = options.code + '-C' + seq;
      while (used[kcode]) {
        seq += 1;
        kcode = options.code + '-C' + seq;
      }
      used[kcode] = true;
      await API.cloud.database.from('ee_knowledge').insert({
        code: kcode,
        subject: options.subject,
        textbook: options.name,
        textbook_code: options.code,
        grade: options.gradeScope || '六年级',
        term: term,
        chapter: String(item.chapter || '').trim() || '自定义',
        name: String(item.name || '').trim(),
        summary: String(item.summary || '').trim(),
        difficulty: difficulty,
        order_no: seq
      }).select();
      added += 1;
    }
    return added;
  }

  // ================= 拍照导入错题 =================

  function importDraft() {
    if (!state.importing) {
      state.importing = {
        stage: 'pick',
        subject: null,
        textbookCode: null,
        dataUrl: null,
        blob: null,
        items: [],
        busy: false,
        message: ''
      };
    }
    return state.importing;
  }

  function fieldLabel(text) {
    return el('div', { class: 'field-label', text: text });
  }

  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取照片失败')); };
      reader.onload = function () {
        var image = new Image();
        image.onerror = function () { reject(new Error('这张图片打不开，换一张试试')); };
        image.onload = function () {
          var scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          var width = Math.max(1, Math.round(image.width * scale));
          var height = Math.max(1, Math.round(image.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          var binary = atob(dataUrl.split(',')[1]);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          resolve({ dataUrl: dataUrl, blob: new Blob([bytes], { type: 'image/jpeg' }) });
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function parseExtraction(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```[a-z]*/i, '').replace(/```$/, '').trim();
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);

    var data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { subject: '', items: [] };
    }
    var list = Array.isArray(data.items) ? data.items : [];
    var items = list.map(function (row) {
      return {
        stem: String(row.stem || '').trim(),
        options: Array.isArray(row.options) && row.options.length ? row.options : null,
        answer: String(row.answer === undefined || row.answer === null ? '' : row.answer).trim(),
        analysis: String(row.analysis || '').trim(),
        wrongReason: String(row.wrong_reason || row.wrongReason || '').trim(),
        knowledgeName: String(row.knowledge || '').trim()
      };
    }).filter(function (row) { return row.stem; });

    return { subject: String(data.subject || '').trim(), items: items };
  }

  function matchKnowledge(name, subject) {
    var target = String(name || '').trim();
    if (!target) return null;
    var pool = state.knowledge.filter(function (k) { return !subject || k.subject === subject; });
    var exact = pool.filter(function (k) { return k.name === target; })[0];
    if (exact) return exact;
    return pool.filter(function (k) {
      return k.name.indexOf(target) >= 0 || target.indexOf(k.name) >= 0;
    })[0] || null;
  }

  function draftItemCard(item, index) {
    var stem = el('textarea', { class: 'field mini', rows: '3' });
    stem.value = item.stem;
    stem.addEventListener('input', function () { item.stem = stem.value; });

    var answer = el('input', { class: 'field', placeholder: '正确答案' });
    answer.value = item.answer;
    answer.addEventListener('input', function () { item.answer = answer.value; });

    var analysis = el('textarea', { class: 'field mini', rows: '3' });
    analysis.value = item.analysis;
    analysis.addEventListener('input', function () { item.analysis = analysis.value; });

    var knowledge = el('input', { class: 'field', placeholder: '对应知识点名称，可留空' });
    knowledge.value = item.knowledgeName || '';
    knowledge.addEventListener('input', function () { item.knowledgeName = knowledge.value; });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: 'read-no', text: String(index) }),
        el('h3', { class: 'card-title', text: item.knowledgeName || '第 ' + index + ' 题' }),
        el('button', {
          class: 'link-btn',
          type: 'button',
          text: '删除',
          onclick: function () {
            var draft = importDraft();
            draft.items.splice(index - 1, 1);
            renderImportPage();
          }
        })
      ]),
      el('div', { class: 'form-col' }, [
        fieldLabel('题干'), stem,
        fieldLabel('答案'), answer,
        fieldLabel('解析'), analysis,
        fieldLabel('知识点'), knowledge
      ])
    ]);
  }

  function renderImportPage() {
    var page = $('#sub-page');
    clear(page);

    var draft = importDraft();
    var catalog = activeTextbooks();
    var subjects = [];
    catalog.forEach(function (row) {
      if (subjects.indexOf(row.subject) < 0) subjects.push(row.subject);
    });

    if (draft.subject && subjects.indexOf(draft.subject) < 0) draft.subject = null;
    if (draft.textbookCode && !catalog.some(function (r) { return r.code === draft.textbookCode; })) {
      draft.textbookCode = null;
    }

    var subjectSelect = el('select', { class: 'field' });
    subjects.forEach(function (name) {
      subjectSelect.appendChild(el('option', { value: name, text: name }));
    });
    if (draft.subject) subjectSelect.value = draft.subject;
    else draft.subject = subjects[0] || null;

    var bookSelect = el('select', { class: 'field' });
    function fillBooks() {
      clear(bookSelect);
      catalog.filter(function (row) { return row.subject === subjectSelect.value; }).forEach(function (row) {
        bookSelect.appendChild(el('option', { value: row.code, text: row.name }));
      });
      if (draft.textbookCode && bookSelect.querySelector('option[value="' + draft.textbookCode + '"]')) {
        bookSelect.value = draft.textbookCode;
      } else {
        draft.textbookCode = bookSelect.value || null;
      }
    }
    fillBooks();

    subjectSelect.addEventListener('change', function () {
      draft.subject = subjectSelect.value;
      draft.textbookCode = null;
      fillBooks();
    });
    bookSelect.addEventListener('change', function () { draft.textbookCode = bookSelect.value; });

    var fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (file) prepareImage(file);
      fileInput.value = '';
    });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '拍照或选图' })]),
        el('p', {
          class: 'card-summary',
          text: '对着错题拍一张，AI 会把题干、答案和讲解整理成结构化内容，你核对一遍再入库。'
        }),
        el('div', { class: 'form-col' }, [subjectSelect, bookSelect, fileInput]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: draft.dataUrl ? '换一张照片' : '选择照片',
            onclick: function () { fileInput.click(); }
          })
        ])
      ])
    );

    if (draft.dataUrl) {
      page.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '照片预览' })]),
          el('img', { class: 'shot', src: draft.dataUrl, alt: '错题照片' })
        ])
      );
    }

    if (draft.busy) {
      page.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'working' }, [
            el('span', { class: 'spinner dark' }),
            el('span', { text: draft.message || '处理中…' })
          ])
        ])
      );
    } else if (draft.dataUrl && !draft.items.length) {
      page.appendChild(
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn', type: 'button', text: '开始识别', onclick: recognizePhoto }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '手动填写',
            onclick: function () {
              draft.items = [{
                stem: '', options: null, answer: '', analysis: '', wrongReason: '', knowledgeName: ''
              }];
              draft.message = '手动填写题干、答案和解析，然后入库。';
              renderImportPage();
            }
          })
        ])
      );
    }

    if (draft.message && !draft.busy) {
      page.appendChild(el('p', { class: 'hint-line', text: draft.message }));
    }

    if (draft.items.length) {
      draft.items.forEach(function (item, i) { page.appendChild(draftItemCard(item, i + 1)); });

      page.appendChild(
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn', type: 'button', text: '确认入库', onclick: saveImported }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '加一道空白题',
            onclick: function () {
              draft.items.push({
                stem: '', options: null, answer: '', analysis: '', wrongReason: '', knowledgeName: ''
              });
              renderImportPage();
            }
          })
        ])
      );
    }
  }

  function prepareImage(file) {
    var draft = importDraft();
    draft.busy = true;
    draft.message = '正在处理照片…';
    renderImportPage();
    compressImage(file, 1400, 0.72).then(function (result) {
      draft.dataUrl = result.dataUrl;
      draft.blob = result.blob;
      draft.items = [];
      draft.busy = false;
      draft.message = '照片已就绪，点「开始识别」让 AI 读题。';
      renderImportPage();
    }).catch(function (error) {
      draft.busy = false;
      draft.message = '';
      renderImportPage();
      fail(error);
    });
  }

  async function recognizePhoto() {
    var draft = importDraft();
    if (!draft.dataUrl) return;
    draft.busy = true;
    draft.message = 'AI 正在读这张照片，题目多的话要等十几秒…';
    renderImportPage();

    try {
      var raw = await API.vision.extract(draft.dataUrl, {
        onThinking: function () {
          if (draft.message.indexOf('思考') < 0) {
            draft.message = 'AI 正在思考怎么讲这道题…';
            renderImportPage();
          }
        }
      });
      var parsed = parseExtraction(raw);
      if (parsed.subject && state.knowledge.some(function (k) { return k.subject === parsed.subject; })) {
        draft.subject = parsed.subject;
      }
      draft.items = parsed.items;
      if (!draft.items.length) {
        draft.items = [{
          stem: '', options: null, answer: '', analysis: '', wrongReason: '', knowledgeName: ''
        }];
        draft.message = '没能识别出题目，可以换一张更清楚的照片，或者直接手动填写。';
      } else {
        draft.message = '识别到 ' + parsed.items.length + ' 道题，核对或修改后再入库。';
      }
      draft.busy = false;
      renderImportPage();
    } catch (error) {
      draft.busy = false;
      draft.message = '';
      renderImportPage();
      fail(error);
    }
  }

  async function saveImported() {
    var draft = importDraft();
    var items = draft.items.filter(function (row) { return row.stem && row.stem.trim(); });
    if (!items.length) return toast('还没有可入库的题目');
    if (!state.student) return toast('还没有建立学习档案');

    draft.busy = true;
    draft.message = '正在入库…';
    renderImportPage();

    try {
      var imagePath = null;
      if (draft.blob && state.session && state.session.user) {
        try {
          imagePath = await API.files.upload(
            state.session.user.id,
            draft.blob,
            'image/jpeg',
            'wq-' + Date.now() + '.jpg'
          );
        } catch (error) {
          // The question text matters more than the photo.
          if (window.console) console.error(error);
        }
      }

      var payload = items.map(function (row) {
        var knowledge = matchKnowledge(row.knowledgeName, draft.subject);
        return {
          subject: draft.subject,
          textbookCode: draft.textbookCode,
          knowledgeCode: knowledge ? knowledge.code : null,
          knowledgeName: row.knowledgeName || (knowledge ? knowledge.name : null),
          stem: row.stem.trim(),
          options: row.options,
          answer: row.answer,
          analysis: row.analysis,
          wrongReason: row.wrongReason,
          imagePath: imagePath
        };
      });

      await API.myQuestion.insertBatch(state.student.id, payload);
      for (var i = 0; i < payload.length; i++) {
        await API.study.addWrong({
          studentId: state.student.id,
          knowledgeCode: payload[i].knowledgeCode,
          subject: payload[i].subject,
          stem: payload[i].stem,
          options: payload[i].options,
          correctAnswer: payload[i].answer || '（未填写答案）',
          analysis: payload[i].analysis,
          wrongReason: payload[i].wrongReason,
          imagePath: payload[i].imagePath,
          source: 'import'
        });
      }

      await API.activity.log({
        studentId: state.student.id,
        kind: 'import',
        subject: draft.subject,
        title: '导入错题 · ' + draft.subject,
        detail: '入库 ' + payload.length + ' 道题',
        minutes: 5
      });

      state.importing = null;
      await loadData();
      renderImportPage();
      toast('已入库 ' + payload.length + ' 道题');
    } catch (error) {
      draft.busy = false;
      draft.message = '';
      renderImportPage();
      fail(error);
    }
  }

  // ================= 错题重做 =================

  function reviewPool(source) {
    if (source === 'wrong') {
      return state.wrongList.map(function (row) {
        return {
          type: row.options && row.options.length ? 'choice' : 'blank',
          stem: row.stem,
          options: row.options && row.options.length ? row.options : null,
          answer: row.correct_answer || '',
          analysis: row.analysis || '',
          knowledgeCode: row.knowledge_code || null,
          subjectHint: row.subject || null
        };
      });
    }
    return state.myQuestions.map(function (row) {
      return {
        type: row.options && row.options.length ? 'choice' : 'blank',
        stem: row.stem,
        options: row.options && row.options.length ? row.options : null,
        answer: row.answer || '',
        analysis: row.analysis || '',
        knowledgeCode: row.knowledge_code || null,
        subjectHint: row.subject || null
      };
    });
  }

  function beginReview(source, limit) {
    var pool = reviewPool(source).filter(function (row) { return row.stem && row.answer; });
    if (!pool.length) return toast('还没有可重做的题目');

    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
    }
    var picked = pool.slice(0, limit);
    var subject = picked[0].subjectHint || '综合';

    state.learn = {
      mode: 'review',
      knowledge: {
        code: 'REVIEW',
        name: '错题重做',
        subject: subject,
        chapter: '共 ' + picked.length + ' 题'
      },
      step: 'practice',
      lesson: '',
      lessonDone: true,
      questions: picked,
      index: 0,
      answers: [],
      busy: false
    };
    $('#learn-title').textContent = '错题重做';
    $('#learn-sub').textContent = subject + ' · ' + picked.length + ' 题';
    state.subStack = [];
    showScreen('learn');
    renderLearn();
  }

  function renderReviewPage() {
    var page = $('#sub-page');
    clear(page);

    var importCount = state.myQuestions.length;
    var wrongCount = state.wrongList.length;

    var source = el('select', { class: 'field' });
    source.appendChild(el('option', { value: 'import', text: '导入的错题（' + importCount + ' 道）' }));
    source.appendChild(el('option', { value: 'wrong', text: '错题本（' + wrongCount + ' 道）' }));

    var count = el('select', { class: 'field' });
    [5, 10, 20].forEach(function (n, i) {
      count.appendChild(el('option', { value: String(n), text: '最多 ' + n + ' 题' }));
      if (i === 1) count.value = String(n);
    });

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '组一套重做' })]),
        el('p', {
          class: 'card-summary',
          text: '每次随机抽题，做完立刻判分。做错的继续留在错题本，做对的会记进掌握度和看板。'
        }),
        el('div', { class: 'form-col' }, [source, count]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: '开始重做',
            onclick: function () { beginReview(source.value, Number(count.value)); }
          }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '再导入一批',
            onclick: function () { pushSub('import'); }
          })
        ])
      ])
    );

    if (!importCount && !wrongCount) {
      page.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '还没有可重做的题' }),
          el('div', { text: '先导入一批错题，或者去做练习积累错题本' })
        ])
      );
      return;
    }

    if (importCount) {
      page.appendChild(
        el('div', { class: 'section-title' }, [
          '导入的错题',
          el('span', { class: 'count', text: importCount + ' 道' })
        ])
      );
      state.myQuestions.slice(0, 30).forEach(function (row) {
        page.appendChild(
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [
              el('h3', { class: 'card-title', text: row.knowledge_name || row.subject || '错题' }),
              el('span', { class: 'card-meta', text: dateKey(row.created_at) })
            ]),
            el('p', { class: 'card-summary', text: row.stem }),
            row.answer ? el('div', { class: 'line', text: '答案：' + row.answer }) : null,
            row.analysis ? el('p', { class: 'card-summary', text: '解析：' + row.analysis }) : null
          ])
        );
      });
    }
  }

  // ---------------- virtual lab: offline-hosted PhET sims ----------------

  // Each sim is a single self-contained Chinese HTML file under ./sim/
  // (built by PhET, University of Colorado Boulder, GPL-3.0).
  var LAB_SIMS = [
    { id: 'states-of-matter-basics', emoji: '🔥', name: '物质状态', subject: '科学', desc: '给水加热/冷却，观察固液气三态与粒子运动变化' },
    { id: 'acid-base-solutions', emoji: '🧪', name: '酸碱溶液', subject: '化学', desc: '配置酸碱溶液，看浓度、pH 和导电性如何变化' },
    { id: 'ph-scale', emoji: '🧫', name: 'pH 值', subject: '化学', desc: '把常见的液体放到 pH 尺上，比较酸碱性强弱' },
    { id: 'circuit-construction-kit-dc', emoji: '⚡', name: '电路搭建', subject: '物理', desc: '拖动电池、灯泡、导线搭真实电路，看电流怎么走' },
    { id: 'forces-and-motion-basics', emoji: '🧱', name: '力和运动', subject: '物理', desc: '推箱子比赛：力、摩擦、质量谁说了算' },
    { id: 'density', emoji: '⚖️', name: '密度', subject: '物理', desc: '不同材料放进水里，谁沉谁浮？' },
    { id: 'bending-light', emoji: '🌈', name: '光的折射', subject: '物理', desc: '让光穿过水和玻璃，看它怎么拐弯' },
    { id: 'magnets-and-electromagnets', emoji: '🧲', name: '磁铁与电磁铁', subject: '物理', desc: '拖动磁铁看磁场线，自己造一个电磁铁' }
  ];

  function renderLab() {
    var page = $('#main-page');
    clear(page);
    page.appendChild(el('div', { class: 'card', style: 'text-align:center' }, [
      el('div', { style: 'font-size:34px;line-height:1.2' }, ['🔬']),
      el('div', { class: 'card-title', style: 'margin:4px 0 2px' }, ['虚拟实验室']),
      el('div', { class: 'hint', style: 'text-align:center' }, ['来自 PhET（科罗拉多大学）的互动仿真 · 动手做实验，玩着学'])
    ]));
    var grid = el('div', { class: 'sim-grid' });
    LAB_SIMS.forEach(function (s) {
      grid.appendChild(el('a', {
        class: 'sim-card',
        href: 'sim/' + s.id + '.html',
        target: '_blank',
        rel: 'noopener'
      }, [
        el('div', { class: 'sim-emoji' }, [s.emoji]),
        el('div', { class: 'sim-name' }, [s.name]),
        el('div', { class: 'sim-desc' }, [s.desc]),
        el('span', { class: 'qchip' }, [s.subject])
      ]));
    });
    page.appendChild(grid);

    // ---- 3D immersive lab (Maroon, Graz University of Technology, BSD-2) ----
    // Deep links to the official WebGL build; not self-hosted.
    var MAROON_URL = 'https://maroon.tugraz.at/build/web/?LoadScene=';
    var MAROON_EXPS = [
      { scene: 'TitrationExperiment', emoji: '⚗️', name: '3D 滴定实验', subject: '化学', desc: '真实 3D 视角做滴定：选试剂、控流速、看颜色突变（和化学实验室的滴定模块配套）' },
      { scene: 'Optics', emoji: '🔦', name: '3D 光学实验', subject: '物理', desc: '激光的反射、折射、透镜与光纤，实时调参数看光路变化' },
      { scene: 'FaradaysLaw', emoji: '🧲', name: '3D 法拉第定律', subject: '物理', desc: '在 3D 磁场里移动导体，看电磁感应如何产生电流' },
      { scene: 'Pendulum', emoji: '🕰️', name: '3D 单摆', subject: '物理', desc: '改摆长、摆重，观察周期怎么变（3D 沉浸版）' }
    ];
    page.appendChild(el('div', { style: 'margin-top:18px;text-align:center' }, [
      el('div', { class: 'card-title', style: 'font-size:15px' }, ['🎥 3D 沉浸实验室（Maroon）']),
      el('div', { class: 'hint', style: 'text-align:center' }, ['格拉茨工业大学 Unity 3D 实验 · 首次加载约 1-2 分钟，建议用电脑打开'])
    ]));
    var mgrid = el('div', { class: 'sim-grid' });
    MAROON_EXPS.forEach(function (s) {
      mgrid.appendChild(el('a', {
        class: 'sim-card',
        href: MAROON_URL + s.scene,
        target: '_blank',
        rel: 'noopener'
      }, [
        el('div', { class: 'sim-emoji' }, [s.emoji]),
        el('div', { class: 'sim-name' }, [s.name]),
        el('div', { class: 'sim-desc' }, [s.desc]),
        el('span', { class: 'qchip' }, [s.subject])
      ]));
    });
    page.appendChild(mgrid);
  }

  function switchTab(tab) {
    state.tab = tab;
    // Leaving the reading tab must not leave the microphone or the
    // speaker running in the background.
    if (tab !== 'reading') {
      if (state.reading.recording) stopRecording();
      stopDemo();
    }
    $$('#tabbar button').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-tab') === tab);
    });
    var titles = {
      today: '今日任务',
      map: '知识图谱',
      reading: '英语跟读',
      bank: '题库刷练',
      lab: '虚拟实验室',
      wrong: '错题本',
      board: '学习看板'
    };
    $('#main-title').textContent = titles[tab] || '全科导学';
    var stats = progressStats();
    $('#main-sub').textContent = state.student
      ? state.student.student_name + ' · 已掌握 ' + stats.mastered + '/' + stats.total
      : '';
    if (tab === 'today') renderToday();
    else if (tab === 'map') renderMap();
    else if (tab === 'reading') renderReading();
    else if (tab === 'bank') renderBank();
    else if (tab === 'lab') renderLab();
    else if (tab === 'wrong') renderWrong();
    else renderBoard();
  }

  // ---------------- rewards: daily tasks, xp, diamonds, shop ----------------

  // Level names cycle like the Duolingo-style ladder in ChinaStudyFree, but
  // the currency is family-sized: diamonds buy real-life rewards the parent
  // defines in the shop.
  var LEVEL_NAMES = ['见习生', '小学徒', '探索者', '思考者', '解题手', '小达人', '小博士', '学霸', '学神', '传奇'];
  var XP_PER_LEVEL = 100;

  function rewardLevel(xp) {
    var level = Math.floor((xp || 0) / XP_PER_LEVEL) + 1;
    var name = level <= LEVEL_NAMES.length ? LEVEL_NAMES[level - 1] : '传奇+' + (level - LEVEL_NAMES.length);
    return { level: level, name: name, progress: (xp || 0) % XP_PER_LEVEL };
  }

  function todayKey() {
    return localDateKey(new Date().toISOString());
  }

  // The record API persists to the cloud but does not hand back the row, so
  // the daily-task counters (and the board charts) would stay stale until the
  // next full reload. Fold a local mirror into practiceLogs right away.
  function pushLocalPracticeLog(entry) {
    state.practiceLogs.push({
      student_id: state.student.id,
      knowledge_code: entry.knowledgeCode,
      subject: entry.subject || null,
      textbook_code: entry.textbookCode || null,
      qtype: entry.qtype || 'choice',
      stem: entry.stem,
      user_answer: entry.userAnswer,
      correct_answer: entry.correctAnswer,
      is_correct: entry.isCorrect,
      source: entry.source || 'practice',
      created_at: new Date().toISOString()
    });
  }

  function todayPracticeStats() {
    var today = todayKey();
    var stats = { total: 0, correct: 0, bank: 0, review: 0, reading: 0 };
    state.practiceLogs.forEach(function (row) {
      if (localDateKey(row.created_at) !== today) return;
      stats.total += 1;
      if (row.is_correct) stats.correct += 1;
      if (row.source === 'bank') stats.bank += 1;
      if (row.source === 'review') stats.review += 1;
    });
    state.reading.logs.forEach(function (row) {
      if (dateKey(row.read_date) === today) stats.reading += 1;
    });
    return stats;
  }

  // Daily task list. progress()/done() are computed from logs the app already
  // keeps, so finishing real work is the only way to light a task up.
  var REWARD_TASKS = [
    {
      code: 'practice10', emoji: '✏️', name: '今日练习 10 题', goal: 10, diamonds: 10, xp: 20,
      progress: function (s) { return Math.min(s.total, 10); },
      done: function (s) { return s.total >= 10; }
    },
    {
      code: 'accuracy80', emoji: '🎯', name: '今日正确率达到 80%（10 题起）', goal: 1, diamonds: 15, xp: 20,
      progress: function (s) { return s.total >= 10 && s.correct / s.total >= 0.8 ? 1 : 0; },
      done: function (s) { return s.total >= 10 && s.correct / s.total >= 0.8; }
    },
    {
      code: 'reading1', emoji: '🎤', name: '英语跟读打卡 1 句', goal: 1, diamonds: 10, xp: 15,
      progress: function (s) { return Math.min(s.reading || 0, 1); },
      done: function (s) { return (s.reading || 0) >= 1; }
    },
    {
      code: 'bank5', emoji: '🧩', name: '完成一组题库刷练（5 题）', goal: 5, diamonds: 10, xp: 15,
      progress: function (s) { return Math.min(s.bank, 5); },
      done: function (s) { return s.bank >= 5; }
    },
    {
      code: 'review3', emoji: '🔁', name: '错题重做 3 道', goal: 3, diamonds: 10, xp: 15,
      progress: function (s) { return Math.min(s.review, 3); },
      done: function (s) { return s.review >= 3; }
    },
    {
      code: 'all', emoji: '🏆', name: '完成上面全部 5 项', goal: 1, diamonds: 20, xp: 30,
      bonus: true,
      progress: function (s, claimedSet) {
        var done = REWARD_TASKS.filter(function (t) { return !t.bonus && t.done(s); }).length;
        return done === 5 || claimedSet.has('all') ? 1 : 0;
      },
      done: function (s, claimedSet) {
        var required = REWARD_TASKS.filter(function (t) { return !t.bonus; });
        return required.every(function (t) { return claimedSet.has(t.code) || t.done(s); });
      }
    }
  ];

  function claimedTaskCodes() {
    var set = new Set();
    state.rewards.taskLogs.forEach(function (row) { set.add(row.task_code); });
    return set;
  }

  function loadRewards() {
    var rewards = state.rewards;
    if (rewards.loading || rewards.loaded || !state.student) return;
    rewards.loading = true;
    var day = todayKey();
    Promise.all([
      API.rewards.wallet(state.student.id),
      API.rewards.taskLogs(state.student.id, day),
      API.rewards.listShop(),
      API.rewards.redeems(state.student.id)
    ]).then(function (settled) {
      rewards.wallet = settled[0] || { xp: 0, diamonds: 0 };
      rewards.taskLogs = settled[1] || [];
      rewards.shop = settled[2] || [];
      rewards.redeems = settled[3] || [];
      rewards.loaded = true;
      rewards.loading = false;
      if (state.tab === 'board') renderBoard();
    }).catch(function (error) {
      rewards.loading = false;
      fail(error);
    });
  }

  function rewardCard() {
    var rewards = state.rewards;
    var wrap = el('div');

    if (!rewards.loaded) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '每日任务与奖励' })]),
        el('div', { class: 'boot', text: '正在加载…' })
      ]));
      loadRewards();
      return wrap;
    }

    var wallet = rewards.wallet || { xp: 0, diamonds: 0 };
    var level = rewardLevel(wallet.xp);
    var claimed = claimedTaskCodes();
    var stats = todayPracticeStats();
    var pending = rewards.redeems.filter(function (row) { return row.status === 'pending'; });

    // -- wallet head --
    var head = el('div', { class: 'card reward-card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '每日任务与奖励' }),
        el('span', { class: 'card-meta reward-diamonds', text: '💎 ' + (wallet.diamonds || 0) })
      ]),
      el('div', { class: 'reward-level' }, [
        el('span', { class: 'reward-lv', text: 'LV.' + level.level }),
        el('span', { class: 'reward-lvname', text: level.name }),
        el('span', { class: 'reward-xp', text: level.progress + ' / ' + XP_PER_LEVEL + ' EXP' })
      ]),
      el('div', { class: 'bar' }, [el('i', { style: 'width:' + level.progress + '%' })]),
      el('p', { class: 'card-summary', text: '完成每日任务赚经验升级、攒钻石；钻石可以在下面的商店兑换心愿奖品，由爸爸妈妈兑现。' })
    ]);
    wrap.appendChild(head);

    // -- daily tasks --
    var taskCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '今日任务' }),
        el('span', { class: 'card-meta', text: claimed.size + ' / ' + REWARD_TASKS.length + ' 已领' })
      ])
    ]);
    REWARD_TASKS.forEach(function (task) {
      var isDone = task.done(stats, claimed);
      var isClaimed = claimed.has(task.code);
      var progressText = task.bonus
        ? (isDone ? '全部完成' : '完成 5 项后解锁')
        : task.progress(stats, claimed) + ' / ' + task.goal;
      var row = el('div', { class: 'task-row' + (isDone ? ' done' : '') + (isClaimed ? ' claimed' : '') }, [
        el('span', { class: 'task-emoji', text: task.emoji }),
        el('span', { class: 'task-body' }, [
          el('div', { class: 'task-name', text: task.name }),
          el('div', { class: 'task-sub', text: progressText + ' · +' + task.diamonds + '💎 +' + task.xp + 'EXP' })
        ]),
        isClaimed
          ? el('span', { class: 'tag mastered', text: '已领' })
          : el('button', {
            class: 'btn mini task-claim', type: 'button', text: '领取',
            disabled: isDone ? null : 'disabled',
            onclick: function () { claimTask(task); }
          })
      ]);
      taskCard.appendChild(row);
    });
    wrap.appendChild(taskCard);

    // -- shop --
    var shopCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '钻石商店' }),
        el('button', {
          class: 'btn ghost mini', type: 'button',
          text: rewards.manage ? '完成管理' : '管理奖品',
          onclick: function () {
            rewards.manage = !rewards.manage;
            renderBoard();
          }
        })
      ])
    ]);

    if (rewards.manage) {
      var nameInput = el('input', { class: 'field bank-input', placeholder: '奖品名称，如：看动画片 30 分钟' });
      var emojiInput = el('input', { class: 'field bank-input reward-emoji-input', placeholder: '🎁', maxlength: '4' });
      var costInput = el('input', { class: 'field bank-input', placeholder: '所需钻石，如：30', inputmode: 'numeric' });
      shopCard.appendChild(el('div', { class: 'reward-manage' }, [
        el('div', { class: 'reward-manage-row' }, [emojiInput]),
        el('div', { class: 'reward-manage-row grow' }, [nameInput]),
        el('div', { class: 'reward-manage-row' }, [costInput]),
        el('button', {
          class: 'btn mini', type: 'button', text: '添加',
          onclick: function () {
            var name = nameInput.value.trim();
            var cost = parseInt(costInput.value, 10);
            if (!name || !cost || cost <= 0) { toast('填好奖品名称和钻石数'); return; }
            API.rewards.addShopItem(name, emojiInput.value.trim() || '🎁', cost)
              .then(function (created) {
                if (created[0]) rewards.shop.push(created[0]);
                rewards.shop.sort(function (a, b) { return a.cost - b.cost; });
                toast('奖品已上架');
                renderBoard();
              })
              .catch(fail);
          }
        })
      ]));
    }

    if (!rewards.shop.length) {
      shopCard.appendChild(el('p', { class: 'card-summary', text: rewards.manage ? '在上面添加第一个奖品吧。' : '奖品列表还是空的，点「管理奖品」添加心愿。' }));
    }
    rewards.shop.forEach(function (item) {
      var afford = (wallet.diamonds || 0) >= item.cost;
      var row = el('div', { class: 'task-row shop-row' }, [
        el('span', { class: 'task-emoji', text: item.emoji || '🎁' }),
        el('span', { class: 'task-body' }, [
          el('div', { class: 'task-name', text: item.name }),
          el('div', { class: 'task-sub', text: '💎 ' + item.cost })
        ])
      ]);
      if (rewards.manage) {
        row.appendChild(el('button', {
          class: 'btn ghost mini', type: 'button', text: '下架',
          onclick: function () {
            API.rewards.removeShopItem(item.id)
              .then(function () {
                rewards.shop = rewards.shop.filter(function (x) { return x.id !== item.id; });
                toast('已下架');
                renderBoard();
              })
              .catch(fail);
          }
        }));
      } else {
        row.appendChild(el('button', {
          class: 'btn mini', type: 'button', text: '兑换',
          disabled: afford ? null : 'disabled',
          onclick: function () {
            API.rewards.redeem(state.student.id, item)
              .then(function (result) {
                rewards.wallet = result.wallet;
                rewards.redeems.unshift(result.redeem);
                toast('已兑换「' + item.name + '」，等爸妈兑现吧！');
                renderBoard();
              })
              .catch(function (error) { toast(API.describeError(error)); });
          }
        }));
      }
      shopCard.appendChild(row);
    });

    if (pending.length) {
      shopCard.appendChild(el('div', { class: 'group-title', text: '待兑现的心愿' }));
      pending.forEach(function (row) {
        var line = el('div', { class: 'task-row' }, [
          el('span', { class: 'task-emoji', text: '⏳' }),
          el('span', { class: 'task-body' }, [
            el('div', { class: 'task-name', text: row.item_name }),
            el('div', { class: 'task-sub', text: '花了 💎 ' + row.cost })
          ])
        ]);
        if (rewards.manage) {
          line.appendChild(el('button', {
            class: 'btn mini', type: 'button', text: '已兑现',
            onclick: function () {
              API.rewards.fulfillRedeem(row.id)
                .then(function () {
                  row.status = 'done';
                  renderBoard();
                })
                .catch(fail);
            }
          }));
        } else {
          line.appendChild(el('span', { class: 'tag', text: '等待兑现' }));
        }
        shopCard.appendChild(line);
      });
    }
    wrap.appendChild(shopCard);
    return wrap;
  }

  function claimTask(task) {
    var rewards = state.rewards;
    if (!state.student) return;
    API.rewards.claimTask(state.student.id, todayKey(), task.code, task.diamonds, task.xp)
      .then(function (result) {
        rewards.wallet = result.wallet;
        rewards.taskLogs.push(result.task);
        toast('+' + task.diamonds + ' 钻石 +' + task.xp + ' 经验！');
        renderBoard();
      })
      .catch(function (error) { toast(API.describeError(error)); });
  }

  // ---------------- bank drill (ChinaStudyFree question bank) ----------------

  var BANK_TYPE_NAMES = {
    true_false: '判断题',
    choice: '单选题',
    fill_blank: '填空题',
    fill_blank_text: '填空题',
    calculation: '计算题',
    matching: '配对题',
    word_order: '连词成句'
  };

  var BANK_SUBJECT_ORDER = ['数学', '语文', '英语', '科学', '道德与法治'];

  // Renders $...$ and \(...\) math with the bundled KaTeX. Quiet no-op when
  // the assets failed to load — plain text stays perfectly readable.
  function typesetMath(node) {
    if (!node || !window.renderMathInElement) return;
    try {
      window.renderMathInElement(node, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (e) { /* rendering must never break the quiz flow */ }
  }

  function bankGroup(meta) {
    var subjects = [];
    var bySubject = {};
    (meta || []).forEach(function (row) {
      if (!bySubject[row.subject]) {
        bySubject[row.subject] = { books: [], byBook: {} };
        subjects.push(row.subject);
      }
      var entry = bySubject[row.subject];
      if (!entry.byBook[row.textbook]) {
        entry.byBook[row.textbook] = [];
        entry.books.push(row.textbook);
      }
      if (row.unit && entry.byBook[row.textbook].indexOf(row.unit) < 0) {
        entry.byBook[row.textbook].push(row.unit);
      }
    });
    subjects.sort(function (a, b) {
      var ia = BANK_SUBJECT_ORDER.indexOf(a); var ib = BANK_SUBJECT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return { subjects: subjects, bySubject: bySubject };
  }

  function bankDefaultSel(groups) {
    var subject = groups.subjects.indexOf('数学') >= 0 ? '数学' : groups.subjects[0] || '';
    var books = subject ? groups.bySubject[subject].books : [];
    return {
      subject: subject,
      textbook: books[0] || '',
      unit: '',
      difficulty: 0,
      count: 10
    };
  }

  function renderBank() {
    var page = $('#main-page');
    clear(page);
    var bank = state.bank;

    if (bank.session) { renderBankQuiz(); return; }

    if (!bank.loaded) {
      if (!bank.loading) {
        bank.loading = true;
        API.bank.meta().then(function (meta) {
          bank.meta = meta || [];
          bank.loaded = true;
          bank.loading = false;
          if (state.tab === 'bank') renderBank();
        }).catch(function (error) {
          bank.loading = false;
          fail(error);
          clear(page);
          page.appendChild(el('p', { class: 'hint', text: '题库加载失败，点右上角「我的」刷新后再进一次。' }));
        });
      }
      page.appendChild(el('div', { class: 'boot', text: '正在加载题库…' }));
      return;
    }

    var groups = bankGroup(bank.meta);
    if (!groups.subjects.length) {
      page.appendChild(el('p', { class: 'hint', text: '题库还是空的，等下一次内容同步后就能刷题了。' }));
      return;
    }
    if (!bank.sel || groups.subjects.indexOf(bank.sel.subject) < 0) bank.sel = bankDefaultSel(groups);
    var sel = bank.sel;
    var books = (groups.bySubject[sel.subject] || { books: [] }).books;
    if (books.indexOf(sel.textbook) < 0) sel.textbook = books[0] || '';
    var units = sel.textbook ? (groups.bySubject[sel.subject].byBook[sel.textbook] || []) : [];

    page.appendChild(el('p', {
      class: 'card-summary',
      text: '从题库里随机抽一组题练手：选学科、教材和单元，答完当场出解析，错题自动进错题本。'
    }));

    var filterCard = el('div', { class: 'card' });
    var row1 = el('div', { class: 'filter-bar bank-filters' });
    var subjectSel = el('select', { class: 'field filter-select' });
    groups.subjects.forEach(function (name) {
      subjectSel.appendChild(el('option', { value: name, text: name }));
    });
    subjectSel.value = sel.subject;
    subjectSel.addEventListener('change', function () {
      sel.subject = subjectSel.value;
      sel.textbook = (groups.bySubject[sel.subject].books[0]) || '';
      sel.unit = '';
      renderBank();
    });
    row1.appendChild(subjectSel);

    var bookSel = el('select', { class: 'field filter-select' });
    bookSel.appendChild(el('option', { value: '', text: '全部教材' }));
    books.forEach(function (name) {
      bookSel.appendChild(el('option', { value: name, text: name.replace('义务教育教科书', '义教').replace('（三年级起点）', '') }));
    });
    bookSel.value = sel.textbook;
    bookSel.addEventListener('change', function () {
      sel.textbook = bookSel.value;
      sel.unit = '';
      renderBank();
    });
    row1.appendChild(bookSel);

    var unitSel = el('select', { class: 'field filter-select' });
    unitSel.appendChild(el('option', { value: '', text: '全部单元' }));
    units.forEach(function (name) {
      unitSel.appendChild(el('option', { value: name, text: name }));
    });
    unitSel.value = sel.unit;
    unitSel.addEventListener('change', function () { sel.unit = unitSel.value; });
    row1.appendChild(unitSel);

    var row2 = el('div', { class: 'filter-bar bank-filters' });
    var diffSel = el('select', { class: 'field filter-select' });
    [[0, '全部难度'], [1, '★ 基础'], [2, '★★ 普通'], [3, '★★★ 提高'], [4, '★★★★ 挑战']].forEach(function (pair) {
      diffSel.appendChild(el('option', { value: String(pair[0]), text: pair[1] }));
    });
    diffSel.value = String(sel.difficulty);
    diffSel.addEventListener('change', function () { sel.difficulty = Number(diffSel.value); });
    row2.appendChild(diffSel);

    var countSel = el('select', { class: 'field filter-select' });
    [5, 10, 15].forEach(function (n) {
      countSel.appendChild(el('option', { value: String(n), text: n + ' 题一组' }));
    });
    countSel.value = String(sel.count);
    countSel.addEventListener('change', function () { sel.count = Number(countSel.value); });
    row2.appendChild(countSel);

    filterCard.appendChild(row1);
    filterCard.appendChild(row2);
    page.appendChild(filterCard);

    page.appendChild(el('div', { class: 'actions' }, [
      el('button', {
        class: 'btn',
        type: 'button',
        text: '开始刷题',
        onclick: startBankSession
      })
    ]));
  }

  function bankShuffle(list) {
    var arr = list.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  async function startBankSession() {
    var bank = state.bank;
    if (bank.busy) return;
    var sel = bank.sel;
    bank.busy = true;
    var page = $('#main-page');
    try {
      var ids = await API.bank.ids(sel);
      if (!ids.length) { toast('这个范围暂时没有题，放宽一点条件试试'); return; }
      var picked = bankShuffle(ids.map(function (row) { return row.id; })).slice(0, sel.count);
      var found = await API.bank.byIds(picked);
      var byId = {};
      found.forEach(function (row) { byId[row.id] = row; });
      var qs = picked.map(function (id) { return byId[id]; }).filter(Boolean);
      if (!qs.length) { toast('题目加载失败，再试一次'); return; }
      bank.session = { qs: qs, i: 0, results: [], startedAt: Date.now() };
      renderBankQuiz();
    } catch (error) {
      fail(error);
    } finally {
      bank.busy = false;
    }
  }

  function bankTrueFalse(value) {
    var v = normalize(value);
    if (/^(对|正确|√|t|true|yes|y)$/.test(v)) return '对';
    if (/^(错|错误|不对|×|x|f|false|no|n)$/.test(v)) return '错';
    return v;
  }

  // The bank stores choice answers either as the option text or as a letter;
  // resolve both to the letter the option buttons use.
  function bankChoiceLetter(q) {
    var answer = String(q.answer || '').trim();
    var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    if (letters.indexOf(answer.toUpperCase()) >= 0 && answer.length === 1) return answer.toUpperCase();
    for (var i = 0; i < (q.options || []).length; i++) {
      if (normalize(q.options[i]) === normalize(answer)) return letters[i];
    }
    return null;
  }

  function bankFillMatch(q, given) {
    var variants = String(q.answer || '').split(/[\/;；、|]/).map(function (s) { return normalize(s); }).filter(Boolean);
    var g = normalize(given);
    if (!g) return false;
    return variants.indexOf(g) >= 0;
  }

  function bankOrderKey(text) {
    return normalize(String(text).replace(/[,，\s]+/g, ''));
  }

  function renderBankQuiz() {
    var page = $('#main-page');
    clear(page);
    var s = state.bank.session;
    var q = s.qs[s.i];
    if (!q) { finishBank(); return; }

    page.appendChild(el('div', { class: 'section-title' }, [
      '第 ' + (s.i + 1) + ' / ' + s.qs.length + ' 题',
      el('span', { class: 'count', text: BANK_TYPE_NAMES[q.qtype] || '练习题' })
    ]));

    page.appendChild(el('div', { class: 'card bank-stem' }, [
      el('div', { class: 'bank-meta', text: q.subject + ' · ' + (q.unit || '') + ' · ' + (q.knowledge_point || '') }),
      el('div', { class: 'bank-diff', text: '★★★★★'.slice(0, Math.max(1, q.difficulty || 2)) }),
      el('div', { class: 'question', text: q.stem })
    ]));

    var wrap = el('div');
    page.appendChild(wrap);
    renderBankAnswer(q, wrap);
    typesetMath(page);
  }

  function bankVerdict(q, wrap, userAnswer, isCorrect) {
    var s = state.bank.session;
    s.results.push({ q: q, answer: userAnswer, correct: isCorrect });

    var last = s.i === s.qs.length - 1;
    var box = el('div', { class: 'answer-box' }, [
      el('div', { class: 'verdict ' + (isCorrect ? 'ok' : 'no'), text: isCorrect ? '答对了' : '答错了' }),
      el('div', { class: 'line', text: '正确答案：' + q.answer }),
      q.analysis ? el('div', { class: 'line', text: '解析：' + q.analysis }) : null,
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: last ? '查看结果' : '下一题',
          onclick: function () {
            if (last) finishBank();
            else { s.i += 1; renderBankQuiz(); }
          }
        })
      ])
    ]);
    wrap.appendChild(box);
    typesetMath(wrap);
    window.scrollTo(0, document.body.scrollHeight);

    // Log the attempt and let a miss fall into the wrong book. Bank rows do
    // not map onto knowledge-graph codes, so mastery stays untouched.
    API.study.record({
      studentId: state.student.id,
      knowledgeCode: 'BANK:' + (q.knowledge_point || q.unit || q.qtype),
      subject: q.subject,
      textbookCode: q.textbook,
      qtype: q.qtype,
      stem: q.stem,
      userAnswer: userAnswer,
      correctAnswer: q.answer,
      isCorrect: isCorrect,
      skipMastery: true,
      source: 'bank'
    }).then(function () {
      pushLocalPracticeLog({
        knowledgeCode: 'BANK:' + (q.knowledge_point || q.unit || q.qtype),
        subject: q.subject,
        textbookCode: q.textbook,
        qtype: q.qtype,
        stem: q.stem,
        userAnswer: userAnswer,
        correctAnswer: q.answer,
        isCorrect: isCorrect,
        source: 'bank'
      });
    }).catch(function (error) { fail(error); });
  }

  function bankLock(wrap) {
    wrap.querySelectorAll('button, input, select').forEach(function (node) { node.disabled = true; });
  }

  // Self-judged question types: show the reference answer first, then let the
  // child be honest about whether they had it right.
  function bankSelfJudge(q, wrap, introText) {
    bankLock(wrap);
    var box = el('div', { class: 'answer-box' }, [
      el('div', { class: 'line', text: introText || '先自己算一算、配一配，再看答案。' }),
      el('div', { class: 'line', text: '参考答案：' + q.answer }),
      q.analysis ? el('div', { class: 'line', text: '解析：' + q.analysis }) : null,
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn ghost', type: 'button', text: '我答对了',
          onclick: function () {
            clear(box);
            bankVerdict(q, wrap, q.answer, true);
          }
        }),
        el('button', {
          class: 'btn ghost', type: 'button', text: '我答错了',
          onclick: function () {
            clear(box);
            bankVerdict(q, wrap, q.answer, false);
          }
        })
      ])
    ]);
    wrap.appendChild(box);
    typesetMath(wrap);
    window.scrollTo(0, document.body.scrollHeight);
  }

  function renderBankAnswer(q, wrap) {
    var letters = ['A', 'B', 'C', 'D', 'E', 'F'];

    if (q.qtype === 'choice') {
      var answerLetter = bankChoiceLetter(q);
      (q.options || []).forEach(function (option, i) {
        var letter = letters[i];
        wrap.appendChild(el('button', {
          class: 'option', type: 'button',
          onclick: function () {
            bankLock(wrap);
            wrap.querySelectorAll('.option').forEach(function (node, k) {
              var nodeLetter = letters[k];
              if (answerLetter && nodeLetter === answerLetter) node.classList.add('right');
              else if (nodeLetter === letter) node.classList.add('wrong');
            });
            bankVerdict(q, wrap, letter + '. ' + option, answerLetter === letter);
          }
        }, [
          el('span', { class: 'key', text: letter }),
          el('span', { text: String(option) })
        ]));
      });
      return;
    }

    if (q.qtype === 'true_false') {
      var expected = bankTrueFalse(q.answer);
      ['对', '错'].forEach(function (choice) {
        wrap.appendChild(el('button', {
          class: 'option bank-tf', type: 'button',
          onclick: function () {
            bankLock(wrap);
            wrap.querySelectorAll('.option').forEach(function (node) {
              if (node.textContent.trim() === expected) node.classList.add('right');
              else if (node.textContent.trim() === choice) node.classList.add('wrong');
            });
            bankVerdict(q, wrap, choice, expected === choice);
          }
        }, [
          el('span', { class: 'key', text: choice === '对' ? '√' : '×' }),
          el('span', { text: choice })
        ]));
      });
      return;
    }

    if (q.qtype === 'fill_blank' || q.qtype === 'fill_blank_text') {
      var input = el('input', {
        class: 'field bank-input',
        placeholder: '在这里填写答案',
        autocomplete: 'off'
      });
      wrap.appendChild(el('div', { class: 'card' }, [input]));
      wrap.appendChild(el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '提交答案',
          onclick: function () {
            var given = input.value.trim();
            if (!given) { toast('先写一下你的答案'); return; }
            if (bankFillMatch(q, given)) {
              bankLock(wrap);
              bankVerdict(q, wrap, given, true);
            } else {
              bankSelfJudge(q, wrap, '你的答案：' + given + ' · 和参考答案比对一下，拼写或写法一致就算对。');
            }
          }
        })
      ]));
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          wrap.querySelector('.actions .btn').click();
        }
      });
      return;
    }

    if (q.qtype === 'word_order') {
      var pool = bankShuffle((q.options || []).map(String));
      var picked = [];
      var poolRow = el('div', { class: 'bank-chip-row' });
      var pickRow = el('div', { class: 'bank-chip-row bank-picked' });
      var hint = el('p', { class: 'hint', text: '按顺序点下面的词，组成完整的句子。点错了再点一下可以放回去。' });

      function refresh() {
        clear(poolRow); clear(pickRow);
        pool.forEach(function (word, idx) {
          var chip = el('button', { class: 'qchip', type: 'button', text: word });
          chip.addEventListener('click', function () {
            pool.splice(idx, 1);
            picked.push(word);
            refresh();
          });
          poolRow.appendChild(chip);
        });
        picked.forEach(function (word, idx) {
          var chip = el('button', { class: 'qchip on', type: 'button', text: word });
          chip.addEventListener('click', function () {
            picked.splice(idx, 1);
            pool.push(word);
            refresh();
          });
          pickRow.appendChild(chip);
        });
      }
      refresh();

      wrap.appendChild(hint);
      wrap.appendChild(el('div', { class: 'card' }, [pickRow, poolRow]));
      wrap.appendChild(el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '提交句子',
          onclick: function () {
            if (!picked.length) { toast('先点词组成句子'); return; }
            var given = picked.join(' ');
            if (bankOrderKey(given) === bankOrderKey(q.answer)) {
              bankLock(wrap);
              bankVerdict(q, wrap, given, true);
            } else {
              bankSelfJudge(q, wrap, '你排的：' + given + ' · 和参考答案比对一下，意思一样就算对。');
            }
          }
        })
      ]));
      return;
    }

    // calculation / matching / anything unusual: self-judge with the answer shown.
    bankSelfJudge(q, wrap, q.qtype === 'calculation' ? '先在草稿纸上算一算，再看答案。' : '自己配一配、想一想，再看答案。');
  }

  function finishBank() {
    var s = state.bank.session;
    var page = $('#main-page');
    clear(page);
    var total = s.results.length;
    var correct = s.results.filter(function (r) { return r.correct; }).length;
    var wrong = s.results.filter(function (r) { return !r.correct; });

    page.appendChild(el('div', { class: 'section-title' }, ['本组成绩']));
    page.appendChild(el('div', { class: 'card bank-result' }, [
      el('div', { class: 'verdict ' + (correct === total ? 'ok' : correct >= Math.ceil(total * 0.7) ? 'ok' : 'no'), text: '答对 ' + correct + ' / ' + total + ' 题' }),
      el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.round((correct / Math.max(1, total)) * 100) + '%' })]),
      el('p', { class: 'hint', text: wrong.length ? '错的题已经自动收进错题本，可以在「错题本」里重练。' : '全对！可以换一个单元继续挑战。' })
    ]));

    if (wrong.length) {
      page.appendChild(el('div', { class: 'section-title' }, ['本组错题']));
      wrong.forEach(function (r) {
        page.appendChild(el('div', { class: 'card bank-wrong-item' }, [
          el('div', { class: 'question', text: r.q.stem }),
          el('div', { class: 'line', text: '正确答案：' + r.q.answer })
        ]));
      });
      typesetMath(page);
    }

    page.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'btn', type: 'button', text: '再来一组', onclick: function () { state.bank.session = null; startBankSession(); } }),
      el('button', { class: 'btn ghost', type: 'button', text: '重新选择范围', onclick: function () { state.bank.session = null; renderBank(); } })
    ]));
  }

  // ---------------- learning flow ----------------

  function enterLearn(knowledge) {
    state.learn = {
      mode: 'study',
      knowledge: knowledge,
      step: 'lesson',
      lesson: '',
      lessonDone: false,
      questions: [],
      index: 0,
      answers: [],
      busy: false
    };
    $('#learn-title').textContent = knowledge.name;
    $('#learn-sub').textContent = knowledge.subject + ' · ' + knowledge.chapter;
    showScreen('learn');
    renderLearn();
    loadLesson();
  }

  function stepsBar(current) {
    var order = ['lesson', 'practice', 'result'];
    var names = { lesson: '定向学习', practice: '针对练习', result: '掌握更新' };
    var index = order.indexOf(current);
    return el('div', { class: 'steps' }, order.map(function (key, i) {
      var cls = i === index ? 'step on' : i < index ? 'step done' : 'step';
      return el('span', { class: cls, text: names[key] });
    }));
  }

  // Every subject answers in its own format — a GESP programming problem is not
  // a reading-comprehension answer. The lesson and the generated questions both
  // read from here, so the explanation always covers the exact format the
  // practice questions use.
  function subjectAnswerSpec(subject) {
    if (subject === '信息学') {
      return {
        brief: '本学科是竞赛式编程题：题面给出输入格式、输出格式与数据范围，作答用 C++ 代码，标准输入输出，不用文件读写。',
        howto: '先读输入格式、输出格式和数据范围，再写算法思路与时间复杂度，最后给出完整可运行的 C++ 代码框架（读入 → 处理 → 输出）。',
        types: '出 3 道题：其中至少 1 道是程序阅读题——在 code 字段放一段 8 到 15 行的 C++ 代码，问它的输出结果，用单选题作答；其余为单选题或填空题。'
      };
    }
    if (subject === '语文') {
      return {
        brief: '本学科以阅读理解和语言表达为主，答案要求分点、扣原文、用术语。',
        howto: '讲清这类题的作答结构，例如概括题写「谁 + 做了什么 + 结果」，赏析题写「手法 + 内容 + 效果或情感」，并给一个标准答案示范。',
        types: '出 3 道题：以单选题为主，可以有 1 道用填空题形式呈现的简答题，答案不超过 20 字。'
      };
    }
    if (subject === '数学') {
      return {
        brief: '本学科要求写出解题过程，格式是：设、列、算、答，注意单位与答句。',
        howto: '展示规范步骤与一步完整的书写示范，并说明怎样检验答案。',
        types: '出 3 道题：以计算题或应用题为主，可以有 1 道填空题。'
      };
    }
    if (subject === '英语') {
      return {
        brief: '本学科以单项选择、完形与写作为主，注意时态一致、固定搭配与单复数。',
        howto: '说明先判断考点、再排除错误选项、最后说明理由的作答顺序，并点出这一类题的常见陷阱。',
        types: '出 3 道题：以单选题为主，可以有 1 道填空题。'
      };
    }
    if (subject === '奥数') {
      return {
        brief: '本学科是竞赛数学，答题要先写思路再写算式，最后检验。',
        howto: '给出画图或列表的分析思路、算式的书写格式与检验方法。',
        types: '出 3 道题：以单选题为主，可以有 1 道填空题。'
      };
    }
    return {
      brief: '',
      howto: '说明这类题的作答步骤和规范格式。',
      types: '出 3 道题：以单选题为主，可以有 1 道填空题。'
    };
  }

  // ---------------- interactive math demos ----------------
  // 讲解页下方的互动动画：按知识点从内置演示库里挑一个。
  // 动画是本地代码画的，不依赖 LLM，保证每次都能稳定运行。

  // 逐个核对过的映射表：知识点代码 → 演示。宁可不给演示，也不给主题不符的。
  var DEMO_MAP = {
    // 奥数
    'A6-04': { type: 'telescope' },                                    // 裂项相消
    'A6-08': { type: 'ratio' },                                        // 按比分配
    'A6-16': { type: 'percent', variant: 'concentration' },            // 浓度问题
    'A6-18': { type: 'circleArea' },                                   // 圆的周长与面积综合
    // 数学上册
    'M6A-01-01': { type: 'fraction' },                                 // 分数乘整数
    'M6A-01-02': { type: 'fraction' },                                 // 分数乘分数
    'M6A-01-06': { type: 'fraction' },                                 // 求一个数的几分之几
    'M6A-01-07': { type: 'fraction' },                                 // 连续求几分之几
    'M6A-04-05': { type: 'ratio' },                                    // 按比分配
    'M6A-05-01': { type: 'circleParts' },                              // 圆的认识
    'M6A-05-02': { type: 'circleParts' },                              // 圆的对称性与画圆
    'M6A-05-03': { type: 'circleCircum' },                             // 圆的周长与圆周率
    'M6A-05-04': { type: 'circleCircum' },                             // 圆周长的应用
    'M6A-05-05': { type: 'circleArea' },                               // 圆的面积
    'M6A-05-06': { type: 'ring' },                                     // 圆环的面积
    'M6A-05-07': { type: 'sector' },                                   // 扇形的认识与面积
    'M6A-06-01': { type: 'percent' },                                  // 百分数的意义
    'M6A-06-02': { type: 'percent' },                                  // 百分数与分数互化
    'M6A-06-03': { type: 'percent' },                                  // 百分数与小数互化
    'M6A-06-04': { type: 'percent' },                                  // 求百分率
    'M6A-06-05': { type: 'percent' },                                  // 求多百分之几
    'M6A-06-06': { type: 'percent' },                                  // 已知多百分之几求原数
    'M6A-07-01': { type: 'pie' },                                      // 扇形统计图
    // 数学下册
    'M6B-01-01': { type: 'numberline' },                               // 负数的意义
    'M6B-01-02': { type: 'numberline' },                               // 数轴上的正负数
    'M6B-02-01': { type: 'percent', variant: 'discount' },             // 折扣
    'M6B-02-02': { type: 'percent', variant: 'chengshu' },             // 成数
    'M6B-02-03': { type: 'percent' },                                  // 税率
    'M6B-02-04': { type: 'percent' },                                  // 利率
    'M6B-03-01': { type: 'cylinder' },                                 // 圆柱的认识
    'M6B-03-02': { type: 'cylinder' },                                 // 圆柱的侧面积
    'M6B-03-03': { type: 'cylinder' },                                 // 圆柱的表面积
    'M6B-03-05': { type: 'cone' },                                     // 圆锥的认识
    'M6B-03-06': { type: 'cone' }                                      // 圆锥的体积
  };

  function pickMathDemo(knowledge) {
    if (knowledge.subject !== '数学' && knowledge.subject !== '奥数') return null;
    if (DEMO_MAP[knowledge.code]) return DEMO_MAP[knowledge.code];
    // 兜底关键词只留把握大的，避免新知识点配错主题
    var t = [knowledge.name, knowledge.unit_name, knowledge.chapter].join(' ');
    if (/浓度/.test(t)) return { type: 'percent', variant: 'concentration' };
    if (/圆的面积/.test(t)) return { type: 'circleArea' };
    if (/分数/.test(t) && /乘/.test(t)) return { type: 'fraction' };
    if (/百分/.test(t)) return { type: 'percent' };
    return null;
  }

  function tween(duration, step, done) {
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      step(ease);
      if (t < 1) requestAnimationFrame(frame);
      else if (done) done();
    }
    requestAnimationFrame(frame);
  }

  function svgNode(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  // 圆的面积：16 等份扇形，点击后拼成近似平行四边形 → S = πr × r = πr²。
  function demoCircleArea() {
    var NS = 'http://www.w3.org/2000/svg';
    var SECTORS = 16, R = 70, CX = 100, CY = 105;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 480 210');
    svg.setAttribute('class', 'demo-svg');
    var group = document.createElementNS(NS, 'g');
    svg.appendChild(group);

    var colors = ['#5b8def', '#f2b544'];
    var targets = [];
    var X0 = 235;
    var W = (Math.PI * R) / 8; // 每行 8 份，底 = πr
    for (var k = 0; k < SECTORS; k += 1) {
      var a1 = (k / SECTORS) * Math.PI * 2;
      var a2 = ((k + 1) / SECTORS) * Math.PI * 2;
      var x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
      var x2 = CX + R * Math.cos(a2), y2 = CY + R * Math.sin(a2);
      var path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        'M' + CX + ' ' + CY +
        ' L' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
        ' A' + R + ' ' + R + ' 0 0 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' Z'
      );
      path.setAttribute('fill', colors[k % 2]);
      path.setAttribute('stroke', '#fff');
      path.setAttribute('stroke-width', '1');
      group.appendChild(path);

      var row = k < 8 ? 0 : 1;
      var i = k % 8;
      // 目标：扇形尖朝下（上排）或朝上（下排，横向错开半格），交错拼出平行四边形
      var apexX = X0 + i * W + W / 2 + (row ? W / 2 : 0);
      var apexY = row ? 100 : 170;
      var outAngle = ((k + 0.5) / SECTORS) * 360; // 当前底边相对尖的朝向
      var wantAngle = row ? 90 : -90;
      var rot = wantAngle - outAngle;
      targets.push({
        dx: apexX - CX,
        dy: apexY - CY,
        rot: rot
      });
    }

    var assembled = false;
    var animating = false;
    var caption = el('div', {
      class: 'demo-caption',
      text: '把圆平均分成 16 份。点一点图或下面的按钮，看看这些小扇形能拼成什么形状？'
    });

    function apply(t) {
      for (var j = 0; j < SECTORS; j += 1) {
        var tg = targets[j];
        var dx = t * tg.dx, dy = t * tg.dy, rot = t * tg.rot;
        group.childNodes[j].setAttribute(
          'transform',
          'translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) + ') rotate(' + rot.toFixed(2) + ' ' + CX + ' ' + CY + ')'
        );
      }
    }

    function toggle() {
      if (animating) return;
      animating = true;
      var from = assembled ? 1 : 0;
      var to = assembled ? 0 : 1;
      tween(900, function (e) { apply(from + (to - from) * e); }, function () {
        assembled = !assembled;
        animating = false;
        btn.textContent = assembled ? '还原成圆' : '拼成平行四边形';
        caption.textContent = assembled
          ? '拼成了近似的平行四边形：底 ≈ 圆周长的一半（πr），高 ≈ r。所以 S = πr × r = πr²'
          : '把圆平均分成 16 份。点一点图或下面的按钮，看看这些小扇形能拼成什么形状？';
      });
    }

    var btn = el('button', {
      class: 'demo-btn primary',
      type: 'button',
      text: '拼成平行四边形',
      onclick: toggle
    });

    // 图像本身也可以点：孩子会直接去戳扇形图，而不是找下面的按钮
    svg.style.cursor = 'pointer';
    svg.addEventListener('click', toggle);

    return el('div', { class: 'demo-body' }, [
      svg,
      el('div', { class: 'demo-actions' }, [btn]),
      caption
    ]);
  }

  // 分数乘分数：竖着涂 a/b（蓝），横着涂 c/d（黄），重叠就是乘积。
  function demoFractionMultiply() {
    var SETS = [[1, 2, 1, 3], [2, 3, 1, 2], [3, 4, 2, 3]];
    var setIdx = 0;

    var num = el('div', { class: 'demo-num' });
    var caption = el('div', { class: 'demo-caption' });
    var grid = el('div', { class: 'frac-grid' });

    function build() {
      var s = SETS[setIdx];
      var a = s[0], b = s[1], c = s[2], d = s[3];
      clear(grid);
      grid.style.gridTemplateColumns = 'repeat(' + b + ', 1fr)';
      grid.style.gridTemplateRows = 'repeat(' + d + ', 1fr)';
      for (var r = 0; r < d; r += 1) {
        for (var col = 0; col < b; col += 1) {
          var cell = el('div', { class: 'fcell' });
          cell.style.transitionDelay = ((r + col) * 70) + 'ms';
          grid.appendChild(cell);
        }
      }
      num.textContent = a + '/' + b + ' × ' + c + '/' + d + ' = ?';
      caption.textContent = '竖着涂 ' + a + '/' + b + '（蓝色列），横着涂 ' + c + '/' + d + '（黄色行）—— 重叠的格子就是答案';
      // 触发动画：先回到未涂色，下一帧再点亮
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var cells = grid.childNodes;
          for (var j = 0; j < cells.length; j += 1) {
            var rr = Math.floor(j / b), cc = j % b;
            if (cc < a) cells[j].classList.add(rr < c ? 'both' : 'col');
            else if (rr < c) cells[j].classList.add('row');
          }
        });
      });
    }

    build();
    // 点格子图重新演示一遍涂色过程
    grid.style.cursor = 'pointer';
    grid.addEventListener('click', build);
    return el('div', { class: 'demo-body' }, [
      num,
      grid,
      caption,
      el('div', { class: 'demo-actions' }, [
        el('button', {
          class: 'demo-btn primary',
          type: 'button',
          text: '换一组分数',
          onclick: function () {
            setIdx = (setIdx + 1) % SETS.length;
            build();
          }
        }),
        el('button', {
          class: 'demo-btn',
          type: 'button',
          text: '重新演示',
          onclick: build
        })
      ])
    ]);
  }

  // 百分数 / 浓度：拖动滑杆，条形和数字实时联动。
  function demoPercent(variant) {
    var mode = variant || 'percent';
    var slider = el('input', { class: 'demo-slider', type: 'range', min: '0', max: '100', value: '30' });
    var fill = el('div', { class: 'pct-fill', style: 'width:30%' });
    var num = el('div', { class: 'demo-num' });
    var text = {
      concentration: '浓度 = 糖 ÷ 糖水。拖一拖滑杆，看看糖变多时浓度怎么变？',
      discount: '折扣就是原价的百分之几十：打 7 折 = 按原价的 70% 卖。拖一拖，看看折后价。',
      chengshu: '成数表示十分之几：三成 = 30%，八成五 = 85%。拖一拖，看看是多少。',
      percent: '百分数表示"占整体的百分之几"。拖一拖滑杆，看看具体是多少。'
    };
    var caption = el('div', { class: 'demo-caption', text: text[mode] || text.percent });

    function update() {
      var v = Number(slider.value);
      fill.style.width = v + '%';
      if (mode === 'concentration') {
        num.textContent = '糖 ' + Math.round(v / 4) + ' 份 ÷ 糖水 100 份 → 浓度 ' + v + '%';
      } else if (mode === 'discount') {
        var zhe = (v / 10).toFixed(1);
        num.textContent = '打 ' + zhe + ' 折 = 原价 × ' + (v / 100).toFixed(2) + '，100 元的东西卖 ' + v.toFixed(1) + ' 元';
      } else if (mode === 'chengshu') {
        num.textContent = v + '% = ' + (v / 10).toFixed(1) + ' 成，100 元的商品卖 ' + v.toFixed(1) + ' 元';
      } else {
        num.textContent = v + '% = ' + v + '/100 = ' + (v / 100).toFixed(2);
      }
    }
    slider.addEventListener('input', update);
    update();

    // 点条形图任意位置也能直接设定数值（不只是拖滑杆）
    var bar = el('div', { class: 'pct-bar', style: 'cursor:pointer' }, [fill]);
    bar.addEventListener('click', function (event) {
      var rect = bar.getBoundingClientRect();
      var ratio = (event.clientX - rect.left) / rect.width;
      slider.value = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      update();
    });

    return el('div', { class: 'demo-body' }, [
      num,
      bar,
      slider,
      caption
    ]);
  }

  // 圆的认识：点一点，圆心、半径、直径、对称轴依次亮出来。
  function demoCircleParts() {
    var svg = svgNode('svg', { viewBox: '0 0 220 220', class: 'demo-svg' });
    var CX = 110, CY = 110, R = 78;
    svg.appendChild(svgNode('circle', { cx: CX, cy: CY, r: R, fill: '#eef3fb', stroke: '#bcd0f7', 'stroke-width': 2 }));
    var radiusLine = svgNode('line', { x1: CX, y1: CY, x2: CX + R, y2: CY, stroke: '#5b8def', 'stroke-width': 2.5 });
    var diameterLine = svgNode('line', { x1: CX - R, y1: CY, x2: CX + R, y2: CY, stroke: '#5b8def', 'stroke-width': 2.5, opacity: 0 });
    var centerDot = svgNode('circle', { cx: CX, cy: CY, r: 4.5, fill: '#ef6c5a' });
    var symmetry = svgNode('line', { x1: CX, y1: CY - R, x2: CX, y2: CY + R, stroke: '#f2b544', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0 });
    var symmetry2 = svgNode('line', { x1: CX - R, y1: CY, x2: CX + R, y2: CY, stroke: '#f2b544', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0 });
    svg.appendChild(diameterLine);
    svg.appendChild(symmetry);
    svg.appendChild(symmetry2);
    svg.appendChild(radiusLine);
    svg.appendChild(centerDot);
    var labelR = svgNode('text', { x: CX + 40, y: CY - 8, fill: '#5b8def', 'font-size': 13 });
    labelR.textContent = '半径 r';
    var labelD = svgNode('text', { x: CX - 30, y: CY + 20, fill: '#5b8def', 'font-size': 13, opacity: 0 });
    labelD.textContent = '直径 d = 2r';
    svg.appendChild(labelR);
    svg.appendChild(labelD);

    var stage = 0;
    var caption = el('div', { class: 'demo-caption' });
    var stages = [
      '圆心（红点）决定圆的位置；从圆心到圆上任意一点的距离叫半径 r。',
      '直径 d 穿过圆心、两端都在圆上，d = 2r；一个圆有无数条半径和直径。',
      '圆是轴对称图形，有无数条对称轴，每条直径所在直线都是它的对称轴。'
    ];
    function renderStage() {
      radiusLine.setAttribute('opacity', '1');
      centerDot.setAttribute('opacity', '1');
      labelR.setAttribute('opacity', '1');
      diameterLine.setAttribute('opacity', stage >= 1 ? '1' : '0');
      labelD.setAttribute('opacity', stage >= 1 ? '1' : '0');
      symmetry.setAttribute('opacity', stage >= 2 ? '1' : '0');
      symmetry2.setAttribute('opacity', stage >= 2 ? '1' : '0');
      caption.textContent = stages[stage];
    }
    renderStage();
    svg.style.cursor = 'pointer';
    svg.addEventListener('click', function () {
      stage = (stage + 1) % stages.length;
      renderStage();
    });
    return el('div', { class: 'demo-body' }, [
      svg,
      el('div', { class: 'demo-caption', text: '点一点圆，依次认识圆心、半径、直径、对称轴。' }),
      caption
    ]);
  }

  // 圆的周长：滚动圆，看它滚一圈正好是一段"直径 × 3.14"的长度。
  function demoCircleCircumference() {
    var svg = svgNode('svg', { viewBox: '0 0 360 180', class: 'demo-svg' });
    var R = 46, CX = 70, CY = 110;
    // 地面与滚动轨迹
    svg.appendChild(svgNode('line', { x1: 20, y1: CY, x2: 340, y2: CY, stroke: '#c9d3e4', 'stroke-width': 2 }));
    var track = svgNode('line', { x1: CX, y1: CY, x2: CX, y2: CY, stroke: '#5b8def', 'stroke-width': 3, opacity: 0 });
    svg.appendChild(track);
    var circle = svgNode('circle', { cx: CX, cy: CY - R, r: R, fill: '#eef3fb', stroke: '#5b8def', 'stroke-width': 2.5 });
    svg.appendChild(circle);
    var spoke = svgNode('line', { x1: CX, y1: CY - R, x2: CX, y2: CY - 2 * R, stroke: '#f2b544', 'stroke-width': 2 });
    svg.appendChild(spoke);
    var circumference = (2 * Math.PI * R).toFixed(1);
    var label = svgNode('text', { x: 120, y: 40, fill: '#5b8def', 'font-size': 14 });
    label.textContent = '直径 d';
    var dLine = svgNode('line', { x1: CX - R, y1: CY - 2 * R - 20, x2: CX + R, y2: CY - 2 * R - 20, stroke: '#5b8def', 'stroke-width': 1.4 });
    svg.appendChild(dLine);
    svg.appendChild(label);

    var rolled = false, animating = false;
    var caption = el('div', {
      class: 'demo-caption',
      text: '圆滚动一圈的距离就是它的周长。点一点，让它滚起来看看。'
    });
    function roll() {
      if (animating) return;
      animating = true;
      var from = rolled ? 0 : 0, to = rolled ? 0 : 2 * Math.PI * R / 1;
      var startX = CX, startA = 0;
      tween(1100, function (e) {
        var dist = (2 * Math.PI * R) * e;
        var ang = (dist / R) * 180 / Math.PI;
        circle.setAttribute('cx', (startX + dist).toFixed(2));
        spoke.setAttribute('transform', 'rotate(' + ang.toFixed(2) + ' ' + (startX + dist).toFixed(2) + ' ' + (CY - R) + ')');
        spoke.setAttribute('x1', (startX + dist).toFixed(2));
        spoke.setAttribute('x2', (startX + dist).toFixed(2));
        track.setAttribute('x2', (startX + dist).toFixed(2));
        track.setAttribute('opacity', '1');
      }, function () {
        animating = false; rolled = true;
        caption.textContent = '滚过的距离 = 圆的周长 ≈ 3.14 × 直径。所以 C = πd = 2πr（这里约 ' + circumference + '）。';
      });
    }
    function reset() {
      rolled = false; animating = false;
      circle.setAttribute('cx', CX);
      spoke.setAttribute('x1', CX); spoke.setAttribute('x2', CX);
      spoke.removeAttribute('transform');
      track.setAttribute('opacity', '0');
      caption.textContent = '圆滚动一圈的距离就是它的周长。点一点，让它滚起来看看。';
    }
    svg.style.cursor = 'pointer';
    svg.addEventListener('click', function () { if (rolled) reset(); else roll(); });
    return el('div', { class: 'demo-body' }, [
      svg,
      el('div', { class: 'demo-actions' }, [
        el('button', { class: 'demo-btn primary', type: 'button', text: '让它滚一圈', onclick: function () { if (rolled) reset(); else roll(); } }),
        el('button', { class: 'demo-btn', type: 'button', text: '重新来', onclick: reset })
      ]),
      caption
    ]);
  }

  // 圆环的面积：拉一拉内圆，看环宽和面积怎么变（S = π(R²−r²)）。
  function demoRing() {
    var svg = svgNode('svg', { viewBox: '0 0 220 220', class: 'demo-svg' });
    var CX = 110, CY = 110, R = 88;
    svg.appendChild(svgNode('circle', { cx: CX, cy: CY, r: R, fill: '#bcd0f7', stroke: '#5b8def', 'stroke-width': 1 }));
    var inner = svgNode('circle', { cx: CX, cy: CY, r: 44, fill: '#fff', stroke: '#5b8def', 'stroke-width': 1.5 });
    svg.appendChild(inner);
    var num = el('div', { class: 'demo-num' });
    var slider = el('input', { class: 'demo-slider', type: 'range', min: '10', max: '80', value: '44' });
    function update() {
      var r = Number(slider.value);
      inner.setAttribute('r', r);
      num.textContent = '外圆半径 R=88，内圆半径 r=' + r + ' → 环宽 ' + (88 - r) + '，面积 = 3.14×(88²−' + r + '²) ≈ ' + (3.14 * (88 * 88 - r * r)).toFixed(0);
    }
    slider.addEventListener('input', update);
    update();
    svg.addEventListener('click', function () { slider.value = String(10 + Math.round(Math.random() * 70)); update(); });
    svg.style.cursor = 'pointer';
    return el('div', { class: 'demo-body' }, [
      num, svg, slider,
      el('div', { class: 'demo-caption', text: '圆环面积 = 大圆面积 − 小圆面积 = π(R²−r²)。拖滑杆或点圆调整内圆。' })
    ]);
  }

  // 扇形：拉动滑杆改变圆心角，扇形和它的面积一起变。
  function demoSector() {
    var svg = svgNode('svg', { viewBox: '0 0 220 220', class: 'demo-svg' });
    var CX = 110, CY = 110, R = 88;
    function arcPath(deg) {
      var rad = deg * Math.PI / 180;
      var x = CX + R * Math.sin(rad), y = CY - R * Math.cos(rad);
      var large = deg > 180 ? 1 : 0;
      return 'M' + CX + ' ' + CY + ' L' + CX + ' ' + (CY - R) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Z';
    }
    var wedge = svgNode('path', { d: arcPath(90), fill: '#bcd0f7', stroke: '#5b8def', 'stroke-width': 1.5 });
    svg.appendChild(wedge);
    svg.appendChild(svgNode('circle', { cx: CX, cy: CY, r: 3.5, fill: '#ef6c5a' }));
    var num = el('div', { class: 'demo-num' });
    var slider = el('input', { class: 'demo-slider', type: 'range', min: '10', max: '360', value: '90' });
    function update() {
      var deg = Number(slider.value);
      wedge.setAttribute('d', arcPath(deg));
      num.textContent = '圆心角 ' + deg + '° → 占整圆的 ' + deg + '/360 = ' + (deg / 360).toFixed(2) + '，面积 = 3.14×88²×' + (deg / 360).toFixed(2) + ' ≈ ' + (3.14 * 88 * 88 * deg / 360).toFixed(0);
    }
    slider.addEventListener('input', update);
    update();
    return el('div', { class: 'demo-body' }, [
      num, svg, slider,
      el('div', { class: 'demo-caption', text: '扇形面积 = 圆面积 × (圆心角 ÷ 360)。拖滑杆改变圆心角看看。' })
    ]);
  }

  // 扇形统计图：把比例切成扇形，看各部分的占比。
  function demoPie() {
    var svg = svgNode('svg', { viewBox: '0 0 240 200', class: 'demo-svg' });
    var CX = 100, CY = 100, R = 82;
    var data = [[40, '体育', '#5b8def'], [30, '阅读', '#f2b544'], [20, '艺术', '#69c08d'], [10, '其他', '#c9d3e4']];
    var start = -90;
    var legend = el('div', { class: 'demo-legend' });
    data.forEach(function (item) {
      var deg = item[0] * 3.6;
      var rad1 = start * Math.PI / 180, rad2 = (start + deg) * Math.PI / 180;
      var x1 = CX + R * Math.cos(rad1), y1 = CY + R * Math.sin(rad1);
      var x2 = CX + R * Math.cos(rad2), y2 = CY + R * Math.sin(rad2);
      var large = deg > 180 ? 1 : 0;
      var path = svgNode('path', {
        d: 'M' + CX + ' ' + CY + ' L' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
          ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' Z',
        fill: item[2], stroke: '#fff', 'stroke-width': 1.5
      });
      svg.appendChild(path);
      legend.appendChild(el('span', { class: 'legend-item' }, [
        el('i', { class: 'legend-dot', style: 'background:' + item[2] }),
        el('span', { text: item[1] + ' ' + item[0] + '%' })
      ]));
      start += deg;
    });
    return el('div', { class: 'demo-body' }, [
      svg,
      legend,
      el('div', { class: 'demo-caption', text: '扇形统计图用扇形的大小表示各部分占总数的百分比，各部分加起来正好是 100%。' })
    ]);
  }

  // 圆柱：点击把侧面展开成长方形，直观看到侧面积 = 底面周长 × 高。
  function demoCylinder() {
    var svg = svgNode('svg', { viewBox: '0 0 380 220', class: 'demo-svg' });
    var group = svgNode('g', {});
    svg.appendChild(group);
    var W = 90, H = 110, CX = 120, TOP = 35, RX = W / 2, RY = 16;
    var body = svgNode('rect', { x: CX - W / 2, y: TOP, width: W, height: H, fill: '#bcd0f7', stroke: '#5b8def', 'stroke-width': 1.5 });
    var top = svgNode('ellipse', { cx: CX, cy: TOP, rx: RX, ry: RY, fill: '#dfe8f8', stroke: '#5b8def', 'stroke-width': 1.5 });
    group.appendChild(body); group.appendChild(top);
    var targetX = 235;
    var unfoldedW = (2 * Math.PI * RX); // 展开后长方形宽 = 底面周长
    var caption = el('div', { class: 'demo-caption', text: '圆柱的侧面展开是一个长方形。点一点看看它怎么展开。' });
    var flat = false, animating = false;
    var label = svgNode('text', { x: targetX + 10, y: TOP - 20, fill: '#5b8def', 'font-size': 13, opacity: 0 });
    label.textContent = '长 = 底面周长 2πr';
    var labelH = svgNode('text', { x: targetX + unfoldedW + 8, y: TOP + H / 2, fill: '#5b8def', 'font-size': 13, opacity: 0 });
    labelH.textContent = '宽 = 高';
    var rect = svgNode('rect', { x: targetX, y: TOP, width: 0, height: H, fill: '#bcd0f7', stroke: '#5b8def', 'stroke-width': 1.5, opacity: 1 });
    group.appendChild(rect);
    group.appendChild(label); group.appendChild(labelH);
    function unfold() {
      if (animating) return; animating = true;
      tween(900, function (e) {
        var w = unfoldedW * e;
        rect.setAttribute('width', w.toFixed(2));
        body.setAttribute('opacity', String(1 - e));
        top.setAttribute('opacity', String(1 - e));
        label.setAttribute('opacity', String(e));
        labelH.setAttribute('opacity', String(e));
      }, function () {
        animating = false; flat = true;
        caption.textContent = '展开得到长方形：长 = 底面周长 2πr，宽 = 高 h，所以侧面积 = 2πr × h。';
      });
    }
    function fold() {
      if (animating) return; animating = true;
      tween(900, function (e) {
        var w = unfoldedW * (1 - e);
        rect.setAttribute('width', w.toFixed(2));
        body.setAttribute('opacity', String(e));
        top.setAttribute('opacity', String(e));
        label.setAttribute('opacity', String(1 - e));
        labelH.setAttribute('opacity', String(1 - e));
      }, function () { animating = false; flat = false; caption.textContent = '圆柱的侧面展开是一个长方形。点一点看看它怎么展开。'; });
    }
    svg.style.cursor = 'pointer';
    svg.addEventListener('click', function () { flat ? fold() : unfold(); });
    return el('div', { class: 'demo-body' }, [
      svg,
      el('div', { class: 'demo-actions' }, [
        el('button', { class: 'demo-btn primary', type: 'button', text: '展开侧面', onclick: function () { flat ? fold() : unfold(); } })
      ]),
      caption
    ]);
  }

  // 圆锥的体积：等底等高的圆锥装满水，倒进圆柱看要倒几次。
  function demoCone() {
    var svg = svgNode('svg', { viewBox: '0 0 340 230', class: 'demo-svg' });
    var CX = 90, CY = 190;
    var coneW = 120, coneH = 100;
    var cone = svgNode('path', {
      d: 'M' + (CX - coneW / 2) + ' ' + CY + ' L' + (CX + coneW / 2) + ' ' + CY + ' L' + CX + ' ' + (CY - coneH) + ' Z',
      fill: '#f7dca4', stroke: '#e0a83c', 'stroke-width': 1.5
    });
    svg.appendChild(cone);
    svg.appendChild(svgNode('ellipse', { cx: CX, cy: CY, rx: coneW / 2, ry: 14, fill: '#f2e0b8', stroke: '#e0a83c', 'stroke-width': 1.5 }));
    var coneH2 = svgNode('line', { x1: CX, y1: CY, x2: CX, y2: CY - coneH, stroke: '#e0a83c', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' });
    svg.appendChild(coneH2);

    var cylX = 230, cylW = 110, cylH = 118, cylTop = 60;
    var cyl = svgNode('rect', { x: cylX, y: cylTop, width: cylW, height: cylH, fill: 'none', stroke: '#5b8def', 'stroke-width': 2 });
    svg.appendChild(cyl);
    var water = svgNode('rect', { x: cylX + 1, y: cylTop + cylH, width: cylW - 2, height: 0, fill: '#7fb2f0', opacity: 0.75 });
    svg.appendChild(water);
    var waterLabel = svgNode('text', { x: cylX + 8, y: cylTop - 8, fill: '#5b8def', 'font-size': 14 });
    waterLabel.textContent = '倒 0 次';
    svg.appendChild(waterLabel);

    var count = 0, animating = false;
    var caption = el('div', { class: 'demo-caption', text: '等底等高的圆锥和圆柱。把圆锥装满水倒进圆柱，猜猜要倒几次才能倒满？' });
    function pour() {
      if (animating || count >= 3) return;
      animating = true;
      count += 1;
      var fromH = (count - 1) / 3 * cylH, toH = count / 3 * cylH;
      tween(700, function (e) {
        var h = fromH + (toH - fromH) * e;
        water.setAttribute('height', h.toFixed(2));
        water.setAttribute('y', (cylTop + cylH - h).toFixed(2));
      }, function () {
        animating = false;
        waterLabel.textContent = '倒 ' + count + ' 次';
        if (count >= 3) caption.textContent = '正好倒了 3 次才装满！所以等底等高时，圆锥的体积是圆柱的 1/3：V锥 = 1/3 × πr²h。';
      });
    }
    function reset() {
      count = 0; animating = false;
      water.setAttribute('height', 0);
      water.setAttribute('y', cylTop + cylH);
      waterLabel.textContent = '倒 0 次';
      caption.textContent = '等底等高的圆锥和圆柱。把圆锥装满水倒进圆柱，猜猜要倒几次才能倒满？';
    }
    svg.addEventListener('click', pour);
    svg.style.cursor = 'pointer';
    return el('div', { class: 'demo-body' }, [
      svg,
      el('div', { class: 'demo-actions' }, [
        el('button', { class: 'demo-btn primary', type: 'button', text: '倒一次', onclick: pour }),
        el('button', { class: 'demo-btn', type: 'button', text: '重新来', onclick: reset })
      ]),
      caption
    ]);
  }

  // 按比分配：把一条线段按比例分成若干段，看每份是多少。
  function demoRatio() {
    var SETS = [[2, 3, 50], [1, 4, 60], [3, 5, 80]];
    var idx = 0;
    var svg = svgNode('svg', { viewBox: '0 0 340 140', class: 'demo-svg' });
    var num = el('div', { class: 'demo-num' });
    var caption = el('div', { class: 'demo-caption' });
    var colors = ['#5b8def', '#f2b544', '#69c08d', '#c9d3e4'];
    function build() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var s = SETS[idx], a = s[0], b = s[1], total = s[2];
      var sum = a + b;
      var W = 300, X = 20, Y = 60, H = 46;
      var parts = [a, b];
      var cursorX = X;
      parts.forEach(function (p, i) {
        var w = W * p / sum;
        svg.appendChild(svgNode('rect', { x: cursorX, y: Y, width: w, height: H, fill: colors[i], stroke: '#fff', 'stroke-width': 1.5 }));
        var t = svgNode('text', { x: cursorX + w / 2, y: Y + H / 2 + 5, fill: '#fff', 'font-size': 15, 'text-anchor': 'middle' });
        t.textContent = p + ' 份';
        svg.appendChild(t);
        cursorX += w;
      });
      num.textContent = '把 ' + total + ' 按 ' + a + ' : ' + b + ' 分配';
      caption.textContent = '总份数 ' + sum + ' 份，每份 ' + total + ' ÷ ' + sum + ' = ' + (total / sum).toFixed(1) +
        '，所以两部分分别是 ' + (total * a / sum).toFixed(1) + ' 和 ' + (total * b / sum).toFixed(1) + '。';
    }
    build();
    svg.addEventListener('click', function () { idx = (idx + 1) % SETS.length; build(); });
    svg.style.cursor = 'pointer';
    return el('div', { class: 'demo-body' }, [
      num, svg,
      el('div', { class: 'demo-actions' }, [
        el('button', { class: 'demo-btn primary', type: 'button', text: '换一组', onclick: function () { idx = (idx + 1) % SETS.length; build(); } })
      ]),
      caption
    ]);
  }

  // 裂项相消：一行一个分数，裂开后"前一项的尾"和"后一项的头"相消。
  function demoTelescope() {
    var terms = ['1/(1×2)', '1/(2×3)', '1/(3×4)', '1/(4×5)'];
    var pieces = ['1 − 1/2', '1/2 − 1/3', '1/3 − 1/4', '1/4 − 1/5'];
    var row = el('div', { class: 'telescope-row' });
    var split = false;
    var num = el('div', { class: 'demo-num', text: '1/(1×2) + 1/(2×3) + 1/(3×4) + 1/(4×5) = ?' });
    var caption = el('div', { class: 'demo-caption', text: '点一点，把每一项都拆成两个分数相减。' });
    function render() {
      clear(row);
      for (var i = 0; i < terms.length; i += 1) {
        row.appendChild(el('span', { class: 'tchip' + (split ? ' split' : ''), text: split ? pieces[i] : terms[i] }));
        if (i < terms.length - 1) row.appendChild(el('span', { class: 'tplus', text: '+' }));
      }
      caption.textContent = split
        ? '−1/2 与 +1/2、−1/3 与 +1/3……中间的都相互抵消，只剩 1 − 1/5 = 4/5。'
        : '点一点，把每一项都拆成两个分数相减。';
    }
    render();
    row.addEventListener('click', function () { split = !split; render(); });
    row.style.cursor = 'pointer';
    return el('div', { class: 'demo-body' }, [num, row, caption]);
  }

  // 负数与数轴：拖动滑杆，点沿数轴左右移动，看它相对 0 的位置。
  function demoNumberline() {
    var svg = svgNode('svg', { viewBox: '0 0 340 100', class: 'demo-svg' });
    var Y = 55, X0 = 20, W = 300, MIN = -10, MAX = 10;
    svg.appendChild(svgNode('line', { x1: X0, y1: Y, x2: X0 + W, y2: Y, stroke: '#c9d3e4', 'stroke-width': 2 }));
    for (var v = MIN; v <= MAX; v += 1) {
      var x = X0 + W * (v - MIN) / (MAX - MIN);
      svg.appendChild(svgNode('line', { x1: x, y1: Y - 4, x2: x, y2: Y + 4, stroke: '#c9d3e4', 'stroke-width': 1.4 }));
      if (v % 5 === 0) {
        var t = svgNode('text', { x: x, y: Y + 20, fill: '#8a94a6', 'font-size': 11, 'text-anchor': 'middle' });
        t.textContent = String(v);
        svg.appendChild(t);
      }
    }
    var dot = svgNode('circle', { cx: X0 + W / 2, cy: Y, r: 6, fill: '#ef6c5a' });
    svg.appendChild(dot);
    var num = el('div', { class: 'demo-num' });
    var slider = el('input', { class: 'demo-slider', type: 'range', min: '-10', max: '10', value: '0', step: '1' });
    function update() {
      var val = Number(slider.value);
      dot.setAttribute('cx', (X0 + W * (val - MIN) / (MAX - MIN)).toFixed(2));
      num.textContent = val < 0 ? val + '（负数，在 0 的左边）' : val > 0 ? '+' + val + '（正数，在 0 的右边）' : '0（正负数的分界）';
    }
    slider.addEventListener('input', update);
    update();
    svg.addEventListener('click', function (e) {
      var rect = svg.getBoundingClientRect();
      var ratio = (e.clientX - rect.left) / rect.width * (MAX - MIN) + MIN;
      slider.value = String(Math.round(Math.max(MIN, Math.min(MAX, ratio))));
      update();
    });
    svg.style.cursor = 'pointer';
    return el('div', { class: 'demo-body' }, [
      num, svg, slider,
      el('div', { class: 'demo-caption', text: '数轴上，0 右边的数是正数，左边的数是负数。拖一拖或点一点数轴。' })
    ]);
  }

  // 讲解页的互动演示卡片；知识点没有匹配的动画时返回 null。
  function demoCard(knowledge) {
    var demo = pickMathDemo(knowledge);
    if (!demo) return null;
    var titles = {
      circleArea: '圆的面积 · 拼一拼',
      circleParts: '圆的认识 · 认一认',
      circleCircum: '圆的周长 · 滚一滚',
      ring: '圆环的面积 · 拉一拉',
      sector: '扇形 · 转一转',
      pie: '扇形统计图 · 看一看',
      cylinder: '圆柱 · 展一展',
      cone: '圆锥的体积 · 倒一倒',
      ratio: '按比分配 · 分一分',
      telescope: '裂项相消 · 消一消',
      numberline: '正负数与数轴 · 走一走',
      fraction: '分数乘分数 · 涂一涂',
      percent: demo.variant === 'concentration' ? '浓度问题 · 拉一拉'
        : demo.variant === 'discount' ? '折扣 · 拉一拉'
          : demo.variant === 'chengshu' ? '成数 · 拉一拉'
            : '百分数 · 拉一拉'
    };

    var builders = {
      circleArea: demoCircleArea,
      circleParts: demoCircleParts,
      circleCircum: demoCircleCircumference,
      ring: demoRing,
      sector: demoSector,
      pie: demoPie,
      cylinder: demoCylinder,
      cone: demoCone,
      ratio: demoRatio,
      telescope: demoTelescope,
      numberline: demoNumberline,
      fraction: demoFractionMultiply,
      percent: function () { return demoPercent(demo.variant); }
    };
    var builder = builders[demo.type];
    if (!builder) return null;
    var body = builder();
    return el('div', { class: 'card demo-card' }, [
      el('div', { class: 'demo-head' }, [
        el('span', { class: 'demo-tag', text: '互动演示' }),
        el('span', { class: 'demo-title', text: titles[demo.type] })
      ]),
      body,
      el('div', { class: 'demo-hint', text: '点一点图和按钮试试，边玩边理解' })
    ]);
  }

  function renderLearn() {
    var learn = state.learn;
    if (!learn) return;
    var page = $('#learn-page');
    clear(page);
    page.appendChild(stepsBar(learn.step));

    if (learn.step === 'lesson') {
      var body = el('div', { class: 'lesson-body' });
      if (!learn.lesson) {
        body.appendChild(el('span', { class: 'spinner dark' }));
        body.appendChild(document.createTextNode('老师正在准备讲解…'));
      } else {
        body.textContent = learn.lesson;
        if (!learn.lessonDone) body.classList.add('typing');
      }
      page.appendChild(el('div', { class: 'card' }, [body]));

      // 数学/奥数知识点如果匹配到内置动画，把演示卡片放在讲解下方
      var demo = learn.knowledge ? demoCard(learn.knowledge) : null;
      if (demo) page.appendChild(demo);

      if (learn.lessonDone) {
        page.appendChild(
          el('div', { class: 'actions' }, [
            el('button', {
              class: 'btn',
              type: 'button',
              text: '开始练习（3 题）',
              onclick: startPractice
            })
          ])
        );
      }
    } else if (learn.step === 'practice') {
      renderQuestion(page);
    } else {
      renderResult(page);
    }
  }

  async function loadLesson() {
    var learn = state.learn;
    var knowledge = learn.knowledge;
    var spec = subjectAnswerSpec(knowledge.subject);
    var isCs = knowledge.subject === '信息学';
    var system = isCs
      ? '你是一位信息学竞赛教练，正在给准备 GESP 5 级以上和 CSP-J 的学生做一对一讲解。语言简洁直接，多用具体例子和 C++ 代码，不要使用 Markdown 标题符号和表情符号。'
      : '你是一位经验丰富的小学老师，正在给六年级学生做一对一讲解。语言简洁口语化，多用具体例子，不要使用 Markdown 标题符号和表情符号。';
    var prompt =
      '请讲解这个知识点。\n' +
      '学科：' + knowledge.subject + '（' + knowledge.textbook + '）\n' +
      '知识点：' + knowledge.name + '\n' +
      '教材位置：' + knowledge.chapter + (knowledge.unit_name ? ' · ' + knowledge.unit_name : '') + '\n' +
      '要点提示：' + (knowledge.summary || '') + '\n' +
      '本学科的题面与答题格式：' + spec.brief + '\n\n' +
      '请按这个结构讲，总长控制在 450 字以内：\n' +
      '1. 一句话说清它是什么\n' +
      '2. 为什么是这样（讲道理，不要只给结论）\n' +
      '3. 一个具体例子，带完整过程' + (isCs ? '（必须给出完整可运行的 C++ 代码，包含读入、处理和输出）' : '') + '\n' +
      '4. 一个最容易出错的地方\n' +
      '5. 这类题怎么答：' + spec.howto + '\n\n' +
      '特别注意：第 5 部分必须讲清楚「答题格式」，因为接下来出的 3 道练习题就是按这个格式来的；'
      + '只讲知识点而漏掉答题格式，学生做题时会不知道怎么下笔。';

    try {
      await API.llm.stream(system, prompt, function (delta) {
        if (!state.learn || state.learn.step !== 'lesson') return;
        state.learn.lesson += delta;
        var node = $('#learn-page .lesson-body');
        if (node) {
          node.textContent = state.learn.lesson;
          node.classList.add('typing');
        }
      }, {
        // Thinking models emit reasoning first; show it as progress
        // instead of leaving the child staring at a motionless spinner.
        onReasoning: function () {
          if (!state.learn || state.learn.step !== 'lesson') return;
          var node = $('#learn-page .lesson-body');
          if (node && !state.learn.lesson) {
            node.textContent = '老师正在思考怎么讲更好…（约需十几秒）';
          }
        }
      });
      if (!state.learn) return;
      state.learn.lessonDone = true;
      renderLearn();
    } catch (error) {
      fail(error);
      if (state.learn) {
        state.learn.lesson = state.learn.lesson || '讲解加载失败，可以直接开始练习。';
        state.learn.lessonDone = true;
        renderLearn();
      }
    }
  }

  function parseQuestions(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    var parsed = JSON.parse(text);
    var list = parsed.questions || parsed.items || parsed.data || [];
    return list.filter(function (q) {
      return q && q.stem && q.answer !== undefined && q.answer !== null && String(q.answer).length;
    }).slice(0, 5);
  }

  async function startPractice() {
    var learn = state.learn;
    if (!learn || learn.busy) return;
    learn.busy = true;
    var knowledge = learn.knowledge;

    var page = $('#learn-page');
    clear(page);
    page.appendChild(stepsBar('practice'));
    page.appendChild(
      el('div', { class: 'empty' }, [
        el('div', { class: 'big' }, [
          el('span', { class: 'spinner dark' }),
          document.createTextNode('正在出题…')
        ]),
        el('div', { text: '针对「' + knowledge.name + '」生成练习题' })
      ])
    );

    var spec = subjectAnswerSpec(knowledge.subject);
    var isCs = knowledge.subject === '信息学';
    var system = isCs
      ? '你是一位信息学竞赛命题老师，只输出合法的 JSON 对象，不输出任何解释文字、不使用代码块标记。'
      : '你是一位小学命题老师，只输出合法的 JSON 对象，不输出任何解释文字、不使用代码块标记。';
    var prompt =
      '请针对下面的知识点出 3 道练习题。\n' +
      '学科：' + knowledge.subject + '\n' +
      '知识点：' + knowledge.name + '\n' +
      '要点：' + (knowledge.summary || '') + '\n\n' +
      '本学科的题面与答题格式：' + spec.brief + '\n' +
      '题型要求：' + spec.types + '\n\n' +
      '要求：\n' +
      '- 难度贴合学生当前水平' + (isCs ? '（GESP 5 级以上，中等偏难，不要出刚学几天的入门题）' : '（六年级）') + '。\n' +
      '- 题干清晰无歧义，单选题四个选项中只有一个正确答案。\n' +
      '- 解析要按本学科的答题格式讲清思路和格式，不要只重复答案。\n' +
      '- 填空题的答案必须唯一且简短（不超过 20 个字），题干里用四个下划线表示空。\n' +
      '- 只有程序阅读题才输出 code 字段（纯 C++ 代码，用 \\n 换行，不要加代码块标记），其他题型不要输出 code 字段。\n\n' +
      '严格按这个 JSON 结构输出：\n' +
      '{"questions":[{"type":"choice","stem":"题干文字","code":"可选：程序阅读题的C++代码","options":["选项A内容","选项B内容","选项C内容","选项D内容"],"answer":"A","analysis":"解析文字"},{"type":"blank","stem":"题干中有____的句子","answer":"标准答案","analysis":"解析文字"}]}';

    try {
      var raw = await API.llm.stream(system, prompt, null, { temperature: 0.5, json: true });
      var questions = parseQuestions(raw);
      if (!questions.length) throw new Error('出题结果无法解析，请重试');
      learn.questions = questions.map(function (q) {
        var isChoice = String(q.type || 'choice') === 'choice' && Array.isArray(q.options) && q.options.length >= 2;
        return {
          type: isChoice ? 'choice' : 'blank',
          stem: q.stem,
          code: q.code ? String(q.code) : null,
          options: isChoice ? q.options : null,
          answer: String(q.answer).trim(),
          analysis: q.analysis || ''
        };
      });
      learn.index = 0;
      learn.answers = [];
      learn.step = 'practice';
      learn.busy = false;
      renderLearn();
    } catch (error) {
      learn.busy = false;
      fail(error);
      renderLearn();
    }
  }

  function renderQuestion(page) {
    var learn = state.learn;
    var question = learn.questions[learn.index];
    if (!question) return;

    page.appendChild(
      el('div', { class: 'section-title' }, [
        '第 ' + (learn.index + 1) + ' / ' + learn.questions.length + ' 题',
        el('span', { class: 'count', text: question.type === 'choice' ? '单选题' : '填空题' })
      ])
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'question', text: question.stem }),
        question.code ? el('pre', { class: 'code-block', text: question.code }) : null
      ])
    );

    var answerWrap = el('div');
    page.appendChild(answerWrap);

    if (question.type === 'choice') {
      var letters = ['A', 'B', 'C', 'D', 'E'];
      question.options.forEach(function (option, i) {
        var letter = letters[i];
        answerWrap.appendChild(
          el('button', {
            class: 'option',
            type: 'button',
            onclick: function () { submitAnswer(letter, answerWrap); }
          }, [
            el('span', { class: 'key', text: letter }),
            el('span', { text: String(option) })
          ])
        );
      });
    } else {
      var input = el('input', {
        class: 'field',
        style: 'width:100%;padding:13px 14px;border:1px solid #e9ecf0;border-radius:10px;background:#fff;outline:none',
        placeholder: '在这里填写答案'
      });
      answerWrap.appendChild(el('div', { class: 'card' }, [input]));
      answerWrap.appendChild(
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: '提交答案',
            onclick: function () { submitAnswer(input.value.trim(), answerWrap); }
          })
        ])
      );
    }
  }

  function normalize(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/\s+/g, '')
      .replace(/[，。！？；：""''（）【】]/g, '')
      .toLowerCase();
  }

  function isCorrect(question, answer) {
    if (!String(answer || '').length) return false;
    if (question.type === 'choice') {
      return String(question.answer).trim().toUpperCase() === String(answer).trim().toUpperCase();
    }
    var expected = normalize(question.answer);
    var given = normalize(answer);
    if (expected === given) return true;
    return given.length > 0 && expected.indexOf(given) === 0 && given.length >= expected.length - 1;
  }

  async function submitAnswer(answer, answerWrap) {
    var learn = state.learn;
    if (!learn || learn.busy) return;
    var question = learn.questions[learn.index];
    var correct = isCorrect(question, answer);

    learn.busy = true;

    // Lock the options and show the verdict.
    $$('#learn-page .option').forEach(function (node) {
      node.disabled = true;
    });
    $$('#learn-page .btn').forEach(function (node) {
      node.disabled = true;
    });

    if (question.type === 'choice') {
      $$('#learn-page .option').forEach(function (node, i) {
        var letters = ['A', 'B', 'C', 'D', 'E'];
        var letter = letters[i];
        if (letter === String(question.answer).trim().toUpperCase()) node.classList.add('right');
        else if (letter === answer) node.classList.add('wrong');
      });
    }

    answerWrap.appendChild(
      el('div', { class: 'answer-box' }, [
        el('div', {
          class: 'verdict ' + (correct ? 'ok' : 'no'),
          text: correct ? '答对了' : '答错了'
        }),
        el('div', { class: 'line', text: '正确答案：' + question.answer }),
        question.analysis ? el('div', { class: 'line', text: '解析：' + question.analysis }) : null
      ])
    );

    var last = learn.index === learn.questions.length - 1;
    answerWrap.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: last ? '查看结果' : '下一题',
          onclick: function () {
            learn.answers.push({ question: question, answer: answer, correct: correct });
            learn.busy = false;
            if (last) {
              finishPractice();
            } else {
              learn.index += 1;
              renderLearn();
            }
          }
        })
      ])
    );

    // Persist immediately so a mid-way exit still keeps the record.
    try {
      var targetCode = question.knowledgeCode || learn.knowledge.code;
      var targetKnowledge = knowledgeByCode(targetCode);
      var outcome = await API.study.record({
        studentId: state.student.id,
        knowledgeCode: targetCode,
        subject: (targetKnowledge && targetKnowledge.subject) || learn.knowledge.subject || null,
        textbookCode: (targetKnowledge && targetKnowledge.textbook_code) || null,
        qtype: question.type,
        stem: question.stem,
        userAnswer: answer,
        correctAnswer: question.answer,
        isCorrect: correct,
        options: question.options,
        analysis: question.analysis,
        source: learn.mode === 'review' ? 'review' : 'practice',
        // An imported question with no knowledge point still gets logged and
        // filed as wrong, but must not invent a mastery record.
        skipMastery: !targetKnowledge
      });
      learn.lastOutcome = outcome;
      pushLocalPracticeLog({
        knowledgeCode: targetCode,
        subject: (targetKnowledge && targetKnowledge.subject) || learn.knowledge.subject || null,
        textbookCode: (targetKnowledge && targetKnowledge.textbook_code) || null,
        qtype: question.type,
        stem: question.stem,
        userAnswer: answer,
        correctAnswer: question.answer,
        isCorrect: correct,
        source: learn.mode === 'review' ? 'review' : 'practice'
      });
      if (targetKnowledge) {
        state.mastery[targetCode] = Object.assign(
          {},
          state.mastery[targetCode] || {},
          { status: outcome.status, level: outcome.level, correct_count: outcome.correctCount, total_count: outcome.totalCount }
        );
      }
    } catch (error) {
      fail(error);
    }
  }

  function finishPractice() {
    var learn = state.learn;
    var total = learn.answers.length;
    var correct = learn.answers.filter(function (a) { return a.correct; }).length;
    learn.step = 'result';
    learn.summary = { total: total, correct: correct };
    renderLearn();
    if (state.student) {
      API.activity.log({
        studentId: state.student.id,
        kind: learn.mode === 'review' ? 'review' : 'practice',
        subject: learn.knowledge.subject || null,
        knowledgeCode: learn.knowledge.code || null,
        title: (learn.mode === 'review' ? '错题重做 · ' : '练习 · ') + (learn.knowledge.name || ''),
        detail: '答对 ' + correct + '/' + total + ' 题',
        minutes: 5
      }).then(function (rows) {
        if (rows && rows.length) state.activities = rows.concat(state.activities);
      }).catch(function () {});
      API.study.listWrongBook(state.student.id)
        .then(function (list) { state.wrongList = list; })
        .catch(function () {});
    }
  }

  function renderResult(page) {
    var learn = state.learn;
    var summary = learn.summary || { total: 0, correct: 0 };
    var rate = summary.total ? Math.round((summary.correct / summary.total) * 100) : 0;
    var record = state.mastery[learn.knowledge.code];
    var status = record ? record.status : 'learning';

    page.appendChild(
      el('div', { class: 'result-hero' }, [
        el('div', { class: 'big', text: rate + '%' }),
        el('div', { class: 'cap', text: '本次答对 ' + summary.correct + ' / ' + summary.total + ' 题' })
      ])
    );

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: learn.knowledge.name }),
          el('span', { class: 'tag ' + status, text: status === 'mastered' ? '已掌握' : '待巩固' })
        ]),
        el('p', {
          class: 'card-summary',
          text: status === 'mastered'
            ? '这个知识点已经掌握，它会从今后的今日清单里消失。'
            : '还需要再练几轮。累计正确率达到 80% 以上就会标记为已掌握。'
        }),
        record
          ? el('p', { class: 'card-summary', text: '累计：答对 ' + record.correct_count + ' / ' + record.total_count + ' 次' })
          : null
      ])
    );

    page.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn secondary',
          type: 'button',
          text: '再练一组',
          onclick: function () {
            state.learn.step = 'practice';
            state.learn.busy = false;
            startPractice();
          }
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: '返回清单',
          onclick: function () {
            state.learn = null;
            showScreen('main');
            switchTab('today');
          }
        })
      ])
    );
  }

  // ---------------- daily English reading (shadowing) ----------------

  var READING_PER_DAY = 3;

  function dateKey(value) {
    return String(value === undefined || value === null ? '' : value).slice(0, 10);
  }

  // Local-calendar key. Never use toISOString() here: in UTC+8 it would report
  // the previous day for any local time before 08:00.
  function localKey(date) {
    var m = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function todayKey() {
    return localKey(new Date());
  }

  // The sentence bank rotates by calendar day, so every day brings different
  // sentences without any server-side scheduling.
  function todaySentences() {
    var list = state.reading.sentences;
    if (!list.length) return [];
    var dayNumber = Math.floor(new Date(todayKey() + 'T00:00:00').getTime() / 86400000);
    var start = (dayNumber * READING_PER_DAY) % list.length;
    var picked = [];
    for (var i = 0; i < READING_PER_DAY && i < list.length; i += 1) {
      picked.push(list[(start + i) % list.length]);
    }
    return picked;
  }

  function readingLog(code) {
    var key = todayKey();
    for (var i = 0; i < state.reading.logs.length; i += 1) {
      var row = state.reading.logs[i];
      if (row.sentence_code === code && dateKey(row.read_date) === key) return row;
    }
    return null;
  }

  function readingStreak() {
    var days = {};
    state.reading.logs.forEach(function (row) { days[dateKey(row.read_date)] = true; });
    var streak = 0;
    var cursor = new Date(todayKey() + 'T00:00:00');
    // Today counts as soon as it has a record; before that, count back from
    // yesterday so an unfinished today does not look like a broken streak.
    if (!days[todayKey()]) cursor.setDate(cursor.getDate() - 1);
    for (;;) {
      var key = localKey(cursor);
      if (!days[key]) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function readingTotals() {
    var days = {};
    var attempts = 0;
    var scoreSum = 0;
    var scored = 0;
    var best = 0;
    state.reading.logs.forEach(function (row) {
      days[dateKey(row.read_date)] = true;
      attempts += row.attempts || 0;
      if (row.asr_score) {
        scoreSum += row.asr_score;
        scored += 1;
        if (row.asr_score > best) best = row.asr_score;
      }
    });
    return {
      attempts: attempts,
      days: Object.keys(days).length,
      scored: scored,
      avg: scored ? Math.round(scoreSum / scored) : 0,
      best: best
    };
  }

  // ---- model pronunciation (bundled MP3 first, browser TTS as fallback) ----

  var ttsVoice = null;
  var demoAudio = null;       // currently playing <audio>, so taps can stop it
  var demoClips = {};         // code -> Audio element, or 'missing' after a 404

  function pickTtsVoice() {
    if (!('speechSynthesis' in window)) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    var en = voices.filter(function (v) { return /^en([-_]|$)/i.test(v.lang || ''); });
    var us = en.filter(function (v) { return /^en[-_]us/i.test(v.lang || ''); });
    ttsVoice = us[0] || en[0] || null;
    return ttsVoice;
  }

  function stopDemo() {
    if (demoAudio) {
      try { demoAudio.pause(); } catch (e) { /* ignore */ }
      demoAudio = null;
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
  }

  function speakWithTts(text) {
    if (!('speechSynthesis' in window)) {
      toast('这台设备暂不支持朗读示范，可以直接录音跟读');
      return false;
    }
    var synth = window.speechSynthesis;
    try { synth.cancel(); } catch (e) { /* ignore */ }
    var utterance = new SpeechSynthesisUtterance(String(text));
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    utterance.pitch = 1;
    if (!ttsVoice) pickTtsVoice();
    if (ttsVoice) utterance.voice = ttsVoice;
    synth.speak(utterance);
    return true;
  }

  function speakEnglish(code, text) {
    stopDemo();
    // Bundled MP3 plays on every browser, including ones without speechSynthesis.
    var clip = demoClips[code];
    if (clip !== 'missing') {
      if (!clip) {
        clip = new Audio('audio/' + code + '.mp3');
        clip.preload = 'none';
        demoClips[code] = clip;
      }
      try { clip.currentTime = 0; } catch (e) { /* ignore */ }
      demoAudio = clip;
      var attempt = clip.play();
      if (attempt && attempt.catch) {
        attempt.catch(function () {
          // Missing or undecodable file: remember it and use browser TTS.
          demoClips[code] = 'missing';
          demoAudio = null;
          speakWithTts(text);
        });
      }
      return true;
    }
    return speakWithTts(text);
  }

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = pickTtsVoice;
    pickTtsVoice();
  }

  // ---- recording (MediaRecorder, needs HTTPS + mic permission) ----

  function recorderSupported() {
    return !!(
      window.MediaRecorder &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.isSecureContext
    );
  }

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg'];
    for (var i = 0; i < list.length; i += 1) {
      if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  function releaseStream() {
    var stream = state.reading.stream;
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
    }
    state.reading.stream = null;
  }

  function stopRecording() {
    var recorder = state.reading.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    state.reading.recording = false;
    state.reading.mediaRecorder = null;
    stopRecognition();
    releaseStream();
    renderReading();
  }

  function startRecording(code) {
    if (!recorderSupported()) {
      toast('这台设备不能录音，可以跟读后点「今天读过了」打卡');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var mime = pickMime();
        var recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        state.reading.stream = stream;
        state.reading.mediaRecorder = recorder;
        state.reading.chunks = [];
        state.reading.startedAt = Date.now();
        state.reading.recordingCode = code;
        state.reading.recording = true;
        recorder.ondataavailable = function (event) {
          if (event.data && event.data.size) state.reading.chunks.push(event.data);
        };
        recorder.onstop = function () { handleRecordingStop(code); };
        recorder.start();
        // System scoring runs in parallel with the clip: the recogniser owns a
        // second audio pipeline, so it never has to wait for the recording.
        startRecognition(code);
        renderReading();
      })
      .catch(function (error) {
        releaseStream();
        state.reading.recording = false;
        state.reading.mediaRecorder = null;
        renderReading();
        toast(
          error && error.name === 'NotAllowedError'
            ? '没有拿到麦克风权限，请在浏览器设置里允许后重试'
            : '录音启动失败，请重试'
        );
      });
  }

  async function handleRecordingStop(code) {
    var chunks = state.reading.chunks || [];
    var duration = Date.now() - (state.reading.startedAt || Date.now());
    state.reading.recording = false;
    state.reading.mediaRecorder = null;
    state.reading.chunks = [];
    var pendingAsr = stopRecognition();
    releaseStream();

    if (!chunks.length || duration < 400) {
      renderReading();
      toast('没有录到声音，再试一次吧');
      return;
    }

    var blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
    if (state.reading.clipUrl) {
      try { URL.revokeObjectURL(state.reading.clipUrl); } catch (e) { /* ignore */ }
    }
    state.reading.clipUrl = URL.createObjectURL(blob);
    state.reading.clipCode = code;
    state.reading.clipDuration = duration;
    state.reading.scoring = code;
    renderReading();

    // Let the recogniser flush its final words before we compare.
    if (pendingAsr) {
      try { await pendingAsr; } catch (error) { /* ignore */ }
    }

    var said = state.reading.asrCode === code ? state.reading.asrText : '';
    var accuracy = said ? scoreReading(sentenceText(code), said) : null;
    // Audio analysis runs even when speech recognition is unavailable, so a
    // score is always produced. Decoding happens after the clip is saved.
    var audio = null;
    try {
      audio = await analyzeClip(blob, englishWords(sentenceText(code)).length);
    } catch (error) { audio = null; }
    var result = combineResult(accuracy, audio);

    try {
      await saveReading(code, {
        durationMs: duration,
        asrText: said || null,
        asrScore: result ? result.score : null,
        asrDetail: result ? result.detail : null
      });
      state.reading.scoring = null;
      renderReading();
      if (result) toast('跟读评分 ' + result.score + ' 分 · ' + result.level);
      else if (asrSupported()) toast('这次没听清，可以再录一遍');
      else toast('录音已保存，但这次没能算出评分，再大声读一次试试');
    } catch (error) {
      state.reading.scoring = null;
      fail(error);
    }
  }

  function playClip() {
    if (!state.reading.clipUrl) {
      toast('先录一段自己的朗读');
      return;
    }
    var audio = new Audio(state.reading.clipUrl);
    audio.play().catch(function () { toast('播放失败，请重试'); });
  }

  // ---- system scoring (browser speech recognition, no upload needed) ----
  //
  // The microphone audio never leaves the device: the browser transcribes it
  // locally and we only store the recognised text plus a similarity score.
  // Browsers without the Web Speech API fall back to self-rating only.

  function speechRecognitionClass() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function asrSupported() {
    return !!speechRecognitionClass() && !!window.isSecureContext;
  }

  function normalizeEnglish(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9' ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function englishWords(text) {
    var clean = normalizeEnglish(text);
    return clean ? clean.split(' ') : [];
  }

  // Longest common subsequence over words: matched words are counted, the rest
  // split into "missed" (in the original, not spoken) and "extra" (added).
  function alignWords(targetWords, saidWords) {
    var n = targetWords.length;
    var m = saidWords.length;
    var dp = [];
    var i;
    var j;
    for (i = 0; i <= n; i += 1) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (i = 1; i <= n; i += 1) {
      for (j = 1; j <= m; j += 1) {
        dp[i][j] = targetWords[i - 1] === saidWords[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    var marks = [];
    var ok = 0;
    var miss = 0;
    var extra = 0;
    i = n;
    j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && targetWords[i - 1] === saidWords[j - 1]) {
        marks.push({ word: targetWords[i - 1], status: 'ok' });
        ok += 1;
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        marks.push({ word: saidWords[j - 1], status: 'extra' });
        extra += 1;
        j -= 1;
      } else {
        marks.push({ word: targetWords[i - 1], status: 'miss' });
        miss += 1;
        i -= 1;
      }
    }
    marks.reverse();
    return { marks: marks, ok: ok, miss: miss, extra: extra };
  }

  function scoreReading(target, saidText) {
    var targetWords = englishWords(target);
    var saidWords = englishWords(saidText);
    if (!targetWords.length || !saidWords.length) return null;

    var aligned = alignWords(targetWords, saidWords);
    var coverage = aligned.ok / targetWords.length;
    // Reading the sentence but adding stray words should not score a full mark.
    var penalty = Math.min(0.25, (aligned.extra / targetWords.length) * 0.5);
    var score = Math.round(Math.max(0, coverage - penalty) * 100);

    return {
      score: score,
      level: score >= 90 ? '优秀' : score >= 80 ? '良好' : score >= 65 ? '及格' : '再练一次',
      coverage: Math.round(coverage * 100),
      ok: aligned.ok,
      miss: aligned.miss,
      extra: aligned.extra,
      total: targetWords.length,
      words: aligned.marks,
      text: saidText
    };
  }

  // ---- audio-based scoring (works in every browser, no ASR needed) ----
  //
  // 浏览器语音识别在多数环境（尤其国内 Chrome）连不上服务，所以录音本身也
  // 必须能打分：解码录音 → 20ms 分帧算响度 → 统计有效发声时长、中途停顿、
  // 语速，给出完整度 / 流利度 / 响亮度三个分数。逐词准确度只在识别可用时
  // 叠加进总分。

  function levelOf(score) {
    return score >= 90 ? '优秀' : score >= 80 ? '良好' : score >= 65 ? '及格' : '再练一次';
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function blobToArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  // decodeAudioData: promise form on modern browsers, callback form elsewhere.
  function decodeAudio(ctx, buffer) {
    return new Promise(function (resolve, reject) {
      var pending;
      try {
        pending = ctx.decodeAudioData(buffer, resolve, reject);
      } catch (error) {
        reject(error);
        return;
      }
      if (pending && pending.then) pending.then(resolve, reject);
    });
  }

  async function analyzeClip(blob, wordCount) {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor || !wordCount) return null;
    var raw = await blobToArrayBuffer(blob);
    var ctx = new Ctor();
    var decoded;
    try {
      decoded = await decodeAudio(ctx, raw);
    } finally {
      try { ctx.close(); } catch (e) { /* ignore */ }
    }

    var data = decoded.getChannelData(0);
    var sampleRate = decoded.sampleRate || 44100;
    var frameLen = Math.max(1, Math.floor(sampleRate * 0.02));
    var frames = [];
    for (var i = 0; i + frameLen <= data.length; i += frameLen) {
      var sum = 0;
      for (var j = i; j < i + frameLen; j += 1) sum += data[j] * data[j];
      frames.push(Math.sqrt(sum / frameLen));
    }
    if (!frames.length) return null;

    var peak = 0;
    frames.forEach(function (v) { if (v > peak) peak = v; });
    // A clip that never rises above ~-56 dBFS is silence, not reading.
    if (peak < 0.0015) return null;
    // Normal recordings get an absolute noise floor; very quiet ones (soft
    // voice, low mic gain) fall back to a relative threshold so a whisper is
    // still measured — it just scores low on loudness instead of vanishing.
    var threshold = peak >= 0.01 ? Math.max(0.008, peak * 0.07) : peak * 0.07;

    var active = frames.map(function (v) { return v >= threshold; });
    var activeFrames = 0;
    active.forEach(function (a) { if (a) activeFrames += 1; });
    var activeMs = activeFrames * 20;

    // Pauses: silent gaps of 0.6s+ between the first and last spoken frame.
    var first = -1;
    var last = -1;
    var k;
    for (k = 0; k < active.length; k += 1) {
      if (active[k]) { if (first < 0) first = k; last = k; }
    }
    if (first < 0) return null;
    var pauses = 0;
    var run = 0;
    for (k = first; k <= last; k += 1) {
      if (!active[k]) run += 1;
      else {
        if (run * 20 >= 600) pauses += 1;
        run = 0;
      }
    }

    // ≈2.4 words/s is a steady grade-6 reading pace; 420 ms per word.
    var expectedMs = wordCount * 420;
    var pace = activeMs / expectedMs;

    // Completeness: only reading too little is punished; a slower reader who
    // finishes the sentence still gets the full mark here.
    var complete = clampScore((pace / 0.8) * 100);
    // Fluency: each long stall costs 7 points (capped), and a very hesitant
    // or very dragged-out pace scales the whole score down.
    var pausePenalty = Math.min(35, pauses * 7);
    var paceFactor = pace < 0.7
      ? Math.max(0.4, pace / 0.7)
      : pace > 2.4 ? Math.max(0.5, 2.4 / pace) : 1;
    var fluency = clampScore((100 - pausePenalty) * paceFactor);
    // Loudness: mean RMS over spoken frames, log-mapped 0.003 → 0.08.
    var meanRms = 0;
    var count = 0;
    for (k = first; k <= last; k += 1) {
      if (active[k]) { meanRms += frames[k]; count += 1; }
    }
    meanRms = count ? meanRms / count : 0;
    var lo = Math.log(0.003);
    var hi = Math.log(0.08);
    var loudness = clampScore(
      ((Math.log(Math.max(meanRms, 1e-5)) - lo) / (hi - lo)) * 100
    );

    return {
      complete: complete,
      fluency: fluency,
      loudness: loudness,
      activeMs: activeMs,
      expectedMs: expectedMs,
      pauses: pauses,
      seconds: Math.round(activeMs / 100) / 10
    };
  }

  function combineResult(accuracy, audio) {
    if (!accuracy && !audio) return null;
    var detail = {};
    var total;
    if (accuracy && audio) {
      total = Math.round(accuracy.score * 0.6 + audio.complete * 0.2 + audio.fluency * 0.2);
      detail.source = 'asr+audio';
    } else if (accuracy) {
      total = accuracy.score;
      detail.source = 'asr';
    } else {
      total = Math.round(audio.complete * 0.4 + audio.fluency * 0.3 + audio.loudness * 0.3);
      detail.source = 'audio';
    }
    detail.score = total;
    detail.level = levelOf(total);
    if (accuracy) {
      detail.accuracy = {
        score: accuracy.score,
        coverage: accuracy.coverage,
        ok: accuracy.ok,
        miss: accuracy.miss,
        extra: accuracy.extra,
        total: accuracy.total,
        words: accuracy.words
      };
    }
    if (audio) detail.audio = audio;
    return { score: total, level: detail.level, said: accuracy ? accuracy.text : '', detail: detail };
  }

  function startRecognition(code) {
    var Ctor = speechRecognitionClass();
    if (!Ctor || !window.isSecureContext) return;
    try {
      var recognition = new Ctor();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      state.reading.asrText = '';
      state.reading.asrFailed = false;
      state.reading.asrCode = code;
      recognition.onresult = function (event) {
        var text = '';
        for (var i = 0; i < event.results.length; i += 1) {
          text += event.results[i][0].transcript + ' ';
        }
        state.reading.asrText = text.trim();
      };
      recognition.onerror = function () {
        state.reading.asrFailed = true;
      };
      recognition.onend = function () {
        state.reading.recognizing = false;
        var resolve = state.reading.asrResolver;
        state.reading.asrResolver = null;
        if (resolve) resolve();
      };
      recognition.start();
      state.reading.recognition = recognition;
      state.reading.recognizing = true;
    } catch (error) {
      state.reading.recognition = null;
      state.reading.recognizing = false;
    }
  }

  // Stops recognition and resolves once the engine has flushed its final
  // result (capped, so a silent mic cannot freeze the UI).
  function stopRecognition() {
    var recognition = state.reading.recognition;
    state.reading.recognition = null;
    if (!recognition) return null;
    var pending = new Promise(function (resolve) {
      state.reading.asrResolver = resolve;
      setTimeout(resolve, 3000);
    });
    try { recognition.stop(); } catch (error) { /* ignore */ }
    return pending;
  }

  function sentenceText(code) {
    for (var i = 0; i < state.reading.sentences.length; i += 1) {
      if (state.reading.sentences[i].code === code) return state.reading.sentences[i].text_en;
    }
    return '';
  }

  async function saveReading(code, extra) {
    var entry = {
      studentId: state.student.id,
      sentenceCode: code,
      readDate: todayKey()
    };
    Object.keys(extra || {}).forEach(function (key) { entry[key] = extra[key]; });
    var row = await API.reading.saveAttempt(entry);
    state.reading.logs = state.reading.logs.filter(function (r) {
      return !(r.sentence_code === code && dateKey(r.read_date) === entry.readDate);
    });
    if (row) state.reading.logs.unshift(row);
    return row;
  }

  async function rateReading(code, rating) {
    try {
      await saveReading(code, { rating: rating, countAttempt: false });
      renderReading();
      toast(
        rating === 3 ? '这一句读顺了，继续保持'
          : rating === 2 ? '记录下来，明天再顺一遍'
            : '没关系，多读两遍就顺了'
      );
    } catch (error) {
      fail(error);
    }
  }

  async function markReadingDone(code) {
    try {
      await saveReading(code, {});
      renderReading();
      toast('已打卡');
    } catch (error) {
      fail(error);
    }
  }

  function ratingText(value) {
    if (value === 3) return '流利';
    if (value === 2) return '还行';
    if (value === 1) return '再练一次';
    return '';
  }

  function scoreTone(score) {
    if (score >= 90) return 'great';
    if (score >= 80) return 'good';
    if (score >= 65) return 'ok';
    return 'low';
  }

  // The verdict for one sentence: total score, per-dimension bars, the
  // per-word diff (when recognition worked) and the raw transcript, so a
  // child can see exactly which word was dropped.
  function subScoreRow(label, value) {
    return el('div', { class: 'asr-sub' }, [
      el('span', { text: label }),
      el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.max(0, Math.min(100, value)) + '%' })]),
      el('b', { text: String(value) })
    ]);
  }

  function scoreBlock(record) {
    if (!record || !record.asr_score) return null;
    var detail = record.asr_detail || {};
    // Old records stored the diff flat; newer ones nest it under accuracy.
    var accuracy = detail.accuracy || (detail.words ? {
      score: record.asr_score,
      coverage: detail.coverage,
      ok: detail.ok,
      miss: detail.miss,
      extra: detail.extra,
      total: detail.total,
      words: detail.words
    } : null);
    var audio = detail.audio || null;
    var words = accuracy && Array.isArray(accuracy.words) ? accuracy.words : [];

    var subs = [];
    if (accuracy) subs.push(subScoreRow('准确度', accuracy.score));
    if (audio) {
      subs.push(subScoreRow('完整度', audio.complete));
      subs.push(subScoreRow('流利度', audio.fluency));
      subs.push(subScoreRow('响亮度', audio.loudness));
    }

    var metaParts = [];
    if (accuracy) {
      metaParts.push('读对 ' + accuracy.ok + ' / ' + accuracy.total + ' 个词，漏读 ' + accuracy.miss + ' 个');
    }
    if (audio && audio.pauses) metaParts.push('中途停顿 ' + audio.pauses + ' 次');
    if (audio && audio.seconds) metaParts.push('有效朗读 ' + audio.seconds + ' 秒');

    return el('div', { class: 'asr-card ' + scoreTone(record.asr_score) }, [
      el('div', { class: 'asr-head' }, [
        el('span', { class: 'asr-cap', text: '跟读评分' }),
        el('span', { class: 'asr-score', text: String(record.asr_score) }),
        el('span', { class: 'asr-level', text: detail.level || '' })
      ]),
      el('div', { class: 'bar asr-bar' }, [el('i', { style: 'width:' + record.asr_score + '%' })]),
      subs.length ? el('div', { class: 'asr-subs' }, subs) : null,
      metaParts.length
        ? el('p', { class: 'asr-meta', text: metaParts.join(' · ') })
        : null,
      words.length
        ? el('div', { class: 'word-chips' }, words.map(function (word) {
          return el('span', { class: 'wchip ' + word.status, text: word.word });
        }))
        : null,
      record.asr_text ? el('p', { class: 'asr-heard', text: '识别到：' + record.asr_text }) : null,
      accuracy && accuracy.miss
        ? el('p', { class: 'asr-heal', text: '红色是漏读的词，跟着示范把那几个词再读一遍。' })
        : null,
      !accuracy && audio
        ? el('p', { class: 'asr-heal', text: '本机不支持逐词识别，评的是完整度、流利度和响亮度。' })
        : null
    ]);
  }

  function readingCard(item, index) {
    var record = readingLog(item.code);
    var isRecording = state.reading.recording && state.reading.recordingCode === item.code;
    var hasClip = state.reading.clipCode === item.code && !!state.reading.clipUrl;

    var actions = el('div', { class: 'read-actions' }, [
      el('button', {
        class: 'btn ghost',
        type: 'button',
        text: '听示范',
        onclick: function () {
          if (speakEnglish(item.code, item.text_en)) toast('正在朗读示范，跟着读一遍');
        }
      }),
      el('button', {
        class: 'btn' + (isRecording ? ' recording' : ''),
        type: 'button',
        text: isRecording ? '停止录音' : hasClip ? '再录一遍' : '开始朗读',
        onclick: function () {
          if (isRecording) stopRecording();
          else startRecording(item.code);
        }
      }),
      hasClip
        ? el('button', { class: 'btn secondary', type: 'button', text: '听我的', onclick: playClip })
        : null
    ]);

    var ratingRow = el('div', { class: 'rating' }, [
      el('span', { class: 'rating-cap', text: '自评' }),
      el('button', {
        class: 'rating-btn' + (record && record.self_rating === 3 ? ' on' : ''),
        type: 'button',
        text: '流利',
        onclick: function () { rateReading(item.code, 3); }
      }),
      el('button', {
        class: 'rating-btn' + (record && record.self_rating === 2 ? ' on' : ''),
        type: 'button',
        text: '还行',
        onclick: function () { rateReading(item.code, 2); }
      }),
      el('button', {
        class: 'rating-btn' + (record && record.self_rating === 1 ? ' on' : ''),
        type: 'button',
        text: '再练一次',
        onclick: function () { rateReading(item.code, 1); }
      })
    ]);

    var statusText = record
      ? '今天已完成 · 录了 ' + (record.attempts || 1) + ' 次'
        + (record.asr_score ? ' · 评分 ' + record.asr_score + ' 分' : '')
        + (record.self_rating ? ' · 自评「' + ratingText(record.self_rating) + '」' : '')
      : isRecording
        ? '正在录音…读完后点「停止录音」'
        : '先点「听示范」听一遍，再点「开始朗读」录一遍自己的';

    var scoring = state.reading.scoring === item.code;

    return el('div', { class: 'card read-card' + (record ? ' done' : '') }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: 'read-no', text: String(index) }),
        el('h3', { class: 'card-title', text: item.unit_name || '英语跟读' }),
        record ? el('span', { class: 'tag mastered', text: '已完成' }) : null
      ]),
      el('p', { class: 'sentence-en', text: item.text_en }),
      el('p', { class: 'sentence-zh', text: item.text_zh }),
      item.tip ? el('p', { class: 'read-tip', text: '发音要点：' + item.tip }) : null,
      isRecording ? el('div', { class: 'rec-hint' }, [el('i'), document.createTextNode('正在录音，读完点「停止录音」')]) : null,
      scoring && !isRecording ? el('div', { class: 'rec-hint' }, [el('i'), document.createTextNode('正在分析这段录音，稍等一下…')]) : null,
      actions,
      scoreBlock(record),
      ratingRow,
      el('p', { class: 'read-status', text: statusText }),
      !asrSupported()
        ? el('p', {
          class: 'read-status',
          text: '每段录音都会自动打分（完整度 / 流利度 / 响亮度）。逐词准确度评分需要 Chrome 或 Safari 的语音识别，本机自动跳过。'
        })
        : null,
      !recorderSupported()
        ? el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn secondary',
            type: 'button',
            text: '今天读过了',
            onclick: function () { markReadingDone(item.code); }
          })
        ])
        : null
    ]);
  }

  function renderReading() {
    // A late async callback (e.g. the recording stop handler) must never
    // repaint the page after the user has already left this tab.
    if (state.tab !== 'reading') return;
    var page = $('#main-page');
    clear(page);

    if (!state.reading.sentences.length) {
      page.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '跟读素材还没有加载出来' }),
          el('div', { text: '退出后重新进入看看' })
        ])
      );
      return;
    }

    var today = todaySentences();
    var doneCount = today.filter(function (item) { return !!readingLog(item.code); }).length;
    var percent = today.length ? Math.round((doneCount / today.length) * 100) : 0;
    var totals = readingTotals();

    page.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { class: 'card-title', text: '今日跟读' }),
          el('span', { class: 'card-meta', text: doneCount + ' / ' + today.length + ' 句' })
        ]),
        el('div', { class: 'bar' }, [el('i', { style: 'width:' + percent + '%' })]),
        el('div', { class: 'read-stats four' }, [
          el('div', { class: 'read-stat' }, [
            el('b', { text: String(readingStreak()) }),
            el('span', { text: '连续打卡 · 天' })
          ]),
          el('div', { class: 'read-stat' }, [
            el('b', { text: String(totals.attempts) }),
            el('span', { text: '累计朗读 · 次' })
          ]),
          el('div', { class: 'read-stat' }, [
            el('b', { text: totals.scored ? String(totals.avg) : '—' }),
            el('span', { text: '平均得分' })
          ]),
          el('div', { class: 'read-stat' }, [
            el('b', { text: totals.scored ? String(totals.best) : '—' }),
            el('span', { text: '最高得分' })
          ])
        ]),
        el('p', {
          class: 'card-summary',
          text: asrSupported()
            ? '每天 3 句，句子按日期轮转。流程：听示范 → 录自己 → 自动评分（准确度 + 完整度 / 流利度 / 响亮度）→ 听回放对比 → 打卡。'
            : '每天 3 句，句子按日期轮转。流程：听示范 → 录自己 → 录音自动评分（完整度 / 流利度 / 响亮度）→ 听回放对比 → 打卡。'
        })
      ])
    );

    if (doneCount === today.length) {
      page.appendChild(
        el('div', { class: 'card read-done-card' }, [
          el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '今天的跟读完成了' })]),
          el('p', { class: 'card-summary', text: '连续打卡 ' + readingStreak() + ' 天。明天会有新的 3 句。' })
        ])
      );
    }

    today.forEach(function (item, i) {
      page.appendChild(readingCard(item, i + 1));
    });
  }

  // ---------------- auth ----------------

  function setAuthMode(mode) {
    state.authMode = mode;
    state.authPending = null;
    $$('#auth-tabs button').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-mode') === mode);
    });

    var needPassword = mode === 'password' || mode === 'signup' || mode === 'reset';
    var needCode = mode === 'code' || mode === 'signup' || mode === 'reset';
    $('#field-password').style.display = needPassword ? '' : 'none';
    $('#field-code').style.display = needCode ? '' : 'none';
    $$('#auth-tabs button').forEach(function (btn) {
      btn.style.display = mode === 'reset' ? 'none' : '';
    });

    var passwordInput = $('#auth-password');
    var labels = { password: '密码', signup: '设置密码（至少 6 位）', reset: '新密码（至少 6 位）' };
    passwordInput.setAttribute('placeholder', labels[mode] || '密码');
    passwordInput.setAttribute('autocomplete', mode === 'password' ? 'current-password' : 'new-password');

    var submitLabels = { password: '登录', code: '登录', signup: '注册并登录', reset: '重置密码' };
    $('#auth-submit').textContent = submitLabels[mode];

    var hints = {
      password: '家长注册一个邮箱账号即可，孩子用同一个账号在手机上登录。',
      code: '验证码会发到邮箱，没收到就再看一眼垃圾邮件。',
      signup: '注册需要邮箱验证码，密码用于日常登录。',
      reset: '先获取邮箱验证码，再设置新密码。'
    };
    $('#auth-hint').textContent = hints[mode];
    $('#auth-error').classList.remove('show');
  }

  function authError(message) {
    var node = $('#auth-error');
    node.textContent = message;
    node.classList.add('show');
  }

  function startCountdown(button) {
    var left = 60;
    button.disabled = true;
    button.textContent = left + ' 秒后重发';
    clearInterval(state.authTimer);
    state.authTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(state.authTimer);
        button.disabled = false;
        button.textContent = '获取验证码';
        return;
      }
      button.textContent = left + ' 秒后重发';
    }, 1000);
  }

  async function sendCode() {
    var email = $('#auth-email').value.trim();
    if (!email) return authError('请先填写邮箱');
    var button = $('#btn-send-code');
    button.disabled = true;
    try {
      var data = await API.auth.sendCode(email);
      state.authPending = {
        email: email,
        verificationId: data.verificationId,
        isExistingUser: !!data.isExistingUser
      };
      startCountdown(button);
    } catch (error) {
      button.disabled = false;
      authError(API.describeError(error));
    }
  }

  async function submitAuth(event) {
    if (event) event.preventDefault();
    var mode = state.authMode;
    var email = $('#auth-email').value.trim();
    var password = $('#auth-password').value;
    var code = $('#auth-code').value.trim();
    var button = $('#auth-submit');
    $('#auth-error').classList.remove('show');

    if (!email) return authError('请填写邮箱');

    button.disabled = true;
    var original = button.textContent;
    button.innerHTML = '<span class="spinner"></span>处理中';

    try {
      if (mode === 'password') {
        if (!password) throw new Error('请填写密码');
        await API.auth.signInPassword(email, password);
        await afterSignIn();
      } else if (mode === 'code') {
        if (!code) throw new Error('请填写验证码');
        if (!state.authPending || state.authPending.email !== email) {
          throw new Error('请先获取当前邮箱的验证码');
        }
        await API.auth.verifyCode(state.authPending, code);
        await afterSignIn();
      } else if (mode === 'signup') {
        if (!code) throw new Error('请填写验证码');
        if (!password || password.length < 6) throw new Error('密码至少 6 位');
        if (!state.authPending || state.authPending.email !== email) {
          throw new Error('请先获取当前邮箱的验证码');
        }
        if (state.authPending.isExistingUser) {
          setAuthMode('password');
          throw new Error('请改用登录方式继续');
        }
        await API.auth.verifyCode(state.authPending, code, password);
        await afterSignIn();
      } else if (mode === 'reset') {
        if (!code) throw new Error('请填写验证码');
        if (!password || password.length < 6) throw new Error('新密码至少 6 位');
        if (!state.authPending || state.authPending.email !== email) {
          throw new Error('请先获取当前邮箱的验证码');
        }
        var challenge = await API.auth.startReset(email);
        await API.auth.finishReset(challenge, code, password);
        await afterSignIn();
      }
      state.authPending = null;
    } catch (error) {
      authError(API.describeError(error) === '操作失败，请重试'
        ? (error.message || '操作失败，请重试')
        : API.describeError(error));
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function afterSignIn() {
    state.session = await API.auth.current();
    await loadData();
    showScreen('main');
    switchTab('today');
  }

  async function loadData() {
    if (state.session && state.session.user) {
      try {
        state.member = await API.member.join(state.session.user.id, null);
      } catch (error) {
        if (window.console) console.error(error);
      }
    }
    state.isAdmin = !!(state.member && (state.member.role === 'owner' || state.member.role === 'admin'));

    state.student = await API.student.ensure();

    var base = await Promise.all([
      API.textbook.listCatalog(),
      API.profile.list(),
      API.study.listKnowledge()
    ]);
    state.catalog = base[0] || [];
    state.mySubjects = base[1] || [];
    state.knowledge = base[2] || [];

    var tasks = [
      state.student ? API.study.listMastery(state.student.id) : Promise.resolve([]),
      state.student ? API.study.listWrongBook(state.student.id) : Promise.resolve([]),
      state.student ? API.myQuestion.list(state.student.id) : Promise.resolve([]),
      state.student ? API.analytics.listLogs(state.student.id, 3000) : Promise.resolve([]),
      state.student ? API.activity.list(state.student.id, 200) : Promise.resolve([]),
      API.member.list()
    ];
    // Optional data must never block the core study loop.
    var settled = await Promise.all(tasks.map(function (task) {
      return task.catch(function (error) {
        if (window.console && error) console.error(error);
        return [];
      });
    }));

    state.mastery = {};
    (settled[0] || []).forEach(function (record) { state.mastery[record.knowledge_code] = record; });
    state.wrongList = settled[1] || [];
    state.myQuestions = settled[2] || [];
    state.practiceLogs = settled[3] || [];
    state.activities = settled[4] || [];
    state.members = settled[5] || [];

    if (state.student) {
      try {
        var readingResults = await Promise.all([
          API.reading.listSentences(),
          API.reading.listLogs(state.student.id)
        ]);
        state.reading.sentences = readingResults[0] || [];
        state.reading.logs = readingResults[1] || [];
      } catch (error) {
        if (window.console && error) console.error(error);
      }
    }
  }

  // ---------------- boot ----------------

  function bindEvents() {
    $$('#auth-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () { setAuthMode(btn.getAttribute('data-mode')); });
    });
    $('#auth-form').addEventListener('submit', submitAuth);
    $('#btn-send-code').addEventListener('click', sendCode);
    $('#btn-forgot').addEventListener('click', function () { setAuthMode('reset'); });
    $$('#tabbar button').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    $('#btn-me').addEventListener('click', function () { pushSub('me'); });
    $('#sub-back').addEventListener('click', popSub);
    $('#learn-back').addEventListener('click', function () {
      var wasReview = state.learn && state.learn.mode === 'review';
      state.learn = null;
      showScreen('main');
      if (!wasReview) {
        switchTab(state.tab);
        return;
      }
      // A review run just wrote fresh results: refresh them and land on the board.
      switchTab('board');
      API.analytics.listLogs(state.student.id, 3000)
        .then(function (list) {
          state.practiceLogs = list || [];
          if (state.tab === 'board') renderBoard();
        })
        .catch(function () {});
    });
  }

  async function boot() {
    bindEvents();
    setAuthMode('password');
    try {
      var session = await API.auth.current();
      if (!session) {
        showScreen('auth');
        return;
      }
      state.session = session;
      await loadData();
      showScreen('main');
      switchTab('today');
    } catch (error) {
      showScreen('auth');
      if (error) console.error(error);
    }
  }

  API.auth.onChange(function (event, session) {
    if (event === 'SIGNED_OUT') {
      state.session = null;
      showScreen('auth');
    }
  });

  // Narrow handle for automated rendering tests and console diagnostics only.
  window.__app = {
    state: state,
    open: pushSub,
    rerender: function () { renderSub(); },
    // Dev-only hooks used by the stub render tests (no cloud access).
    renderMap: renderMap,
    renderReading: renderReading,
    renderLearn: renderLearn,
    switchTab: switchTab,
    scoreReading: scoreReading,
    analyzeClip: analyzeClip,
    combineResult: combineResult,
    scoreBlock: scoreBlock
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
