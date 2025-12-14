const DB_NAME = "bollos_db_v1";
const DB_VER  = 1;

const stores = [
  { name: "meta",        keyPath: "key" },
  { name: "users",       keyPath: "id"  },
  { name: "products",    keyPath: "id"  },
  { name: "customers",   keyPath: "id"  },
  { name: "sales",       keyPath: "id"  },
  { name: "sale_items",  keyPath: "id"  },
  { name: "payments",    keyPath: "id"  },
  { name: "routes",      keyPath: "id"  },
  { name: "route_stops", keyPath: "id"  },
  { name: "expenses",    keyPath: "id"  },
  { name: "tracks",      keyPath: "id"  }, // puntos GPS live
  { name: "outbox",      keyPath: "id"  }
];

function id() {
  return (crypto?.randomUUID?.() || (Date.now()+"-"+Math.random().toString(16).slice(2)));
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s.name)) {
          db.createObjectStore(s.name, { keyPath: s.keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const st = t.objectStore(storeName);
    let res;
    Promise.resolve()
      .then(() => fn(st))
      .then(r => { res = r; })
      .catch(reject);

    t.oncomplete = () => resolve(res);
    t.onerror = () => reject(t.error);
  });
}

const DB = {
  id,
  async get(store, key) {
    return tx(store, "readonly", st => new Promise((resolve, reject) => {
      const r = st.get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    }));
  },
  async put(store, obj) {
    return tx(store, "readwrite", st => new Promise((resolve, reject) => {
      const r = st.put(obj);
      r.onsuccess = () => resolve(obj);
      r.onerror = () => reject(r.error);
    }));
  },
  async del(store, key) {
    return tx(store, "readwrite", st => new Promise((resolve, reject) => {
      const r = st.delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    }));
  },
  async all(store) {
    return tx(store, "readonly", st => new Promise((resolve, reject) => {
      const r = st.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    }));
  },
  async where(store, predicate) {
    const all = await DB.all(store);
    return all.filter(predicate);
  },
  async queue(action, payload) {
    const item = { id: DB.id(), at: Date.now(), action, payload, done: 0 };
    await DB.put("outbox", item);
    return item;
  },
};
