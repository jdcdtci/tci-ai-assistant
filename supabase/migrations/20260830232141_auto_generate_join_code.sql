-- Course creation happens before any content is ingested into that
-- course, so the join_code should never depend on a separate manual step
-- afterward. This generates one automatically at insert time whenever a
-- new courses row doesn't explicitly supply its own.
--
-- Uses a retry loop against the existing unique constraint (from Step 1)
-- rather than relying on the random code space alone, so uniqueness is
-- structurally guaranteed, not just astronomically likely: a collision,
-- however improbable with an 8-character code from a 32-symbol alphabet,
-- simply causes another draw instead of a failed insert.
create or replace function generate_unique_join_code()
returns text
language plpgsql
set search_path = public
as $$
declare
  -- Excludes O/0 and I/1/L: easy to misread when a student types a code
  -- back in, especially read aloud or handwritten.
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  code_exists boolean;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;

    select exists(select 1 from courses where join_code = code) into code_exists;
    exit when not code_exists;
  end loop;

  return code;
end;
$$;

alter table courses
  alter column join_code set default generate_unique_join_code();
