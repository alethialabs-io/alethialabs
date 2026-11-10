-- alethia db-bootstrap --byo-users (mysql), sweep script. Apply with mysql -N -B --force, after the provision script.
SET SESSION group_concat_max_len = 1048576;
-- phase 3a: end every candidate's sessions (a KILL that fails is reported and skipped; the session can no longer authenticate)
SET @alethia_byo_k = 0;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_k = (SELECT MIN(p.ID) FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c));
SET @alethia_byo_s = IF(@alethia_byo_k IS NULL, 'DO 0', CONCAT('KILL ', @alethia_byo_k));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
-- phase 3b: drop every candidate; its database is kept (a DROP USER that fails is reported and skipped; the user stays locked)
SET @alethia_byo_u = '';
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_u = (SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY));
SET @alethia_byo_s = IF(@alethia_byo_u IS NULL, 'DO 0', CONCAT('DROP USER ', QUOTE(@alethia_byo_u), '@''%'''));
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
-- result: the provisioned set and every candidate still present
SELECT s.line FROM (
  SELECT 0 AS o, CONCAT('alethia-byo-users v1 count=', COUNT(*)) AS line FROM (SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1' AND m.account_locked = 'N'
        AND CAST(a.USER AS BINARY) IN ('alethia_byo_0123456789ab')
    UNION ALL
    SELECT CONVERT(CONCAT('revocation-pending:', c.USER) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c) r
  UNION ALL
  SELECT 1, r.line FROM (SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1' AND m.account_locked = 'N'
        AND CAST(a.USER AS BINARY) IN ('alethia_byo_0123456789ab')
    UNION ALL
    SELECT CONVERT(CONCAT('revocation-pending:', c.USER) USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c) r) s
    ORDER BY s.o, s.line;
