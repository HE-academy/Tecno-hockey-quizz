import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.min.js';

// Fallo de red, timeout o 5xx: se puede reintentar.
export class ErrorRed extends Error {}
// El servidor respondió y dijo que no (token_invalido, permisos...): no reintentar igual.
export class ErrorServidor extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo; }
}

export async function rpc(nombre, params = {}, { timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new ErrorRed(e.name === 'AbortError' ? 'timeout' : e.message);
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) throw new ErrorRed(`HTTP ${res.status}`);
  const datos = await res.json().catch(() => null);
  if (!res.ok) throw new ErrorServidor(datos?.message || `HTTP ${res.status}`, datos?.code);
  return datos;
}

// Postgres devuelve microsegundos; Safari no siempre los parsea.
export function aMs(fecha) {
  if (fecha == null) return null;
  return Date.parse(String(fecha).replace(/(\.\d{3})\d+/, '$1'));
}

// Desfase = hora servidor − hora móvil. Se toma la muestra con menos latencia.
export async function medirDesfase(muestras = 3) {
  let mejor = null;
  for (let i = 0; i < muestras; i++) {
    const t0 = Date.now();
    const s = await rpc('hora_servidor', {}, { timeout: 5000 });
    const t1 = Date.now();
    const rtt = t1 - t0;
    const desfase = aMs(s) - (t0 + rtt / 2);
    if (!mejor || rtt < mejor.rtt) mejor = { rtt, desfase };
  }
  return mejor;
}

let cliente = null;
function cargarCliente() {
  if (cliente) return cliente;
  cliente = new Promise((resolve, reject) => {
    const listo = () => resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }));
    if (window.supabase?.createClient) return listo();
    const s = document.createElement('script');
    s.src = SUPABASE_JS;
    s.crossOrigin = 'anonymous';
    s.onload = listo;
    s.onerror = () => { cliente = null; reject(new Error('supabase-js no disponible')); };
    document.head.append(s);
  });
  return cliente;
}

// Aviso en tiempo real de cambios de la sesión (abrir/cerrar pregunta, fin).
// Es solo un empujón: quien escucha vuelve a pedir estado_sesion, que manda.
// Si no se puede cargar Realtime, el sondeo periódico cubre el hueco.
export async function escucharSesion(sesionId, alCambiar) {
  try {
    const sb = await cargarCliente();
    const canal = sb.channel(`vivo-${sesionId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'sesiones_vivo', filter: `sesion_id=eq.${sesionId}` },
        (cambio) => alCambiar(cambio.new))
      .subscribe();
    return () => sb.removeChannel(canal);
  } catch {
    return () => {};
  }
}
