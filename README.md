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
3. **Proyector**: QR + código. Los alumnos entran (la primera vez se registran: nombre, apellidos y email de TecnoCampus; después entran solo con el email). Pulsa *Empezar*.
   En cuanto han respondido todos los que han entrado, la pregunta se cierra sin esperar al reloj (en calendario fijo se adelanta todo lo que viene detrás). Si alguien entró y dejó el móvil, se espera al reloj.
4. Al acabar, *Terminar y guardar notas*: ranking del día y clasificación del grupo.
5. **Notas**: por sesión (revisar respuestas sincronizadas tarde), trimestre (descartar peores, ausencias como 0) → *Exportar CSV para Moodle*.

Profesores: el primer usuario de Supabase Auth y los emails de `profesores_invitados` quedan como profesor al crearse.

## Fases

1. Esquema de datos y RLS — `supabase/schema.sql` ✅
2. Flujo del alumno con modo sin conexión — `index.html`, `js/alumno.js`, `sw.js` ✅
3. Panel del profesor y proyector — `profe.html`, `js/profe.js` ✅
4. Importación (Moodle XML, CSV, JSON) y exportación a Moodle — `js/importar.js` ✅
5. Pruebas de caída de red ✅ (modo avión, recarga sin red, reenvío al reconectar; pruebas E2E fuera del repo)

## Imágenes y vídeos

En el editor de cada pregunta (*Preguntas → Editar*):

- **Imagen**: se ve en el móvil y en el proyector, junto a las opciones. Se reduce en el navegador antes de subir (WebP, 1280 px como mucho, unos 30-150 KB).
  El móvil la descarga al entrar en la sesión, así que se ve aunque se caiga la red.
- **Vídeo**: solo en el proyector, **antes** de poder responder. Mientras tanto el móvil dice "Mira el proyector" con la cuenta atrás.
  Cuando acaba, empieza el tiempo de respuesta normal. En calendario fijo, esa pregunta dura lo que dure el vídeo de más.
  - *Clip propio* (mp4/webm, máx. 20 MB): mejor ya cortado y en 720p.
  - *YouTube*: enlace + segundo de inicio y de fin. No ocupa espacio, pero el proyector necesita internet.
  - Tramo máximo: 180 s. Una sesión con vídeos no puede barajar el orden de las preguntas (todos ven el mismo vídeo a la vez).

### Plan gratuito de Supabase

1 GB de archivos y 5 GB de descarga al mes. Para no agotarlo:

- Los archivos se guardan con el sha256 de su contenido como nombre: lo repetido no se sube dos veces y, como no cambian nunca, cada móvil guarda las imágenes para siempre (service worker) y no las vuelve a bajar en otras sesiones.
- Los vídeos solo los descarga el proyector, una vez por sesión, y los reproduce de memoria. Los móviles nunca bajan vídeo.
- *Preguntas* muestra el espacio usado ("X MB de 1 GB"). Al borrar o cambiar una imagen o un vídeo, o al borrar preguntas, sesiones o grupos, se borran solos los archivos que ya no usa nadie.
  Las sesiones hechas conservan sus archivos aunque borres la pregunta del banco.

## Notas y clasificación

- Cada pregunta tiene **siempre 5 opciones** (A-E) y una sola correcta.
- **Nota del día** (0-10) = 10 × (aciertos − penalización × errores) / nº preguntas, mínimo 0. Penalización 0 o 0,25 por sesión; de momento la app crea todas las sesiones sin penalización (opción retirada del formulario).
- **Registro test a test**: al finalizar cada sesión se guarda una fila por alumno en `notas` (nota, aciertos, errores, en blanco, tardías, puntos).
  Si después anulas una respuesta, corriges la clave o llega una respuesta sincronizada tarde, se recalcula sola.
  Quien no entra queda como *no presentado* (sin nota, no 0).
- **Clasificación general por grupo** (4 grupos, cada uno la suya): suma de puntos tipo Kahoot (acierto + rapidez) de todos los tests.
  Solo motiva, no cuenta para la nota. Se ve en el proyector y en el móvil (top 10 con nombre + inicial y su propio puesto). Nunca se enseñan notas ajenas.
- El alumno ve en el móvil su historial de notas test a test.
- **Nota del trimestre**: media de las notas del día, con opción de descartar las N peores y de contar ausencias como 0.

## Cómo entra el alumno

1. Escanea el QR del proyector con la cámara del móvil (abre la web con el código puesto), o pulsa **Escanear QR** en la app, o hace una foto al QR, o escribe el código de 6 caracteres.
2. Pone su email de TecnoCampus (sin PIN ni contraseña). Puede marcar "Recordar mi email en este dispositivo".

- **Importado por el profesor** (CSV o participantes de Moodle): entra directamente con su email.
- **No está en la lista**: al poner un email que no está en el grupo pasa al registro (nombre, apellidos y email de TecnoCampus). Si el email ya estaba, entra con esa ficha y no se crea otra.
- Desde el 28-10-2026 no hay PIN: quien sepa el email de un compañero y tenga el código de la sesión puede entrar por él. Los botones de PIN del panel ya no tienen efecto.

## Qué pasa si se cae la red

- Al entrar, el móvil descarga todas las preguntas (sin la respuesta correcta) y el calendario, y calcula el desfase de su reloj con el del servidor.
- En **modo calendario fijo** el móvil avanza solo de pregunta aunque no tenga red.
- Cada respuesta se guarda primero en el móvil (IndexedDB) y se envía con reintentos. Se reenvía al reconectar, al recargar y al volver a la app.
- Recargar, cerrar la pestaña o reiniciar el móvil no pierde nada: al abrir la app sigue donde iba (la app está guardada por el service worker).
- La pantalla se mantiene encendida durante la sesión cuando el navegador lo permite.

Al publicar cambios en la app, sube `VERSION` en `sw.js` para que los móviles se actualicen.

## Cómo funciona la seguridad

- **Profesor**: usuario de Supabase Auth dado de alta en la tabla `profesores`. Ve y edita todo vía RLS.
- **Alumno**: no tiene cuenta. Entra con código de sesión + su email (o `id_alumno`), sin PIN.
  Usa la clave pública (rol `anon`), que **no puede leer ninguna tabla** salvo `sesiones_vivo` (solo turno y horas, sin preguntas ni respuestas).
  Todo lo hace con funciones RPC que validan un token de participación.
- La columna `correcta` nunca es accesible al alumno. Solo ve la correcta de una pregunta cuando su ventana + 2 s ha cerrado (si el orden está barajado, al final de la sesión).
- PIN guardado con bcrypt. 5 intentos fallidos bloquean 5 minutos.
- La corrección y la nota se calculan en Postgres, nunca en el móvil.

## Puesta en marcha

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
- Cambios posteriores al esquema: `supabase/migraciones/`, en orden de fecha. Un proyecto nuevo solo necesita `schema.sql` (ya los incluye).
- `js/config.js`: URL y clave **publicable** (puede ir en el repo). La clave secret/service_role nunca va al repo.

### Mantener vivo el proyecto gratuito

Supabase pausa los proyectos gratuitos tras 7 días sin actividad. La Action [`keepalive.yml`](.github/workflows/keepalive.yml) hace una consulta diaria (06:17 UTC) a `hora_servidor`.
Usa las variables del repo `SUPABASE_URL` y `SUPABASE_KEY` (Settings → Secrets and variables → Actions → Variables).
Se puede lanzar a mano desde la pestaña Actions → *Mantener Supabase activo* → *Run workflow*.

## Tests del esquema

Ejecutan `schema.sql` en Postgres en memoria (PGlite) y prueban permisos, entrada por email, ventanas de tiempo, respuestas tardías, idempotencia y notas.

```bash
npm install
npm test
```
