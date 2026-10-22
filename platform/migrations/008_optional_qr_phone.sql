-- 008_optional_qr_phone: the phone is optional in the QR registration only.
-- A contact WITHOUT a phone can exist only when it comes from the QR form. Enquiries (birthday form) and manual
-- bookings keep requiring a phone: that is enforced here, not only in the application.
-- A contact without a phone is never merged with anyone: the unique key (phone_e164, name_key) treats NULL phones as
-- distinct, so every phoneless registration is its own contact. There is no placeholder number and no merging by name.
ALTER TABLE contacts ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE contacts ADD CONSTRAINT contacts_phone_required_unless_qr CHECK (phone_e164 IS NOT NULL OR source = 'qr');

SELECT harden_schema();
