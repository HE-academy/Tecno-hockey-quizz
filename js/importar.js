// Lectura de ficheros para importar preguntas (Moodle XML, CSV, JSON) y
// alumnos (CSV). Solo transforma y valida; no toca la base de datos.

const LETRAS = 'ABCDE';

export const claveDuplicado = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------- CSV

export function detectarSeparador(texto) {
  const linea = texto.split(/\r?\n/).find((l) => l.trim()) || '';
  const cuenta = (c) => linea.split(c).length - 1;
  return [';', ',', '\t'].sort((a, b) => cuenta(b) - cuenta(a))[0];
}

// CSV con comillas dobles, saltos de línea dentro de comillas y "" escapadas.
export function parsearCSV(texto, sep = detectarSeparador(texto)) {
  texto = texto.replace(/^﻿/, '');
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"' && campo === '') comillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((x) => x.trim() !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x.trim() !== '')) filas.push(fila);
  return filas.map((f) => f.map((x) => x.trim()));
}

export function generarCSV(filas, sep = ',') {
  const celda = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + filas.map((f) => f.map(celda).join(sep)).join('\r\n') + '\r\n';
}

export function descargar(nombre, contenido, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- preguntas

function normEtiquetas(v) {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  return normEtiquetas(String(v ?? '').split(/[,|]/));
}

function normCorrecta(v, opciones) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 4 ? v : null;
  const s = String(v).trim().toUpperCase();
  if (/^[A-E]$/.test(s)) return LETRAS.indexOf(s);
  if (/^[1-5]$/.test(s)) return Number(s) - 1;
  // También vale el texto exacto de la opción correcta.
  const i = opciones.findIndex((o) => claveDuplicado(o) === claveDuplicado(v));
  return i >= 0 ? i : null;
}

// Devuelve { pregunta, errores[] }.
export function validarPregunta(p) {
  const errores = [];
  const enunciado = String(p.enunciado ?? '').trim();
  const opciones = (p.opciones || []).map((o) => String(o ?? '').trim());
  if (!enunciado) errores.push('sin enunciado');
  if (opciones.length !== 5) errores.push(`tiene ${opciones.length} opciones (hacen falta 5)`);
  else if (opciones.some((o) => !o)) errores.push('alguna opción está vacía');
  else if (new Set(opciones.map(claveDuplicado)).size !== 5) errores.push('opciones repetidas');
  const correcta = p.correcta_ok ?? normCorrecta(p.correcta, opciones);
  if (correcta == null || correcta < 0 || correcta > 4) errores.push(`respuesta correcta no válida (${p.correcta ?? 'vacía'})`);
  let dificultad = p.dificultad == null || p.dificultad === '' ? null : Number(p.dificultad);
  if (dificultad != null && !(Number.isInteger(dificultad) && dificultad >= 1 && dificultad <= 5)) {
    errores.push('dificultad debe ser 1-5');
    dificultad = null;
  }
  if (p.error) errores.push(p.error);
  return {
    pregunta: {
      enunciado,
      opciones,
      correcta,
      explicacion: String(p.explicacion ?? '').trim(),
      etiquetas: normEtiquetas(p.etiquetas),
      dificultad,
    },
    errores,
  };
}

function textoPlano(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('br, p, div, li').forEach((el) => el.append(' '));
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

export function leerMoodleXML(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El XML no es válido.');
  const salida = [];
  let categoria = null;
  for (const q of doc.querySelectorAll('quiz > question')) {
    const tipo = q.getAttribute('type');
    if (tipo === 'category') {
      const ruta = q.querySelector('category > text')?.textContent || '';
      categoria = ruta.split('/').map((s) => s.trim()).filter((s) => s && !/^\$\w+\$$/.test(s)).pop() || null;
      continue;
    }
    const nombre = q.querySelector(':scope > name > text')?.textContent?.trim();
    if (tipo !== 'multichoice') {
      salida.push({ enunciado: nombre || `(pregunta ${tipo})`, opciones: [], error: `tipo "${tipo}" no admitido (solo opción múltiple)` });
      continue;
    }
    const respuestas = [...q.querySelectorAll(':scope > answer')].map((a) => ({
      texto: textoPlano(a.querySelector(':scope > text')?.textContent),
      fraccion: Number(a.getAttribute('fraction') || 0),
    }));
    const correctas = respuestas.map((a, i) => (a.fraccion >= 100 ? i : -1)).filter((i) => i >= 0);
    const single = (q.querySelector(':scope > single')?.textContent ?? 'true').trim() !== 'false';
    const etiquetas = [...q.querySelectorAll(':scope > tags > tag > text')].map((t) => t.textContent);
    if (categoria) etiquetas.push(categoria);
    salida.push({
      enunciado: textoPlano(q.querySelector(':scope > questiontext > text')?.textContent) || nombre,
      opciones: respuestas.map((a) => a.texto),
      correcta_ok: correctas.length === 1 ? correctas[0] : null,
      correcta: correctas.length === 1 ? correctas[0] : `${correctas.length} correctas`,
      explicacion: textoPlano(q.querySelector(':scope > generalfeedback > text')?.textContent),
      etiquetas,
      error: !single ? 'admite varias respuestas (debe ser de una sola)' : null,
    });
  }
  return salida;
}

// enunciado;A;B;C;D;E;correcta;explicacion;etiquetas[;dificultad]
export function leerCSVPreguntas(texto) {
  let filas = parsearCSV(texto);
  if (filas.length && /enunciado/i.test(filas[0][0])) filas = filas.slice(1);
  return filas.map((f) => ({
    enunciado: f[0],
    opciones: f.slice(1, 6).filter((x, i) => i < 5 && (x !== '' || f.length >= 6)),
    correcta: f[6],
    explicacion: f[7],
    etiquetas: f[8],
    dificultad: f[9],
  }));
}

export function leerJSONPreguntas(texto) {
  const datos = JSON.parse(texto);
  const lista = Array.isArray(datos) ? datos : datos.preguntas;
  if (!Array.isArray(lista)) throw new Error('El JSON debe ser una lista de preguntas.');
  return lista.map((p) => ({
    ...p,
    opciones: p.opciones ?? ['A', 'B', 'C', 'D', 'E'].map((l) => p[l] ?? p[l.toLowerCase()]).filter((x) => x != null),
  }));
}

export function leerPreguntas(nombre, texto) {
  const ext = nombre.toLowerCase().split('.').pop();
  const t = texto.trim();
  if (ext === 'xml' || t.startsWith('<')) return leerMoodleXML(texto);
  if (ext === 'json' || t.startsWith('[') || t.startsWith('{')) return leerJSONPreguntas(texto);
  return leerCSVPreguntas(texto);
}

// ---------------------------------------------------------------- alumnos

const ALIAS_ALUMNO = {
  id_alumno: ['id_alumno', 'id', 'idalumno', 'número de id', 'numero de id', 'id number', 'idnumber', 'niu', 'dni', 'username', 'nombre de usuario'],
  nombre: ['nombre', 'first name', 'firstname', 'nom'],
  apellidos: ['apellidos', 'apellido(s)', 'apellido', 'last name', 'lastname', 'surname', 'cognoms'],
  email: ['email', 'e-mail', 'correo', 'dirección de correo', 'direccion de correo', 'email address', 'correu', 'adreça electrònica'],
};

export function leerCSVAlumnos(texto) {
  const filas = parsearCSV(texto);
  if (!filas.length) return [];
  const cab = filas[0].map((c) => c.toLowerCase().trim());
  const idx = {};
  for (const [campo, alias] of Object.entries(ALIAS_ALUMNO)) {
    idx[campo] = cab.findIndex((c) => alias.includes(c));
  }
  const conCabecera = Object.values(idx).some((i) => i >= 0);
  if (!conCabecera) Object.assign(idx, { id_alumno: 0, nombre: 1, apellidos: 2, email: 3 });
  return (conCabecera ? filas.slice(1) : filas).map((f) => {
    const a = {
      id_alumno: (f[idx.id_alumno] ?? '').trim(),
      nombre: (f[idx.nombre] ?? '').trim(),
      apellidos: idx.apellidos >= 0 ? (f[idx.apellidos] ?? '').trim() : '',
      email: (f[idx.email] ?? '').trim().toLowerCase(),
    };
    const errores = [];
    if (!a.id_alumno) errores.push('sin id_alumno');
    if (!a.nombre) errores.push('sin nombre');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) errores.push('email no válido');
    return { alumno: a, errores };
  });
}
