# Tecno Hockey Quizz

Cuestionarios cortos al final de cada clase de Deportes Colectivos II (hockey hierba, TecnoCampus).
Los alumnos responden desde el móvil con tiempo por pregunta. Cada sesión da una nota del día y el trimestre se exporta a Moodle.

- Frontend estático (HTML + CSS + JS, sin build) en GitHub Pages.
- Backend en Supabase (plan gratuito): Postgres + Auth + Realtime.
- PWA: funciona aunque se caiga la red a mitad de cuestionario.

> Estado: **fase 1 de 5** (esquema de datos y RLS). La app todavía no tiene pantallas.

## Fases

1. Esquema de datos y RLS — `supabase/schema.sql` ✅
2. Flujo del alumno con modo sin conexión
3. Panel del profesor y proyector
4. Importación (Moodle XML, CSV, JSON) y exportación a Moodle
5. Pruebas de caída de red

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

## Tests del esquema

Ejecutan `schema.sql` en Postgres en memoria (PGlite) y prueban permisos, PIN, ventanas de tiempo, respuestas tardías, idempotencia y notas.

```bash
npm install
npm test
```
