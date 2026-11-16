-- Fictitious demo data only.
CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  country text NOT NULL,
  status text NOT NULL
);

INSERT INTO customers (name, email, country, status) VALUES
  ('Alice Martin', 'alice.martin@example.com', 'France', 'active'),
  ('Bruno Keller', 'bruno.keller@example.com', 'Germany', 'active'),
  ('Chiara Rossi', 'chiara.rossi@example.com', 'Italy', 'inactive'),
  ('Dmitri Ivanov', 'dmitri.ivanov@example.com', 'Poland', 'active'),
  ('Elena Garcia', 'elena.garcia@example.com', 'Spain', 'pending'),
  ('Farid Haddad', 'farid.haddad@example.com', 'France', 'active'),
  ('Greta Nilsson', 'greta.nilsson@example.com', 'Sweden', 'inactive'),
  ('Hugo Lambert', 'hugo.lambert@example.com', 'Belgium', 'active'),
  ('Ingrid Larsen', 'ingrid.larsen@example.com', 'Norway', 'pending'),
  ('Jan Novak', 'jan.novak@example.com', 'Czechia', 'active'),
  ('Katia Silva', 'katia.silva@example.com', 'Portugal', 'active'),
  ('Liam Murphy', 'liam.murphy@example.com', 'Ireland', 'inactive'),
  ('Maria Costa', 'maria.costa@example.com', 'Portugal', 'pending'),
  ('Nikos Papas', 'nikos.papas@example.com', 'Greece', 'active'),
  ('Olga Petrova', 'olga.petrova@example.com', 'Poland', 'active'),
  ('Pierre Dubois', 'pierre.dubois@example.com', 'France', 'inactive'),
  ('Quentin Moreau', 'quentin.moreau@example.com', 'France', 'active'),
  ('Rosa Fernandez', 'rosa.fernandez@example.com', 'Spain', 'active'),
  ('Stefan Weber', 'stefan.weber@example.com', 'Germany', 'pending'),
  ('Tina Berg', 'tina.berg@example.com', 'Sweden', 'active'),
  ('Ugo Bianchi', 'ugo.bianchi@example.com', 'Italy', 'active'),
  ('Vera Kovac', 'vera.kovac@example.com', 'Croatia', 'inactive'),
  ('Willem de Vries', 'willem.devries@example.com', 'Netherlands', 'active'),
  ('Xavier Leroy', 'xavier.leroy@example.com', 'France', 'pending'),
  ('Yasmin Aziz', 'yasmin.aziz@example.com', 'Belgium', 'active');
