-- Drops the fixed-window counter table that backed public-endpoint rate
-- limiting. Its only reader (PublicRateLimitService) now counts in Redis
-- (INCR + EXPIRE): the row-locked version serialized every request for
-- the same key behind one hot row on the kiosk endpoints. The table held
-- 60-second-window counters, so nothing here is durable data.
DROP TABLE "public_endpoint_rate_limits";
