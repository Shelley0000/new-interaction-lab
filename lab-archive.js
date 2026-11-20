/*
 * Interactive Lab — 本地档案馆桥接脚本
 * 供主站和每个独立作品引用，统一读写 IndexedDB。
 *
 * 用法：
 *   const config = await InteractiveLab.getWorkConfig("christmas");
 *   const session = InteractiveLab.beginSession("christmas");
 *   InteractiveLab.logEvent("christmas", "gesture", "点亮一颗星");
 */
(function () {
  "use strict";

  const DB_NAME = "interactive-lab-archive";
  const DB_VERSION = 1;
  let dbPromise = null;

  function uid(prefix) {
    return (prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) {
        reject(new Error("当前浏览器不支持 IndexedDB"));
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = function () {
        const db = request.result;

        if (!db.objectStoreNames.contains("works")) {
          const works = db.createObjectStore("works", { keyPath: "id" });
          works.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("assets")) {
          const assets = db.createObjectStore("assets", { keyPath: "id" });
          assets.createIndex("workId", "workId");
        }
        if (!db.objectStoreNames.contains("revisions")) {
          const revisions = db.createObjectStore("revisions", { keyPath: "id" });
          revisions.createIndex("workId", "workId");
          revisions.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("events")) {
          const events = db.createObjectStore("events", { keyPath: "id" });
          events.createIndex("workId", "workId");
          events.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };

      request.onsuccess = function () {
        const db = request.result;
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = function () {
        reject(request.error || new Error("无法打开本地档案馆数据库"));
      };

      request.onblocked = function () {
        reject(new Error("档案馆数据库被其他标签页占用，请关闭其他页面后重试"));
      };
    });

    dbPromise.catch(function () {
      dbPromise = null;
    });

    return dbPromise;
  }

  /**
   * 在一个事务里执行一次请求，事务完成后 resolve。
   * action 必须同步地返回一个 IDBRequest。
   */
  function dbRequest(storeName, mode, action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        let request;
        try {
          const transaction = db.transaction(storeName, mode);
          request = action(transaction.objectStore(storeName));
          transaction.oncomplete = function () {
            resolve(request ? request.result : undefined);
          };
          transaction.onerror = function () {
            reject(transaction.error || (request && request.error) || new Error("档案馆操作失败"));
          };
          transaction.onabort = function () {
            reject(transaction.error || new Error("档案馆操作被中断"));
          };
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function getWork(workId) {
    return dbRequest("works", "readonly", function (store) {
      return store.get(workId);
    });
  }

  /**
   * 读取作品配置。失败或超时都返回 null，保证作品可以照常打开。
   */
  async function getWorkConfig(workId) {
    try {
      const work = await Promise.race([
        getWork(workId),
        new Promise(function (resolve) {
          setTimeout(function () { resolve(null); }, 1500);
        })
      ]);
      if (work && work.config && typeof work.config === "object" && !Array.isArray(work.config)) {
        return work.config;
      }
      return null;
    } catch (error) {
      console.info("[Lab Archive] 配置暂不可用：", error.message);
      return null;
    }
  }

  /**
   * 把作品里的当前配置写回档案馆。
   * 用于作品自己维护设置面板、同时希望档案保持最新的场景。
   */
  function saveWorkConfig(workId, config, options) {
    const settings = options && typeof options === "object" ? options : {};

    return getWork(workId).then(function (work) {
      if (!work) return null;

      work.config = config && typeof config === "object" && !Array.isArray(config)
        ? config
        : {};
      work.updatedAt = Date.now();

      return dbRequest("works", "readwrite", function (store) {
        return store.put(work);
      }).then(function () {
        if (!settings.createRevision) return work;

        const revision = {
          id: uid("rev"),
          workId: work.id,
          label: String(settings.label || "作品内保存"),
          config: JSON.parse(JSON.stringify(work.config)),
          createdAt: Date.now(),
          reason: "work-save"
        };

        return dbRequest("revisions", "readwrite", function (store) {
          return store.add(revision);
        }).then(function () {
          return work;
        });
      });
    }).catch(function (error) {
      console.info("[Lab Archive] 配置未同步：", error.message);
      return null;
    });
  }

  /**
   * 把作品里上传的文件镜像进档案馆的素材仓库。
   * blob 可以是 File 或 Blob。
   */
  function addAsset(workId, blob, meta) {
    if (!(blob instanceof Blob)) {
      return Promise.resolve(null);
    }

    const options = meta && typeof meta === "object" ? meta : {};
    const record = {
      id: uid("asset"),
      workId: workId || "unknown",
      name: String(options.name || blob.name || "asset").slice(0, 180),
      type: blob.type || options.type || "application/octet-stream",
      size: blob.size,
      blob: blob,
      createdAt: Date.now(),
      source: options.source || "work"
    };

    return dbRequest("assets", "readwrite", function (store) {
      return store.add(record);
    }).then(function () {
      return record;
    }).catch(function (error) {
      console.info("[Lab Archive] 素材未归档：", error.message);
      return null;
    });
  }

  function logEvent(workId, type, detail, extra) {
    const payload = {
      id: uid("evt"),
      workId: workId || "unknown",
      type: String(type || "event"),
      detail: typeof detail === "string" ? detail : "",
      createdAt: Date.now(),
      sessionId: null
    };

    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach(function (key) {
        payload[key] = extra[key];
      });
    }

    return dbRequest("events", "readwrite", function (store) {
      return store.add(payload);
    }).then(function () {
      return payload;
    }).catch(function (error) {
      console.info("[Lab Archive] 交互记录未保存：", error.message);
      return null;
    });
  }

  /**
   * 开始一次体验会话：进入时记录起点，离开页面时记录时长。
   */
  function beginSession(workId) {
    const sessionId = uid("ses");
    const startedAt = Date.now();
    let ended = false;

    logEvent(workId, "session_start", "打开作品", {
      sessionId: sessionId,
      startedAt: startedAt
    });

    function end(reason) {
      if (ended) return;
      ended = true;
      logEvent(workId, "session_end", reason || "离开作品", {
        sessionId: sessionId,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    }

    window.addEventListener("pagehide", function () {
      end("关闭或离开页面");
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") end("切换到其他页面");
    });

    return {
      sessionId: sessionId,
      log: function (type, detail, extra) {
        const merged = extra && typeof extra === "object" ? Object.assign({}, extra) : {};
        merged.sessionId = sessionId;
        return logEvent(workId, type, detail, merged);
      },
      end: end
    };
  }

  window.InteractiveLab = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    openDB: openDB,
    getWork: getWork,
    getWorkConfig: getWorkConfig,
    saveWorkConfig: saveWorkConfig,
    addAsset: addAsset,
    logEvent: logEvent,
    beginSession: beginSession,
    uid: uid
  };
})();
