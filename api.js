// Cloud service access layer.
// Wraps auth / database / llm into a small promise-based API used by the UI.
window.API = (function () {
  var cfg = window.PUBLIC_CONFIG || {};

  // 离线预览兜底：SDK 由 index.html 从 CDN 加载；取不到时用空实现顶上，
  // 保证页面能启动到登录界面，云端调用给出明确提示而不是整页崩掉。
  // 完整云端功能仍依赖 SDK 正常加载 + config.js 里的云端配置。
  function offlineFailure() {
    return new Error('离线预览模式：云端 SDK 未加载。请检查网络，或改用 /_sub_test/ 测试桩查看完整 UI');
  }
  function createOfflineCloud() {
    var query = {};
    ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike',
      'order', 'limit', 'offset', 'update', 'insert', 'upsert', 'delete',
      'single', 'maybeSingle', 'or', 'not', 'contains'].forEach(function (name) {
      query[name] = function () { return query; };
    });
    query.then = function (resolve, reject) { reject(offlineFailure()); };
    return {
      auth: {
        getSession: async function () { return { data: null }; },
        onAuthStateChange: function () { return function () {}; },
        signInWithPassword: async function () { throw offlineFailure(); },
        sendOtp: async function () { throw offlineFailure(); },
        verifyOtp: async function () { throw offlineFailure(); },
        resetPasswordForEmail: async function () { throw offlineFailure(); },
        resetPasswordForOld: async function () { throw offlineFailure(); },
        signOut: async function () { throw offlineFailure(); }
      },
      database: { from: function () { return query; } },
      llm: {
        models: { list: async function () { throw offlineFailure(); } },
        chat: { completions: { create: async function* () { throw offlineFailure(); } } }
      },
      storage: {
        userPath: function () { throw offlineFailure(); },
        upload: async function () { throw offlineFailure(); },
        createSignedUrl: async function () { throw offlineFailure(); }
      }
    };
  }

  var SDK = window.WorkBuddyCloud;
  var cloud;
  if (SDK && typeof SDK.createWorkBuddyCloud === 'function') {
    cloud = SDK.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey
    });
    window.__CLOUD_SDK_OFFLINE__ = false;
  } else {
    cloud = createOfflineCloud();
    window.__CLOUD_SDK_OFFLINE__ = true;
    console.warn('[全科导学] 云端 SDK 未加载，进入离线预览模式：UI 可用，云端功能不可用');
  }

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  function rows(res) {
    var data = unwrap(res);
    return Array.isArray(data) ? data : [];
  }

  // Turns a backend error into something a parent can act on.
  function describeError(err) {
    if (!err) return '操作失败，请重试';
    var code = err.code || (err.error && err.error.code) || '';
    if (code === '42501') return '没有权限执行该操作';
    if (code === '42P01') return '数据表不存在';
    if (code === '23505') return '记录已存在';
    if (code === '23503') return '关联数据不存在';
    if (code.indexOf('quota_') === 0) return '今日额度已用完，请稍后再试';
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '服务暂时不可用，请稍后重试';
    if (code === 'gateway_stream_interrupted') return '生成中断，请重试';
    if (err.kind === 'unauthenticated' || err.kind === 'invalid_grant') return '登录状态已失效，请重新登录';
    if (err.kind === 'network') return '网络连接失败，请检查网络';
    if (err.kind === 'backend-unavailable') return '服务暂时不可用，请稍后重试';
    return err.message || '操作失败，请重试';
  }

  // ---------------- auth ----------------

  var auth = {
    current: async function () {
      var res = await cloud.auth.getSession();
      if (!res || res.error || !res.data) return null;
      return res.data;
    },

    signInPassword: async function (email, password) {
      var res = await cloud.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      return res.data;
    },

    sendCode: async function (email) {
      var res = await cloud.auth.sendOtp({ email: email });
      if (res.error) throw res.error;
      return res.data; // { verificationId, isExistingUser }
    },

    verifyCode: async function (pending, token, password) {
      var payload = {
        email: pending.email,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: token
      };
      if (!pending.isExistingUser && password) payload.password = password;
      var res = await cloud.auth.verifyOtp(payload);
      if (res.error) throw res.error;
      return res.data;
    },

    startReset: async function (email) {
      var res = await cloud.auth.resetPasswordForEmail(email);
      if (res.error) throw res.error;
      return res.data; // { updateUser }
    },

    finishReset: async function (challenge, nonce, password) {
      var res = await challenge.updateUser({ nonce: nonce, password: password });
      if (res.error) throw res.error;
      return res.data;
    },

    changePassword: async function (oldPassword, newPassword) {
      var res = await cloud.auth.resetPasswordForOld({
        oldPassword: oldPassword,
        newPassword: newPassword
      });
      if (res.error) throw res.error;
      return res.data;
    },

    signOut: async function () {
      await cloud.auth.signOut();
    },

    onChange: function (cb) {
      return cloud.auth.onAuthStateChange(cb);
    }
  };

  // ---------------- student profile ----------------

  var student = {
    // One account owns one study profile. Created on first login.
    ensure: async function (name) {
      var list = rows(await cloud.database.from('ee_student').select('*').eq('is_active', true).limit(1));
      if (list.length) return list[0];
      var created = rows(
        await cloud.database
          .from('ee_student')
          .insert({ student_name: name || '我的孩子', grade: '六年级' })
          .select()
      );
      return created[0] || null;
    },

    rename: async function (id, name) {
      var updated = rows(
        await cloud.database.from('ee_student').update({ student_name: name }).eq('id', id).select()
      );
      if (!updated.length) throw new Error('没有找到要修改的档案');
      return updated[0];
    }
  };

  // ---------------- knowledge + mastery ----------------

  // Wrong answers are filed by (knowledge point + stem) so redoing the same
  // question bumps the counter instead of duplicating the entry.
  async function fileWrong(entry, now) {
    var existing = rows(
      await cloud.database
        .from('ee_wrong_book')
        .select('*')
        .eq('student_id', entry.studentId)
        .eq('stem', entry.stem)
        .limit(1)
    )[0];

    if (existing) {
      await cloud.database
        .from('ee_wrong_book')
        .update({
          wrong_count: (existing.wrong_count || 1) + 1,
          user_answer: entry.userAnswer,
          resolved: false,
          updated_at: now
        })
        .eq('id', existing.id)
        .select();
      return existing.id;
    }

    var created = rows(
      await cloud.database
        .from('ee_wrong_book')
        .insert({
          student_id: entry.studentId,
          knowledge_code: entry.knowledgeCode || null,
          subject: entry.subject || null,
          stem: entry.stem,
          options: entry.options || null,
          user_answer: entry.userAnswer,
          correct_answer: entry.correctAnswer,
          analysis: entry.analysis || null,
          wrong_reason: entry.wrongReason || null,
          image_path: entry.imagePath || null,
          source: entry.source === 'import' ? 'import' : entry.source === 'bank' ? 'bank' : 'practice'
        })
        .select()
    );
    return created[0] ? created[0].id : null;
  }

  var study = {
    listKnowledge: async function () {
      return rows(
        await cloud.database
          .from('ee_knowledge')
          .select('code, subject, textbook, textbook_code, term, chapter, unit_name, name, summary, difficulty, order_no')
          .order('order_no', { ascending: true })
      );
    },

    listMastery: async function (studentId) {
      return rows(
        await cloud.database.from('ee_mastery').select('*').eq('student_id', studentId)
      );
    },

    listWrongBook: async function (studentId) {
      return rows(
        await cloud.database
          .from('ee_wrong_book')
          .select('*')
          .eq('student_id', studentId)
          .eq('resolved', false)
          .order('updated_at', { ascending: false })
          .limit(200)
      );
    },

    listRecentLogs: async function (studentId, limit) {
      return rows(
        await cloud.database
          .from('ee_practice_log')
          .select('*')
          .eq('student_id', studentId)
          .order('created_at', { ascending: false })
          .limit(limit || 100)
      );
    },

    // Writes the practice result and folds it back into the mastery record.
    // This is the data loop that makes already-mastered knowledge disappear
    // from the next study plan.
    record: async function (entry) {
      var now = new Date().toISOString();

      await cloud.database.from('ee_practice_log').insert({
        student_id: entry.studentId,
        knowledge_code: entry.knowledgeCode,
        subject: entry.subject || null,
        textbook_code: entry.textbookCode || null,
        qtype: entry.qtype || 'choice',
        stem: entry.stem,
        user_answer: entry.userAnswer,
        correct_answer: entry.correctAnswer,
        is_correct: entry.isCorrect,
        source: entry.source || 'practice'
      });

      if (entry.skipMastery) {
        // A question with no knowledge point still belongs in the log and the
        // wrong book, but inventing a mastery record for it would pollute the
        // knowledge graph.
        if (!entry.isCorrect) await fileWrong(entry, now);
        return { status: '', level: 0, correctCount: 0, totalCount: 0, skipped: true };
      }

      var current = rows(
        await cloud.database
          .from('ee_mastery')
          .select('*')
          .eq('student_id', entry.studentId)
          .eq('knowledge_code', entry.knowledgeCode)
          .limit(1)
      )[0];

      var correctCount = (current ? current.correct_count || 0 : 0) + (entry.isCorrect ? 1 : 0);
      var totalCount = (current ? current.total_count || 0 : 0) + 1;
      var rate = correctCount / totalCount;

      var status = 'learning';
      var level = 1;
      if (totalCount >= 3 && rate >= 0.8) {
        status = 'mastered';
        level = 3;
      } else if (rate >= 0.6) {
        level = 2;
      }

      var streak = entry.isCorrect ? (current ? current.streak || 0 : 0) + 1 : 0;

      if (!current) {
        await cloud.database.from('ee_mastery').insert({
          student_id: entry.studentId,
          knowledge_code: entry.knowledgeCode,
          subject: entry.subject || null,
          textbook_code: entry.textbookCode || null,
          status: status,
          level: level,
          correct_count: correctCount,
          total_count: totalCount,
          streak: streak,
          last_practice_at: now
        });
      } else {
        var touched = rows(
          await cloud.database
            .from('ee_mastery')
            .update({
              status: status,
              level: level,
              subject: current.subject || entry.subject || null,
              textbook_code: current.textbook_code || entry.textbookCode || null,
              correct_count: correctCount,
              total_count: totalCount,
              streak: streak,
              last_practice_at: now,
              updated_at: now
            })
            .eq('id', current.id)
            .select()
        );
        if (!touched.length) throw new Error('掌握度更新未生效');
      }

      if (!entry.isCorrect) await fileWrong(entry, now);

      return { status: status, level: level, correctCount: correctCount, totalCount: totalCount };
    },

    // Files an imported question straight into the wrong book without touching
    // mastery — the import flow owns that decision.
    addWrong: async function (entry) {
      return fileWrong(entry, new Date().toISOString());
    },

    resolveWrong: async function (id) {
      var now = new Date().toISOString();
      var touched = rows(
        await cloud.database
          .from('ee_wrong_book')
          .update({ resolved: true, resolved_at: now, updated_at: now })
          .eq('id', id)
          .select()
      );
      if (!touched.length) throw new Error('这条错题没有找到');
    },

    removeWrong: async function (id) {
      var removed = rows(await cloud.database.from('ee_wrong_book').delete().eq('id', id).select());
      if (!removed.length) throw new Error('这条错题没有找到');
    }
  };

  // ---------------- daily reading (English shadowing) ----------------

  var reading = {
    listSentences: async function () {
      return rows(
        await cloud.database
          .from('ee_reading_sentence')
          .select('code, knowledge_code, unit_name, text_en, text_zh, tip, difficulty, order_no')
          .order('order_no', { ascending: true })
      );
    },

    // All reading records for this learner, newest first. Used for both the
    // daily checklist and the streak calculation.
    listLogs: async function (studentId, limit) {
      return rows(
        await cloud.database
          .from('ee_reading_log')
          .select('*')
          .eq('student_id', studentId)
          .order('read_date', { ascending: false })
          .limit(limit || 400)
      );
    },

    // One row per sentence per day: reading the same sentence again only
    // bumps the counter instead of creating duplicates.
    saveAttempt: async function (entry) {
      var now = new Date().toISOString();
      var existing = rows(
        await cloud.database
          .from('ee_reading_log')
          .select('*')
          .eq('student_id', entry.studentId)
          .eq('sentence_code', entry.sentenceCode)
          .eq('read_date', entry.readDate)
          .limit(1)
      )[0];

      var attempts = (existing ? existing.attempts || 0 : 0) + (entry.countAttempt === false ? 0 : 1);
      var listenCount = (existing ? existing.listen_count || 0 : 0) + (entry.listenCount || 0);
      var rating = entry.rating || (existing ? existing.self_rating || 0 : 0);
      // System scoring: keep the last recognised text and score, but never let
      // a silent attempt wipe a good score taken earlier the same day.
      var asrText = entry.asrText || (existing ? existing.asr_text : null) || null;
      var asrScore = entry.asrScore !== undefined && entry.asrScore !== null
        ? entry.asrScore
        : (existing ? existing.asr_score : null) || null;
      var asrDetail = entry.asrDetail !== undefined && entry.asrDetail !== null
        ? entry.asrDetail
        : (existing ? existing.asr_detail : null) || null;

      if (!existing) {
        var created = rows(
          await cloud.database
            .from('ee_reading_log')
            .insert({
              student_id: entry.studentId,
              sentence_code: entry.sentenceCode,
              read_date: entry.readDate,
              attempts: attempts || 1,
              listen_count: listenCount,
              duration_ms: entry.durationMs || null,
              self_rating: rating,
              asr_text: asrText,
              asr_score: asrScore,
              asr_detail: asrDetail
            })
            .select()
        );
        return created[0] || null;
      }

      var updated = rows(
        await cloud.database
          .from('ee_reading_log')
          .update({
            attempts: attempts || 1,
            listen_count: listenCount,
            duration_ms: entry.durationMs || existing.duration_ms || null,
            self_rating: rating,
            asr_text: asrText,
            asr_score: asrScore,
            asr_detail: asrDetail,
            updated_at: now
          })
          .eq('id', existing.id)
          .select()
      );
      if (!updated.length) throw new Error('打卡记录没有保存成功');
      return updated[0];
    }
  };

  // ---------------- textbook catalog ----------------

  var textbook = {
    listCatalog: async function () {
      return rows(
        await cloud.database.from('ee_textbook').select('*').order('sort_no', { ascending: true })
      );
    },

    setActive: async function (code, active) {
      var updated = rows(
        await cloud.database.from('ee_textbook').update({ is_active: active }).eq('code', code).select()
      );
      if (!updated.length) throw new Error('没有找到这个教材版本');
      return updated[0];
    },

    add: async function (entry) {
      var created = rows(
        await cloud.database
          .from('ee_textbook')
          .insert({
            code: entry.code,
            subject: entry.subject,
            name: entry.name,
            publisher: entry.publisher || null,
            grade_scope: entry.gradeScope || '六年级',
            builtin: false,
            is_active: true,
            sort_no: entry.sortNo || 90
          })
          .select()
      );
      return created[0] || null;
    }
  };

  // ---------------- accounts and roles ----------------

  var member = {
    // Every account enrols itself once. The database trigger promotes the
    // very first account to owner, so no client can hand out admin rights.
    join: async function (userId, displayName) {
      var now = new Date().toISOString();
      var mine = rows(
        await cloud.database.from('ee_member').select('*').eq('user_id', userId).limit(1)
      );
      if (mine.length) {
        await cloud.database
          .from('ee_member')
          .update({ last_seen_at: now, display_name: displayName || mine[0].display_name })
          .eq('user_id', userId)
          .select();
        return mine[0];
      }
      var created = rows(
        await cloud.database
          .from('ee_member')
          .insert({ user_id: userId, display_name: displayName || '新成员' })
          .select()
      );
      return created[0] || null;
    },

    list: async function () {
      return rows(
        await cloud.database
          .from('ee_member')
          .select('user_id, display_name, role, joined_at, last_seen_at')
          .order('joined_at', { ascending: true })
      );
    },

    rename: async function (userId, displayName) {
      await cloud.database
        .from('ee_member')
        .update({ display_name: displayName })
        .eq('user_id', userId)
        .select();
    },

    setRole: async function (userId, role) {
      var updated = rows(
        await cloud.database.from('ee_member').update({ role: role }).eq('user_id', userId).select()
      );
      if (!updated.length) throw new Error('没有权限修改这个账号');
      return updated[0];
    }
  };

  // ---------------- per-account subject selection ----------------

  var profile = {
    list: async function () {
      return rows(
        await cloud.database.from('ee_profile_subject').select('*').order('sort_no', { ascending: true })
      );
    },

    // Rows are created lazily. An account that never opened the settings page
    // has no rows at all, and the UI then treats every catalog offer as enabled.
    save: async function (items) {
      var existing = await profile.list();
      var byKey = {};
      existing.forEach(function (row) { byKey[row.subject + '|' + row.textbook_code] = row; });
      var now = new Date().toISOString();

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var row = byKey[item.subject + '|' + item.textbookCode];
        if (row) {
          if (!!row.enabled !== !!item.enabled || (row.sort_no || 0) !== i) {
            await cloud.database
              .from('ee_profile_subject')
              .update({ enabled: !!item.enabled, sort_no: i, updated_at: now })
              .eq('id', row.id)
              .select();
          }
        } else {
          await cloud.database
            .from('ee_profile_subject')
            .insert({
              subject: item.subject,
              textbook_code: item.textbookCode,
              enabled: !!item.enabled,
              sort_no: i
            })
            .select();
        }
      }
      return profile.list();
    }
  };

  // ---------------- imported question bank (wrong questions + analysis) ----------------

  function questionPayload(studentId, item) {
    var payload = {
      student_id: studentId,
      subject: item.subject || null,
      textbook_code: item.textbookCode || null,
      knowledge_code: item.knowledgeCode || null,
      knowledge_name: item.knowledgeName || null,
      qtype: item.qtype || 'choice',
      stem: item.stem,
      options: item.options || null,
      answer: item.answer || null,
      analysis: item.analysis || null,
      wrong_reason: item.wrongReason || null,
      image_path: item.imagePath || null,
      source: item.source || 'import'
    };
    return payload;
  }

  var myQuestion = {
    list: async function (studentId) {
      return rows(
        await cloud.database
          .from('ee_my_question')
          .select('*')
          .eq('student_id', studentId)
          .order('created_at', { ascending: false })
          .limit(500)
      );
    },

    // Sequential on purpose: a partial bulk failure would leave the caller
    // without a usable per-row error, and imports are low frequency.
    insertBatch: async function (studentId, items) {
      var out = [];
      for (var i = 0; i < items.length; i++) {
        if (!items[i].stem) continue;
        var created = rows(
          await cloud.database
            .from('ee_my_question')
            .insert(questionPayload(studentId, items[i]))
            .select()
        );
        if (created[0]) out.push(created[0]);
      }
      return out;
    },

    update: async function (id, patch) {
      var body = Object.assign({ updated_at: new Date().toISOString() }, patch);
      var updated = rows(
        await cloud.database.from('ee_my_question').update(body).eq('id', id).select()
      );
      if (!updated.length) throw new Error('没有找到这道题');
      return updated[0];
    },

    remove: async function (id) {
      var removed = rows(await cloud.database.from('ee_my_question').delete().eq('id', id).select());
      if (!removed.length) throw new Error('没有找到这道题');
    }
  };

  // ---------------- activity feed ----------------

  var activity = {
    log: async function (entry) {
      var payload = {
        student_id: entry.studentId,
        kind: entry.kind,
        subject: entry.subject || null,
        knowledge_code: entry.knowledgeCode || null,
        title: entry.title || null,
        detail: entry.detail || null,
        minutes: entry.minutes || 0
      };
      if (entry.date) payload.occurred_on = entry.date;
      try {
        return rows(await cloud.database.from('ee_activity').insert(payload).select());
      } catch (error) {
        // The study loop must never fail because a log line failed.
        if (window.console) console.error(error);
        return [];
      }
    },

    list: async function (studentId, limit) {
      return rows(
        await cloud.database
          .from('ee_activity')
          .select('*')
          .eq('student_id', studentId)
          .order('occurred_on', { ascending: false })
          .limit(limit || 300)
      );
    }
  };

  // ---------------- learning analytics ----------------

  var analytics = {
    // Raw practice history. Every dashboard number is recomputed from these
    // rows, so the timeline can never drift from the mastery table.
    listLogs: async function (studentId, limit) {
      return rows(
        await cloud.database
          .from('ee_practice_log')
          .select('knowledge_code, subject, is_correct, created_at, source')
          .eq('student_id', studentId)
          .order('created_at', { ascending: false })
          .limit(limit || 3000)
      );
    }
  };

  // ---------------- image understanding ----------------

  var vision = {
    PREFERRED: ['glm-4.6v', 'deepseek-v4.1-flash', 'glm-5v-turbo', 'glm-5.3-flash', 'space-bunny'],

    SYSTEM: '你是一位小学教师的助教，负责把家长拍的错题照片转成结构化数据。'
      + '严格只输出一个 JSON 对象，不要输出解释、不要用代码块包裹。',

    INSTRUCTION: '请识别这张照片里的题目，判断学科，并输出 JSON：'
      + '{"subject":"语文|数学|英语|奥数|信息学","knowledge":"最贴切的知识点名（若无法判断填空字符串）",'
      + '"items":[{"stem":"完整题干，数学公式用普通文本写出","options":["A选项","B选项"],'
      + '"answer":"标准答案，照片里没有就根据题目自行算出","analysis":"简明易懂的解题讲解，两三句话，讲给孩子听",'
      + '"wrong_reason":"结合孩子卷面上的笔迹推测的错因，没有就填空字符串"}]}。'
      + '如果照片里有多道题，全部放进 items。如果照片糊到无法辨认，输出 {"subject":"","knowledge":"","items":[]}。',

    model: async function () {
      if (vision._model) return vision._model;
      var models = await cloud.llm.models.list();
      var usable = (models || []).filter(function (m) {
        return m.disabled !== true && m.supportsImages !== false;
      });
      if (!usable.length) throw new Error('当前没有可用的识图模型');
      var picked = null;
      for (var p = 0; p < vision.PREFERRED.length && !picked; p++) {
        for (var i = 0; i < usable.length; i++) {
          if (usable[i].id === vision.PREFERRED[p]) { picked = usable[i]; break; }
        }
      }
      if (!picked) picked = usable[0];
      vision._model = picked;
      return picked;
    },

    // dataUrl must be a compressed JPEG data URL — phone originals are far too
    // large to send through the gateway.
    extract: async function (dataUrl, options) {
      options = options || {};
      var model = await vision.model();
      var payload = {
        model: model.id,
        messages: [
          { role: 'system', content: vision.SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: vision.INSTRUCTION },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        stream: true,
        temperature: 0.2,
        response_format: { type: 'json_object' }
      };

      var text = '';
      var gotFirst = false;
      var timedOut = false;
      var timer = null;
      if (typeof AbortController !== 'undefined') {
        var controller = new AbortController();
        payload.signal = controller.signal;
        timer = setTimeout(function () {
          if (!gotFirst) { timedOut = true; controller.abort(); }
        }, options.firstTokenTimeout || 90000);
      }

      try {
        var iterator = cloud.llm.chat.completions.create(payload);
        for await (var chunk of iterator) {
          var choice = chunk.choices && chunk.choices[0];
          var delta = choice && choice.delta;
          if (delta && delta.reasoning_content && options.onThinking) options.onThinking();
          if (delta && delta.content) {
            if (!gotFirst) { gotFirst = true; if (timer) clearTimeout(timer); }
            text += delta.content;
          }
        }
      } catch (error) {
        if (timedOut && !gotFirst) throw new Error('识别超时，请把照片裁小一点再试');
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return text;
    }
  };

  // ---------------- llm ----------------

  var llm = {
    _model: null,

    // Reasoning ("thinking") models can spend minutes emitting only
    // reasoning_content before any visible text. A kid should not stare at
    // a silent spinner, so prefer fast non-thinking models explicitly.
    PREFERRED: ['hunyuan-chat', 'default'],

    model: async function () {
      if (llm._model) return llm._model;
      var models = await cloud.llm.models.list();
      if (!models || !models.length) throw new Error('当前没有可用的 AI 模型');
      var available = models.filter(function (m) { return m.disabled !== true; });
      if (!available.length) throw new Error('当前没有可用的 AI 模型');

      var picked = null;
      var i;
      for (var p = 0; p < llm.PREFERRED.length && !picked; p++) {
        for (i = 0; i < available.length; i++) {
          if (available[i].id === llm.PREFERRED[p]) { picked = available[i]; break; }
        }
      }
      if (!picked) {
        for (i = 0; i < available.length; i++) {
          if (available[i].onlyReasoning !== true) { picked = available[i]; break; }
        }
      }
      if (!picked) picked = available[0];
      llm._model = picked;
      return picked;
    },

    // Streaming chat with a mandatory application-owned system message.
    // options.onReasoning surfaces the model's silent thinking phase so the
    // UI can show progress; options.firstTokenTimeout aborts a hung call
    // instead of waiting forever with no feedback.
    stream: async function (systemPrompt, userPrompt, onDelta, options) {
      options = options || {};
      var model = await llm.model();
      var payload = {
        model: model.id,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        temperature: options.temperature !== undefined ? options.temperature : 0.7
      };
      if (options.json) payload.response_format = { type: 'json_object' };

      var text = '';
      var gotFirst = false;
      var timedOut = false;
      var timer = null;
      if (typeof AbortController !== 'undefined') {
        var controller = new AbortController();
        payload.signal = controller.signal;
        timer = setTimeout(function () {
          if (!gotFirst) {
            timedOut = true;
            controller.abort();
          }
        }, options.firstTokenTimeout || 60000);
      }

      try {
        var iterator = cloud.llm.chat.completions.create(payload);
        for await (var chunk of iterator) {
          var choice = chunk.choices && chunk.choices[0];
          var delta = choice && choice.delta;
          if (delta && delta.reasoning_content && options.onReasoning) {
            options.onReasoning(delta.reasoning_content);
          }
          if (delta && delta.content) {
            if (!gotFirst) {
              gotFirst = true;
              if (timer) clearTimeout(timer);
            }
            text += delta.content;
            if (onDelta) onDelta(delta.content);
          }
        }
      } catch (err) {
        if (timedOut && !gotFirst) {
          throw new Error('AI 老师长时间没有响应，请返回重试一次');
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return text;
    }
  };

  // ---------------- runtime files (wrong-question photos) ----------------

  var files = {
    // Photos live under the signed-in user's own prefix, so the storage rules
    // scope them to that account without any extra work in the UI.
    upload: async function (userId, body, contentType, name) {
      var path = cloud.storage.userPath(userId, 'wrong/' + name);
      var uploaded = await cloud.storage.upload(path, body, {
        contentType: contentType || 'image/jpeg',
        cacheControl: '3600'
      });
      if (uploaded && uploaded.error) throw uploaded.error;
      return (uploaded && uploaded.data && uploaded.data.path) || path;
    },

    signedUrl: async function (path, ttl) {
      var signed = await cloud.storage.createSignedUrl(path, ttl || 3600);
      if (signed && signed.error) throw signed.error;
      return signed && signed.data ? signed.data.signedUrl || signed.data.url : null;
    }
  };

  // ---------------- question bank (imported from ChinaStudyFree) ----------------

  var bank = {
    // Minimal columns only: the UI groups textbooks and units locally, so we
    // never pull the 2200+ full stems just to render the filter card.
    meta: async function () {
      return rows(
        await cloud.database
          .from('ee_bank_question')
          .select('subject, textbook, unit, unit_number')
          .order('textbook', { ascending: true })
      );
    },

    ids: async function (f) {
      var q = cloud.database.from('ee_bank_question').select('id');
      if (f.subject) q = q.eq('subject', f.subject);
      if (f.textbook) q = q.eq('textbook', f.textbook);
      if (f.unit) q = q.eq('unit', f.unit);
      if (f.difficulty) q = q.eq('difficulty', f.difficulty);
      return rows(await q);
    },

    byIds: async function (ids) {
      if (!ids.length) return [];
      return rows(
        await cloud.database.from('ee_bank_question').select('*').in('id', ids)
      );
    }
  };

  // ---------------- rewards (daily tasks / xp / diamonds / shop) ----------------

  var rewards = {
    wallet: async function (studentId) {
      var list = rows(
        await cloud.database.from('ee_wallet').select('*').eq('student_id', studentId).limit(1)
      );
      if (list.length) return list[0];
      var created = rows(
        await cloud.database.from('ee_wallet').insert({ student_id: studentId }).select()
      );
      return created[0] || { student_id: studentId, xp: 0, diamonds: 0 };
    },

    // One row per (student, day, task) — the unique index makes double claims
    // impossible even if the button is pressed twice.
    claimTask: async function (studentId, day, taskCode, diamonds, xp) {
      var created = rows(
        await cloud.database.from('ee_task_log').insert({
          student_id: studentId,
          day: day,
          task_code: taskCode,
          diamonds: diamonds,
          xp: xp
        }).select()
      );
      if (!created.length) throw new Error('任务已领取过');
      var wallet = await rewards.wallet(studentId);
      var touched = rows(
        await cloud.database.from('ee_wallet').update({
          xp: (wallet.xp || 0) + xp,
          diamonds: (wallet.diamonds || 0) + diamonds,
          updated_at: new Date().toISOString()
        }).eq('id', wallet.id).select()
      );
      return { task: created[0], wallet: touched[0] || wallet };
    },

    taskLogs: async function (studentId, day) {
      return rows(
        await cloud.database.from('ee_task_log').select('*')
          .eq('student_id', studentId).eq('day', day)
      );
    },

    listShop: async function () {
      return rows(
        await cloud.database.from('ee_shop_item').select('*')
          .eq('active', true).order('cost', { ascending: true })
      );
    },

    addShopItem: async function (name, emoji, cost) {
      return rows(
        await cloud.database.from('ee_shop_item').insert({ name: name, emoji: emoji, cost: cost }).select()
      );
    },

    removeShopItem: async function (id) {
      await cloud.database.from('ee_shop_item').update({ active: false }).eq('id', id);
    },

    redeems: async function (studentId) {
      return rows(
        await cloud.database.from('ee_redeem_log').select('*')
          .eq('student_id', studentId).order('created_at', { ascending: false }).limit(50)
      );
    },

    // Spend diamonds on a reward: deduct first, then log the wish. If the
    // deduct fails nothing is logged, so diamonds can never go negative.
    redeem: async function (studentId, item) {
      var wallet = await rewards.wallet(studentId);
      if ((wallet.diamonds || 0) < item.cost) throw new Error('钻石不够');
      var touched = rows(
        await cloud.database.from('ee_wallet').update({
          diamonds: (wallet.diamonds || 0) - item.cost,
          updated_at: new Date().toISOString()
        }).eq('id', wallet.id).select()
      );
      var created = rows(
        await cloud.database.from('ee_redeem_log').insert({
          student_id: studentId,
          item_id: item.id,
          item_name: item.name,
          cost: item.cost
        }).select()
      );
      return { wallet: touched[0] || wallet, redeem: created[0] };
    },

    // Parent marks a wish as delivered.
    fulfillRedeem: async function (id) {
      return rows(
        await cloud.database.from('ee_redeem_log').update({
          status: 'done',
          resolved_at: new Date().toISOString()
        }).eq('id', id).select()
      );
    }
  };

  return {
    cloud: cloud,
    auth: auth,
    student: student,
    study: study,
    reading: reading,
    textbook: textbook,
    member: member,
    profile: profile,
    myQuestion: myQuestion,
    activity: activity,
    analytics: analytics,
    vision: vision,
    files: files,
    llm: llm,
    bank: bank,
    rewards: rewards,
    describeError: describeError
  };
})();
