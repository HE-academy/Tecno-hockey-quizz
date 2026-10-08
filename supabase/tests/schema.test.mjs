import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });

let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fallos++; };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];
const falla = async (sql, params, patron) => {
  try { await db.query(sql, params); return false; }
  catch (e) { return patron ? patron.test(e.message) : true; }
};

const PROFE = '11111111-1111-1111-1111-111111111111';
const OTRO = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  create schema extensions; grant usage on schema extensions to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create publication supabase_realtime;
  -- Supabase concede por defecto todo a anon/authenticated en public:
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`);
await db.exec(schema);
console.log('schema.sql cargado sin errores');

await db.exec(`insert into auth.users values ('${PROFE}', 'profe@tecnocampus.cat');
               insert into auth.users values ('${OTRO}', 'intruso@x.com');`);
const profes = (await db.query(`select user_id from public.profesores`)).rows;
ok(profes.length === 1 && profes[0].user_id === PROFE, 'el primer usuario creado queda como profesor; el segundo no');

const comoProfe = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${PROFE}', false);`);
const comoOtro = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${OTRO}', false);`);
const comoAnon = () => db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);`);
const comoAdmin = () => db.exec(`reset role;`);

// --- Profesor prepara grupo, alumnos, preguntas, sesión
await comoProfe();
const g = (await q1(`insert into grupos (nombre) values ('DC2-A') returning id`)).id;
await q(`insert into alumnos (grupo_id, id_alumno, nombre, apellidos, email) values
  ($1,'u100','Ana','García','ana@tecnocampus.cat'),
  ($1,'u101','Bru','Puig','bru@tecnocampus.cat'),
  ($1,'u102','Carla','Vidal','carla@tecnocampus.cat')`, [g]);
const pregs = [];
for (let i = 0; i < 4; i++) {
  pregs.push((await q1(`insert into preguntas (enunciado, opciones, correcta, etiquetas)
    values ($1, array['A','B','C','D','E'], $2, array['pase']) returning id`, [`Pregunta ${i}`, i % 5])).id);
}
ok(await falla(`insert into preguntas (enunciado, opciones, correcta) values ('x', array['a','b','c','d','e'], 5)`), 'check: correcta fuera de rango rechazada');
ok(await falla(`insert into preguntas (enunciado, opciones, correcta) values ('x', array['a','b','c','d'], 0)`), 'check: 4 opciones rechazada (siempre 5)');

const pins = await q(`select * from generar_pines($1)`, [g]);
ok(pins.length === 3 && pins.every(p => /^\d{4}$/.test(p.pin)), 'generar_pines devuelve 3 PIN de 4 cifras');
const pinDe = Object.fromEntries(pins.map(p => [p.id_alumno, p.pin]));
const hash = await q1(`select pin_hash from alumnos where id_alumno='u100'`);
ok(hash.pin_hash.startsWith('$2') && !hash.pin_hash.includes(pinDe.u100), 'PIN guardado con bcrypt');

const s = (await q1(`insert into sesiones (grupo_id, titulo, modo, tiempo_s, pausa_s, barajar_preguntas)
  values ($1,'Clase 1','fijo',20,5,false) returning id`, [g])).id;
ok((await q1(`select asignar_preguntas($1, $2::uuid[]) n`, [s, pregs])).n === 4, 'asignar_preguntas copia 4');
ok(await falla(`insert into sesiones (grupo_id, titulo, modo, barajar_preguntas) values ($1,'x','manual',true)`, [g]), 'check: manual + barajar_preguntas rechazado');
const codigo = (await q1(`select lanzar_sesion($1) c`, [s])).c;
ok(/^[A-HJ-NP-Z2-9]{6}$/.test(codigo), `lanzar_sesion -> código ${codigo}`);

// --- Intruso autenticado (no profe) no ve nada
await comoOtro();
ok((await q(`select * from preguntas`)).length === 0, 'authenticated no-profe: 0 preguntas visibles');
ok(await falla(`select * from notas_sesion($1)`, [s], /no_autorizado/), 'authenticated no-profe: notas_sesion denegado');

// --- Alumno (anon)
await comoAnon();
ok(await falla(`select * from preguntas`, [], /permission denied/), 'anon: preguntas -> permission denied');
ok(await falla(`select correcta from sesion_preguntas`, [], /permission denied/), 'anon: sesion_preguntas.correcta -> permission denied');
ok(await falla(`select * from respuestas`, [], /permission denied/), 'anon: respuestas -> permission denied');
ok(await falla(`select * from alumnos`, [], /permission denied/), 'anon: alumnos -> permission denied');
ok(await falla(`select * from notas_sesion($1)`, [s], /permission denied/), 'anon: notas_sesion -> permission denied');
ok(await falla(`select _participacion('x')`, [], /permission denied/), 'anon: funciones internas -> permission denied');
ok(await falla(`insert into sesiones_vivo (sesion_id, estado, modo) values ($1,'x','x')`, [s], /permission denied/), 'anon: no escribe sesiones_vivo');
ok((await q(`select * from sesiones_vivo`)).length === 1, 'anon: lee sesiones_vivo');

const malo = (await q1(`select unirse_sesion($1,'u100','0000') r`, [codigo])).r;
ok(!malo.ok && malo.error === 'credenciales', 'PIN incorrecto -> credenciales');
for (let i = 0; i < 5; i++) await q(`select unirse_sesion($1,'u102','9999')`, [codigo]);
const bloq = (await q1(`select unirse_sesion($1,'u102',$2) r`, [codigo, pinDe.u102])).r;
ok(!bloq.ok && bloq.error === 'bloqueado', '5 fallos -> bloqueado aunque luego acierte');

const j = (await q1(`select unirse_sesion($1,'u100',$2) r`, [codigo.toLowerCase(), pinDe.u100])).r;
ok(j.ok && j.token.length === 48, 'unirse_sesion ok (código en minúsculas)');
ok(j.preguntas.length === 4 && j.preguntas.every(p => !('correcta' in p)), 'precarga: 4 preguntas sin clave');
ok(j.ventanas.length === 0, 'sala de espera: aún sin ventanas');
const tokA = j.token;
const jB = (await q1(`select unirse_sesion($1,'u101',$2) r`, [codigo, pinDe.u101])).r;
const tokB = jB.token;

const pre = (await q1(`select enviar_respuesta($1, 0::smallint, 0::smallint, now()) r`, [tokA])).r;
ok(!pre.ok && pre.error === 'no_iniciada', 'responder antes de iniciar -> no_iniciada');

// --- Profe inicia
await comoProfe();
const ini = (await q1(`select iniciar_sesion($1, 0) r`, [s])).r;
ok(ini.ventanas.length === 4, 'iniciar_sesion fijo: calendario de 4 ventanas');

await comoAnon();
const est = (await q1(`select estado_sesion($1) r`, [tokA])).r;
ok(est.estado === 'en_curso' && est.ventanas.length === 4, 'estado_sesion devuelve calendario');
ok(await falla(`select estado_sesion('falso')`, [], /token_invalido/), 'token falso -> token_invalido');

// A responde turno 0 correctamente (correcta de P0 = 0)
let r = (await q1(`select enviar_respuesta($1, 0::smallint, 0::smallint, now()) r`, [tokA])).r;
ok(r.ok && r.estado === 'registrada' && !('correcta' in r), 'respuesta en ventana -> registrada, sin revelar');
r = (await q1(`select enviar_respuesta($1, 0::smallint, 3::smallint, now()) r`, [tokA])).r;
ok(r.ok && r.duplicada, 'reenvío -> duplicada (idempotente, no cambia la opción)');
r = (await q1(`select enviar_respuesta($1, 1::smallint, 7::smallint, now()) r`, [tokA])).r;
ok(!r.ok && r.error === 'opcion', 'opción inexistente rechazada');
r = (await q1(`select enviar_respuesta($1, 2::smallint, 2::smallint, now()) r`, [tokA])).r;
ok(!r.ok && r.error === 'no_abierta', 'turno futuro aún no abierto -> no_abierta, no se guarda');
// B responde turno 0 mal
await q(`select enviar_respuesta($1, 0::smallint, 1::smallint, now())`, [tokB]);

let mr = (await q1(`select mi_resultado($1) r`, [tokA])).r;
ok(mr.preguntas[0].revelada === false && !('correcta' in mr.preguntas[0]) && mr.nota === null, 'mi_resultado: nada revelado durante la pregunta');

// --- Simular paso del tiempo: retrasar 2 minutos todo el calendario
await comoAdmin();
await db.exec(`update sesion_preguntas set abierta_en = abierta_en - interval '2 minutes', cierra_en = cierra_en - interval '2 minutes' where sesion_id = '${s}'`);
// Ventanas ahora (aprox.): t0 [-120,-100], t1 [-95,-75], t2 [-70,-50], t3 [-45,-25] s

await comoAnon();
// A estuvo sin red: contestó t1 dentro de su ventana (t=-85 s), llega ahora -> aceptada y marcada tarde
r = (await q1(`select enviar_respuesta($1, 1::smallint, 1::smallint, now() - interval '85 seconds') r`, [tokA])).r;
ok(r.ok && r.estado === 'registrada', 'sin conexión: respuesta en ventana llega tarde -> registrada');
// t2 contestada fuera de plazo (t=-40 s, cierre -50 s)
r = (await q1(`select enviar_respuesta($1, 2::smallint, 2::smallint, now() - interval '40 seconds') r`, [tokA])).r;
ok(r.ok && r.estado === 'fuera_de_tiempo', 'fuera de ventana -> fuera_de_tiempo');
// reloj del móvil en el futuro
r = (await q1(`select enviar_respuesta($1, 3::smallint, 3::smallint, now() + interval '1 hour') r`, [tokB])).r;
ok(r.ok && r.estado === 'fuera_de_tiempo', 'hora futura recortada a now() -> fuera_de_tiempo');

mr = (await q1(`select mi_resultado($1) r`, [tokA])).r;
ok(mr.preguntas.every(p => p.revelada) && mr.preguntas[0].correcta === 0 && mr.preguntas[0].acierto === true, 'tras cierres: revelado con correcta y acierto');
ok(Number(mr.nota) === 5, `nota del día A = ${mr.nota} (2 aciertos de 4, 0 errores) esperado 5`);

// Recuperación: A vuelve a entrar con PIN -> mismo orden y respuestas
const j2 = (await q1(`select unirse_sesion($1,'u100',$2) r`, [codigo, pinDe.u100])).r;
ok(j2.ok && j2.respondidas.length === 3 && j2.token !== tokA, 'reentrar: rota token y recupera respondidas');
ok(await falla(`select estado_sesion($1)`, [tokA], /token_invalido/), 'token viejo invalidado');

// --- Profe: notas, cierre, ranking, trimestre
await comoProfe();
const tard = await q1(`select count(*)::int n from respuestas where sincronizada_tarde`);
ok(tard.n === 3, `sincronizada_tarde marcadas: ${tard.n} (esperado 3: las que llegaron >10 s tras el cierre)`);
const cp = (await q1(`select cerrar_pregunta($1, 0::smallint) r`, [s])).r;
ok(cp.revelada && cp.correcta === 0 && cp.reparto[0] === 1 && cp.reparto[1] === 1, `cerrar_pregunta reparto ${JSON.stringify(cp.reparto)}`);
const rk = await q(`select * from ranking_sesion($1)`, [s]);
ok(rk[0].nombre === 'Ana' && rk[0].puntos > 0, `ranking: ${rk.map(x => x.nombre + ' ' + x.puntos).join(', ')}`);
await q(`select finalizar_sesion($1)`, [s]);
const ns = await q(`select * from notas_sesion($1)`, [s]);
const nA = ns.find(x => x.id_alumno === 'u100'), nB = ns.find(x => x.id_alumno === 'u101'), nC = ns.find(x => x.id_alumno === 'u102');
ok(Number(nA.nota) === 5 && nA.presentado, `notas_sesion Ana = ${nA.nota}`);
ok(Number(nB.nota) === 0 && nB.errores === 1, `notas_sesion Bru = ${nB.nota} (1 error, mínimo 0)`);
ok(nC.presentado === false && nC.nota === null, 'Carla no presentada -> nota null, no 0');

// Registro test a test en public.notas
const regNota = async (alumno) => q1(`select n.* from notas n join alumnos a on a.id = n.alumno_id
                                      where n.sesion_id = $1 and a.id_alumno = $2`, [s, alumno]);
ok((await q(`select * from notas where sesion_id = $1`, [s])).length === 3, 'finalizar guarda 3 filas en notas');
const rA = await regNota('u100');
ok(Number(rA.nota) === 5 && rA.puntos > 0, `notas Ana: ${rA.nota}, ${rA.puntos} puntos`);
ok((await regNota('u102')).presentado === false, 'notas Carla: no presentado');
ok(await falla(`update notas set nota = 10 where sesion_id = $1`, [s], /permission denied/), 'profe no puede editar notas a mano');

const anular = (v) => q(`update respuestas set anulada = $2 where posicion = 1 and participacion_id =
  (select p.id from participaciones p join alumnos a on a.id = p.alumno_id where a.id_alumno = 'u100' and p.sesion_id = $1)`, [s, v]);
await anular(true);
ok(Number((await regNota('u100')).nota) === 2.5, 'anular respuesta tras finalizar -> nota recalculada a 2.5');
await anular(false);
ok(Number((await regNota('u100')).nota) === 5, 'desanular -> vuelve a 5');

await comoAnon();
r = (await q1(`select enviar_respuesta($1, 2::smallint, 0::smallint, now() - interval '60 seconds') r`, [tokB])).r;
ok(r.ok && r.estado === 'registrada', 'Bru sincroniza tarde tras finalizar -> registrada');
ok(await falla(`select * from notas`, [], /permission denied/), 'anon: notas -> permission denied');
await comoProfe();
const rB = await regNota('u101');
ok(rB.errores === 2 && rB.tardias === 2 && Number(rB.nota) === 0, `notas Bru recalculadas: ${rB.errores} errores, ${rB.tardias} tardías`);

// segunda sesión: Ana no viene, Bru saca 10
const s2 = (await q1(`insert into sesiones (grupo_id, titulo, barajar_preguntas, penalizacion) values ($1,'Clase 2',true,0) returning id`, [g])).id;
await q(`select asignar_preguntas($1, $2::uuid[])`, [s2, pregs.slice(0, 2)]);
const c2 = (await q1(`select lanzar_sesion($1) c`, [s2])).c;
await comoAnon();
const jb2 = (await q1(`select unirse_sesion($1,'u101',$2) r`, [c2, pinDe.u101])).r;
ok(jb2.preguntas.map(p => p.posicion).sort().join() === '0,1', 'barajado: mismas preguntas en algún orden');
await comoProfe();
await q(`select iniciar_sesion($1, 0)`, [s2]);
await comoAdmin();
await db.exec(`update sesion_preguntas set abierta_en = now() - interval '1 second', cierra_en = now() + interval '1 minute' where sesion_id = '${s2}'`);
await comoAnon();
for (const p of jb2.preguntas) await q(`select enviar_respuesta($1, $2::smallint, $3::smallint, now())`, [jb2.token, p.posicion, p.posicion % 5]);
await comoProfe();
await q(`select finalizar_sesion($1)`, [s2]);

const nt = await q(`select * from notas_trimestre($1)`, [g]);
const tA = nt.find(x => x.id_alumno === 'u100'), tB = nt.find(x => x.id_alumno === 'u101');
ok(Number(tA.nota_trimestre) === 5 && tA.sesiones_contadas === 1, `trimestre Ana (ausencia excluida) = ${tA.nota_trimestre}`);
ok(Number(tB.nota_trimestre) === 5, `trimestre Bru = ${tB.nota_trimestre} (0 y 10)`);
const nt0 = await q(`select * from notas_trimestre($1, null, null, 0, true)`, [g]);
ok(Number(nt0.find(x => x.id_alumno === 'u100').nota_trimestre) === 2.5, 'ausencia como 0 -> Ana 2.5');
const ntD = await q(`select * from notas_trimestre($1, null, null, 1)`, [g]);
ok(Number(ntD.find(x => x.id_alumno === 'u101').nota_trimestre) === 10, 'descartar peor 1 -> Bru 10');
ok(Object.keys(tA.notas).length === 2 && tA.notas[s2] === null, 'columnas por sesión con null = no presentado');

// Clasificación general del grupo (puntos de todos los tests)
const cg = await q(`select * from clasificacion_grupo($1)`, [g]);
const suma = await q1(`select sum(puntos)::int t from notas n join alumnos a on a.id = n.alumno_id where a.id_alumno = 'u101'`);
const cB = cg.find(x => x.nombre === 'Bru');
ok(cg.length === 3 && cB.puntos === suma.t && cB.tests === 2, `clasificacion_grupo: ${cg.map(x => x.puesto + '. ' + x.nombre + ' ' + x.puntos).join(', ')}`);
ok(cg[0].puesto === 1 && cg[0].puntos >= cg[1].puntos && cg[2].nombre === 'Carla' && cg[2].puntos === 0, 'ordenada por puntos, Carla 0');

await comoAnon();
const mc = (await q1(`select mi_clasificacion($1) r`, [jb2.token])).r;
ok(mc.top.length === 3 && mc.total_alumnos === 3 && mc.top.some(x => x.yo && x.nombre === 'Bru P.'), `mi_clasificacion: ${JSON.stringify(mc.top)}`);
ok(mc.yo.puntos === cB.puntos && mc.top.every(x => !('nota' in x)), 'mi_clasificacion: puesto propio, sin notas ajenas');
const mh = (await q1(`select mi_historial($1) r`, [j2.token])).r;
ok(mh.tests.length === 2 && Number(mh.tests[0].nota) === 5 && mh.tests[1].presentado === false && Number(mh.media_provisional) === 5,
   `mi_historial Ana: ${mh.tests.map(t => t.titulo + '=' + t.nota).join(', ')}`);
await comoProfe();

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
