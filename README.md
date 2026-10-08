# Tecno Hockey Quizz

Cuestionarios cortos al final de cada clase de Deportes Colectivos II (hockey hierba, TecnoCampus).
Los alumnos responden desde el móvil con tiempo por pregunta. Cada sesión da una nota del día y el trimestre se exporta a Moodle.

- Frontend estático (HTML + CSS + JS, sin build) en GitHub Pages.
- Backend en Supabase (plan gratuito): Postgres + Auth + Realtime.
- PWA: funciona aunque se caiga la red a mitad de cuestionario.

- Alumnos: https://he-academy.github.io/Tecno-hockey-quizz/
- Profesor: https://he-academy.github.io/Tecno-hockey-quizz/profe.html

## Uso en clase

1. **Preguntas** → Importar tu banco (Moodle XML, CSV `enunciado;A;B;C;D;E;correcta;explicacion;etiquetas` o JSON). Siempre 5 opciones. Ejemplo: `preguntas_ejemplo.csv`.
2. **Sesiones → Nueva sesión**: grupo, modo (calendario fijo en pista / manual), tiempo y pausa, preguntas a mano o N al azar de una etiqueta → *Guardar y lanzar*.
3. **Proyector**: QR + código. Los alumnos entran (la primera vez se registran: nombre, apellidos, email de TecnoCampus y PIN; reciben un id de 6 cifras para siempre). Pulsa *Empezar*.
4. Al acabar, *Terminar y guardar notas*: ranking del día y clasificación del grupo.
5. **Notas**: por sesión (revisar respuestas sincronizadas tarde), trimestre (descartar peores, ausencias como 0) → *Exportar CSV para Moodle*.

Profesores: el primer usuario de Supabase Auth y los emails de `profesores_invitados` quedan como profesor al crearse.

## Fases

1. Esquema de datos y RLS — `supabase/schema.sql` ✅
2. Flujo del alumno con modo sin conexión — `index.html`, `js/alumno.js`, `sw.js` ✅
3. Panel del profesor y proyector — `profe.html`, `js/profe.js` ✅
4. Importación (Moodle XML, CSV, JSON) y exportación a Moodle — `js/importar.js` ✅
5. Pruebas de caída de red ✅ (modo avión, recarga sin red, reenvío al reconectar; pruebas E2E fuera del repo)

## Notas y clasificación

- Cada pregunta tiene **siempre 5 opciones** (A-E) y una sola correcta.
- **Nota del día** (0-10) = 10 × (aciertos − penalización × errores) / nº preguntas, mínimo 0. Penalización 0 o 0,25 por sesión.
- **Registro test a test**: al finalizar cada sesión se guarda una fila por alumno en `notas` (nota, aciertos, errores, en blanco, tardías, puntos).
  Si después anulas una respuesta, corriges la clave o llega una respuesta sincronizada tarde, se recalcula sola.
  Quien no entra queda como *no presentado* (sin nota, no 0).
- **Clasificación general por grupo** (4 grupos, cada uno la suya): suma de puntos tipo Kahoot (acierto + rapidez) de todos los tests.
  Solo motiva, no cuenta para la nota. Se ve en el proyector y en el móvil (top 10 con nombre + inicial y su propio puesto). Nunca se enseñan notas ajenas.
- El alumno ve en el móvil su historial de notas test a test.
- **Nota del trimestre**: media de las notas del día, con opción de descartar las N peores y de contar ausencias como 0.

## Cómo entra el alumno

1. Escanea el QR del proyector con la cámara del móvil (abre la web con el código puesto), o pulsa **Escanear QR** en la app, o hace una foto al QR, o escribe el código de 6 caracteres.
2. Pone su id de alumno y su PIN de 4 cifras. Puede marcar "Recordar en este móvil".

## Qué pasa si se cae la red

- Al entrar, el móvil descarga todas las preguntas (sin la respuesta correcta) y el calendario, y calcula el desfase de su reloj con el del servidor.
- En **modo calendario fijo** el móvil avanza solo de pregunta aunque no tenga red.
- Cada respuesta se guarda primero en el móvil (IndexedDB) y se envía con reintentos. Se reenvía al reconectar, al recargar y al volver a la app.
- Recargar, cerrar la pestaña o reiniciar el móvil no pierde nada: al abrir la app sigue donde iba (la app está guardada por el service worker).
- La pantalla se mantiene encendida durante la sesión cuando el navegador lo permite.

Al publicar cambios en la app, sube `VERSION` en `sw.js` para que los móviles se actualicen.

## Cómo funciona la seguridad

- **Profesor**: usuario de Supabase Auth dado de alta en la tabla `profesores`. Ve y edita todo vía RLS.
- **Alumno**: no tiene cuenta. Entra con código de sesión + `id_alumno` + PIN de 4 cifras.
  Usa la clave pública (rol `anon`), que **no puede leer ninguna tabla** salvo `sesiones_vivo` (solo turno y horas, sin preguntas ni respuestas).
  Todo lo hace con funciones RPC que validan un token de participación.
- La columna `correcta` nunca es accesible al alumno. Solo ve la correcta de una pregunta cuando su ventana + 2 s ha cerrado (si el orden está barajado, al final de la sesión).
- PIN guardado con bcrypt. 5 intentos fallidos bloquean 5 minutos.
- La corrección y la nota se calculan en Postgres, nunca en el móvil.

## Puesta en marcha (provisional, se completará en la fase 4)

1. Crea un proyecto nuevo en [supabase.com](https://supabase.com) (plan gratuito).
2. SQL Editor → pega y ejecuta `supabase/schema.sql` entero.
3. Authentication → Sign In / Providers → desactiva **Allow new users to sign up**.
4. Authentication → Users → **Add user** con tu email y contraseña.
5. SQL Editor → date de alta como profesor:
   ```sql
   insert into public.profesores (user_id, email)
   select id, email from auth.users where email = 'TU_EMAIL@tecnocampus.cat';
   ```

### Proyecto actual

- Supabase: `mrogihueonnacjdywxys` (org Tecnocampus, eu-west-1). `schema.sql` aplicado, registro público desactivado, URL del sitio = GitHub Pages.
- `js/config.js`: URL y clave **publicable** (puede ir en el repo). La clave secret/service_role nunca va al repo.

### Mantener vivo el proyecto gratuito

Supabase pausa los proyectos gratuitos tras 7 días sin actividad. La Action [`keepalive.yml`](.github/workflows/keepalive.yml) hace una consulta diaria (06:17 UTC) a `hora_servidor`.
Usa las variables del repo `SUPABASE_URL` y `SUPABASE_KEY` (Settings → Secrets and variables → Actions → Variables).
Se puede lanzar a mano desde la pestaña Actions → *Mantener Supabase activo* → *Run workflow*.

## Tests del esquema

Ejecutan `schema.sql` en Postgres en memoria (PGlite) y prueban permisos, PIN, ventanas de tiempo, respuestas tardías, idempotencia y notas.

```bash
npm install
npm test
```
