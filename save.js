// modules/save/index.js
var SaveError = class extends Error {
  constructor(kind, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "SaveError";
    this.kind = kind;
  }
};
var RECORD = (data, schema, revision) => ({ ...data, schema, revision });
var DATA = (record) => {
  const COPY = { ...record };
  delete COPY.schema;
  delete COPY.revision;
  return COPY;
};
var INTEGER = (value) => Number.isSafeInteger(value) && value >= 0;
function createSave({ adapter, key, version, create, validate, migrate = {} } = {}) {
  if (!adapter || typeof adapter.transact !== "function") {
    throw new TypeError("save adapter must provide transact");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("save key must be a non-empty string");
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("save version must be a positive integer");
  }
  if (typeof create !== "function" || typeof validate !== "function") {
    throw new TypeError("save create and validate must be functions");
  }
  const LISTENERS = /* @__PURE__ */ new Set();
  let channel = null, pending = Promise.resolve(), closed = false;
  if (adapter.channelName && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(`${adapter.channelName}:${key}`);
    channel.onmessage = (event) => {
      const REVISION = event.data?.revision;
      if (INTEGER(REVISION) && SAVE.revision !== null && REVISION > SAVE.revision) {
        for (const LISTENER of LISTENERS) {
          LISTENER({ revision: REVISION });
        }
      }
    };
  }
  const READ = (stored) => {
    if (stored instanceof SaveError) {
      throw stored;
    }
    if (stored === void 0) {
      const CREATED = create();
      validate(CREATED);
      return { record: RECORD(CREATED, version, 0), write: true };
    }
    if (!stored || typeof stored !== "object" || !INTEGER(stored.schema) || !INTEGER(stored.revision)) {
      throw new SaveError("unreadable", "saved record has no schema or revision");
    }
    if (stored.schema > version) {
      throw new SaveError("unreadable", `saved schema ${stored.schema} is newer than ${version}`);
    }
    let data = DATA(stored);
    for (let schema = stored.schema; schema < version; schema++) {
      if (typeof migrate[schema] !== "function") {
        throw new SaveError("unreadable", `no migration from schema ${schema}`);
      }
      try {
        data = migrate[schema](data);
      } catch (error) {
        throw new SaveError("unreadable", `saved record failed migration from schema ${schema}`, error);
      }
    }
    try {
      validate(data);
    } catch (error) {
      throw new SaveError("unreadable", "saved record failed validation", error);
    }
    const MIGRATED = stored.schema !== version;
    return { record: RECORD(data, version, stored.revision + (MIGRATED ? 1 : 0)), write: MIGRATED };
  };
  const QUEUE = (operation) => {
    const RUN = pending.then(() => {
      if (closed) {
        throw new SaveError("closed", "save is closed");
      }
      return operation();
    });
    pending = RUN.catch(() => {
    });
    return RUN;
  };
  const COMMIT = (record, written) => {
    SAVE.data = DATA(record);
    SAVE.revision = record.revision;
    if (written) {
      channel?.postMessage({ revision: record.revision });
    }
    return SAVE.data;
  };
  const SAVE = {
    /** 마지막으로 읽거나 저장한 데이터. 직접 고치지 말고 update로 바꿉니다. */
    data: null,
    revision: null,
    /** 읽지 못한 저장을 만나면 true. 원본을 덮어쓰지 않도록 update를 거부합니다. */
    locked: false,
    /** 저장소에서 다시 읽습니다. 없으면 create로 만들고, 낮은 schema는 이관해 저장합니다. */
    load() {
      return QUEUE(async () => {
        let written = false, record;
        try {
          record = await adapter.transact(key, (stored) => {
            const RESULT = READ(stored);
            written = RESULT.write;
            return { value: RESULT.record, write: RESULT.write };
          });
        } catch (error) {
          if (error instanceof SaveError && error.kind === "unreadable") {
            SAVE.locked = true;
          }
          throw error;
        }
        SAVE.locked = false;
        return COMMIT(record, written);
      });
    },
    /**
     * 현재 데이터의 복사본을 고쳐 저장합니다. mutate가 false를 반환하면 저장하지 않습니다.
     * 저장소의 revision이 마지막으로 읽은 것과 다르면 아무것도 쓰지 않고 conflict를 던집니다.
     */
    update(mutate) {
      return QUEUE(async () => {
        if (SAVE.locked) {
          throw new SaveError("unreadable", "saved record is unreadable and preserved");
        }
        if (SAVE.revision === null) {
          throw new Error("load before update");
        }
        let written = false;
        const UPDATED = await adapter.transact(key, (stored) => {
          if (stored instanceof SaveError) {
            throw stored;
          }
          if (!stored || stored.revision !== SAVE.revision || stored.schema !== version) {
            throw new SaveError("conflict", "saved record changed elsewhere");
          }
          const NEXT = structuredClone(DATA(stored));
          if (mutate(NEXT) === false) {
            return { value: stored, write: false };
          }
          validate(NEXT);
          written = true;
          return { value: RECORD(NEXT, version, stored.revision + 1), write: true };
        });
        return COMMIT(UPDATED, written);
      });
    },
    /**
     * 저장된 레코드를 버리고 `create()`로 새로 만들어 저장합니다. 읽지 못한 저장도 덮어쓰고 잠금을 풉니다.
     * 되돌릴 수 없으므로 게임이 사용자 확인을 받은 뒤에만 부릅니다. 다른 탭이 알도록 revision은 이어서 올립니다.
     */
    reset() {
      return QUEUE(async () => {
        const CREATED = create();
        validate(CREATED);
        const RECORD_RESET = await adapter.transact(key, (stored) => ({
          value: RECORD(CREATED, version, INTEGER(stored?.revision) ? stored.revision + 1 : 0),
          write: true
        }));
        SAVE.locked = false;
        return COMMIT(RECORD_RESET, true);
      });
    },
    /** 다른 탭이 이 레코드를 저장하면 `{revision}`으로 부릅니다. 해제 함수를 반환합니다. */
    onExternalChange(listener) {
      LISTENERS.add(listener);
      return () => LISTENERS.delete(listener);
    },
    dispose() {
      closed = true;
      LISTENERS.clear();
      channel?.close();
      channel = null;
      adapter.close?.();
    }
  };
  return SAVE;
}
function indexedDbAdapter({ database, store = "records", indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) {
    throw new SaveError("storage", "IndexedDB is not available");
  }
  let opening = null;
  const OPEN = () => opening ??= new Promise((resolve, reject) => {
    const REQUEST = indexedDB.open(database, 1);
    REQUEST.onupgradeneeded = () => {
      if (!REQUEST.result.objectStoreNames.contains(store)) {
        REQUEST.result.createObjectStore(store);
      }
    };
    REQUEST.onblocked = () => reject(new SaveError("storage", "IndexedDB open is blocked by another tab"));
    REQUEST.onerror = () => reject(new SaveError("storage", "IndexedDB open failed", REQUEST.error));
    REQUEST.onsuccess = () => {
      const DB = REQUEST.result;
      DB.onversionchange = () => {
        DB.close();
        opening = null;
      };
      resolve(DB);
    };
  });
  return {
    channelName: `idb:${database}:${store}`,
    async transact(key, body) {
      const DB = await OPEN();
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = DB.transaction(store, "readwrite");
        } catch (error) {
          reject(new SaveError("storage", "IndexedDB transaction failed", error));
          return;
        }
        const TX = tx, OBJECTS = TX.objectStore(store);
        let failure = null, result;
        TX.oncomplete = () => resolve(result);
        TX.onabort = () => reject(
          failure ?? new SaveError(
            "storage",
            TX.error?.name === "QuotaExceededError" ? "storage quota exceeded" : "IndexedDB write failed",
            TX.error
          )
        );
        const REQUEST = OBJECTS.get(key);
        REQUEST.onsuccess = () => {
          try {
            const { value: VALUE, write: WRITE } = body(REQUEST.result);
            if (WRITE) {
              OBJECTS.put(VALUE, key);
            }
            result = VALUE;
          } catch (error) {
            failure = error;
            TX.abort();
          }
        };
      });
    },
    close() {
      opening?.then((db) => db.close());
      opening = null;
    }
  };
}
function localStorageAdapter({ prefix = "", storage = globalThis.localStorage } = {}) {
  if (!storage) {
    throw new SaveError("storage", "localStorage is not available");
  }
  return {
    channelName: `local:${prefix}`,
    async transact(key, body) {
      let text, stored;
      try {
        text = storage.getItem(prefix + key);
      } catch (error) {
        throw new SaveError("storage", "localStorage read failed", error);
      }
      try {
        stored = text === null ? void 0 : JSON.parse(text);
      } catch (error) {
        stored = new SaveError("unreadable", "saved text is not JSON", error);
      }
      const { value: VALUE, write: WRITE } = body(stored);
      if (WRITE) {
        try {
          storage.setItem(prefix + key, JSON.stringify(VALUE));
        } catch (error) {
          throw new SaveError(
            "storage",
            error?.name === "QuotaExceededError" ? "storage quota exceeded" : "localStorage write failed",
            error
          );
        }
      }
      return VALUE;
    }
  };
}
function memoryAdapter(records = {}) {
  const RECORDS = new Map(Object.entries(structuredClone(records)));
  return {
    channelName: null,
    async transact(key, body) {
      const { value: VALUE, write: WRITE } = body(structuredClone(RECORDS.get(key)));
      if (WRITE) {
        RECORDS.set(key, structuredClone(VALUE));
      }
      return structuredClone(VALUE);
    }
  };
}
export {
  SaveError,
  createSave,
  indexedDbAdapter,
  localStorageAdapter,
  memoryAdapter
};
