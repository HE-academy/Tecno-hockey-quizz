-- Migración 2026-10-14: el alumno importado elige su PIN al entrar.
-- Aplicar una vez en el SQL Editor del proyecto (ya con schema.sql anterior).
-- schema.sql ya incluye estos cambios para instalaciones nuevas.

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

-- Autoinscripción: el alumno se da de alta en el grupo de la sesión cuyo
-- código tiene (solo con sesión abierta y email de TecnoCampus), elige su PIN
-- y recibe un id de 6 cifras para siempre. Después entra como unirse_sesion.
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
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;

  select * into v_existente from public.alumnos
  where grupo_id = s.grupo_id and lower(email) = v_email;
  if found then
    -- Importado por el profesor y sin PIN: se queda con el que elige ahora
    -- (nombre y apellidos, los de la lista del profesor).
    if v_existente.pin_hash is null then
      return public.elegir_pin(p_codigo, v_existente.id_alumno, p_pin)
             || jsonb_build_object('nuevo_id', v_existente.id_alumno);
    end if;
    -- El id no es secreto (el PIN sí): se le recuerda para que entre.
    return jsonb_build_object('ok', false, 'error', 'ya_registrado', 'id_alumno', v_existente.id_alumno);
  end if;
  -- Freno a altas masivas con un código filtrado.
  if (select count(*) from public.alumnos where grupo_id = s.grupo_id) >= 150 then
    return jsonb_build_object('ok', false, 'error', 'grupo_lleno');
  end if;

  loop
    v_id := lpad((floor(random() * 900000) + 100000)::integer::text, 6, '0');
    exit when not exists (select 1 from public.alumnos where id_alumno = v_id);
  end loop;

  insert into public.alumnos (grupo_id, id_alumno, nombre, apellidos, email, pin_hash)
  values (s.grupo_id, v_id, v_nombre, v_apellidos, v_email,
          extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));

  return public.unirse_sesion(p_codigo, v_id, p_pin) || jsonb_build_object('nuevo_id', v_id);
end;
$$;

-- Primer acceso de un alumno importado por el profesor: elige su PIN y entra.
-- Solo con el código de una sesión abierta (en clase) y solo si aún no tiene
-- PIN; si alguien se lo quedó por error, el profesor lo quita (quitar_pin).
create function public.elegir_pin(p_codigo text, p_id_alumno text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sesiones%rowtype;
  a public.alumnos%rowtype;
begin
  select * into s from public.sesiones
  where codigo = upper(trim(p_codigo)) and estado in ('abierta', 'en_curso');
  if not found then
    return jsonb_build_object('ok', false, 'error', 'codigo');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;

  select * into a from public.alumnos
  where grupo_id = s.grupo_id
    and (id_alumno = trim(p_id_alumno) or lower(email) = lower(trim(p_id_alumno)))
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;
  if a.pin_hash is not null then
    return jsonb_build_object('ok', false, 'error', 'ya_tiene_pin');
  end if;

  update public.alumnos
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
         intentos_fallidos = 0, bloqueado_hasta = null
   where id = a.id;

  return public.unirse_sesion(p_codigo, a.id_alumno, p_pin);
end;
$$;

-- El alumno vuelve a elegir PIN la próxima vez que entre (lo olvidó, o se lo
-- quedó otro).
create function public.quitar_pin(p_alumno uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public._exigir_profe();
  update public.alumnos
     set pin_hash = null, intentos_fallidos = 0, bloqueado_hasta = null
   where id = p_alumno;
  if not found then
    raise exception 'alumno_inexistente';
  end if;
end;
$$;

revoke execute on function public.elegir_pin(text, text, text) from public, anon, authenticated;
revoke execute on function public.quitar_pin(uuid) from public, anon, authenticated;
grant execute on function public.elegir_pin(text, text, text) to anon, authenticated;
grant execute on function public.quitar_pin(uuid)             to authenticated;

commit;
