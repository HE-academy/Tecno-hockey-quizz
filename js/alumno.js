import { kv, cola } from './db.js';
import { rpc, aMs, medirDesfase, escucharSesion, ErrorRed, ErrorServidor } from './api.js';
import { escanearQR, extraerCodigo } from './qr.js';

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONOS = {
  qr: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8" y="8" width="3" height="3"/><rect x="13" y="8" width="3" height="3"/><rect x="8" y="13" width="3" height="3"/><path d="M13 13h3v3"/>'),
  flecha: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  libro: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7M8 11h5"/>'),
  barras: svg('<path d="M4 20h16M7 16v-4M12 16V8M17 16V5"/>'),
  diana: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5"/><path d="M20 4l-6 6M17 4h3v3"/>'),
};
const LS_CRED = 'thq_credenciales';
const LS_TOKEN = 'thq_ultimo_token';
const LS_HIST = 'thq_historial';

const $app = document.getElementById('app');
const $conexion = document.getElementById('conexion');
const $aviso = document.getElementById('aviso-red');
const ponerVista = (v) => { document.body.dataset.vista = v; };

// Registro de la sesión en curso, persistido en IndexedDB ('sesion'):
// { codigo, sesion, token, alumno, preguntas[turno], ventanas, respondidas,
//   desfase, perms{posicion:[orig por botón]}, elegidas{posicion:botón}, tokenInvalido }
let r = null;
let conectado = navigator.onLine;
let pendientes = 0;
let vista = null;
let dejarDeEscuchar = () => {};
let sondeo = null;
let resultadoFinal = null;
let cargandoFinal = false;
let wakeLock = null;
const estadoCola = new Map();   // posicion -> item de la cola (sesión actual)
const feedback = {};            // turno -> pregunta de mi_resultado | 'cargando'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ahora = () => Date.now() + (r?.desfase ?? 0);
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ }
};
const guardar = () => kv.set('sesion', r);
const nota2 = (n) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- conexión

function pintarConexion() {
  $conexion.className = 'conexion' + (!conectado ? ' off' : pendientes ? ' enviando' : '');
  $conexion.textContent = !conectado ? 'Sin conexión' : pendientes ? `Enviando ${pendientes}` : 'Conectado';
  $aviso.hidden = conectado || !r;
}

function marcarConexion(ok) {
  if (conectado === ok) return;
  conectado = ok;
  pintarConexion();
  if (ok) alReconectar();
  else if (vista?.startsWith('pregunta')) pintarEstadoRespuesta();
}

async function alReconectar() {
  if (r) {
    try { r.desfase = (await medirDesfase()).desfase; await guardar(); } catch { /* sigue con el anterior */ }
  }
  await refrescar();
  sincronizar();
}

// ---------------------------------------------------------------- cola de respuestas

let sincronizando = false;
let otraVuelta = false;
let reintento = null;
let espera = 1000;

async function contarPendientes() {
  const todas = await cola.todas();
  pendientes = todas.filter((i) => i.estado === 'pendiente' || i.estado === 'sin_token').length;
  if (r) {
    estadoCola.clear();
    todas.filter((i) => i.sesion_id === r.sesion.id).forEach((i) => estadoCola.set(i.posicion, i));
  }
  pintarConexion();
}

// Envía todo lo pendiente de cualquier sesión. Backoff exponencial ante fallos
// de red; se relanza al reconectar, al volver a primer plano y al abrir la app.
async function sincronizar() {
  if (sincronizando) { otraVuelta = true; return; }
  sincronizando = true;
  clearTimeout(reintento);
  try {
    const items = (await cola.todas()).filter((i) => i.estado === 'pendiente');
    for (const item of items) {
      const token = await kv.get(`token:${item.sesion_id}`);
      try {
        const res = await rpc('enviar_respuesta', {
          p_token: token, p_posicion: item.posicion, p_opcion: item.opcion, p_t_respuesta: item.t_respuesta,
        });
        if (res.ok) {
          item.estado = 'confirmada';
          item.resultado = res.duplicada ? 'duplicada' : res.estado;
        } else if (res.error === 'no_iniciada') {
          throw new ErrorRed('no_iniciada');
        } else {
          item.estado = 'rechazada';
          item.resultado = res.error;
        }
      } catch (e) {
        if (!(e instanceof ErrorServidor)) throw e;
        // Token sustituido (entró desde otro móvil): espera a que vuelva a entrar aquí.
        item.estado = /token_invalido/.test(e.message) ? 'sin_token' : 'rechazada';
        item.resultado = e.message;
        if (item.estado === 'sin_token' && r?.sesion.id === item.sesion_id) {
          r.tokenInvalido = true;
          await guardar();
        }
      }
      item.intentos = (item.intentos || 0) + 1;
      await cola.poner(item);
      marcarConexion(true);
    }
    espera = 1000;
  } catch {
    marcarConexion(false);
    reintento = setTimeout(sincronizar, espera + Math.random() * 500);
    espera = Math.min(espera * 2, 30000);
  } finally {
    sincronizando = false;
    await contarPendientes();
    if (vista?.startsWith('pregunta')) pintarEstadoRespuesta();
    if (vista?.startsWith('final')) pintarFinal();
    if (otraVuelta) { otraVuelta = false; sincronizar(); }
  }
}

// ---------------------------------------------------------------- estado de la sesión

async function refrescar() {
  if (!r) return;
  try {
    const e = await rpc('estado_sesion', { p_token: r.token });
    r.ventanas = e.ventanas;
    r.sesion.estado = e.estado;
    r.sesion.inicio = e.inicio;
    r.respondidas = e.respondidas;
    r.tokenInvalido = false;
    await guardar();
    marcarConexion(true);
    tick();
  } catch (err) {
    if (err instanceof ErrorServidor && /token_invalido/.test(err.message)) {
      r.tokenInvalido = true;
      await guardar();
      tick(true);
    } else if (err instanceof ErrorRed) {
      marcarConexion(false);
    }
  }
}

function programarSondeo() {
  clearTimeout(sondeo);
  if (!r) return;
  const f = fase();
  let ms = 15000;
  if (f.tipo === 'espera' || (f.tipo === 'pausa' && !f.hasta)) ms = 3000;
  if (f.tipo === 'final') {
    if (resultadoFinal?.nota != null && !pendientes) return;
    ms = 8000;
  }
  sondeo = setTimeout(async () => {
    await refrescar();
    if (fase().tipo === 'final') cargarResultadoFinal();
    programarSondeo();
  }, ms);
}

const preguntaDeTurno = (turno) => r.preguntas[turno];
const respondida = (pos) => r.elegidas[pos] != null || r.respondidas.includes(pos) || estadoCola.has(pos);

// Qué toca ahora según el calendario y la hora del servidor. Funciona sin red:
// en modo fijo el calendario completo ya está en el móvil.
function fase() {
  const t = ahora();
  const n = r.preguntas.length;
  if (r.sesion.estado === 'finalizada') return { tipo: 'final' };
  const v = r.ventanas
    .map((x) => ({ turno: x.turno, abre: aMs(x.abierta_en), cierra: aMs(x.cierra_en) }))
    .sort((a, b) => a.turno - b.turno);
  if (!v.length) return { tipo: 'espera' };
  const abierta = v.find((x) => t >= x.abre && t < x.cierra);
  if (abierta) return { tipo: 'pregunta', ...abierta };
  const proxima = v.find((x) => t < x.abre);
  if (proxima) {
    return proxima.turno === 0
      ? { tipo: 'cuenta', hasta: proxima.abre }
      : { tipo: 'pausa', hasta: proxima.abre, turnoPrevio: proxima.turno - 1, cierrePrevio: v[proxima.turno - 1]?.cierra };
  }
  const ultima = v[v.length - 1];
  if (ultima.turno >= n - 1) return { tipo: 'final' };
  // Modo manual: el profesor aún no ha abierto la siguiente.
  return { tipo: 'pausa', hasta: null, turnoPrevio: ultima.turno, cierrePrevio: ultima.cierra };
}

function tick(forzar = false) {
  if (!r || (vista === 'historial' && !forzar)) return;
  const f = fase();
  const clave = r.tokenInvalido && f.tipo !== 'final'
    ? 'reentrar'
    : `${f.tipo}:${f.turno ?? f.turnoPrevio ?? ''}:${f.hasta ? 1 : 0}`;
  if (forzar || clave !== vista) {
    vista = clave;
    pintarJuego(f, clave);
    programarSondeo();
  }
  actualizarContadores(f);
  if (f.tipo === 'pausa') pedirFeedback(f);
}

// ---------------------------------------------------------------- pantallas de juego

function pintarJuego(f, clave) {
  ponerVista('juego');
  if (clave === 'reentrar') return pintarReentrar();
  if (f.tipo === 'espera') return pintarEspera();
  if (f.tipo === 'cuenta') return pintarCuenta();
  if (f.tipo === 'pregunta') return pintarPregunta(f);
  if (f.tipo === 'pausa') return pintarPausa(f);
  if (f.tipo === 'final') { resultadoFinal = null; pintarFinal(); cargarResultadoFinal(); }
}

function pintarEspera() {
  $app.innerHTML = `
    <section class="pantalla centro">
      <h1>Hola, <b>${esc(r.alumno.nombre)}</b></h1>
      <p class="sub">${esc(r.sesion.titulo)}</p>
      <div class="pelota" aria-hidden="true"></div>
      <div class="tarjeta">
        <strong>Ya estás dentro.</strong><br>
        Espera a que el profesor empiece.<br>
        ${r.preguntas.length} preguntas · ${r.sesion.tiempo_s} s cada una
      </div>
      <p class="sub">Las preguntas ya están en tu móvil: si se va la conexión, podrás seguir.</p>
      <button class="btn-link" type="button" data-salir>No soy ${esc(r.alumno.nombre)} · salir</button>
    </section>`;
  $app.querySelector('[data-salir]').onclick = () => salir();
}

function pintarCuenta() {
  $app.innerHTML = `
    <section class="pantalla centro">
      <h1>¡Preparados!</h1>
      <p class="sub">${esc(r.sesion.titulo)}</p>
      <div class="grande" id="cuenta">--</div>
      <p class="sub">La primera pregunta empieza enseguida.</p>
    </section>`;
}

function pintarPregunta(f) {
  const p = preguntaDeTurno(f.turno);
  const perm = r.perms[p.posicion] || [0, 1, 2, 3, 4];
  const ya = respondida(p.posicion);
  const elegida = r.elegidas[p.posicion];
  $app.innerHTML = `
    <section class="pantalla">
      <div class="cabecera-pregunta">
        <span class="contador-preg">Pregunta ${f.turno + 1} de ${r.preguntas.length}</span>
        <span class="reloj" id="reloj" aria-live="off">--</span>
      </div>
      <div class="tiempo" aria-hidden="true"><div id="barra-tiempo"></div></div>
      <p class="enunciado">${esc(p.enunciado)}</p>
      <ul class="opciones${ya ? ' bloqueadas' : ''}" id="opciones">
        ${perm.map((orig, i) => `
          <li><button class="opcion${elegida === i ? ' elegida' : ''}" type="button" data-i="${i}" ${ya ? 'disabled' : ''}>
            <span class="letra">${LETRAS[i]}</span><span>${esc(p.opciones[orig])}</span>
          </button></li>`).join('')}
      </ul>
      <p class="estado-respuesta" id="estado-resp" aria-live="polite"></p>
    </section>`;
  $app.querySelectorAll('.opcion').forEach((b) => {
    b.onclick = () => responder(f.turno, Number(b.dataset.i));
  });
  pintarEstadoRespuesta();
}

function pintarEstadoRespuesta() {
  const $e = document.getElementById('estado-resp');
  if (!$e || !r) return;
  const f = fase();
  if (f.tipo !== 'pregunta') return;
  const pos = preguntaDeTurno(f.turno).posicion;
  const item = estadoCola.get(pos);
  let texto = '';
  if (item?.estado === 'confirmada') texto = item.resultado === 'fuera_de_tiempo' ? 'Llegó fuera de tiempo.' : 'Respuesta enviada ✓';
  else if (item?.estado === 'rechazada') texto = 'No se pudo registrar esta respuesta.';
  else if (item) texto = conectado ? 'Enviando…' : 'Guardada en el móvil. Se enviará al volver la conexión.';
  else if (respondida(pos)) texto = 'Ya habías respondido esta pregunta.';
  $e.textContent = texto;
}

async function responder(turno, boton) {
  const p = preguntaDeTurno(turno);
  if (respondida(p.posicion)) return;
  const f = fase();
  if (f.tipo !== 'pregunta' || f.turno !== turno) return;
  const perm = r.perms[p.posicion] || [0, 1, 2, 3, 4];
  const item = {
    id: `${r.sesion.id}:${p.posicion}`,
    sesion_id: r.sesion.id,
    posicion: p.posicion,
    opcion: perm[boton],
    t_respuesta: new Date(ahora()).toISOString(),
    estado: 'pendiente',
    intentos: 0,
  };
  // Primero al disco: si el móvil se apaga ahora, la respuesta sobrevive.
  await cola.poner(item);
  estadoCola.set(p.posicion, item);
  r.elegidas[p.posicion] = boton;
  await guardar();
  navigator.vibrate?.(30);
  const $ops = document.getElementById('opciones');
  if ($ops) {
    $ops.classList.add('bloqueadas');
    $ops.querySelectorAll('.opcion').forEach((b) => {
      b.disabled = true;
      if (Number(b.dataset.i) === boton) b.classList.add('elegida');
    });
  }
  pendientes += 1;
  pintarConexion();
  pintarEstadoRespuesta();
  sincronizar();
}

function pintarPausa(f) {
  $app.innerHTML = `
    <section class="pantalla centro">
      <div id="feedback"></div>
      ${f.hasta
        ? `<p class="sub">Siguiente pregunta en</p><div class="grande" id="cuenta">--</div>`
        : `<div class="pelota" aria-hidden="true"></div>
           <p><strong>Espera a la siguiente pregunta.</strong></p>
           ${conectado ? '' : '<p class="sub">Sin conexión: al volver te llevo a la pregunta que toque.</p>'}`}
      <p class="sub">Llevas ${f.turnoPrevio + 1} de ${r.preguntas.length}</p>
    </section>`;
  pintarFeedback(f);
}

function pintarFeedback(f) {
  const $f = document.getElementById('feedback');
  if (!$f) return;
  const p = preguntaDeTurno(f.turnoPrevio);
  const item = estadoCola.get(p.posicion);
  const q = feedback[f.turnoPrevio];
  let html;
  if (!respondida(p.posicion)) {
    html = '<div class="feedback neutro">No respondiste a tiempo.</div>';
  } else if (q && q !== 'cargando' && q.revelada) {
    const correcta = esc(p.opciones[q.correcta]);
    html = q.acierto
      ? '<div class="feedback bien">¡Correcto!</div>'
      : `<div class="feedback mal">${q.aceptada === false ? 'Fuera de tiempo' : 'Incorrecto'}<p>Correcta: ${correcta}</p></div>`;
  } else if (q && q !== 'cargando' && !q.revelada) {
    html = '<div class="feedback neutro">Respuesta guardada.<p>Verás si acertaste al final.</p></div>';
  } else if (item && item.estado !== 'confirmada') {
    html = '<div class="feedback neutro">Respuesta guardada en el móvil.<p>El resultado llegará cuando se envíe.</p></div>';
  } else {
    html = '<div class="feedback neutro">Respuesta enviada.</div>';
  }
  $f.innerHTML = html;
}

async function pedirFeedback(f) {
  const turno = f.turnoPrevio;
  if (feedback[turno] || !conectado || !f.cierrePrevio) return;
  // La correcta solo se revela a los 2 s del cierre.
  if (ahora() < f.cierrePrevio + 2500) return;
  const p = preguntaDeTurno(turno);
  const item = estadoCola.get(p.posicion);
  if (!respondida(p.posicion) || (item && item.estado !== 'confirmada')) return;
  feedback[turno] = 'cargando';
  try {
    const res = await rpc('mi_resultado', { p_token: r.token });
    res.preguntas.forEach((q) => { if (q.revelada || q.turno === turno) feedback[q.turno] = q; });
  } catch {
    delete feedback[turno];
  }
  if (vista?.startsWith('pausa')) pintarFeedback(fase());
}

function actualizarContadores(f) {
  const t = ahora();
  if (f.tipo === 'pregunta') {
    const resta = Math.max(0, f.cierra - t);
    const $reloj = document.getElementById('reloj');
    const $barra = document.getElementById('barra-tiempo');
    if ($reloj) {
      const s = Math.ceil(resta / 1000);
      $reloj.textContent = s;
      $reloj.classList.toggle('urgente', s <= 5);
    }
    if ($barra) $barra.style.transform = `scaleX(${Math.min(1, resta / (f.cierra - f.abre))})`;
  } else if (f.hasta) {
    const $c = document.getElementById('cuenta');
    if ($c) $c.textContent = Math.max(0, Math.ceil((f.hasta - t) / 1000));
  }
}

async function cargarResultadoFinal() {
  if (!r || cargandoFinal || pendientes || !conectado) return;
  if (resultadoFinal?.nota != null) return;
  cargandoFinal = true;
  try {
    resultadoFinal = await rpc('mi_resultado', { p_token: r.token });
    if (vista?.startsWith('final')) pintarFinal();
  } catch { /* se reintenta en el sondeo */ }
  cargandoFinal = false;
}

function pintarFinal() {
  liberarPantalla();
  const rf = resultadoFinal;
  let bloque;
  if (pendientes) {
    bloque = `<div class="tarjeta"><strong>Tienes ${pendientes} respuesta${pendientes > 1 ? 's' : ''} guardada${pendientes > 1 ? 's' : ''} en el móvil.</strong><br>
      Se enviarán solas en cuanto haya conexión, aunque cierres la app.</div>`;
  } else if (rf?.nota != null) {
    const enBlanco = rf.total - rf.aciertos - rf.errores;
    bloque = `
      <p class="sub">Tu nota de hoy</p>
      <div class="nota">${nota2(rf.nota)}<small> / 10</small></div>
      <div class="cifras">
        <div><b>${rf.aciertos}</b><span>aciertos</span></div>
        <div><b>${rf.errores}</b><span>errores</span></div>
        <div><b>${enBlanco}</b><span>en blanco</span></div>
      </div>
      <div class="tarjeta"><strong>${rf.puntos}</strong> puntos para la clasificación de tu grupo</div>`;
  } else if (rf) {
    bloque = '<div class="tarjeta">Tus respuestas están enviadas. La nota aparecerá cuando se cierre la sesión.</div>';
  } else {
    bloque = `<div class="tarjeta">${conectado ? 'Calculando tu nota…' : 'Sin conexión: la nota aparecerá al reconectar.'}</div>`;
  }
  $app.innerHTML = `
    <section class="pantalla centro">
      <h1>¡Cuestionario <b>terminado</b>!</h1>
      ${r.tokenInvalido ? '<p class="error">Entraste desde otro dispositivo: consulta allí el resultado.</p>' : ''}
      ${bloque}
      <button class="btn bloque" type="button" data-notas>Mis notas y clasificación</button>
      <button class="btn secundario bloque" type="button" data-salir>Salir</button>
    </section>`;
  $app.querySelector('[data-notas]').onclick = () => pintarHistorial();
  $app.querySelector('[data-salir]').onclick = () => salir();
}

function pintarReentrar() {
  $app.innerHTML = `
    <form class="pantalla" id="form-reentrar" novalidate>
      <h1>Vuelve a <b>entrar</b></h1>
      <p class="sub">Has entrado con tu id desde otro dispositivo. Para seguir en este, escribe otra vez tu PIN.</p>
      <div class="campo"><label for="pin">PIN</label>
        <input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off"></div>
      <p class="error" id="error" hidden></p>
      <button class="btn bloque" type="submit">Seguir aquí</button>
      <button class="btn-link" type="button" data-salir>Salir de la sesión</button>
    </form>`;
  $app.querySelector('[data-salir]').onclick = () => salir();
  $app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const err = await entrar(r.codigo, r.alumno.id_alumno, $app.querySelector('#pin').value);
    if (err) {
      const $e = $app.querySelector('#error');
      $e.textContent = err;
      $e.hidden = false;
    }
  };
}

// ---------------------------------------------------------------- entrar / salir

function barajar(n) {
  const a = [...Array(n).keys()];
  const azar = new Uint32Array(n);
  crypto.getRandomValues(azar);
  for (let i = n - 1; i > 0; i--) {
    const j = azar[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Devuelve null si entra, o el mensaje de error.
async function entrar(codigo, idAlumno, pin, recordar) {
  codigo = (codigo || '').trim().toUpperCase();
  idAlumno = (idAlumno || '').trim();
  pin = (pin || '').trim();
  if (!/^[A-Z2-9]{6}$/.test(codigo)) return 'El código tiene 6 caracteres (letras y números).';
  if (!idAlumno) return 'Escribe tu id de alumno.';
  if (!/^\d{4}$/.test(pin)) return 'El PIN son 4 cifras.';
  let res;
  let desfase = 0;
  try {
    desfase = (await medirDesfase()).desfase;
    res = await rpc('unirse_sesion', { p_codigo: codigo, p_id_alumno: idAlumno, p_pin: pin });
  } catch (e) {
    marcarConexion(false);
    return e instanceof ErrorRed
      ? 'Sin conexión. Para entrar hace falta internet; después, aunque se corte, podrás seguir.'
      : 'No se ha podido entrar. Inténtalo otra vez.';
  }
  marcarConexion(true);
  if (!res.ok) {
    if (res.error === 'codigo') return 'No hay ninguna sesión abierta con ese código.';
    if (res.error === 'bloqueado') {
      const hora = new Date(aMs(res.hasta)).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      return `Demasiados intentos con PIN incorrecto. Prueba otra vez a las ${hora}.`;
    }
    return 'Id de alumno o PIN incorrectos.';
  }

  const anterior = r?.sesion.id === res.sesion.id ? r : null;
  const perms = anterior?.perms || {};
  for (const p of res.preguntas) {
    perms[p.posicion] ??= res.sesion.barajar_opciones ? barajar(5) : [0, 1, 2, 3, 4];
  }
  r = {
    codigo,
    sesion: res.sesion,
    token: res.token,
    alumno: res.alumno,
    preguntas: res.preguntas,
    ventanas: res.ventanas,
    respondidas: res.respondidas,
    desfase,
    perms,
    elegidas: anterior?.elegidas || {},
    tokenInvalido: false,
  };
  await guardar();
  await kv.set(`token:${res.sesion.id}`, res.token);
  lsSet(LS_TOKEN, res.token);
  // undefined = no tocar lo recordado (reentrada desde la pantalla de PIN).
  if (recordar === true) lsSet(LS_CRED, { id_alumno: idAlumno, pin });
  else if (recordar === false) lsSet(LS_CRED, null);

  // Respuestas que se quedaron sin token válido: ya se pueden enviar.
  for (const item of await cola.deSesion(res.sesion.id)) {
    if (item.estado === 'sin_token') { item.estado = 'pendiente'; await cola.poner(item); }
  }
  arrancar();
  return null;
}

function arrancar() {
  vista = null;
  resultadoFinal = null;
  Object.keys(feedback).forEach((k) => delete feedback[k]);
  dejarDeEscuchar();
  dejarDeEscuchar = () => {};
  escucharSesion(r.sesion.id, () => refrescar()).then((parar) => { dejarDeEscuchar = parar; });
  contarPendientes().then(() => tick(true));
  refrescar();
  sincronizar();
  mantenerPantalla();
}

async function salir() {
  dejarDeEscuchar();
  dejarDeEscuchar = () => {};
  clearTimeout(sondeo);
  liberarPantalla();
  // La cola no se borra: lo pendiente se sigue enviando con su token.
  await kv.del('sesion');
  r = null;
  resultadoFinal = null;
  pintarConexion();
  pintarEntrada();
}

// ---------------------------------------------------------------- pantalla de entrada

function pintarEntrada({ codigo = '', error = '', escrito = null } = {}) {
  vista = 'entrada';
  ponerVista('portada');
  const cred = escrito || lsGet(LS_CRED) || {};
  const hayNotas = !!lsGet(LS_TOKEN);
  $app.innerHTML = `
    <div class="portada">
      <section class="hero">
        <div class="hero-txt">
          <p class="antetitulo">Deportes Colectivos II</p>
          <h1 class="hero-titulo">Hockey <span>hierba</span></h1>
          <span class="hero-raya" aria-hidden="true"></span>
          <p class="hero-sub">Cuestionarios de apoyo a la asignatura</p>
          <ul class="ventajas">
            <li>${ICONOS.libro}<span>Repasa<br>conceptos</span></li>
            <li>${ICONOS.barras}<span>Comprueba<br>tu progreso</span></li>
            <li>${ICONOS.diana}<span>Prepárate<br>para el examen</span></li>
          </ul>
        </div>
        <a class="credito" href="https://commons.wikimedia.org/wiki/File:Field_hockey_banner.jpg" target="_blank" rel="noopener">Foto: fourthandfifteen · CC BY 2.0</a>
      </section>
      <form class="tarjeta-entrar" id="form-entrar" novalidate autocomplete="off">
        <div class="cabeza">
          <p class="antetitulo">Entra al</p>
          <h2>Cuestionario</h2>
          <span class="raya" aria-hidden="true"></span>
        </div>
        <p class="sub">Escanea el QR del proyector o escribe el código que aparece.</p>
        <button type="button" class="btn oscuro bloque" id="btn-qr">${ICONOS.qr}Escanear QR</button>
        <div class="separador">o</div>
        <div class="campo">
          <label for="codigo">Código de la sesión</label>
          <input id="codigo" class="codigo-input" inputmode="text" maxlength="6" autocapitalize="characters"
                 spellcheck="false" value="${esc(codigo)}" placeholder="ABC234">
        </div>
        <div class="fila">
          <div class="campo">
            <label for="id-alumno">Id de alumno</label>
            <input id="id-alumno" type="text" autocapitalize="none" spellcheck="false" placeholder="Ej. 123456"
                   value="${esc(cred.id_alumno || '')}">
          </div>
          <div class="campo">
            <label for="pin">PIN</label>
            <input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="••••"
                   value="${esc(cred.pin || '')}">
          </div>
        </div>
        <label class="check"><input type="checkbox" id="recordar" ${cred.id_alumno || !hayNotas ? 'checked' : ''}>
          Recordar mi id y PIN en este dispositivo</label>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        <button class="btn bloque" type="submit" id="btn-entrar">Entrar ${ICONOS.flecha}</button>
        ${hayNotas ? '<button type="button" class="btn-link" id="btn-notas">Ver mis notas y clasificación</button>' : ''}
      </form>
    </div>`;
  const $form = $app.querySelector('form');
  const $codigo = $form.querySelector('#codigo');
  const $boton = $form.querySelector('#btn-entrar');

  const enviar = async () => {
    $boton.disabled = true;
    $boton.textContent = 'Entrando…';
    const escrito = { id_alumno: $form.querySelector('#id-alumno').value, pin: $form.querySelector('#pin').value };
    const err = await entrar($codigo.value, escrito.id_alumno, escrito.pin, $form.querySelector('#recordar').checked);
    if (err) pintarEntrada({ codigo: $codigo.value.toUpperCase(), error: err, escrito });
  };
  $form.onsubmit = (e) => { e.preventDefault(); enviar(); };
  $codigo.oninput = () => { $codigo.value = $codigo.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  $form.querySelector('#btn-qr').onclick = async () => {
    const leido = await escanearQR();
    if (!leido) return;
    $codigo.value = leido;
    const listo = $form.querySelector('#id-alumno').value && /^\d{4}$/.test($form.querySelector('#pin').value);
    if (listo) enviar();
    else $form.querySelector($form.querySelector('#id-alumno').value ? '#pin' : '#id-alumno').focus();
  };
  $form.querySelector('#btn-notas')?.addEventListener('click', () => pintarHistorial());
}

// ---------------------------------------------------------------- notas y clasificación

async function pintarHistorial(pestana = 'notas') {
  vista = 'historial';
  ponerVista('juego');
  clearTimeout(sondeo);
  const token = lsGet(LS_TOKEN);
  const pintar = (datos, cargando) => {
    if (vista !== 'historial') return;
    $app.innerHTML = `
      <section class="pantalla">
        <h1>Mis <b>notas</b></h1>
        <div class="pestanas" role="tablist">
          <button role="tab" type="button" data-p="notas" aria-selected="${pestana === 'notas'}">Test a test</button>
          <button role="tab" type="button" data-p="clasif" aria-selected="${pestana === 'clasif'}">Clasificación</button>
        </div>
        ${cargando ? '<p class="sub">Actualizando…</p>' : ''}
        ${!datos ? `<div class="tarjeta">${conectado ? 'Cargando…' : 'Sin conexión. Vuelve a intentarlo con internet.'}</div>`
          : pestana === 'notas' ? htmlNotas(datos.historial) : htmlClasificacion(datos.clasificacion)}
        <button class="btn secundario bloque" type="button" data-volver>Volver</button>
      </section>`;
    $app.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { pestana = b.dataset.p; pintar(datos, false); }; });
    $app.querySelector('[data-volver]').onclick = () => {
      if (r) { vista = null; tick(true); } else pintarEntrada();
    };
  };
  const cache = lsGet(LS_HIST);
  pintar(cache, true);
  try {
    const [historial, clasificacion] = await Promise.all([
      rpc('mi_historial', { p_token: token }),
      rpc('mi_clasificacion', { p_token: token, p_top: 10 }),
    ]);
    const datos = { historial, clasificacion };
    lsSet(LS_HIST, datos);
    marcarConexion(true);
    pintar(datos, false);
  } catch (e) {
    if (e instanceof ErrorRed) marcarConexion(false);
    pintar(cache, false);
  }
}

function htmlNotas(h) {
  if (!h?.tests?.length) return '<div class="tarjeta">Aún no hay tests terminados en tu grupo.</div>';
  return `
    ${h.media_provisional != null ? `<div class="tarjeta centro"><span class="sub">Media de tus tests</span>
      <div class="nota">${nota2(h.media_provisional)}<small> / 10</small></div>
      <span class="sub">Provisional: la nota final la calcula el profesor.</span></div>` : ''}
    <ul class="lista">
      ${h.tests.slice().reverse().map((t) => `
        <li><span class="nom">${esc(t.titulo)}<span class="fecha">${new Date(t.fecha).toLocaleDateString('es-ES')}</span></span>
          <span class="val">${t.presentado ? nota2(t.nota) : 'No presentado'}</span></li>`).join('')}
    </ul>`;
}

function htmlClasificacion(c) {
  if (!c?.top?.length) return '<div class="tarjeta">Aún no hay clasificación.</div>';
  const yoEnTop = c.top.some((x) => x.yo);
  return `
    ${c.yo ? `<div class="tarjeta centro">Vas <strong>${c.yo.puesto}.º</strong> de ${c.total_alumnos}
      con <strong>${c.yo.puntos}</strong> puntos</div>` : ''}
    <ul class="lista">
      ${c.top.map((x) => `
        <li class="${x.yo ? 'yo' : ''}"><span class="pos">${x.puesto}</span>
          <span class="nom">${esc(x.nombre)}${x.yo ? ' (tú)' : ''}</span><span class="val">${x.puntos}</span></li>`).join('')}
      ${!yoEnTop && c.yo ? `<li class="yo"><span class="pos">${c.yo.puesto}</span><span class="nom">Tú</span>
        <span class="val">${c.yo.puntos}</span></li>` : ''}
    </ul>
    <p class="sub centro">Puntos por acertar y por rapidez. No cuentan para la nota.</p>`;
}

// ---------------------------------------------------------------- pantalla encendida

async function mantenerPantalla() {
  try {
    if ('wakeLock' in navigator && r && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* no soportado o denegado */ }
}

function liberarPantalla() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------------------------------------------------------------- arranque

async function iniciar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  const codigoUrl = extraerCodigo(new URLSearchParams(location.search).get('c') || '');
  try { r = (await kv.get('sesion')) ?? null; } catch { r = null; }
  // Viene con QR de otra sesión y la anterior ya acabó: empezar de cero.
  if (r && codigoUrl && codigoUrl !== r.codigo && fase().tipo === 'final') {
    await kv.del('sesion');
    r = null;
  }
  pintarConexion();
  if (r) arrancar();
  else pintarEntrada({ codigo: codigoUrl || '' });
  contarPendientes().then(sincronizar);
  setInterval(() => tick(), 250);

  window.addEventListener('online', () => alReconectar());
  window.addEventListener('offline', () => marcarConexion(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    mantenerPantalla();
    refrescar();
    sincronizar();
  });
}

iniciar();
