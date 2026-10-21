-- Migración 2026-10-22: si ya han respondido todos los unidos a la sesión, la
-- pregunta se cierra sin esperar al reloj (en modo fijo se adelanta el resto
-- del calendario lo mismo).
-- Aplicar una vez en el SQL Editor del proyecto (ya con las migraciones del 14-10).
-- schema.sql ya incluye estos cambios para instalaciones nuevas.

begin;

create function public._cerrar_si_respondieron_todos(p_sesion uuid, p_turno smallint) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_cierra timestamptz;
  v_ahora timestamptz;
begin
  -- Bloquea el turno: si los dos últimos responden a la vez, el segundo
  -- espera al primero y ya cuenta su respuesta.
  select cierra_en into v_cierra from public.sesion_preguntas
  where sesion_id = p_sesion and posicion = p_turno for update;
  v_ahora := clock_timestamp();
  if v_cierra is null or v_cierra <= v_ahora then
    return;
  end if;
  if (select count(*) from public.respuestas where sesion_id = p_sesion and turno = p_turno)
     < (select count(*) from public.participaciones where sesion_id = p_sesion) then
    return;
  end if;
  if (select modo from public.sesiones where id = p_sesion) = 'fijo' then
    update public.sesion_preguntas
       set abierta_en = abierta_en - (v_cierra - v_ahora),
           cierra_en  = cierra_en - (v_cierra - v_ahora)
     where sesion_id = p_sesion and posicion > p_turno and abierta_en is not null;
  end if;
  update public.sesion_preguntas set cierra_en = v_ahora
   where sesion_id = p_sesion and posicion = p_turno;
  perform public._publicar_vivo(p_sesion);
end;
$$;

revoke execute on function public._cerrar_si_respondieron_todos(uuid, smallint) from public, anon, authenticated;

create or replace function public.enviar_respuesta(
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

  if p_opcion is null or p_opcion not between 0 and 4 then
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
  if v_aceptada then
    perform public._cerrar_si_respondieron_todos(s.id, v_turno::smallint);
  end if;
  return jsonb_build_object('ok', true,
    'estado', case when v_aceptada then 'registrada' else 'fuera_de_tiempo' end);
end;
$$;

commit;
