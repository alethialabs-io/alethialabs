-- alethia db-bootstrap --byo-users (mysql), sweep script. Apply with mysql -N -B --force, after the provision script.
SET SESSION group_concat_max_len = 1048576;
-- the candidates whose open sessions this administrator cannot end (with PROCESS, those with a session, and without it, all), reported after the drops
SET @alethia_byo_unkilled = (SELECT IF(EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES g WHERE g.PRIVILEGE_TYPE IN ('PROCESS')
      AND CAST(g.GRANTEE AS BINARY) IN (SELECT CAST(CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''') AS BINARY)
        UNION SELECT CAST(CONCAT('''', r.ROLE_NAME, '''@''', r.ROLE_HOST, '''') AS BINARY) FROM information_schema.ENABLED_ROLES r))
    AND EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES g WHERE g.PRIVILEGE_TYPE IN ('CONNECTION_ADMIN', 'SUPER')
      AND CAST(g.GRANTEE AS BINARY) IN (SELECT CAST(CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''') AS BINARY)
        UNION SELECT CAST(CONCAT('''', r.ROLE_NAME, '''@''', r.ROLE_HOST, '''') AS BINARY) FROM information_schema.ENABLED_ROLES r)),
    JSON_ARRAY(), IFNULL(JSON_ARRAYAGG(c.USER), JSON_ARRAY())) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES g WHERE g.PRIVILEGE_TYPE IN ('PROCESS')
      AND CAST(g.GRANTEE AS BINARY) IN (SELECT CAST(CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''') AS BINARY)
        UNION SELECT CAST(CONCAT('''', r.ROLE_NAME, '''@''', r.ROLE_HOST, '''') AS BINARY) FROM information_schema.ENABLED_ROLES r))
      OR EXISTS (SELECT 1 FROM information_schema.PROCESSLIST p WHERE CAST(p.USER AS BINARY) = CAST(c.USER AS BINARY)));
-- phase 3a: end every candidate's sessions (a KILL that fails is reported and skipped; the session can no longer authenticate)
SET @alethia_byo_k = 0;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c)
    INTO @alethia_byo_k, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
-- phase 3b: drop every candidate; its database is kept (a DROP USER that fails is reported and skipped; the user stays locked)
SET @alethia_byo_u = '';
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = 'DO 0';
SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER ', QUOTE(CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)), '@''%'''), 'DO 0') FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @alethia_byo_s;
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
    SELECT CONVERT(CONCAT('revocation-pending:', p.USER) USING utf8mb4)
      FROM (SELECT c.USER FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c ORDER BY CAST(c.USER AS BINARY) LIMIT 32) p
    UNION ALL
    SELECT CONVERT(CONCAT('doubt:revocation-pending +', COUNT(*) - 32, ' more') USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c HAVING COUNT(*) > 32
    UNION ALL
    SELECT CONVERT(CONCAT('sessions-not-ended:', j.u) USING utf8mb4)
      FROM JSON_TABLE(IFNULL(@alethia_byo_unkilled, JSON_ARRAY()), '$[*]' COLUMNS (n FOR ORDINALITY, u VARCHAR(32) PATH '$')) j WHERE j.n <= 32
    UNION ALL
    SELECT CONVERT(CONCAT('doubt:sessions-not-ended +', COUNT(*) - 32, ' more') USING utf8mb4) FROM JSON_TABLE(IFNULL(@alethia_byo_unkilled, JSON_ARRAY()), '$[*]' COLUMNS (n FOR ORDINALITY, u VARCHAR(32) PATH '$')) j HAVING COUNT(*) > 32
    UNION ALL
    SELECT CONVERT('doubt:sessions-unrecorded' USING utf8mb4) FROM DUAL WHERE @alethia_byo_unkilled IS NULL) r
  UNION ALL
  SELECT 1, r.line FROM (SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1' AND m.account_locked = 'N'
        AND CAST(a.USER AS BINARY) IN ('alethia_byo_0123456789ab')
    UNION ALL
    SELECT CONVERT(CONCAT('revocation-pending:', p.USER) USING utf8mb4)
      FROM (SELECT c.USER FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c ORDER BY CAST(c.USER AS BINARY) LIMIT 32) p
    UNION ALL
    SELECT CONVERT(CONCAT('doubt:revocation-pending +', COUNT(*) - 32, ' more') USING utf8mb4) FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c HAVING COUNT(*) > 32
    UNION ALL
    SELECT CONVERT(CONCAT('sessions-not-ended:', j.u) USING utf8mb4)
      FROM JSON_TABLE(IFNULL(@alethia_byo_unkilled, JSON_ARRAY()), '$[*]' COLUMNS (n FOR ORDINALITY, u VARCHAR(32) PATH '$')) j WHERE j.n <= 32
    UNION ALL
    SELECT CONVERT(CONCAT('doubt:sessions-not-ended +', COUNT(*) - 32, ' more') USING utf8mb4) FROM JSON_TABLE(IFNULL(@alethia_byo_unkilled, JSON_ARRAY()), '$[*]' COLUMNS (n FOR ORDINALITY, u VARCHAR(32) PATH '$')) j HAVING COUNT(*) > 32
    UNION ALL
    SELECT CONVERT('doubt:sessions-unrecorded' USING utf8mb4) FROM DUAL WHERE @alethia_byo_unkilled IS NULL) r) s
    ORDER BY s.o, s.line;
