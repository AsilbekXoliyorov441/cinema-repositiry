-- Creates the isolated test database on first container start (development only).
SELECT 'CREATE DATABASE cinewave_test OWNER ' || current_user
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cinewave_test')\gexec
