-- Records, at write time, whether an event crossed a notification threshold
-- and which one. Computed when the event is created rather than recomputed
-- by every reader, so the review tool and any future delivery channel agree
-- by construction instead of reimplementing the same rule twice.
--
-- This does NOT send anything. There is still no delivery channel. These
-- columns are the queue a delivery channel would later read, and today they
-- are what the review tool surfaces.
alter table public.distress_events
  add column if not exists notification_worthy boolean not null default false;

alter table public.distress_events
  add column if not exists notification_reason text
    check (notification_reason in ('interpersonal_harm', 'pattern'));

-- A reason must be present exactly when the flag is set, so the two cannot
-- disagree. Same discipline as escalation_enabled and the distress reader
-- commitment fields.
alter table public.distress_events
  drop constraint if exists distress_events_notification_reason_complete;
alter table public.distress_events
  add constraint distress_events_notification_reason_complete
  check (notification_worthy = (notification_reason is not null));

comment on column public.distress_events.notification_worthy is
  'True when this event crossed a notification threshold at write time: either interpersonal_harm (bypasses the pattern requirement, surfaces on first occurrence) or pattern (3+ events at possible_risk or above for the same identified student in the same course within 7 days). Recording only; nothing is sent.';

create index if not exists distress_events_notification_worthy_idx
  on public.distress_events (created_at desc)
  where notification_worthy;
