import os, sys
sys.path.insert(0, os.getcwd())
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db.models.admin_user import AdminUser
engine = create_engine(os.environ["DATABASE_URL"])
rows = [
    ("stg-sales-a", "manager-a@staging.boombala.example.com", "Тест менеджер A", "sales_manager", "stg-almaty"),
    ("stg-sales-b", "manager-b@staging.boombala.example.com", "Тест менеджер B", "sales_manager", "stg-almaty"),
]
with sessionmaker(bind=engine)() as s:
    for id_, email, name, role, branch in rows:
        if s.get(AdminUser, id_) is None:
            s.add(AdminUser(id=id_, email=email, full_name=name, password_hash="x", role=role, branch_id=branch, is_active=True))
    s.commit()
print("ok")
