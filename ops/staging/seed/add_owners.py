import os, sys
sys.path.insert(0, os.getcwd())
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db.models.admin_user import AdminUser
engine = create_engine(os.environ["DATABASE_URL"])
with sessionmaker(bind=engine)() as s:
    for suffix, name in (("a", "Тест владелец A"), ("b", "Тест владелец B")):
        s.add(AdminUser(id=f"stg-owner-{suffix}", email=f"owner-{suffix}@staging.boombala.example.com", full_name=name, password_hash="x", role="super_admin", branch_id=None, is_active=True))
    s.commit()
print("ok")
