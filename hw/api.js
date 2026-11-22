// 硬件工程师导学系统 —— 数据访问层。
// MVP 版：云端只用于 LLM（讲解/出题），学习进度全部存 localStorage。
window.API = (function () {
  var cfg = window.PUBLIC_CONFIG || {};
  var SDK = window.WorkBuddyCloud;
  var cloud;
  if (SDK && typeof SDK.createWorkBuddyCloud === 'function') {
    cloud = SDK.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey
    });
    window.__CLOUD_SDK_OFFLINE__ = false;
  } else {
    // 本地离线预览：SDK 取不到时学习进度仍走 localStorage，只是 AI 功能不可用。
    window.__CLOUD_SDK_OFFLINE__ = true;
    function offlineFailure() {
      return new Error('离线预览模式：云端 SDK 未加载，AI 讲解/出题暂不可用');
    }
    cloud = {
      llm: {
        models: { list: async function () { throw offlineFailure(); } },
        chat: { completions: { create: async function* () { throw offlineFailure(); } } }
      }
    };
    console.warn('[硬件导学] 云端 SDK 未加载，进入离线预览模式：AI 功能不可用');
  }

  function describeError(err) {
    if (!err) return '操作失败，请重试';
    var code = err.code || (err.error && err.error.code) || '';
    if (code.indexOf('quota_') === 0) return '今日 AI 额度已用完，请稍后再试';
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '服务暂时不可用，请稍后重试';
    if (code === 'gateway_stream_interrupted') return '生成中断，请重试';
    if (err.kind === 'network') return '网络连接失败，请检查网络';
    return err.message || '操作失败，请重试';
  }

  var llm = {
    _model: null,
    PREFERRED: ['hunyuan-chat', 'default'],

    model: async function () {
      if (llm._model) return llm._model;
      var models = await cloud.llm.models.list();
      if (!models || !models.length) throw new Error('当前没有可用的 AI 模型');
      var available = models.filter(function (m) { return m.disabled !== true; });
      if (!available.length) throw new Error('当前没有可用的 AI 模型');
      var picked = null, i;
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

    // 流式对话。options: {onDelta(deltaText), temperature, json, firstTokenTimeout}
    chat: async function (system, user, options) {
      options = options || {};
      var model = await llm.model();
      var payload = {
        model: model.id,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: true,
        temperature: options.temperature != null ? options.temperature : 0.4
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
          if (!gotFirst) { timedOut = true; controller.abort(); }
        }, options.firstTokenTimeout || 90000);
      }
      try {
        var iterator = cloud.llm.chat.completions.create(payload);
        for await (var chunk of iterator) {
          var choice = chunk.choices && chunk.choices[0];
          var delta = choice && choice.delta;
          if (delta && delta.content) {
            if (!gotFirst) { gotFirst = true; if (timer) clearTimeout(timer); }
            text += delta.content;
            if (options.onDelta) options.onDelta(delta.content);
          }
        }
      } catch (error) {
        if (timedOut && !gotFirst) throw new Error('AI 响应超时，请重试');
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return text;
    }
  };

  return { describeError: describeError, llm: llm };
})();
