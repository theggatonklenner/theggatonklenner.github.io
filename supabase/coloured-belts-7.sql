-- AMA Toolkit: coloured belt grading, update 7 (pay the grading fee by card, then book the EFC session automatically)
-- Run once in Supabase > SQL Editor, after coloured-belts-6.sql. Safe to run again.
-- A family's booking link can take the fee by card (Stripe Checkout). When Stripe confirms the payment the "cb" function marks
-- them paid and sends the booking to your Zap, which books the EFC grading session (set that session to $0 in EFC so
-- EFC doesn't charge again). Families can still book and pay at the front desk instead.

-- How it was paid: 'card' (Stripe) or 'desk' (marked by staff)
alter table public.cb_entries add column if not exists paid_how text;

-- Card payments. Only payments staff (and admins) can see amounts.
create table if not exists public.cb_payments (
  payment_id     uuid primary key default gen_random_uuid(),
  entry_id       uuid references public.cb_entries on delete set null,
  member_key     text,
  full_name      text,
  day_id         uuid,
  amount         numeric(8,2),
  status         text not null default 'pending' check (status in ('pending', 'paid')),
  stripe_session text unique,
  stripe_payment text,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz
);
create index if not exists cb_payments_entry_idx on public.cb_payments (entry_id);
alter table public.cb_payments enable row level security;
drop policy if exists "read" on public.cb_payments;
create policy "read" on public.cb_payments for select to authenticated using (public.prep_has_role('payments'));
revoke all on public.cb_payments from anon, authenticated;
grant select on public.cb_payments to authenticated;

-- Staff can mark a front-desk payment, but not undo a card payment (refund it in Stripe)
create or replace function public.cb_set_paid(p_entry uuid, p_paid boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('grading', 'payments') then raise exception 'Only grading or payments staff can change paid.'; end if;
  if not p_paid and exists (select 1 from cb_payments where entry_id = p_entry and status = 'paid') then
    raise exception 'This was paid by card. Refund it in Stripe if needed.';
  end if;
  update cb_entries set paid = p_paid, paid_at = case when p_paid then now() end, paid_how = case when p_paid then coalesce(paid_how, 'desk') end where entry_id = p_entry;
end $$;
