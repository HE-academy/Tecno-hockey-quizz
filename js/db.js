// IndexedDB mínimo. Dos almacenes:
//   kv   -> estado de la sesión en curso ('sesion'), clave fuera de línea
//   cola -> respuestas pendientes/confirmadas, id = `${sesion_id}:${posicion}`

const NOMBRE = 'tecno-hockey-quizz';
const VERSION = 1;
let conexion = null;

function abrir() {
  if (conexion) return conexion;
  conexion = new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('cola')) {
        const cola = db.createObjectStore('cola', { keyPath: 'id' });
        cola.createIndex('sesion', 'sesion_id');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { conexion = null; reject(req.error); };
  });
  return conexion;
}

async function tx(almacen, modo, fn) {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const t = db.transaction(almacen, modo);
    const resultado = fn(t.objectStore(almacen));
    t.oncomplete = () => resolve(resultado instanceof IDBRequest ? resultado.result : resultado);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
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
