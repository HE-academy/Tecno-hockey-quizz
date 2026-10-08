import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { medirDesfase, aMs } from './api.js';
import {
  leerPreguntas, validarPregunta, claveDuplicado, leerCSVAlumnos, generarCSV, descargar,
} from './importar.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const LETRAS = 'ABCDE';

let desfase = 0;
const ahora = () => Date.now() + desfase;
let limpiarVista = () => {};

// ---------------------------------------------------------------- utilidades

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaCorta = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) : '');
const fechaLarga = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-ES') : '');
const nota2 = (n) => (n == null ? '' : Number(n).toLocaleString('es-ES', { maximumFractionDigits: 2 }));
const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nombreCorto = (a) => `${a.nombre}${a.apellidos ? ` ${a.apellidos[0]}.` : ''}`;

async function q(promesa) {
  const { data, error } = await promesa;
  if (error) throw new Error(traducirError(error.message));
  return data;
}

function traducirError(m) {
  const mapa = {
    no_autorizado: 'No tienes permiso de profesor.',
    sesion_no_editable: 'La sesión ya está lanzada: no se pueden cambiar las preguntas.',
    sesion_sin_preguntas: 'La sesión no tiene preguntas.',
    sesion_no_lanzable: 'La sesión ya estaba lanzada.',
    sesion_no_abierta: 'La sesión no está en la sala de espera.',
    turno_no_disponible: 'Esa pregunta ya se abrió.',
    preguntas_inexistentes_o_repetidas: 'Alguna pregunta no existe o está repetida.',
  };
  return Object.entries(mapa).find(([k]) => m.includes(k))?.[1] || m;
}

let toastT = null;
function toast(msg, tipo = '') {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: `toast ${tipo}`, textContent: msg });
  t.setAttribute('role', 'status');
  document.body.append(t);
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), tipo === 'error' ? 6000 : 3000);
}

async function intentar(fn, boton) {
  if (boton) boton.disabled = true;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || 'Algo ha fallado', 'error');
    return undefined;
  } finally {
    if (boton) boton.disabled = false;
  }
}

// PostgREST devuelve como mucho 1000 filas por petición.
async function todas(consulta) {
  const salida = [];
  for (let desde = 0; ; desde += 1000) {
    const lote = await q(consulta().range(desde, desde + 999));
    salida.push(...lote);
    if (lote.length < 1000) return salida;
  }
}

function leerArchivo(archivo) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(archivo, 'utf-8');
  });
}

// Navega; si ya estamos en esa ruta, vuelve a pintarla (no habrá hashchange).
function ir(hash) {
  if (location.hash === hash) enrutar();
  else location.hash = hash;
}

const cargarGrupos = () => q(sb.from('grupos').select('id, nombre').order('nombre'));

function selectorGrupo(grupos, actual, id = 'sel-grupo') {
  return `<select id="${id}">${grupos.map((g) => `<option value="${g.id}" ${g.id === actual ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('')}</select>`;
}

// ---------------------------------------------------------------- arranque y acceso

async function iniciar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return vistaLogin();
  let esProfe = false;
  try { esProfe = await q(sb.rpc('es_profe')); } catch { /* sin red */ }
  if (!esProfe) return vistaNoAutorizado(session.user.email);
  $nav.hidden = false;
  medirDesfase().then((d) => { desfase = d.desfase; }).catch(() => {});
  if (!iniciado) window.addEventListener('hashchange', enrutar);
  iniciado = true;
  enrutar();
}
let iniciado = false;

function vistaLogin(error = '') {
  $nav.hidden = true;
  $app.innerHTML = `
    <form class="caja login pantalla" id="form-login">
      <h1>Acceso <b>profesor</b></h1>
      <div class="campo"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
      <div class="campo"><label for="pass">Contraseña</label><input id="pass" type="password" autocomplete="current-password" required></div>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <button class="btn bloque" type="submit">Entrar</button>
      <p class="ayuda">¿Primera vez? Crea tu usuario en Supabase → Authentication → Users → Add user.
        El primer usuario creado queda como profesor.</p>
    </form>`;
  $app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const boton = e.target.querySelector('button');
    boton.disabled = true;
    const { error: err } = await sb.auth.signInWithPassword({
      email: e.target.email.value.trim(), password: e.target.pass.value,
    });
    if (err) return vistaLogin(/invalid/i.test(err.message) ? 'Email o contraseña incorrectos.' : err.message);
    iniciar();
  };
}

function vistaNoAutorizado(email) {
  $nav.hidden = true;
  $app.innerHTML = `
    <div class="caja login pantalla">
      <h1>Sin <b>permiso</b></h1>
      <p>${esc(email)} no está dado de alta como profesor.</p>
      <button class="btn secundario" type="button" id="b-salir">Salir</button>
    </div>`;
  $app.querySelector('#b-salir').onclick = async () => { await sb.auth.signOut(); vistaLogin(); };
}

document.getElementById('btn-salir').onclick = async (e) => {
  e.preventDefault();
  await sb.auth.signOut();
  location.hash = '';
  vistaLogin();
};

function enrutar() {
  limpiarVista();
  limpiarVista = () => {};
  const [ruta, ...args] = location.hash.replace(/^#\/?/, '').split('/');
  $nav.querySelectorAll('a[data-r]').forEach((a) => a.classList.toggle('activa', a.dataset.r === (ruta || 'sesiones')));
  const vistas = {
    sesiones: vistaSesiones, nueva: vistaNuevaSesion, preguntas: vistaPreguntas,
    grupos: vistaGrupos, notas: vistaNotas, proyector: vistaProyector,
  };
  window.scrollTo(0, 0);
  (vistas[ruta] || vistaSesiones)(...args);
}

// ---------------------------------------------------------------- sesiones

async function vistaSesiones(grupoFiltro = '') {
  const [grupos, sesiones] = await Promise.all([
    cargarGrupos(),
    q(sb.from('sesiones')
      .select('id, titulo, fecha, modo, estado, codigo, grupo_id, creada_en, grupos(nombre), sesion_preguntas(count)')
      .order('fecha', { ascending: false }).order('creada_en', { ascending: false })),
  ]);
  const lista = grupoFiltro ? sesiones.filter((s) => s.grupo_id === grupoFiltro) : sesiones;
  $app.innerHTML = `
    <div class="cab">
      <h1>Sesiones</h1>
      <select id="filtro" style="width:auto"><option value="">Todos los grupos</option>
        ${grupos.map((g) => `<option value="${g.id}" ${g.id === grupoFiltro ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('')}</select>
      <a class="btn" href="#/nueva">+ Nueva sesión</a>
    </div>
    ${!grupos.length ? '<div class="caja">Empieza creando un grupo y sus alumnos en <a href="#/grupos">Grupos y alumnos</a>.</div>' : ''}
    <div class="tabla-envoltorio">
      <table class="tabla">
        <thead><tr><th>Sesión</th><th>Grupo</th><th>Fecha</th><th>Modo</th><th class="num">Preg.</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${lista.map((s) => `
            <tr>
              <td><strong>${esc(s.titulo)}</strong>${s.codigo && s.estado !== 'finalizada' ? ` <span class="chip amarillo">${s.codigo}</span>` : ''}</td>
              <td>${esc(s.grupos?.nombre)}</td>
              <td>${fechaLarga(s.fecha)}</td>
              <td>${s.modo === 'fijo' ? 'Calendario' : 'Manual'}</td>
              <td class="num">${s.sesion_preguntas?.[0]?.count ?? 0}</td>
              <td><span class="estado ${s.estado}">${{ borrador: 'Borrador', abierta: 'Sala de espera', en_curso: 'En curso', finalizada: 'Finalizada' }[s.estado]}</span></td>
              <td><div class="acciones">
                ${s.estado === 'borrador' ? `<button class="btn peque" data-lanzar="${s.id}">Lanzar</button>` : ''}
                ${s.estado !== 'borrador' ? `<a class="btn peque oscuro" href="#/proyector/${s.id}">Proyector</a>` : ''}
                ${s.estado === 'finalizada' || s.estado === 'en_curso' ? `<a class="btn peque secundario" href="#/notas/${s.grupo_id}/${s.id}">Notas</a>` : ''}
                <button class="btn peque secundario" data-borrar="${s.id}" title="Borrar">✕</button>
              </div></td>
            </tr>`).join('') || '<tr><td colspan="7">No hay sesiones todavía.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  $app.querySelector('#filtro').onchange = (e) => vistaSesiones(e.target.value);
  $app.querySelectorAll('[data-lanzar]').forEach((b) => {
    b.onclick = () => intentar(async () => {
      await q(sb.rpc('lanzar_sesion', { p_sesion: b.dataset.lanzar }));
      location.hash = `#/proyector/${b.dataset.lanzar}`;
    }, b);
  });
  $app.querySelectorAll('[data-borrar]').forEach((b) => {
    b.onclick = () => {
      const s = sesiones.find((x) => x.id === b.dataset.borrar);
      const aviso = s.estado === 'finalizada' ? '\n\nSe borrarán también sus respuestas y notas.' : '';
      if (!confirm(`¿Borrar la sesión "${s.titulo}"?${aviso}`)) return;
      intentar(async () => {
        await q(sb.from('sesiones').delete().eq('id', s.id));
        toast('Sesión borrada');
        vistaSesiones(grupoFiltro);
      }, b);
    };
  });
}

async function vistaNuevaSesion() {
  const [grupos, preguntas] = await Promise.all([
    cargarGrupos(),
    todas(() => sb.from('preguntas').select('id, enunciado, etiquetas, opciones, correcta').order('creada_en', { ascending: false })),
  ]);
  if (!grupos.length) {
    $app.innerHTML = '<div class="caja">Antes crea un grupo en <a href="#/grupos">Grupos y alumnos</a>.</div>';
    return;
  }
  if (!preguntas.length) {
    $app.innerHTML = '<div class="caja">Antes importa o crea preguntas en <a href="#/preguntas">Preguntas</a>.</div>';
    return;
  }
  const etiquetas = [...new Set(preguntas.flatMap((p) => p.etiquetas))].sort();
  const elegidas = [];
  const porId = new Map(preguntas.map((p) => [p.id, p]));

  $app.innerHTML = `
    <div class="cab"><h1>Nueva sesión</h1><a class="btn secundario" href="#/sesiones">Cancelar</a></div>
    <form id="f" class="rejilla dos">
      <div class="caja pantalla">
        <h2>Datos</h2>
        <div class="campo"><label for="grupo">Grupo</label>${selectorGrupo(grupos, grupos[0].id, 'grupo')}</div>
        <div class="campo"><label for="titulo">Título</label><input id="titulo" type="text" value="Sesión ${fechaCorta(hoyISO())}" required></div>
        <div class="campo"><label>Modo de avance</label>
          <label class="check"><input type="radio" name="modo" value="fijo" checked> Calendario fijo · el móvil avanza solo aunque no haya red (recomendado en pista)</label>
          <label class="check"><input type="radio" name="modo" value="manual"> Manual · tú pasas cada pregunta (tipo Kahoot)</label>
        </div>
        <div class="fila">
          <div class="campo"><label for="tiempo">Segundos por pregunta</label><input id="tiempo" type="number" min="5" max="300" value="20"></div>
          <div class="campo"><label for="pausa">Pausa entre preguntas (s)</label><input id="pausa" type="number" min="0" max="120" value="8"></div>
        </div>
        <div class="campo"><label for="pen">Penalización por error</label>
          <select id="pen"><option value="0.25">−0,25 por error</option><option value="0">Sin penalización</option></select></div>
        <label class="check"><input type="checkbox" id="bar-preg"> Barajar el orden de las preguntas por alumno (solo calendario fijo)</label>
        <label class="check"><input type="checkbox" id="bar-op" checked> Barajar el orden de las opciones por alumno</label>
        <p class="ayuda">Con preguntas barajadas el proyector no puede enseñar la pregunta en curso ni la correcta hasta el final.</p>
      </div>
      <div class="caja pantalla">
        <h2>Preguntas <span class="chip" id="cuenta">0</span></h2>
        <div class="fila">
          <div class="campo"><label for="azar-et">Al azar de la etiqueta</label>
            <select id="azar-et"><option value="">Todas</option>${etiquetas.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
          <div class="campo" style="max-width:110px"><label for="azar-n">Cuántas</label><input id="azar-n" type="number" min="1" value="10"></div>
        </div>
        <button class="btn secundario" type="button" id="azar">Elegir al azar</button>
        <ol class="seleccion" id="seleccion"></ol>
        <details>
          <summary><strong>Elegir a mano</strong></summary>
          <div class="fila" style="margin:8px 0">
            <select id="man-et"><option value="">Todas las etiquetas</option>${etiquetas.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
            <input id="man-q" type="text" placeholder="Buscar…">
          </div>
          <ul class="lista-check" id="manual"></ul>
        </details>
      </div>
      <div class="acciones" style="grid-column:1/-1">
        <button class="btn" type="submit" data-lanzar="1">Guardar y lanzar</button>
        <button class="btn secundario" type="submit">Guardar como borrador</button>
      </div>
    </form>`;

  const $f = $app.querySelector('#f');
  const $sel = $f.querySelector('#seleccion');
  const pintarSeleccion = () => {
    $f.querySelector('#cuenta').textContent = elegidas.length;
    $sel.innerHTML = elegidas.map((id, i) => `<li>${esc(porId.get(id).enunciado)} <button type="button" data-quitar="${i}" title="Quitar">✕</button></li>`).join('');
    $sel.querySelectorAll('[data-quitar]').forEach((b) => { b.onclick = () => { elegidas.splice(Number(b.dataset.quitar), 1); pintarSeleccion(); pintarManual(); }; });
  };
  const pintarManual = () => {
    const et = $f.querySelector('#man-et').value;
    const txt = claveDuplicado($f.querySelector('#man-q').value);
    const vis = preguntas.filter((p) => (!et || p.etiquetas.includes(et)) && (!txt || claveDuplicado(p.enunciado).includes(txt))).slice(0, 300);
    $f.querySelector('#manual').innerHTML = vis.map((p) => `
      <li><label><input type="checkbox" value="${p.id}" ${elegidas.includes(p.id) ? 'checked' : ''}>
        <span>${esc(p.enunciado)} ${p.etiquetas.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</span></label></li>`).join('');
    $f.querySelectorAll('#manual input').forEach((c) => {
      c.onchange = () => {
        const i = elegidas.indexOf(c.value);
        if (c.checked && i < 0) elegidas.push(c.value);
        if (!c.checked && i >= 0) elegidas.splice(i, 1);
        pintarSeleccion();
      };
    });
  };
  $f.querySelector('#man-et').onchange = pintarManual;
  $f.querySelector('#man-q').oninput = pintarManual;
  $f.querySelector('#azar').onclick = () => {
    const et = $f.querySelector('#azar-et').value;
    const n = Math.max(1, Number($f.querySelector('#azar-n').value) || 10);
    const pool = preguntas.filter((p) => !et || p.etiquetas.includes(et)).map((p) => p.id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    elegidas.splice(0, elegidas.length, ...pool.slice(0, n));
    if (pool.length < n) toast(`Solo hay ${pool.length} preguntas con esa etiqueta`);
    pintarSeleccion();
    pintarManual();
  };
  const sincronizarModo = () => {
    const manual = $f.querySelector('input[name=modo]:checked').value === 'manual';
    const c = $f.querySelector('#bar-preg');
    c.disabled = manual;
    if (manual) c.checked = false;
  };
  $f.querySelectorAll('input[name=modo]').forEach((r) => { r.onchange = sincronizarModo; });
  pintarSeleccion();
  pintarManual();

  $f.onsubmit = (e) => {
    e.preventDefault();
    const lanzar = e.submitter?.dataset.lanzar === '1';
    if (!elegidas.length) return toast('Elige al menos una pregunta', 'error');
    intentar(async () => {
      const modo = $f.querySelector('input[name=modo]:checked').value;
      const s = await q(sb.from('sesiones').insert({
        grupo_id: $f.querySelector('#grupo').value,
        titulo: $f.querySelector('#titulo').value.trim() || `Sesión ${fechaCorta(hoyISO())}`,
        modo,
        tiempo_s: Number($f.querySelector('#tiempo').value) || 20,
        pausa_s: Number($f.querySelector('#pausa').value) || 0,
        penalizacion: Number($f.querySelector('#pen').value),
        barajar_preguntas: modo === 'fijo' && $f.querySelector('#bar-preg').checked,
        barajar_opciones: $f.querySelector('#bar-op').checked,
      }).select('id').single());
      await q(sb.rpc('asignar_preguntas', { p_sesion: s.id, p_preguntas: elegidas }));
      if (lanzar) {
        await q(sb.rpc('lanzar_sesion', { p_sesion: s.id }));
        location.hash = `#/proyector/${s.id}`;
      } else {
        toast('Sesión guardada');
        location.hash = '#/sesiones';
      }
    }, e.submitter);
  };
}

// ---------------------------------------------------------------- proyector

async function vistaProyector(id) {
  const capa = document.createElement('div');
  capa.className = 'proyector';
  document.body.append(capa);
  let vivo = true;
  let temporizador = null;
  let clave = null;
  let s = null;
  let sp = [];
  let nombres = [];
  const reparto = {};        // turno -> [nA, nB, nC, nD, nE]
  let rankingTurno = -1;
  let ranking = null;
  let clasif = null;
  let respondidas = 0;
  let participantes = 0;

  const salirProyector = () => { vivo = false; clearTimeout(temporizador); capa.remove(); document.removeEventListener('keydown', teclas); };
  limpiarVista = salirProyector;
  const urlAlumno = () => `${new URL('./', location.href).href}?c=${s.codigo}`;

  function teclas(e) {
    if (e.key === 'f' || e.key === 'F') pantallaCompleta();
    if ((e.key === 'ArrowRight' || e.key === ' ') && s?.modo === 'manual') { e.preventDefault(); capa.querySelector('[data-sig]')?.click(); }
  }
  document.addEventListener('keydown', teclas);
  const pantallaCompleta = () => (document.fullscreenElement ? document.exitFullscreen() : capa.requestFullscreen?.()).catch?.(() => {});

  async function cargar() {
    [s, sp] = await Promise.all([
      q(sb.from('sesiones').select('*, grupos(nombre)').eq('id', id).single()),
      q(sb.from('sesion_preguntas').select('posicion, enunciado, opciones, correcta, explicacion, abierta_en, cierra_en').eq('sesion_id', id).order('posicion')),
    ]);
  }

  function fase() {
    if (s.estado === 'borrador') return { tipo: 'borrador' };
    if (s.estado === 'abierta') return { tipo: 'sala' };
    if (s.estado === 'finalizada') return { tipo: 'fin' };
    const t = ahora();
    const v = sp.filter((x) => x.abierta_en).map((x) => ({ turno: x.posicion, abre: aMs(x.abierta_en), cierra: aMs(x.cierra_en) }));
    const abierta = v.find((x) => t >= x.abre && t < x.cierra);
    if (abierta) return { tipo: 'pregunta', ...abierta };
    const proxima = v.find((x) => t < x.abre);
    if (proxima && proxima.turno === 0) return { tipo: 'cuenta', hasta: proxima.abre };
    const cerradas = v.filter((x) => t >= x.cierra);
    const ultima = cerradas[cerradas.length - 1];
    if (!ultima) return { tipo: 'cuenta', hasta: null };
    const esUltima = ultima.turno === sp.length - 1;
    return { tipo: esUltima ? 'acabada' : 'entre', turno: ultima.turno, cierra: ultima.cierra, hasta: proxima?.abre ?? null };
  }

  async function bucle() {
    if (!vivo) return;
    try {
      await cargar();
      const f = fase();
      if (f.tipo === 'sala') {
        const ps = await q(sb.from('participaciones').select('alumnos(nombre, apellidos)').eq('sesion_id', id));
        nombres = ps.map((p) => nombreCorto(p.alumnos)).sort((a, b) => a.localeCompare(b, 'es'));
      }
      if (f.tipo === 'pregunta' || f.tipo === 'entre' || f.tipo === 'acabada') {
        const [{ count: c1 }, { count: c2 }] = await Promise.all([
          sb.from('respuestas').select('id', { count: 'exact', head: true }).eq('sesion_id', id).eq('turno', f.turno ?? 0),
          sb.from('participaciones').select('id', { count: 'exact', head: true }).eq('sesion_id', id),
        ]);
        respondidas = c1 ?? 0;
        participantes = c2 ?? 0;
      }
      if ((f.tipo === 'entre' || f.tipo === 'acabada') && !s.barajar_preguntas) {
        const filas = await q(sb.from('respuestas').select('opcion')
          .eq('sesion_id', id).eq('posicion', f.turno).eq('aceptada', true).eq('anulada', false));
        const n = [0, 0, 0, 0, 0];
        filas.forEach((x) => { n[x.opcion] += 1; });
        reparto[f.turno] = n;
        // El servidor solo puntúa preguntas reveladas (cierre + 2 s): pedir el ranking después.
        if (rankingTurno !== f.turno && ahora() > f.cierra + 2600) {
          ranking = await q(sb.rpc('ranking_sesion', { p_sesion: id, p_limite: 5 }));
          rankingTurno = f.turno;
        }
      }
      if (f.tipo === 'fin' && !clasif) {
        [ranking, clasif] = await Promise.all([
          q(sb.rpc('ranking_sesion', { p_sesion: id, p_limite: 10 })),
          q(sb.rpc('clasificacion_grupo', { p_grupo: s.grupo_id })),
        ]);
        clave = null;
      }
      pintar(f);
    } catch (e) {
      console.error(e);
    }
    temporizador = setTimeout(bucle, 1000);
  }

  // Reloj fluido entre recargas de datos.
  const reloj = setInterval(() => {
    if (!vivo) return clearInterval(reloj);
    if (s) actualizarReloj(fase());
  }, 200);

  function actualizarReloj(f) {
    const $r = capa.querySelector('[data-reloj]');
    if ($r && f.tipo === 'pregunta') {
      const seg = Math.max(0, Math.ceil((f.cierra - ahora()) / 1000));
      $r.textContent = seg;
      $r.classList.toggle('urgente', seg <= 5);
    }
    const $c = capa.querySelector('[data-cuenta]');
    if ($c && f.hasta) $c.textContent = Math.max(0, Math.ceil((f.hasta - ahora()) / 1000));
    const $n = capa.querySelector('[data-resp]');
    if ($n) $n.textContent = `${respondidas} de ${participantes} han respondido`;
    // Cambio de fase (o momento de revelar) por el reloj, sin esperar a la recarga de datos.
    if (claveDe(f) !== clave) pintar(f);
  }

  // La correcta se enseña a los 2 s del cierre: el mismo margen que tienen los
  // móviles para que llegue una respuesta dada en el último segundo.
  const revelar = (f) => (f.tipo === 'entre' || f.tipo === 'acabada') && !s.barajar_preguntas && ahora() >= f.cierra + 2000;

  function claveDe(f) {
    const base = `${f.tipo}:${f.turno ?? ''}`;
    if (f.tipo !== 'entre' && f.tipo !== 'acabada') return base;
    return `${base}:${revelar(f) ? 1 : 0}:${(reparto[f.turno] || []).join(',')}:${rankingTurno === f.turno ? 1 : 0}`;
  }

  function actualizarSala() {
    const $c = capa.querySelector('.p-cuantos');
    if ($c) $c.textContent = `${nombres.length} conectado${nombres.length === 1 ? '' : 's'}`;
    const $n = capa.querySelector('.p-nombres');
    if ($n) $n.innerHTML = nombres.map((x) => `<span>${esc(x)}</span>`).join('');
  }

  function barra() {
    return `<div class="p-barra">
      <span class="titulo">${esc(s.titulo)} · ${esc(s.grupos?.nombre)}</span>
      ${s.estado === 'en_curso' || s.estado === 'abierta' ? '<button class="btn oscuro" type="button" data-terminar>Terminar sesión</button>' : ''}
      <button class="btn oscuro" type="button" data-pc title="Pantalla completa (F)">⛶</button>
      <button class="btn" type="button" data-cerrar>Salir del proyector</button>
    </div>`;
  }

  function opcionesHTML(q0, rev) {
    const total = rev ? rev.reparto.reduce((a, b) => a + b, 0) || 1 : 1;
    return `<ul class="p-opciones">${q0.opciones.map((o, i) => `
      <li class="p-op${rev?.revelada && rev.correcta === i ? ' correcta' : ''}" data-i="${i}">
        ${rev ? `<span class="barra-r" style="width:${(100 * rev.reparto[i]) / total}%"></span>` : ''}
        <span class="letra">${LETRAS[i]}</span><span>${esc(o)}</span>
        ${rev ? `<span class="n">${rev.reparto[i]}</span>` : ''}
      </li>`).join('')}</ul>`;
  }

  function rankingHTML(lista, campo = 'puntos') {
    if (!lista?.length) return '';
    return `<ol class="p-ranking">${lista.map((r, i) => `
      <li><span class="pos">${r.puesto ?? i + 1}</span><span class="nom">${esc(nombreCorto(r))}</span><span class="pts">${r[campo]}</span></li>`).join('')}</ol>`;
  }

  function pintar(f) {
    const nueva = claveDe(f);
    if (nueva === clave) return f.tipo === 'sala' ? actualizarSala() : actualizarReloj(f);
    clave = nueva;
    let cuerpo = '';
    const n = sp.length;
    if (f.tipo === 'borrador') {
      cuerpo = `<div class="p-centro"><p class="p-grande">Sin lanzar</p>
        <button class="btn" type="button" data-lanzar>Lanzar sesión</button></div>`;
    } else if (f.tipo === 'sala') {
      const qr = window.qrcode(0, 'M');
      qr.addData(urlAlumno());
      qr.make();
      const base = new URL('./', location.href);
      cuerpo = `<div class="p-sala">
          <div class="p-qr">${qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true })}</div>
          <div>
            <p class="p-url">Escanea el QR o entra en <b>${esc(base.host + base.pathname)}</b> con el código</p>
            <div class="p-codigo">${s.codigo}</div>
            <div class="p-cuantos">${nombres.length} conectado${nombres.length === 1 ? '' : 's'}</div>
            <div class="p-nombres">${nombres.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
          </div>
        </div>
        <div class="p-pie">
          <button class="btn" type="button" data-empezar>Empezar (${n} preguntas)</button>
          <button class="btn secundario" type="button" data-pc>Pantalla completa</button>
        </div>`;
    } else if (f.tipo === 'cuenta') {
      cuerpo = `<div class="p-centro"><p class="p-num">¡Preparados!</p><p class="p-grande" data-cuenta>…</p></div>`;
    } else if (f.tipo === 'pregunta') {
      const q0 = sp[f.turno];
      cuerpo = `<div class="p-cabeza"><span class="p-num">Pregunta ${f.turno + 1} de ${n}</span><span class="p-reloj" data-reloj>--</span></div>
        ${s.barajar_preguntas
          ? '<div class="p-centro"><p class="p-grande">Responde en tu móvil</p><p class="p-num">Cada alumno tiene las preguntas en un orden distinto.</p></div>'
          : `<p class="p-enunciado">${esc(q0.enunciado)}</p>${opcionesHTML(q0, null)}`}
        <div class="p-pie"><span class="p-respondido" data-resp></span>
          ${s.modo === 'manual' ? '<button class="btn oscuro" type="button" data-cerrarya>Cerrar ya</button>' : ''}</div>`;
    } else if (f.tipo === 'entre' || f.tipo === 'acabada') {
      const q0 = sp[f.turno];
      const rev = revelar(f)
        ? { revelada: true, correcta: q0.correcta, explicacion: q0.explicacion, reparto: reparto[f.turno] || [0, 0, 0, 0, 0] }
        : null;
      const siguiente = f.tipo === 'entre'
        ? (s.modo === 'manual'
          ? '<button class="btn" type="button" data-sig>Siguiente pregunta →</button>'
          : '<span class="p-num">Siguiente en <span data-cuenta>…</span> s</span>')
        : '<button class="btn" type="button" data-finalizar>Terminar y guardar notas</button>';
      cuerpo = `<div class="p-cabeza"><span class="p-num">Pregunta ${f.turno + 1} de ${n}</span><span class="p-respondido" data-resp></span></div>
        ${s.barajar_preguntas
          ? '<div class="p-centro"><p class="p-grande">Tiempo</p><p class="p-num">Las respuestas correctas se verán al final.</p></div>'
          : `<p class="p-enunciado">${esc(q0.enunciado)}</p>
             <div class="${rev?.revelada ? 'p-revelado' : ''}">${opcionesHTML(q0, rev?.revelada ? rev : null)}</div>
             ${rev?.revelada && rev.explicacion ? `<p class="p-explicacion">${esc(rev.explicacion)}</p>` : ''}
             ${rev?.revelada && rankingTurno === f.turno && ranking?.length ? `<h2>Top 5</h2>${rankingHTML(ranking)}` : ''}`}
        <div class="p-pie">${siguiente}</div>`;
    } else if (f.tipo === 'fin') {
      cuerpo = `<div class="rejilla dos">
          <div><h2>Ranking de hoy</h2>${rankingHTML(ranking) || '<p>Sin respuestas.</p>'}</div>
          <div><h2>Clasificación general · ${esc(s.grupos?.nombre)}</h2>${rankingHTML(clasif?.slice(0, 10)) || '<p>—</p>'}</div>
        </div>
        <div class="p-pie">
          <a class="btn" href="#/notas/${s.grupo_id}/${s.id}" data-cerrar-nav>Ver notas</a>
        </div>`;
    }
    capa.innerHTML = `${barra()}<div class="p-cuerpo">${cuerpo}</div>`;
    capa.querySelector('[data-cerrar]').onclick = () => ir('#/sesiones');
    capa.querySelectorAll('[data-pc]').forEach((b) => { b.onclick = pantallaCompleta; });
    capa.querySelector('[data-lanzar]')?.addEventListener('click', (e) => intentar(async () => {
      await q(sb.rpc('lanzar_sesion', { p_sesion: id })); clave = null; await bucle0();
    }, e.target));
    capa.querySelector('[data-empezar]')?.addEventListener('click', (e) => intentar(async () => {
      if (!nombres.length && !confirm('Todavía no hay nadie conectado. ¿Empezar igualmente?')) return;
      await q(sb.rpc('iniciar_sesion', { p_sesion: id, p_espera_s: 5 })); clave = null; await bucle0();
    }, e.target));
    capa.querySelector('[data-cerrarya]')?.addEventListener('click', (e) => intentar(async () => {
      await q(sb.rpc('cerrar_pregunta', { p_sesion: id, p_turno: f.turno })); clave = null; await bucle0();
    }, e.target));
    capa.querySelector('[data-sig]')?.addEventListener('click', (e) => intentar(async () => {
      await q(sb.rpc('abrir_pregunta', { p_sesion: id, p_turno: f.turno + 1 })); clave = null; await bucle0();
    }, e.target));
    capa.querySelector('[data-finalizar]')?.addEventListener('click', (e) => intentar(async () => {
      await q(sb.rpc('finalizar_sesion', { p_sesion: id })); clave = null; await bucle0();
    }, e.target));
    capa.querySelector('[data-terminar]')?.addEventListener('click', (e) => {
      if (!confirm('¿Terminar la sesión ahora? Las preguntas que falten contarán como no respondidas.')) return;
      intentar(async () => { await q(sb.rpc('finalizar_sesion', { p_sesion: id })); clave = null; await bucle0(); }, e.target);
    });
    actualizarReloj(f);
  }

  async function bucle0() {
    clearTimeout(temporizador);
    await bucle();
  }

  try {
    await cargar();
  } catch (e) {
    capa.innerHTML = `<div class="p-centro"><p class="error">${esc(e.message)}</p><a class="btn" href="#/sesiones">Volver</a></div>`;
    return;
  }
  bucle();
}

// ---------------------------------------------------------------- preguntas

function editorPregunta(p, alGuardar) {
  const d = document.createElement('dialog');
  const v = p || { enunciado: '', opciones: ['', '', '', '', ''], correcta: 0, explicacion: '', etiquetas: [], dificultad: null };
  d.innerHTML = `
    <form method="dialog">
      <h2>${p ? 'Editar' : 'Nueva'} pregunta</h2>
      <div class="campo"><label for="e-enun">Enunciado</label><textarea id="e-enun" required>${esc(v.enunciado)}</textarea></div>
      <label>Opciones (marca la correcta)</label>
      ${v.opciones.map((o, i) => `
        <div class="opcion-edit">
          <input type="radio" name="correcta" value="${i}" ${v.correcta === i ? 'checked' : ''} aria-label="Correcta ${LETRAS[i]}">
          <span class="letra-e" style="background:var(--op-${'abcde'[i]});${i === 4 ? 'color:var(--marino)' : ''}">${LETRAS[i]}</span>
          <input type="text" data-op="${i}" value="${esc(o)}" required>
        </div>`).join('')}
      <div class="campo"><label for="e-exp">Explicación (se ve al cerrar la pregunta)</label><textarea id="e-exp">${esc(v.explicacion)}</textarea></div>
      <div class="fila">
        <div class="campo"><label for="e-et">Etiquetas (separadas por comas)</label><input id="e-et" type="text" value="${esc(v.etiquetas.join(', '))}"></div>
        <div class="campo" style="max-width:140px"><label for="e-dif">Dificultad</label>
          <select id="e-dif"><option value="">—</option>${[1, 2, 3, 4, 5].map((x) => `<option ${v.dificultad === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
      <p class="error" hidden></p>
      <div class="acciones"><button class="btn" value="ok">Guardar</button><button class="btn secundario" value="cancel" formnovalidate>Cancelar</button></div>
    </form>`;
  document.body.append(d);
  d.showModal();
  d.querySelector('form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const { pregunta, errores } = validarPregunta({
      enunciado: d.querySelector('#e-enun').value,
      opciones: [...d.querySelectorAll('[data-op]')].map((x) => x.value),
      correcta_ok: Number(d.querySelector('input[name=correcta]:checked')?.value ?? -1),
      explicacion: d.querySelector('#e-exp').value,
      etiquetas: d.querySelector('#e-et').value,
      dificultad: d.querySelector('#e-dif').value,
    });
    const $err = d.querySelector('.error');
    if (errores.length) { $err.textContent = errores.join('; '); $err.hidden = false; return; }
    const ok = await intentar(async () => {
      if (p) await q(sb.from('preguntas').update(pregunta).eq('id', p.id));
      else await q(sb.from('preguntas').insert(pregunta));
      return true;
    }, e.submitter);
    if (ok) { d.close(); toast('Pregunta guardada'); alGuardar(); }
  };
  d.addEventListener('close', () => d.remove());
}

async function vistaPreguntas() {
  const preguntas = await todas(() => sb.from('preguntas').select('*').order('creada_en', { ascending: false }));
  const etiquetas = [...new Set(preguntas.flatMap((p) => p.etiquetas))].sort();
  $app.innerHTML = `
    <div class="cab">
      <h1>Banco de preguntas <span class="chip">${preguntas.length}</span></h1>
      <button class="btn" type="button" id="nueva">+ Nueva</button>
      <label class="btn oscuro" style="margin:0">Importar XML / CSV / JSON<input type="file" id="fichero" accept=".xml,.csv,.json,.txt" hidden></label>
      <a class="btn secundario" href="preguntas_ejemplo.csv" download>CSV de ejemplo</a>
    </div>
    <div id="importacion"></div>
    <div class="caja">
      <div class="fila" style="margin-bottom:12px">
        <select id="f-et"><option value="">Todas las etiquetas</option>${etiquetas.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
        <input id="f-q" type="text" placeholder="Buscar en el enunciado…">
      </div>
      <div class="acciones" style="margin-bottom:8px"><span class="ayuda" id="mostrando"></span>
        <button class="btn peque secundario" type="button" id="borrar-filtradas">Borrar las filtradas</button></div>
      <div class="tabla-envoltorio scroll"><table class="tabla">
        <thead><tr><th>Enunciado</th><th>Correcta</th><th>Etiquetas</th><th class="num">Dif.</th><th></th></tr></thead>
        <tbody id="filas"></tbody></table></div>
    </div>`;
  let filtradas = preguntas;
  const pintarFilas = () => {
    const et = $app.querySelector('#f-et').value;
    const txt = claveDuplicado($app.querySelector('#f-q').value);
    filtradas = preguntas.filter((p) => (!et || p.etiquetas.includes(et)) && (!txt || p.clave_duplicado.includes(txt)));
    $app.querySelector('#mostrando').textContent = `${filtradas.length} pregunta${filtradas.length === 1 ? '' : 's'}${filtradas.length > 300 ? ' (se muestran 300)' : ''}`;
    $app.querySelector('#filas').innerHTML = filtradas.slice(0, 300).map((p) => `
      <tr><td class="corto">${esc(p.enunciado)}</td>
        <td class="corto"><strong>${LETRAS[p.correcta]}</strong> · ${esc(p.opciones[p.correcta])}</td>
        <td>${p.etiquetas.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td>
        <td class="num">${p.dificultad ?? ''}</td>
        <td><div class="acciones"><button class="btn peque secundario" data-ed="${p.id}">Editar</button>
          <button class="btn peque secundario" data-bo="${p.id}" title="Borrar">✕</button></div></td></tr>`).join('')
      || '<tr><td colspan="5">No hay preguntas. Importa tu banco de Moodle o un CSV.</td></tr>';
    $app.querySelectorAll('[data-ed]').forEach((b) => { b.onclick = () => editorPregunta(preguntas.find((p) => p.id === b.dataset.ed), vistaPreguntas); });
    $app.querySelectorAll('[data-bo]').forEach((b) => {
      b.onclick = () => {
        if (!confirm('¿Borrar esta pregunta del banco? Las sesiones ya hechas conservan su copia.')) return;
        intentar(async () => { await q(sb.from('preguntas').delete().eq('id', b.dataset.bo)); vistaPreguntas(); }, b);
      };
    });
  };
  $app.querySelector('#f-et').onchange = pintarFilas;
  $app.querySelector('#f-q').oninput = pintarFilas;
  $app.querySelector('#nueva').onclick = () => editorPregunta(null, vistaPreguntas);
  $app.querySelector('#borrar-filtradas').onclick = (e) => {
    if (!filtradas.length || !confirm(`¿Borrar ${filtradas.length} preguntas del banco?`)) return;
    intentar(async () => {
      const ids = filtradas.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 200) await q(sb.from('preguntas').delete().in('id', ids.slice(i, i + 200)));
      toast(`${ids.length} preguntas borradas`);
      vistaPreguntas();
    }, e.target);
  };
  $app.querySelector('#fichero').onchange = async (e) => {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    let leidas;
    try {
      leidas = leerPreguntas(archivo.name, await leerArchivo(archivo));
    } catch (err) {
      return toast(`No se ha podido leer el fichero: ${err.message}`, 'error');
    }
    previsualizarImportacion(archivo.name, leidas, new Set(preguntas.map((p) => p.clave_duplicado)));
  };
  pintarFilas();
}

function previsualizarImportacion(nombre, leidas, existentes) {
  const vistas = new Set();
  const filas = leidas.map((x) => {
    const { pregunta, errores } = validarPregunta(x);
    const clave = claveDuplicado(pregunta.enunciado);
    let estado = 'ok';
    if (errores.length) estado = 'error';
    else if (existentes.has(clave)) estado = 'duplicada';
    else if (vistas.has(clave)) estado = 'repetida';
    vistas.add(clave);
    return { pregunta, errores, estado };
  });
  const validas = filas.filter((f) => f.estado === 'ok');
  const cuenta = (e) => filas.filter((f) => f.estado === e).length;
  const $imp = $app.querySelector('#importacion');
  $imp.innerHTML = `
    <div class="caja">
      <h2>Vista previa · ${esc(nombre)}</h2>
      <p><strong>${validas.length}</strong> listas para importar · ${cuenta('duplicada')} ya están en el banco ·
        ${cuenta('repetida')} repetidas en el fichero · <strong>${cuenta('error')}</strong> con errores</p>
      <div class="fila" style="max-width:640px;margin-bottom:12px">
        <div class="campo"><label for="imp-et">Añadir etiqueta a todas (opcional)</label><input id="imp-et" type="text" placeholder="p. ej. pase"></div>
      </div>
      <div class="tabla-envoltorio scroll"><table class="tabla">
        <thead><tr><th>Estado</th><th>Enunciado</th><th>Correcta</th><th>Etiquetas</th></tr></thead>
        <tbody>${filas.map((f) => `
          <tr class="${f.estado === 'error' ? 'error' : f.estado === 'ok' ? '' : 'aviso'}">
            <td>${{ ok: '✓ OK', duplicada: 'Ya existe', repetida: 'Repetida', error: `✕ ${esc(f.errores.join('; '))}` }[f.estado]}</td>
            <td class="corto">${esc(f.pregunta.enunciado)}</td>
            <td class="corto">${f.pregunta.correcta != null && f.pregunta.opciones[f.pregunta.correcta] ? `${LETRAS[f.pregunta.correcta]} · ${esc(f.pregunta.opciones[f.pregunta.correcta])}` : '—'}</td>
            <td>${f.pregunta.etiquetas.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="acciones" style="margin-top:12px">
        <button class="btn" type="button" id="imp-ok" ${validas.length ? '' : 'disabled'}>Importar ${validas.length} preguntas</button>
        <button class="btn secundario" type="button" id="imp-no">Descartar</button>
      </div>
    </div>`;
  $imp.querySelector('#imp-no').onclick = () => { $imp.innerHTML = ''; };
  $imp.querySelector('#imp-ok').onclick = (e) => intentar(async () => {
    const extra = $imp.querySelector('#imp-et').value.trim().toLowerCase();
    const filasIns = validas.map((f) => ({
      ...f.pregunta,
      etiquetas: extra && !f.pregunta.etiquetas.includes(extra) ? [...f.pregunta.etiquetas, extra] : f.pregunta.etiquetas,
    }));
    for (let i = 0; i < filasIns.length; i += 200) await q(sb.from('preguntas').insert(filasIns.slice(i, i + 200)));
    toast(`${filasIns.length} preguntas importadas`);
    vistaPreguntas();
  }, e.target);
  $imp.scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------- grupos y alumnos

async function vistaGrupos(grupoId) {
  const grupos = await cargarGrupos();
  const actual = grupos.find((g) => g.id === grupoId)?.id || grupos[0]?.id;
  const alumnos = actual ? await q(sb.from('alumnos').select('id, id_alumno, nombre, apellidos, email, pin_hash').eq('grupo_id', actual).order('apellidos').order('nombre')) : [];
  $app.innerHTML = `
    <div class="cab"><h1>Grupos y alumnos</h1></div>
    <div class="caja">
      <form class="acciones" id="f-grupo">
        ${grupos.length ? `<div style="flex:1 1 220px">${selectorGrupo(grupos, actual)}</div>` : ''}
        <input id="nuevo-grupo" type="text" placeholder="Nombre del grupo nuevo (p. ej. DC2 · Grupo 1)" style="flex:1 1 260px">
        <button class="btn" type="submit">+ Crear grupo</button>
      </form>
    </div>
    ${actual ? `
    <div class="caja">
      <div class="cab" style="margin-bottom:8px">
        <h2 style="flex:1;margin:0">${alumnos.length} alumnos</h2>
        <label class="btn oscuro peque" style="margin:0">Importar alumnos (CSV)<input type="file" id="csv-alumnos" accept=".csv,.txt" hidden></label>
        <button class="btn peque" type="button" id="pines-nuevos">Generar PIN a quien no tenga</button>
        <button class="btn peque secundario" type="button" id="pines-todos">Regenerar todos los PIN</button>
        <button class="btn peque secundario" type="button" id="renombrar-grupo">Renombrar</button>
        <button class="btn peque secundario" type="button" id="borrar-grupo">Borrar grupo</button>
      </div>
      <p class="ayuda">Los alumnos se registran solos la primera vez que entran con el código de una sesión de este grupo
        (nombre, apellidos, email de TecnoCampus y un PIN que eligen). Si alguien olvida el PIN, pulsa "Nuevo PIN" y dáselo.
        Importar un CSV (<code>id_alumno, nombre, apellidos, email</code>, o la lista de participantes de Moodle) es opcional.</p>
      <div id="zona-pines"></div>
      <div id="zona-import"></div>
      <div class="tabla-envoltorio scroll" style="margin-top:12px"><table class="tabla">
        <thead><tr><th>Id</th><th>Apellidos, nombre</th><th>Email</th><th>PIN</th><th></th></tr></thead>
        <tbody>${alumnos.map((a) => `
          <tr><td>${esc(a.id_alumno)}</td><td>${esc(a.apellidos)}${a.apellidos ? ', ' : ''}${esc(a.nombre)}</td><td>${esc(a.email)}</td>
            <td>${a.pin_hash ? '✓' : '<span class="chip amarillo">sin PIN</span>'}</td>
            <td><div class="acciones"><button class="btn peque secundario" data-pin="${a.id}">Nuevo PIN</button>
              <button class="btn peque secundario" data-borrar="${a.id}" title="Borrar">✕</button></div></td></tr>`).join('')
          || '<tr><td colspan="5">Sin alumnos. Importa un CSV.</td></tr>'}</tbody></table></div>
    </div>` : '<div class="caja">Crea un grupo por clase.</div>'}`;

  $app.querySelector('#sel-grupo')?.addEventListener('change', (e) => { location.hash = `#/grupos/${e.target.value}`; });
  $app.querySelector('#f-grupo').onsubmit = (e) => {
    e.preventDefault();
    const nombre = $app.querySelector('#nuevo-grupo').value.trim();
    if (!nombre) return;
    intentar(async () => {
      const g = await q(sb.from('grupos').insert({ nombre }).select('id').single());
      toast('Grupo creado');
      ir(`#/grupos/${g.id}`);
    }, e.submitter);
  };
  if (!actual) return;

  const mostrarPines = (lista) => {
    const $z = $app.querySelector('#zona-pines');
    if (!lista.length) { toast('Todos los alumnos tienen PIN'); return; }
    $z.innerHTML = `
      <div class="caja" style="background:var(--fondo)">
        <p class="exito no-imprimir">PIN generados. Descárgalos o imprímelos ahora: después no se pueden volver a ver (solo regenerar).</p>
        <div class="acciones no-imprimir" style="margin:10px 0">
          <button class="btn peque" type="button" id="pin-csv">Descargar CSV</button>
          <button class="btn peque secundario" type="button" id="pin-print">Imprimir tarjetas</button>
        </div>
        <div class="pines">${lista.map((p) => `
          <div class="pin-tarjeta">${esc(p.apellidos)}${p.apellidos ? ', ' : ''}${esc(p.nombre)}<br>
            Id: <strong>${esc(p.id_alumno)}</strong><br>PIN: <b>${p.pin}</b></div>`).join('')}</div>
      </div>`;
    $z.querySelector('#pin-csv').onclick = () => descargar(`pines-${grupos.find((g) => g.id === actual).nombre}.csv`,
      generarCSV([['id_alumno', 'nombre', 'apellidos', 'email', 'pin'], ...lista.map((p) => [p.id_alumno, p.nombre, p.apellidos, p.email, p.pin])]));
    $z.querySelector('#pin-print').onclick = () => window.print();
    $z.scrollIntoView({ behavior: 'smooth' });
  };

  $app.querySelector('#pines-nuevos').onclick = (e) => intentar(async () => {
    mostrarPines(await q(sb.rpc('generar_pines', { p_grupo: actual, p_solo_sin_pin: true })));
  }, e.target);
  $app.querySelector('#pines-todos').onclick = (e) => {
    if (!confirm('Se cambiará el PIN de TODOS los alumnos del grupo. ¿Seguir?')) return;
    intentar(async () => mostrarPines(await q(sb.rpc('generar_pines', { p_grupo: actual, p_solo_sin_pin: false }))), e.target);
  };
  $app.querySelectorAll('[data-pin]').forEach((b) => {
    b.onclick = () => intentar(async () => {
      const pin = await q(sb.rpc('generar_pin', { p_alumno: b.dataset.pin }));
      const a = alumnos.find((x) => x.id === b.dataset.pin);
      mostrarPines([{ ...a, pin }]);
    }, b);
  });
  $app.querySelectorAll('[data-borrar]').forEach((b) => {
    b.onclick = () => {
      if (!confirm('¿Borrar este alumno? Se borran también sus respuestas y notas.')) return;
      intentar(async () => { await q(sb.from('alumnos').delete().eq('id', b.dataset.borrar)); vistaGrupos(actual); }, b);
    };
  });
  $app.querySelector('#renombrar-grupo').onclick = (e) => {
    const g = grupos.find((x) => x.id === actual);
    const nombre = prompt('Nuevo nombre del grupo', g.nombre)?.trim();
    if (!nombre || nombre === g.nombre) return;
    intentar(async () => {
      await q(sb.from('grupos').update({ nombre }).eq('id', actual));
      toast('Grupo renombrado');
      vistaGrupos(actual);
    }, e.target);
  };
  $app.querySelector('#borrar-grupo').onclick = (e) => {
    const g = grupos.find((x) => x.id === actual);
    if (!confirm(`¿Borrar el grupo "${g.nombre}" con sus alumnos, sesiones y notas? No se puede deshacer.`)) return;
    intentar(async () => {
      await q(sb.from('sesiones').delete().eq('grupo_id', actual));
      await q(sb.from('grupos').delete().eq('id', actual));
      toast('Grupo borrado');
      ir('#/grupos');
    }, e.target);
  };
  $app.querySelector('#csv-alumnos').onchange = async (e) => {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    const filas = leerCSVAlumnos(await leerArchivo(archivo));
    const existentes = new Set(alumnos.map((a) => a.id_alumno));
    const validas = filas.filter((f) => !f.errores.length);
    const $z = $app.querySelector('#zona-import');
    $z.innerHTML = `
      <div class="caja" style="background:var(--fondo)">
        <h2>Vista previa · ${esc(archivo.name)}</h2>
        <p>${validas.length} válidos (${validas.filter((f) => existentes.has(f.alumno.id_alumno)).length} ya existen y se actualizarán) · ${filas.length - validas.length} con errores</p>
        <div class="tabla-envoltorio scroll"><table class="tabla"><thead><tr><th></th><th>Id</th><th>Nombre</th><th>Apellidos</th><th>Email</th></tr></thead>
          <tbody>${filas.map((f) => `<tr class="${f.errores.length ? 'error' : ''}"><td>${f.errores.length ? `✕ ${esc(f.errores.join('; '))}` : existentes.has(f.alumno.id_alumno) ? 'Actualizar' : '✓ Nuevo'}</td>
            <td>${esc(f.alumno.id_alumno)}</td><td>${esc(f.alumno.nombre)}</td><td>${esc(f.alumno.apellidos)}</td><td>${esc(f.alumno.email)}</td></tr>`).join('')}</tbody></table></div>
        <div class="acciones" style="margin-top:10px">
          <button class="btn" type="button" id="imp-al" ${validas.length ? '' : 'disabled'}>Importar ${validas.length} alumnos</button>
          <button class="btn secundario" type="button" id="imp-no">Descartar</button></div>
      </div>`;
    $z.querySelector('#imp-no').onclick = () => { $z.innerHTML = ''; };
    $z.querySelector('#imp-al').onclick = (ev) => intentar(async () => {
      const unicos = [...new Map(validas.map((f) => [f.alumno.id_alumno, { ...f.alumno, grupo_id: actual }])).values()];
      await q(sb.from('alumnos').upsert(unicos, { onConflict: 'grupo_id,id_alumno' }));
      toast(`${unicos.length} alumnos importados. Ahora genera sus PIN.`);
      vistaGrupos(actual);
    }, ev.target);
  };
}

// ---------------------------------------------------------------- notas

async function vistaNotas(grupoId, sesionId, pestana) {
  const grupos = await cargarGrupos();
  if (!grupos.length) { $app.innerHTML = '<div class="caja">Aún no hay grupos.</div>'; return; }
  const actual = grupos.find((g) => g.id === grupoId)?.id || grupos[0].id;
  const sesiones = await q(sb.from('sesiones').select('id, titulo, fecha, estado').eq('grupo_id', actual).in('estado', ['en_curso', 'finalizada']).order('fecha').order('creada_en'));
  pestana ||= sesionId ? 'sesion' : 'trimestre';
  const ses = sesiones.find((s) => s.id === sesionId) || sesiones[sesiones.length - 1];
  $app.innerHTML = `
    <div class="cab"><h1>Notas</h1><div style="min-width:220px">${selectorGrupo(grupos, actual)}</div></div>
    <div class="pestanas" style="max-width:620px;margin-bottom:16px">
      <button type="button" data-p="sesion" aria-selected="${pestana === 'sesion'}">Por sesión</button>
      <button type="button" data-p="trimestre" aria-selected="${pestana === 'trimestre'}">Trimestre · Moodle</button>
      <button type="button" data-p="clasif" aria-selected="${pestana === 'clasif'}">Clasificación</button>
    </div>
    <div id="contenido"></div>`;
  $app.querySelector('#sel-grupo').onchange = (e) => { location.hash = `#/notas/${e.target.value}`; };
  $app.querySelectorAll('[data-p]').forEach((b) => {
    b.onclick = () => { location.hash = `#/notas/${actual}/${ses?.id ?? ''}/${b.dataset.p}`; };
  });
  const $c = $app.querySelector('#contenido');
  if (pestana === 'sesion') return notasSesion($c, actual, sesiones, ses);
  if (pestana === 'clasif') return notasClasificacion($c, actual);
  return notasTrimestre($c, actual, sesiones);
}

async function notasSesion($c, grupo, sesiones, ses) {
  if (!ses) { $c.innerHTML = '<div class="caja">Este grupo aún no tiene sesiones jugadas.</div>'; return; }
  const [notas, tardias] = await Promise.all([
    q(sb.rpc('notas_sesion', { p_sesion: ses.id })),
    q(sb.from('respuestas').select('id, posicion, opcion, t_respuesta, recibida_en, aceptada, anulada, participaciones(alumnos(nombre, apellidos))')
      .eq('sesion_id', ses.id).eq('sincronizada_tarde', true).order('recibida_en')),
  ]);
  const pres = notas.filter((n) => n.presentado);
  const media = pres.length ? pres.reduce((a, n) => a + Number(n.nota), 0) / pres.length : null;
  $c.innerHTML = `
    <div class="caja">
      <div class="cab" style="margin-bottom:8px">
        <select id="sel-ses" style="flex:1 1 260px">${sesiones.map((s) => `<option value="${s.id}" ${s.id === ses.id ? 'selected' : ''}>${fechaLarga(s.fecha)} · ${esc(s.titulo)}${s.estado === 'en_curso' ? ' (en curso)' : ''}</option>`).join('')}</select>
        <button class="btn peque secundario" type="button" id="csv-ses">Descargar CSV</button>
      </div>
      <p>${pres.length} de ${notas.length} presentados · media ${media == null ? '—' : nota2(media)}</p>
      <div class="tabla-envoltorio scroll"><table class="tabla">
        <thead><tr><th>Alumno</th><th>Id</th><th class="num">Aciertos</th><th class="num">Errores</th><th class="num">En blanco</th><th class="num">Tardías</th><th class="num">Nota</th><th class="num">Puntos</th></tr></thead>
        <tbody>${notas.map((n) => `<tr><td>${esc(n.apellidos)}${n.apellidos ? ', ' : ''}${esc(n.nombre)}</td><td>${esc(n.id_alumno)}</td>
          ${n.presentado ? `<td class="num">${n.aciertos}</td><td class="num">${n.errores}</td><td class="num">${n.en_blanco}</td>
            <td class="num">${n.tardias ? `<span class="chip amarillo">${n.tardias}</span>` : 0}</td><td class="num"><strong>${nota2(n.nota)}</strong></td><td class="num">${n.puntos}</td>`
            : '<td colspan="6"><span class="chip">No presentado</span></td>'}</tr>`).join('')}</tbody></table></div>
    </div>
    <div class="caja">
      <h2>Respuestas sincronizadas tarde (${tardias.length})</h2>
      <p class="ayuda">Llegaron más de 10 s después del cierre porque el móvil estaba sin conexión. Se aceptan si se respondieron a tiempo; anula las que no te convenzan y la nota se recalcula.</p>
      ${tardias.length ? `<div class="tabla-envoltorio"><table class="tabla">
        <thead><tr><th>Alumno</th><th>Pregunta</th><th>Respondió</th><th>Llegó</th><th>Estado</th><th>Anular</th></tr></thead>
        <tbody>${tardias.map((r) => `<tr><td>${esc(nombreCorto(r.participaciones.alumnos))}</td><td class="num">${r.posicion + 1}</td>
          <td>${new Date(aMs(r.t_respuesta)).toLocaleTimeString('es-ES')}</td><td>${new Date(aMs(r.recibida_en)).toLocaleTimeString('es-ES')}</td>
          <td>${r.aceptada ? 'Aceptada' : 'Fuera de tiempo'}</td>
          <td><input type="checkbox" data-anular="${r.id}" ${r.anulada ? 'checked' : ''} aria-label="Anular"></td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`;
  $c.querySelector('#sel-ses').onchange = (e) => { location.hash = `#/notas/${grupo}/${e.target.value}/sesion`; };
  $c.querySelector('#csv-ses').onclick = () => descargar(`notas-${ses.fecha}-${ses.titulo}.csv`, generarCSV([
    ['email', 'id_alumno', 'apellidos', 'nombre', 'presentado', 'aciertos', 'errores', 'en_blanco', 'tardias', 'nota', 'puntos'],
    ...notas.map((n) => [n.email, n.id_alumno, n.apellidos, n.nombre, n.presentado ? 'si' : 'no', n.aciertos, n.errores, n.en_blanco, n.tardias, n.nota, n.puntos]),
  ]));
  $c.querySelectorAll('[data-anular]').forEach((c) => {
    c.onchange = () => intentar(async () => {
      await q(sb.from('respuestas').update({ anulada: c.checked }).eq('id', c.dataset.anular));
      toast(c.checked ? 'Respuesta anulada' : 'Respuesta restaurada');
      notasSesion($c, grupo, sesiones, ses);
    });
  });
}

async function notasTrimestre($c, grupo, sesiones) {
  const finalizadas = sesiones.filter((s) => s.estado === 'finalizada');
  $c.innerHTML = `
    <div class="caja">
      <form class="rejilla tres" id="f-tri">
        <div class="campo"><label for="desde">Desde</label><input id="desde" type="date" value="${finalizadas[0]?.fecha ?? ''}"></div>
        <div class="campo"><label for="hasta">Hasta</label><input id="hasta" type="date" value="${hoyISO()}"></div>
        <div class="campo"><label for="desc">Descartar las peores</label><input id="desc" type="number" min="0" value="0"></div>
        <label class="check"><input type="checkbox" id="aus0"> Contar los "no presentado" como 0</label>
        <div class="acciones"><button class="btn" type="submit">Calcular</button>
          <button class="btn oscuro" type="button" id="moodle" disabled>Exportar CSV para Moodle</button></div>
      </form>
    </div>
    <div id="res-tri"></div>`;
  const $f = $c.querySelector('#f-tri');
  let ultimo = null;
  const calcular = () => intentar(async () => {
    const desde = $f.querySelector('#desde').value || null;
    const hasta = $f.querySelector('#hasta').value || null;
    const aus0 = $f.querySelector('#aus0').checked;
    const filas = await q(sb.rpc('notas_trimestre', {
      p_grupo: grupo, p_desde: desde, p_hasta: hasta,
      p_descartar: Number($f.querySelector('#desc').value) || 0, p_ausencia_cero: aus0,
    }));
    const cols = finalizadas.filter((s) => (!desde || s.fecha >= desde) && (!hasta || s.fecha <= hasta));
    ultimo = { filas, cols, aus0 };
    $f.querySelector('#moodle').disabled = !filas.length;
    $c.querySelector('#res-tri').innerHTML = `
      <div class="caja"><p>${cols.length} sesiones finalizadas en el periodo.</p>
      <div class="tabla-envoltorio scroll"><table class="tabla">
        <thead><tr><th>Alumno</th><th>Email</th><th class="num">Nota trimestre</th><th class="num">Cuentan</th>
          ${cols.map((s) => `<th class="num" title="${esc(s.titulo)}">${fechaCorta(s.fecha)}</th>`).join('')}</tr></thead>
        <tbody>${filas.map((f) => `<tr><td>${esc(f.apellidos)}${f.apellidos ? ', ' : ''}${esc(f.nombre)}</td><td>${esc(f.email)}</td>
          <td class="num"><strong>${f.nota_trimestre == null ? '—' : nota2(f.nota_trimestre)}</strong></td><td class="num">${f.sesiones_contadas}</td>
          ${cols.map((s) => `<td class="num">${f.notas[s.id] == null ? '<span class="chip">NP</span>' : nota2(f.notas[s.id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }, $f.querySelector('button[type=submit]'));
  $f.onsubmit = (e) => { e.preventDefault(); calcular(); };
  // Moodle importa CSV con coma, punto decimal y una columna identificadora (email).
  $f.querySelector('#moodle').onclick = () => {
    if (!ultimo) return;
    const { filas, cols, aus0 } = ultimo;
    const titulos = cols.map((s) => `${s.titulo} (${fechaCorta(s.fecha)})`);
    const num = (v) => (v == null ? '' : Number(v).toFixed(2));
    descargar(`moodle-${hoyISO()}.csv`, generarCSV([
      ['email', 'id_alumno', 'nota_trimestre', ...titulos],
      ...filas.map((f) => [f.email, f.id_alumno, num(f.nota_trimestre),
        ...cols.map((s) => (f.notas[s.id] == null ? (aus0 ? '0.00' : '') : num(f.notas[s.id])))]),
    ]));
  };
  calcular();
}

async function notasClasificacion($c, grupo) {
  const filas = await q(sb.rpc('clasificacion_grupo', { p_grupo: grupo }));
  $c.innerHTML = `
    <div class="caja">
      <p class="ayuda">Suma de puntos de todos los tests (acierto + rapidez). Solo motiva: no cuenta para la nota.</p>
      <div class="tabla-envoltorio scroll"><table class="tabla">
        <thead><tr><th class="num">#</th><th>Alumno</th><th class="num">Puntos</th><th class="num">Tests</th><th class="num">Aciertos</th></tr></thead>
        <tbody>${filas.map((f) => `<tr><td class="num">${f.puesto}</td><td>${esc(f.apellidos)}${f.apellidos ? ', ' : ''}${esc(f.nombre)}</td>
          <td class="num"><strong>${f.puntos}</strong></td><td class="num">${f.tests}</td><td class="num">${f.aciertos}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}

iniciar();
