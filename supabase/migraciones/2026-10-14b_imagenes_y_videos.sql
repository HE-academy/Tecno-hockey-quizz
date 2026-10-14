-- Migración 2026-10-14b: imágenes y vídeos en las preguntas.
-- Aplicar después de 2026-10-14_pin_al_entrar.sql, en el SQL Editor.
-- schema.sql ya incluye estos cambios para instalaciones nuevas.

begin;

alter table public.preguntas
  add column imagen        text check (imagen ~ '^[0-9a-f]{64}\.(webp|jpg|png)$'),
  add column video         text check (video ~ '^([0-9a-f]{64}\.(mp4|webm)|yt:[A-Za-z0-9_-]{11})$'),
  add column video_desde_s integer not null default 0 check (video_desde_s >= 0),
  add column video_s       smallint check (video_s between 1 and 180),
  add constraint preguntas_video_s check ((video is null) = (video_s is null));

alter table public.sesion_preguntas
  add column imagen        text,
  add column video         text,
  add column video_desde_s integer not null default 0,
  add column video_s       smallint;

create or replace function public.unirse_sesion(p_codigo text, p_id_alumno text, p_pin text)
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
  where grupo_id = s.grupo_id
    and (id_alumno = trim(p_id_alumno) or lower(email) = lower(trim(p_id_alumno)))
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;

  if a.bloqueado_hasta is not null and a.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'hasta', a.bloqueado_hasta);
  end if;

  -- Importado por el profesor y aún sin PIN: lo elige al entrar (elegir_pin).
  -- Nombre + inicial para que confirme que es él antes de quedarse la cuenta.
  if a.pin_hash is null then
    return jsonb_build_object('ok', false, 'error', 'sin_pin',
      'nombre', a.nombre || case when a.apellidos <> '' then ' ' || left(a.apellidos, 1) || '.' else '' end);
  end if;

  -- Un PIN mal formado (vacío) no es un intento: no cuenta para el bloqueo.
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;

  if a.pin_hash <> extensions.crypt(p_pin, a.pin_hash) then
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
               'enunciado', sp.enunciado, 'opciones', sp.opciones,
               'imagen', sp.imagen, 'video_s', sp.video_s)
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

-- Sustituye la lista de preguntas de una sesión en borrador (copia congelada).
create or replace function public.asignar_preguntas(p_sesion uuid, p_preguntas uuid[]) returns integer
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
    (sesion_id, posicion, pregunta_id, enunciado, opciones, correcta, explicacion,
     imagen, video, video_desde_s, video_s)
  select p_sesion, (t.n - 1)::smallint, q.id, q.enunciado, q.opciones, q.correcta, q.explicacion,
         q.imagen, q.video, q.video_desde_s, q.video_s
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
create or replace function public.lanzar_sesion(p_sesion uuid) returns text
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
  -- El vídeo se ve en el proyector: todos tienen que estar en la misma pregunta.
  if exists (select 1 from public.sesiones where id = p_sesion and barajar_preguntas)
     and exists (select 1 from public.sesion_preguntas where sesion_id = p_sesion and video is not null) then
    raise exception 'video_con_barajar';
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
create or replace function public.iniciar_sesion(p_sesion uuid, p_espera_s integer default 5) returns jsonb
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
  -- Cada vídeo se ve justo antes de su pregunta: retrasa esa ventana y las siguientes.
  if s.modo = 'fijo' then
    update public.sesion_preguntas sp
       set abierta_en = v_inicio + make_interval(secs => sp.posicion * (s.tiempo_s + s.pausa_s) + x.video_acum),
           cierra_en  = v_inicio + make_interval(secs => sp.posicion * (s.tiempo_s + s.pausa_s) + x.video_acum + s.tiempo_s)
      from (select posicion, sum(coalesce(video_s, 0)) over (order by posicion) as video_acum
              from public.sesion_preguntas where sesion_id = p_sesion) x
     where sp.sesion_id = p_sesion and sp.posicion = x.posicion;
  else
    update public.sesion_preguntas
       set abierta_en = v_inicio + make_interval(secs => coalesce(video_s, 0)),
           cierra_en  = v_inicio + make_interval(secs => coalesce(video_s, 0) + s.tiempo_s)
     where sesion_id = p_sesion and posicion = 0;
  end if;
  perform public._publicar_vivo(p_sesion);
  return jsonb_build_object('inicio', v_inicio, 'ventanas', public._ventanas(p_sesion));
end;
$$;

-- Solo modo manual: cierra el turno abierto (si lo hay) y abre p_turno.
create or replace function public.abrir_pregunta(p_sesion uuid, p_turno smallint) returns jsonb
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
     set abierta_en = now() + make_interval(secs => coalesce(video_s, 0)),
         cierra_en  = now() + make_interval(secs => coalesce(video_s, 0) + s.tiempo_s)
   where sesion_id = p_sesion and posicion = p_turno;
  perform public._publicar_vivo(p_sesion);
  return jsonb_build_object('turno', p_turno, 'ventanas', public._ventanas(p_sesion));
end;
$$;

-- Archivos del bucket "medios" con su tamaño y si alguna pregunta o sesión los
-- usa. Los que no, se borran desde el panel con la API de Storage (no por SQL).
create function public.medios_uso()
returns table (nombre text, bytes bigint, en_uso boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public._exigir_profe();
  if to_regclass('storage.objects') is null then
    return;
  end if;
  return query
  select o.name, coalesce((o.metadata ->> 'size')::bigint, 0),
         exists (select 1 from public.preguntas q where o.name in (q.imagen, q.video))
         or exists (select 1 from public.sesion_preguntas sp where o.name in (sp.imagen, sp.video))
  from storage.objects o
  where o.bucket_id = 'medios';
end;
$$;

revoke execute on function public.medios_uso() from public, anon, authenticated;
grant execute on function public.medios_uso() to authenticated;

-- Lectura pública por URL (los nombres son sha256: no se adivinan) para que
-- los móviles no necesiten cuenta. Solo el profesor sube, lista y borra.
-- 20 MB por archivo: el plan gratuito da 1 GB en total.
do $$
begin
  if to_regclass('storage.objects') is null then
    return;  -- Postgres sin Supabase Storage (tests)
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('medios', 'medios', true, 20971520,
          array['image/webp', 'image/jpeg', 'image/png', 'video/mp4', 'video/webm'])
  on conflict (id) do update
    set public = excluded.public, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  drop policy if exists medios_profe_lee on storage.objects;
  drop policy if exists medios_profe_sube on storage.objects;
  drop policy if exists medios_profe_borra on storage.objects;
  create policy medios_profe_lee on storage.objects for select to authenticated
    using (bucket_id = 'medios' and (select public.es_profe()));
  create policy medios_profe_sube on storage.objects for insert to authenticated
    with check (bucket_id = 'medios' and (select public.es_profe()));
  create policy medios_profe_borra on storage.objects for delete to authenticated
    using (bucket_id = 'medios' and (select public.es_profe()));
end;
$$;

commit;
