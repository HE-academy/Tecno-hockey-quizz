// IndexedDB mínimo. Dos almacenes:
//   kv   -> estado de la sesión en curso ('sesion'), clave fuera de línea
//   cola -> respuestas pendientes/confirmadas, id = `${sesion_id}:${posicion}`

const NOMBRE = 'tecno-hockey-quizz';
const VERSION = 1;
// En iPhone, IndexedDB a veces se queda colgado o pierde la conexión al volver
// de otra app ("Connection to Indexed Database server lost"). Nada puede
// esperarlo para siempre: pasado este tiempo, la operación falla.
const LIMITE_MS = 1500;
let conexion = null;

const conLimite = (promesa) => Promise.race([
  promesa,
  new Promise((_, reject) => setTimeout(() => reject(new Error('indexeddb_timeout')), LIMITE_MS)),
]);

function abrir() {
  if (conexion) return conexion;
  conexion = conLimite(new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('cola')) {
        const cola = db.createObjectStore('cola', { keyPath: 'id' });
        cola.createIndex('sesion', 'sesion_id');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { conexion = null; };
      db.onversionchange = () => { db.close(); conexion = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }));
  conexion.catch(() => { conexion = null; });
  return conexion;
}

// Si la conexión estaba muerta, se reabre una vez. Repetir es seguro: put y
// delete son idempotentes.
async function tx(almacen, modo, fn, reintento = true) {
  try {
    const db = await abrir();
    return await conLimite(new Promise((resolve, reject) => {
      const t = db.transaction(almacen, modo);
      const resultado = fn(t.objectStore(almacen));
      t.oncomplete = () => resolve(resultado instanceof IDBRequest ? resultado.result : resultado);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  } catch (e) {
    conexion = null;
    if (!reintento) throw e;
    return tx(almacen, modo, fn, false);
  }
}

export const kv = {
  get: (clave) => tx('kv', 'readonly', (s) => s.get(clave)),
  set: (clave, valor) => tx('kv', 'readwrite', (s) => { s.put(valor, clave); }),
  del: (clave) => tx('kv', 'readwrite', (s) => { s.delete(clave); }),
};

export const cola = {
  poner: (item) => tx('cola', 'readwrite', (s) => { s.put(item); }),
  todas: () => tx('cola', 'readonly', (s) => s.getAll()),
  deSesion: (sesionId) => tx('cola', 'readonly', (s) => s.index('sesion').getAll(sesionId)),
  borrarSesion: async (sesionId) => {
    const items = await cola.deSesion(sesionId);
    return tx('cola', 'readwrite', (s) => { items.forEach((i) => s.delete(i.id)); });
  },
};
