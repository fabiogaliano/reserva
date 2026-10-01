-- The sweep looks for unreported oversell markers every five minutes. Without an index of their
-- own it reaches them through the status index, where they sit among every delivered outbox row,
-- so each sweep read the whole delivery history. Partial, so ordinary outbox writes never touch it.
CREATE INDEX idx_side_effect_operations_oversell ON side_effect_operations (updated_at) WHERE family = 'oversell';
