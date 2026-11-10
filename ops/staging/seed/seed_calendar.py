"""Synthetic staging seed for the CRM calendar. Not committed. Run from the backend directory with the staging env loaded."""
import os
import sys
from datetime import time

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.getcwd())
from app.db.models.admin_user import AdminUser  # noqa: E402
from app.db.models.birthday_booking_room import BirthdayBookingRoom  # noqa: E402
from app.db.models.birthday_booking_slot import BirthdayBookingSlot  # noqa: E402
from app.db.models.birthday_package import BirthdayPackage  # noqa: E402
from app.db.models.branch import Branch  # noqa: E402

engine = create_engine(os.environ["DATABASE_URL"])
Session = sessionmaker(bind=engine)
DOMAIN = "staging.boombala.example.com"

with Session() as s:
    s.execute(text(
        "TRUNCATE TABLE birthday_booking_audit, birthday_booking_commands, birthday_slot_reservations, "
        "birthday_payment_facts, birthday_requests, birthday_booking_rooms, birthday_booking_slots, "
        "birthday_packages, admin_sessions, admin_users, branches CASCADE"
    ))
    s.commit()
    s.add_all([
        Branch(id="stg-almaty", slug="stg-almaty", name="Тест-Алматы", city="Almaty", address="Тест", short_label="Алматы",
               working_hours="10:00-22:00", booking_buffer_minutes=30, description="Тест", phone="+77070000000", whatsapp_phone="+77070000000",
               gallery_image_urls=[], facilities=[], display_order=1, is_active=True),
    ])
    s.flush()
    s.add_all([
        AdminUser(id="stg-manager-a", email=f"manager-a@{DOMAIN}", full_name="Менеджер А", password_hash="x", role="sales_manager", branch_id=None, is_active=True),
        AdminUser(id="stg-manager-b", email=f"manager-b@{DOMAIN}", full_name="Менеджер Б", password_hash="x", role="sales_manager", branch_id=None, is_active=True),
        AdminUser(id="stg-operator-almaty", email=f"operator-almaty@{DOMAIN}", full_name="Оператор Алматы", password_hash="x", role="operator", branch_id="stg-almaty", is_active=True),
        AdminUser(id="stg-owner", email=f"owner@{DOMAIN}", full_name="Владелец (тест)", password_hash="x", role="super_admin", branch_id=None, is_active=True),
        BirthdayPackage(id="stg-pkg-start", branch_id="stg-almaty", slug="stg-start", name="Старт", price_from=55000, price_label="от 55 000 ₸",
                        guest_capacity_label="до 15 гостей", description="Тест", highlights=[], is_featured=False, is_active=True, display_order=1),
        BirthdayPackage(id="stg-pkg-party", branch_id="stg-almaty", slug="stg-party", name="Вечеринка", price_from=95000, price_label="от 95 000 ₸",
                        guest_capacity_label="до 30 гостей", description="Тест", highlights=[], is_featured=True, is_active=True, display_order=2),
        BirthdayBookingRoom(id="stg-room-a", branch_id="stg-almaty", name="Комната A", display_order=1, is_active=True),
        BirthdayBookingRoom(id="stg-room-b", branch_id="stg-almaty", name="Комната B", display_order=2, is_active=True),
        BirthdayBookingRoom(id="stg-room-c", branch_id="stg-almaty", name="Комната C", display_order=3, is_active=True),
        BirthdayBookingRoom(id="stg-room-d", branch_id="stg-almaty", name="Комната D", display_order=4, is_active=True),
        BirthdayBookingSlot(id="stg-slot-morning", code="stg-slot-morning", starts_at=time(10), ends_at=time(14), is_active=True),
        BirthdayBookingSlot(id="stg-slot-evening", code="stg-slot-evening", starts_at=time(14), ends_at=time(18), is_active=True),
    ])
    s.commit()
print("seeded")
