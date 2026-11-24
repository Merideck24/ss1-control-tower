-- Roles para el entorno local (docker-compose). En producción los crea el equipo de plataforma.
-- crm_owner: dueño del esquema; corre migraciones y la reconstrucción (con BYPASSRLS).
-- crm_app_login: usuario de la aplicación, miembro de crm_app (sujeto a RLS, sin UPDATE/DELETE en eventos ni auditoría).
ALTER ROLE crm_owner BYPASSRLS;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN CREATE ROLE crm_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_login') THEN CREATE ROLE crm_app_login LOGIN PASSWORD 'crm_app_local' IN ROLE crm_app; END IF;
END $$;
