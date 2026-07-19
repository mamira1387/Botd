-- ==========================================================
-- Depth TON Bot — Supabase Schema
-- اجرا کن این فایل رو داخل SQL Editor پروژه Supabase
-- ==========================================================

-- جدول کاربران / ولت‌ها
create table if not exists users (
  user_id     bigint primary key,
  username    text,
  first_name  text,
  balance     bigint not null default 0,   -- موجودی به کوچکترین واحد (عدد صحیح)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- جدول ادمین‌ها (OWNER_ID همیشه از env خونده میشه و نیازی به رکورد نداره)
create table if not exists admins (
  user_id     bigint primary key references users(user_id),
  added_by    bigint,
  created_at  timestamptz not null default now()
);

-- جدول قبض‌ها
create table if not exists bills (
  id            uuid primary key default gen_random_uuid(),
  creator_id    bigint not null references users(user_id),
  amount        bigint not null,
  max_uses      int not null,
  used_count    int not null default 0,
  chat_id       bigint,          -- چتی که قبض توش ساخته شده (برای ادیت پیام)
  message_id    bigint,          -- آیدی پیام قبض برای ادیت لحظه‌ای
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- جدول پرداخت‌کننده‌های هر قبض (جلوگیری از پرداخت تکراری)
create table if not exists bill_payments (
  bill_id     uuid not null references bills(id),
  user_id     bigint not null references users(user_id),
  paid_at     timestamptz not null default now(),
  primary key (bill_id, user_id)
);

-- جدول انتقال‌های در انتظار تایید (دکمه شیشه‌ای)
create table if not exists pending_transfers (
  id            uuid primary key default gen_random_uuid(),
  from_user_id  bigint not null references users(user_id),
  to_user_id    bigint not null references users(user_id),
  amount        bigint not null,
  chat_id       bigint not null,
  message_id    bigint,          -- آیدی پیام حاوی دکمه‌ها (برای ادیت/حذف)
  status        text not null default 'pending', -- pending | confirmed | cancelled | expired
  created_at    timestamptz not null default now()
);

-- تابع اتمیک برای انتقال موجودی (جلوگیری از race condition)
create or replace function transfer_balance(
  p_from bigint,
  p_to   bigint,
  p_amount bigint
) returns boolean
language plpgsql
as $$
declare
  v_balance bigint;
begin
  -- قفل ردیف فرستنده
  select balance into v_balance from users where user_id = p_from for update;

  if v_balance is null or v_balance < p_amount then
    return false;
  end if;

  update users set balance = balance - p_amount, updated_at = now() where user_id = p_from;
  update users set balance = balance + p_amount, updated_at = now() where user_id = p_to;

  return true;
end;
$$;
