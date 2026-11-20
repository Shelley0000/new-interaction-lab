/*
 * 圣诞树（v16.4）与创作档案馆的桥接层
 *
 * 这层脚本不改动作品本身的渲染逻辑，只负责：
 *  1. 记录进入 / 离开与体验时长；
 *  2. 把作品里的文字、字体、颜色、粒子密度同步到档案馆；
 *  3. 把上传的照片和音乐镜像进档案馆素材库；
 *  4. 把摄像头手势与界面操作写进交互时间线；
 *  5. 在左侧设置面板里加「保存到档案馆 / 读取档案馆设置」两个按钮。
 */
(function () {
  "use strict";

  const Lab = window.InteractiveLab;
  if (!Lab) return;

  const WORK_ID = "christmas";
  let session = null;
  let lastSavedSignature = "";
  let mirrorTimer = 0;

  function log(type, detail, extra) {
    if (session) session.log(type, detail, extra);
    else Lab.logEvent(WORK_ID, type, detail, extra);
  }

  function getValue(id) {
    const element = document.getElementById(id);
    return element ? element.value : "";
  }

  function getNumber(id, fallback) {
    const value = Number(getValue(id));
    return isFinite(value) && value > 0 ? value : fallback;
  }

  function currentConfig() {
    return {
      line1: getValue("input-line1") || "Merry",
      line2: getValue("input-line2") || "Christmas",
      fontKey: getValue("font-select") || "style1",
      fontSize: getNumber("slider-fontsize", 100),
      color: getValue("color-picker") || "#fceea7",
      treeParticles: getNumber("slider-tree", 1500),
      dustParticles: getNumber("slider-dust", 2500)
    };
  }

  function settingsReady() {
    const line1 = document.getElementById("input-line1");
    const line2 = document.getElementById("input-line2");
    return Boolean(line1 && line2 && line1.value.trim() && line2.value.trim());
  }

  function setValue(id, value) {
    const element = document.getElementById(id);
    if (element && value !== undefined && value !== null) {
      element.value = String(value);
    }
  }

  function applyArchiveConfig(config) {
    setValue("input-line1", config.line1);
    setValue("input-line2", config.line2);
    setValue("font-select", config.fontKey);
    setValue("slider-fontsize", config.fontSize);
    setValue("color-picker", config.color);
    setValue("slider-tree", config.treeParticles);
    setValue("slider-dust", config.dustParticles);

    if (typeof window.updateTextConfig === "function") {
      window.updateTextConfig();
    }

    // 粒子重建需要场景已经初始化好，稍等一下再调用。
    setTimeout(function () {
      if (typeof window.applyParticleSettings === "function") {
        window.applyParticleSettings();
      }
      lastSavedSignature = JSON.stringify(currentConfig());
    }, 350);
  }

  function mirrorConfig(detail) {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async function () {
      if (!settingsReady()) return;

      const config = currentConfig();
      const signature = JSON.stringify(config);
      if (signature === lastSavedSignature) return;

      const saved = await Lab.saveWorkConfig(WORK_ID, config);
      if (saved) {
        lastSavedSignature = signature;
        if (detail) log("config", detail);
      }
    }, 900);
  }

  function guardSidebarHeight() {
    if (document.getElementById("archive-layout-guard")) return;

    const style = document.createElement("style");
    style.id = "archive-layout-guard";
    style.textContent = [
      "#left-sidebar{max-height:calc(100vh - 210px);overflow-y:auto;overflow-x:hidden;padding-right:4px}",
      "#left-sidebar::-webkit-scrollbar{width:4px}",
      "#left-sidebar::-webkit-scrollbar-thumb{background:rgba(212,175,55,.35);border-radius:2px}",
      "#left-sidebar .left-gesture-panel{margin-top:2px}"
    ].join("");
    document.head.appendChild(style);
  }

  function addArchiveButtons() {
    const panel = document.getElementById("top-right-controls");
    if (!panel || document.getElementById("archive-save-btn")) return;

    const saveButton = document.createElement("button");
    saveButton.className = "elegant-btn";
    saveButton.id = "archive-save-btn";
    saveButton.type = "button";
    saveButton.textContent = "⇧ 保存到档案馆";
    saveButton.title = "把当前文字、字体、颜色与粒子密度保存到档案馆，并生成一个版本快照";

    const loadButton = document.createElement("button");
    loadButton.className = "elegant-btn";
    loadButton.id = "archive-load-btn";
    loadButton.type = "button";
    loadButton.textContent = "⇩ 读取档案馆设置";
    loadButton.title = "从创作档案馆读取最近保存的配置";

    panel.appendChild(saveButton);
    panel.appendChild(loadButton);

    guardSidebarHeight();

    function setButtonState(enabled) {
      saveButton.disabled = !enabled;
      loadButton.disabled = !enabled;
      saveButton.style.opacity = enabled ? "1" : ".45";
      loadButton.style.opacity = enabled ? "1" : ".45";
      saveButton.style.cursor = enabled ? "pointer" : "wait";
      loadButton.style.cursor = enabled ? "pointer" : "wait";
    }

    function waitUntilReady() {
      if (settingsReady()) {
        setButtonState(true);
        lastSavedSignature = JSON.stringify(currentConfig());
      } else {
        setButtonState(false);
        setTimeout(waitUntilReady, 500);
      }
    }

    waitUntilReady();

    saveButton.addEventListener("click", async function () {
      if (!settingsReady()) return;

      const config = currentConfig();
      const saved = await Lab.saveWorkConfig(WORK_ID, config, {
        createRevision: true,
        label: "作品内手动保存"
      });
      if (saved) {
        lastSavedSignature = JSON.stringify(config);
        log("config", "手动保存当前设置到档案馆");
        saveButton.textContent = "✓ 已保存";
        setTimeout(function () { saveButton.textContent = "⇧ 保存到档案馆"; }, 1600);
      } else {
        saveButton.textContent = "档案馆暂不可用";
        setTimeout(function () { saveButton.textContent = "⇧ 保存到档案馆"; }, 2000);
      }
    });

    loadButton.addEventListener("click", async function () {
      const config = await Lab.getWorkConfig(WORK_ID);
      if (!config) {
        log("config", "档案馆里还没有配置");
        loadButton.textContent = "暂无档案配置";
        setTimeout(function () { loadButton.textContent = "⇩ 读取档案馆设置"; }, 1800);
        return;
      }

      applyArchiveConfig(config);
      log("config", "从档案馆读取设置");
      loadButton.textContent = "✓ 已读取";
      setTimeout(function () { loadButton.textContent = "⇩ 读取档案馆设置"; }, 1600);
    });
  }

  function bindConfigMirroring() {
    ["input-line1", "input-line2"].forEach(function (id) {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener("input", function () {
          mirrorConfig("标题设置已同步到档案馆");
        });
      }
    });

    ["font-select", "color-picker", "slider-fontsize"].forEach(function (id) {
      const element = document.getElementById(id);
      if (!element) return;
      element.addEventListener("input", function () {
        mirrorConfig("文字样式已同步到档案馆");
      });
      element.addEventListener("change", function () {
        mirrorConfig("文字样式已同步到档案馆");
      });
    });

    ["slider-tree", "slider-dust"].forEach(function (id) {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener("change", function () {
          mirrorConfig("粒子密度已同步到档案馆");
        });
      }
    });

    const applyButton = document.querySelector('button[onclick="applyParticleSettings()"]');
    if (applyButton) {
      applyButton.addEventListener("click", function () {
        setTimeout(function () {
          mirrorConfig("粒子密度已同步到档案馆");
        }, 500);
      });
    }
  }

  function bindAssets() {
    const fileInput = document.getElementById("file-input");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        const files = Array.prototype.slice.call(fileInput.files || []);
        if (!files.length) return;

        Promise.all(files.map(function (file) {
          return Lab.addAsset(WORK_ID, file, { name: file.name, source: "photo" });
        })).then(function (records) {
          const saved = records.filter(Boolean).length;
          if (saved) log("asset", "归档了 " + saved + " 张照片", { count: saved });
        });
      });
    }

    const musicInput = document.getElementById("music-input");
    if (musicInput) {
      musicInput.addEventListener("change", function () {
        const file = musicInput.files && musicInput.files[0];
        if (!file) return;

        Lab.addAsset(WORK_ID, file, { name: file.name, source: "music" }).then(function (record) {
          if (record) log("asset", "归档背景音乐：" + file.name);
        });
      });
    }
  }

  function observeGestures() {
    const hint = document.getElementById("gesture-hint");
    if (!hint) return;

    let lastText = hint.textContent.trim();

    const observer = new MutationObserver(function () {
      const text = hint.textContent.trim();
      if (text === lastText) return;
      lastText = text;

      if (text.indexOf("状态:") === 0) {
        log("gesture", "手势：" + text.replace("状态:", "").replace(/[（）()]/g, "").trim());
      } else if (text === "手势识别就绪") {
        log("setting", "手势识别已就绪");
      } else if (text === "Camera Access Denied") {
        log("setting", "摄像头权限被拒绝");
      } else if (text === "AI Failed") {
        log("setting", "手势模型加载失败");
      }
    });

    observer.observe(hint, { childList: true, characterData: true, subtree: true });
  }

  function bindUiEvents() {
    [
      ["toggle-ui-btn", "切换界面显示"],
      ["toggle-cam-btn", "切换摄像头画面"],
      ["fs-btn", "切换全屏"],
      ["play-pause-btn", "播放或暂停背景音乐"]
    ].forEach(function (pair) {
      const button = document.getElementById(pair[0]);
      if (button) {
        button.addEventListener("click", function () {
          log("setting", pair[1]);
        });
      }
    });

    const libraryButton = document.querySelector('button[onclick="openDeleteManager()"]');
    if (libraryButton) {
      libraryButton.addEventListener("click", function () {
        log("gesture", "打开照片库");
      });
    }
  }

  function init() {
    session = Lab.beginSession(WORK_ID);
    addArchiveButtons();
    bindConfigMirroring();
    bindAssets();
    observeGestures();
    bindUiEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
