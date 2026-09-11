-- database/seed.sql
INSERT INTO instrument_types (name, category, parameter_schema, default_validity_days) VALUES
('Road weighbridge', 'Weighing', '{"fields":[{"key":"max_capacity_kg","label":"Max capacity (kg)","type":"number"},{"key":"platform_length_m","label":"Platform length (m)","type":"number"},{"key":"test_load_error_g","label":"Error at test load (g)","type":"number"}]}', 365),
('Fuel dispensing unit', 'Volumetric', '{"fields":[{"key":"nozzle_count","label":"Number of nozzles","type":"number"},{"key":"test_volume_l","label":"Test draw volume (L)","type":"number"},{"key":"error_ml","label":"Error observed (mL)","type":"number"}]}', 365),
('Commercial weighing scale', 'Weighing', '{"fields":[{"key":"max_capacity_kg","label":"Max capacity (kg)","type":"number"},{"key":"test_load_error_g","label":"Error at test load (g)","type":"number"}]}', 365),
('Taximeter', 'Distance/Fare', '{"fields":[{"key":"test_distance_km","label":"Test distance (km)","type":"number"},{"key":"fare_error_pct","label":"Fare error (%)","type":"number"}]}', 365);

-- Demo accounts, one per role, so login can be tested with zero setup.
-- CENTRAL_ADMIN/STATE_ADMIN/LMO/GATC accounts are never self-registered in
-- this system by design (see README) — someone has to exist first to bulk-
-- import the rest, so these are the bootstrap accounts.
INSERT INTO stakeholders (role, name, phone, state, district, source_registry) VALUES
('CENTRAL_ADMIN', 'Demo Central Admin', '9999900001', 'Delhi', 'New Delhi', 'bootstrap'),
('STATE_ADMIN',   'Demo Punjab State Admin', '9999900002', 'Punjab', 'Chandigarh', 'bootstrap'),
('LMO',           'Demo LMO Officer', '9999900003', 'Punjab', 'Ludhiana', 'bootstrap'),
('GATC',          'Demo GATC Centre', '9999900004', 'Punjab', 'Ludhiana', 'emaap.gov.in/gatc');
