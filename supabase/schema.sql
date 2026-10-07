-- =====================================================================
-- Tecno Hockey Quizz · esquema Supabase (Postgres)
-- Ejecutar entero en el SQL Editor de un proyecto Supabase vacío.
--
-- Modelo de acceso:
--   · Profesor: usuario de Supabase Auth dado de alta en public.profesores.
--     Acceso total vía RLS (es_profe()).
--   · Alumno: NO es usuario de Auth. Llega con la clave pública (rol anon),
--     que no tiene permiso sobre ninguna tabla salvo sesiones_vivo.
--     Todo lo hace por funciones RPC security definer que validan un token
--     de participación emitido por unirse_sesion (id_alumno + PIN).
--
-- Turno vs posición:
--   · posicion = índice canónico de la pregunta en la sesión (sesion_preguntas).
--   · turno    = hueco temporal en que el alumno la ve. La ventana de tiempo
--     (abierta_en/cierra_en) pertenece al turno, y se guarda en la fila de
--     sesion_preguntas con posicion = turno. participaciones.orden[turno+1]
--     da la posición que ese alumno ve en ese turno.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

create table public.profesores (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text not null unique,
  creado_en timestamptz not null default now()
);

create table public.grupos (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null unique check (length(trim(nombre)) > 0),
  creado_en timestamptz not null default now()
);

create table public.alumnos (
  id                uuid primary key default gen_random_uuid(),
  grupo_id          uuid not null references public.grupos (id) on delete cascade,
  id_alumno         text not null check (length(trim(id_alumno)) > 0),
  nombre            text not null,
  apellidos         text not null default '',
  email             text not null,
  pin_hash          text,
  intentos_fallidos smallint not null default 0,
  bloqueado_hasta   timestamptz,
  unique (grupo_id, id_alumno)
);

create table public.preguntas (
  id              uuid primary key default gen_random_uuid(),
  enunciado       text not null check (length(trim(enunciado)) > 0),
  opciones        text[] not null,
  correcta        smallint not null,
  explicacion     text not null default '',
  etiquetas       text[] not null default '{}',
  dificultad      smallint check (dificultad between 1 and 5),
  clave_duplicado text generated always as (lower(regexp_replace(trim(enunciado), '\s+', ' ', 'g'))) stored,
  creada_en       timestamptz not null default now(),
  actualizada_en  timestamptz not null default now(),
  check (array_ndims(opciones) = 1 and array_length(opciones, 1) between 2 and 5),
  check (array_position(opciones, null) is null),
  check (correcta >= 0 and correcta < array_length(opciones, 1))
);
create index preguntas_etiquetas_idx on public.preguntas using gin (etiquetas);
create index preguntas_duplicado_idx on public.preguntas (clave_duplicado);

create table public.sesiones (
  id                uuid primary key default gen_random_uuid(),
  grupo_id          uuid not null references public.grupos (id) on delete restrict,
  titulo            text not null,
  fecha             date not null default current_date,
  modo              text not null default 'fijo' check (modo in ('fijo', 'manual')),
  tiempo_s          smallint not null default 20 check (tiempo_s between 5 and 300),
  pausa_s           smallint not null default 5 check (pausa_s between 0 and 120),
  penalizacion      numeric(3, 2) not null default 0.25 check (penalizacion in (0, 0.25)),
  barajar_preguntas boolean not null default true,
  barajar_opciones  boolean not null default true,
  codigo            text check (codigo ~ '^[A-HJ-NP-Z2-9]{6}$'),
  estado            text not null default 'borrador'
                    check (estado in ('borrador', 'abierta', 'en_curso', 'finalizada')),
  inicio            timestamptz,
  creada_en         timestamptz not null default now(),
  -- En modo manual el proyector enseña "la" pregunta actual: orden común para todos.
  check (not (modo = 'manual' and barajar_preguntas))
);
create unique index sesiones_codigo_activo on public.sesiones (codigo)
  where estado in ('abierta', 'en_curso');
create index sesiones_grupo_fecha_idx on public.sesiones (grupo_id, fecha);

-- Copia congelada de cada pregunta al asignarla: editar el banco después no
-- cambia notas ya puestas. Corregir aquí "correcta" recalcula la sesión.
create table public.sesion_preguntas (
  sesion_id   uuid not null references public.sesiones (id) on delete cascade,
  posicion    smallint not null check (posicion >= 0),
  pregunta_id uuid references public.preguntas (id) on delete set null,
  enunciado   text not null,
  opciones    text[] not null,
  correcta    smallint not null,
  explicacion text not null default '',
  abierta_en  timestamptz,
  cierra_en   timestamptz,
  primary key (sesion_id, posicion),
  check (correcta >= 0 and correcta < array_length(opciones, 1))
);

create table public.participaciones (
  id              uuid primary key default gen_random_uuid(),
  sesion_id       uuid not null references public.sesiones (id) on delete cascade,
  alumno_id       uuid not null references public.alumnos (id) on delete cascade,
  token_hash      bytea not null,
  orden           smallint[] not null,
  unido_en        timestamptz not null default now(),
  ultimo_contacto timestamptz not null default now(),
  unique (sesion_id, alumno_id)
);
create unique index participaciones_token_idx on public.participaciones (token_hash);

create table public.respuestas (
  id                 bigint generated always as identity primary key,
  participacion_id   uuid not null references public.participaciones (id) on delete cascade,
  sesion_id          uuid not null,
  posicion           smallint not null,
  turno              smallint not null,
  opcion             smallint not null check (opcion between 0 and 4),
  t_respuesta        timestamptz not null,
  recibida_en        timestamptz not null default now(),
  ms_respuesta       integer not null,
  aceptada           boolean not null,
  sincronizada_tarde boolean not null default false,
  anulada            boolean not null default false,
  unique (participacion_id, posicion),
  foreign key (sesion_id, posicion)
    references public.sesion_preguntas (sesion_id, posicion) on delete cascade
);
create index respuestas_sesion_posicion_idx on public.respuestas (sesion_id, posicion);

-- Espejo mínimo del estado de cada sesión, legible por anon y publicado en
-- Realtime. Sin código ni preguntas: solo "qué turno está abierto y hasta cuándo".
create table public.sesiones_vivo (
  sesion_id      uuid primary key references public.sesiones (id) on delete cascade,
  estado         text not null,
  modo           text not null,
  inicio         timestamptz,
  turno_actual   smallint,
  abierta_en     timestamptz,
  cierra_en      timestamptz,
  actualizado_en timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Funciones auxiliares (no expuestas)
-- ---------------------------------------------------------------------

create function public.es_profe() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profesores where user_id = (select auth.uid()));
$$;

create function public._exigir_profe() returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.es_profe() then
    raise exception 'no_autorizado' using errcode = '42501';
  end if;
end;
$$;

create function public._tocar_actualizada() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.actualizada_en := now();
  return new;
end;
$$;

create trigger preguntas_actualizada before update on public.preguntas
  for each row execute function public._tocar_actualizada();

create function public._nota(p_aciertos integer, p_errores integer, p_n integer, p_pen numeric)
returns numeric
language sql immutable set search_path = ''
as $$
  select case when p_n is null or p_n = 0 then null
              else greatest(0, round(10 * (p_aciertos - p_pen * p_errores) / p_n, 2)) end;
$$;

create function public._conteo(p_participacion uuid)
returns table (aciertos integer, errores integer)
language sql stable security definer set search_path = ''
as $$
  select count(*) filter (where r.opcion = sp.correcta)::integer,
         count(*) filter (where r.opcion <> sp.correcta)::integer
  from public.respuestas r
  join public.sesion_preguntas sp on sp.sesion_id = r.sesion_id and sp.posicion = r.posicion
  where r.participacion_id = p_participacion and r.aceptada and not r.anulada;
$$;

-- Una posición es "revelada" (se puede enseñar la correcta) cuando ya nadie
-- puede responderla: su ventana + 2 s de margen ha pasado. Si el orden está
-- barajado por alumno, la misma pregunta cae en turnos distintos: se espera
-- al cierre del último turno.
create function public._revelada(p_sesion uuid, p_posicion smallint) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  v_cierre timestamptz;
begin
  select * into s from public.sesiones where id = p_sesion;
  if s.estado = 'finalizada' then
    return true;
  end if;
  if s.barajar_preguntas then
    if exists (select 1 from public.sesion_preguntas
               where sesion_id = p_sesion and cierra_en is null) then
      return false;
    end if;
    select max(cierra_en) into v_cierre from public.sesion_preguntas where sesion_id = p_sesion;
  else
    select cierra_en into v_cierre from public.sesion_preguntas
    where sesion_id = p_sesion and posicion = p_posicion;
  end if;
  return v_cierre is not null and clock_timestamp() > v_cierre + interval '2 seconds';
end;
$$;

create function public._ventanas(p_sesion uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'turno', posicion, 'abierta_en', abierta_en, 'cierra_en', cierra_en)
           order by posicion), '[]'::jsonb)
  from public.sesion_preguntas
  where sesion_id = p_sesion and abierta_en is not null;
$$;

create function public._publicar_vivo(p_sesion uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  v_turno smallint;
  v_abre timestamptz;
  v_cierra timestamptz;
begin
  select * into s from public.sesiones where id = p_sesion;
  if s.modo = 'manual' then
    select posicion, abierta_en, cierra_en into v_turno, v_abre, v_cierra
    from public.sesion_preguntas
    where sesion_id = p_sesion and abierta_en is not null
    order by posicion desc limit 1;
  end if;
  insert into public.sesiones_vivo as v
    (sesion_id, estado, modo, inicio, turno_actual, abierta_en, cierra_en, actualizado_en)
  values (s.id, s.estado, s.modo, s.inicio, v_turno, v_abre, v_cierra, now())
  on conflict (sesion_id) do update
    set estado = excluded.estado, modo = excluded.modo, inicio = excluded.inicio,
        turno_actual = excluded.turno_actual, abierta_en = excluded.abierta_en,
        cierra_en = excluded.cierra_en, actualizado_en = excluded.actualizado_en;
end;
$$;

create function public._participacion(p_token text) returns public.participaciones
language plpgsql security definer set search_path = ''
as $$
declare
  p public.participaciones%rowtype;
begin
  select * into p from public.participaciones
  where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256');
  if not found then
    raise exception 'token_invalido' using errcode = '28000';
  end if;
  update public.participaciones set ultimo_contacto = now() where id = p.id;
  return p;
end;
$$;

create function public._pin_aleatorio() returns text
language plpgsql volatile set search_path = ''
as $$
declare
  b bytea := extensions.gen_random_bytes(2);
begin
  return lpad(((get_byte(b, 0) * 256 + get_byte(b, 1)) % 10000)::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------
-- RPC públicas (alumno, rol anon)
-- ---------------------------------------------------------------------

-- Precisión de ms para calcular el desfase de reloj del móvil.
create function public.hora_servidor() returns timestamptz
language sql volatile set search_path = ''
as $$ select clock_timestamp(); $$;

create function public.unirse_sesion(p_codigo text, p_id_alumno text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  a public.alumnos%rowtype;
  p public.participaciones%rowtype;
  v_token text;
  v_orden smallint[];
begin
  select * into s from public.sesiones
  where codigo = upper(trim(p_codigo)) and estado in ('abierta', 'en_curso');
  if not found then
    return jsonb_build_object('ok', false, 'error', 'codigo');
  end if;

  select * into a from public.alumnos
  where grupo_id = s.grupo_id and id_alumno = trim(p_id_alumno)
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;

  if a.bloqueado_hasta is not null and a.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'hasta', a.bloqueado_hasta);
  end if;

  if coalesce(p_pin, '') !~ '^[0-9]{4}$'
     or a.pin_hash is null
     or a.pin_hash <> extensions.crypt(p_pin, a.pin_hash) then
    -- 5 fallos seguidos bloquean 5 minutos (10.000 PIN posibles).
    update public.alumnos
       set intentos_fallidos = case when intentos_fallidos + 1 >= 5 then 0 else intentos_fallidos + 1 end,
           bloqueado_hasta   = case when intentos_fallidos + 1 >= 5 then now() + interval '5 minutes'
                                    else bloqueado_hasta end
     where id = a.id;
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;

  update public.alumnos set intentos_fallidos = 0, bloqueado_hasta = null where id = a.id;

  if s.barajar_preguntas then
    select array_agg(posicion order by random()) into v_orden
    from public.sesion_preguntas where sesion_id = s.id;
  else
    select array_agg(posicion order by posicion) into v_orden
    from public.sesion_preguntas where sesion_id = s.id;
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  -- Si ya estaba dentro (otro móvil, recarga sin token) se rota el token y
  -- se conserva su orden y sus respuestas.
  insert into public.participaciones as pa (sesion_id, alumno_id, token_hash, orden)
  values (s.id, a.id, extensions.digest(v_token, 'sha256'), v_orden)
  on conflict (sesion_id, alumno_id) do update
    set token_hash = excluded.token_hash, ultimo_contacto = now()
  returning * into p;

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'hora_servidor', clock_timestamp(),
    'alumno', jsonb_build_object('id_alumno', a.id_alumno, 'nombre', a.nombre),
    'sesion', jsonb_build_object(
      'id', s.id, 'titulo', s.titulo, 'modo', s.modo, 'estado', s.estado,
      'inicio', s.inicio, 'tiempo_s', s.tiempo_s, 'pausa_s', s.pausa_s,
      'barajar_opciones', s.barajar_opciones),
    'preguntas', (
      select jsonb_agg(jsonb_build_object(
               'turno', t.n - 1, 'posicion', sp.posicion,
               'enunciado', sp.enunciado, 'opciones', sp.opciones)
               order by t.n)
      from unnest(p.orden) with ordinality as t (posicion, n)
      join public.sesion_preguntas sp on sp.sesion_id = s.id and sp.posicion = t.posicion),
    'ventanas', public._ventanas(s.id),
    'respondidas', (
      select coalesce(jsonb_agg(r.posicion), '[]'::jsonb)
      from public.respuestas r where r.participacion_id = p.id)
  );
end;
$$;

create function public.estado_sesion(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.participaciones%rowtype;
  s public.sesiones%rowtype;
begin
  p := public._participacion(p_token);
  select * into s from public.sesiones where id = p.sesion_id;
  return jsonb_build_object(
    'hora_servidor', clock_timestamp(),
    'estado', s.estado,
    'modo', s.modo,
    'inicio', s.inicio,
    'ventanas', public._ventanas(s.id),
    'respondidas', (
      select coalesce(jsonb_agg(r.posicion), '[]'::jsonb)
      from public.respuestas r where r.participacion_id = p.id)
  );
end;
$$;

-- Idempotente: reenviar la misma (token, posicion) no duplica ni cambia nada.
-- No devuelve si es correcta: eso solo sale en mi_resultado tras el cierre.
create function public.enviar_respuesta(
  p_token text, p_posicion smallint, p_opcion smallint, p_t_respuesta timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.participaciones%rowtype;
  s public.sesiones%rowtype;
  v_turno integer;
  v_abre timestamptz;
  v_cierra timestamptz;
  v_n_opciones integer;
  v_t timestamptz;
  v_aceptada boolean;
  v_id bigint;
begin
  p := public._participacion(p_token);
  select * into s from public.sesiones where id = p.sesion_id;
  if s.estado not in ('en_curso', 'finalizada') then
    return jsonb_build_object('ok', false, 'error', 'no_iniciada');
  end if;

  v_turno := array_position(p.orden, p_posicion) - 1;
  if v_turno is null then
    return jsonb_build_object('ok', false, 'error', 'pregunta');
  end if;

  select array_length(opciones, 1) into v_n_opciones
  from public.sesion_preguntas where sesion_id = s.id and posicion = p_posicion;
  if p_opcion is null or p_opcion < 0 or p_opcion >= v_n_opciones then
    return jsonb_build_object('ok', false, 'error', 'opcion');
  end if;

  select abierta_en, cierra_en into v_abre, v_cierra
  from public.sesion_preguntas where sesion_id = s.id and posicion = v_turno;

  -- Un reloj de móvil adelantado no puede fechar en el futuro.
  v_t := least(p_t_respuesta, clock_timestamp());

  if v_abre is null or v_t < v_abre - interval '1 second' then
    -- Turno aún no abierto: no se guarda, así no bloquea una respuesta válida posterior.
    return jsonb_build_object('ok', false, 'error', 'no_abierta');
  end if;

  v_aceptada := v_t <= v_cierra + interval '2 seconds';

  insert into public.respuestas
    (participacion_id, sesion_id, posicion, turno, opcion, t_respuesta,
     ms_respuesta, aceptada, sincronizada_tarde)
  values
    (p.id, s.id, p_posicion, v_turno, p_opcion, v_t,
     greatest(0, (extract(epoch from (v_t - v_abre)) * 1000)::integer),
     v_aceptada,
     clock_timestamp() > v_cierra + interval '10 seconds')
  on conflict (participacion_id, posicion) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'duplicada', true);
  end if;
  return jsonb_build_object('ok', true,
    'estado', case when v_aceptada then 'registrada' else 'fuera_de_tiempo' end);
end;
$$;

create function public.mi_resultado(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.participaciones%rowtype;
  s public.sesiones%rowtype;
  v_n integer;
  v_todas boolean;
  c record;
begin
  p := public._participacion(p_token);
  select * into s from public.sesiones where id = p.sesion_id;
  v_n := array_length(p.orden, 1);

  select bool_and(public._revelada(s.id, x.posicion)) into v_todas
  from unnest(p.orden) as x (posicion);

  select * into c from public._conteo(p.id);

  return jsonb_build_object(
    'estado', s.estado,
    'preguntas', (
      select jsonb_agg(
        case when public._revelada(s.id, sp.posicion) then
          jsonb_build_object(
            'turno', t.n - 1, 'posicion', sp.posicion, 'revelada', true,
            'opcion', r.opcion, 'aceptada', r.aceptada,
            'correcta', sp.correcta, 'explicacion', sp.explicacion,
            'acierto', r.aceptada and not r.anulada and r.opcion = sp.correcta)
        else
          jsonb_build_object(
            'turno', t.n - 1, 'posicion', sp.posicion, 'revelada', false,
            'respondida', r.id is not null)
        end
        order by t.n)
      from unnest(p.orden) with ordinality as t (posicion, n)
      join public.sesion_preguntas sp on sp.sesion_id = s.id and sp.posicion = t.posicion
      left join public.respuestas r on r.participacion_id = p.id and r.posicion = sp.posicion),
    'nota', case when v_todas
                 then public._nota(c.aciertos, c.errores, v_n, s.penalizacion) end,
    'aciertos', case when v_todas then c.aciertos end,
    'errores', case when v_todas then c.errores end,
    'total', v_n
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPC del profesor (rol authenticated + es_profe)
-- ---------------------------------------------------------------------

create function public.generar_pines(p_grupo uuid, p_solo_sin_pin boolean default true)
returns table (alumno_id uuid, id_alumno text, nombre text, apellidos text, email text, pin text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_pin text;
begin
  perform public._exigir_profe();
  for r in
    select a.* from public.alumnos a
    where a.grupo_id = p_grupo and (not p_solo_sin_pin or a.pin_hash is null)
    order by a.apellidos, a.nombre
  loop
    v_pin := public._pin_aleatorio();
    update public.alumnos
       set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 8)),
           intentos_fallidos = 0, bloqueado_hasta = null
     where id = r.id;
    alumno_id := r.id; id_alumno := r.id_alumno; nombre := r.nombre;
    apellidos := r.apellidos; email := r.email; pin := v_pin;
    return next;
  end loop;
end;
$$;

create function public.generar_pin(p_alumno uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_pin text := public._pin_aleatorio();
begin
  perform public._exigir_profe();
  update public.alumnos
     set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 8)),
         intentos_fallidos = 0, bloqueado_hasta = null
   where id = p_alumno;
  if not found then
    raise exception 'alumno_inexistente';
  end if;
  return v_pin;
end;
$$;

-- Sustituye la lista de preguntas de una sesión en borrador (copia congelada).
create function public.asignar_preguntas(p_sesion uuid, p_preguntas uuid[]) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_n integer;
begin
  perform public._exigir_profe();
  if not exists (select 1 from public.sesiones where id = p_sesion and estado = 'borrador') then
    raise exception 'sesion_no_editable';
  end if;
  delete from public.sesion_preguntas where sesion_id = p_sesion;
  insert into public.sesion_preguntas
    (sesion_id, posicion, pregunta_id, enunciado, opciones, correcta, explicacion)
  select p_sesion, (t.n - 1)::smallint, q.id, q.enunciado, q.opciones, q.correcta, q.explicacion
  from unnest(p_preguntas) with ordinality as t (id, n)
  join public.preguntas q on q.id = t.id;
  get diagnostics v_n = row_count;
  if v_n <> coalesce(array_length(p_preguntas, 1), 0) then
    raise exception 'preguntas_inexistentes_o_repetidas';
  end if;
  return v_n;
end;
$$;

-- borrador -> abierta: genera el código y deja entrar a los alumnos (sala de espera).
create function public.lanzar_sesion(p_sesion uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codigo text;
  b bytea;
  i integer;
begin
  perform public._exigir_profe();
  if not exists (select 1 from public.sesiones where id = p_sesion and estado = 'borrador') then
    raise exception 'sesion_no_lanzable';
  end if;
  if not exists (select 1 from public.sesion_preguntas where sesion_id = p_sesion) then
    raise exception 'sesion_sin_preguntas';
  end if;
  loop
    b := extensions.gen_random_bytes(6);
    v_codigo := '';
    for i in 0..5 loop
      v_codigo := v_codigo || substr(v_alfabeto, get_byte(b, i) % 32 + 1, 1);
    end loop;
    exit when not exists (select 1 from public.sesiones
                          where codigo = v_codigo and estado in ('abierta', 'en_curso'));
  end loop;
  update public.sesiones
     set codigo = v_codigo, estado = 'abierta', fecha = current_date
   where id = p_sesion;
  perform public._publicar_vivo(p_sesion);
  return v_codigo;
end;
$$;

-- abierta -> en_curso. Modo fijo: fija ya el calendario completo, así el móvil
-- avanza solo aunque pierda la red. Modo manual: abre solo el turno 0.
create function public.iniciar_sesion(p_sesion uuid, p_espera_s integer default 5) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  v_inicio timestamptz := now() + make_interval(secs => greatest(p_espera_s, 0));
begin
  perform public._exigir_profe();
  select * into s from public.sesiones where id = p_sesion for update;
  if s.estado <> 'abierta' then
    raise exception 'sesion_no_abierta';
  end if;
  update public.sesiones set estado = 'en_curso', inicio = v_inicio where id = p_sesion;
  if s.modo = 'fijo' then
    update public.sesion_preguntas
       set abierta_en = v_inicio + make_interval(secs => posicion * (s.tiempo_s + s.pausa_s)),
           cierra_en  = v_inicio + make_interval(secs => posicion * (s.tiempo_s + s.pausa_s) + s.tiempo_s)
     where sesion_id = p_sesion;
  else
    update public.sesion_preguntas
       set abierta_en = v_inicio, cierra_en = v_inicio + make_interval(secs => s.tiempo_s)
     where sesion_id = p_sesion and posicion = 0;
  end if;
  perform public._publicar_vivo(p_sesion);
  return jsonb_build_object('inicio', v_inicio, 'ventanas', public._ventanas(p_sesion));
end;
$$;

-- Solo modo manual: cierra el turno abierto (si lo hay) y abre p_turno.
create function public.abrir_pregunta(p_sesion uuid, p_turno smallint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
begin
  perform public._exigir_profe();
  select * into s from public.sesiones where id = p_sesion for update;
  if s.estado <> 'en_curso' or s.modo <> 'manual' then
    raise exception 'sesion_no_manual_en_curso';
  end if;
  if not exists (select 1 from public.sesion_preguntas
                 where sesion_id = p_sesion and posicion = p_turno and abierta_en is null) then
    raise exception 'turno_no_disponible';
  end if;
  update public.sesion_preguntas set cierra_en = now()
   where sesion_id = p_sesion and cierra_en > now();
  update public.sesion_preguntas
     set abierta_en = now(), cierra_en = now() + make_interval(secs => s.tiempo_s)
   where sesion_id = p_sesion and posicion = p_turno;
  perform public._publicar_vivo(p_sesion);
  return jsonb_build_object('turno', p_turno, 'ventanas', public._ventanas(p_sesion));
end;
$$;

-- Modo manual: adelanta el cierre del turno. En ambos modos devuelve el reparto
-- para el proyector; la correcta solo cuando ya es "revelada" (cierre + 2 s),
-- así que el proyector debe esperar esos 2 s antes de pedirla.
create function public.cerrar_pregunta(p_sesion uuid, p_turno smallint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  q public.sesion_preguntas%rowtype;
  v_revelada boolean;
begin
  perform public._exigir_profe();
  select * into s from public.sesiones where id = p_sesion;
  if s.modo = 'manual' then
    update public.sesion_preguntas set cierra_en = now()
     where sesion_id = p_sesion and posicion = p_turno and cierra_en > now();
    perform public._publicar_vivo(p_sesion);
  end if;
  select * into q from public.sesion_preguntas where sesion_id = p_sesion and posicion = p_turno;
  if not found then
    raise exception 'turno_inexistente';
  end if;
  v_revelada := public._revelada(p_sesion, p_turno);
  return jsonb_build_object(
    'turno', p_turno,
    'enunciado', q.enunciado,
    'opciones', q.opciones,
    'cierra_en', q.cierra_en,
    'participantes', (select count(*) from public.participaciones where sesion_id = p_sesion),
    'respondidas', (select count(*) from public.respuestas
                    where sesion_id = p_sesion and posicion = p_turno and aceptada and not anulada),
    'reparto', (
      select jsonb_agg(coalesce(x.n, 0) order by i)
      from generate_series(0, array_length(q.opciones, 1) - 1) as i
      left join (select opcion, count(*) as n from public.respuestas
                 where sesion_id = p_sesion and posicion = p_turno and aceptada and not anulada
                 group by opcion) x on x.opcion = i),
    'revelada', v_revelada,
    'correcta', case when v_revelada then q.correcta end,
    'explicacion', case when v_revelada then q.explicacion end
  );
end;
$$;

create function public.finalizar_sesion(p_sesion uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public._exigir_profe();
  update public.sesion_preguntas set cierra_en = now()
   where sesion_id = p_sesion and cierra_en > now();
  update public.sesiones set estado = 'finalizada'
   where id = p_sesion and estado in ('abierta', 'en_curso');
  if not found then
    raise exception 'sesion_no_finalizable';
  end if;
  perform public._publicar_vivo(p_sesion);
end;
$$;

-- presentado = false -> "no presentado" (nota null), nunca 0.
create function public.notas_sesion(p_sesion uuid)
returns table (alumno_id uuid, id_alumno text, nombre text, apellidos text, email text,
               presentado boolean, aciertos integer, errores integer, en_blanco integer,
               tardias integer, nota numeric)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_grupo uuid;
  v_pen numeric;
  v_n integer;
begin
  perform public._exigir_profe();
  select s.grupo_id, s.penalizacion into v_grupo, v_pen from public.sesiones s where s.id = p_sesion;
  select count(*) into v_n from public.sesion_preguntas sp where sp.sesion_id = p_sesion;
  return query
  select a.id, a.id_alumno, a.nombre, a.apellidos, a.email,
         p.id is not null,
         case when p.id is not null then c.aciertos end,
         case when p.id is not null then c.errores end,
         case when p.id is not null then v_n - c.aciertos - c.errores end,
         case when p.id is not null then
           (select count(*)::integer from public.respuestas r
            where r.participacion_id = p.id and r.sincronizada_tarde) end,
         case when p.id is not null then public._nota(c.aciertos, c.errores, v_n, v_pen) end
  from public.alumnos a
  left join public.participaciones p on p.alumno_id = a.id and p.sesion_id = p_sesion
  left join lateral public._conteo(p.id) c on true
  where a.grupo_id = v_grupo
  order by a.apellidos, a.nombre;
end;
$$;

-- Media de notas del día de las sesiones finalizadas del grupo en el rango.
-- p_descartar quita las N peores (siempre queda al menos una).
-- notas: {sesion_id: nota | null(no presentado)} para las columnas del CSV.
create function public.notas_trimestre(
  p_grupo uuid, p_desde date default null, p_hasta date default null,
  p_descartar integer default 0, p_ausencia_cero boolean default false)
returns table (alumno_id uuid, id_alumno text, nombre text, apellidos text, email text,
               nota_trimestre numeric, sesiones_contadas integer, notas jsonb)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public._exigir_profe();
  return query
  with ses as (
    select s.id from public.sesiones s
    where s.grupo_id = p_grupo and s.estado = 'finalizada'
      and (p_desde is null or s.fecha >= p_desde)
      and (p_hasta is null or s.fecha <= p_hasta)
  ),
  n as (
    select ns.alumno_id, s.id as sesion_id, ns.nota,
           case when ns.presentado then ns.nota
                when p_ausencia_cero then 0::numeric end as valor
    from ses s cross join lateral public.notas_sesion(s.id) ns
  ),
  r as (
    select n.alumno_id, n.valor,
           row_number() over (partition by n.alumno_id order by n.valor) as rn,
           count(*) over (partition by n.alumno_id) as total
    from n where n.valor is not null
  )
  select a.id, a.id_alumno, a.nombre, a.apellidos, a.email,
         (select round(avg(r.valor), 2) from r
          where r.alumno_id = a.id and r.rn > least(greatest(p_descartar, 0), r.total - 1)),
         (select count(*)::integer from r
          where r.alumno_id = a.id and r.rn > least(greatest(p_descartar, 0), r.total - 1)),
         coalesce((select jsonb_object_agg(n.sesion_id, n.nota) from n where n.alumno_id = a.id),
                  '{}'::jsonb)
  from public.alumnos a
  where a.grupo_id = p_grupo
  order by a.apellidos, a.nombre;
end;
$$;

-- Solo para motivar en el proyector: no cuenta para la nota. Solo puntúa
-- preguntas ya reveladas, para no filtrar aciertos durante la pregunta.
create function public.ranking_sesion(p_sesion uuid, p_limite integer default 10)
returns table (nombre text, apellidos text, puntos integer, aciertos integer)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ms numeric;
begin
  perform public._exigir_profe();
  select s.tiempo_s * 1000 into v_ms from public.sesiones s where s.id = p_sesion;
  return query
  select a.nombre, a.apellidos,
         coalesce(sum(round(1000 * (1 - 0.5 * least(r.ms_respuesta, v_ms) / v_ms)))
                  filter (where r.opcion = sp.correcta), 0)::integer as puntos,
         (count(*) filter (where r.opcion = sp.correcta))::integer
  from public.participaciones p
  join public.alumnos a on a.id = p.alumno_id
  left join public.respuestas r
    on r.participacion_id = p.id and r.aceptada and not r.anulada
   and public._revelada(p_sesion, r.posicion)
  left join public.sesion_preguntas sp on sp.sesion_id = r.sesion_id and sp.posicion = r.posicion
  where p.sesion_id = p_sesion
  group by a.id, a.nombre, a.apellidos
  order by puntos desc, a.apellidos
  limit p_limite;
end;
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profesores       enable row level security;
alter table public.grupos           enable row level security;
alter table public.alumnos          enable row level security;
alter table public.preguntas        enable row level security;
alter table public.sesiones         enable row level security;
alter table public.sesion_preguntas enable row level security;
alter table public.participaciones  enable row level security;
alter table public.respuestas       enable row level security;
alter table public.sesiones_vivo    enable row level security;

create policy profe_lee_su_fila on public.profesores
  for select to authenticated using (user_id = (select auth.uid()));

create policy profe_todo on public.grupos
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.alumnos
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.preguntas
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.sesiones
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.sesion_preguntas
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.participaciones
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));
create policy profe_todo on public.respuestas
  for all to authenticated using ((select public.es_profe())) with check ((select public.es_profe()));

create policy vivo_lectura on public.sesiones_vivo
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------
-- Permisos: anon no toca tablas (salvo sesiones_vivo) ni funciones internas
-- ---------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select on public.sesiones_vivo to anon;
-- Nadie escribe sesiones_vivo directamente: solo _publicar_vivo.
revoke insert, update, delete, truncate on public.sesiones_vivo from authenticated;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from public, anon;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.hora_servidor()                                    to anon, authenticated;
grant execute on function public.unirse_sesion(text, text, text)                    to anon, authenticated;
grant execute on function public.estado_sesion(text)                                to anon, authenticated;
grant execute on function public.enviar_respuesta(text, smallint, smallint, timestamptz) to anon, authenticated;
grant execute on function public.mi_resultado(text)                                 to anon, authenticated;

grant execute on function public.es_profe()                                         to authenticated;
grant execute on function public.generar_pines(uuid, boolean)                       to authenticated;
grant execute on function public.generar_pin(uuid)                                  to authenticated;
grant execute on function public.asignar_preguntas(uuid, uuid[])                    to authenticated;
grant execute on function public.lanzar_sesion(uuid)                                to authenticated;
grant execute on function public.iniciar_sesion(uuid, integer)                      to authenticated;
grant execute on function public.abrir_pregunta(uuid, smallint)                     to authenticated;
grant execute on function public.cerrar_pregunta(uuid, smallint)                    to authenticated;
grant execute on function public.finalizar_sesion(uuid)                             to authenticated;
grant execute on function public.notas_sesion(uuid)                                 to authenticated;
grant execute on function public.notas_trimestre(uuid, date, date, integer, boolean) to authenticated;
grant execute on function public.ranking_sesion(uuid, integer)                      to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: alumnos escuchan sesiones_vivo; el proyector, respuestas (RLS profe)
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.sesiones_vivo, public.respuestas;
