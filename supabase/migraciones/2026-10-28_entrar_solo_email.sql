-- Migración 2026-10-28: el alumno entra solo con su email, sin PIN.
-- unirse_sesion ya no mira el PIN ni bloquea por intentos (p_pin se mantiene y
-- se ignora, para los móviles con la versión vieja). registrar_alumno no pide
-- PIN y, si el email ya está en el grupo, entra con esa ficha.
-- Aplicar una vez en el SQL Editor del proyecto. schema.sql ya lo incluye.

begin;
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

  -- Se entra solo con el email (o el id): el PIN ya no se pide y p_pin se
  -- ignora (se mantiene el parámetro para no romper móviles con la versión vieja).
  select * into a from public.alumnos
  where grupo_id = s.grupo_id
    and (id_alumno = trim(p_id_alumno) or lower(email) = lower(trim(p_id_alumno)))
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;

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

-- Autoinscripción: el alumno se da de alta en el grupo de la sesión cuyo
-- código tiene (solo con sesión abierta y email de TecnoCampus) y recibe un id
-- de 6 cifras. Después entra solo con su email. p_pin se ignora.
create or replace function public.registrar_alumno(
  p_codigo text, p_nombre text, p_apellidos text, p_email text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  v_nombre text := left(regexp_replace(trim(coalesce(p_nombre, '')), '\s+', ' ', 'g'), 60);
  v_apellidos text := left(regexp_replace(trim(coalesce(p_apellidos, '')), '\s+', ' ', 'g'), 80);
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id text;
  v_existente public.alumnos%rowtype;
begin
  select * into s from public.sesiones
  where codigo = upper(trim(p_codigo)) and estado in ('abierta', 'en_curso');
  if not found then
    return jsonb_build_object('ok', false, 'error', 'codigo');
  end if;
  if v_nombre = '' or v_apellidos = '' then
    return jsonb_build_object('ok', false, 'error', 'nombre');
  end if;
  if v_email !~ '^[^@\s]+@([a-z0-9-]+\.)*tecnocampus\.cat$' then
    return jsonb_build_object('ok', false, 'error', 'email');
  end if;
  -- Ya estaba (registrado antes o importado por el profesor): entra con su
  -- ficha, sin pisar el nombre de la lista del profesor.
  select * into v_existente from public.alumnos
  where grupo_id = s.grupo_id and lower(email) = v_email;
  if found then
    return public.unirse_sesion(p_codigo, v_existente.id_alumno, null)
           || jsonb_build_object('nuevo_id', v_existente.id_alumno);
  end if;
  -- Freno a altas masivas con un código filtrado.
  if (select count(*) from public.alumnos where grupo_id = s.grupo_id) >= 150 then
    return jsonb_build_object('ok', false, 'error', 'grupo_lleno');
  end if;

  loop
    v_id := lpad((floor(random() * 900000) + 100000)::integer::text, 6, '0');
    exit when not exists (select 1 from public.alumnos where id_alumno = v_id);
  end loop;

  insert into public.alumnos (grupo_id, id_alumno, nombre, apellidos, email)
  values (s.grupo_id, v_id, v_nombre, v_apellidos, v_email);

  return public.unirse_sesion(p_codigo, v_id, null) || jsonb_build_object('nuevo_id', v_id);
end;
$$;

commit;
