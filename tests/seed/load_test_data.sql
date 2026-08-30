-- =============================================================================
-- Movie Booking Load Test Seed Data
-- =============================================================================
-- This script creates realistic test data for load testing the movie booking
-- system. It does NOT affect production data.
--
-- Usage:
--   psql -U <user> -d <test_db> -f tests/seed/load_test_data.sql
--
-- Prerequisites:
--   - Run migrations first (knex migrate:latest)
--   - Ensure organization 'load-test-org' exists or create one
-- =============================================================================

-- =============================================================================
-- 1. ORGANIZATION (for super admin / organizer context)
-- =============================================================================
INSERT INTO organizations (name, slug, email, phone, status, is_verified, settings, created_at, updated_at)
VALUES (
  'Load Test Cinema Chain',
  'load-test-cinemas',
  'loadtest@example.com',
  '+919999999999',
  'active',
  true,
  '{"max_screens_per_cinema": 20, "allow_self_checkin": true}',
  NOW(),
  NOW()
) ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- 2. CITIES & STATES
-- =============================================================================
INSERT INTO cities (name, state, slug, is_active, created_at, updated_at) VALUES
  ('Mumbai', 'Maharashtra', 'mumbai', true, NOW(), NOW()),
  ('Delhi', 'Delhi', 'delhi', true, NOW(), NOW()),
  ('Bangalore', 'Karnataka', 'bangalore', true, NOW(), NOW()),
  ('Hyderabad', 'Telangana', 'hyderabad', true, NOW(), NOW()),
  ('Chennai', 'Tamil Nadu', 'chennai', true, NOW(), NOW()),
  ('Kolkata', 'West Bengal', 'kolkata', true, NOW(), NOW()),
  ('Pune', 'Maharashtra', 'pune', true, NOW(), NOW())
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- 3. MOVIES (10 movies, mix of languages)
-- =============================================================================
INSERT INTO movies (title, slug, description, language, genre, duration_minutes, release_date, status,
  certificate, director, cast, trailer_url, poster_url, backdrop_url,
  organization_id, is_featured, is_trending, rating, created_at, updated_at)
SELECT
  title, slug, description, language, genre, duration_minutes, release_date, status,
  certificate, director, cast::jsonb, trailer_url, poster_url, backdrop_url,
  org_id, is_featured, is_trending, rating, NOW(), NOW()
FROM (VALUES
  ('Action Hero Returns', 'action-hero-returns', 'Blockbuster action sequel', 'Hindi', '{"Action","Thriller"}', 162, '2026-09-01', 'released', 'UA', 'Rajamouli', '["Star A","Star B"]', 'https://youtube.com/demo1', 'poster_1.jpg', 'backdrop_1.jpg'),
  ('Love in Bangalore', 'love-in-bangalore', 'Romantic comedy set in tech city', 'Kannada', '{"Romance","Comedy"}', 148, '2026-09-05', 'released', 'U', 'Rakshit Shetty', '["Actor C","Actress D"]', 'https://youtube.com/demo2', 'poster_2.jpg', 'backdrop_2.jpg'),
  ('The Last Detective', 'the-last-detective', 'Mystery thriller', 'Hindi', '{"Mystery","Thriller"}', 155, '2026-09-10', 'released', 'UA', 'Sriram Raghavan', '["Actor E"]', 'https://youtube.com/demo3', 'poster_3.jpg', 'backdrop_3.jpg'),
  ('Family Vacation', 'family-vacation', 'Family drama', 'Tamil', '{"Drama","Family"}', 140, '2026-09-15', 'released', 'U', 'Mani Ratnam', '["Actor F","Actress G"]', 'https://youtube.com/demo4', 'poster_4.jpg', 'backdrop_4.jpg'),
  ('Superhero Chronicles', 'superhero-chronicles', 'Superhero origin story', 'Hindi', '{"Action","Sci-Fi"}', 175, '2026-09-20', 'released', 'UA', 'Ayan Mukerji', '["Star H"]', 'https://youtube.com/demo5', 'poster_5.jpg', 'backdrop_5.jpg'),
  ('Haunted House', 'haunted-house', 'Horror', 'Malayalam', '{"Horror","Thriller"}', 120, '2026-09-25', 'released', 'A', 'Priyadarshan', '["Actor I"]', 'https://youtube.com/demo6', 'poster_6.jpg', 'backdrop_6.jpg'),
  ('Cricket Dreams', 'cricket-dreams', 'Sports drama', 'Telugu', '{"Drama","Sports"}', 152, '2026-10-01', 'released', 'U', 'SS Rajamouli', '["Actor J"]', 'https://youtube.com/demo7', 'poster_7.jpg', 'backdrop_7.jpg'),
  ('Comedy Nights', 'comedy-nights', 'Stand-up comedy special', 'Hindi', '{"Comedy"}', 95, '2026-10-05', 'released', 'U', 'Tanmay Bhat', '["Comedian K"]', 'https://youtube.com/demo8', 'poster_8.jpg', 'backdrop_8.jpg'),
  ('Documentary: Oceans', 'documentary-oceans', 'Nature documentary', 'English', '{"Documentary"}', 90, '2026-08-01', 'released', 'U', 'Attenborough', '[]', 'https://youtube.com/demo9', 'poster_9.jpg', 'backdrop_9.jpg'),
  ('Folk Music Journey', 'folk-music-journey', 'Musical documentary', 'Bengali', '{"Documentary","Music"}', 105, '2026-08-15', 'released', 'U', 'Ritwik Ghatak', '[]', 'https://youtube.com/demo10', 'poster_10.jpg', 'backdrop_10.jpg')
) AS t(title, slug, description, language, genre, duration_minutes, release_date, status, certificate, director, cast, trailer_url, poster_url, backdrop_url, org_id, is_featured, is_trending, rating)
WHERE NOT EXISTS (
  SELECT 1 FROM movies m WHERE m.slug = t.slug
);

-- Get the org_id for load-test-cinemas
DO $$
DECLARE
  v_org_id INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'load-test-cinemas' LIMIT 1;

  -- Update movies with actual org_id
  UPDATE movies SET organization_id = v_org_id WHERE organization_id IS NULL AND status = 'released';

  -- =============================================================================
  -- 4. CINEMAS (5 cinemas across different cities)
  -- =============================================================================
  INSERT INTO cinemas (name, slug, address, city, state, country, phone, email,
    total_screens, facility_features, status, organization_id,
    latitude, longitude, created_at, updated_at)
  SELECT name, slug, address, city, state, 'India', phone, email,
    total_screens, facility_features::jsonb, status, v_org_id,
    latitude, longitude, NOW(), NOW()
  FROM (VALUES
    ('PVR LoadTest Mall', 'pvr-loadtest-mall', '123 Test Street, Andheri', 'Mumbai', 'Maharashtra', '+919900000001', 'pvr-mall@test.com', 4, '{"parking","food","imax","dolby"}', 'active', 19.0760, 72.8777),
    ('INOX LoadTest Central', 'inox-loadtest-central', '456 Test Avenue, Connaught Place', 'Delhi', 'Delhi', '+919900000002', 'inox-del@test.com', 3, '{"parking","food","4dx"}', 'active', 28.6139, 77.2090),
    ('Cinepolis LoadTest Hub', 'cinepolis-loadtest-hub', '789 Test Road, Koramangala', 'Bangalore', 'Karnataka', '+919900000003', 'cine-blr@test.com', 3, '{"parking","food","recliner"}', 'active', 12.9716, 77.5946),
    ('SPI LoadTest Siva', 'spi-loadtest-siva', '321 Test Lane, Banjara Hills', 'Hyderabad', 'Telangana', '+919900000004', 'spi-hyd@test.com', 2, '{"parking","food","gold_class"}', 'active', 17.4065, 78.4772),
    ('AGS LoadTest Arcade', 'ags-loadtest-arcade', '654 Test Drive, T Nagar', 'Chennai', 'Tamil Nadu', '+919900000005', 'ags-che@test.com', 2, '{"parking","food","imax"}', 'active', 13.0827, 80.2707)
  ) AS t(name, slug, address, city, state, phone, email, total_screens, facility_features, status, latitude, longitude)
  WHERE NOT EXISTS (SELECT 1 FROM cinemas c WHERE c.slug = t.slug);

  -- =============================================================================
  -- 5. SCREENS (2-4 per cinema, various types)
  -- =============================================================================
  -- PVR: 4 screens
  INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type,
    sound_system, row_labels, seats_per_row, seat_types, pricing_rules, is_active, created_at, updated_at)
  SELECT cinema_id, screen_number, name, seat_capacity, screen_type, sound_system,
    row_labels, seats_per_row, seat_types::jsonb, pricing_rules::jsonb, true, NOW(), NOW()
  FROM (VALUES
    (1, 1, 'Screen 1 - Standard', 120, 'standard', 'Dolby Atmos', '{"A","B","C","D","E","F","G","H","I","J","K","L"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"standard"},{"row":"J","type":"standard"},{"row":"K","type":"premium"},{"row":"L","type":"premium"}]',
     '{"premium_rows":["K","L"],"couple_seats":[]}'),
    (1, 2, 'Screen 2 - IMAX', 80, 'imax', 'Dolby Atmos 7.1', '{"A","B","C","D","E","F","G","H"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"premium"},{"row":"G","type":"premium"},{"row":"H","type":"premium"}]',
     '{"premium_rows":["F","G","H"],"couple_seats":[]}'),
    (1, 3, 'Screen 3 - Dolby', 100, 'dolby', 'Dolby Atmos 9.1', '{"A","B","C","D","E","F","G","H","I","J"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"premium"},{"row":"J","type":"premium"}]',
     '{"premium_rows":["I","J"],"couple_seats":[]}'),
    (1, 4, 'Screen 4 - 4DX', 60, '4dx', '4DX Motion', '{"A","B","C","D","E","F"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"}]',
     '{"premium_rows":[],"couple_seats":[]}')
  ) AS t(cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, row_labels, seats_per_row, seat_types, pricing_rules)
  WHERE NOT EXISTS (SELECT 1 FROM cinema_screens cs WHERE cs.cinema_id = t.cinema_id AND cs.screen_number = t.screen_number);

  -- INOX: 3 screens
  INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type,
    sound_system, row_labels, seats_per_row, seat_types, pricing_rules, is_active, created_at, updated_at)
  SELECT cinema_id, screen_number, name, seat_capacity, screen_type, sound_system,
    row_labels, seats_per_row, seat_types::jsonb, pricing_rules::jsonb, true, NOW(), NOW()
  FROM (VALUES
    (2, 1, 'Screen 1', 150, 'standard', 'Dolby Digital', '{"A","B","C","D","E","F","G","H","I","J","K","L","M","N","O"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"standard"},{"row":"J","type":"standard"},{"row":"K","type":"premium"},{"row":"L","type":"premium"},{"row":"M","type":"premium"},{"row":"N","type":"sofa"},{"row":"O","type":"sofa"}]',
     '{"premium_rows":["K","L","M"],"couple_seats":[]}'),
    (2, 2, 'Screen 2', 100, 'imax', 'IMAX 12-Channel', '{"A","B","C","D","E","F","G","H","I","J"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"premium"},{"row":"G","type":"premium"},{"row":"H","type":"premium"},{"row":"I","type":"couple"},{"row":"J","type":"couple"}]',
     '{"premium_rows":["F","G","H"],"couple_seats":["I","J"]}'),
    (2, 3, 'Screen 3 - 4DX', 60, '4dx', '4DX', '{"A","B","C","D","E","F"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"}]',
     '{"premium_rows":[],"couple_seats":[]}')
  ) AS t(cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, row_labels, seats_per_row, seat_types, pricing_rules)
  WHERE NOT EXISTS (SELECT 1 FROM cinema_screens cs WHERE cs.cinema_id = t.cinema_id AND cs.screen_number = t.screen_number);

  -- Cinepolis: 3 screens
  INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type,
    sound_system, row_labels, seats_per_row, seat_types, pricing_rules, is_active, created_at, updated_at)
  SELECT cinema_id, screen_number, name, seat_capacity, screen_type, sound_system,
    row_labels, seats_per_row, seat_types::jsonb, pricing_rules::jsonb, true, NOW(), NOW()
  FROM (VALUES
    (3, 1, 'Screen 1', 120, 'standard', 'Dolby Atmos', '{"A","B","C","D","E","F","G","H","I","J","K","L"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"premium"},{"row":"J","type":"premium"},{"row":"K","type":"sofa"},{"row":"L","type":"sofa"}]',
     '{"premium_rows":["I","J"],"couple_seats":[]}'),
    (3, 2, 'Screen 2', 80, 'gold_class', 'Dolby Digital', '{"A","B","C","D","E","F","G","H"}', 10,
     '[{"row":"A","type":"premium"},{"row":"B","type":"premium"},{"row":"C","type":"premium"},{"row":"D","type":"premium"},{"row":"E","type":"premium"},{"row":"F","type":"sofa"},{"row":"G","type":"sofa"},{"row":"H","type":"sofa"}]',
     '{"premium_rows":["A","B","C","D","E"],"couple_seats":[]}'),
    (3, 3, 'Screen 3', 100, 'standard', 'DTS', '{"A","B","C","D","E","F","G","H","I","J"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"wheelchair"},{"row":"J","type":"wheelchair"}]',
     '{"premium_rows":[],"couple_seats":[]}')
  ) AS t(cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, row_labels, seats_per_row, seat_types, pricing_rules)
  WHERE NOT EXISTS (SELECT 1 FROM cinema_screens cs WHERE cs.cinema_id = t.cinema_id AND cs.screen_number = t.screen_number);

  -- SPI: 2 screens
  INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type,
    sound_system, row_labels, seats_per_row, seat_types, pricing_rules, is_active, created_at, updated_at)
  SELECT cinema_id, screen_number, name, seat_capacity, screen_type, sound_system,
    row_labels, seats_per_row, seat_types::jsonb, pricing_rules::jsonb, true, NOW(), NOW()
  FROM (VALUES
    (4, 1, 'Screen 1', 200, 'standard', 'Dolby Atmos', '{"A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"standard"},{"row":"J","type":"standard"},{"row":"K","type":"premium"},{"row":"L","type":"premium"},{"row":"M","type":"premium"},{"row":"N","type":"premium"},{"row":"O","type":"premium"},{"row":"P","type":"premium"},{"row":"Q","type":"premium"},{"row":"R","type":"sofa"},{"row":"S","type":"sofa"},{"row":"T","type":"sofa"}]',
     '{"premium_rows":["K","L","M","N","O","P","Q"],"couple_seats":[]}'),
    (4, 2, 'Screen 2', 150, 'imax', 'IMAX', '{"A","B","C","D","E","F","G","H","I","J","K","L","M","N","O"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"premium"},{"row":"H","type":"premium"},{"row":"I","type":"premium"},{"row":"J","type":"premium"},{"row":"K","type":"premium"},{"row":"L","type":"couple"},{"row":"M","type":"couple"},{"row":"N","type":"couple"},{"row":"O","type":"couple"}]',
     '{"premium_rows":["G","H","I","J","K"],"couple_seats":["L","M","N","O"]}')
  ) AS t(cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, row_labels, seats_per_row, seat_types, pricing_rules)
  WHERE NOT EXISTS (SELECT 1 FROM cinema_screens cs WHERE cs.cinema_id = t.cinema_id AND cs.screen_number = t.screen_number);

  -- AGS: 2 screens
  INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type,
    sound_system, row_labels, seats_per_row, seat_types, pricing_rules, is_active, created_at, updated_at)
  SELECT cinema_id, screen_number, name, seat_capacity, screen_type, sound_system,
    row_labels, seats_per_row, seat_types::jsonb, pricing_rules::jsonb, true, NOW(), NOW()
  FROM (VALUES
    (5, 1, 'Screen 1', 120, 'standard', 'Dolby Atmos', '{"A","B","C","D","E","F","G","H","I","J","K","L"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"standard"},{"row":"G","type":"standard"},{"row":"H","type":"standard"},{"row":"I","type":"premium"},{"row":"J","type":"premium"},{"row":"K","type":"premium"},{"row":"L","type":"premium"}]',
     '{"premium_rows":["I","J","K","L"],"couple_seats":[]}'),
    (5, 2, 'Screen 2 - IMAX', 80, 'imax', 'IMAX 12.1', '{"A","B","C","D","E","F","G","H"}', 10,
     '[{"row":"A","type":"standard"},{"row":"B","type":"standard"},{"row":"C","type":"standard"},{"row":"D","type":"standard"},{"row":"E","type":"standard"},{"row":"F","type":"premium"},{"row":"G","type":"premium"},{"row":"H","type":"premium"}]',
     '{"premium_rows":["F","G","H"],"couple_seats":[]}')
  ) AS t(cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, row_labels, seats_per_row, seat_types, pricing_rules)
  WHERE NOT EXISTS (SELECT 1 FROM cinema_screens cs WHERE cs.cinema_id = t.cinema_id AND cs.screen_number = t.screen_number);

  -- =============================================================================
  -- 6. CINEMA SEATS (generated for each screen)
  -- =============================================================================
  -- Screen 1 (PVR): 12 rows x 10 seats = 120 seats
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE
      WHEN r.row_letter IN ('K','L') THEN 'premium'
      ELSE 'standard'
    END,
    CASE
      WHEN r.row_letter IN ('K','L') THEN 'recliner'
      ELSE 'regular'
    END,
    (s2.seat_num - 1) * 8.5,
    (r.row_idx - 1) * 7.5,
    true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (
    VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12)
  ) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 1
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- Screen 2 (PVR IMAX): 8 rows x 10 = 80 seats
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'premium' ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'recliner' ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 1 AND s.screen_number = 2
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- Screen 3 (PVR Dolby): 10 rows x 10 = 100 seats
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('I','J') THEN 'premium' ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('I','J') THEN 'recliner' ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 1 AND s.screen_number = 3
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- Screen 4 (PVR 4DX): 6 rows x 10 = 60 seats
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num, 'standard', 'regular',
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 1 AND s.screen_number = 4
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- INOX screens: 15, 10, 6 rows x 10 seats
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('K','L','M') THEN 'premium'
         WHEN r.row_letter IN ('N','O') THEN 'sofa'
         ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('K','L','M') THEN 'recliner'
         WHEN r.row_letter IN ('N','O') THEN 'recliner'
         ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12),('M',13),('N',14),('O',15)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 2 AND s.screen_number = 1
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'premium'
         WHEN r.row_letter IN ('I','J') THEN 'couple'
         ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'recliner'
         WHEN r.row_letter IN ('I','J') THEN 'couple'
         ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 2 AND s.screen_number = 2
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num, 'standard', 'regular',
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 2 AND s.screen_number = 3
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- Cinepolis screens: 12, 8, 10 rows x 10
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('I','J') THEN 'premium' WHEN r.row_letter IN ('K','L') THEN 'sofa' ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('I','J') THEN 'recliner' WHEN r.row_letter IN ('K','L') THEN 'recliner' ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 3 AND s.screen_number = 1
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num, 'premium', 'recliner',
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 3 AND s.screen_number = 2
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num, 'standard', 'regular',
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 3 AND s.screen_number = 3
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- SPI screens: 20, 15 rows x 10
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('K','L','M','N','O','P','Q') THEN 'premium'
         WHEN r.row_letter IN ('R','S','T') THEN 'sofa'
         ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('K','L','M','N','O','P','Q') THEN 'recliner'
         WHEN r.row_letter IN ('R','S','T') THEN 'recliner'
         ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12),('M',13),('N',14),('O',15),('P',16),('Q',17),('R',18),('S',19),('T',20)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 4 AND s.screen_number = 1
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('G','H','I','J','K') THEN 'premium'
         WHEN r.row_letter IN ('L','M','N','O') THEN 'couple'
         ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('G','H','I','J','K') THEN 'recliner'
         WHEN r.row_letter IN ('L','M','N','O') THEN 'couple'
         ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12),('M',13),('N',14),('O',15)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 4 AND s.screen_number = 2
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  -- AGS screens: 12, 8 rows x 10
  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('I','J','K','L') THEN 'premium' ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('I','J','K','L') THEN 'recliner' ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8),('I',9),('J',10),('K',11),('L',12)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 5 AND s.screen_number = 1
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

  INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, position_x, position_y, is_available, created_at, updated_at)
  SELECT s.id, r.row_letter, s2.seat_num,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'premium' ELSE 'standard' END,
    CASE WHEN r.row_letter IN ('F','G','H') THEN 'recliner' ELSE 'regular' END,
    (s2.seat_num - 1) * 8.5, (r.row_idx - 1) * 7.5, true, NOW(), NOW()
  FROM cinema_screens s
  CROSS JOIN (VALUES ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),('G',7),('H',8)) AS r(row_letter, row_idx)
  CROSS JOIN generate_series(1, 10) AS s2(seat_num)
  WHERE s.cinema_id = 5 AND s.screen_number = 2
  AND NOT EXISTS (SELECT 1 FROM cinema_seats cs WHERE cs.screen_id = s.id);

END $$;

-- =============================================================================
-- 7. SHOWTIMES (hot showtime + multiple upcoming)
-- =============================================================================
DO $$
DECLARE
  v_movie_action INT;
  v_movie_romance INT;
  v_screen_pvr_1 INT;
  v_screen_inox_1 INT;
  v_screen_pvr_2 INT;
BEGIN
  SELECT id INTO v_movie_action FROM movies WHERE slug = 'action-hero-returns' LIMIT 1;
  SELECT id INTO v_movie_romance FROM movies WHERE slug = 'love-in-bangalore' LIMIT 1;
  SELECT id INTO v_screen_pvr_1 FROM cinema_screens WHERE cinema_id = 1 AND screen_number = 1;
  SELECT id INTO v_screen_inox_1 FROM cinema_screens WHERE cinema_id = 2 AND screen_number = 1;
  SELECT id INTO v_screen_pvr_2 FROM cinema_screens WHERE cinema_id = 1 AND screen_number = 2;

  -- HOT showtime: Action Hero Returns on PVR Screen 1 (120 seats), tonight
  INSERT INTO showtimes (movie_id, cinema_id, screen_id, start_datetime, end_datetime,
    total_seats, available_seats, booked_seats, base_price, currency, status,
    show_format, language, organization_id, created_at, updated_at)
  VALUES (
    v_movie_action, 1, v_screen_pvr_1,
    NOW() + INTERVAL '2 hours',
    NOW() + INTERVAL '2 hours' + INTERVAL '2 hours 42 minutes',
    120, 120, 0, 25000, 'INR', 'on_sale',
    '2D', 'Hindi', 1, NOW(), NOW()
  ) ON CONFLICT DO NOTHING;

  -- Second hot showtime: Action Hero Returns on IMAX (80 seats)
  INSERT INTO showtimes (movie_id, cinema_id, screen_id, start_datetime, end_datetime,
    total_seats, available_seats, booked_seats, base_price, currency, status,
    show_format, language, organization_id, created_at, updated_at)
  VALUES (
    v_movie_action, 1, v_screen_pvr_2,
    NOW() + INTERVAL '4 hours',
    NOW() + INTERVAL '4 hours' + INTERVAL '2 hours 55 minutes',
    80, 80, 0, 45000, 'INR', 'on_sale',
    'IMAX 3D', 'Hindi', 1, NOW(), NOW()
  ) ON CONFLICT DO NOTHING;

  -- Love in Bangalore showtimes
  INSERT INTO showtimes (movie_id, cinema_id, screen_id, start_datetime, end_datetime,
    total_seats, available_seats, booked_seats, base_price, currency, status,
    show_format, language, organization_id, created_at, updated_at)
  VALUES (
    v_movie_romance, 3, (SELECT id FROM cinema_screens WHERE cinema_id = 3 AND screen_number = 1 LIMIT 1),
    NOW() + INTERVAL '3 hours',
    NOW() + INTERVAL '3 hours' + INTERVAL '2 hours 28 minutes',
    120, 120, 0, 20000, 'INR', 'on_sale',
    '2D', 'Kannada', 1, NOW(), NOW()
  ), (
    v_movie_romance, 3, (SELECT id FROM cinema_screens WHERE cinema_id = 3 AND screen_number = 1 LIMIT 1),
    NOW() + INTERVAL '6 hours',
    NOW() + INTERVAL '6 hours' + INTERVAL '2 hours 28 minutes',
    120, 120, 0, 20000, 'INR', 'on_sale',
    '2D', 'Kannada', 1, NOW(), NOW()
  )
  ON CONFLICT DO NOTHING;

  -- Additional showtimes spread across the week
  INSERT INTO showtimes (movie_id, cinema_id, screen_id, start_datetime, end_datetime,
    total_seats, available_seats, booked_seats, base_price, currency, status,
    show_format, language, organization_id, created_at, updated_at)
  SELECT
    v_movie_action,
    c.id,
    (SELECT id FROM cinema_screens WHERE cinema_id = c.id AND screen_number = 1 LIMIT 1),
    NOW() + (d || ' days')::INTERVAL + INTERVAL '14:00',
    NOW() + (d || ' days')::INTERVAL + INTERVAL '16:42',
    100, 100, 0, 25000, 'INR', 'on_sale',
    '2D', 'Hindi', 1, NOW(), NOW()
  FROM (VALUES (1),(2),(3),(4),(5),(6)) AS t(d)
  CROSS JOIN (SELECT id FROM cinemas WHERE organization_id = 1 LIMIT 3) AS c
  ON CONFLICT DO NOTHING;

END $$;

-- =============================================================================
-- 8. PRICE CAPS for load test org
-- =============================================================================
DO $$
DECLARE
  v_org_id INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'load-test-cinemas' LIMIT 1;

  INSERT INTO movie_price_caps (organization_id, city, state, seat_type, max_price_paise, applies_to, is_active, created_at, updated_at)
  VALUES
    (v_org_id, 'Mumbai', 'Maharashtra', 'standard', 40000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Mumbai', 'Maharashtra', 'premium', 60000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Mumbai', 'Maharashtra', 'sofa', 80000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Delhi', 'Delhi', 'standard', 35000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Delhi', 'Delhi', 'premium', 55000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Bangalore', 'Karnataka', 'standard', 30000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Bangalore', 'Karnataka', 'premium', 50000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Hyderabad', 'Telangana', 'standard', 28000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Hyderabad', 'Telangana', 'premium', 48000, 'all', true, NOW(), NOW()),
    (v_org_id, 'Chennai', 'Tamil Nadu', 'standard', 30000, 'all', true, NOW(), NOW()),
    (v_org_id, 'all', 'all', 'standard', 50000, 'all', true, NOW(), NOW()),
    (v_org_id, 'all', 'all', 'premium', 75000, 'all', true, NOW(), NOW()),
    (v_org_id, 'all', 'all', 'sofa', 100000, 'all', true, NOW(), NOW())
  ON CONFLICT DO NOTHING;
END $$;

-- =============================================================================
-- 9. SUMMARY
-- =============================================================================
DO $$
DECLARE
  v_movie_count INT;
  v_cinema_count INT;
  v_screen_count INT;
  v_seat_count INT;
  v_showtime_count INT;
  v_org_id INT;
BEGIN
  SELECT id INTO v_org_id FROM organizations WHERE slug = 'load-test-cinemas' LIMIT 1;
  SELECT COUNT(*) INTO v_movie_count FROM movies WHERE organization_id = v_org_id;
  SELECT COUNT(*) INTO v_cinema_count FROM cinemas WHERE organization_id = v_org_id;
  SELECT COUNT(*) INTO v_screen_count FROM cinema_screens WHERE cinema_id IN (SELECT id FROM cinemas WHERE organization_id = v_org_id);
  SELECT COUNT(*) INTO v_seat_count FROM cinema_seats WHERE screen_id IN (SELECT id FROM cinema_screens WHERE cinema_id IN (SELECT id FROM cinemas WHERE organization_id = v_org_id));
  SELECT COUNT(*) INTO v_showtime_count FROM showtimes WHERE organization_id = v_org_id;

  RAISE NOTICE '=== Load Test Data Summary ===';
  RAISE NOTICE 'Organization: load-test-cinemas (id=%)', v_org_id;
  RAISE NOTICE 'Movies: %', v_movie_count;
  RAISE NOTICE 'Cinemas: %', v_cinema_count;
  RAISE NOTICE 'Screens: %', v_screen_count;
  RAISE NOTICE 'Total Seats: %', v_seat_count;
  RAISE NOTICE 'Showtimes: %', v_showtime_count;
  RAISE NOTICE '===============================';
END $$;
